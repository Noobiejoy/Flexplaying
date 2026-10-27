import { AiError } from "@/lib/ai/types";
import { WpError } from "@/lib/wordpress/types";
import { createStageContext, StageError, type PipelineDeps, type StageContext, type StageResult } from "./context";
import { dedupeStage } from "./stages/dedupe";
import { factCheckStage } from "./stages/factcheck";
import { imageStage } from "./stages/image";
import { publishStage } from "./stages/publish";
import { qualityStage } from "./stages/quality";
import { researchStage } from "./stages/research";
import { writeStage } from "./stages/write";
import { isTerminal, type RunRecord, type StageStatus } from "./types";

export const MAX_STAGE_ATTEMPTS = 3;
/** Backoff before retry n (1-based): 2 min, 8 min, 20 min. */
export const RETRY_BACKOFF_MS = [120_000, 480_000, 1_200_000];
export const LEASE_SECONDS = 330;

const HANDLERS: Record<Exclude<StageStatus, "queued">, (sc: StageContext) => Promise<StageResult>> = {
  researching: researchStage,
  deduplicating: dedupeStage,
  fact_checking: factCheckStage,
  writing: writeStage,
  quality_check: qualityStage,
  generating_image: imageStage,
  publishing: publishStage,
};

export interface ClassifiedError {
  code: string;
  message: string;
  transient: boolean;
}

export function classifyError(e: unknown): ClassifiedError {
  if (e instanceof StageError) return { code: e.code, message: e.message, transient: e.transient };
  if (e instanceof AiError) {
    // Malformed model output is worth a bounded retry; credits/auth/model problems are not.
    return { code: `ai_${e.kind}`, message: e.message, transient: e.transient || e.kind === "parse" };
  }
  if (e instanceof WpError) return { code: `wp_${e.kind}`, message: e.message, transient: e.transient };
  const msg = e instanceof Error ? e.message : String(e);
  if (/Missing required configuration/.test(msg)) return { code: "config", message: msg, transient: false };
  return { code: "internal", message: msg.slice(0, 500), transient: true };
}

export interface ProcessResult {
  runId: string;
  status: string;
  stagesRun: number;
  claimed: boolean;
}

/**
 * Advance a run through as many stages as fit in the time budget. Each stage's
 * outcome is persisted before the next starts, so an interrupted request (or a
 * crashed function) resumes from the last completed stage on the next tick.
 */
export async function processRun(deps: PipelineDeps, runId: string, opts: { owner: string; budgetMs: number }): Promise<ProcessResult> {
  const startedAt = Date.now();
  const { store } = deps;
  if (!(await store.claimRun(runId, opts.owner, LEASE_SECONDS))) {
    return { runId, status: "locked", stagesRun: 0, claimed: false };
  }
  let stagesRun = 0;
  let last = "unknown";
  try {
    for (;;) {
      const run = await store.getRun(runId);
      if (!run) break;
      last = run.status;
      if (isTerminal(run.status)) break;
      const ws = await store.loadContext(run.workspace_id);
      const now = deps.now();

      if (run.status === "retry_scheduled") {
        if (run.next_attempt_at && new Date(run.next_attempt_at) > now) break;
        await store.updateRun(run.id, { status: run.resume_stage ?? "researching", next_attempt_at: null });
        continue;
      }
      if (run.status === "queued") {
        if (run.trigger === "schedule" && !ws.settings.automation_enabled) {
          await store.updateRun(run.id, { status: "cancelled", completed_at: now.toISOString(), outcome_reason: "Automation paused before the run started" });
          await store.log({ run_id: run.id, workspace_id: run.workspace_id, stage: "queued", attempt: 1, level: "skipped", message: "Cancelled: automation is paused" });
          last = "cancelled";
          break;
        }
        if (await store.hasOtherActiveRun(run.workspace_id, run.id)) break; // one active run per workspace
        await store.updateRun(run.id, { status: "researching", started_at: now.toISOString(), attempt: run.attempt + 1 });
        await store.log({ run_id: run.id, workspace_id: run.workspace_id, stage: "queued", attempt: 1, level: "info", message: `Run started (${run.trigger}, ${run.publishing_mode})` });
        continue;
      }
      if (Date.now() - startedAt > opts.budgetMs) break;

      const stage = run.status as Exclude<StageStatus, "queued">;
      const handler = HANDLERS[stage];
      const sc = createStageContext(deps, run, ws, stage);
      const t0 = Date.now();
      await sc.log("started", `Stage ${stage} started${sc.attempt > 1 ? ` (attempt ${sc.attempt})` : ""}`);
      stagesRun++;
      try {
        const result = await handler(sc);
        const done = isTerminal(result.next);
        const patch: Partial<RunRecord> = {
          ...result.patch,
          status: result.next,
          stage_attempt: 0,
          resume_stage: null,
          next_attempt_at: null,
          ...(result.next === "failed" ? {} : { error_code: null, error_message: null }),
          ...(done ? { completed_at: deps.now().toISOString() } : {}),
        };
        await store.updateRun(run.id, patch);
        await store.log({
          run_id: run.id,
          workspace_id: run.workspace_id,
          stage,
          attempt: sc.attempt,
          level: result.next === "failed" ? "failed" : "succeeded",
          message: result.message,
          detail: result.detail ?? {},
          finished_at: deps.now().toISOString(),
          duration_ms: Date.now() - t0,
        });
        last = result.next;
        if (result.next === "failed") await onFailure(deps, run, result.patch?.error_message ?? result.message);
        if (done) break;
        await store.claimRun(run.id, opts.owner, LEASE_SECONDS); // extend lease
      } catch (e) {
        const err = classifyError(e);
        const attempt = run.stage_attempt + 1;
        const canRetry = err.transient && attempt < MAX_STAGE_ATTEMPTS;
        if (canRetry) {
          const delay = RETRY_BACKOFF_MS[attempt - 1] ?? RETRY_BACKOFF_MS.at(-1)!;
          const nextAt = new Date(deps.now().getTime() + delay).toISOString();
          await store.updateRun(run.id, { status: "retry_scheduled", resume_stage: stage, stage_attempt: attempt, next_attempt_at: nextAt, error_code: err.code, error_message: err.message });
          await store.log({ run_id: run.id, workspace_id: run.workspace_id, stage, attempt, level: "failed", message: `${err.message} — retry ${attempt}/${MAX_STAGE_ATTEMPTS - 1} scheduled`, detail: { code: err.code, retry_at: nextAt }, finished_at: deps.now().toISOString(), duration_ms: Date.now() - t0 });
          last = "retry_scheduled";
        } else {
          await store.updateRun(run.id, { status: "failed", resume_stage: stage, stage_attempt: attempt, error_code: err.code, error_message: err.message, completed_at: deps.now().toISOString() });
          await store.log({ run_id: run.id, workspace_id: run.workspace_id, stage, attempt, level: "failed", message: `${err.message}${err.transient ? " (retries exhausted)" : ""}`, detail: { code: err.code }, finished_at: deps.now().toISOString(), duration_ms: Date.now() - t0 });
          await onFailure(deps, run, err.message);
          last = "failed";
        }
        break;
      }
    }
  } finally {
    await store.releaseRun(runId, opts.owner);
  }
  return { runId, status: last, stagesRun, claimed: true };
}

async function onFailure(deps: PipelineDeps, run: RunRecord, message: string) {
  if (run.article_id) {
    const a = await deps.store.getArticle(run.article_id);
    if (a && !["published", "drafted"].includes(a.status)) await deps.store.updateArticle(a.id, { status: "failed" });
  }
  const ctx = await deps.store.loadContext(run.workspace_id);
  if (ctx.settings.notify_on_failure) {
    await deps.store.notify(run.workspace_id, run.id, "error", "Editorial run failed", message.slice(0, 500));
  }
}

/**
 * Manual "retry from failed stage": re-queues the run at the stage that failed.
 * Never re-runs earlier completed stages.
 */
export async function retryFailedRun(deps: PipelineDeps, run: RunRecord): Promise<boolean> {
  if (run.status !== "failed" || !run.resume_stage) return false;
  await deps.store.updateRun(run.id, { status: "retry_scheduled", next_attempt_at: deps.now().toISOString(), stage_attempt: 0, completed_at: null, error_code: null, error_message: null });
  await deps.store.log({ run_id: run.id, workspace_id: run.workspace_id, stage: run.resume_stage, attempt: 1, level: "info", message: `Manual retry from stage ${run.resume_stage}` });
  return true;
}
