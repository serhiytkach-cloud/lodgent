import Anthropic from '@anthropic-ai/sdk';
import { UpstreamError } from '@lodgent/core';
import { describe, expect, it } from 'vitest';
import { ClaudeExtractionModel } from '../src/claude-extraction';
import { KeywordExtractionModel } from '../src/keyword-extraction';

const pages = [
  {
    url: 'https://hotel.example/',
    title: 'Home',
    text: 'A boutique hotel by the sea.\nFree Wi-Fi in all rooms.\nUnfortunately pets are not allowed.',
  },
  {
    url: 'https://hotel.example/rooms',
    title: 'Rooms',
    text: 'The Sea Suite has a private terrace and a bathtub.',
  },
];
const attributes = [
  {
    code: 'free_wifi',
    label: 'Free Wi-Fi',
    valueType: 'boolean' as const,
    enumValues: null,
    appliesTo: 'property' as const,
  },
  {
    code: 'pets_allowed',
    label: 'Pets allowed',
    valueType: 'boolean' as const,
    enumValues: null,
    appliesTo: 'property' as const,
  },
  {
    code: 'terrace',
    label: 'Private terrace',
    valueType: 'boolean' as const,
    enumValues: null,
    appliesTo: 'room' as const,
  },
];
const input = {
  hotelName: 'Hotel Example',
  pages,
  roomTypes: [{ name: 'Sea Suite', description: null }],
  attributes,
};

/** A real SDK client whose HTTP layer returns a canned Messages API response. */
function clientReturning(
  body: unknown,
  status = 200,
  seen?: { url: string; headers: Headers; body: Record<string, unknown> }[],
) {
  return new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      seen?.push({
        url: String(url),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    },
  });
}

const message = (output: unknown, extra: Record<string, unknown> = {}) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text: JSON.stringify(output) }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 300 },
  ...extra,
});

describe('ClaudeExtractionModel', () => {
  it('sends a cached vocabulary, structured-output schema and the pages; maps the answer', async () => {
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const client = clientReturning(
      message({
        attributes: [
          {
            code: 'free_wifi',
            value: 'true',
            room_type_name: null,
            confidence: 0.95,
            evidence_url: 'https://hotel.example/',
            evidence_quote: 'Free Wi-Fi in all rooms.',
          },
          {
            code: 'terrace',
            value: 'true',
            room_type_name: 'Sea Suite',
            confidence: 0.9,
            evidence_url: 'https://hotel.example/rooms',
            evidence_quote: 'The Sea Suite has a private terrace',
          },
        ],
        property_description: {
          text: 'A boutique hotel by the sea.',
          evidence_url: 'https://hotel.example/',
        },
        room_descriptions: [],
      }),
      200,
      seen,
    );
    const model = new ClaudeExtractionModel({ apiKey: 'test-key', model: 'claude-sonnet-5-5', client });
    const result = await model.extract(input);

    expect(result.model).toBe('claude-sonnet-5-5');
    expect(result.attributes).toEqual([
      {
        code: 'free_wifi',
        value: 'true',
        confidence: 0.95,
        roomTypeName: null,
        evidence: { url: 'https://hotel.example/', snippet: 'Free Wi-Fi in all rooms.' },
      },
      expect.objectContaining({ code: 'terrace', roomTypeName: 'Sea Suite' }),
    ]);
    expect(result.propertyDescription?.text).toBe('A boutique hotel by the sea.');

    const req = seen[0]!;
    expect(req.url).toContain('/v1/messages');
    expect(req.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(req.body.model).toBe('claude-sonnet-5-5');
    const system = req.body.system as { text: string; cache_control?: unknown }[];
    expect(system[1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1]!.text).toContain('pets_allowed | Pets allowed | boolean | property');
    const outputConfig = req.body.output_config as {
      format: { type: string; schema: Record<string, unknown> };
    };
    expect(outputConfig.format.type).toBe('json_schema');
    expect(JSON.stringify(outputConfig.format.schema)).toContain('evidence_quote');
    const userText = (req.body.messages as { content: string }[])[0]!.content;
    expect(userText).toContain('<page url="https://hotel.example/rooms" title="Rooms">');
    expect(userText).toContain('- Sea Suite');
  });

  it('turns a refusal into an upstream error', async () => {
    const client = clientReturning(
      message(null, {
        content: [],
        stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber' },
      }),
    );
    const model = new ClaudeExtractionModel({ apiKey: 'k', model: 'claude-sonnet-5-5', client });
    await expect(model.extract(input)).rejects.toBeInstanceOf(UpstreamError);
  });

  it('turns API errors into upstream errors without leaking the response', async () => {
    const client = clientReturning(
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      529,
    );
    const model = new ClaudeExtractionModel({ apiKey: 'k', model: 'claude-sonnet-5-5', client });
    const error = await model.extract(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as Error).message).toBe('Claude extraction failed (529)');
  });
});

describe('KeywordExtractionModel', () => {
  const model = new KeywordExtractionModel(
    new Map([
      ['free_wifi', ['free wi-fi']],
      ['pets_allowed', ['pets allowed', 'pets are not allowed']],
      ['terrace', ['private terrace']],
    ]),
  );

  it('quotes the matching sentence, records negatives and maps rooms by name', async () => {
    const result = await model.extract(input);
    const byCode = new Map(result.attributes.map((a) => [a.code, a]));
    expect(byCode.get('free_wifi')).toMatchObject({
      value: true,
      evidence: { url: 'https://hotel.example/', snippet: 'Free Wi-Fi in all rooms.' },
    });
    expect(byCode.get('pets_allowed')?.value).toBe(false);
    expect(byCode.get('terrace')).toMatchObject({ value: true, roomTypeName: 'Sea Suite' });
    for (const a of result.attributes) {
      expect(pages.find((p) => p.url === a.evidence.url)?.text).toContain(a.evidence.snippet);
    }
  });
});
