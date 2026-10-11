import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  properties,
  visibilityQueries,
  visibilityResults,
  visibilityRuns,
  visibilitySettings,
} from '../schema';

export type VisibilitySettingsRow = typeof visibilitySettings.$inferSelect;
export type VisibilityQueryRow = typeof visibilityQueries.$inferSelect;
export type VisibilityRunRow = typeof visibilityRuns.$inferSelect;
export type VisibilityResultRow = typeof visibilityResults.$inferSelect;
export type NewVisibilityResult = Omit<
  typeof visibilityResults.$inferInsert,
  'organizationId' | 'id' | 'createdAt'
>;

export function visibilityRepo(tx: Tx, orgId: string) {
  return {
    async settings(): Promise<VisibilitySettingsRow | undefined> {
      const [row] = await tx
        .select()
        .from(visibilitySettings)
        .where(eq(visibilitySettings.organizationId, orgId));
      return row;
    },
    async saveSettings(values: {
      monthlyCapCents: number;
      enabled: boolean;
    }): Promise<VisibilitySettingsRow> {
      const [row] = await tx
        .insert(visibilitySettings)
        .values({ ...values, organizationId: orgId })
        .onConflictDoUpdate({ target: visibilitySettings.organizationId, set: values })
        .returning();
      return row!;
    },

    async queries(propertyId: string): Promise<VisibilityQueryRow[]> {
      return tx
        .select()
        .from(visibilityQueries)
        .where(
          and(
            eq(visibilityQueries.organizationId, orgId),
            eq(visibilityQueries.propertyId, propertyId),
            eq(visibilityQueries.active, true),
          ),
        )
        .orderBy(visibilityQueries.createdAt);
    },
    async addQuery(
      propertyId: string,
      text: string,
      source: VisibilityQueryRow['source'],
    ): Promise<VisibilityQueryRow> {
      const [row] = await tx
        .insert(visibilityQueries)
        .values({ organizationId: orgId, propertyId, text, source })
        .returning();
      return row!;
    },
    async deactivateQuery(propertyId: string, id: string): Promise<boolean> {
      const rows = await tx
        .update(visibilityQueries)
        .set({ active: false })
        .where(
          and(
            eq(visibilityQueries.organizationId, orgId),
            eq(visibilityQueries.propertyId, propertyId),
            eq(visibilityQueries.id, id),
          ),
        )
        .returning({ id: visibilityQueries.id });
      return rows.length > 0;
    },

    async createRun(propertyId: string, trigger: string): Promise<VisibilityRunRow> {
      const [row] = await tx
        .insert(visibilityRuns)
        .values({ organizationId: orgId, propertyId, trigger })
        .returning();
      return row!;
    },
    async getRun(id: string): Promise<VisibilityRunRow | undefined> {
      const [row] = await tx
        .select()
        .from(visibilityRuns)
        .where(and(eq(visibilityRuns.organizationId, orgId), eq(visibilityRuns.id, id)));
      return row;
    },
    async updateRun(
      id: string,
      patch: Partial<Omit<VisibilityRunRow, 'id' | 'organizationId' | 'createdAt'>>,
    ) {
      await tx
        .update(visibilityRuns)
        .set(patch)
        .where(and(eq(visibilityRuns.organizationId, orgId), eq(visibilityRuns.id, id)));
    },
    async runs(propertyId: string, limit = 12): Promise<VisibilityRunRow[]> {
      return tx
        .select()
        .from(visibilityRuns)
        .where(and(eq(visibilityRuns.organizationId, orgId), eq(visibilityRuns.propertyId, propertyId)))
        .orderBy(desc(visibilityRuns.createdAt))
        .limit(limit);
    },
    /** Spend since a point in time (the start of the month), in cents. */
    async spendSince(since: Date): Promise<number> {
      const [row] = await tx
        .select({ total: sql<string>`coalesce(sum(${visibilityResults.costCents}), 0)` })
        .from(visibilityResults)
        .where(and(eq(visibilityResults.organizationId, orgId), gte(visibilityResults.createdAt, since)));
      return Number(row?.total ?? 0);
    },

    async addResult(values: NewVisibilityResult): Promise<void> {
      await tx.insert(visibilityResults).values({ ...values, organizationId: orgId });
    },
    async resultsForRuns(runIds: string[]): Promise<VisibilityResultRow[]> {
      if (runIds.length === 0) return [];
      return tx
        .select()
        .from(visibilityResults)
        .where(and(eq(visibilityResults.organizationId, orgId), inArray(visibilityResults.runId, runIds)))
        .orderBy(visibilityResults.createdAt);
    },
  };
}

export function visibilitySystemRepo(tx: Tx) {
  return {
    /** Every published property (the weekly run covers them all). */
    async publishedProperties(): Promise<{ organizationId: string; propertyId: string }[]> {
      return tx
        .select({ organizationId: properties.organizationId, propertyId: properties.id })
        .from(properties)
        .where(eq(properties.status, 'published'))
        .orderBy(properties.organizationId);
    },
    async purgeRawAnswers(before: Date): Promise<number> {
      const result = await tx
        .update(visibilityResults)
        .set({ rawAnswer: null })
        .where(and(lt(visibilityResults.createdAt, before), sql`${visibilityResults.rawAnswer} is not null`));
      return result.rowCount ?? 0;
    },
  };
}
