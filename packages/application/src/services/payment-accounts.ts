import { type Clock, type ConnectedAccount, NotFoundError, type PaymentProvider } from '@lodgent/core';
import type { Database, PaymentAccountRow, TenantRepos } from '@lodgent/db';
import type { PaymentAccountDto } from '@lodgent/shared';
import type { Logger } from 'pino';
import { assertCan, type OrgContext, userActor } from '../context';

function statusOf(a: ConnectedAccount): PaymentAccountRow['status'] {
  if (a.chargesEnabled) return 'active';
  return a.detailsSubmitted ? 'restricted' : 'onboarding';
}

/** Stripe Connect onboarding for a hotel group (one connected account per organization). */
export class PaymentAccountService {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      payments: PaymentProvider;
      logger: Logger;
      webBaseUrl: string;
      defaultFeeBps: number;
    },
  ) {}

  private toDto(row: PaymentAccountRow | undefined): PaymentAccountDto {
    return {
      connected: !!row,
      status: row?.status ?? 'not_connected',
      accountId: row?.accountId ?? null,
      chargesEnabled: row?.chargesEnabled ?? false,
      payoutsEnabled: row?.payoutsEnabled ?? false,
      detailsSubmitted: row?.detailsSubmitted ?? false,
      requirementsDue: row?.requirementsDue ?? [],
      defaultFeeBps: this.deps.defaultFeeBps,
    };
  }

  private static patch(a: ConnectedAccount) {
    return {
      status: statusOf(a),
      chargesEnabled: a.chargesEnabled,
      payoutsEnabled: a.payoutsEnabled,
      detailsSubmitted: a.detailsSubmitted,
      country: a.country,
      defaultCurrency: a.defaultCurrency,
      requirementsDue: a.requirementsDue,
    };
  }

  async get(ctx: OrgContext): Promise<PaymentAccountDto> {
    assertCan(ctx, 'org.read');
    return this.toDto(await this.deps.db.tenant(ctx.orgId, (r) => r.paymentAccount.get()));
  }

  /**
   * Creates the connected account on first use, then returns a fresh hosted onboarding link
   * (Stripe collects identity, business and bank details; we never see them).
   */
  async startOnboarding(ctx: OrgContext): Promise<{ url: string }> {
    assertCan(ctx, 'payments.manage');
    const { db, payments, webBaseUrl } = this.deps;
    let row = await db.tenant(ctx.orgId, (r) => r.paymentAccount.get());
    if (!row) {
      const org = await db.tenant(ctx.orgId, async (r) => ({
        org: await r.organization.get(),
        properties: await r.properties.list(),
      }));
      const country = org.properties.find((p) => p.countryCode)?.countryCode ?? null;
      const account = await payments.createConnectedAccount({
        email: org.org?.billingEmail ?? ctx.email,
        country,
        metadata: { organizationId: ctx.orgId },
      });
      row = await db.tenant(ctx.orgId, async (r) => {
        // Another admin may have connected concurrently; keep the first account.
        const existing = await r.paymentAccount.get();
        if (existing) return existing;
        const created = await r.paymentAccount.create({
          provider: payments.name,
          accountId: account.id,
          connectedByUserId: ctx.userId,
          ...PaymentAccountService.patch(account),
        });
        await r.audit.record({
          ...userActor(ctx),
          action: 'payments.account_created',
          entityType: 'payment_account',
          entityId: created.id,
          changes: { provider: payments.name, accountId: account.id },
        });
        return created;
      });
    }
    const base = `${webBaseUrl}/app/${ctx.orgId}/settings/connections`;
    const url = await payments.createOnboardingLink({
      accountId: row.accountId,
      refreshUrl: `${base}?stripe=refresh`,
      returnUrl: `${base}?stripe=return`,
    });
    return { url };
  }

  /** Pulls the account's current state from Stripe (after onboarding returns, or on a webhook). */
  async refresh(ctx: OrgContext): Promise<PaymentAccountDto> {
    assertCan(ctx, 'org.read');
    const row = await this.deps.db.tenant(ctx.orgId, (r) => r.paymentAccount.get());
    if (!row) throw new NotFoundError('Payment account');
    return this.toDto(await this.sync(ctx.orgId, row.accountId));
  }

  async handleAccountUpdated(accountId: string): Promise<void> {
    const owner = await this.deps.db.system(({ bookings }) => bookings.paymentAccountOrg(accountId));
    if (!owner) {
      this.deps.logger.warn({ accountId }, 'account.updated for an unknown connected account');
      return;
    }
    await this.sync(owner.organizationId, accountId);
  }

  private async sync(orgId: string, accountId: string): Promise<PaymentAccountRow | undefined> {
    const account = await this.deps.payments.getConnectedAccount(accountId);
    return this.deps.db.tenant(orgId, async (r) => {
      const before = await r.paymentAccount.get();
      const after = await r.paymentAccount.update(PaymentAccountService.patch(account));
      if (before && after && before.status !== after.status) {
        await r.audit.record({
          actorType: 'system',
          actorUserId: null,
          requestId: null,
          action: 'payments.account_status_changed',
          entityType: 'payment_account',
          entityId: after.id,
          changes: { from: before.status, to: after.status },
        });
      }
      return after;
    });
  }

  /** The account a property's bookings are charged on, if it can take payments. */
  static async chargeableAccount(r: TenantRepos): Promise<PaymentAccountRow | null> {
    const row = await r.paymentAccount.get();
    return row?.chargesEnabled ? row : null;
  }
}
