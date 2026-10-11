import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { auditLogs, invitations, memberships, organizations, outbox, properties, users } from '../schema';

export type OrganizationRow = typeof organizations.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type MembershipRole = (typeof memberships.$inferSelect)['role'];
export type InvitationRow = typeof invitations.$inferSelect;
export type PropertyRow = typeof properties.$inferSelect;
export type NewProperty = Omit<typeof properties.$inferInsert, 'organizationId' | 'id'>;
export type AuditLogRow = typeof auditLogs.$inferSelect;

export function organizationRepo(tx: Tx, orgId: string) {
  return {
    async get(): Promise<OrganizationRow | undefined> {
      const [row] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
      return row;
    },
    async update(patch: Partial<Pick<OrganizationRow, 'name' | 'billingEmail' | 'stripeCustomerId'>>) {
      const [row] = await tx.update(organizations).set(patch).where(eq(organizations.id, orgId)).returning();
      return row;
    },
  };
}

export function membershipRepo(tx: Tx, orgId: string) {
  return {
    async list() {
      return tx
        .select({
          userId: memberships.userId,
          role: memberships.role,
          createdAt: memberships.createdAt,
          email: users.email,
          name: users.name,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(eq(memberships.organizationId, orgId))
        .orderBy(memberships.createdAt);
    },
    async get(userId: string) {
      const [row] = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)));
      return row;
    },
    async add(userId: string, role: MembershipRole) {
      const [row] = await tx
        .insert(memberships)
        .values({ organizationId: orgId, userId, role })
        .onConflictDoNothing()
        .returning();
      return row;
    },
    async setRole(userId: string, role: MembershipRole) {
      const [row] = await tx
        .update(memberships)
        .set({ role })
        .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)))
        .returning();
      return row;
    },
    async remove(userId: string) {
      const rows = await tx
        .delete(memberships)
        .where(and(eq(memberships.organizationId, orgId), eq(memberships.userId, userId)))
        .returning();
      return rows.length > 0;
    },
    async countOwners(): Promise<number> {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(memberships)
        .where(and(eq(memberships.organizationId, orgId), eq(memberships.role, 'owner')));
      return row?.n ?? 0;
    },
  };
}

export function invitationRepo(tx: Tx, orgId: string) {
  return {
    async listPending(now: Date) {
      return tx
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.organizationId, orgId),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            sql`${invitations.expiresAt} > ${now}`,
          ),
        )
        .orderBy(desc(invitations.createdAt));
    },
    async create(values: {
      email: string;
      role: MembershipRole;
      tokenHash: string;
      invitedByUserId: string | null;
      expiresAt: Date;
    }) {
      const [row] = await tx
        .insert(invitations)
        .values({ ...values, organizationId: orgId })
        .returning();
      return row!;
    },
    async revoke(id: string, now: Date) {
      const [row] = await tx
        .update(invitations)
        .set({ revokedAt: now })
        .where(
          and(eq(invitations.organizationId, orgId), eq(invitations.id, id), isNull(invitations.acceptedAt)),
        )
        .returning();
      return row;
    },
    async markAccepted(id: string, userId: string, now: Date) {
      const [row] = await tx
        .update(invitations)
        .set({ acceptedAt: now, acceptedByUserId: userId })
        .where(and(eq(invitations.organizationId, orgId), eq(invitations.id, id)))
        .returning();
      return row;
    },
  };
}

export function propertyRepo(tx: Tx, orgId: string) {
  return {
    async list() {
      return tx
        .select()
        .from(properties)
        .where(eq(properties.organizationId, orgId))
        .orderBy(properties.name);
    },
    async get(id: string): Promise<PropertyRow | undefined> {
      const [row] = await tx
        .select()
        .from(properties)
        .where(and(eq(properties.organizationId, orgId), eq(properties.id, id)));
      return row;
    },
    async getByPmsId(pmsPropertyId: string): Promise<PropertyRow | undefined> {
      const [row] = await tx
        .select()
        .from(properties)
        .where(and(eq(properties.organizationId, orgId), eq(properties.pmsPropertyId, pmsPropertyId)));
      return row;
    },
    async create(values: NewProperty): Promise<PropertyRow> {
      const [row] = await tx
        .insert(properties)
        .values({ ...values, organizationId: orgId })
        .returning();
      return row!;
    },
    async update(id: string, patch: Partial<NewProperty>): Promise<PropertyRow | undefined> {
      const [row] = await tx
        .update(properties)
        .set(patch)
        .where(and(eq(properties.organizationId, orgId), eq(properties.id, id)))
        .returning();
      return row;
    },
  };
}

export interface AuditEntry {
  actorType: 'user' | 'system';
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  changes?: Record<string, unknown> | null;
  requestId?: string | null;
}

export function auditRepo(tx: Tx, orgId: string) {
  return {
    async record(entry: AuditEntry) {
      await tx.insert(auditLogs).values({ ...entry, organizationId: orgId });
    },
    async recordMany(entries: AuditEntry[]) {
      if (entries.length === 0) return;
      await tx.insert(auditLogs).values(entries.map((entry) => ({ ...entry, organizationId: orgId })));
    },
    /** How many entries with one of `actions` were written since `since` (simple per-org quotas). */
    async countSince(actions: string[], since: Date): Promise<number> {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, orgId),
            inArray(auditLogs.action, actions),
            gte(auditLogs.createdAt, since),
          ),
        );
      return row?.n ?? 0;
    },
    async list(options: { limit: number; before?: Date }) {
      return tx
        .select({
          id: auditLogs.id,
          actorType: auditLogs.actorType,
          actorUserId: auditLogs.actorUserId,
          actorEmail: users.email,
          action: auditLogs.action,
          entityType: auditLogs.entityType,
          entityId: auditLogs.entityId,
          changes: auditLogs.changes,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(
          and(
            eq(auditLogs.organizationId, orgId),
            options.before ? lt(auditLogs.createdAt, options.before) : undefined,
          ),
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(options.limit);
    },
  };
}

export function outboxRepo(tx: Tx, orgId: string | null) {
  return {
    /** Enqueues a side effect in the current transaction. Duplicate dedupe keys are ignored. */
    async add(
      topic: string,
      payload: Record<string, unknown>,
      options?: { dedupeKey?: string; availableAt?: Date },
    ) {
      await tx
        .insert(outbox)
        .values({
          organizationId: orgId,
          topic,
          payload,
          dedupeKey: options?.dedupeKey,
          availableAt: options?.availableAt,
        })
        .onConflictDoNothing({ target: outbox.dedupeKey });
    },
    /**
     * Guest erasure: drops booking confirmations to `email` that have not been sent yet (sent ones
     * are already scrubbed by the dispatcher). Returns how many were removed.
     */
    async deletePendingGuestEmails(email: string): Promise<number> {
      if (!orgId) return 0;
      const result = await tx
        .delete(outbox)
        .where(
          and(
            eq(outbox.organizationId, orgId),
            eq(outbox.topic, 'email.send'),
            isNull(outbox.dispatchedAt),
            sql`${outbox.payload}->>'template' = 'booking-confirmation'`,
            sql`lower(${outbox.payload}->>'to') = lower(${email})`,
          ),
        );
      return result.rowCount ?? 0;
    },
  };
}
