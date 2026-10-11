import type { PmsClient, PmsProvider, PmsTokens } from '@lodgent/core';
import { UpstreamError } from '@lodgent/core';
import { ApaleoClient } from './client';
import { TokenResponse } from './schemas';

/** Scopes requested from Apaleo. Must match the scopes registered for the app in the Apaleo store. */
export const DEFAULT_APALEO_SCOPES = [
  'offline_access',
  'setup.read',
  'rates.read',
  'availability.read',
  'reservations.manage',
  'folios.manage',
];

export interface ApaleoProviderOptions {
  clientId: string;
  clientSecret: string;
  identityUrl: string;
  apiUrl: string;
  webhookUrl: string;
  scopes?: string[];
  channelCode?: 'Ibe' | 'Direct';
  fetch?: typeof fetch;
}

/**
 * Apaleo "connected app" OAuth 2.0 authorization-code flow (identity.apaleo.com/connect/*), token
 * refresh, revocation, and a factory for account-bound API clients.
 */
export class ApaleoProvider implements PmsProvider {
  readonly name = 'apaleo' as const;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: ApaleoProviderOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const url = new URL(`${this.options.identityUrl}/connect/authorize`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.options.clientId,
      redirect_uri: redirectUri,
      scope: (this.options.scopes ?? DEFAULT_APALEO_SCOPES).join(' '),
      state,
    }).toString();
    return url.toString();
  }

  exchangeCode(code: string, redirectUri: string): Promise<PmsTokens> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  }

  refresh(refreshToken: string): Promise<PmsTokens> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.fetch(`${this.options.identityUrl}/connect/revocation`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: this.basicAuth() },
      body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token' }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  }

  client(getAccessToken: () => Promise<string>): PmsClient {
    return new ApaleoClient({
      apiUrl: this.options.apiUrl,
      webhookUrl: this.options.webhookUrl,
      getAccessToken,
      channelCode: this.options.channelCode,
      fetch: this.options.fetch,
    });
  }

  private basicAuth(): string {
    return `Basic ${Buffer.from(`${encodeURIComponent(this.options.clientId)}:${encodeURIComponent(this.options.clientSecret)}`).toString('base64')}`;
  }

  private async token(params: Record<string, string>): Promise<PmsTokens> {
    const res = await this.fetch(`${this.options.identityUrl}/connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: this.basicAuth() },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new UpstreamError('apaleo', `Apaleo token endpoint returned ${res.status}`, {
        status: res.status,
        body,
      });
    }
    const json = TokenResponse.parse(await res.json());
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      // Refresh a minute early to absorb clock skew.
      expiresAt: new Date(Date.now() + (json.expires_in - 60) * 1000),
      scope: json.scope ?? null,
    };
  }
}
