"use server";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { rateLimit } from "@/lib/auth/rate-limit";
import { adminClient } from "@/lib/supabase/admin";
import { isWaitingTurn, processRun, retryFailedRun } from "@/lib/pipeline/engine";
import { serverDeps } from "@/lib/pipeline/server-deps";
import { isTerminal, type RunRecord } from "@/lib/pipeline/types";
import { topicActiveOn } from "@/lib/pipeline/targets";
import { CATEGORIES, CATEGORY_LABEL, type Category } from "@/lib/editorial/categories";
import { formatLocalDate, localDateOf, startOfLocalDay } from "@/lib/schedule/slots";
import { done, isRedirect, safeMessage } from "./util";

const ACTIVE = ["queued", "researching", "deduplicating", "fact_checking", "writing", "quality_check", "generating_image", "publishing", "retry_scheduled"];

/**
 * Continue in the background after the response: work through this workspace's
 * queued runs one after another. The scheduler tick picks up whatever is left.
 */
function kick(workspaceId: string) {
  after(async () => {
    const started = Date.now();
    const owner = `manual-${randomUUID()}`;
    try {
      const deps = serverDeps();
      for (let i = 0; i < 6; i++) {
        const remaining = 170_000 - (Date.now() - started);
        if (remaining < 60_000) break;
        const queue = (await deps.store.listRunnableRuns(new Date(), 40)).filter((r) => r.workspace_id === workspaceId);
        // Skip past runs that are only waiting their turn; stop once one run has done work.
        let res = null;
        for (const next of queue) {
          res = await processRun(deps, next.id, { owner, budgetMs: 170_000 - (Date.now() - started) - 10_000 });
          if (!isWaitingTurn(res)) break;
        }
        if (!res || isWaitingTurn(res) || !isTerminal(res.status)) break;
      }
    } catch (e) {
      console.error("manual run processing failed", (e as Error).message);
    }
  });
}

async function effectiveMode(db: ReturnType<typeof adminClient>, workspaceId: string, mode: string) {
  const { data: settings } = await db.from("workspace_settings").select("publishing_mode,enabled_categories").eq("workspace_id", workspaceId).single();
  let effective = (mode === "workspace" ? settings?.publishing_mode : mode) as RunRecord["publishing_mode"];
  // A manual run can never exceed the workspace's own publishing permission.
  if (effective === "auto_publish" && settings?.publishing_mode !== "auto_publish") effective = "draft_only";
  return { effective, enabled: (settings?.enabled_categories ?? []) as Category[] };
}

/** Run now: one run per enabled category ("all"), or a single category. */
export async function triggerRun(fd: FormData) {
  const back = String(fd.get("back") ?? "/activity");
  let firstId = "";
  let count = 0;
  try {
    const id = String(fd.get("workspace_id"));
    const { user } = await requireRole(id, "editor");
    const mode = z.enum(["dry_run", "draft_only", "auto_publish", "workspace"]).parse(fd.get("mode") ?? "workspace");
    const target = z.enum(["all", ...CATEGORIES]).parse(fd.get("target") ?? "all");
    if (!(await rateLimit(user.id, id, "manual_run", 6, 3600))) throw new Error("Rate limit: at most 6 manual starts per hour");
    const db = adminClient();
    const { effective, enabled } = await effectiveMode(db, id, mode);
    const wanted = target === "all" ? CATEGORIES.filter((c) => enabled.includes(c)) : [target];
    if (wanted.length === 0) throw new Error("Invalid request: no categories are enabled");
    const { data: active } = await db.from("runs").select("category").eq("workspace_id", id).is("topic_id", null).in("status", ACTIVE);
    const busy = new Set((active ?? []).map((r) => r.category as string | null));
    const todo = wanted.filter((c) => !busy.has(c));
    if (todo.length === 0) throw new Error(`Invalid request: ${wanted.map((c) => CATEGORY_LABEL[c]).join(", ")} already queued or running`);
    for (const category of todo) {
      const { data: run, error } = await db.from("runs").insert({ workspace_id: id, trigger: "manual", status: "queued", publishing_mode: effective, triggered_by: user.id, category }).select("id").single();
      if (error) throw new Error(`Database error: ${error.message}`);
      firstId ||= run.id;
      count++;
    }
    kick(id);
  } catch (e) {
    if (isRedirect(e)) throw e;
    done(back, "err", safeMessage(e));
  }
  revalidatePath("/", "layout");
  if (count > 1) done("/activity?status=active", "ok", `${count} runs queued, one per category. They run one after another.`);
  done(`/activity/${firstId}`, "ok", "Run queued and started");
}

/** Run a topic's article now (still at most one article per topic per day). */
export async function runTopicNow(fd: FormData) {
  const back = "/topics";
  let runId = "";
  try {
    const topicId = String(fd.get("topic_id"));
    const db = adminClient();
    const { data: topic } = await db.from("editorial_topics").select("*").eq("id", topicId).maybeSingle();
    if (!topic) throw new Error("Invalid topic");
    const { user } = await requireRole(topic.workspace_id, "editor");
    if (!(await rateLimit(user.id, topic.workspace_id, "manual_run", 6, 3600))) throw new Error("Rate limit: at most 6 manual starts per hour");
    const { data: settings } = await db.from("workspace_settings").select("timezone").eq("workspace_id", topic.workspace_id).single();
    const tz = settings?.timezone ?? "Asia/Kolkata";
    const now = new Date();
    if (!topicActiveOn(topic, formatLocalDate(localDateOf(now, tz)))) throw new Error(`Invalid request: this topic is ${topic.enabled ? "over" : "paused"}`);
    const { data: active } = await db.from("runs").select("id").eq("topic_id", topicId).in("status", ACTIVE).limit(1);
    if (active?.length) throw new Error("Invalid request: this topic already has a run queued or in progress");
    const { count } = await db.from("articles").select("id", { count: "exact", head: true }).eq("topic_id", topicId).in("status", ["drafted", "published", "needs_review"]).gte("created_at", startOfLocalDay(now, tz).toISOString());
    if (count) throw new Error("Invalid request: this topic already has today's article");
    const { effective } = await effectiveMode(db, topic.workspace_id, "workspace");
    const { data: run, error } = await db.from("runs").insert({ workspace_id: topic.workspace_id, trigger: "manual", status: "queued", publishing_mode: effective, triggered_by: user.id, category: topic.category, topic_id: topicId }).select("id").single();
    if (error) throw new Error(`Database error: ${error.message}`);
    runId = run.id;
    kick(topic.workspace_id);
  } catch (e) {
    if (isRedirect(e)) throw e;
    done(back, "err", safeMessage(e));
  }
  revalidatePath("/", "layout");
  done(`/activity/${runId}`, "ok", "Topic run queued. It starts as soon as any earlier run finishes.");
}

export async function retryRun(fd: FormData) {
  const runId = String(fd.get("run_id"));
  try {
    const db = adminClient();
    const { data: run } = await db.from("runs").select("*").eq("id", runId).single();
    if (!run) throw new Error("Invalid run");
    const { user } = await requireRole(run.workspace_id, "editor");
    if (!(await rateLimit(user.id, run.workspace_id, "retry_run", 10, 3600))) throw new Error("Rate limit: try again later");
    const deps = serverDeps();
    if (!(await retryFailedRun(deps, run as RunRecord))) throw new Error("Invalid request: only failed runs with a recorded stage can be retried");
    kick(run.workspace_id);
  } catch (e) {
    if (isRedirect(e)) throw e;
    done(`/activity/${runId}`, "err", safeMessage(e));
  }
  done(`/activity/${runId}`, "ok", "Retry scheduled from the failed stage");
}

export async function cancelRun(fd: FormData) {
  const runId = String(fd.get("run_id"));
  try {
    const db = adminClient();
    const { data: run } = await db.from("runs").select("workspace_id,status").eq("id", runId).single();
    if (!run) throw new Error("Invalid run");
    await requireRole(run.workspace_id, "editor");
    if (!["queued", "retry_scheduled"].includes(run.status)) throw new Error("Invalid request: only queued or retry-scheduled runs can be cancelled");
    await db.from("runs").update({ status: "cancelled", completed_at: new Date().toISOString(), outcome_reason: "Cancelled by user" }).eq("id", runId);
  } catch (e) {
    if (isRedirect(e)) throw e;
    done(`/activity/${runId}`, "err", safeMessage(e));
  }
  done(`/activity/${runId}`, "ok", "Run cancelled");
}

export async function resolveNotification(fd: FormData) {
  const id = Number(fd.get("id"));
  const ws = String(fd.get("workspace_id"));
  try {
    const { sb } = await requireRole(ws, "editor");
    await sb.from("notifications").update({ resolved_at: new Date().toISOString() }).eq("id", id).eq("workspace_id", ws);
  } catch (e) {
    if (isRedirect(e)) throw e;
    done("/overview", "err", safeMessage(e));
  }
  revalidatePath("/overview");
  done("/overview", "ok", "Marked resolved");
}
