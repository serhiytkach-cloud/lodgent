import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export type SigningPurpose = 'oauth-state' | 'checkout' | 'webhook-path';

/**
 * Compact signed tokens (`base64url(payload).base64url(hmac)`) with an expiry. Each purpose uses its
 * own key derived from the root secret (HKDF), so a token minted for one purpose is useless for
 * another.
 */
export class Signer {
  private readonly keys = new Map<SigningPurpose, Buffer>();

  constructor(private readonly rootSecret: string) {}

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
    const [body, mac] = token.split('.');
    if (!body || !mac) return null;
    const expected = createHmac('sha256', this.key(purpose)).update(body).digest();
    const actual = Buffer.from(mac, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
      if (typeof payload.exp !== 'number' || payload.exp * 1000 < now.getTime()) return null;
      return payload;
    } catch {
      return null;
    }
  }
}
