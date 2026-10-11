import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { UpstreamError, type VisibilityAnswer, type VisibilityProvider } from '@lodgent/core';
import Perplexity from '@perplexity-ai/perplexity_ai';
import OpenAI from 'openai';

/**
 * Assistants we monitor for AI visibility, each in its web-search mode, asked the question exactly
 * as a traveller would. A light system prompt asks for named recommendations so answers are
 * comparable across assistants.
 */
export const VISIBILITY_SYSTEM_PROMPT =
  'You are a helpful travel assistant. When asked where to stay, recommend specific hotels by name, as a short numbered list with one line on why for each, based on current web sources.';

type Location = NonNullable<Parameters<VisibilityProvider['ask']>[1]>['location'];

const cents = (usd: number) => Math.round(usd * 100 * 100) / 100;

/** USD per million tokens [input, output]. Unknown models fall back to the most expensive known. */
const ANTHROPIC_PRICES: Record<string, [number, number]> = {
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  'claude-fable-5-1': [10, 50],
};
const ANTHROPIC_SEARCH_USD = 0.01; // $10 per 1,000 searches

export class AnthropicVisibilityProvider implements VisibilityProvider {
  readonly id = 'anthropic' as const;
  readonly label = 'Claude';
  readonly simulated = false;
  private readonly client: Anthropic;

  constructor(
    options: { apiKey: string; model: string; client?: Anthropic },
    private readonly maxSearches = 3,
  ) {
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 2 });
    this.model = options.model;
  }

  readonly model: string;

  private price(): [number, number] {
    return ANTHROPIC_PRICES[this.model] ?? [10, 50];
  }

  estimateCostCents(): number {
    const [inp, out] = this.price();
    return Math.ceil(cents((12_000 * inp + 1_500 * out) / 1e6 + this.maxSearches * ANTHROPIC_SEARCH_USD));
  }

  async ask(question: string, options: { location?: Location } = {}): Promise<VisibilityAnswer> {
    const loc = options.location;
    const tool: Anthropic.WebSearchTool20260209 = {
      type: 'web_search_20260209',
      name: 'web_search',
      max_uses: this.maxSearches,
      ...(loc && (loc.city || loc.country)
        ? {
            user_location: {
              type: 'approximate',
              ...(loc.city ? { city: loc.city } : {}),
              ...(loc.region ? { region: loc.region } : {}),
              ...(loc.country ? { country: loc.country } : {}),
            },
          }
        : {}),
    };
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];
    let inputTokens = 0;
    let outputTokens = 0;
    let searches = 0;
    const text: string[] = [];
    const citations = new Map<string, string | null>();
    // A long server-side search turn can pause; resume it by sending the turn back (at most twice).
    for (let turn = 0; turn < 3; turn++) {
      const response = await this.client.messages
        .create({
          model: this.model,
          max_tokens: 4_000,
          system: VISIBILITY_SYSTEM_PROMPT,
          tools: [tool],
          messages,
        })
        .catch((error: unknown) => {
          if (error instanceof Anthropic.APIError) {
            throw new UpstreamError('anthropic', `Claude request failed (${error.status ?? 'network'})`);
          }
          throw error;
        });
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      searches += response.usage.server_tool_use?.web_search_requests ?? 0;
      for (const block of response.content) {
        if (block.type === 'text') {
          text.push(block.text);
          for (const c of block.citations ?? []) {
            if (c.type === 'web_search_result_location') citations.set(c.url, c.title ?? null);
          }
        }
      }
      if (response.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: response.content });
    }
    const [inp, out] = this.price();
    return {
      text: text.join(''),
      citations: [...citations.entries()].map(([url, title]) => ({ url, title })),
      model: this.model,
      costCents: cents((inputTokens * inp + outputTokens * out) / 1e6 + searches * ANTHROPIC_SEARCH_USD),
      searches,
    };
  }
}

/**
 * OpenAI Responses API with the web_search tool. The SDK reports tokens but not prices, so the cost
 * uses configurable per-token rates (verify them against your OpenAI pricing; SETUP-NEEDED).
 */
export class OpenAIVisibilityProvider implements VisibilityProvider {
  readonly id = 'openai' as const;
  readonly label = 'ChatGPT';
  readonly simulated = false;
  private readonly client: OpenAI;
  readonly model: string;

  constructor(
    options: { apiKey: string; model: string; client?: OpenAI },
    private readonly prices = { inputPerMTok: 1.25, outputPerMTok: 10, perSearch: 0.01 },
  ) {
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey, maxRetries: 2 });
    this.model = options.model;
  }

  estimateCostCents(): number {
    return Math.ceil(
      cents(
        (12_000 * this.prices.inputPerMTok + 1_500 * this.prices.outputPerMTok) / 1e6 +
          3 * this.prices.perSearch,
      ),
    );
  }

  async ask(question: string, options: { location?: Location } = {}): Promise<VisibilityAnswer> {
    const loc = options.location;
    const response = await this.client.responses
      .create({
        model: this.model,
        instructions: VISIBILITY_SYSTEM_PROMPT,
        input: question,
        tools: [
          {
            type: 'web_search',
            ...(loc && (loc.city || loc.country)
              ? {
                  user_location: {
                    type: 'approximate',
                    city: loc.city,
                    region: loc.region,
                    country: loc.country,
                  },
                }
              : {}),
          },
        ],
      })
      .catch((error: unknown) => {
        if (error instanceof OpenAI.APIError)
          throw new UpstreamError('openai', `OpenAI request failed (${error.status ?? 'network'})`);
        throw error;
      });
    const citations = new Map<string, string | null>();
    let searches = 0;
    for (const item of response.output) {
      if (item.type === 'web_search_call') searches++;
      if (item.type !== 'message') continue;
      for (const part of item.content) {
        if (part.type !== 'output_text') continue;
        for (const a of part.annotations)
          if (a.type === 'url_citation') citations.set(a.url, a.title ?? null);
      }
    }
    const usage = response.usage;
    return {
      text: response.output_text,
      citations: [...citations.entries()].map(([url, title]) => ({ url, title })),
      model: response.model ?? this.model,
      costCents: cents(
        ((usage?.input_tokens ?? 0) * this.prices.inputPerMTok +
          (usage?.output_tokens ?? 0) * this.prices.outputPerMTok) /
          1e6 +
          searches * this.prices.perSearch,
      ),
      searches,
    };
  }
}

/** Minimal surface of @google/genai used here (injectable in tests). */
export interface GeminiModels {
  generateContent(params: {
    model: string;
    contents: string;
    config: { systemInstruction: string; tools: { googleSearch: Record<string, never> }[] };
  }): Promise<{
    text?: string;
    candidates?: {
      groundingMetadata?: {
        groundingChunks?: { web?: { uri?: string; title?: string } }[];
        webSearchQueries?: string[];
      };
    }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      toolUsePromptTokenCount?: number;
    };
    modelVersion?: string;
  }>;
}

/** Gemini with Google Search grounding. Costs use configurable rates (SETUP-NEEDED). */
export class GeminiVisibilityProvider implements VisibilityProvider {
  readonly id = 'gemini' as const;
  readonly label = 'Gemini';
  readonly simulated = false;
  private readonly models: GeminiModels;
  readonly model: string;

  constructor(
    options: { apiKey: string; model: string; models?: GeminiModels },
    private readonly prices = { inputPerMTok: 0.5, outputPerMTok: 3, perGroundedPrompt: 0.035 },
  ) {
    this.models =
      options.models ?? (new GoogleGenAI({ apiKey: options.apiKey }).models as unknown as GeminiModels);
    this.model = options.model;
  }

  estimateCostCents(): number {
    return Math.ceil(
      cents(
        (12_000 * this.prices.inputPerMTok + 1_500 * this.prices.outputPerMTok) / 1e6 +
          this.prices.perGroundedPrompt,
      ),
    );
  }

  async ask(question: string): Promise<VisibilityAnswer> {
    const response = await this.models
      .generateContent({
        model: this.model,
        contents: question,
        config: { systemInstruction: VISIBILITY_SYSTEM_PROMPT, tools: [{ googleSearch: {} }] },
      })
      .catch((error: unknown) => {
        throw new UpstreamError(
          'gemini',
          `Gemini request failed: ${error instanceof Error ? error.message.slice(0, 120) : 'error'}`,
        );
      });
    const grounding = response.candidates?.[0]?.groundingMetadata;
    const citations = (grounding?.groundingChunks ?? [])
      .map((c) => c.web)
      .filter((w): w is { uri?: string; title?: string } => !!w?.uri)
      .map((w) => {
        // Grounding URIs are redirect links; the title carries the source's domain.
        const isRedirect = /grounding-api-redirect|vertexaisearch/.test(w.uri ?? '');
        const domainTitle = w.title && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(w.title) ? w.title : null;
        return {
          url: isRedirect && domainTitle ? `https://${domainTitle}/` : w.uri!,
          title: w.title ?? null,
        };
      });
    const usage = response.usageMetadata;
    const inputTokens = (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0);
    return {
      text: response.text ?? '',
      citations,
      model: response.modelVersion ?? this.model,
      costCents: cents(
        (inputTokens * this.prices.inputPerMTok +
          (usage?.candidatesTokenCount ?? 0) * this.prices.outputPerMTok) /
          1e6 +
          (grounding ? this.prices.perGroundedPrompt : 0),
      ),
      searches: grounding?.webSearchQueries?.length ?? 0,
    };
  }
}

/** Perplexity Sonar (search is built in). The API reports the exact request cost. */
export class PerplexityVisibilityProvider implements VisibilityProvider {
  readonly id = 'perplexity' as const;
  readonly label = 'Perplexity';
  readonly simulated = false;
  private readonly client: Perplexity;
  readonly model: string;

  constructor(options: { apiKey: string; model: string; client?: Perplexity }) {
    this.client = options.client ?? new Perplexity({ apiKey: options.apiKey, maxRetries: 2 });
    this.model = options.model;
  }

  estimateCostCents(): number {
    return 2;
  }

  async ask(question: string, options: { location?: Location } = {}): Promise<VisibilityAnswer> {
    const loc = options.location;
    const response = await this.client.chat.completions
      .create({
        model: this.model,
        messages: [
          { role: 'system', content: VISIBILITY_SYSTEM_PROMPT },
          { role: 'user', content: question },
        ],
        ...(loc?.country
          ? { web_search_options: { user_location: { country: loc.country, city: loc.city } } }
          : {}),
      })
      .catch((error: unknown) => {
        if (error instanceof Perplexity.APIError) {
          throw new UpstreamError('perplexity', `Perplexity request failed (${error.status ?? 'network'})`);
        }
        throw error;
      });
    const content = response.choices[0]?.message.content;
    const text =
      typeof content === 'string'
        ? content
        : (content ?? []).map((c) => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('');
    const results = response.search_results ?? [];
    const citations =
      results.length > 0
        ? results.map((r) => ({ url: r.url, title: r.title ?? null }))
        : (response.citations ?? []).map((url) => ({ url, title: null }));
    return {
      text,
      citations,
      model: response.model ?? this.model,
      costCents: cents(response.usage?.cost?.total_cost ?? 0.02),
      searches: response.usage?.num_search_queries ?? 1,
    };
  }
}

/**
 * Local development and demos without API keys: deterministic, plausible answers that mention
 * some of the hotels it is told about (published hotels in the same city) plus fictional ones.
 * Results are labelled as simulated everywhere they appear.
 */
export class SimulatedVisibilityProvider implements VisibilityProvider {
  readonly simulated = true;
  readonly label: string;
  readonly model = 'simulated';

  constructor(
    readonly id: VisibilityProvider['id'],
    private readonly knownHotels: (question: string) => Promise<{ name: string; website: string | null }[]>,
  ) {
    this.label = `${{ anthropic: 'Claude', openai: 'ChatGPT', gemini: 'Gemini', perplexity: 'Perplexity', simulated: 'Assistant' }[id]} (simulated)`;
  }

  estimateCostCents(): number {
    return 0;
  }

  async ask(question: string): Promise<VisibilityAnswer> {
    const seed = createHash('sha256').update(`${this.id}:${question}`).digest();
    const city = /\bin ([\p{L} -]+?)(?: for|$)/u.exec(question)?.[1]?.trim() ?? 'town';
    const fictional = [
      `Hotel ${city} Plaza`,
      `The Grand ${city}`,
      `${city} Garden Suites`,
      `Pension Central ${city}`,
    ];
    const real = await this.knownHotels(question);
    const pool = [...fictional];
    // Each real hotel appears for roughly 60% of (provider, question) pairs, at a stable position.
    real.forEach((h, i) => {
      if (seed[i]! % 10 < 6) pool.splice(seed[i + 4]! % (pool.length + 1), 0, h.name);
    });
    const list = pool.slice(0, 4);
    const text = `Here are some well-reviewed options:\n\n${list
      .map(
        (name, i) =>
          `${i + 1}. **${name}** – ${['great location', 'excellent reviews', 'stylish rooms', 'friendly staff'][(seed[10]! + i) % 4]}.`,
      )
      .join('\n')}\n\nPrices vary by season; book directly for the best rate.`;
    const citations = real
      .filter((h, i) => h.website && list.includes(h.name) && seed[12 + i]! % 2 === 0)
      .map((h) => ({ url: h.website!, title: h.name }));
    citations.push({ url: 'https://www.tripadvisor.example/hotels', title: 'Traveller reviews' });
    return { text, citations, model: this.model, costCents: 0, searches: 1 };
  }
}
