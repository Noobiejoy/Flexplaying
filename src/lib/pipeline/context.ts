import { AiError, type AiProvider, type AiUsage } from "@/lib/ai/types";
import { verifyModel } from "@/lib/ai/openrouter";
import { costFor } from "@/lib/costs/pricing";
import type { DomainRegistry } from "@/lib/editorial/domains";
import type { ComposedImage } from "@/lib/image/compose";
import type { WordPressApi } from "@/lib/wordpress/types";
import type { PageFetcher } from "./source-verify";
import type { PipelineStore, RunRecord, RunStatus, StageLogInput, UsageEventInput, WorkspaceContext } from "./types";

export interface PipelineDeps {
  store: PipelineStore;
  ai: AiProvider;
  /** Builds an authenticated WordPress client for the workspace, or null when not connected. */
  wordpress: (ctx: WorkspaceContext) => Promise<WordPressApi | null>;
  domains: DomainRegistry;
  fetchPage: PageFetcher;
  composeImage: (source: Buffer, opts: { overlayText?: string | null; label?: string | null }) => Promise<ComposedImage>;
  now: () => Date;
  models: { text: string; research: string; image: string };
  siteName: string;
}

export interface StageResult {
  next: RunStatus;
  patch?: Partial<RunRecord>;
  message: string;
  detail?: Record<string, unknown>;
}

export class StageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly transient: boolean,
  ) {
    super(message);
    this.name = "StageError";
  }
}

export interface StageContext {
  deps: PipelineDeps;
  run: RunRecord;
  ws: WorkspaceContext;
  stage: string;
  attempt: number;
  models: { text: string; research: string; image: string };
  log(level: StageLogInput["level"], message: string, detail?: Record<string, unknown>): Promise<void>;
  tracked<T extends { usage: AiUsage; latencyMs: number }>(
    action: UsageEventInput["action"],
    model: string,
    articleId: string | null,
    fn: () => Promise<T>,
  ): Promise<T>;
  ensureModel(model: string, needs: "text" | "image"): Promise<void>;
  wp(): Promise<WordPressApi>;
}

export function createStageContext(deps: PipelineDeps, run: RunRecord, ws: WorkspaceContext, stage: string): StageContext {
  const models = {
    text: ws.settings.text_model ?? deps.models.text,
    research: ws.settings.research_model ?? deps.models.research,
    image: ws.settings.image_model ?? deps.models.image,
  };
  const attempt = run.stage_attempt + 1;
  const verified = new Set<string>();
  let wpClient: WordPressApi | null = null;

  const record = async (action: UsageEventInput["action"], articleId: string | null, usage: AiUsage, success: boolean, latencyMs: number | null) => {
    const pricing = await deps.store.getPricing(ws.workspaceId, usage.model);
    const cost = costFor(usage, pricing);
    await deps.store.recordUsage({
      workspace_id: ws.workspaceId,
      run_id: run.id,
      article_id: articleId,
      stage,
      action,
      model: usage.model,
      generation_id: usage.generationId,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      reasoning_tokens: usage.reasoningTokens,
      cached_tokens: usage.cachedTokens,
      web_searches: usage.webSearches,
      images: usage.images,
      cost_usd: cost.costUsd,
      cost_source: cost.source,
      pricing_id: cost.pricingId,
      success,
      is_retry: attempt > 1,
      latency_ms: latencyMs,
      raw_usage: usage.raw,
    });
  };

  return {
    deps,
    run,
    ws,
    stage,
    attempt,
    models,
    async log(level, message, detail = {}) {
      await deps.store.log({ run_id: run.id, workspace_id: ws.workspaceId, stage, attempt, level, message, detail });
    },
    async tracked(action, model, articleId, fn) {
      const started = Date.now();
      try {
        const res = await fn();
        await record(action, articleId, res.usage, true, res.latencyMs);
        return res;
      } catch (e) {
        const usage = e instanceof AiError && e.usage ? e.usage : { model, generationId: null, inputTokens: null, outputTokens: null, reasoningTokens: null, cachedTokens: null, webSearches: null, images: null, costUsd: null, raw: {} };
        await record(action, articleId, usage, false, Date.now() - started);
        throw e;
      }
    },
    async ensureModel(model, needs) {
      if (verified.has(model)) return;
      await verifyModel(deps.ai, model, needs);
      verified.add(model);
    },
    async wp() {
      if (wpClient) return wpClient;
      const c = await deps.wordpress(ws);
      if (!c) throw new StageError("wordpress_not_connected", "WordPress is not connected for this workspace", false);
      wpClient = c;
      return c;
    },
  };
}
