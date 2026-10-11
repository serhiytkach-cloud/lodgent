import {
  analyzeAnswer,
  type Clock,
  ConflictError,
  effectiveAssignments,
  NotFoundError,
  suggestQueries,
  ValidationError,
  type VisibilityProvider,
  visibilityRecommendations,
} from '@lodgent/core';
import type { Database, PropertyRow, TenantRepos, VisibilityResultRow, VisibilityRunRow } from '@lodgent/db';
import type { VisibilityDto } from '@lodgent/shared';
import { attribute } from '@lodgent/taxonomy';
import type { Logger } from 'pino';
import { assertCan, type OrgContext, userActor } from '../context';
import { profileCompleteness } from './profile';

const MAX_ACTIVE_QUERIES = 20;
const MANUAL_RUN_COOLDOWN_MS = 60 * 60_000;
const PROVIDER_CONCURRENCY = 4;

function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((100 * n) / d));

/**
 * AI visibility monitor: asks the configured assistants (web-search modes) the questions travellers
 * ask, and records whether each answer mentions the hotel, where it ranks, who else is recommended
 * and which sources are cited. Spend is checked against a monthly cap before every call.
 */
export class VisibilityService {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      providers: VisibilityProvider[];
      logger: Logger;
      webBaseUrl: string;
      defaultMonthlyCapCents: number;
      rawRetentionDays: number;
    },
  ) {}

  private providerLabel(id: string): string {
    return this.deps.providers.find((p) => p.id === id)?.label ?? id;
  }

  private async settingsOf(r: TenantRepos) {
    return (
      (await r.visibility.settings()) ?? { enabled: true, monthlyCapCents: this.deps.defaultMonthlyCapCents }
    );
  }

  /** Creates the default questions for a property that has none yet. */
  private async ensureQueries(r: TenantRepos, property: PropertyRow) {
    const existing = await r.visibility.queries(property.id);
    if (existing.length > 0) return existing;
    const assignments = await r.attributes.listForProperty(property.id);
    const effective = [...effectiveAssignments(assignments).values()].filter(
      (a) => a.roomTypeId === null && a.value !== false && a.value !== 'none',
    );
    const texts = suggestQueries({
      city: property.city,
      region: property.region,
      attributes: effective.map((a) => ({
        code: a.attributeCode,
        label: attribute(a.attributeCode)?.label ?? a.attributeCode,
        importance: attribute(a.attributeCode)?.importance ?? 1,
      })),
    });
    for (const text of texts) await r.visibility.addQuery(property.id, text, 'suggested');
    return r.visibility.queries(property.id);
  }

  async view(ctx: OrgContext, propertyId: string): Promise<VisibilityDto> {
    assertCan(ctx, 'visibility.read');
    const { db, clock } = this.deps;
    return db.tenant(ctx.orgId, async (r) => {
      const property = await r.properties.get(propertyId);
      if (!property) throw new NotFoundError('Property');
      const settings = await this.settingsOf(r);
      const queries = await this.ensureQueries(r, property);
      const runs = await r.visibility.runs(propertyId, 12);
      const results = await r.visibility.resultsForRuns(runs.map((run) => run.id));
      const latestRun = runs[0] ?? null;
      // The most recent run that produced answers drives the summary.
      const reported =
        runs.find((run) => results.some((x) => x.runId === run.id && x.status === 'ok')) ?? null;
      const current = reported ? results.filter((x) => x.runId === reported.id) : [];
      const ok = current.filter((x) => x.status === 'ok');

      const order = (provider: string) => {
        const i = this.deps.providers.findIndex((p) => p.id === provider);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      current.sort(
        (a, b) =>
          queries.findIndex((q) => q.id === a.queryId) - queries.findIndex((q) => q.id === b.queryId) ||
          order(a.provider) - order(b.provider),
      );
      const byProvider = [...new Set(ok.map((x) => x.provider))]
        .sort((a, b) => order(a) - order(b))
        .map((provider) => {
          const rows = ok.filter((x) => x.provider === provider);
          const ranks = rows.map((x) => x.rank).filter((n): n is number => n !== null);
          return {
            provider,
            label: this.providerLabel(provider),
            answers: rows.length,
            mentionRate: pct(rows.filter((x) => x.mentioned).length, rows.length),
            averageRank: ranks.length
              ? Math.round((10 * ranks.reduce((a, b) => a + b, 0)) / ranks.length) / 10
              : null,
          };
        });
      const ranks = ok.map((x) => x.rank).filter((n): n is number => n !== null);
      const competitorCounts = new Map<string, number>();
      for (const x of ok)
        for (const c of x.competitors) competitorCounts.set(c, (competitorCounts.get(c) ?? 0) + 1);

      const roomTypes = await r.roomTypes.listForProperty(propertyId);
      const ratePlans = await r.ratePlans.listForProperty(propertyId);
      const completeness = profileCompleteness(
        property,
        roomTypes,
        ratePlans,
        effectiveAssignments(await r.attributes.listForProperty(propertyId)),
      );

      const recentManual = runs.find(
        (run) =>
          run.trigger === 'manual' &&
          clock.now().getTime() - run.createdAt.getTime() < MANUAL_RUN_COOLDOWN_MS,
      );
      const inFlight = runs.find((run) => run.status === 'queued' || run.status === 'running');
      const spent = await r.visibility.spendSince(monthStart(clock.now()));
      const runBlockedReason = inFlight
        ? 'A check is already running.'
        : recentManual
          ? 'You can run a manual check once an hour.'
          : !settings.enabled
            ? 'The monitor is turned off.'
            : spent >= settings.monthlyCapCents && this.deps.providers.some((p) => !p.simulated)
              ? 'This month’s budget is used up.'
              : null;

      return {
        propertyId,
        propertyName: property.name,
        published: property.status === 'published',
        settings: {
          enabled: settings.enabled,
          monthlyCapCents: settings.monthlyCapCents,
          spentThisMonthCents: spent,
        },
        providers: this.deps.providers.map((p) => ({
          id: p.id,
          label: p.label,
          model: p.model,
          simulated: p.simulated,
        })),
        queries: queries.map((q) => ({ id: q.id, text: q.text, source: q.source })),
        latestRun: latestRun ? this.runDto(latestRun) : null,
        summary:
          ok.length > 0
            ? {
                answers: ok.length,
                mentionRate: pct(ok.filter((x) => x.mentioned).length, ok.length),
                averageRank: ranks.length
                  ? Math.round((10 * ranks.reduce((a, b) => a + b, 0)) / ranks.length) / 10
                  : null,
                citedRate: pct(ok.filter((x) => x.ownSiteCited || x.profileCited).length, ok.length),
                byProvider,
              }
            : null,
        results: current.map((x) => this.resultDto(x)),
        topCompetitors: [...competitorCounts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, 8)
          .map(([name, count]) => ({ name, count })),
        trend: runs
          .filter((run) => results.some((x) => x.runId === run.id && x.status === 'ok'))
          .slice(0, 8)
          .reverse()
          .map((run) => {
            const rows = results.filter((x) => x.runId === run.id && x.status === 'ok');
            return {
              runId: run.id,
              date: run.createdAt.toISOString(),
              mentionRate: pct(rows.filter((x) => x.mentioned).length, rows.length),
            };
          }),
        recommendations: visibilityRecommendations({
          published: property.status === 'published',
          websiteUrl: property.websiteUrl,
          completeness: completeness.score,
          topGaps: completeness.gaps.map((g) => g.label),
          results: ok,
        }),
        canRunNow: runBlockedReason === null,
        runBlockedReason,
      };
    });
  }

  private runDto(run: VisibilityRunRow) {
    return {
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      questions: run.questions,
      costCents: run.costCents,
      error: run.error,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }

  private resultDto(x: VisibilityResultRow) {
    return {
      queryText: x.queryText,
      provider: x.provider,
      providerLabel: this.providerLabel(x.provider),
      model: x.model,
      simulated: x.simulated,
      status: x.status === 'ok' ? ('ok' as const) : ('error' as const),
      error: x.error,
      mentioned: x.mentioned,
      rank: x.rank,
      listSize: x.listSize,
      competitors: x.competitors,
      citedUrls: x.citedUrls,
      ownSiteCited: x.ownSiteCited,
      profileCited: x.profileCited,
      excerpt: x.excerpt,
    };
  }

  async addQuery(ctx: OrgContext, propertyId: string, text: string) {
    assertCan(ctx, 'visibility.manage');
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      const property = await r.properties.get(propertyId);
      if (!property) throw new NotFoundError('Property');
      const queries = await this.ensureQueries(r, property);
      if (queries.length >= MAX_ACTIVE_QUERIES)
        throw new ValidationError(`Up to ${MAX_ACTIVE_QUERIES} questions per hotel.`);
      if (queries.some((q) => q.text.toLowerCase() === text.toLowerCase()))
        throw new ConflictError('duplicate', 'You already track this question.');
      const row = await r.visibility.addQuery(propertyId, text, 'hotel');
      await r.audit.record({
        ...userActor(ctx),
        action: 'visibility.query_added',
        entityType: 'property',
        entityId: propertyId,
        changes: { text },
      });
      return { id: row.id };
    });
  }

  async removeQuery(ctx: OrgContext, propertyId: string, queryId: string) {
    assertCan(ctx, 'visibility.manage');
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      if (!(await r.visibility.deactivateQuery(propertyId, queryId))) throw new NotFoundError('Question');
      await r.audit.record({
        ...userActor(ctx),
        action: 'visibility.query_removed',
        entityType: 'property',
        entityId: propertyId,
      });
      return { ok: true };
    });
  }

  async updateSettings(ctx: OrgContext, input: { monthlyCapCents: number; enabled: boolean }) {
    assertCan(ctx, 'visibility.manage');
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      const saved = await r.visibility.saveSettings(input);
      await r.audit.record({
        ...userActor(ctx),
        action: 'visibility.settings_updated',
        entityType: 'organization',
        entityId: ctx.orgId,
        changes: input,
      });
      return { enabled: saved.enabled, monthlyCapCents: saved.monthlyCapCents };
    });
  }

  /** "Run now" from the dashboard (at most hourly per property). */
  async requestRun(ctx: OrgContext, propertyId: string): Promise<{ runId: string }> {
    assertCan(ctx, 'visibility.manage');
    const view = await this.view(ctx, propertyId);
    if (!view.canRunNow)
      throw new ConflictError('run_unavailable', view.runBlockedReason ?? 'A check cannot run right now.');
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      const run = await r.visibility.createRun(propertyId, 'manual');
      await r.outbox.add('job.enqueue', {
        type: 'visibility.run',
        payload: { orgId: ctx.orgId, runId: run.id },
      });
      return { runId: run.id };
    });
  }

  /** Weekly job: one run per published property of every organization with the monitor on. */
  async scheduleAll(): Promise<number> {
    const { db } = this.deps;
    const targets = await db.system(({ visibility }) => visibility.publishedProperties());
    let scheduled = 0;
    for (const { organizationId, propertyId } of targets) {
      await db.tenant(organizationId, async (r) => {
        if (!(await this.settingsOf(r)).enabled) return;
        const run = await r.visibility.createRun(propertyId, 'schedule');
        await r.outbox.add('job.enqueue', {
          type: 'visibility.run',
          payload: { orgId: organizationId, runId: run.id },
          dedupeKey: `visibility.run:${run.id}`,
        });
        scheduled++;
      });
    }
    return scheduled;
  }

  /** Job: ask every question to every assistant, within the monthly budget. */
  async run(orgId: string, runId: string): Promise<void> {
    const { db, clock, providers, logger, webBaseUrl } = this.deps;
    const setup = await db.tenant(orgId, async (r) => {
      const run = await r.visibility.getRun(runId);
      if (!run || (run.status !== 'queued' && run.status !== 'running')) return null;
      const property = await r.properties.get(run.propertyId);
      if (!property) return null;
      const queries = await this.ensureQueries(r, property);
      const settings = await this.settingsOf(r);
      const spent = await r.visibility.spendSince(monthStart(clock.now()));
      await r.visibility.updateRun(runId, {
        status: 'running',
        startedAt: clock.now(),
        questions: queries.length,
      });
      return { run, property, queries, settings, spent };
    });
    if (!setup) return;
    const { property, queries, settings } = setup;
    let spent = setup.spent;
    let runCost = 0;
    let capped = false;
    const target = {
      name: property.name,
      city: property.city,
      ownDomains: [hostOf(property.websiteUrl)].filter((h): h is string => !!h),
      profileDomains: [hostOf(webBaseUrl)].filter((h): h is string => !!h),
    };
    const location = { city: property.city, region: property.region, country: property.countryCode };

    const tasks = queries.flatMap((q) => providers.map((p) => ({ q, p })));
    let next = 0;
    const worker = async () => {
      while (next < tasks.length && !capped) {
        const { q, p } = tasks[next++]!;
        const estimate = p.estimateCostCents();
        if (!p.simulated && spent + estimate > settings.monthlyCapCents) {
          capped = true;
          break;
        }
        spent += estimate; // reserve; corrected below
        try {
          const answer = await p.ask(q.text, { location });
          spent += answer.costCents - estimate;
          runCost += answer.costCents;
          const analysis = analyzeAnswer({ answer: answer.text, citations: answer.citations, target });
          await db.tenant(orgId, (r) =>
            r.visibility.addResult({
              runId,
              propertyId: property.id,
              queryId: q.id,
              queryText: q.text,
              provider: p.id,
              model: answer.model,
              simulated: p.simulated,
              status: 'ok',
              ...analysis,
              rawAnswer: answer.text.slice(0, 20_000),
              costCents: answer.costCents,
            }),
          );
        } catch (error) {
          spent -= estimate;
          logger.warn({ err: error, provider: p.id, runId }, 'visibility question failed');
          await db.tenant(orgId, (r) =>
            r.visibility.addResult({
              runId,
              propertyId: property.id,
              queryId: q.id,
              queryText: q.text,
              provider: p.id,
              model: p.model,
              simulated: p.simulated,
              status: 'error',
              error: error instanceof Error ? error.message.slice(0, 300) : 'Request failed',
              costCents: 0,
            }),
          );
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PROVIDER_CONCURRENCY, tasks.length) }, worker));

    await db.tenant(orgId, (r) =>
      r.visibility.updateRun(runId, {
        status: capped ? 'capped' : 'completed',
        costCents: Math.round(runCost * 100) / 100,
        finishedAt: clock.now(),
        error: capped ? 'Stopped at the monthly budget.' : null,
      }),
    );
  }

  /** Daily job: drop full answer texts after the retention period (analysis results stay). */
  async purgeRawAnswers(): Promise<number> {
    const before = new Date(this.deps.clock.now().getTime() - this.deps.rawRetentionDays * 86_400_000);
    return this.deps.db.system(({ visibility }) => visibility.purgeRawAnswers(before));
  }
}
