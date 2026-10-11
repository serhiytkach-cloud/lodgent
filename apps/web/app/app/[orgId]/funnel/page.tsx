import type { FunnelDto } from '@lodgent/shared';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, EmptyState, PageHeader, Table, Td, Th } from '@/components/ui/misc';
import { api } from '@/lib/api';
import type { Property } from '@/lib/types';
import { cn, formatDate } from '@/lib/utils';

const RANGES = [7, 30, 90] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = [
  ['searches', 'Searches'],
  ['views', 'Views'],
  ['offers', 'Quotes'],
  ['holds', 'Holds'],
  ['checkouts', 'Checkouts'],
  ['paid', 'Paid'],
  ['reservations', 'Booked'],
] as const;

function Pill({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-full border px-3 py-1 text-sm',
        active ? 'border-primary bg-accent font-medium' : 'hover:bg-muted',
      )}
    >
      {children}
    </Link>
  );
}

export default async function FunnelPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ days?: string; property?: string }>;
}) {
  const { orgId } = await params;
  const s = await searchParams;
  const days = RANGES.find((d) => String(d) === s.days) ?? 30;
  const propertyId = s.property && UUID.test(s.property) ? s.property : undefined;
  const q = new URLSearchParams({ days: String(days) });
  if (propertyId) q.set('propertyId', propertyId);
  const [{ properties }, funnel] = await Promise.all([
    api<{ properties: Property[] }>(`/v1/orgs/${orgId}/properties`),
    api<FunnelDto>(`/v1/orgs/${orgId}/funnel?${q}`),
  ]);
  const href = (patch: { days?: number; property?: string | null }) => {
    const p = new URLSearchParams();
    const d = patch.days ?? days;
    if (d !== 30) p.set('days', String(d));
    const prop = patch.property === undefined ? propertyId : patch.property;
    if (prop) p.set('property', prop);
    const qs = p.toString();
    return `/app/${orgId}/funnel${qs ? `?${qs}` : ''}`;
  };
  const max = Math.max(1, ...funnel.stages.map((st) => st.count));
  const dailyMax = Math.max(1, ...funnel.daily.map((d) => d.searches));
  const empty = funnel.totals.searches + funnel.totals.views + funnel.totals.offers === 0;

  return (
    <>
      <PageHeader
        title="Agent funnel"
        description="How AI agents move from finding you to booking: every search you appeared in, every quote, hold and paid booking."
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {RANGES.map((d) => (
          <Pill key={d} href={href({ days: d })} active={d === days}>
            Last {d} days
          </Pill>
        ))}
        {properties.length > 1 ? (
          <>
            <span className="mx-1 h-5 w-px bg-border" aria-hidden />
            <Pill href={href({ property: null })} active={!propertyId}>
              All properties
            </Pill>
            {properties.map((p) => (
              <Pill key={p.id} href={href({ property: p.id })} active={p.id === propertyId}>
                {p.name}
              </Pill>
            ))}
          </>
        ) : null}
      </div>

      {empty ? (
        <EmptyState title="No agent activity in this period.">
          Publish your profile so AI agents can find you. Activity shows up here as soon as they do.
        </EmptyState>
      ) : (
        <>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>From search to reservation</CardTitle>
              <CardDescription>
                {formatDate(funnel.from)} to {formatDate(funnel.daily.at(-1)?.date ?? funnel.to)} (
                {funnel.timeZone}). Percentages compare each step with the one before.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="grid gap-3">
                {funnel.stages.map((st) => (
                  <li
                    key={st.key}
                    className="grid grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-3 text-sm"
                  >
                    <span>{st.label}</span>
                    <div className="h-6 overflow-hidden rounded bg-muted" aria-hidden>
                      <div
                        className="h-full rounded bg-primary/80"
                        style={{ width: `${Math.max(st.count > 0 ? 1 : 0, (st.count / max) * 100)}%` }}
                      />
                    </div>
                    <span className="w-28 text-right tabular-nums">
                      <span className="font-medium">{st.count.toLocaleString('en')}</span>
                      {st.conversion !== null ? (
                        <span className="ml-2 text-xs text-muted-foreground">{st.conversion}%</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card className="mb-6">
            <CardHeader>
              <CardTitle>By agent</CardTitle>
              <CardDescription>
                Partners use an API key; other agents are named by the app they report (for example an MCP
                client).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <thead>
                  <tr>
                    <Th>Agent</Th>
                    {COLUMNS.map(([key, label]) => (
                      <Th key={key} className="text-right">
                        {label}
                      </Th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {funnel.byAgent.map((a) => (
                    <tr key={`${a.partner}-${a.channel}-${a.name}`}>
                      <Td>
                        <span className="font-medium">{a.name}</span>
                        <span className="ml-2 inline-flex gap-1">
                          <Badge variant="outline">{a.channel.toUpperCase()}</Badge>
                          {a.partner ? <Badge variant="secondary">Partner</Badge> : null}
                        </span>
                      </Td>
                      {COLUMNS.map(([key]) => (
                        <Td key={key} className="text-right tabular-nums">
                          {a.counts[key]}
                        </Td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Daily activity</CardTitle>
              <CardDescription>
                Searches you appeared in per day; dots mark days with reservations.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex h-36 items-end gap-0.5" role="img" aria-label="Searches per day">
                {funnel.daily.map((d) => (
                  <div
                    key={d.date}
                    className="relative flex h-full flex-1 flex-col justify-end"
                    title={`${formatDate(d.date)}: ${d.searches} searches, ${d.holds} holds, ${d.reservations} reservations`}
                  >
                    {d.reservations > 0 ? (
                      <span className="mx-auto mb-1 size-1.5 rounded-full bg-success" aria-hidden />
                    ) : null}
                    <div
                      className="mx-auto w-full max-w-6 rounded-t-sm bg-primary/70"
                      style={{
                        height: `${(d.searches / dailyMax) * 100}%`,
                        minHeight: d.searches > 0 ? 2 : 0,
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                <span>{formatDate(funnel.daily[0]?.date ?? funnel.from)}</span>
                <span>{formatDate(funnel.daily.at(-1)?.date ?? funnel.to)}</span>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
