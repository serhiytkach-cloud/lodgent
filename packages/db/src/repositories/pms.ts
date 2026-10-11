import { and, asc, desc, eq, gt, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  offerQuotes,
  pmsConnections,
  policies,
  properties,
  ratePlans,
  roomTypes,
  webhookEvents,
} from '../schema';

export type PmsConnectionRow = typeof pmsConnections.$inferSelect;
export type RoomTypeRow = typeof roomTypes.$inferSelect;
export type RatePlanRow = typeof ratePlans.$inferSelect;
export type PolicyRow = typeof policies.$inferSelect;
export type OfferQuoteRow = typeof offerQuotes.$inferSelect;
export type NewOfferQuote = Omit<typeof offerQuotes.$inferInsert, 'organizationId' | 'id' | 'createdAt'>;

export function pmsConnectionRepo(tx: Tx, orgId: string) {
  return {
    async get(provider = 'apaleo'): Promise<PmsConnectionRow | undefined> {
      const [row] = await tx
        .select()
        .from(pmsConnections)
        .where(and(eq(pmsConnections.organizationId, orgId), eq(pmsConnections.provider, provider)));
      return row;
    },
    /** Locks the connection row for a token refresh so concurrent requests don't race. */
    async getForUpdate(id: string): Promise<PmsConnectionRow | undefined> {
      const [row] = await tx
        .select()
        .from(pmsConnections)
        .where(and(eq(pmsConnections.organizationId, orgId), eq(pmsConnections.id, id)))
        .for('update');
      return row;
    },
    async upsert(
      values: Omit<typeof pmsConnections.$inferInsert, 'organizationId' | 'id'>,
    ): Promise<PmsConnectionRow> {
      const [row] = await tx
        .insert(pmsConnections)
        .values({ ...values, organizationId: orgId })
        .onConflictDoUpdate({
          target: [pmsConnections.organizationId, pmsConnections.provider],
          set: { ...values, updatedAt: new Date() },
        })
        .returning();
      return row!;
    },
    async update(id: string, patch: Partial<typeof pmsConnections.$inferInsert>) {
      const [row] = await tx
        .update(pmsConnections)
        .set(patch)
        .where(and(eq(pmsConnections.organizationId, orgId), eq(pmsConnections.id, id)))
        .returning();
      return row;
    },
  };
}

export function roomTypeRepo(tx: Tx, orgId: string) {
  return {
    async listForProperty(propertyId: string, options: { includeArchived?: boolean } = {}) {
      return tx
        .select()
        .from(roomTypes)
        .where(
          and(
            eq(roomTypes.organizationId, orgId),
            eq(roomTypes.propertyId, propertyId),
            options.includeArchived ? undefined : isNull(roomTypes.archivedAt),
          ),
        )
        .orderBy(asc(roomTypes.name));
    },
    async get(id: string): Promise<RoomTypeRow | undefined> {
      const [row] = await tx
        .select()
        .from(roomTypes)
        .where(and(eq(roomTypes.organizationId, orgId), eq(roomTypes.id, id)));
      return row;
    },
    async insert(values: Omit<typeof roomTypes.$inferInsert, 'organizationId' | 'id'>): Promise<RoomTypeRow> {
      const [row] = await tx
        .insert(roomTypes)
        .values({ ...values, organizationId: orgId })
        .returning();
      return row!;
    },
    async update(id: string, patch: Partial<typeof roomTypes.$inferInsert>) {
      const [row] = await tx
        .update(roomTypes)
        .set(patch)
        .where(and(eq(roomTypes.organizationId, orgId), eq(roomTypes.id, id)))
        .returning();
      return row;
    },
  };
}

export function ratePlanRepo(tx: Tx, orgId: string) {
  return {
    async listForProperty(propertyId: string, options: { includeArchived?: boolean } = {}) {
      return tx
        .select()
        .from(ratePlans)
        .where(
          and(
            eq(ratePlans.organizationId, orgId),
            eq(ratePlans.propertyId, propertyId),
            options.includeArchived ? undefined : isNull(ratePlans.archivedAt),
          ),
        )
        .orderBy(asc(ratePlans.name));
    },
    async get(id: string): Promise<RatePlanRow | undefined> {
      const [row] = await tx
        .select()
        .from(ratePlans)
        .where(and(eq(ratePlans.organizationId, orgId), eq(ratePlans.id, id)));
      return row;
    },
    async upsertByPmsId(
      propertyId: string,
      pmsId: string,
      values: Omit<
        typeof ratePlans.$inferInsert,
        'organizationId' | 'id' | 'propertyId' | 'pmsId' | 'exposedToAgents'
      >,
    ): Promise<RatePlanRow> {
      const [row] = await tx
        .insert(ratePlans)
        .values({ ...values, organizationId: orgId, propertyId, pmsId })
        .onConflictDoUpdate({
          target: [ratePlans.propertyId, ratePlans.pmsId],
          targetWhere: sql`${ratePlans.pmsId} is not null`,
          set: { ...values, updatedAt: new Date() },
        })
        .returning();
      return row!;
    },
    async setExposed(id: string, exposed: boolean) {
      const [row] = await tx
        .update(ratePlans)
        .set({ exposedToAgents: exposed })
        .where(and(eq(ratePlans.organizationId, orgId), eq(ratePlans.id, id)))
        .returning();
      return row;
    },
    async archiveMissing(propertyId: string, keepPmsIds: string[], now: Date) {
      await tx
        .update(ratePlans)
        .set({ archivedAt: now, exposedToAgents: false })
        .where(
          and(
            eq(ratePlans.organizationId, orgId),
            eq(ratePlans.propertyId, propertyId),
            isNull(ratePlans.archivedAt),
            keepPmsIds.length > 0 ? notInArray(ratePlans.pmsId, keepPmsIds) : undefined,
          ),
        );
    },
  };
}

export function policyRepo(tx: Tx, orgId: string) {
  return {
    async listForProperty(propertyId: string) {
      return tx
        .select()
        .from(policies)
        .where(and(eq(policies.organizationId, orgId), eq(policies.propertyId, propertyId)))
        .orderBy(asc(policies.kind), asc(policies.title));
    },
    async upsertPms(
      propertyId: string,
      kind: PolicyRow['kind'],
      pmsId: string,
      values: {
        code: string | null;
        title: string;
        description: string | null;
        data?: Record<string, unknown>;
      },
    ): Promise<PolicyRow> {
      const [row] = await tx
        .insert(policies)
        .values({ ...values, organizationId: orgId, propertyId, kind, pmsId, source: 'pms' })
        .onConflictDoUpdate({
          target: [policies.propertyId, policies.kind, policies.pmsId],
          targetWhere: sql`${policies.pmsId} is not null`,
          set: { ...values, updatedAt: new Date() },
        })
        .returning();
      return row!;
    },
    async upsertHotel(
      propertyId: string,
      kind: PolicyRow['kind'],
      values: { title: string; description: string | null; data?: Record<string, unknown> },
    ) {
      const [existing] = await tx
        .select()
        .from(policies)
        .where(
          and(
            eq(policies.organizationId, orgId),
            eq(policies.propertyId, propertyId),
            eq(policies.kind, kind),
            eq(policies.source, 'hotel'),
          ),
        );
      if (existing) {
        const [row] = await tx.update(policies).set(values).where(eq(policies.id, existing.id)).returning();
        return row!;
      }
      const [row] = await tx
        .insert(policies)
        .values({ ...values, organizationId: orgId, propertyId, kind, source: 'hotel' })
        .returning();
      return row!;
    },
    async delete(id: string) {
      await tx.delete(policies).where(and(eq(policies.organizationId, orgId), eq(policies.id, id)));
    },
  };
}

export function offerQuoteRepo(tx: Tx, orgId: string) {
  return {
    /** Inserts one search's quotes with a shared, millisecond-precision timestamp (the cache key). */
    async insertMany(values: NewOfferQuote[], createdAt: Date): Promise<OfferQuoteRow[]> {
      if (values.length === 0) return [];
      return tx
        .insert(offerQuotes)
        .values(values.map((v) => ({ ...v, organizationId: orgId, createdAt })))
        .returning();
    },
    /** Quotes for the same search created after `since` (the cache window). */
    async findCached(propertyId: string, queryKey: string, since: Date): Promise<OfferQuoteRow[]> {
      const [latest] = await tx
        .select({ createdAt: offerQuotes.createdAt })
        .from(offerQuotes)
        .where(
          and(
            eq(offerQuotes.organizationId, orgId),
            eq(offerQuotes.propertyId, propertyId),
            eq(offerQuotes.queryKey, queryKey),
            gt(offerQuotes.createdAt, since),
          ),
        )
        .orderBy(desc(offerQuotes.createdAt))
        .limit(1);
      if (!latest) return [];
      return tx
        .select()
        .from(offerQuotes)
        .where(
          and(
            eq(offerQuotes.organizationId, orgId),
            eq(offerQuotes.propertyId, propertyId),
            eq(offerQuotes.queryKey, queryKey),
            eq(offerQuotes.createdAt, latest.createdAt),
          ),
        )
        .orderBy(asc(offerQuotes.totalAmount));
    },
    async get(id: string): Promise<OfferQuoteRow | undefined> {
      const [row] = await tx
        .select()
        .from(offerQuotes)
        .where(and(eq(offerQuotes.organizationId, orgId), eq(offerQuotes.id, id)));
      return row;
    },
  };
}

/** Cross-tenant PMS lookups: webhooks arrive with an Apaleo account id, schedules scan all connections. */
export function pmsSystemRepo(tx: Tx) {
  return {
    async connectionByAccount(provider: string, accountCode: string): Promise<PmsConnectionRow | undefined> {
      const [row] = await tx
        .select()
        .from(pmsConnections)
        .where(
          and(
            eq(pmsConnections.provider, provider),
            eq(pmsConnections.accountCode, accountCode),
            eq(pmsConnections.status, 'active'),
          ),
        );
      return row;
    },
    async activeConnections(): Promise<PmsConnectionRow[]> {
      return tx.select().from(pmsConnections).where(eq(pmsConnections.status, 'active'));
    },
    /** Finds the org owning an offer quote (agents only know the quote id). */
    async offerQuoteOrg(id: string): Promise<{ organizationId: string; propertyId: string } | undefined> {
      const [row] = await tx
        .select({ organizationId: offerQuotes.organizationId, propertyId: offerQuotes.propertyId })
        .from(offerQuotes)
        .where(eq(offerQuotes.id, id));
      return row;
    },
    async propertyOrg(propertyId: string): Promise<{ organizationId: string } | undefined> {
      const [row] = await tx
        .select({ organizationId: properties.organizationId })
        .from(properties)
        .where(eq(properties.id, propertyId));
      return row;
    },
    async deleteExpiredQuotes(before: Date): Promise<number> {
      const result = await tx.delete(offerQuotes).where(sql`${offerQuotes.expiresAt} < ${before}`);
      return result.rowCount ?? 0;
    },
    /** Records an inbound webhook event; returns false if it was already seen. */
    async recordWebhookEvent(provider: string, eventId: string, type: string): Promise<boolean> {
      const rows = await tx
        .insert(webhookEvents)
        .values({ provider, eventId, type })
        .onConflictDoNothing()
        .returning({ id: webhookEvents.id });
      return rows.length > 0;
    },
    async markWebhookProcessed(provider: string, eventId: string, now: Date) {
      await tx
        .update(webhookEvents)
        .set({ processedAt: now })
        .where(and(eq(webhookEvents.provider, provider), eq(webhookEvents.eventId, eventId)));
    },
    async ratePlansByIds(ids: string[]) {
      if (ids.length === 0) return [];
      return tx.select().from(ratePlans).where(inArray(ratePlans.id, ids));
    },
  };
}
