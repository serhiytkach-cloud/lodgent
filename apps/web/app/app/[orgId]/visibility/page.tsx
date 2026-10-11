import type { VisibilityDto } from '@lodgent/shared';
import { Trash2 } from 'lucide-react';
import Link from 'next/link';
import { ActionForm } from '@/components/action-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox, Field, Input } from '@/components/ui/form';
import { Alert, Badge, EmptyState, PageHeader, Stat, Table, Td, Th } from '@/components/ui/misc';
import { api } from '@/lib/api';
import type { Organization, Property } from '@/lib/types';
import { cn, formatDateTime } from '@/lib/utils';
import { addQuestion, removeQuestion, saveBudget } from './actions';
import { RunButton } from './run-button';

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function MentionBar({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div
          className={cn(
            'h-full rounded-full',
            value >= 50 ? 'bg-success' : value > 0 ? 'bg-primary' : 'bg-muted',
          )}
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="tabular-nums">{value}%</span>
    </div>
  );
}

export default async function VisibilityPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ property?: string }>;
}) {
  const { orgId } = await params;
  const query = await searchParams;
  const [org, list] = await Promise.all([
    api<Organization>(`/v1/orgs/${orgId}`),
    api<{ properties: Property[] }>(`/v1/orgs/${orgId}/properties`),
  ]);
  const properties = list.properties;
  if (properties.length === 0) {
    return (
      <>
        <PageHeader title="AI visibility" />
        <EmptyState title="Add a property first">Visibility is tracked per hotel.</EmptyState>
      </>
    );
  }
  const selected =
    properties.find((p) => p.id === query.property) ??
    properties.find((p) => p.status === 'published') ??
    properties[0]!;
  const v = await api<VisibilityDto>(`/v1/orgs/${orgId}/properties/${selected.id}/visibility`);
  const canManage = org.role !== 'viewer';
  const simulated = v.providers.length > 0 && v.providers.every((p) => p.simulated);
  const inFlight = v.latestRun && (v.latestRun.status === 'queued' || v.latestRun.status === 'running');
  const questions = [...new Set(v.results.map((r) => r.queryText))];

  return (
    <>
      <PageHeader
        title="AI visibility"
        description="What ChatGPT, Claude, Gemini and Perplexity tell travellers who ask where to stay, and whether they mention you."
        actions={
          canManage ? (
            <RunButton orgId={orgId} propertyId={selected.id} disabledReason={v.runBlockedReason} />
          ) : null
        }
      />

      {properties.length > 1 ? (
        <nav className="mb-4 flex flex-wrap gap-2" aria-label="Property">
          {properties.map((p) => (
            <Link
              key={p.id}
              href={`/app/${orgId}/visibility?property=${p.id}`}
              aria-current={p.id === selected.id ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm',
                p.id === selected.id ? 'border-primary bg-accent font-medium' : 'hover:bg-muted',
              )}
            >
              {p.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {simulated ? (
        <Alert variant="warning" className="mb-4" title="Demo mode: simulated assistants">
          No AI provider keys are configured, so answers come from a simulator. Add Anthropic, OpenAI, Gemini
          or Perplexity keys to monitor the real assistants.
        </Alert>
      ) : null}
      {v.providers.length === 0 ? (
        <Alert variant="warning" className="mb-4">
          No assistants are configured for monitoring.
        </Alert>
      ) : null}
      {inFlight ? (
        <Alert variant="info" className="mb-4">
          A check is {v.latestRun?.status}. Refresh in a few minutes.
        </Alert>
      ) : null}
      {v.latestRun?.status === 'capped' ? (
        <Alert variant="warning" className="mb-4">
          The last check stopped at this month’s budget. Raise it below or wait for next month.
        </Alert>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Mentioned in"
          value={v.summary ? `${v.summary.mentionRate}%` : '—'}
          hint={v.summary ? `of ${v.summary.answers} answers` : 'No check yet'}
        />
        <Stat label="Average position" value={v.summary?.averageRank ?? '—'} hint="When listed" />
        <Stat
          label="Your site cited"
          value={v.summary ? `${v.summary.citedRate}%` : '—'}
          hint="Website or public profile"
        />
        <Stat
          label="Spent this month"
          value={usd(v.settings.spentThisMonthCents)}
          hint={`of ${usd(v.settings.monthlyCapCents)} budget`}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="grid content-start gap-6 lg:col-span-2">
          {v.recommendations.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>What to do next</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-3 text-sm">
                  {v.recommendations.map((r) => (
                    <li key={r.key}>
                      <p className="font-medium">{r.title}</p>
                      <p className="text-muted-foreground">{r.detail}</p>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {v.summary ? (
            <Card>
              <CardHeader>
                <CardTitle>By assistant</CardTitle>
                <CardDescription>
                  Latest check{v.latestRun?.finishedAt ? `, ${formatDateTime(v.latestRun.finishedAt)}` : ''}.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <thead>
                    <tr>
                      <Th>Assistant</Th>
                      <Th>Mentions you</Th>
                      <Th>Avg. position</Th>
                      <Th>Answers</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.summary.byProvider.map((p) => (
                      <tr key={p.provider}>
                        <Td className="font-medium">{p.label}</Td>
                        <Td>
                          <MentionBar value={p.mentionRate} />
                        </Td>
                        <Td className="tabular-nums">{p.averageRank ?? '—'}</Td>
                        <Td className="tabular-nums">{p.answers}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </CardContent>
            </Card>
          ) : (
            <EmptyState title="No results yet">
              {canManage
                ? 'Run a check to see how assistants answer your questions.'
                : 'An admin can run the first check.'}
            </EmptyState>
          )}

          {questions.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Answers</CardTitle>
                <CardDescription>
                  Each question asked to each assistant, in its web-search mode.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5">
                {questions.map((q) => (
                  <section key={q}>
                    <h3 className="mb-2 text-sm font-medium">“{q}”</h3>
                    <ul className="grid gap-2">
                      {v.results
                        .filter((r) => r.queryText === q)
                        .map((r) => (
                          <li key={`${q}-${r.provider}`} className="rounded-md border p-3 text-sm">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{r.providerLabel}</span>
                              {r.status === 'error' ? (
                                <Badge variant="destructive">Failed</Badge>
                              ) : r.mentioned ? (
                                <Badge variant="success">
                                  {r.rank ? `#${r.rank} of ${r.listSize}` : 'Mentioned'}
                                </Badge>
                              ) : (
                                <Badge variant="secondary">Not mentioned</Badge>
                              )}
                              {r.ownSiteCited ? <Badge variant="outline">Cites your site</Badge> : null}
                              {r.profileCited ? <Badge variant="outline">Cites your profile</Badge> : null}
                            </div>
                            {r.error ? <p className="mt-1 text-xs text-destructive">{r.error}</p> : null}
                            {r.excerpt ? (
                              <p className="mt-1 text-xs text-muted-foreground">…{r.excerpt}…</p>
                            ) : null}
                            {!r.mentioned && r.competitors.length > 0 ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                Recommended instead: {r.competitors.slice(0, 4).join(', ')}
                              </p>
                            ) : null}
                          </li>
                        ))}
                    </ul>
                  </section>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="grid content-start gap-6">
          {v.trend.length > 1 ? (
            <Card>
              <CardHeader>
                <CardTitle>Trend</CardTitle>
                <CardDescription>Share of answers mentioning you, per check.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex h-24 items-end gap-1.5" role="img" aria-label="Mention rate per check">
                  {v.trend.map((t) => (
                    <div
                      key={t.runId}
                      className="flex-1 rounded-t bg-primary/70"
                      style={{ height: `${Math.max(4, t.mentionRate)}%` }}
                      title={`${formatDateTime(t.date)}: ${t.mentionRate}%`}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {v.topCompetitors.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Recommended most often</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="grid gap-1 text-sm">
                  {v.topCompetitors.map((c) => (
                    <li key={c.name} className="flex justify-between gap-2">
                      <span>{c.name}</span>
                      <span className="tabular-nums text-muted-foreground">{c.count}×</span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Questions</CardTitle>
              <CardDescription>What travellers ask. Checked weekly.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <ul className="grid gap-1.5 text-sm">
                {v.queries.map((q) => (
                  <li key={q.id} className="flex items-start justify-between gap-2">
                    <span>
                      {q.text}
                      {q.source === 'suggested' ? (
                        <span className="ml-1 text-xs text-muted-foreground">(suggested)</span>
                      ) : null}
                    </span>
                    {canManage ? (
                      <form action={removeQuestion.bind(null, orgId, selected.id, q.id)}>
                        <Button
                          type="submit"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={`Remove “${q.text}”`}
                        >
                          <Trash2 />
                        </Button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
              {canManage ? (
                <ActionForm
                  action={addQuestion.bind(null, orgId, selected.id)}
                  submitLabel="Add question"
                  submitVariant="outline"
                  resetOnSuccess
                >
                  <Field label="New question" htmlFor="text" name="text">
                    <Input
                      id="text"
                      name="text"
                      placeholder={`e.g. quiet hotels in ${selected.city ?? 'your city'} with parking`}
                    />
                  </Field>
                </ActionForm>
              ) : null}
            </CardContent>
          </Card>

          {canManage ? (
            <Card>
              <CardHeader>
                <CardTitle>Budget</CardTitle>
                <CardDescription>Checks stop when the month’s spend reaches the budget.</CardDescription>
              </CardHeader>
              <CardContent>
                <ActionForm action={saveBudget.bind(null, orgId)} submitVariant="outline">
                  <Field label="Monthly budget (USD)" htmlFor="budget" name="budget">
                    <Input
                      id="budget"
                      name="budget"
                      inputMode="decimal"
                      defaultValue={(v.settings.monthlyCapCents / 100).toFixed(2)}
                    />
                  </Field>
                  <label htmlFor="enabled" className="flex items-center gap-2 text-sm">
                    <Checkbox id="enabled" name="enabled" defaultChecked={v.settings.enabled} /> Weekly checks
                    on
                  </label>
                </ActionForm>
              </CardContent>
            </Card>
          ) : null}

          <p className="text-xs text-muted-foreground">
            Assistants:{' '}
            {v.providers.map((p) => (p.simulated ? p.label : `${p.label} (${p.model})`)).join(', ') || 'none'}
            .
          </p>
        </div>
      </div>
    </>
  );
}
