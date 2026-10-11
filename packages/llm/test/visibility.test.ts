import Anthropic from '@anthropic-ai/sdk';
import Perplexity from '@perplexity-ai/perplexity_ai';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import {
  AnthropicVisibilityProvider,
  GeminiVisibilityProvider,
  OpenAIVisibilityProvider,
  PerplexityVisibilityProvider,
  SimulatedVisibilityProvider,
} from '../src/visibility';

type Seen = { url: string; body: Record<string, unknown> }[];
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function fetchSequence(responses: unknown[], seen: Seen) {
  let i = 0;
  return async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return json(responses[Math.min(i++, responses.length - 1)]);
  };
}
const location = { city: 'Lisboa', region: null, country: 'PT' };

describe('Anthropic (web_search_20260209)', () => {
  it('asks with web search, resumes a paused turn, collects text, citations and cost', async () => {
    const seen: Seen = [];
    const paused = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      stop_reason: 'pause_turn',
      stop_sequence: null,
      content: [
        {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: { query: 'boutique hotels lisbon' },
        },
      ],
      usage: { input_tokens: 3000, output_tokens: 100, server_tool_use: { web_search_requests: 1 } },
    };
    const final = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [
        {
          type: 'text',
          text: '1. **Casa Azul Lisboa** – river views.',
          citations: [
            {
              type: 'web_search_result_location',
              url: 'https://casaazul.example/',
              title: 'Casa Azul',
              encrypted_index: 'x',
              cited_text: 'river',
            },
          ],
        },
        { type: 'text', text: '\n2. **Memmo Alfama** – rooftop pool.', citations: null },
      ],
      usage: { input_tokens: 5000, output_tokens: 400, server_tool_use: { web_search_requests: 1 } },
    };
    const client = new Anthropic({ apiKey: 'k', maxRetries: 0, fetch: fetchSequence([paused, final], seen) });
    const provider = new AnthropicVisibilityProvider({ apiKey: 'k', model: 'claude-sonnet-5-5', client });
    const answer = await provider.ask('best boutique hotels in Lisboa', { location });

    expect(seen).toHaveLength(2);
    expect(seen[0]!.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      tools: [
        {
          type: 'web_search_20260209',
          name: 'web_search',
          max_uses: 3,
          user_location: { type: 'approximate', city: 'Lisboa', country: 'PT' },
        },
      ],
      messages: [{ role: 'user', content: 'best boutique hotels in Lisboa' }],
    });
    expect((seen[1]!.body.messages as unknown[]).length).toBe(2); // the paused assistant turn was sent back
    expect(answer.text).toBe('1. **Casa Azul Lisboa** – river views.\n2. **Memmo Alfama** – rooftop pool.');
    expect(answer.citations).toEqual([{ url: 'https://casaazul.example/', title: 'Casa Azul' }]);
    expect(answer.searches).toBe(2);
    // 8000 in × $2 + 500 out × $10 per MTok + 2 searches × $0.01 = $0.016 + $0.005 + $0.02
    expect(answer.costCents).toBeCloseTo(4.1, 5);
    expect(provider.estimateCostCents()).toBeGreaterThanOrEqual(answer.costCents);
  });
});

describe('OpenAI (Responses + web_search)', () => {
  it('reads output text, url citations and counts searches', async () => {
    const seen: Seen = [];
    const client = new OpenAI({
      apiKey: 'k',
      maxRetries: 0,
      fetch: fetchSequence(
        [
          {
            id: 'resp_1',
            object: 'response',
            created_at: 1,
            model: 'gpt-5.2',
            status: 'completed',
            output: [
              {
                type: 'web_search_call',
                id: 'ws_1',
                status: 'completed',
                action: { type: 'search', query: 'q' },
              },
              {
                type: 'message',
                id: 'msg_1',
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: '1. **Casa Azul Lisboa**',
                    annotations: [
                      {
                        type: 'url_citation',
                        url: 'https://casaazul.example/',
                        title: 'Casa Azul',
                        start_index: 0,
                        end_index: 5,
                      },
                    ],
                  },
                ],
              },
            ],
            usage: { input_tokens: 10_000, output_tokens: 1_000, total_tokens: 11_000 },
          },
        ],
        seen,
      ),
    });
    const provider = new OpenAIVisibilityProvider({ apiKey: 'k', model: 'gpt-5.2', client });
    const answer = await provider.ask('best boutique hotels in Lisboa', { location });
    expect(seen[0]!.url).toContain('/responses');
    expect(seen[0]!.body).toMatchObject({
      model: 'gpt-5.2',
      input: 'best boutique hotels in Lisboa',
      tools: [{ type: 'web_search', user_location: { type: 'approximate', city: 'Lisboa', country: 'PT' } }],
    });
    expect(answer).toMatchObject({
      text: '1. **Casa Azul Lisboa**',
      citations: [{ url: 'https://casaazul.example/', title: 'Casa Azul' }],
      searches: 1,
    });
    expect(answer.costCents).toBeCloseTo(3.25, 5);
  });
});

describe('Gemini (Google Search grounding)', () => {
  it('maps grounding chunks (redirect links resolved to the source domain)', async () => {
    const calls: unknown[] = [];
    const provider = new GeminiVisibilityProvider({
      apiKey: 'k',
      model: 'gemini-3-flash',
      models: {
        async generateContent(params) {
          calls.push(params);
          return {
            text: '1. **Casa Azul Lisboa**',
            candidates: [
              {
                groundingMetadata: {
                  webSearchQueries: ['boutique hotels lisbon'],
                  groundingChunks: [
                    {
                      web: {
                        uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc',
                        title: 'casaazul.example',
                      },
                    },
                  ],
                },
              },
            ],
            usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 },
          };
        },
      },
    });
    const answer = await provider.ask('best boutique hotels in Lisboa');
    expect(calls[0]).toMatchObject({ model: 'gemini-3-flash', config: { tools: [{ googleSearch: {} }] } });
    expect(answer.citations).toEqual([{ url: 'https://casaazul.example/', title: 'casaazul.example' }]);
    expect(answer.searches).toBe(1);
  });
});

describe('Perplexity (Sonar)', () => {
  it('uses search results as citations and the reported cost', async () => {
    const seen: Seen = [];
    const client = new Perplexity({
      apiKey: 'k',
      maxRetries: 0,
      fetch: fetchSequence(
        [
          {
            id: 'p1',
            created: 1,
            model: 'sonar-pro',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: '1. **Casa Azul Lisboa**' },
                delta: { role: 'assistant', content: '' },
              },
            ],
            search_results: [{ url: 'https://casaazul.example/', title: 'Casa Azul' }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 20,
              total_tokens: 30,
              num_search_queries: 1,
              cost: { input_tokens_cost: 0, output_tokens_cost: 0, total_cost: 0.0062 },
            },
          },
        ],
        seen,
      ) as unknown as typeof fetch,
    });
    const provider = new PerplexityVisibilityProvider({ apiKey: 'k', model: 'sonar-pro', client });
    const answer = await provider.ask('best boutique hotels in Lisboa', { location });
    expect(seen[0]!.body).toMatchObject({
      model: 'sonar-pro',
      web_search_options: { user_location: { country: 'PT' } },
    });
    expect(answer).toMatchObject({
      text: '1. **Casa Azul Lisboa**',
      citations: [{ url: 'https://casaazul.example/', title: 'Casa Azul' }],
    });
    expect(answer.costCents).toBeCloseTo(0.62, 5);
  });
});

describe('SimulatedVisibilityProvider', () => {
  it('is deterministic and labelled as simulated', async () => {
    const known = async () => [{ name: 'Casa Azul Lisboa', website: 'https://casaazul.example/' }];
    const a = await new SimulatedVisibilityProvider('openai', known).ask('best boutique hotels in Lisboa');
    const b = await new SimulatedVisibilityProvider('openai', known).ask('best boutique hotels in Lisboa');
    expect(a).toEqual(b);
    expect(a.text).toMatch(/^Here are some well-reviewed options:\n\n1\. \*\*/);
    expect(a.costCents).toBe(0);
    expect(new SimulatedVisibilityProvider('gemini', known).label).toBe('Gemini (simulated)');
  });
});
