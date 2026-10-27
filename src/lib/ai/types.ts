export interface AiUsage {
  model: string;
  generationId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  webSearches: number | null;
  images: number | null;
  /** Provider-reported cost in USD (OpenRouter credits), or null when not reported. */
  costUsd: number | null;
  raw: Record<string, unknown>;
}

export interface Citation {
  url: string;
  title: string | null;
  snippet: string | null;
  startIndex: number | null;
  endIndex: number | null;
}

export interface TextResult {
  text: string;
  citations: Citation[];
  usage: AiUsage;
  latencyMs: number;
}

export interface GeneratedImage {
  mimeType: string;
  data: Buffer;
}

export interface ImageResult {
  images: GeneratedImage[];
  text: string;
  usage: AiUsage;
  latencyMs: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  pricing: Record<string, string>;
}

export interface ResearchRequest {
  model: string;
  system: string;
  prompt: string;
  maxResults?: number;
}

export interface CompleteRequest {
  model: string;
  system: string;
  prompt: string;
  temperature?: number;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

export interface ImageRequest {
  model: string;
  prompt: string;
  aspectRatio: "16:9" | "1:1" | "4:3";
}

export interface AiProvider {
  readonly name: string;
  research(req: ResearchRequest): Promise<TextResult>;
  complete(req: CompleteRequest): Promise<TextResult>;
  generateImage(req: ImageRequest): Promise<ImageResult>;
  listModels(): Promise<ModelInfo[]>;
}

export type AiErrorKind =
  | "not_configured"
  | "auth"
  | "credits"
  | "rate_limit"
  | "server"
  | "timeout"
  | "bad_request"
  | "model_unavailable"
  | "empty_response"
  | "parse";

const TRANSIENT: AiErrorKind[] = ["rate_limit", "server", "timeout", "empty_response"];

export class AiError extends Error {
  readonly transient: boolean;
  constructor(
    public readonly kind: AiErrorKind,
    message: string,
    public readonly status?: number,
    public readonly usage?: AiUsage,
  ) {
    super(message);
    this.name = "AiError";
    this.transient = TRANSIENT.includes(kind);
  }
}

export function emptyUsage(model: string): AiUsage {
  return {
    model,
    generationId: null,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedTokens: null,
    webSearches: null,
    images: null,
    costUsd: null,
    raw: {},
  };
}
