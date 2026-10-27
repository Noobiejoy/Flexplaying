"use server";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { rateLimit } from "@/lib/auth/rate-limit";
import { adminClient } from "@/lib/supabase/admin";
import { processRun, retryFailedRun } from "@/lib/pipeline/engine";
import { serverDeps } from "@/lib/pipeline/server-deps";
import type { RunRecord } from "@/lib/pipeline/types";
import { done, isRedirect, safeMessage } from "./util";

const ACTIVE = ["queued", "researching", "deduplicating", "fact_checking", "writing", "quality_check", "generating_image", "publishing", "retry_scheduled"];

function kick(runId: string) {
  // Continue in the background after the response; the scheduler tick resumes it if this is cut short.
  after(async () => {
    try {
      await processRun(serverDeps(), runId, { owner: `manual-${randomUUID()}`, budgetMs: 170_000 });
    } catch (e) {
      console.error("manual run processing failed", (e as Error).message);
    }
  });
}

export async function triggerRun(fd: FormData) {
  const back = String(fd.get("back") ?? "/activity");
  let runId = "";
  try {
    const id = String(fd.get("workspace_id"));
    const { user } = await requireRole(id, "editor");
    const mode = z.enum(["dry_run", "draft_only", "auto_publish", "workspace"]).parse(fd.get("mode") ?? "workspace");
    if (!(await rateLimit(user.id, id, "manual_run", 6, 3600))) throw new Error("Rate limit: at most 6 manual runs per hour");
    const db = adminClient();
    const { data: active } = await db.from("runs").select("id").eq("workspace_id", id).in("status", ACTIVE).limit(1);
    if (active?.length) throw new Error("Invalid request: a run is already in progress for this workspace");
    const { data: settings } = await db.from("workspace_settings").select("publishing_mode").eq("workspace_id", id).single();
    let effective = mode === "workspace" ? (settings?.publishing_mode as RunRecord["publishing_mode"]) : mode;
    // A manual run can never exceed the workspace's own publishing permission.
    if (effective === "auto_publish" && settings?.publishing_mode !== "auto_publish") effective = "draft_only";
    const { data: run, error } = await db.from("runs").insert({ workspace_id: id, trigger: "manual", status: "queued", publishing_mode: effective, triggered_by: user.id }).select("id").single();
    if (error) throw new Error(`Database error: ${error.message}`);
    runId = run.id;
    kick(runId);
  } catch (e) {
    if (isRedirect(e)) throw e;
    done(back, "err", safeMessage(e));
  }
  revalidatePath("/", "layout");
  done(`/activity/${runId}`, "ok", "Run queued and started");
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
    kick(runId);
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
