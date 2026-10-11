import type { IdentityProvider, VerifiedIdentity } from '@lodgent/core';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

/**
 * Verifies Cognito ID tokens (issued by the user pool's managed login / hosted UI) against the
 * pool's JWKS. The web app runs the OAuth authorization-code + PKCE flow and forwards the ID token.
 */
export class CognitoIdentityProvider implements IdentityProvider {
  readonly kind = 'cognito' as const;
  private readonly verifier;

  constructor(options: { userPoolId: string; clientId: string }) {
    this.verifier = CognitoJwtVerifier.create({
      userPoolId: options.userPoolId,
      clientId: options.clientId,
      tokenUse: 'id',
    });
  }

  async verify(token: string): Promise<VerifiedIdentity | null> {
    try {
      const payload = await this.verifier.verify(token);
      const email = payload.email;
      if (typeof email !== 'string' || payload.email_verified === false) return null;
      return {
        subject: `cognito:${payload.sub}`,
        email,
        name: typeof payload.name === 'string' ? payload.name : null,
      };
    } catch {
      return null;
    }
  }
}
