import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { holds } from '../schema';

export type HoldRow = typeof holds.$inferSelect;
export type NewHold = Omit<typeof holds.$inferInsert, 'organizationId' | 'id' | 'createdAt' | 'updatedAt'>;
export type HoldStatus = HoldRow['status'];

export function holdRepo(tx: Tx, orgId: string) {
  const own = eq(holds.organizationId, orgId);
  return {
    async create(values: NewHold): Promise<HoldRow> {
      const [row] = await tx
        .insert(holds)
        .values({ ...values, organizationId: orgId })
        .returning();
      return row!;
    },
    async get(id: string): Promise<HoldRow | undefined> {
      const [row] = await tx
        .select()
        .from(holds)
        .where(and(own, eq(holds.id, id)));
      return row;
    },
    /** Serializes hold creation per room type (row lock until the transaction ends). */
    async lockRoomType(roomTypeId: string): Promise<void> {
      await tx.execute(
        sql`select 1 from room_types where id = ${roomTypeId} and organization_id = ${orgId} for update`,
      );
    },
    /** Holds still competing for the same room type on overlapping nights. */
    async countActiveOverlapping(
      roomTypeId: string,
      arrival: string,
      departure: string,
      now: Date,
    ): Promise<number> {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(holds)
        .where(
          and(
            own,
            eq(holds.roomTypeId, roomTypeId),
            inArray(holds.status, ['active', 'processing']),
            gt(holds.expiresAt, now),
            lt(holds.arrival, departure),
            gt(holds.departure, arrival),
          ),
        );
      return row?.n ?? 0;
    },
    async setStatus(
      id: string,
      status: HoldStatus,
      reason: string | null = null,
    ): Promise<HoldRow | undefined> {
      const [row] = await tx
        .update(holds)
        .set({ status, statusReason: reason })
        .where(and(own, eq(holds.id, id)))
        .returning();
      return row;
    },
  };
}

/** Cross-tenant hold maintenance and lookups by id (agents only know the hold id). */
export function holdSystemRepo(tx: Tx) {
  return {
    async owner(id: string): Promise<{ organizationId: string; propertyId: string } | undefined> {
      const [row] = await tx
        .select({ organizationId: holds.organizationId, propertyId: holds.propertyId })
        .from(holds)
        .where(eq(holds.id, id));
      return row;
    },
    /** Marks active holds past their expiry as expired; returns how many. */
    async expireDue(now: Date): Promise<number> {
      const result = await tx
        .update(holds)
        .set({ status: 'expired', statusReason: 'Checkout not completed in time' })
        .where(and(eq(holds.status, 'active'), lt(holds.expiresAt, now)));
      return result.rowCount ?? 0;
    },
  };
}
