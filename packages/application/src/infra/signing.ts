import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export type SigningPurpose = 'oauth-state' | 'checkout' | 'webhook-path';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Generous upper bound: real tokens are ~100-200 characters. */
const MAX_TOKEN_LENGTH = 2048;

/**
 * Compact signed tokens (`base64url(payload).base64url(hmac)`) with an expiry. Each purpose uses its
 * own key derived from the root secret (HKDF), so a token minted for one purpose is useless for
 * another. Verification is strict: exactly two canonical base64url parts, a constant-time MAC
 * comparison, a JSON object payload and an unexpired `exp`, so every token has exactly one valid
 * spelling.
 */
export class Signer {
  private readonly keys = new Map<SigningPurpose, Buffer>();

  constructor(private readonly rootSecret: string) {
    if (rootSecret.length < 32) throw new Error('The signing secret must be at least 32 characters');
  }

  private key(purpose: SigningPurpose): Buffer {
    let key = this.keys.get(purpose);
    if (!key) {
      key = Buffer.from(hkdfSync('sha256', this.rootSecret, 'lodgent', purpose, 32));
      this.keys.set(purpose, key);
    }
    return key;
  }

  sign(
    purpose: SigningPurpose,
    payload: Record<string, unknown>,
    ttlSeconds: number,
    now = new Date(),
  ): string {
    const body = Buffer.from(
      JSON.stringify({ ...payload, exp: Math.floor(now.getTime() / 1000) + ttlSeconds }),
    ).toString('base64url');
    const mac = createHmac('sha256', this.key(purpose)).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  verify<T extends Record<string, unknown>>(
    purpose: SigningPurpose,
    token: string,
    now = new Date(),
  ): T | null {
    if (token.length > MAX_TOKEN_LENGTH) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, mac] = parts as [string, string];
    if (!BASE64URL.test(body) || !BASE64URL.test(mac)) return null;
    // Compare the canonical encodings: a MAC with non-canonical trailing bits never matches.
    const expected = Buffer.from(createHmac('sha256', this.key(purpose)).update(body).digest('base64url'));
    const actual = Buffer.from(mac);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const exp = (payload as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp * 1000 < now.getTime()) return null;
    return payload as T;
  }
}
