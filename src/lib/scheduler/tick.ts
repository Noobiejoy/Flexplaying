import { evaluateSlots } from "@/lib/schedule/slots";
import { processRun, type ProcessResult } from "@/lib/pipeline/engine";
import type { PipelineDeps } from "@/lib/pipeline/context";

export interface TickResult {
  created: number;
  missed: number;
  processed: ProcessResult[];
  workspaces: number;
}

/**
 * One scheduler tick: materialise due/missed slots (idempotent via the unique
 * slot key), then advance runnable runs within the time budget, at most one
 * run per workspace per tick.
 */
export async function runTick(deps: PipelineDeps, opts: { owner: string; budgetMs: number }): Promise<TickResult> {
  const started = Date.now();
  const now = deps.now();
  let created = 0;
  let missed = 0;
  const workspaces = await deps.store.listAutomatedWorkspaces();
  for (const ws of workspaces) {
    const { due, missed: missedSlots } = evaluateSlots({
      now,
      timeZone: ws.timezone,
      localTimes: ws.localTimes,
      graceMinutes: ws.graceMinutes,
      notBefore: new Date(ws.automationChangedAt),
    });
    for (const slot of due) {
      const run = await deps.store.createRun({ workspace_id: ws.workspaceId, trigger: "schedule", slot_key: slot.slotKey, scheduled_for: slot.scheduledFor.toISOString(), status: "queued", publishing_mode: ws.publishingMode, triggered_by: null });
      if (run) created++;
    }
    for (const slot of missedSlots) {
      const run = await deps.store.createRun({
        workspace_id: ws.workspaceId,
        trigger: "schedule",
        slot_key: slot.slotKey,
        scheduled_for: slot.scheduledFor.toISOString(),
        status: "missed",
        publishing_mode: ws.publishingMode,
        triggered_by: null,
        outcome_reason: `Scheduler did not run within ${ws.graceMinutes} minutes of the ${slot.localTime} slot`,
      });
      if (run) {
        missed++;
        await deps.store.notify(ws.workspaceId, run.id, "warning", `Missed ${slot.localTime} run`, `No scheduler tick arrived within ${ws.graceMinutes} minutes of the slot. Check the Supabase Cron job and the app URL.`);
      }
    }
  }

  const processed: ProcessResult[] = [];
  const seen = new Set<string>();
  const runnable = await deps.store.listRunnableRuns(now, 20);
  for (const run of runnable) {
    if (seen.has(run.workspace_id)) continue;
    const remaining = opts.budgetMs - (Date.now() - started);
    if (remaining < 20_000) break;
    seen.add(run.workspace_id);
    processed.push(await processRun(deps, run.id, { owner: opts.owner, budgetMs: remaining - 15_000 }));
  }
  return { created, missed, processed, workspaces: workspaces.length };
}
