import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import {
  attributeAssignments,
  attributeDefinitions,
  crawledPages,
  descriptionSuggestions,
  embeddings,
  websiteCrawls,
} from '../schema';

export type AttributeAssignmentRow = typeof attributeAssignments.$inferSelect;
export type DescriptionSuggestionRow = typeof descriptionSuggestions.$inferSelect;
export type WebsiteCrawlRow = typeof websiteCrawls.$inferSelect;
export type EmbeddingRow = typeof embeddings.$inferSelect;

export const scopeKeyFor = (roomTypeId: string | null) => roomTypeId ?? 'property';

export interface SuggestionInput {
  roomTypeId: string | null;
  attributeCode: string;
  value: boolean | number | string;
  source: 'pms' | 'website' | 'hotel' | 'ai_extracted';
  confidence: number;
  evidence: { url: string; snippet: string }[];
}

export function attributeAssignmentRepo(tx: Tx, orgId: string) {
  const own = eq(attributeAssignments.organizationId, orgId);
  return {
    async listForProperty(propertyId: string): Promise<AttributeAssignmentRow[]> {
      return tx
        .select()
        .from(attributeAssignments)
        .where(and(own, eq(attributeAssignments.propertyId, propertyId)))
        .orderBy(attributeAssignments.attributeCode);
    },
    async byIds(propertyId: string, ids: string[]): Promise<AttributeAssignmentRow[]> {
      if (ids.length === 0) return [];
      return tx
        .select()
        .from(attributeAssignments)
        .where(
          and(own, eq(attributeAssignments.propertyId, propertyId), inArray(attributeAssignments.id, ids)),
        );
    },
    /**
     * Records a suggestion from an automated source. Re-running a source is idempotent: an approved
     * or rejected row with the same value keeps its review; a changed value goes back to review.
     */
    async upsertSuggestion(
      propertyId: string,
      s: SuggestionInput,
    ): Promise<'created' | 'updated' | 'unchanged'> {
      const scopeKey = scopeKeyFor(s.roomTypeId);
      const [existing] = await tx
        .select()
        .from(attributeAssignments)
        .where(
          and(
            own,
            eq(attributeAssignments.propertyId, propertyId),
            eq(attributeAssignments.scopeKey, scopeKey),
            eq(attributeAssignments.attributeCode, s.attributeCode),
            eq(attributeAssignments.source, s.source),
          ),
        );
      if (!existing) {
        await tx.insert(attributeAssignments).values({ ...s, organizationId: orgId, propertyId, scopeKey });
        return 'created';
      }
      if (JSON.stringify(existing.value) === JSON.stringify(s.value)) {
        await tx
          .update(attributeAssignments)
          .set({ evidence: s.evidence, confidence: s.confidence })
          .where(eq(attributeAssignments.id, existing.id));
        return 'unchanged';
      }
      await tx
        .update(attributeAssignments)
        .set({
          value: s.value,
          evidence: s.evidence,
          confidence: s.confidence,
          status: 'suggested',
          reviewedAt: null,
          reviewedByUserId: null,
        })
        .where(eq(attributeAssignments.id, existing.id));
      return 'updated';
    },
    /** The hotel's own value: always approved. */
    async setHotelValue(
      propertyId: string,
      roomTypeId: string | null,
      attributeCode: string,
      value: boolean | number | string,
      userId: string,
      now: Date,
    ): Promise<AttributeAssignmentRow> {
      const scopeKey = scopeKeyFor(roomTypeId);
      const [row] = await tx
        .insert(attributeAssignments)
        .values({
          organizationId: orgId,
          propertyId,
          roomTypeId,
          scopeKey,
          attributeCode,
          value,
          source: 'hotel',
          confidence: 1,
          status: 'approved',
          evidence: [],
          reviewedByUserId: userId,
          reviewedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            attributeAssignments.propertyId,
            attributeAssignments.scopeKey,
            attributeAssignments.attributeCode,
            attributeAssignments.source,
          ],
          set: { value, status: 'approved', reviewedByUserId: userId, reviewedAt: now },
        })
        .returning();
      return row!;
    },
    async setStatus(
      propertyId: string,
      ids: string[],
      status: 'approved' | 'rejected' | 'suggested',
      userId: string,
      now: Date,
    ): Promise<AttributeAssignmentRow[]> {
      if (ids.length === 0) return [];
      return tx
        .update(attributeAssignments)
        .set({ status, reviewedByUserId: userId, reviewedAt: now })
        .where(
          and(own, eq(attributeAssignments.propertyId, propertyId), inArray(attributeAssignments.id, ids)),
        )
        .returning();
    },
    /** Clears the hotel's own value and rejects other approved values, so nothing is in effect. */
    async clearScope(
      propertyId: string,
      roomTypeId: string | null,
      attributeCode: string,
      userId: string,
      now: Date,
    ) {
      const scopeKey = scopeKeyFor(roomTypeId);
      const where = and(
        own,
        eq(attributeAssignments.propertyId, propertyId),
        eq(attributeAssignments.scopeKey, scopeKey),
        eq(attributeAssignments.attributeCode, attributeCode),
      );
      await tx.delete(attributeAssignments).where(and(where, eq(attributeAssignments.source, 'hotel')));
      await tx
        .update(attributeAssignments)
        .set({ status: 'rejected', reviewedByUserId: userId, reviewedAt: now })
        .where(and(where, eq(attributeAssignments.status, 'approved')));
    },
  };
}

export function descriptionSuggestionRepo(tx: Tx, orgId: string) {
  const own = eq(descriptionSuggestions.organizationId, orgId);
  return {
    async listPending(propertyId: string) {
      return tx
        .select()
        .from(descriptionSuggestions)
        .where(
          and(
            own,
            eq(descriptionSuggestions.propertyId, propertyId),
            eq(descriptionSuggestions.status, 'suggested'),
          ),
        );
    },
    async get(id: string) {
      const [row] = await tx
        .select()
        .from(descriptionSuggestions)
        .where(and(own, eq(descriptionSuggestions.id, id)));
      return row;
    },
    async upsert(
      propertyId: string,
      roomTypeId: string | null,
      text: string,
      source: 'website' | 'ai_extracted',
      evidenceUrl: string | null,
    ) {
      const scopeKey = scopeKeyFor(roomTypeId);
      await tx
        .insert(descriptionSuggestions)
        .values({ organizationId: orgId, propertyId, roomTypeId, scopeKey, text, source, evidenceUrl })
        .onConflictDoUpdate({
          target: [
            descriptionSuggestions.propertyId,
            descriptionSuggestions.scopeKey,
            descriptionSuggestions.source,
          ],
          set: {
            text,
            evidenceUrl,
            status: sql`case when ${descriptionSuggestions.text} = ${text} then ${descriptionSuggestions.status} else 'suggested'::assignment_status end`,
          },
        });
    },
    async setStatus(id: string, status: 'approved' | 'rejected') {
      await tx
        .update(descriptionSuggestions)
        .set({ status })
        .where(and(own, eq(descriptionSuggestions.id, id)));
    },
  };
}

export function embeddingRepo(tx: Tx, orgId: string) {
  const own = eq(embeddings.organizationId, orgId);
  return {
    async listForProperty(propertyId: string) {
      return tx
        .select({
          scopeKey: embeddings.scopeKey,
          contentHash: embeddings.contentHash,
          model: embeddings.model,
        })
        .from(embeddings)
        .where(and(own, eq(embeddings.propertyId, propertyId)));
    },
    async upsert(values: {
      propertyId: string;
      roomTypeId: string | null;
      kind: 'property' | 'room';
      model: string;
      contentHash: string;
      content: string;
      embedding: number[];
    }) {
      const scopeKey = scopeKeyFor(values.roomTypeId);
      await tx
        .insert(embeddings)
        .values({ ...values, organizationId: orgId, scopeKey })
        .onConflictDoUpdate({
          target: [embeddings.propertyId, embeddings.scopeKey],
          set: {
            model: values.model,
            contentHash: values.contentHash,
            content: values.content,
            embedding: values.embedding,
            updatedAt: new Date(),
          },
        });
    },
    async deleteOthers(propertyId: string, keepScopeKeys: string[]) {
      await tx.delete(embeddings).where(
        and(
          own,
          eq(embeddings.propertyId, propertyId),
          keepScopeKeys.length > 0
            ? sql`${embeddings.scopeKey} <> all(array[${sql.join(
                keepScopeKeys.map((k) => sql`${k}`),
                sql`, `,
              )}]::text[])`
            : undefined,
        ),
      );
    },
  };
}

export function crawlRepo(tx: Tx, orgId: string) {
  const own = eq(websiteCrawls.organizationId, orgId);
  return {
    async create(values: { propertyId: string; url: string; requestedByUserId: string | null }) {
      const [row] = await tx
        .insert(websiteCrawls)
        .values({ ...values, organizationId: orgId })
        .returning();
      return row!;
    },
    async get(id: string): Promise<WebsiteCrawlRow | undefined> {
      const [row] = await tx
        .select()
        .from(websiteCrawls)
        .where(and(own, eq(websiteCrawls.id, id)));
      return row;
    },
    async latest(propertyId: string): Promise<WebsiteCrawlRow | undefined> {
      const [row] = await tx
        .select()
        .from(websiteCrawls)
        .where(and(own, eq(websiteCrawls.propertyId, propertyId)))
        .orderBy(desc(websiteCrawls.createdAt))
        .limit(1);
      return row;
    },
    async update(id: string, patch: Partial<typeof websiteCrawls.$inferInsert>) {
      await tx
        .update(websiteCrawls)
        .set(patch)
        .where(and(own, eq(websiteCrawls.id, id)));
    },
    async addPages(crawlId: string, pages: { url: string; title: string | null; text: string }[]) {
      if (pages.length === 0) return;
      await tx.insert(crawledPages).values(pages.map((p) => ({ ...p, crawlId, organizationId: orgId })));
    },
    /** Keeps only the latest crawl's pages for a property. */
    async pruneOldPages(propertyId: string, keepCrawlId: string) {
      await tx.execute(sql`
        delete from crawled_pages cp using website_crawls wc
        where cp.crawl_id = wc.id and wc.property_id = ${propertyId} and wc.organization_id = ${orgId}
          and wc.id <> ${keepCrawlId}`);
    },
    async pages(crawlId: string) {
      return tx
        .select()
        .from(crawledPages)
        .where(and(eq(crawledPages.organizationId, orgId), eq(crawledPages.crawlId, crawlId)));
    },
    async unfinishedFor(propertyId: string) {
      return tx
        .select()
        .from(websiteCrawls)
        .where(
          and(
            own,
            eq(websiteCrawls.propertyId, propertyId),
            ne(websiteCrawls.status, 'succeeded'),
            ne(websiteCrawls.status, 'failed'),
          ),
        );
    },
  };
}

export function taxonomyRepo(tx: Tx) {
  return {
    async upsertDefinitions(
      defs: {
        code: string;
        label: string;
        category: string;
        appliesTo: string;
        importance: number;
        valueType: string;
        enumValues: string[] | null;
      }[],
    ) {
      if (defs.length === 0) return;
      await tx
        .insert(attributeDefinitions)
        .values(defs)
        .onConflictDoUpdate({
          target: attributeDefinitions.code,
          set: {
            label: sql`excluded.label`,
            category: sql`excluded.category`,
            appliesTo: sql`excluded.applies_to`,
            importance: sql`excluded.importance`,
            valueType: sql`excluded.value_type`,
            enumValues: sql`excluded.enum_values`,
            updatedAt: new Date(),
          },
        });
    },
  };
}
