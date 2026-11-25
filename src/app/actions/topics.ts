"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { CATEGORIES } from "@/lib/editorial/categories";
import { formatLocalDate, localDateOf, normalizeHHMM } from "@/lib/schedule/slots";
import { adminClient } from "@/lib/supabase/admin";
import { done, isRedirect, safeMessage } from "./util";

const P = "/topics";
const ACTIVE = ["queued", "researching", "deduplicating", "fact_checking", "writing", "quality_check", "generating_image", "publishing", "retry_scheduled"];

const time = z
  .string()
  .trim()
  .transform((v) => (v ? normalizeHHMM(v) : null))
  .refine((v) => v === null || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), "Invalid time: use HH:MM");

const topicSchema = z.object({
  title: z.string().trim().min(3, "Invalid topic: at least 3 characters").max(160),
  category: z.enum(CATEGORIES),
  notes: z.string().trim().max(600).default(""),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid end date"),
  local_time: time,
});

async function today(workspaceId: string) {
  const { data } = await adminClient().from("workspace_settings").select("timezone").eq("workspace_id", workspaceId).single();
  return formatLocalDate(localDateOf(new Date(), data?.timezone ?? "Asia/Kolkata"));
}

async function guarded(fn: () => Promise<string>) {
  let msg: string;
  try {
    msg = await fn();
  } catch (e) {
    if (isRedirect(e)) throw e;
    done(P, "err", safeMessage(e));
  }
  revalidatePath("/", "layout");
  done(P, "ok", msg);
}

function parse(fd: FormData) {
  return topicSchema.parse({
    title: fd.get("title") ?? "",
    category: fd.get("category"),
    notes: fd.get("notes") ?? "",
    end_date: fd.get("end_date") ?? "",
    local_time: fd.get("local_time") ?? "",
  });
}

export async function createTopic(fd: FormData) {
  await guarded(async () => {
    const ws = String(fd.get("workspace_id") ?? "");
    const { sb, user } = await requireRole(ws, "editor");
    const v = parse(fd);
    if (v.end_date < (await today(ws))) throw new Error("Invalid end date: it is already in the past");
    const { error } = await sb.from("editorial_topics").insert({ ...v, workspace_id: ws, created_by: user.id });
    if (error) throw new Error(`Database error: ${error.message}`);
    return `Topic added. It gets one article a day through ${v.end_date}, starting with the next ${v.local_time ? `${v.local_time} ` : "scheduled "}run.`;
  });
}

async function loadTopic(fd: FormData) {
  const id = String(fd.get("topic_id") ?? "");
  const { data: t } = await adminClient().from("editorial_topics").select("id,workspace_id,title").eq("id", id).maybeSingle();
  if (!t) throw new Error("Invalid topic");
  const { sb } = await requireRole(t.workspace_id, "editor");
  return { t, sb };
}

export async function updateTopic(fd: FormData) {
  await guarded(async () => {
    const { t, sb } = await loadTopic(fd);
    const v = parse(fd);
    const { error } = await sb.from("editorial_topics").update(v).eq("id", t.id);
    if (error) throw new Error(`Database error: ${error.message}`);
    return `"${v.title}" updated`;
  });
}

export async function setTopicEnabled(fd: FormData) {
  await guarded(async () => {
    const { t, sb } = await loadTopic(fd);
    const enabled = fd.get("enabled") === "true";
    const { error } = await sb.from("editorial_topics").update({ enabled }).eq("id", t.id);
    if (error) throw new Error(`Database error: ${error.message}`);
    return enabled ? `"${t.title}" resumed` : `"${t.title}" paused. It won't get new articles until you resume it.`;
  });
}

/** Ends a topic today: it keeps its history but drops out of the run queue. */
export async function endTopic(fd: FormData) {
  await guarded(async () => {
    const { t, sb } = await loadTopic(fd);
    const { error } = await sb.from("editorial_topics").update({ end_date: await today(t.workspace_id) }).eq("id", t.id);
    if (error) throw new Error(`Database error: ${error.message}`);
    return `"${t.title}" ends today`;
  });
}

export async function deleteTopic(fd: FormData) {
  await guarded(async () => {
    const { t, sb } = await loadTopic(fd);
    const db = adminClient();
    const { data: running } = await db.from("runs").select("id,status").eq("topic_id", t.id).in("status", ACTIVE);
    if ((running ?? []).some((r) => r.status !== "queued")) throw new Error("Invalid request: a run for this topic is in progress. Delete it after the run finishes.");
    if (running?.length) {
      await db.from("runs").update({ status: "cancelled", completed_at: new Date().toISOString(), outcome_reason: "Topic deleted" }).in("id", running.map((r) => r.id));
    }
    const { error } = await sb.from("editorial_topics").delete().eq("id", t.id);
    if (error) throw new Error(`Database error: ${error.message}`);
    return `"${t.title}" deleted. Its articles stay in Articles.`;
  });
}
