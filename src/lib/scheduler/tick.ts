import { evaluateSlots, type SlotInstance } from "@/lib/schedule/slots";
import { isWaitingTurn, processRun, type ProcessResult } from "@/lib/pipeline/engine";
import type { PipelineDeps } from "@/lib/pipeline/context";
import { slotTargets, targetSlotKey, topicActiveOn, type RunTarget } from "@/lib/pipeline/targets";
import { isTerminal, type AutomatedWorkspace } from "@/lib/pipeline/types";

export interface TickResult {
  created: number;
  missed: number;
  processed: ProcessResult[];
  workspaces: number;
}

/** Starting another run in the same tick needs room for at least one full stage. */
const MIN_BUDGET_FOR_NEXT_RUN_MS = 90_000;

type Planned = { slot: SlotInstance; target: RunTarget; key: string; missed: boolean };

/**
 * Runs to create for this tick. Each shared schedule slot gets one run per
 * enabled category, then one per active topic; topics with their own time get
 * their own slot. Slots that already ran the old way (a single run for all
 * categories, keyed by the bare slot) are left alone.
 */
function plan(ws: AutomatedWorkspace, now: Date): { planned: Planned[]; legacyKeys: string[] } {
  const planned: Planned[] = [];
  const legacyKeys: string[] = [];
  const shared = evaluateSlots({ now, timeZone: ws.timezone, localTimes: ws.localTimes, graceMinutes: ws.graceMinutes, notBefore: new Date(ws.automationChangedAt) });
  for (const [list, missed] of [[shared.due, false], [shared.missed, true]] as const) {
    for (const slot of list) {
      legacyKeys.push(slot.slotKey);
      const day = slot.slotKey.slice(0, 10);
      // A topic added after a slot it never had a chance to join is not "missed" there.
      for (const target of slotTargets(ws, day, missed ? slot.scheduledFor : undefined)) {
        planned.push({ slot, target, key: targetSlotKey(slot.slotKey, target), missed });
      }
    }
  }
  for (const t of ws.topics.filter((x) => x.local_time)) {
    const since = Math.max(Date.parse(ws.automationChangedAt), Date.parse(t.updated_at));
    const own = evaluateSlots({ now, timeZone: ws.timezone, localTimes: [t.local_time!], graceMinutes: ws.graceMinutes, notBefore: new Date(since) });
    for (const [list, missed] of [[own.due, false], [own.missed, true]] as const) {
      for (const slot of list) {
        if (!topicActiveOn(t, slot.slotKey.slice(0, 10))) continue;
        const target: RunTarget = { kind: "topic", topicId: t.id, category: t.category };
        planned.push({ slot, target, key: targetSlotKey(slot.slotKey, target), missed });
      }
    }
  }
  return { planned, legacyKeys };
}

/**
 * One scheduler tick: materialise due/missed runs (idempotent via the unique
 * slot key), then work through runnable runs within the time budget. Runs of
 * one workspace go one at a time, back to back.
 */
export async function runTick(deps: PipelineDeps, opts: { owner: string; budgetMs: number }): Promise<TickResult> {
  const started = Date.now();
  const now = deps.now();
  let created = 0;
  let missed = 0;
  const workspaces = await deps.store.listAutomatedWorkspaces();
  for (const ws of workspaces) {
    const { planned, legacyKeys } = plan(ws, now);
    if (planned.length === 0) continue;
    const existing = await deps.store.existingSlotKeys(ws.workspaceId, [...new Set([...legacyKeys, ...planned.map((p) => p.key)])]);
    const missedSlots = new Map<string, string>();
    for (const p of planned) {
      if (existing.has(p.key) || existing.has(p.slot.slotKey)) continue;
      const run = await deps.store.createRun({
        workspace_id: ws.workspaceId,
        trigger: "schedule",
        slot_key: p.key,
        scheduled_for: p.slot.scheduledFor.toISOString(),
        status: p.missed ? "missed" : "queued",
        publishing_mode: ws.publishingMode,
        triggered_by: null,
        category: p.target.category,
        topic_id: p.target.kind === "topic" ? p.target.topicId : null,
        ...(p.missed ? { outcome_reason: `Scheduler did not run within ${ws.graceMinutes} minutes of the ${p.slot.localTime} slot` } : {}),
      });
      if (!run) continue;
      if (p.missed) {
        missed++;
        missedSlots.set(p.slot.slotKey, p.slot.localTime);
      } else {
        created++;
      }
    }
    for (const [key, time] of missedSlots) {
      await deps.store.notify(ws.workspaceId, null, "warning", `Missed ${time} run`, `No scheduler tick arrived within ${ws.graceMinutes} minutes of the ${time} slot on ${key.slice(0, 10)}. Check the Supabase Cron job and the app URL.`);
    }
  }

  const processed: ProcessResult[] = [];
  const busy = new Set<string>();
  // Each pass reads the queue fresh. When a run finishes, the next pass starts
  // from the top, so the run whose turn it now is gets picked up whatever order
  // the queue happened to be listed in. A finished run leaves the queue, so
  // passes always end; the cap is only a backstop.
  passes: for (let pass = 0; pass < 50; pass++) {
    const runnable = await deps.store.listRunnableRuns(deps.now(), 40);
    for (const run of runnable) {
      if (busy.has(run.workspace_id)) continue;
      const remaining = opts.budgetMs - (Date.now() - started);
      if (remaining < (processed.length ? MIN_BUDGET_FOR_NEXT_RUN_MS : 20_000)) break passes;
      const res = await processRun(deps, run.id, { owner: opts.owner, budgetMs: remaining - 15_000 });
      // A run that is only waiting its turn did no work: try the next one in the queue.
      if (isWaitingTurn(res)) continue;
      processed.push(res);
      if (isTerminal(res.status)) continue passes; // frees its workspace: re-read the queue
      busy.add(run.workspace_id);
    }
    break;
  }
  return { created, missed, processed, workspaces: workspaces.length };
}
