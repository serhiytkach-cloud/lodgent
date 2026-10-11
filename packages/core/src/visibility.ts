import { foldText } from './geo';

/**
 * AI visibility analysis: given an assistant's answer to a travel question, did it mention the
 * hotel, where in its list, who else did it recommend, and which sources did it cite?
 * Pure, deterministic text analysis (no second LLM call), so results are cheap and repeatable.
 */

export interface VisibilityTarget {
  name: string;
  city: string | null;
  /** Hostnames that count as the hotel's own site or its public profile. */
  ownDomains: string[];
  profileDomains: string[];
}

export interface AnswerAnalysis {
  mentioned: boolean;
  /** 1-based position among the hotels the answer lists; null if not listed or no list. */
  rank: number | null;
  listSize: number;
  competitors: string[];
  citedUrls: string[];
  ownSiteCited: boolean;
  profileCited: boolean;
  /** Short excerpt around the first mention (for the dashboard). */
  excerpt: string | null;
}

const GENERIC = new Set([
  'the',
  'hotel',
  'hotels',
  'inn',
  'by',
  'and',
  '&',
  'boutique',
  'resort',
  'suites',
  'house',
  'b&b',
]);

/** Name variants that identify the hotel in free text ("The Marlowe Charleston" → "marlowe charleston", "marlowe"). */
export function nameVariants(name: string, city: string | null): string[] {
  const words = foldText(name).split(' ').filter(Boolean);
  const cityWords = new Set(city ? foldText(city).split(' ') : []);
  const variants = new Set<string>([words.join(' ')]);
  const core = words.filter((w) => !GENERIC.has(w));
  if (core.length > 0) variants.add(core.join(' '));
  const withoutCity = core.filter((w) => !cityWords.has(w));
  if (withoutCity.length > 0) variants.add(withoutCity.join(' '));
  // Too short or too generic a variant would match other hotels ("azul", "inn").
  return [...variants].filter((v) => v.length >= 6 && (v.includes(' ') || v.length >= 7));
}

function containsName(haystack: string, variants: string[]): number {
  let best = -1;
  for (const v of variants) {
    const re = new RegExp(
      `(^|[^\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`,
      'u',
    );
    const m = re.exec(haystack);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

const LIST_ITEM = /^\s*(?:\d{1,2}[.)]|[-*•]|#{2,4})\s+(.*)$/;

/** The hotel-like name at the start of a list item: bold text, a link label, or text before a dash/colon. */
function leadingName(item: string): string | null {
  const text = item.trim();
  const bold = /^\*\*([^*]{2,80})\*\*/.exec(text) ?? /^__([^_]{2,80})__/.exec(text);
  const link = /^\[([^\]]{2,80})\]\(/.exec(text);
  let name = bold?.[1] ?? link?.[1] ?? text.split(/\s+[-–—:|(]\s*|:\s|\s\(/)[0] ?? '';
  name = name
    .replace(/\*\*/g, '')
    .replace(/[[\]]/g, '')
    .replace(/[:.,]$/, '')
    .trim();
  if (name.length < 3 || name.length > 80) return null;
  // Skip list items that are clearly not names (sentences, prices, generic advice).
  if (name.split(' ').length > 8 || /^\d|[€$£]/.test(name)) return null;
  return name;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function analyzeAnswer(input: {
  answer: string;
  citations: { url: string; title?: string | null }[];
  target: VisibilityTarget;
}): AnswerAnalysis {
  const { answer, target } = input;
  const variants = nameVariants(target.name, target.city);
  const folded = foldText(answer.replace(/\*\*/g, ''));
  const at = containsName(folded, variants);
  const mentioned = at >= 0;

  // Ordered list of recommended places, from list items in the answer.
  const listed: string[] = [];
  for (const line of answer.split('\n')) {
    const m = LIST_ITEM.exec(line);
    if (!m) continue;
    const name = leadingName(m[1]!);
    if (name && !listed.some((l) => foldText(l) === foldText(name))) listed.push(name);
  }
  const targetIndex = listed.findIndex((l) => containsName(foldText(l), variants) >= 0);
  const competitors = listed.filter((_, i) => i !== targetIndex).slice(0, 10);

  const citedUrls = [...new Set(input.citations.map((c) => c.url).filter(Boolean))];
  const hosts = citedUrls.map(hostOf).filter((h): h is string => !!h);
  const matches = (domains: string[]) =>
    domains.some((d) => {
      const domain = d.toLowerCase().replace(/^www\./, '');
      return hosts.some((h) => h === domain || h.endsWith(`.${domain}`));
    });

  let excerpt: string | null = null;
  if (mentioned) {
    const plain = answer.replace(/\*\*/g, '').replace(/\s+/g, ' ');
    const idx = foldText(plain).indexOf(variants.find((v) => foldText(plain).includes(v)) ?? '');
    if (idx >= 0) excerpt = plain.slice(Math.max(0, idx - 60), idx + 180).trim();
  }

  return {
    mentioned,
    rank: targetIndex >= 0 ? targetIndex + 1 : null,
    listSize: listed.length,
    competitors,
    citedUrls: citedUrls.slice(0, 20),
    ownSiteCited: matches(target.ownDomains),
    profileCited: matches(target.profileDomains),
    excerpt,
  };
}

/** Questions travellers ask assistants that this hotel should appear in (up to `limit`). */
export function suggestQueries(input: {
  city: string | null;
  region: string | null;
  attributes: { code: string; label: string; importance: number }[];
  limit?: number;
}): string[] {
  const where = input.city ?? input.region;
  if (!where) return [];
  const limit = input.limit ?? 10;
  const phrases: Record<string, string> = {
    pets_allowed: `dog-friendly hotels in ${where}`,
    spa: `hotels with a spa in ${where}`,
    family_friendly: `family-friendly hotels in ${where}`,
    romantic: `romantic hotels in ${where} for a weekend away`,
    adults_only: `adults-only hotels in ${where}`,
    river_view: `hotels with river views in ${where}`,
    mountain_view: `hotels with mountain views in ${where}`,
    sea_view: `hotels with sea views in ${where}`,
    beachfront: `beachfront hotels in ${where}`,
    rooftop_bar: `hotels with a rooftop bar in ${where}`,
    historic_building: `historic hotels in ${where}`,
    ski_in_ski_out: `ski-in ski-out hotels in ${where}`,
    wheelchair_accessible: `wheelchair accessible hotels in ${where}`,
    sauna: `hotels with a sauna in ${where}`,
    outdoor_pool: `hotels with a pool in ${where}`,
    indoor_pool: `hotels with an indoor pool in ${where}`,
    breakfast_included_rate: `hotels in ${where} with breakfast included`,
    city_center: `central hotels in ${where}`,
    quiet_location: `quiet hotels in ${where}`,
    kitchenette: `hotels with a kitchenette in ${where}`,
    long_stays: `hotels in ${where} for a long stay or workation`,
  };
  const out = [`best boutique hotels in ${where}`];
  const ranked = [...input.attributes].sort(
    (a, b) => b.importance - a.importance || a.code.localeCompare(b.code),
  );
  for (const a of ranked) {
    const phrase = phrases[a.code];
    if (phrase && !out.includes(phrase)) out.push(phrase);
  }
  for (const generic of [`where to stay in ${where}`, `best hotels in ${where} for a weekend`]) {
    if (!out.includes(generic)) out.push(generic);
  }
  return out.slice(0, limit);
}

export interface VisibilityRecommendation {
  key: string;
  title: string;
  detail: string;
}

/** Plain next steps from the latest results and the profile. */
export function visibilityRecommendations(input: {
  published: boolean;
  websiteUrl: string | null;
  completeness: number;
  topGaps: string[];
  results: { mentioned: boolean; ownSiteCited: boolean; profileCited: boolean; competitors: string[] }[];
}): VisibilityRecommendation[] {
  const recs: VisibilityRecommendation[] = [];
  const n = input.results.length;
  const mentionRate = n ? input.results.filter((r) => r.mentioned).length / n : 0;
  if (!input.published) {
    recs.push({
      key: 'publish',
      title: 'Publish your profile',
      detail: 'AI agents and assistants can only book you once your profile is published.',
    });
  }
  if (n > 0 && !input.results.some((r) => r.ownSiteCited)) {
    recs.push({
      key: 'jsonld',
      title: input.websiteUrl ? 'Add the structured-data snippet to your website' : 'Add your website',
      detail: input.websiteUrl
        ? 'Assistants never cited your site. The schema.org snippet on the Publish tab tells them your amenities, rooms and prices in a form they read reliably.'
        : 'Assistants cite hotel websites. Add yours under Details and publish the structured-data snippet.',
    });
  }
  if (input.completeness < 70) {
    recs.push({
      key: 'complete',
      title: 'Complete your profile',
      detail: `Your profile is ${input.completeness}% complete.${input.topGaps.length > 0 ? ` Start with: ${input.topGaps.slice(0, 3).join(', ')}.` : ''}`,
    });
  }
  const counts = new Map<string, number>();
  for (const r of input.results) for (const c of r.competitors) counts.set(c, (counts.get(c) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  if (n > 0 && mentionRate < 0.5 && top.length > 0) {
    recs.push({
      key: 'competitors',
      title: 'Study who assistants recommend instead',
      detail: `${top.map(([name]) => name).join(', ')} came up most often. Compare what their websites say about the amenities travellers ask for.`,
    });
  }
  return recs;
}
