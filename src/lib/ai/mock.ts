import {
  emptyUsage,
  type AiProvider,
  type CompleteRequest,
  type ImageRequest,
  type ImageResult,
  type ModelInfo,
  type ResearchRequest,
  type TextResult,
} from "./types";

type Handler<Req, Res> = (req: Req, call: number) => Res | Promise<Res>;

/** Scriptable AI provider for tests (no network). */
export class MockAiProvider implements AiProvider {
  readonly name = "mock";
  calls: { kind: string; model: string; prompt: string }[] = [];
  private counters = { research: 0, complete: 0, image: 0 };

  constructor(
    private readonly handlers: {
      research?: Handler<ResearchRequest, TextResult>;
      complete?: Handler<CompleteRequest, TextResult>;
      image?: Handler<ImageRequest, ImageResult>;
      models?: ModelInfo[];
    } = {},
  ) {}

  async research(req: ResearchRequest) {
    this.calls.push({ kind: "research", model: req.model, prompt: req.prompt });
    if (!this.handlers.research) throw new Error("MockAiProvider: no research handler");
    return this.handlers.research(req, this.counters.research++);
  }

  async complete(req: CompleteRequest) {
    this.calls.push({ kind: "complete", model: req.model, prompt: req.prompt });
    if (!this.handlers.complete) throw new Error("MockAiProvider: no complete handler");
    return this.handlers.complete(req, this.counters.complete++);
  }

  async generateImage(req: ImageRequest) {
    this.calls.push({ kind: "image", model: req.model, prompt: req.prompt });
    if (!this.handlers.image) throw new Error("MockAiProvider: no image handler");
    return this.handlers.image(req, this.counters.image++);
  }

  async listModels(): Promise<ModelInfo[]> {
    return (
      this.handlers.models ?? [
        { id: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash", inputModalities: ["text"], outputModalities: ["text"], supportedParameters: ["tools", "response_format"], pricing: {} },
        { id: "google/gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image", inputModalities: ["text"], outputModalities: ["image", "text"], supportedParameters: [], pricing: {} },
      ]
    );
  }
}

export function mockText(text: string, opts: { model?: string; cost?: number | null; citations?: TextResult["citations"] } = {}): TextResult {
  const model = opts.model ?? "google/gemini-3.7-flash";
  return {
    text,
    citations: opts.citations ?? [],
    usage: { ...emptyUsage(model), inputTokens: 1000, outputTokens: 500, costUsd: opts.cost === undefined ? 0.002 : opts.cost },
    latencyMs: 5,
  };
}
