import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { invitations, memberships, organizations, properties, users } from '../schema';
import type { MembershipRole, OrganizationRow, UserRow } from './tenancy';

/**
 * Cross-tenant identity operations: sign-in, "which organizations am I in", creating an
 * organization, resolving invitation tokens. Runs in the system context.
 */
export function identityRepo(tx: Tx) {
  return {
    async findUserBySubject(authSubject: string): Promise<UserRow | undefined> {
      const [row] = await tx.select().from(users).where(eq(users.authSubject, authSubject));
      return row;
    },
    async findUserByEmail(email: string): Promise<UserRow | undefined> {
      const [row] = await tx.select().from(users).where(eq(users.email, email.toLowerCase()));
      return row;
    },
    async getUser(id: string): Promise<UserRow | undefined> {
      const [row] = await tx.select().from(users).where(eq(users.id, id));
      return row;
    },
    /**
     * Finds or creates the user for a verified identity. The subject is the stable key; the email is
     * refreshed from the identity provider on every sign-in.
     */
    async upsertUser(identity: { authSubject: string; email: string; name?: string | null }, now: Date) {
      const email = identity.email.toLowerCase();
      const [row] = await tx
        .insert(users)
        .values({ authSubject: identity.authSubject, email, name: identity.name ?? null, lastLoginAt: now })
        .onConflictDoUpdate({
          target: users.authSubject,
          set: { email, name: sql`coalesce(${identity.name ?? null}, ${users.name})`, lastLoginAt: now },
        })
        .returning();
      return row!;
    },
    async relinkUser(id: string, authSubject: string, now: Date): Promise<UserRow> {
      const [row] = await tx
        .update(users)
        .set({ authSubject, lastLoginAt: now })
        .where(eq(users.id, id))
        .returning();
      return row!;
    },
    async membershipsForUser(userId: string) {
      return tx
        .select({
          organizationId: organizations.id,
          organizationName: organizations.name,
          organizationSlug: organizations.slug,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
        .where(eq(memberships.userId, userId))
        .orderBy(organizations.name);
    },
    async membership(userId: string, organizationId: string): Promise<{ role: MembershipRole } | undefined> {
      const [row] = await tx
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)));
      return row;
    },
    async organizationSlugExists(slug: string): Promise<boolean> {
      const [row] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.slug, slug));
      return row !== undefined;
    },
    async propertySlugExists(slug: string): Promise<boolean> {
      const [row] = await tx.select({ id: properties.id }).from(properties).where(eq(properties.slug, slug));
      return row !== undefined;
    },
    async createOrganization(
      values: { name: string; slug: string; billingEmail?: string | null },
      ownerId: string,
    ) {
      const [org] = await tx.insert(organizations).values(values).returning();
      await tx.insert(memberships).values({ organizationId: org!.id, userId: ownerId, role: 'owner' });
      return org as OrganizationRow;
    },
    async findInvitationByTokenHash(tokenHash: string) {
      const [row] = await tx.select().from(invitations).where(eq(invitations.tokenHash, tokenHash));
      return row;
    },
  };
}
