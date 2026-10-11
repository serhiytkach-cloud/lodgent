import type { IdentityProvider, VerifiedIdentity } from '@lodgent/core';
import { jwtVerify, SignJWT } from 'jose';

const ISSUER = 'lodgent-dev-auth';
const AUDIENCE = 'lodgent-dashboard';

/**
 * Local development identity provider: anyone can sign in with an email address and gets an
 * HS256 session token. Never enabled in production (config refuses AUTH_PROVIDER=dev there).
 */
export class DevIdentityProvider implements IdentityProvider {
  readonly kind = 'dev' as const;
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async issue(email: string, name?: string | null, ttlSeconds = 7 * 24 * 3600): Promise<string> {
    const normalized = email.trim().toLowerCase();
    return new SignJWT({ email: normalized, name: name ?? undefined })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(`dev:${normalized}`)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.key);
  }

  async verify(token: string): Promise<VerifiedIdentity | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') return null;
      return {
        subject: payload.sub,
        email: payload.email,
        name: typeof payload.name === 'string' ? payload.name : null,
      };
    } catch {
      return null;
    }
  }
}
