import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { webEnv } from './env';

export interface CognitoTokens {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authorizeUrl(state: string, challenge: string): string {
  const env = webEnv();
  const url = new URL(`https://${env.cognito.domain}/oauth2/authorize`);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: env.cognito.clientId,
    redirect_uri: `${env.webBaseUrl}/auth/callback`,
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

export function logoutUrl(): string {
  const env = webEnv();
  const url = new URL(`https://${env.cognito.domain}/logout`);
  url.search = new URLSearchParams({
    client_id: env.cognito.clientId,
    logout_uri: `${env.webBaseUrl}/login`,
  }).toString();
  return url.toString();
}

async function tokenRequest(params: Record<string, string>): Promise<CognitoTokens> {
  const env = webEnv();
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (env.cognito.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${env.cognito.clientId}:${env.cognito.clientSecret}`).toString('base64')}`;
  }
  const res = await fetch(`https://${env.cognito.domain}/oauth2/token`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ client_id: env.cognito.clientId, ...params }).toString(),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Cognito token endpoint returned ${res.status}`);
  return (await res.json()) as CognitoTokens;
}

export function exchangeCode(code: string, verifier: string): Promise<CognitoTokens> {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: `${webEnv().webBaseUrl}/auth/callback`,
  });
}

export function refreshTokens(refreshToken: string): Promise<CognitoTokens> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

/** Only same-site relative paths are allowed as post-login destinations. */
export function safeNext(next: string | null | undefined): string {
  // A single leading slash followed by a non-slash, non-backslash character (blocks //evil.com and /\evil.com).
  return next && /^\/(?![/\\])/.test(next) ? next : '/app';
}
