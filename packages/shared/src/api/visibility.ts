import { z } from 'zod';

export const VisibilityResultDto = z.object({
  queryText: z.string(),
  provider: z.string(),
  providerLabel: z.string(),
  model: z.string(),
  simulated: z.boolean(),
  status: z.enum(['ok', 'error']),
  error: z.string().nullable(),
  mentioned: z.boolean(),
  rank: z.number().int().nullable(),
  listSize: z.number().int(),
  competitors: z.array(z.string()),
  citedUrls: z.array(z.string()),
  ownSiteCited: z.boolean(),
  profileCited: z.boolean(),
  excerpt: z.string().nullable(),
});

export const VisibilityRunDto = z.object({
  id: z.uuid(),
  status: z.enum(['queued', 'running', 'completed', 'capped', 'failed']),
  trigger: z.string(),
  questions: z.number().int(),
  costCents: z.number(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

export const VisibilityDto = z.object({
  propertyId: z.uuid(),
  propertyName: z.string(),
  published: z.boolean(),
  settings: z.object({
    enabled: z.boolean(),
    monthlyCapCents: z.number().int(),
    spentThisMonthCents: z.number(),
  }),
  providers: z.array(
    z.object({ id: z.string(), label: z.string(), model: z.string(), simulated: z.boolean() }),
  ),
  queries: z.array(z.object({ id: z.uuid(), text: z.string(), source: z.enum(['suggested', 'hotel']) })),
  latestRun: VisibilityRunDto.nullable(),
  summary: z
    .object({
      answers: z.number().int(),
      mentionRate: z.number().int().describe('Percent of answers that mention the hotel'),
      averageRank: z.number().nullable(),
      citedRate: z.number().int().describe('Percent of answers citing the hotel’s site or profile'),
      byProvider: z.array(
        z.object({
          provider: z.string(),
          label: z.string(),
          answers: z.number().int(),
          mentionRate: z.number().int(),
          averageRank: z.number().nullable(),
        }),
      ),
    })
    .nullable(),
  results: z.array(VisibilityResultDto),
  topCompetitors: z.array(z.object({ name: z.string(), count: z.number().int() })),
  trend: z.array(z.object({ runId: z.uuid(), date: z.iso.datetime(), mentionRate: z.number().int() })),
  recommendations: z.array(z.object({ key: z.string(), title: z.string(), detail: z.string() })),
  canRunNow: z.boolean(),
  runBlockedReason: z.string().nullable(),
});
export type VisibilityDto = z.infer<typeof VisibilityDto>;

export const AddVisibilityQueryInput = z.object({
  text: z.string().trim().min(8, 'Write the question as a traveller would ask it').max(200),
});

export const VisibilitySettingsInput = z.object({
  monthlyCapCents: z.number().int().min(0).max(100_000),
  enabled: z.boolean(),
});
