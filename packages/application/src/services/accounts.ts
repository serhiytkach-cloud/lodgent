import type { Clock, VerifiedIdentity } from '@lodgent/core';
import type { Database, UserRow } from '@lodgent/db';

const LAST_LOGIN_RESOLUTION_MS = 60 * 60 * 1000;

export class AccountService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /**
   * Maps a verified identity to a user row, creating it on first sign-in. If a user with the same
   * (verified) email exists under another subject, e.g. after moving from dev auth to Cognito, the
   * account is linked to the new subject.
   */
  async resolveUser(identity: VerifiedIdentity): Promise<UserRow> {
    const now = this.clock.now();
    return this.db.system(async ({ identity: repo }) => {
      const existing = await repo.findUserBySubject(identity.subject);
      if (existing) {
        const stale =
          !existing.lastLoginAt || now.getTime() - existing.lastLoginAt.getTime() > LAST_LOGIN_RESOLUTION_MS;
        const emailChanged = existing.email !== identity.email.toLowerCase();
        return stale || emailChanged
          ? repo.upsertUser({ authSubject: identity.subject, ...identity }, now)
          : existing;
      }
      const byEmail = await repo.findUserByEmail(identity.email);
      if (byEmail) {
        return repo.relinkUser(byEmail.id, identity.subject, now);
      }
      return repo.upsertUser(
        { authSubject: identity.subject, email: identity.email, name: identity.name },
        now,
      );
    });
  }

  async me(userId: string) {
    return this.db.system(async ({ identity }) => {
      const user = await identity.getUser(userId);
      const memberships = await identity.membershipsForUser(userId);
      return { user, memberships };
    });
  }

  /** The caller's role in an organization, or null if they are not a member. */
  async roleIn(userId: string, organizationId: string) {
    const membership = await this.db.system(({ identity }) => identity.membership(userId, organizationId));
    return membership?.role ?? null;
  }
}
