/** A crawled web page reduced to readable text. */
export interface PageContent {
  url: string;
  title: string | null;
  text: string;
}

export interface ExtractionTarget {
  code: string;
  label: string;
  valueType: 'boolean' | 'enum' | 'number' | 'text';
  enumValues: string[] | null;
  appliesTo: 'property' | 'room' | 'both';
}

export interface ExtractedAttribute {
  code: string;
  value: boolean | number | string;
  confidence: number;
  /** Verbatim quote from the page that supports the value. */
  evidence: { url: string; snippet: string };
  /** For room-level attributes: the room type it applies to, by name. */
  roomTypeName: string | null;
}

export interface ExtractionResult {
  attributes: ExtractedAttribute[];
  propertyDescription: { text: string; evidenceUrl: string } | null;
  roomDescriptions: { roomTypeName: string; text: string; evidenceUrl: string }[];
  model: string;
}

/** Turns website text into attribute suggestions. Claude in production, a keyword matcher offline. */
export interface ExtractionModel {
  readonly name: string;
  /** Source recorded on the suggestions this model produces. */
  readonly source: 'ai_extracted' | 'website';
  extract(input: {
    hotelName: string;
    pages: PageContent[];
    roomTypes: { name: string; description: string | null }[];
    attributes: ExtractionTarget[];
  }): Promise<ExtractionResult>;
}

/** Text embeddings for natural-language matching (pgvector). */
export interface EmbeddingModel {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[], purpose: 'document' | 'query'): Promise<number[][]>;
}

/** Fixed embedding size stored in Postgres (vector(512)). Providers are asked for this dimension. */
export const EMBEDDING_DIMENSIONS = 512;

/** An AI assistant's answer to a traveller's question, with the web sources it cited. */
export interface VisibilityAnswer {
  text: string;
  citations: { url: string; title: string | null }[];
  model: string;
  /** What the call cost, in US cents (exact where the provider reports it, otherwise computed from usage). */
  costCents: number;
  searches: number;
}

export type VisibilityProviderId = 'anthropic' | 'openai' | 'gemini' | 'perplexity' | 'simulated';

/** One assistant whose answers we monitor (in its web-search mode). */
export interface VisibilityProvider {
  readonly id: VisibilityProviderId;
  readonly label: string;
  readonly model: string;
  /** Demo data, not a real assistant. */
  readonly simulated: boolean;
  /** Upper-bound cost of one question, in US cents, checked against the monthly cap before calling. */
  estimateCostCents(): number;
  ask(
    question: string,
    options?: { location?: { city: string | null; region: string | null; country: string | null } },
  ): Promise<VisibilityAnswer>;
}
