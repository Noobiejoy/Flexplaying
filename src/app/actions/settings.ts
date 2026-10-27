"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireRole } from "@/lib/auth/session";
import { rateLimit, audit } from "@/lib/auth/rate-limit";
import { encryptSecret } from "@/lib/crypto/secrets";
import { serverKeyRing } from "@/lib/crypto/keyring";
import { CATEGORIES, CATEGORY_LABEL } from "@/lib/editorial/categories";
import { isValidTimeZone, normalizeHHMM } from "@/lib/schedule/slots";
import { adminClient } from "@/lib/supabase/admin";
import { WordPressClient } from "@/lib/wordpress/client";
import { normalizeSiteUrl, isSafePublicHttpUrl } from "@/lib/wordpress/url";
import { serverAi } from "@/lib/pipeline/server-deps";
import { verifyModel } from "@/lib/ai/openrouter";
import { env } from "@/lib/env";
import { done, isRedirect, safeMessage } from "./util";

const S = "/settings";
const wsId = (fd: FormData) => String(fd.get("workspace_id") ?? "");

async function guarded(path: string, fn: () => Promise<string>) {
  let msg: string;
  try {
    msg = await fn();
  } catch (e) {
    if (isRedirect(e)) throw e;
    done(path, "err", safeMessage(e));
  }
  revalidatePath("/", "layout");
  done(path, "ok", msg);
}

export async function updateGeneral(fd: FormData) {
  await guarded(S, async () => {
    const id = wsId(fd);
    const { sb } = await requireRole(id, "owner");
    const name = z.string().trim().min(1).max(80).parse(fd.get("name"));
    const tz = String(fd.get("timezone"));
    if (!isValidTimeZone(tz)) throw new Error("Invalid timezone");
    const a = await sb.from("workspaces").update({ name }).eq("id", id);
    const b = await sb.from("workspace_settings").update({ timezone: tz }).eq("workspace_id", id);
    if (a.error || b.error) throw new Error(`Database error: ${(a.error ?? b.error)!.message}`);
    return "Workspace updated";
  });
}

export async function setAutomation(fd: FormData) {
  await guarded("/overview", async () => {
    const id = wsId(fd);
    const { sb, user } = await requireRole(id, "owner");
    const enabled = fd.get("enabled") === "true";
    const { error } = await sb.from("workspace_settings").update({ automation_enabled: enabled, automation_changed_at: new Date().toISOString() }).eq("workspace_id", id);
    if (error) throw new Error(`Database error: ${error.message}`);
    await audit(user.id, id, enabled ? "automation_resumed" : "automation_paused");
    return enabled ? "Automation resumed" : "Automation paused. Queued scheduled runs will be cancelled.";
  });
}

export async function updateSchedule(fd: FormData) {
  await guarded(`${S}#schedule`, async () => {
    const id = wsId(fd);
    const { sb } = await requireRole(id, "owner");
    const raw = String(fd.get("times") ?? "").split(/[,\s]+/).filter(Boolean);
    if (raw.length === 0 || raw.length > 8) throw new Error("Invalid schedule: provide 1 to 8 times");
    const times = [...new Set(raw.map(normalizeHHMM))].sort();
    const del = await sb.from("schedules").delete().eq("workspace_id", id);
    if (del.error) throw new Error(`Database error: ${del.error.message}`);
    const ins = await sb.from("schedules").insert(times.map((t) => ({ workspace_id: id, local_time: t, enabled: true })));
    if (ins.error) throw new Error(`Database error: ${ins.error.message}`);
    return `Schedule saved: ${times.join(", ")}`;
  });
}

export async function updatePublishingMode(fd: FormData) {
  await guarded(`${S}#publishing`, async () => {
    const id = wsId(fd);
    const { sb, user } = await requireRole(id, "owner");
    const mode = z.enum(["dry_run", "draft_only", "auto_publish"]).parse(fd.get("mode"));
    const patch: Record<string, unknown> = { publishing_mode: mode };
    if (mode === "auto_publish") {
      if (fd.get("confirm") !== "AUTO-PUBLISH") throw new Error("Invalid confirmation: type AUTO-PUBLISH to enable automatic publication");
      patch.auto_publish_confirmed_at = new Date().toISOString();
      patch.auto_publish_confirmed_by = user.id;
    }
    const { error } = await sb.from("workspace_settings").update(patch).eq("workspace_id", id);
    if (error) throw new Error(`Database error: ${error.message}`);
    await audit(user.id, id, "publishing_mode_changed", { mode });
    return mode === "auto_publish" ? "Auto-publish enabled. Articles that pass every check will be published without approval." : `Publishing mode set to ${mode.replace("_", " ")}`;
  });
}

const editorialSchema = z.object({
  enabled_categories: z.array(z.enum(CATEGORIES)).min(1, "Enable at least one category"),
  max_articles_per_run: z.coerce.number().int().min(1).max(3),
  daily_article_limit: z.coerce.number().int().min(0).max(24),
  min_candidate_score: z.coerce.number().min(0).max(1),
  min_quality_score: z.coerce.number().min(0).max(1),
  target_words_min: z.coerce.number().int().min(150).max(3000),
  target_words_max: z.coerce.number().int().min(300).max(4000),
  max_research_rounds: z.coerce.number().int().min(1).max(4),
  max_candidates_per_run: z.coerce.number().int().min(1).max(12),
  image_failure_policy: z.enum(["draft", "fail"]),
  quality_fail_policy: z.enum(["draft", "fail"]),
  missed_run_grace_minutes: z.coerce.number().int().min(10).max(360),
  thumbnail_text_overlay: z.boolean(),
  inject_json_ld: z.boolean(),
  notify_on_failure: z.boolean(),
});

export async function updateEditorial(fd: FormData) {
  await guarded(`${S}#editorial`, async () => {
    const id = wsId(fd);
    const { sb } = await requireRole(id, "owner");
    const v = editorialSchema.parse({
      enabled_categories: fd.getAll("enabled_categories").map(String),
      max_articles_per_run: fd.get("max_articles_per_run"),
      daily_article_limit: fd.get("daily_article_limit"),
      min_candidate_score: fd.get("min_candidate_score"),
      min_quality_score: fd.get("min_quality_score"),
      target_words_min: fd.get("target_words_min"),
      target_words_max: fd.get("target_words_max"),
      max_research_rounds: fd.get("max_research_rounds"),
      max_candidates_per_run: fd.get("max_candidates_per_run"),
      image_failure_policy: fd.get("image_failure_policy"),
      quality_fail_policy: fd.get("quality_fail_policy"),
      missed_run_grace_minutes: fd.get("missed_run_grace_minutes"),
      thumbnail_text_overlay: fd.get("thumbnail_text_overlay") === "on",
      inject_json_ld: fd.get("inject_json_ld") === "on",
      notify_on_failure: fd.get("notify_on_failure") === "on",
    });
    if (v.target_words_min >= v.target_words_max) throw new Error("Invalid length: minimum words must be below maximum");
    const { error } = await sb.from("workspace_settings").update(v).eq("workspace_id", id);
    if (error) throw new Error(`Database error: ${error.message}`);
    return "Editorial settings saved";
  });
}

const modelId = z.string().trim().regex(/^google\/[a-z0-9.\-:_]+$/i, "Only google/* models are allowed").or(z.literal(""));

export async function updateModels(fd: FormData) {
  await guarded(`${S}#models`, async () => {
    const id = wsId(fd);
    const { sb } = await requireRole(id, "owner");
    const text = modelId.parse(fd.get("text_model") ?? "");
    const research = modelId.parse(fd.get("research_model") ?? "");
    const image = modelId.parse(fd.get("image_model") ?? "");
    const ai = serverAi();
    for (const [m, needs] of [[text, "text"], [research, "text"], [image, "image"]] as const) {
      if (m) await verifyModel(ai, m, needs).catch((e) => { throw new Error(`Model check failed: ${(e as Error).message}`); });
    }
    const { error } = await sb.from("workspace_settings").update({ text_model: text || null, research_model: research || null, image_model: image || null }).eq("workspace_id", id);
    if (error) throw new Error(`Database error: ${error.message}`);
    return "Model overrides saved and verified against OpenRouter";
  });
}

export async function checkModels(fd: FormData) {
  await guarded(`${S}#models`, async () => {
    const id = wsId(fd);
    const { user } = await requireRole(id, "owner");
    if (!(await rateLimit(user.id, id, "model_check", 10, 3600))) throw new Error("Rate limit: try again later");
    const e = env();
    const ai = serverAi();
    const results: string[] = [];
    for (const [m, needs] of [[e.OPENROUTER_TEXT_MODEL, "text"], [e.OPENROUTER_RESEARCH_MODEL, "text"], [e.OPENROUTER_IMAGE_MODEL, "image"]] as const) {
      try {
        await verifyModel(ai, m, needs);
        results.push(`${m} ✓`);
      } catch (err) {
        results.push(`${m} ✗ (${(err as Error).message.slice(0, 120)})`);
      }
    }
    return `Model check: ${results.join(" · ")}`;
  });
}

const wpSchema = z.object({
  site_url: z.string().min(8).max(200),
  username: z.string().trim().min(1).max(120),
  app_password: z.string().trim().regex(/^[A-Za-z0-9 ]{16,64}$/, "Application passwords are 24 letters/numbers (spaces allowed)").or(z.literal("")),
});

export async function saveWordPressConnection(fd: FormData) {
  await guarded(`${S}#wordpress`, async () => {
    const id = wsId(fd);
    const { user } = await requireRole(id, "owner");
    if (!(await rateLimit(user.id, id, "wp_connect", 10, 3600))) throw new Error("Rate limit: too many connection attempts, try again later");
    const v = wpSchema.parse({ site_url: fd.get("site_url"), username: fd.get("username"), app_password: fd.get("app_password") ?? "" });
    const siteUrl = normalizeSiteUrl(v.site_url);
    const db = adminClient();
    const ring = serverKeyRing();
    let password = v.app_password;
    if (!password) {
      const { data } = await db.from("workspace_secrets").select("ciphertext").eq("workspace_id", id).eq("kind", "wordpress_app_password").maybeSingle();
      if (!data) throw new Error("Invalid input: an application password is required");
      const { decryptSecret } = await import("@/lib/crypto/secrets");
      password = decryptSecret(data.ciphertext, `${id}:wordpress_app_password`, ring);
    }
    const client = new WordPressClient({ siteUrl, username: v.username, appPassword: password });
    const site = await client.discover();
    const me = await client.me();
    const caps = me.capabilities;
    const missing = ["edit_posts", "upload_files"].filter((c) => !caps[c]);
    if (missing.length) throw new Error(`WordPress user "${v.username}" lacks required capabilities: ${missing.join(", ")}`);
    const cats = await client.listCategories();
    const categoryMap: Record<string, number> = {};
    for (const c of CATEGORIES) {
      const hit = cats.find((x) => x.slug === c || x.name.toLowerCase() === CATEGORY_LABEL[c].toLowerCase());
      if (hit) categoryMap[c] = hit.id;
    }
    const { data: existing } = await db.from("wordpress_connections").select("category_map, credential_version").eq("workspace_id", id).maybeSingle();
    const row = {
      workspace_id: id,
      site_url: siteUrl,
      username: v.username,
      status: "ok",
      last_tested_at: new Date().toISOString(),
      last_error: null,
      seo_plugin: site.seoPlugin,
      capabilities: { roles: me.roles, publish_posts: Boolean(caps.publish_posts), upload_files: Boolean(caps.upload_files), edit_posts: Boolean(caps.edit_posts), unfiltered_html: Boolean(caps.unfiltered_html), site_name: site.name, categories: cats.slice(0, 200) },
      category_map: { ...categoryMap, ...((existing?.category_map as Record<string, number>) ?? {}) },
      credential_version: (existing?.credential_version ?? 0) + (v.app_password ? 1 : 0),
    };
    const up = await db.from("wordpress_connections").upsert(row, { onConflict: "workspace_id" });
    if (up.error) throw new Error(`Database error: ${up.error.message}`);
    if (v.app_password) {
      const enc = encryptSecret(v.app_password.replace(/\s+/g, ""), `${id}:wordpress_app_password`, ring);
      const s = await db.from("workspace_secrets").upsert({ workspace_id: id, kind: "wordpress_app_password", ciphertext: enc.ciphertext, key_id: enc.keyId, updated_at: new Date().toISOString() }, { onConflict: "workspace_id,kind" });
      if (s.error) throw new Error(`Database error: ${s.error.message}`);
    }
    await audit(user.id, id, "wordpress_connected", { site: siteUrl, rotated: Boolean(v.app_password) });
    const pub = caps.publish_posts ? "" : " Note: this user cannot publish (publish_posts missing), so only drafts are possible.";
    return `Connected to ${site.name || siteUrl}. SEO plugin: ${site.seoPlugin}. ${Object.keys(categoryMap).length}/3 categories auto-mapped.${pub}`;
  });
}

export async function testWordPressConnection(fd: FormData) {
  await guarded(`${S}#wordpress`, async () => {
    const id = wsId(fd);
    const { user } = await requireRole(id, "editor");
    if (!(await rateLimit(user.id, id, "wp_test", 20, 3600))) throw new Error("Rate limit: try again later");
    const db = adminClient();
    const { data: conn } = await db.from("wordpress_connections").select("*").eq("workspace_id", id).maybeSingle();
    const { data: sec } = await db.from("workspace_secrets").select("ciphertext").eq("workspace_id", id).eq("kind", "wordpress_app_password").maybeSingle();
    if (!conn || !sec) throw new Error("WordPress is not connected");
    const { decryptSecret } = await import("@/lib/crypto/secrets");
    const client = new WordPressClient({ siteUrl: conn.site_url, username: conn.username, appPassword: decryptSecret(sec.ciphertext, `${id}:wordpress_app_password`, serverKeyRing()) });
    try {
      const site = await client.discover();
      const me = await client.me();
      const posts = await client.listPosts({ statuses: ["publish"], perPage: 1, maxPages: 1 });
      await db.from("wordpress_connections").update({ status: "ok", last_tested_at: new Date().toISOString(), last_error: null, seo_plugin: site.seoPlugin }).eq("workspace_id", id);
      return `Connection OK: ${site.name}, user ${me.name} (${me.roles.join(", ")}), ${posts.length ? "posts readable" : "no posts found"}`;
    } catch (e) {
      await db.from("wordpress_connections").update({ status: "error", last_tested_at: new Date().toISOString(), last_error: safeMessage(e) }).eq("workspace_id", id);
      throw e;
    }
  });
}

export async function updateCategoryMap(fd: FormData) {
  await guarded(`${S}#wordpress`, async () => {
    const id = wsId(fd);
    const { sb } = await requireRole(id, "owner");
    const map: Record<string, number> = {};
    for (const c of CATEGORIES) {
      const v = Number(fd.get(`cat_${c}`));
      if (Number.isInteger(v) && v > 0) map[c] = v;
    }
    const { error } = await sb.from("wordpress_connections").update({ category_map: map }).eq("workspace_id", id);
    if (error) throw new Error(`Database error: ${error.message}`);
    return "Category mapping saved";
  });
}

export async function disconnectWordPress(fd: FormData) {
  await guarded(`${S}#wordpress`, async () => {
    const id = wsId(fd);
    const { user } = await requireRole(id, "owner");
    const db = adminClient();
    await db.from("workspace_secrets").delete().eq("workspace_id", id).eq("kind", "wordpress_app_password");
    await db.from("wordpress_connections").delete().eq("workspace_id", id);
    await db.from("workspace_settings").update({ automation_enabled: false, automation_changed_at: new Date().toISOString() }).eq("workspace_id", id);
    await audit(user.id, id, "wordpress_disconnected");
    return "WordPress disconnected, credentials deleted and automation paused. Also revoke the application password in WordPress (Users → Profile).";
  });
}

export async function saveWebhook(fd: FormData) {
  await guarded(`${S}#notifications`, async () => {
    const id = wsId(fd);
    const { user } = await requireRole(id, "owner");
    const url = String(fd.get("webhook_url") ?? "").trim();
    const db = adminClient();
    if (!url) {
      await db.from("workspace_secrets").delete().eq("workspace_id", id).eq("kind", "notification_webhook");
      return "Webhook removed";
    }
    if (!url.startsWith("https://") || !isSafePublicHttpUrl(url) || url.length > 500) throw new Error("Invalid webhook: must be a public HTTPS URL");
    const enc = encryptSecret(url, `${id}:notification_webhook`, serverKeyRing());
    const r = await db.from("workspace_secrets").upsert({ workspace_id: id, kind: "notification_webhook", ciphertext: enc.ciphertext, key_id: enc.keyId, updated_at: new Date().toISOString() }, { onConflict: "workspace_id,kind" });
    if (r.error) throw new Error(`Database error: ${r.error.message}`);
    await audit(user.id, id, "webhook_saved");
    return "Failure webhook saved (stored encrypted)";
  });
}

const price = z.preprocess((v) => (v === "" || v === null ? null : v), z.coerce.number().min(0).max(1000).nullable());

export async function savePricing(fd: FormData) {
  await guarded("/costs#pricing", async () => {
    const id = wsId(fd);
    const { sb, user } = await requireRole(id, "owner");
    const model = z.string().regex(/^google\/[a-z0-9.\-:_]+$/i, "Invalid model: only google/* models").parse(fd.get("model"));
    const row = {
      input_per_mtok: price.parse(fd.get("input_per_mtok")),
      output_per_mtok: price.parse(fd.get("output_per_mtok")),
      per_web_search: price.parse(fd.get("per_web_search")),
      per_image: price.parse(fd.get("per_image")),
      source_note: z.string().max(300).parse(fd.get("source_note") ?? ""),
    };
    const { data: prev } = await sb.from("model_pricing").select("version").eq("workspace_id", id).eq("model", model).order("version", { ascending: false }).limit(1);
    const version = (prev?.[0]?.version ?? 0) + 1;
    await sb.from("model_pricing").update({ active: false }).eq("workspace_id", id).eq("model", model);
    const { error } = await sb.from("model_pricing").insert({ workspace_id: id, model, version, ...row, active: true, created_by: user.id });
    if (error) throw new Error(`Database error: ${error.message}`);
    return `Pricing v${version} saved for ${model}. It applies only when OpenRouter does not report a cost.`;
  });
}
