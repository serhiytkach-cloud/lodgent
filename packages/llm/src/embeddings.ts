import { EMBEDDING_DIMENSIONS, type EmbeddingModel, UpstreamError } from '@lodgent/core';
import OpenAI from 'openai';

const STOPWORDS = new Set(
  'a an and are as at be by for from has have in is it its of on or our the their this to was we with you your all also can more very into over just than'.split(
    ' ',
  ),
);

function tokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));
}

function fnv1a(value: string, seed = 0x811c9dc5): number {
  let hash = seed;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic offline embeddings (feature hashing of unigrams and bigrams, L2-normalized).
 * Used locally and in tests so search works without an embeddings API key. Real deployments
 * should set EMBEDDINGS_PROVIDER=openai or voyage.
 */
export class LocalHashEmbedding implements EmbeddingModel {
  readonly name = 'local-hash-v1';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      const words = tokens(text);
      const features = [...words, ...words.slice(1).map((w, i) => `${words[i]}_${w}`)];
      const counts = new Map<string, number>();
      for (const f of features) counts.set(f, (counts.get(f) ?? 0) + 1);
      for (const [feature, count] of counts) {
        const h = fnv1a(feature);
        const sign = fnv1a(feature, 0x9747b28c) & 1 ? 1 : -1;
        const weight = (1 + Math.log(count)) * (feature.includes('_') ? 0.6 : 1);
        vector[h % this.dimensions]! += sign * weight;
      }
      const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
      return vector.map((v) => v / norm);
    });
  }
}

/** OpenAI text-embedding-3-small, shortened to our stored dimension via the `dimensions` parameter. */
export class OpenAIEmbedding implements EmbeddingModel {
  readonly name = 'openai/text-embedding-3-small';
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      const result = await this.client.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts,
        dimensions: this.dimensions,
      });
      return result.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (error) {
      throw new UpstreamError('openai', 'Embedding request failed', { cause: String(error) });
    }
  }
}

/** Voyage AI embeddings (Anthropic's recommended embeddings provider) at our stored dimension. */
export class VoyageEmbedding implements EmbeddingModel {
  readonly name = 'voyage/voyage-3.5';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]> {
    const res = await this.fetchImpl('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: 'voyage-3.5',
        input: texts,
        input_type: purpose,
        output_dimension: this.dimensions,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new UpstreamError('voyage', `Voyage embeddings returned ${res.status}`);
    const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
