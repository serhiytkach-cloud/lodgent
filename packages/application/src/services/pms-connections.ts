import {
  type Clock,
  can,
  ForbiddenError,
  type KeyManagement,
  NotFoundError,
  type PmsClient,
  type PmsProvider,
  UnprocessableError,
  UpstreamError,
  ValidationError,
} from '@lodgent/core';
import type { Database, PmsConnectionRow } from '@lodgent/db';
import type { Logger } from 'pino';
import { z } from 'zod';
import { assertCan, type OrgContext, systemActor, userActor } from '../context';
import type { Signer } from '../infra/signing';

const StoredTokens = z.object({ accessToken: z.string(), refreshToken: z.string().nullable() });
const OAuthState = z.object({ orgId: z.uuid(), userId: z.uuid() });

export interface PmsConnectionStatus {
  connected: boolean;
  provider: 'apaleo';
  accountCode: string | null;
  accountName: string | null;
  status: 'active' | 'error' | 'revoked' | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  lastSyncStats: Record<string, number> | null;
  webhooksActive: boolean;
}

/**
 * The hotel's PMS connection: OAuth connect/disconnect, encrypted token storage and a client whose
 * access token is refreshed transparently (serialized with a row lock because Apaleo rotates
 * refresh tokens on every use).
 */
export class PmsConnectionService {
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      kms: KeyManagement;
      provider: PmsProvider;
      signer: Signer;
      logger: Logger;
      redirectUri: string;
      webBaseUrl: string;
    },
  ) {}

  private context(connection: { id: string; organizationId: string }) {
    return {
      purpose: 'pms-oauth-tokens',
      connection: connection.id,
      organization: connection.organizationId,
    };
  }

  async status(ctx: OrgContext): Promise<PmsConnectionStatus> {
    assertCan(ctx, 'property.read');
    const c = await this.deps.db.tenant(ctx.orgId, (r) => r.pmsConnection.get());
    return toStatus(c);
  }

  authorizeUrl(ctx: OrgContext): string {
    assertCan(ctx, 'pms.manage');
    const state = this.deps.signer.sign(
      'oauth-state',
      { orgId: ctx.orgId, userId: ctx.userId },
      600,
      this.deps.clock.now(),
    );
    return this.deps.provider.authorizeUrl(state, this.deps.redirectUri);
  }

  /**
   * Completes the OAuth flow from the provider's redirect. Returns the dashboard URL to send the
   * browser to. Membership and permission are re-checked: the state only proves who started it.
   */
  async completeAuthorization(params: { code?: string; state?: string; error?: string }): Promise<string> {
    const { db, signer, clock, kms, provider } = this.deps;
    const raw = params.state ? signer.verify('oauth-state', params.state, clock.now()) : null;
    const parsed = OAuthState.safeParse(raw);
    if (!parsed.success)
      throw new ValidationError('The connection link expired or was tampered with. Start again.');
    const { orgId, userId } = parsed.data;
    const back = (result: string) =>
      `${this.deps.webBaseUrl}/app/${orgId}/settings/connections?apaleo=${result}`;
    if (params.error || !params.code) return back(params.error === 'access_denied' ? 'denied' : 'error');

    const membership = await db.system(({ identity }) => identity.membership(userId, orgId));
    if (!membership || !can(membership.role, 'pms.manage')) throw new ForbiddenError();

    const tokens = await provider.exchangeCode(params.code, this.deps.redirectUri);
    const account = await provider.client(async () => tokens.accessToken).getAccount();

    // One Apaleo account belongs to one organization.
    const existing = await db.system(({ pms }) => pms.connectionByAccount('apaleo', account.accountCode));
    if (existing && existing.organizationId !== orgId) {
      throw new UnprocessableError(
        'pms_account_in_use',
        'This Apaleo account is already connected to another organization.',
      );
    }

    await db.tenant(orgId, async (r) => {
      // Insert first to get the id the encryption context is bound to, then store the sealed tokens.
      const placeholder = await r.pmsConnection.upsert({
        provider: 'apaleo',
        accountCode: account.accountCode,
        accountName: account.accountName,
        status: 'active',
        scopes: tokens.scope,
        encryptedTokens: 'pending',
        accessTokenExpiresAt: tokens.expiresAt,
        connectedByUserId: userId,
        lastSyncError: null,
      });
      const sealed = await kms.encrypt(
        JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }),
        this.context(placeholder),
      );
      await r.pmsConnection.update(placeholder.id, { encryptedTokens: sealed });
      await r.audit.record({
        actorType: 'user',
        actorUserId: userId,
        requestId: null,
        action: 'pms.connected',
        entityType: 'pms_connection',
        entityId: placeholder.id,
        changes: { provider: 'apaleo', accountCode: account.accountCode },
      });
      await r.outbox.add('job.enqueue', {
        type: 'pms.sync',
        payload: { orgId },
        dedupeKey: `pms.sync:${orgId}:${Date.now()}`,
      });
    });
    this.tokenCache.clear();
    return back('connected');
  }

  async requestSync(ctx: OrgContext): Promise<void> {
    assertCan(ctx, 'pms.manage');
    await this.deps.db.tenant(ctx.orgId, async (r) => {
      const c = await r.pmsConnection.get();
      if (!c || c.status === 'revoked') throw new NotFoundError('PMS connection');
      await r.outbox.add('job.enqueue', { type: 'pms.sync', payload: { orgId: ctx.orgId } });
      await r.audit.record({
        ...userActor(ctx),
        action: 'pms.sync_requested',
        entityType: 'pms_connection',
        entityId: c.id,
      });
    });
  }

  async disconnect(ctx: OrgContext): Promise<void> {
    assertCan(ctx, 'pms.manage');
    const { db, kms, provider, logger } = this.deps;
    const connection = await db.tenant(ctx.orgId, (r) => r.pmsConnection.get());
    if (!connection || connection.status === 'revoked') throw new NotFoundError('PMS connection');
    try {
      const client = await this.clientFor(ctx.orgId);
      if (connection.webhookSubscriptionId)
        await client.unsubscribeWebhooks(connection.webhookSubscriptionId);
      const tokens = StoredTokens.parse(
        JSON.parse(await kms.decrypt(connection.encryptedTokens, this.context(connection))),
      );
      if (tokens.refreshToken) await provider.revoke(tokens.refreshToken);
    } catch (error) {
      logger.warn(
        { err: error, orgId: ctx.orgId },
        'could not clean up PMS connection; disconnecting anyway',
      );
    }
    await db.tenant(ctx.orgId, async (r) => {
      await r.pmsConnection.update(connection.id, {
        status: 'revoked',
        encryptedTokens: 'revoked',
        webhookSubscriptionId: null,
      });
      await r.audit.record({
        ...userActor(ctx),
        action: 'pms.disconnected',
        entityType: 'pms_connection',
        entityId: connection.id,
      });
    });
    this.tokenCache.delete(connection.id);
  }

  /** A PMS client for the organization's active connection. */
  async clientFor(orgId: string): Promise<PmsClient> {
    const connection = await this.deps.db.tenant(orgId, (r) => r.pmsConnection.get());
    if (!connection || connection.status === 'revoked') {
      throw new UnprocessableError('pms_not_connected', 'This hotel has not connected its PMS');
    }
    return this.deps.provider.client(() => this.accessToken(connection));
  }

  private async accessToken(connection: PmsConnectionRow): Promise<string> {
    const now = this.deps.clock.now().getTime();
    const cached = this.tokenCache.get(connection.id);
    if (cached && cached.expiresAt > now) return cached.token;

    const { db, kms, provider, logger } = this.deps;
    return db.tenant(connection.organizationId, async (r) => {
      const locked = await r.pmsConnection.getForUpdate(connection.id);
      if (!locked || locked.status === 'revoked')
        throw new UnprocessableError('pms_not_connected', 'PMS connection revoked');
      const tokens = StoredTokens.parse(
        JSON.parse(await kms.decrypt(locked.encryptedTokens, this.context(locked))),
      );
      if (locked.accessTokenExpiresAt.getTime() > now + 30_000) {
        this.tokenCache.set(locked.id, {
          token: tokens.accessToken,
          expiresAt: locked.accessTokenExpiresAt.getTime() - 30_000,
        });
        return tokens.accessToken;
      }
      if (!tokens.refreshToken) throw new UnprocessableError('pms_reauth_required', 'Reconnect your PMS');
      try {
        const fresh = await provider.refresh(tokens.refreshToken);
        const sealed = await kms.encrypt(
          JSON.stringify({
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken ?? tokens.refreshToken,
          }),
          this.context(locked),
        );
        await r.pmsConnection.update(locked.id, {
          encryptedTokens: sealed,
          accessTokenExpiresAt: fresh.expiresAt,
          status: 'active',
          lastSyncError: locked.status === 'error' ? null : locked.lastSyncError,
        });
        this.tokenCache.set(locked.id, {
          token: fresh.accessToken,
          expiresAt: fresh.expiresAt.getTime() - 30_000,
        });
        return fresh.accessToken;
      } catch (error) {
        logger.error({ err: error, connectionId: locked.id }, 'PMS token refresh failed');
        if (
          error instanceof UpstreamError &&
          (error.details?.status === 400 || error.details?.status === 401)
        ) {
          await r.pmsConnection.update(locked.id, {
            status: 'error',
            lastSyncError: 'Access to Apaleo was revoked or expired. Reconnect Apaleo.',
          });
          await r.audit.record({
            ...systemActor,
            action: 'pms.reauth_required',
            entityType: 'pms_connection',
            entityId: locked.id,
          });
        }
        throw error;
      }
    });
  }
}

export function toStatus(c: PmsConnectionRow | undefined): PmsConnectionStatus {
  const live = c && c.status !== 'revoked';
  return {
    connected: !!live,
    provider: 'apaleo',
    accountCode: live ? c.accountCode : null,
    accountName: live ? c.accountName : null,
    status: c?.status ?? null,
    lastSyncAt: live ? (c.lastSyncAt?.toISOString() ?? null) : null,
    lastSyncStatus: live ? c.lastSyncStatus : null,
    lastSyncError: live ? c.lastSyncError : null,
    lastSyncStats: live ? (c.lastSyncStats ?? null) : null,
    webhooksActive: !!(live && c.webhookSubscriptionId),
  };
}
