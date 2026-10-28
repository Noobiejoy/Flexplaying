import {
  AiError,
  emptyUsage,
  type AiProvider,
  type AiUsage,
  type Citation,
  type CompleteRequest,
  type GeneratedImage,
  type ImageRequest,
  type ImageResult,
  type ModelInfo,
  type ResearchRequest,
  type TextResult,
} from "./types";

/**
 * OpenRouter gateway client restricted to Google models served by Google's own
 * infrastructure (provider.only = google-vertex/google-ai-studio, no fallbacks).
 * Uses fetch directly so there is no extra SDK surface.
 */
export interface OpenRouterConfig {
  apiKey: string;
  baseUrl: string;
  providerOnly: string[];
  webSearchMode: "server_tool" | "plugin";
  webMaxResults: number;
  appUrl?: string;
  appName?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function assertGoogleModel(model: string) {
  if (!/^google\//.test(model)) {
    throw new AiError("bad_request", `Refusing non-Google model "${model}"`);
  }
}

type Json = Record<string, unknown>;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * With BYOK (your own Google key attached in OpenRouter) OpenRouter reports its
 * own fee in `cost` (often 0) and what the provider billed your key in
 * `cost_details.upstream_inference_cost`. The real spend is the sum.
 */
export function reportedCost(u: Json): number | null {
  const own = num(u.cost);
  const upstream = num(((u.cost_details ?? {}) as Json).upstream_inference_cost);
  if (u.is_byok === true) return own === null && upstream === null ? null : (own ?? 0) + (upstream ?? 0);
  return own;
}

export function parseUsage(model: string, body: Json): AiUsage {
  const u = (body.usage ?? {}) as Json;
  const ptd = (u.prompt_tokens_details ?? {}) as Json;
  const ctd = (u.completion_tokens_details ?? {}) as Json;
  const stu = (u.server_tool_use ?? {}) as Json;
  const stuDetails = (u.server_tool_use_details ?? {}) as Json;
  return {
    ...emptyUsage(typeof body.model === "string" ? body.model : model),
    generationId: typeof body.id === "string" ? body.id : null,
    inputTokens: num(u.prompt_tokens),
    outputTokens: num(u.completion_tokens),
    reasoningTokens: num(ctd.reasoning_tokens),
    cachedTokens: num(ptd.cached_tokens),
    webSearches: num(stuDetails.web_search_requests) ?? num(stu.web_search_requests) ?? num(u.web_search_requests),
    images: null,
    costUsd: reportedCost(u),
    raw: u,
  };
}

function messageText(message: Json | undefined): string {
  if (!message) return "";
  const c = message.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && typeof p === "object" && typeof (p as Json).text === "string" ? ((p as Json).text as string) : ""))
      .join("");
  }
  return "";
}

/** Accepts both the nested ({url_citation:{...}}) and flat annotation shapes. */
export function parseCitations(message: Json | undefined): Citation[] {
  const anns = (message?.annotations ?? []) as unknown[];
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const a of Array.isArray(anns) ? anns : []) {
    if (!a || typeof a !== "object") continue;
    const ann = a as Json;
    if (ann.type !== "url_citation") continue;
    const c = (ann.url_citation && typeof ann.url_citation === "object" ? ann.url_citation : ann) as Json;
    const url = typeof c.url === "string" ? c.url : null;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const key = `${url}|${num(c.start_index)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url,
      title: typeof c.title === "string" ? c.title : null,
      snippet: typeof c.content === "string" ? c.content.slice(0, 1000) : null,
      startIndex: num(c.start_index),
      endIndex: num(c.end_index),
    });
  }
  return out;
}

export function parseImages(message: Json | undefined): GeneratedImage[] {
  const imgs = (message?.images ?? []) as unknown[];
  const out: GeneratedImage[] = [];
  for (const i of Array.isArray(imgs) ? imgs : []) {
    if (!i || typeof i !== "object") continue;
    const iu = (i as Json).image_url as Json | undefined;
    const url = typeof iu?.url === "string" ? iu.url : typeof (i as Json).url === "string" ? ((i as Json).url as string) : null;
    if (!url) continue;
    const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(url);
    if (!m) continue;
    out.push({ mimeType: m[1]!.toLowerCase(), data: Buffer.from(m[2]!, "base64") });
  }
  return out;
}

export class OpenRouterProvider implements AiProvider {
  readonly name = "openrouter";
  private modelsCache: { at: number; models: ModelInfo[] } | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly cfg: OpenRouterConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.sleep = cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      "Content-Type": "application/json",
    };
    if (this.cfg.appUrl) h["HTTP-Referer"] = this.cfg.appUrl;
    if (this.cfg.appName) h["X-Title"] = this.cfg.appName;
    return h;
  }

  private baseBody(model: string): Json {
    assertGoogleModel(model);
    return {
      model,
      provider: { only: this.cfg.providerOnly, allow_fallbacks: false },
      usage: { include: true },
    };
  }

  /** POST with bounded retries on 429/5xx/timeouts (max 3 retries, exponential backoff). */
  private async post(path: string, body: Json, model: string): Promise<{ json: Json; latencyMs: number }> {
    const maxRetries = this.cfg.maxRetries ?? 3;
    let lastErr: AiError | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 250));
      const started = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 120_000);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        lastErr = new AiError("timeout", `OpenRouter request failed: ${(e as Error).name}`);
        continue;
      }
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      let json: Json = {};
      try {
        json = (await res.json()) as Json;
      } catch {
        json = {};
      }
      const errMsg = (() => {
        const e = json.error as Json | undefined;
        return typeof e?.message === "string" ? e.message.slice(0, 300) : `HTTP ${res.status}`;
      })();
      if (res.ok && !json.error) return { json, latencyMs };
      const status = res.ok ? num((json.error as Json)?.code) ?? 500 : res.status;
      if (status === 401 || status === 403) throw new AiError("auth", `OpenRouter rejected the API key (${status})`, status);
      if (status === 402) throw new AiError("credits", "OpenRouter account is out of credits (402)", status);
      if (status === 404) throw new AiError("model_unavailable", `Model ${model} unavailable: ${errMsg}`, status);
      if (status === 400 || status === 422) throw new AiError("bad_request", `OpenRouter bad request: ${errMsg}`, status);
      if (status === 429) lastErr = new AiError("rate_limit", "OpenRouter rate limit (429)", status);
      else lastErr = new AiError("server", `OpenRouter/provider error ${status}: ${errMsg}`, status);
    }
    throw lastErr ?? new AiError("server", "OpenRouter request failed");
  }

  async research(req: ResearchRequest): Promise<TextResult> {
    const body: Json = {
      ...this.baseBody(req.model),
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      temperature: 0.2,
    };
    const maxResults = req.maxResults ?? this.cfg.webMaxResults;
    if (this.cfg.webSearchMode === "server_tool") {
      body.tools = [{ type: "openrouter:web_search", parameters: { max_results: maxResults } }];
    } else {
      body.plugins = [{ id: "web", max_results: maxResults }];
    }
    const { json, latencyMs } = await this.post("/chat/completions", body, req.model);
    const message = ((json.choices as Json[] | undefined)?.[0]?.message ?? undefined) as Json | undefined;
    const text = messageText(message);
    const usage = parseUsage(req.model, json);
    if (!text.trim()) throw new AiError("empty_response", "Model returned no research text", undefined, usage);
    return { text, citations: parseCitations(message), usage, latencyMs };
  }

  async complete(req: CompleteRequest): Promise<TextResult> {
    const body: Json = {
      ...this.baseBody(req.model),
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      temperature: req.temperature ?? 0.4,
    };
    if (req.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema },
      };
    }
    const { json, latencyMs } = await this.post("/chat/completions", body, req.model);
    const message = ((json.choices as Json[] | undefined)?.[0]?.message ?? undefined) as Json | undefined;
    const text = messageText(message);
    const usage = parseUsage(req.model, json);
    if (!text.trim()) throw new AiError("empty_response", "Model returned an empty completion", undefined, usage);
    return { text, citations: parseCitations(message), usage, latencyMs };
  }

  async generateImage(req: ImageRequest): Promise<ImageResult> {
    const body: Json = {
      ...this.baseBody(req.model),
      messages: [{ role: "user", content: req.prompt }],
      modalities: ["image", "text"],
      image_config: { aspect_ratio: req.aspectRatio },
    };
    const { json, latencyMs } = await this.post("/chat/completions", body, req.model);
    const message = ((json.choices as Json[] | undefined)?.[0]?.message ?? undefined) as Json | undefined;
    const images = parseImages(message);
    const usage = { ...parseUsage(req.model, json), images: images.length };
    if (images.length === 0) throw new AiError("empty_response", "Image model returned no image", undefined, usage);
    return { images, text: messageText(message), usage, latencyMs };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < 10 * 60_000) return this.modelsCache.models;
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) throw new AiError(res.status === 401 ? "auth" : "server", `Model list failed (${res.status})`, res.status);
    const json = (await res.json()) as { data?: Json[] };
    const models: ModelInfo[] = (json.data ?? [])
      .filter((m) => typeof m.id === "string" && (m.id as string).startsWith("google/"))
      .map((m) => {
        const arch = (m.architecture ?? {}) as Json;
        return {
          id: m.id as string,
          name: typeof m.name === "string" ? m.name : (m.id as string),
          inputModalities: Array.isArray(arch.input_modalities) ? (arch.input_modalities as string[]) : [],
          outputModalities: Array.isArray(arch.output_modalities) ? (arch.output_modalities as string[]) : [],
          supportedParameters: Array.isArray(m.supported_parameters) ? (m.supported_parameters as string[]) : [],
          pricing: (m.pricing ?? {}) as Record<string, string>,
        };
      });
    this.modelsCache = { at: Date.now(), models };
    return models;
  }
}

/**
 * Confirms a model exists on OpenRouter and supports the needed output. Never
 * silently substitutes another model: callers surface the error instead.
 */
export async function verifyModel(provider: AiProvider, model: string, needs: "text" | "image"): Promise<ModelInfo> {
  assertGoogleModel(model);
  const models = await provider.listModels();
  const found = models.find((m) => m.id === model);
  if (!found) {
    const alternatives = models
      .filter((m) => m.outputModalities.includes(needs))
      .map((m) => m.id)
      .slice(0, 6)
      .join(", ");
    throw new AiError("model_unavailable", `Model ${model} is not listed by OpenRouter. Available ${needs} models include: ${alternatives || "none"}`);
  }
  if (found.outputModalities.length > 0 && !found.outputModalities.includes(needs)) {
    throw new AiError("model_unavailable", `Model ${model} does not produce ${needs} output`);
  }
  return found;
}
