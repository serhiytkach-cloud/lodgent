import {
  type Clock,
  ConflictError,
  type ExtractionModel,
  evidenceAppearsIn,
  NotFoundError,
  type PageContent,
  ValidationError,
} from '@lodgent/core';
import type { Database, SuggestionInput } from '@lodgent/db';
import { ATTRIBUTES, attribute, normalizeValue } from '@lodgent/taxonomy';
import type { Logger } from 'pino';
import { assertCan, type OrgContext, systemActor, userActor } from '../context';
import { crawlSite } from '../crawl/crawler';
import type { safeFetch } from '../crawl/safe-fetch';
import { ProfileService } from './profile';

function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Website import: a polite crawl of the hotel's site, then attribute extraction (Claude, or the
 * offline keyword matcher). Every suggestion must quote the page it came from; quotes that don't
 * appear verbatim on that page are dropped. Everything lands as `suggested` for the hotel to review.
 */
export class WebsiteImportService {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      extraction: ExtractionModel;
      logger: Logger;
      allowPrivateNetworks: boolean;
      fetchImpl?: typeof safeFetch;
      crawlDelayMs?: number;
    },
  ) {}

  async request(ctx: OrgContext, propertyId: string): Promise<{ crawlId: string }> {
    assertCan(ctx, 'property.write');
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      const property = await r.properties.get(propertyId);
      if (!property) throw new NotFoundError('Property');
      if (!property.websiteUrl) throw new ValidationError('Add the hotel’s website URL first (Details).');
      if ((await r.crawls.unfinishedFor(propertyId)).length > 0) {
        throw new ConflictError('crawl_in_progress', 'An import of this website is already running');
      }
      const crawl = await r.crawls.create({
        propertyId,
        url: property.websiteUrl,
        requestedByUserId: ctx.userId,
      });
      await r.outbox.add('job.enqueue', {
        type: 'website.crawl',
        payload: { orgId: ctx.orgId, crawlId: crawl.id },
        dedupeKey: `website.crawl:${crawl.id}`,
      });
      await r.audit.record({
        ...userActor(ctx),
        action: 'profile.website_import_requested',
        entityType: 'property',
        entityId: propertyId,
        changes: { url: property.websiteUrl },
      });
      return { crawlId: crawl.id };
    });
  }

  /** Job handler: crawl, extract, verify, store suggestions. Idempotent per crawl. */
  async run(orgId: string, crawlId: string): Promise<void> {
    const { db, clock, extraction, logger } = this.deps;
    const setup = await db.tenant(orgId, async (r) => {
      const crawl = await r.crawls.get(crawlId);
      if (!crawl || crawl.status === 'succeeded' || crawl.status === 'failed') return null;
      const property = await r.properties.get(crawl.propertyId);
      if (!property) return null;
      const roomTypes = await r.roomTypes.listForProperty(crawl.propertyId);
      await r.crawls.update(crawlId, { status: 'running', startedAt: clock.now(), error: null });
      return { crawl, property, roomTypes };
    });
    if (!setup) return;
    const { crawl, property, roomTypes } = setup;

    try {
      const { pages, skipped } = await crawlSite(crawl.url, {
        allowPrivateNetworks: this.deps.allowPrivateNetworks,
        fetchImpl: this.deps.fetchImpl,
        delayMs: this.deps.crawlDelayMs,
      });
      if (pages.length === 0) throw new Error(`No pages could be read from ${crawl.url}`);
      await db.tenant(orgId, (r) =>
        r.crawls.addPages(
          crawlId,
          pages.map((p) => ({ url: p.url, title: p.title, text: p.text })),
        ),
      );

      const result = await extraction.extract({
        hotelName: property.name,
        pages,
        roomTypes: roomTypes.map((rt) => ({ name: rt.name, description: rt.description })),
        attributes: ATTRIBUTES.map((a) => ({
          code: a.code,
          label: a.label,
          valueType: a.valueType,
          enumValues: a.enumValues,
          appliesTo: a.appliesTo,
        })),
      });

      const { suggestions, dropped } = this.verify(result.attributes, pages, roomTypes);
      const descriptions = [
        ...(result.propertyDescription &&
        pages.some((p) => sameUrl(p.url, result.propertyDescription!.evidenceUrl))
          ? [
              {
                roomTypeId: null,
                text: result.propertyDescription.text,
                evidenceUrl: result.propertyDescription.evidenceUrl,
              },
            ]
          : []),
        ...result.roomDescriptions.flatMap((d) => {
          const rt = roomTypes.find((r) => r.name.toLowerCase() === d.roomTypeName.toLowerCase());
          return rt && pages.some((p) => sameUrl(p.url, d.evidenceUrl))
            ? [{ roomTypeId: rt.id, text: d.text, evidenceUrl: d.evidenceUrl }]
            : [];
        }),
      ];

      await db.tenant(orgId, async (r) => {
        const counts = await ProfileService.applySuggestions(r, crawl.propertyId, suggestions);
        for (const d of descriptions) {
          await r.descriptions.upsert(
            crawl.propertyId,
            d.roomTypeId,
            d.text.slice(0, 2000),
            extraction.source,
            d.evidenceUrl,
          );
        }
        const stats = {
          pages: pages.length,
          skippedPages: skipped.length,
          suggestions: suggestions.length,
          new: counts.created,
          changed: counts.updated,
          droppedUnverified: dropped,
          descriptions: descriptions.length,
        };
        await r.crawls.update(crawlId, {
          status: 'succeeded',
          finishedAt: clock.now(),
          pagesFetched: pages.length,
          extractionModel: result.model,
          stats,
        });
        await r.crawls.pruneOldPages(crawl.propertyId, crawlId);
        await r.audit.record({
          ...systemActor,
          action: 'profile.website_imported',
          entityType: 'property',
          entityId: crawl.propertyId,
          changes: stats,
        });
      });
    } catch (error) {
      logger.warn({ err: error, crawlId }, 'website import failed');
      await db.tenant(orgId, (r) =>
        r.crawls.update(crawlId, {
          status: 'failed',
          finishedAt: clock.now(),
          error: error instanceof Error ? error.message.slice(0, 500) : 'Import failed',
        }),
      );
    }
  }

  private verify(
    extracted: Awaited<ReturnType<ExtractionModel['extract']>>['attributes'],
    pages: PageContent[],
    roomTypes: { id: string; name: string }[],
  ): { suggestions: SuggestionInput[]; dropped: number } {
    const suggestions = new Map<string, SuggestionInput>();
    let dropped = 0;
    for (const item of extracted) {
      const def = attribute(item.code);
      const value = def ? normalizeValue(def, item.value) : null;
      const page = pages.find((p) => sameUrl(p.url, item.evidence.url));
      const confidence = Math.max(0, Math.min(1, item.confidence));
      if (
        !def ||
        value === null ||
        !page ||
        confidence < 0.5 ||
        !evidenceAppearsIn(item.evidence.snippet, page.text)
      ) {
        dropped++;
        continue;
      }
      let roomTypeId: string | null = null;
      if (item.roomTypeName && def.appliesTo !== 'property') {
        const name = item.roomTypeName.toLowerCase();
        roomTypeId = roomTypes.find((rt) => rt.name.toLowerCase() === name)?.id ?? null;
      }
      if (def.appliesTo === 'room' && !roomTypeId) {
        dropped++;
        continue;
      }
      const key = `${roomTypeId ?? 'property'}:${def.code}`;
      const existing = suggestions.get(key);
      if (existing && existing.confidence >= confidence) {
        existing.evidence.push({ url: page.url, snippet: item.evidence.snippet.slice(0, 300) });
        continue;
      }
      suggestions.set(key, {
        roomTypeId,
        attributeCode: def.code,
        value,
        source: this.deps.extraction.source,
        confidence,
        evidence: [{ url: page.url, snippet: item.evidence.snippet.slice(0, 300) }],
      });
    }
    return { suggestions: [...suggestions.values()], dropped };
  }
}
