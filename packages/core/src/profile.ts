/**
 * Attribute profile rules: which value is in effect, whether evidence is genuine, and how complete
 * a profile is. Pure functions over plain data.
 */

export type AttributeSource = 'pms' | 'website' | 'hotel' | 'ai_extracted';
export type AssignmentStatus = 'suggested' | 'approved' | 'rejected';

export interface AssignmentLike {
  id: string;
  attributeCode: string;
  roomTypeId: string | null;
  value: unknown;
  source: AttributeSource;
  status: AssignmentStatus;
  reviewedAt: Date | null;
  updatedAt: Date;
}

/**
 * The value in effect for each (room type or property, attribute): the most recently approved
 * assignment, with the hotel's own entries winning ties. Suggestions never take effect.
 */
export function effectiveAssignments<T extends AssignmentLike>(assignments: T[]): Map<string, T> {
  const result = new Map<string, T>();
  const rank = (a: T) => (a.reviewedAt ?? a.updatedAt).getTime() + (a.source === 'hotel' ? 1 : 0);
  for (const a of assignments) {
    if (a.status !== 'approved') continue;
    const key = scopeKey(a.roomTypeId, a.attributeCode);
    const current = result.get(key);
    if (!current || rank(a) > rank(current)) result.set(key, a);
  }
  return result;
}

export function scopeKey(roomTypeId: string | null, attributeCode: string): string {
  return `${roomTypeId ?? 'property'}:${attributeCode}`;
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’´`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * An evidence snippet only counts if it actually appears on the page (guards against an LLM
 * inventing quotes). Ellipses split a snippet into fragments that must all appear in order.
 */
export function evidenceAppearsIn(snippet: string, pageText: string): boolean {
  const haystack = normalizeText(pageText);
  const fragments = normalizeText(snippet)
    .split(/\s*(?:\.\.\.|…)\s*/)
    .filter((f) => f.length >= 3);
  if (fragments.length === 0) return false;
  let from = 0;
  for (const fragment of fragments) {
    const at = haystack.indexOf(fragment, from);
    if (at < 0) return false;
    from = at + fragment.length;
  }
  return true;
}

export interface CompletenessInput {
  description: string | null;
  photos: number;
  hasCoordinates: boolean;
  hasCheckInOut: boolean;
  websiteUrl: string | null;
  roomTypes: { name: string; description: string | null }[];
  exposedRatePlans: number;
  /** Property-level attributes in the taxonomy with their importance. */
  attributes: { code: string; label: string; importance: number; appliesTo: 'property' | 'room' | 'both' }[];
  /** Codes with an approved value (any value, including "no"). */
  answeredCodes: Set<string>;
}

export interface Gap {
  key: string;
  label: string;
  message: string;
  weight: number;
}

export interface Completeness {
  score: number;
  gaps: Gap[];
}

const BASIC_WEIGHT = 8;

/**
 * Completeness 0–100. Basics (description, location, times, rooms, a sellable rate) carry fixed
 * weight; attributes count by importance (only importance >= 3 matter for the score, so hotels
 * aren't punished for niche items). Answering "no" counts: agents need to know either way.
 */
export function completeness(input: CompletenessInput): Completeness {
  const items: { key: string; label: string; message: string; weight: number; done: boolean }[] = [
    {
      key: 'description',
      label: 'Hotel description',
      message: 'Add a description: agents quote it when recommending you.',
      weight: BASIC_WEIGHT,
      done: (input.description ?? '').trim().length >= 80,
    },
    {
      key: 'coordinates',
      label: 'Map location',
      message: 'Add latitude and longitude so agents can match “near …” searches.',
      weight: BASIC_WEIGHT,
      done: input.hasCoordinates,
    },
    {
      key: 'check_in_out',
      label: 'Check-in and check-out times',
      message: 'Set check-in and check-out times.',
      weight: BASIC_WEIGHT / 2,
      done: input.hasCheckInOut,
    },
    {
      key: 'photos',
      label: 'Photos',
      message: 'Add at least three photos.',
      weight: BASIC_WEIGHT / 2,
      done: input.photos >= 3,
    },
    {
      key: 'room_descriptions',
      label: 'Room descriptions',
      message: 'Describe every room type (size, beds, view).',
      weight: BASIC_WEIGHT,
      done:
        input.roomTypes.length > 0 && input.roomTypes.every((r) => (r.description ?? '').trim().length >= 30),
    },
    {
      key: 'sellable_rate',
      label: 'A rate plan sold via agents',
      message: 'Choose at least one rate plan agents may sell (Rooms & rates).',
      weight: BASIC_WEIGHT,
      done: input.exposedRatePlans > 0,
    },
  ];
  for (const a of input.attributes) {
    if (a.appliesTo === 'room' || a.importance < 3) continue;
    items.push({
      key: `attr:${a.code}`,
      label: a.label,
      message:
        a.importance >= 5
          ? `Agents often filter on “${a.label.toLowerCase()}”. You haven’t set it.`
          : `Set “${a.label.toLowerCase()}” (yes or no).`,
      weight: a.importance,
      done: input.answeredCodes.has(a.code),
    });
  }
  const total = items.reduce((s, i) => s + i.weight, 0);
  const done = items.filter((i) => i.done).reduce((s, i) => s + i.weight, 0);
  const gaps = items
    .filter((i) => !i.done)
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
    .map(({ key, label, message, weight }) => ({ key, label, message, weight }));
  return { score: total === 0 ? 0 : Math.round((done / total) * 100), gaps };
}

export interface PmsMappingInput {
  propertyPmsId: string;
  ratePlans: {
    pmsId: string | null;
    name: string;
    minGuarantee: 'none' | 'credit_card' | 'prepayment' | 'company';
    includedServices: { name: string; description: string | null }[];
    cancellationTitle: string | null;
  }[];
  roomTypes: {
    id: string;
    pmsId: string | null;
    name: string;
    description: string | null;
    maxOccupancy: number | null;
  }[];
}

export interface MappedAttribute {
  code: string;
  roomTypeId: string | null;
  value: boolean | number | string;
  confidence: number;
  evidence: { url: string; snippet: string };
}

const ROOM_KEYWORDS: { code: string; pattern: RegExp }[] = [
  { code: 'balcony', pattern: /\bbalcon(y|ies)\b/i },
  { code: 'terrace', pattern: /\b(private terrace|porch|patio)\b/i },
  { code: 'bathtub', pattern: /\b(bath ?tub|soaking tub)\b/i },
  { code: 'walk_in_shower', pattern: /\bwalk-?in shower\b/i },
  { code: 'rain_shower', pattern: /\brain(fall)? shower\b/i },
  { code: 'king_bed', pattern: /\bking(-size)? bed\b/i },
  { code: 'sofa_bed', pattern: /\bsofa ?bed\b/i },
  { code: 'coffee_machine', pattern: /\b(nespresso|coffee machine|espresso machine)\b/i },
  { code: 'separate_living_area', pattern: /\b(separate living|living room|living area)\b/i },
  { code: 'river_view', pattern: /\b(river view|over the (tagus|river))\b/i },
  { code: 'mountain_view', pattern: /\b(mountain[- ]view|panoramic window)\b/i },
  { code: 'garden_view', pattern: /\b(courtyard|garden)\b/i },
  { code: 'in_room_sauna', pattern: /\bprivate (infrared )?sauna\b/i },
  { code: 'family_rooms', pattern: /\b(bunk[- ]bed|family)\b/i },
];

/**
 * Suggestions derived from PMS data. Structured facts (included breakfast, occupancy) get high
 * confidence; keyword matches in PMS room descriptions get medium confidence.
 */
export function mapPmsToAttributes(input: PmsMappingInput): MappedAttribute[] {
  const out: MappedAttribute[] = [];
  const evidence = (path: string, snippet: string) => ({ url: `pms://apaleo/${path}`, snippet });

  const services = input.ratePlans.flatMap((rp) => rp.includedServices.map((s) => ({ rp, s })));
  const breakfast = services.find(({ s }) => /breakfast/i.test(s.name));
  if (breakfast) {
    out.push({
      code: 'breakfast_available',
      roomTypeId: null,
      value: true,
      confidence: 0.95,
      evidence: evidence(
        `rate-plans/${breakfast.rp.pmsId}`,
        `${breakfast.rp.name} includes ${breakfast.s.name}`,
      ),
    });
    out.push({
      code: 'breakfast_included_rate',
      roomTypeId: null,
      value: true,
      confidence: 0.95,
      evidence: evidence(
        `rate-plans/${breakfast.rp.pmsId}`,
        `${breakfast.rp.name} includes ${breakfast.s.name}`,
      ),
    });
  }
  const halfBoard = services.find(({ s }) => /half board|dinner/i.test(`${s.name} ${s.description ?? ''}`));
  if (halfBoard) {
    out.push({
      code: 'half_board',
      roomTypeId: null,
      value: true,
      confidence: 0.9,
      evidence: evidence(
        `rate-plans/${halfBoard.rp.pmsId}`,
        `${halfBoard.rp.name} includes ${halfBoard.s.name}`,
      ),
    });
  }

  for (const rt of input.roomTypes) {
    const text = `${rt.name}. ${rt.description ?? ''}`;
    const size = /(\d{2,3})\s?(m²|m2|sq ?m)/i.exec(text);
    if (size) {
      out.push({
        code: 'room_size_sqm',
        roomTypeId: rt.id,
        value: Number(size[1]),
        confidence: 0.9,
        evidence: evidence(`unit-groups/${rt.pmsId}`, size[0]),
      });
    }
    const sqft = /(\d{3,4})\s?sq ?ft/i.exec(text);
    if (sqft && !size) {
      out.push({
        code: 'room_size_sqm',
        roomTypeId: rt.id,
        value: Math.round(Number(sqft[1]) * 0.0929),
        confidence: 0.85,
        evidence: evidence(`unit-groups/${rt.pmsId}`, sqft[0]),
      });
    }
    for (const { code, pattern } of ROOM_KEYWORDS) {
      const match = pattern.exec(text);
      if (!match) continue;
      out.push({
        code,
        roomTypeId: rt.id,
        value: true,
        confidence: 0.7,
        evidence: evidence(`unit-groups/${rt.pmsId}`, snippetAround(text, match.index, match[0].length)),
      });
    }
  }
  if (input.roomTypes.some((rt) => (rt.maxOccupancy ?? 0) >= 4)) {
    const rt = input.roomTypes.find((r) => (r.maxOccupancy ?? 0) >= 4)!;
    out.push({
      code: 'family_rooms',
      roomTypeId: null,
      value: true,
      confidence: 0.75,
      evidence: evidence(`unit-groups/${rt.pmsId}`, `${rt.name}: up to ${rt.maxOccupancy} guests`),
    });
  }
  return out;
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, text.lastIndexOf(' ', Math.max(0, index - 40)));
  const end = Math.min(text.length, index + length + 40);
  return text.slice(start, end).trim();
}
