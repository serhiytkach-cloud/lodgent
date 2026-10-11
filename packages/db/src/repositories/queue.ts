import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { jobs, outbox } from '../schema';

export type OutboxRow = typeof outbox.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;

/** System-level access to the outbox (dispatcher side). */
export function outboxDispatchRepo(tx: Tx) {
  return {
    /** Locks up to `limit` undispatched messages that are due. Other dispatchers skip them. */
    async claimPending(now: Date, limit: number): Promise<OutboxRow[]> {
      return tx
        .select()
        .from(outbox)
        .where(and(isNull(outbox.dispatchedAt), sql`${outbox.availableAt} <= ${now}`))
        .orderBy(asc(outbox.id))
        .limit(limit)
        .for('update', { skipLocked: true });
    },
    async markDispatched(id: number, now: Date) {
      await tx.update(outbox).set({ dispatchedAt: now }).where(eq(outbox.id, id));
    },
    /** Drops a delivered message's content (invitation links, guest emails) but keeps the row. */
    async scrub(id: number) {
      await tx
        .update(outbox)
        .set({ payload: { scrubbed: true } })
        .where(eq(outbox.id, id));
    },
    async markFailed(id: number, error: string, retryAt: Date) {
      await tx
        .update(outbox)
        .set({ attempts: sql`${outbox.attempts} + 1`, lastError: error.slice(0, 2000), availableAt: retryAt })
        .where(eq(outbox.id, id));
    },
    async add(
      topic: string,
      payload: Record<string, unknown>,
      options?: { organizationId?: string | null; dedupeKey?: string; availableAt?: Date },
    ) {
      await tx
        .insert(outbox)
        .values({
          organizationId: options?.organizationId ?? null,
          topic,
          payload,
          dedupeKey: options?.dedupeKey,
          availableAt: options?.availableAt,
        })
        .onConflictDoNothing({ target: outbox.dedupeKey });
    },
  };
}

/** Postgres-backed job queue (local and test stand-in for SQS). */
export function jobRepo(tx: Tx) {
  return {
    async enqueue(
      type: string,
      payload: Record<string, unknown>,
      options?: { runAt?: Date; dedupeKey?: string; maxAttempts?: number },
    ) {
      await tx
        .insert(jobs)
        .values({
          type,
          payload,
          runAt: options?.runAt,
          dedupeKey: options?.dedupeKey,
          maxAttempts: options?.maxAttempts,
        })
        .onConflictDoNothing({ target: jobs.dedupeKey });
    },
    /** Claims due jobs and leases them until `leaseUntil`. Expired leases become claimable again. */
    async claim(now: Date, leaseUntil: Date, limit: number): Promise<JobRow[]> {
      const candidates = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            isNull(jobs.completedAt),
            isNull(jobs.failedAt),
            sql`${jobs.runAt} <= ${now}`,
            sql`(${jobs.lockedUntil} is null or ${jobs.lockedUntil} < ${now})`,
          ),
        )
        .orderBy(asc(jobs.runAt), asc(jobs.id))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (candidates.length === 0) return [];
      return tx
        .update(jobs)
        .set({ lockedUntil: leaseUntil, attempts: sql`${jobs.attempts} + 1` })
        .where(
          sql`${jobs.id} in (${sql.join(
            candidates.map((c) => sql`${c.id}`),
            sql`, `,
          )})`,
        )
        .returning();
    },
    async complete(id: number, now: Date) {
      await tx.update(jobs).set({ completedAt: now, lockedUntil: null }).where(eq(jobs.id, id));
    },
    async retry(id: number, error: string, runAt: Date) {
      await tx
        .update(jobs)
        .set({ lastError: error.slice(0, 2000), runAt, lockedUntil: null })
        .where(eq(jobs.id, id));
    },
    async fail(id: number, error: string, now: Date) {
      await tx
        .update(jobs)
        .set({ lastError: error.slice(0, 2000), failedAt: now, lockedUntil: null })
        .where(eq(jobs.id, id));
    },
  };
}
