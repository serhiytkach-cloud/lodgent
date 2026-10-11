import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  type ExtractionModel,
  type ExtractionResult,
  type ExtractionTarget,
  type PageContent,
  UpstreamError,
} from '@lodgent/core';
import { z } from 'zod';

/** What Claude returns (validated by structured outputs, then again by us). */
const ExtractionOutput = z.object({
  attributes: z.array(
    z.object({
      code: z.string().describe('Attribute code from the vocabulary'),
      value: z
        .string()
        .describe('"true"/"false" for yes-no attributes, a number for numeric ones, or one allowed value'),
      room_type_name: z
        .string()
        .nullable()
        .describe(
          'For room-level attributes, the exact room type name it applies to; null for the whole hotel',
        ),
      confidence: z.number().describe('0 to 1'),
      evidence_url: z.string().describe('URL of the page the quote comes from'),
      evidence_quote: z.string().describe('Exact, verbatim quote from that page (at most 200 characters)'),
    }),
  ),
  property_description: z
    .object({ text: z.string(), evidence_url: z.string() })
    .nullable()
    .describe('2–4 factual sentences describing the hotel, based only on the pages'),
  room_descriptions: z.array(
    z.object({ room_type_name: z.string(), text: z.string(), evidence_url: z.string() }),
  ),
});

const SYSTEM = `You extract facts about a hotel from its own website so AI travel agents can match guests to it.

Rules:
- Report an attribute only when the pages state it explicitly. Never infer from photos, prices, or what hotels "usually" have.
- Record explicit negatives too (for example "pets are not allowed" means pets_allowed = "false").
- Every attribute needs a verbatim quote copied exactly from the page text (same words, at most 200 characters). If you can't quote it, leave the attribute out.
- Use only codes from the vocabulary. Respect each attribute's type and allowed values.
- Room-level attributes must name one of the hotel's room types exactly as listed; otherwise use null for hotel-wide facts.
- Confidence: 0.9+ for direct statements, 0.6–0.8 for clear but indirect wording. Drop anything below 0.5.
- Descriptions must be factual and neutral (no superlatives the pages don't support), written for travellers.`;

const MAX_PAGE_CHARS = 6_000;
const MAX_TOTAL_CHARS = 90_000;

export function vocabularyBlock(attributes: ExtractionTarget[]): string {
  const lines = attributes.map((a) => {
    const type =
      a.valueType === 'enum'
        ? `one of ${a.enumValues?.join('|')}`
        : a.valueType === 'number'
          ? 'number'
          : a.valueType;
    return `${a.code} | ${a.label} | ${type} | ${a.appliesTo}`;
  });
  return `Attribute vocabulary (code | label | type | applies to):\n${lines.join('\n')}`;
}

export function pagesBlock(pages: PageContent[]): string {
  let budget = MAX_TOTAL_CHARS;
  const parts: string[] = [];
  for (const page of pages) {
    if (budget <= 0) break;
    const text = page.text.slice(0, Math.min(MAX_PAGE_CHARS, budget));
    budget -= text.length;
    parts.push(`<page url="${page.url}" title="${(page.title ?? '').replace(/"/g, "'")}">\n${text}\n</page>`);
  }
  return parts.join('\n\n');
}

/**
 * Attribute extraction with Claude structured outputs. The default model is configured by
 * ANTHROPIC_MODEL (claude-sonnet-5-5). Server-side refusal fallbacks are enabled.
 */
export class ClaudeExtractionModel implements ExtractionModel {
  readonly name: string;
  readonly source = 'ai_extracted' as const;
  private readonly client: Anthropic;

  constructor(options: { apiKey: string; model: string; client?: Anthropic }) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey });
    this.name = options.model;
  }

  async extract(input: {
    hotelName: string;
    pages: PageContent[];
    roomTypes: { name: string; description: string | null }[];
    attributes: ExtractionTarget[];
  }): Promise<ExtractionResult> {
    const rooms = input.roomTypes
      .map((r) => `- ${r.name}${r.description ? `: ${r.description}` : ''}`)
      .join('\n');
    const response = await this.client.beta.messages
      .parse({
        model: this.name,
        max_tokens: 16_000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [
          // The rules and the vocabulary are identical for every hotel: cache them.
          { type: 'text', text: SYSTEM },
          { type: 'text', text: vocabularyBlock(input.attributes), cache_control: { type: 'ephemeral' } },
        ],
        messages: [
          {
            role: 'user',
            content: `Hotel: ${input.hotelName}\n\nRoom types:\n${rooms || '(none listed)'}\n\nWebsite pages:\n\n${pagesBlock(input.pages)}`,
          },
        ],
        output_config: { format: betaZodOutputFormat(ExtractionOutput) },
      })
      .catch((error: unknown) => {
        if (error instanceof Anthropic.APIError) {
          throw new UpstreamError('anthropic', `Claude extraction failed (${error.status ?? 'network'})`, {
            status: error.status,
          });
        }
        throw error;
      });
    if (response.stop_reason === 'refusal') {
      throw new UpstreamError('anthropic', 'Claude declined to process these pages', {
        category: response.stop_details?.category ?? null,
      });
    }
    const out = response.parsed_output;
    if (!out)
      throw new UpstreamError('anthropic', 'Claude returned no structured output', {
        stop: response.stop_reason,
      });

    return {
      model: response.model,
      attributes: out.attributes.map((a) => ({
        code: a.code,
        value: a.value,
        confidence: a.confidence,
        evidence: { url: a.evidence_url, snippet: a.evidence_quote },
        roomTypeName: a.room_type_name,
      })),
      propertyDescription: out.property_description
        ? { text: out.property_description.text, evidenceUrl: out.property_description.evidence_url }
        : null,
      roomDescriptions: out.room_descriptions.map((r) => ({
        roomTypeName: r.room_type_name,
        text: r.text,
        evidenceUrl: r.evidence_url,
      })),
    };
  }
}
