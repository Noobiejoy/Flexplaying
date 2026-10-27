"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { adminClient } from "@/lib/supabase/admin";
import { recomputePreferences } from "@/lib/editorial/learning-server";
import { done, isRedirect, safeMessage } from "./util";

export async function submitFeedback(fd: FormData) {
  const back = String(fd.get("back") ?? "/research");
  let msg = "Feedback saved";
  try {
    const ws = String(fd.get("workspace_id"));
    const { sb, user } = await requireRole(ws, "editor");
    const candidateId = z.uuid().parse(fd.get("candidate_id"));
    const verdict = z.enum(["interesting", "irrelevant", "already_covered", "needs_research"]).parse(fd.get("verdict"));
    const { data: cand } = await sb.from("topic_candidates").select("id").eq("id", candidateId).eq("workspace_id", ws).maybeSingle();
    if (!cand) throw new Error("Invalid candidate");
    const { error } = await sb.from("topic_feedback").upsert({ workspace_id: ws, candidate_id: candidateId, user_id: user.id, verdict }, { onConflict: "candidate_id,user_id" });
    if (error) throw new Error(`Database error: ${error.message}`);
    const v = await recomputePreferences(ws, user.id);
    if (v) msg = `Feedback saved; preferences updated to v${v}`;
  } catch (e) {
    if (isRedirect(e)) throw e;
    done(back, "err", safeMessage(e));
  }
  revalidatePath("/research");
  done(back, "ok", msg);
}

export async function activatePreferenceVersion(fd: FormData) {
  try {
    const ws = String(fd.get("workspace_id"));
    const { user } = await requireRole(ws, "owner");
    const version = z.coerce.number().int().min(1).parse(fd.get("version"));
    const db = adminClient();
    const { data: target } = await db.from("editorial_preferences").select("*").eq("workspace_id", ws).eq("version", version).single();
    if (!target) throw new Error("Invalid version");
    const { data: latest } = await db.from("editorial_preferences").select("version").eq("workspace_id", ws).order("version", { ascending: false }).limit(1);
    const next = (latest?.[0]?.version ?? version) + 1;
    await db.from("editorial_preferences").update({ active: false }).eq("workspace_id", ws).eq("active", true);
    const { error } = await db.from("editorial_preferences").insert({
      workspace_id: ws,
      version: next,
      active: true,
      source: "revert",
      scoring_weights: target.scoring_weights,
      category_weights: target.category_weights,
      entity_adjustments: target.entity_adjustments,
      blocked_terms: target.blocked_terms,
      change_summary: `Reverted to the settings of v${version}`,
      signals: {},
      created_by: user.id,
    });
    if (error) throw new Error(`Database error: ${error.message}`);
  } catch (e) {
    if (isRedirect(e)) throw e;
    done("/learning", "err", safeMessage(e));
  }
  done("/learning", "ok", "Preferences reverted (as a new version)");
}

export async function updateManualPreferences(fd: FormData) {
  try {
    const ws = String(fd.get("workspace_id"));
    const { user } = await requireRole(ws, "owner");
    const blocked = String(fd.get("blocked_terms") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50);
    const w = (k: string) => z.coerce.number().min(0).max(1).parse(fd.get(k));
    const weights = { recency: w("w_recency"), source_quality: w("w_source_quality"), relevance: w("w_relevance"), originality: w("w_originality"), corroboration: w("w_corroboration") };
    const db = adminClient();
    const { data: active } = await db.from("editorial_preferences").select("*").eq("workspace_id", ws).eq("active", true).single();
    if (!active) throw new Error("Invalid state: no active preferences");
    await db.from("editorial_preferences").update({ active: false }).eq("id", active.id);
    const { error } = await db.from("editorial_preferences").insert({
      workspace_id: ws,
      version: active.version + 1,
      active: true,
      source: "manual",
      scoring_weights: weights,
      category_weights: active.category_weights,
      entity_adjustments: active.entity_adjustments,
      blocked_terms: blocked,
      change_summary: "Manual edit of scoring weights / blocked terms",
      signals: {},
      created_by: user.id,
    });
    if (error) {
      await db.from("editorial_preferences").update({ active: true }).eq("id", active.id);
      throw new Error(`Database error: ${error.message}`);
    }
  } catch (e) {
    if (isRedirect(e)) throw e;
    done("/learning", "err", safeMessage(e));
  }
  done("/learning", "ok", "Preferences saved as a new version");
}
