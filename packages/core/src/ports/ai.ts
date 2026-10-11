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
