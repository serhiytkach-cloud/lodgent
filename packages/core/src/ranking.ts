import { formatMoney } from '@lodgent/shared';

/**
 * Deterministic, explainable hotel ranking. Hard filters remove hotels that can't serve the request
 * (missing must-haves, too small, no availability); the rest are scored on weighted components that
 * are each reported back to the agent in plain language. Same input, same order.
 */

export type AttrValue = boolean | number | string;

export interface Requirement {
  /** What the agent asked for, as interpreted ("Pets allowed", "Parking: free"). */
  label: string;
  /** Alternatives: any one of these codes satisfies the requirement. */
  codes: string[];
  /** For enum attributes: the value required. */
  value?: AttrValue;
}

export interface RankRoom {
  id: string;
  name: string;
  maxOccupancy: number | null;
  attributes: Record<string, AttrValue>;
}

export interface RankCandidate {
  hotelId: string;
  name: string;
  /** Profile completeness 0–100. */
  completeness: number;
  /** Approved hotel-level attribute values. */
  attributes: Record<string, AttrValue>;
  /** Room types with at least one rate plan agents can sell. */
  rooms: RankRoom[];
  /** Cosine similarity of the hotel to the free-text preferences; null without preferences. */
  similarity: number | null;
  /** Cheapest all-in stay (minor units). Undefined when no dates were given; null when nothing is available. */
  price?: { total: number; perNight: number; nights: number; currency: string } | null;
  distanceKm?: number | null;
}

export interface RankQuery {
  mustHave: Requirement[];
  niceToHave: Requirement[];
  partySize: number;
  /** Per night, minor units. */
  budgetPerNight?: { amount: number; currency: string } | null;
}

export interface RankedHotel {
  hotelId: string;
  score: number;
  components: { similarity?: number; niceToHave?: number; price?: number; completeness: number };
  matched: { mustHave: string[]; niceToHave: string[]; missingNiceToHave: string[] };
  why: string[];
}

export interface Excluded {
  hotelId: string;
  reason: string;
}

export const RANKING_WEIGHTS = { similarity: 0.4, niceToHave: 0.25, price: 0.25, completeness: 0.1 } as const;

function truthy(value: AttrValue | undefined): boolean {
  return value !== undefined && value !== false && value !== 'none';
}

function holds(req: Requirement, attrs: Record<string, AttrValue>): boolean {
  return req.codes.some((code) =>
    req.value !== undefined ? attrs[code] === req.value : truthy(attrs[code]),
  );
}

function fits(room: RankRoom, partySize: number): boolean {
  return room.maxOccupancy === null || room.maxOccupancy >= partySize;
}

/** Where a requirement is met: the hotel itself, or a room type that also fits the party. */
export function requirementMet(req: Requirement, c: RankCandidate, partySize: number): string | null {
  if (holds(req, c.attributes)) return 'hotel';
  const room = c.rooms.find((r) => fits(r, partySize) && holds(req, r.attributes));
  return room ? room.name : null;
}

export function eligibility(c: RankCandidate, q: RankQuery): { ok: true } | { ok: false; reason: string } {
  if (c.rooms.length === 0) return { ok: false, reason: 'no rooms bookable via agents' };
  if (!c.rooms.some((r) => fits(r, q.partySize)))
    return { ok: false, reason: `no room for ${q.partySize} guests` };
  const missing = q.mustHave.filter((req) => requirementMet(req, c, q.partySize) === null);
  if (missing.length > 0) return { ok: false, reason: `missing ${missing.map((m) => m.label).join(', ')}` };
  if (c.price === null) return { ok: false, reason: 'no availability for these dates' };
  return { ok: true };
}

function priceFit(
  price: NonNullable<RankCandidate['price']>,
  budget: RankQuery['budgetPerNight'],
  cheapest: Map<string, number>,
): number {
  if (budget && budget.currency === price.currency) {
    if (price.perNight <= budget.amount) return 1;
    return Math.max(0, 1 - (price.perNight - budget.amount) / (0.5 * budget.amount));
  }
  const min = cheapest.get(price.currency);
  return min ? min / price.perNight : 0.5;
}

function similarityWords(sim: number): string {
  if (sim >= 0.6) return 'Strong';
  if (sim >= 0.4) return 'Good';
  return 'Partial';
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

export function rankHotels(
  candidates: RankCandidate[],
  q: RankQuery,
  options: { preferencesText?: string | null } = {},
): { ranked: RankedHotel[]; excluded: Excluded[] } {
  const excluded: Excluded[] = [];
  const eligible: RankCandidate[] = [];
  for (const c of candidates) {
    const e = eligibility(c, q);
    if (e.ok) eligible.push(c);
    else excluded.push({ hotelId: c.hotelId, reason: e.reason });
  }

  const cheapest = new Map<string, number>();
  for (const c of eligible) {
    if (!c.price) continue;
    const current = cheapest.get(c.price.currency);
    if (current === undefined || c.price.perNight < current) cheapest.set(c.price.currency, c.price.perNight);
  }

  const ranked = eligible.map((c): RankedHotel & { sortPrice: number; name: string } => {
    const why: string[] = [];
    const parts: { weight: number; value: number }[] = [];
    const components: RankedHotel['components'] = { completeness: round(c.completeness / 100) };

    const mustHave = q.mustHave.map((req) => ({ req, where: requirementMet(req, c, q.partySize)! }));
    if (mustHave.length > 0) {
      why.push(
        `Has ${mustHave.map(({ req, where }) => (where === 'hotel' ? req.label : `${req.label} (${where})`)).join(', ')}, confirmed by the hotel`,
      );
    }

    if (c.similarity !== null) {
      const sim = Math.max(0, Math.min(1, c.similarity));
      components.similarity = round(sim);
      parts.push({ weight: RANKING_WEIGHTS.similarity, value: sim });
      // A weak match still counts in the score but isn't worth telling the traveller.
      if (sim >= 0.2) {
        const what = options.preferencesText
          ? `“${options.preferencesText.slice(0, 80)}”`
          : 'your preferences';
        why.push(`${similarityWords(sim)} match for ${what}`);
      }
    }

    const niceMet = q.niceToHave.filter((req) => requirementMet(req, c, q.partySize) !== null);
    const niceMissing = q.niceToHave.filter((req) => !niceMet.includes(req));
    if (q.niceToHave.length > 0) {
      const value = niceMet.length / q.niceToHave.length;
      components.niceToHave = round(value);
      parts.push({ weight: RANKING_WEIGHTS.niceToHave, value });
      if (niceMet.length > 0) why.push(`Also has ${niceMet.map((r) => r.label).join(', ')}`);
      if (niceMissing.length > 0) why.push(`Doesn’t list ${niceMissing.map((r) => r.label).join(', ')}`);
    }

    if (c.price) {
      const value = priceFit(c.price, q.budgetPerNight, cheapest);
      components.price = round(value);
      parts.push({ weight: RANKING_WEIGHTS.price, value });
      const total = formatMoney({ amount: c.price.total, currency: c.price.currency });
      const night = formatMoney({ amount: c.price.perNight, currency: c.price.currency });
      let line = `From ${total} all-in for ${c.price.nights} night${c.price.nights === 1 ? '' : 's'} (${night}/night)`;
      if (q.budgetPerNight && q.budgetPerNight.currency === c.price.currency) {
        line += c.price.perNight <= q.budgetPerNight.amount ? ', within budget' : ', above budget';
      } else if (q.budgetPerNight) {
        line += `, priced in ${c.price.currency}`;
      }
      why.push(line);
    }

    parts.push({ weight: RANKING_WEIGHTS.completeness, value: c.completeness / 100 });
    if (typeof c.distanceKm === 'number') why.push(`${c.distanceKm.toFixed(1)} km away`);

    const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
    const score = round(parts.reduce((s, p) => s + p.weight * p.value, 0) / totalWeight);
    return {
      hotelId: c.hotelId,
      name: c.name,
      score,
      components,
      matched: {
        mustHave: mustHave.flatMap(({ req }) => req.codes),
        niceToHave: niceMet.flatMap((r) => r.codes),
        missingNiceToHave: niceMissing.flatMap((r) => r.codes),
      },
      why,
      sortPrice: c.price?.perNight ?? Number.MAX_SAFE_INTEGER,
    };
  });

  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.sortPrice - b.sortPrice ||
      a.name.localeCompare(b.name) ||
      a.hotelId.localeCompare(b.hotelId),
  );
  return { ranked: ranked.map(({ sortPrice: _p, name: _n, ...rest }) => rest), excluded };
}
