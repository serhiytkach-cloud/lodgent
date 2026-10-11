import type {
  ExtractedAttribute,
  ExtractionModel,
  ExtractionResult,
  ExtractionTarget,
  PageContent,
} from '@lodgent/core';

interface KeywordTarget extends ExtractionTarget {
  synonyms: string[];
}

const NEGATIONS = /\b(no|not|without|isn['’]t|aren['’]t|unfortunately|cannot|can['’]t)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8 && s.length <= 400);
}

function parkingValue(sentence: string): 'free' | 'paid' | 'valet' | 'none' | null {
  const s = sentence.toLowerCase();
  if (/\bvalet\b/.test(s)) return 'valet';
  if (/\b(no|not)\b[^.]{0,30}\bparking\b|\bparking\b[^.]{0,20}\bnot available\b/.test(s)) return 'none';
  if (/\bfree\b[^.]{0,20}\bparking\b|\bparking\b[^.]{0,20}\b(free|complimentary|included)\b/.test(s))
    return 'free';
  if (/\bparking\b/.test(s) && /(€|\$|£|per (day|night)|fee|charge|paid)/.test(s)) return 'paid';
  return null;
}

/**
 * Offline extractor used when no Anthropic key is configured (local development, tests, demos).
 * Matches taxonomy synonyms sentence by sentence, records explicit negatives, and quotes the
 * matching sentence as evidence. Lower confidence than Claude, and labelled source "website".
 */
export class KeywordExtractionModel implements ExtractionModel {
  readonly name = 'keyword-matcher-v1';
  readonly source = 'website' as const;

  constructor(private readonly synonyms: Map<string, string[]>) {}

  async extract(input: {
    hotelName: string;
    pages: PageContent[];
    roomTypes: { name: string; description: string | null }[];
    attributes: ExtractionTarget[];
  }): Promise<ExtractionResult> {
    const targets: KeywordTarget[] = input.attributes
      .map((a) => ({ ...a, synonyms: this.synonyms.get(a.code) ?? [] }))
      .filter((a) => a.synonyms.length > 0);
    const patterns = targets.map((t) => ({
      target: t,
      regex: new RegExp(
        `(^|[^\\p{L}\\p{N}])(${t.synonyms.map(escapeRegExp).join('|')})(?=$|[^\\p{L}\\p{N}])`,
        'iu',
      ),
    }));
    const found = new Map<string, ExtractedAttribute>();

    for (const page of input.pages) {
      for (const sentence of sentences(page.text)) {
        const room = input.roomTypes.find((r) => sentence.toLowerCase().includes(r.name.toLowerCase()));
        for (const { target, regex } of patterns) {
          const match = regex.exec(sentence);
          if (!match) continue;
          let value: boolean | number | string | null = null;
          if (target.code === 'parking') value = parkingValue(sentence);
          else if (target.valueType === 'boolean') {
            const before = sentence.slice(
              Math.max(0, (match.index ?? 0) - 40),
              match.index + match[0].length,
            );
            value = !NEGATIONS.test(before);
          } else if (target.valueType === 'number') {
            const n = /(\d{2,4})\s?(m²|m2|sq ?m)/i.exec(sentence);
            value = n ? Number(n[1]) : null;
          } else if (target.valueType === 'text') value = sentence.slice(0, 200);
          if (value === null) continue;
          const roomTypeName = target.appliesTo === 'room' ? (room?.name ?? null) : null;
          if (target.appliesTo === 'room' && !roomTypeName) continue;
          const key = `${roomTypeName ?? ''}:${target.code}`;
          if (found.has(key)) continue;
          found.set(key, {
            code: target.code,
            value,
            confidence: 0.55,
            evidence: { url: page.url, snippet: sentence.slice(0, 200) },
            roomTypeName,
          });
        }
      }
    }

    const home = input.pages[0];
    const firstParagraph = home
      ? sentences(home.text)
          .filter((s) => s.length > 60)
          .slice(0, 3)
          .join(' ')
      : '';
    return {
      model: this.name,
      attributes: [...found.values()],
      propertyDescription:
        home && firstParagraph.length >= 80 ? { text: firstParagraph, evidenceUrl: home.url } : null,
      roomDescriptions: [],
    };
  }
}
