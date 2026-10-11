/** A signed-in hotel user as asserted by the identity provider (Cognito, or the dev provider). */
export interface VerifiedIdentity {
  /** Stable, provider-qualified subject, e.g. `cognito:8f1c…`. */
  subject: string;
  email: string;
  name?: string | null;
}

export interface IdentityProvider {
  readonly kind: 'dev' | 'cognito';
  /** Verifies a bearer token and returns the identity, or null if it is invalid or expired. */
  verify(token: string): Promise<VerifiedIdentity | null>;
}
