import 'server-only';
import { BRAND } from '@lodgent/shared';
import { cookies } from 'next/headers';
import { webEnv } from './env';

export const SESSION_COOKIE = BRAND.sessionCookie;
export const REFRESH_COOKIE = `${BRAND.slug}_refresh`;

export async function getSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

const cookieBase = () =>
  ({
    httpOnly: true,
    sameSite: 'lax',
    secure: webEnv().isProduction,
    path: '/',
  }) as const;

/** Only callable from Server Actions and Route Handlers. */
export async function setSession(token: string, options: { maxAgeSeconds: number; refreshToken?: string }) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, { ...cookieBase(), maxAge: options.maxAgeSeconds });
  if (options.refreshToken) {
    store.set(REFRESH_COOKIE, options.refreshToken, { ...cookieBase(), maxAge: 30 * 24 * 3600 });
  }
}

export async function clearSession() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(REFRESH_COOKIE);
}

/** Reads a JWT's `exp` without verifying it (the API verifies; this only decides when to refresh). */
export function tokenExpiresAt(token: string): number | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}
