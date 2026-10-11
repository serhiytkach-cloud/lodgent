/**
 * The agent funnel for a hotel: how often agents found it, looked closer, quoted, held, and how
 * many of those turned into paid checkouts and PMS reservations, overall, per agent and per day.
 */

export const FUNNEL_KEYS = [
  'searches',
  'views',
  'offers',
  'holds',
  'checkouts',
  'paid',
  'reservations',
] as const;
export type FunnelKey = (typeof FUNNEL_KEYS)[number];
export type FunnelCounts = Record<FunnelKey, number>;

export interface AgentIdentity {
  agentClientId: string | null;
  partnerName: string | null;
  clientName: string | null;
  channel: 'mcp' | 'rest';
}

export interface AgentLabel {
  name: string;
  partner: boolean;
  channel: 'mcp' | 'rest';
}

const EVENT_STAGE: Record<string, FunnelKey> = {
  search_impression: 'searches',
  hotel_view: 'views',
  offers_view: 'offers',
  hold_created: 'holds',
};

/** A partner's registered name wins; otherwise the app's self-reported name; otherwise anonymous. */
export function agentLabel(a: AgentIdentity): AgentLabel {
  if (a.partnerName) return { name: a.partnerName, partner: true, channel: a.channel };
  const client = a.clientName?.trim();
  if (client) return { name: client, partner: false, channel: a.channel };
  return {
    name: a.channel === 'mcp' ? 'Unidentified MCP client' : 'Anonymous API client',
    partner: false,
    channel: a.channel,
  };
}

export const emptyCounts = (): FunnelCounts => ({
  searches: 0,
  views: 0,
  offers: 0,
  holds: 0,
  checkouts: 0,
  paid: 0,
  reservations: 0,
});

/** Calendar days from `from` (inclusive) to `to` (exclusive), as YYYY-MM-DD. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (
    let d = new Date(`${from}T00:00:00Z`);
    d < new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function buildFunnel(input: {
  from: string;
  to: string;
  events: (AgentIdentity & { day: string; kind: string; count: number })[];
  bookings: (AgentIdentity & { day: string; started: number; paid: number; reserved: number })[];
}) {
  const totals = emptyCounts();
  const byDay = new Map(daysBetween(input.from, input.to).map((d) => [d, emptyCounts()]));
  const byAgent = new Map<string, AgentLabel & { counts: FunnelCounts }>();
  const agentRow = (a: AgentIdentity) => {
    const label = agentLabel(a);
    const key = `${label.partner ? 'p' : 'c'}:${label.channel}:${label.name.toLowerCase()}`;
    let row = byAgent.get(key);
    if (!row) {
      row = { ...label, counts: emptyCounts() };
      byAgent.set(key, row);
    }
    return row;
  };
  const add = (a: AgentIdentity, day: string, key: FunnelKey, n: number) => {
    if (n <= 0) return;
    totals[key] += n;
    agentRow(a).counts[key] += n;
    const d = byDay.get(day);
    if (d) d[key] += n;
  };
  for (const e of input.events) {
    const key = EVENT_STAGE[e.kind];
    if (key) add(e, e.day, key, e.count);
  }
  for (const b of input.bookings) {
    add(b, b.day, 'checkouts', b.started);
    add(b, b.day, 'paid', b.paid);
    add(b, b.day, 'reservations', b.reserved);
  }
  const stages = FUNNEL_KEYS.map((key, i) => {
    const previous = i === 0 ? 0 : totals[FUNNEL_KEYS[i - 1]!];
    return {
      key,
      count: totals[key],
      conversion: i === 0 || previous === 0 ? null : Math.round((totals[key] / previous) * 100),
    };
  });
  return {
    totals,
    stages,
    byAgent: [...byAgent.values()].sort(
      (a, b) =>
        b.counts.reservations - a.counts.reservations ||
        b.counts.searches - a.counts.searches ||
        a.name.localeCompare(b.name),
    ),
    daily: [...byDay.entries()].map(([date, counts]) => ({ date, ...counts })),
  };
}
