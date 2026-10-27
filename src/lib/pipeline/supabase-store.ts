import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExistingPost } from "@/lib/editorial/dedupe";
import type { Category } from "@/lib/editorial/categories";
import { parsePreferences, DEFAULT_PREFERENCES } from "@/lib/editorial/preferences";
import type { PricingRow } from "@/lib/costs/pricing";
import { normalizeHHMM } from "@/lib/schedule/slots";
import type {
  ArticleInput,
  ArticleRecord,
  AutomatedWorkspace,
  CandidateInput,
  CandidateRecord,
  ClaimInputRecord,
  ClaimRecord,
  ImageRecord,
  NewRunInput,
  PipelineStore,
  RunRecord,
  SourceInput,
  SourceRecord,
  StageLogInput,
  UsageEventInput,
  WorkspaceContext,
} from "./types";

const ACTIVE = "(queued,researching,deduplicating,fact_checking,writing,quality_check,generating_image,publishing,retry_scheduled)";
const PRODUCED = ["drafted", "published", "needs_review"];

function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new Error(`Database error (${what}): ${res.error.message}`);
  return res.data as T;
}

/** Production store using the Supabase service-role client (server only). */
export class SupabaseStore implements PipelineStore {
  constructor(private readonly db: SupabaseClient, private readonly bucket = "thumbnails") {}

  async createRun(input: NewRunInput): Promise<RunRecord | null> {
    const row = { ...input, completed_at: input.status === "missed" ? new Date().toISOString() : null };
    const res = await this.db.from("runs").insert(row).select("*").single();
    if (res.error) {
      if (res.error.code === "23505") return null; // slot already exists
      throw new Error(`Database error (create run): ${res.error.message}`);
    }
    return res.data as RunRecord;
  }

  async getRun(id: string) {
    return must(await this.db.from("runs").select("*").eq("id", id).maybeSingle(), "get run") as RunRecord | null;
  }

  async updateRun(id: string, patch: Partial<RunRecord>) {
    must(await this.db.from("runs").update(patch).eq("id", id), "update run");
  }

  async claimRun(id: string, owner: string, leaseSeconds: number) {
    return Boolean(must(await this.db.rpc("claim_run", { p_run_id: id, p_owner: owner, p_lease_seconds: leaseSeconds }), "claim run"));
  }

  async releaseRun(id: string, owner: string) {
    must(await this.db.rpc("release_run", { p_run_id: id, p_owner: owner }), "release run");
  }

  async listRunnableRuns(now: Date, limit: number) {
    const iso = now.toISOString();
    const rows = must(
      await this.db
        .from("runs")
        .select("*")
        .filter("status", "in", ACTIVE)
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${iso}`)
        .or(`lease_expires_at.is.null,lease_expires_at.lt.${iso}`)
        .order("created_at", { ascending: true })
        .limit(limit),
      "list runnable",
    ) as RunRecord[];
    return rows;
  }

  async hasOtherActiveRun(workspaceId: string, excludeRunId: string) {
    const self = await this.getRun(excludeRunId);
    const rows = must(
      await this.db.from("runs").select("id,status,created_at").eq("workspace_id", workspaceId).neq("id", excludeRunId).filter("status", "in", ACTIVE).limit(20),
      "active runs",
    ) as { id: string; status: string; created_at: string }[];
    return rows.some((r) => !self || r.created_at < self.created_at || r.status !== "queued");
  }

  async log(e: StageLogInput) {
    must(await this.db.from("run_stage_logs").insert({ ...e, detail: e.detail ?? {} }), "log");
  }

  async loadContext(workspaceId: string): Promise<WorkspaceContext> {
    const [ws, settings, prefs, wp] = await Promise.all([
      this.db.from("workspaces").select("id,name").eq("id", workspaceId).single(),
      this.db.from("workspace_settings").select("*").eq("workspace_id", workspaceId).single(),
      this.db.from("editorial_preferences").select("*").eq("workspace_id", workspaceId).eq("active", true).maybeSingle(),
      this.db.from("wordpress_connections").select("id,site_url,username,status,seo_plugin,category_map").eq("workspace_id", workspaceId).maybeSingle(),
    ]);
    const w = must(ws, "workspace") as { id: string; name: string };
    const s = must(settings, "settings") as WorkspaceContext["settings"];
    const p = must(prefs, "preferences") as (Parameters<typeof parsePreferences>[0] & { id: string }) | null;
    return {
      workspaceId,
      workspaceName: w.name,
      settings: { ...s, min_candidate_score: Number(s.min_candidate_score), min_quality_score: Number(s.min_quality_score) },
      prefs: p ? { ...parsePreferences(p), id: p.id } : { ...DEFAULT_PREFERENCES, id: "default" },
      wp: (must(wp, "wordpress connection") as WorkspaceContext["wp"]) ?? null,
    };
  }

  async listAutomatedWorkspaces(): Promise<AutomatedWorkspace[]> {
    const settings = must(
      await this.db.from("workspace_settings").select("workspace_id,timezone,automation_changed_at,missed_run_grace_minutes,publishing_mode").eq("automation_enabled", true),
      "automated workspaces",
    ) as { workspace_id: string; timezone: string; automation_changed_at: string; missed_run_grace_minutes: number; publishing_mode: AutomatedWorkspace["publishingMode"] }[];
    if (settings.length === 0) return [];
    const schedules = must(
      await this.db.from("schedules").select("workspace_id,local_time").eq("enabled", true).in("workspace_id", settings.map((s) => s.workspace_id)),
      "schedules",
    ) as { workspace_id: string; local_time: string }[];
    return settings.map((s) => ({
      workspaceId: s.workspace_id,
      timezone: s.timezone,
      automationChangedAt: s.automation_changed_at,
      graceMinutes: s.missed_run_grace_minutes,
      publishingMode: s.publishing_mode,
      localTimes: schedules.filter((x) => x.workspace_id === s.workspace_id).map((x) => normalizeHHMM(x.local_time)),
    }));
  }

  async getSecretCiphertext(workspaceId: string, kind: string) {
    const row = must(await this.db.from("workspace_secrets").select("ciphertext").eq("workspace_id", workspaceId).eq("kind", kind).maybeSingle(), "secret") as { ciphertext: string } | null;
    return row?.ciphertext ?? null;
  }

  async insertCandidates(runId: string, workspaceId: string, round: number, input: CandidateInput[]) {
    if (input.length === 0) return [];
    const rows = input.map((c) => ({ ...c, run_id: runId, workspace_id: workspaceId, research_round: round }));
    const data = must(await this.db.from("topic_candidates").insert(rows).select("*"), "insert candidates") as CandidateRecord[];
    // preserve input order
    return input.map((c) => data.find((d) => d.headline === c.headline && d.rank === c.rank)!).filter(Boolean);
  }

  async updateCandidate(id: string, patch: Partial<CandidateRecord>) {
    must(await this.db.from("topic_candidates").update(patch).eq("id", id), "update candidate");
  }

  async listCandidates(runId: string) {
    return (must(await this.db.from("topic_candidates").select("*").eq("run_id", runId).order("rank"), "list candidates") as CandidateRecord[]).map((c) => ({ ...c, overall_score: Number(c.overall_score) }));
  }

  async getCandidate(id: string) {
    const c = must(await this.db.from("topic_candidates").select("*").eq("id", id).maybeSingle(), "get candidate") as CandidateRecord | null;
    return c ? { ...c, overall_score: Number(c.overall_score) } : null;
  }

  async upsertSources(workspaceId: string, sources: SourceInput[]) {
    if (sources.length === 0) return [];
    const rows = sources.map((s) => ({ ...s, workspace_id: workspaceId }));
    const data = must(await this.db.from("sources").upsert(rows, { onConflict: "workspace_id,url", ignoreDuplicates: false }).select("*"), "upsert sources") as SourceRecord[];
    return sources.map((s) => data.find((d) => d.url === s.url)!).map((s) => ({ ...s, quality_score: Number(s.quality_score) }));
  }

  async linkCandidateSources(candidateId: string, workspaceId: string, sourceIds: string[], origin: string) {
    if (sourceIds.length === 0) return;
    must(
      await this.db.from("candidate_sources").upsert(sourceIds.map((id) => ({ candidate_id: candidateId, source_id: id, workspace_id: workspaceId, origin })), { onConflict: "candidate_id,source_id", ignoreDuplicates: true }),
      "link sources",
    );
  }

  async getCandidateSources(candidateId: string) {
    const rows = must(await this.db.from("candidate_sources").select("origin, sources(*)").eq("candidate_id", candidateId), "candidate sources") as unknown as { origin: string; sources: SourceRecord }[];
    return rows.filter((r) => r.sources).map((r) => ({ ...r.sources, quality_score: Number(r.sources.quality_score), origin: r.origin }));
  }

  async replaceClaims(workspaceId: string, candidateId: string, claims: ClaimInputRecord[]) {
    must(await this.db.from("claims").delete().eq("candidate_id", candidateId), "delete claims");
    for (const c of claims) {
      const row = must(
        await this.db.from("claims").insert({ workspace_id: workspaceId, candidate_id: candidateId, text: c.text, kind: c.kind, importance: c.importance, status: c.status, notes: c.notes }).select("id").single(),
        "insert claim",
      ) as { id: string };
      if (c.sourceIds.length) {
        must(await this.db.from("claim_sources").insert(c.sourceIds.map((sid) => ({ claim_id: row.id, source_id: sid, workspace_id: workspaceId }))), "claim sources");
      }
    }
  }

  async getClaims(candidateId: string): Promise<ClaimRecord[]> {
    const rows = must(
      await this.db.from("claims").select("id,text,kind,importance,status,notes,created_at, claim_sources(sources(*))").eq("candidate_id", candidateId).order("created_at"),
      "get claims",
    ) as unknown as (Omit<ClaimRecord, "sources"> & { claim_sources: { sources: SourceRecord }[] })[];
    return rows.map(({ claim_sources, ...c }) => ({ ...c, sources: claim_sources.map((x) => x.sources).filter(Boolean) }));
  }

  async recentHeadlines(workspaceId: string, sinceIso: string) {
    const rows = must(await this.db.from("topic_candidates").select("headline").eq("workspace_id", workspaceId).gte("created_at", sinceIso).limit(60), "recent headlines") as { headline: string }[];
    return rows.map((r) => r.headline);
  }

  async upsertWpPosts(workspaceId: string, posts: ExistingPost[]) {
    if (posts.length === 0) return;
    const rows = posts
      .filter((p) => p.origin === "wordpress")
      .map((p) => ({ workspace_id: workspaceId, wp_id: p.id, slug: p.slug, title: p.title, link: p.link, status: p.status, date_gmt: p.dateGmt ?? null, excerpt: p.excerpt.slice(0, 600), synced_at: new Date().toISOString() }));
    for (let i = 0; i < rows.length; i += 200) {
      must(await this.db.from("wp_posts").upsert(rows.slice(i, i + 200), { onConflict: "workspace_id,wp_id" }), "upsert wp posts");
    }
  }

  async listWpPosts(workspaceId: string, limit: number): Promise<ExistingPost[]> {
    const rows = must(await this.db.from("wp_posts").select("wp_id,slug,title,link,status,excerpt,date_gmt").eq("workspace_id", workspaceId).order("date_gmt", { ascending: false }).limit(limit), "list wp posts") as {
      wp_id: number;
      slug: string;
      title: string;
      link: string;
      status: string;
      excerpt: string;
      date_gmt: string | null;
    }[];
    return rows.map((r) => ({ id: Number(r.wp_id), slug: r.slug, title: r.title, link: r.link, status: r.status, excerpt: r.excerpt, dateGmt: r.date_gmt, origin: "wordpress" as const }));
  }

  async recordWpSync(event: Parameters<PipelineStore["recordWpSync"]>[0]) {
    must(await this.db.from("wp_sync_events").insert(event), "wp sync event");
  }

  async createArticle(input: ArticleInput) {
    return must(await this.db.from("articles").insert(input).select("*").single(), "create article") as ArticleRecord;
  }

  async updateArticle(id: string, patch: Partial<ArticleRecord>) {
    must(await this.db.from("articles").update(patch).eq("id", id), "update article");
  }

  async getArticle(id: string) {
    const a = must(await this.db.from("articles").select("*").eq("id", id).maybeSingle(), "get article") as ArticleRecord | null;
    return a ? { ...a, quality_score: a.quality_score === null ? null : Number(a.quality_score), wp_post_id: a.wp_post_id === null ? null : Number(a.wp_post_id) } : null;
  }

  async findArticleForCandidate(runId: string, candidateId: string) {
    const a = must(await this.db.from("articles").select("id").eq("run_id", runId).eq("candidate_id", candidateId).maybeSingle(), "find article") as { id: string } | null;
    return a ? this.getArticle(a.id) : null;
  }

  async runArticleStatuses(runId: string) {
    return (must(await this.db.from("articles").select("status").eq("run_id", runId), "run articles") as { status: string }[]).map((r) => r.status);
  }

  async addRevision(articleId: string, workspaceId: string, source: "writer" | "revision" | "user", headline: string, bodyHtml: string, changeSummary: string) {
    const last = must(await this.db.from("article_revisions").select("revision").eq("article_id", articleId).order("revision", { ascending: false }).limit(1), "last revision") as { revision: number }[];
    const revision = (last[0]?.revision ?? 0) + 1;
    must(await this.db.from("article_revisions").insert({ article_id: articleId, workspace_id: workspaceId, revision, source, headline, body_html: bodyHtml, change_summary: changeSummary }), "add revision");
    return revision;
  }

  async listLocalArticles(workspaceId: string, limit: number): Promise<ExistingPost[]> {
    const rows = must(
      await this.db.from("articles").select("id,headline,slug,wp_url,wp_post_id,status,excerpt,created_at").eq("workspace_id", workspaceId).in("status", PRODUCED).order("created_at", { ascending: false }).limit(limit),
      "local articles",
    ) as { headline: string; slug: string; wp_url: string | null; wp_post_id: number | null; status: string; excerpt: string; created_at: string }[];
    return rows.map((r, i) => ({ id: r.wp_post_id ? Number(r.wp_post_id) : -(i + 1), title: r.headline, slug: r.slug, link: r.wp_url ?? "", status: r.status, excerpt: r.excerpt, dateGmt: r.created_at, origin: "local" as const }));
  }

  async countProducedSince(workspaceId: string, sinceIso: string) {
    const res = await this.db.from("articles").select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId).in("status", PRODUCED).gte("created_at", sinceIso);
    if (res.error) throw new Error(`Database error (count articles): ${res.error.message}`);
    return res.count ?? 0;
  }

  async recentCategoryCounts(workspaceId: string, sinceIso: string) {
    const rows = must(await this.db.from("articles").select("category").eq("workspace_id", workspaceId).in("status", ["drafted", "published"]).gte("created_at", sinceIso), "category counts") as { category: Category }[];
    const out: Partial<Record<Category, number>> = {};
    for (const r of rows) out[r.category] = (out[r.category] ?? 0) + 1;
    return out;
  }

  async getImage(articleId: string) {
    return must(await this.db.from("article_images").select("*").eq("article_id", articleId).maybeSingle(), "get image") as ImageRecord | null;
  }

  async upsertImage(articleId: string, workspaceId: string, patch: Partial<ImageRecord> & { prompt: string; model: string }) {
    return must(await this.db.from("article_images").upsert({ ...patch, article_id: articleId, workspace_id: workspaceId }, { onConflict: "article_id" }).select("*").single(), "upsert image") as ImageRecord;
  }

  async saveImageBytes(path: string, data: Buffer, mimeType: string) {
    const { error } = await this.db.storage.from(this.bucket).upload(path, data, { contentType: mimeType, upsert: true });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }

  async loadImageBytes(path: string) {
    const { data, error } = await this.db.storage.from(this.bucket).download(path);
    if (error || !data) throw new Error(`Storage download failed: ${error?.message ?? "no data"}`);
    return Buffer.from(await data.arrayBuffer());
  }

  async recordUsage(e: UsageEventInput) {
    must(await this.db.from("usage_events").insert(e), "usage event");
  }

  async getPricing(workspaceId: string, model: string): Promise<PricingRow | null> {
    const rows = must(await this.db.from("model_pricing").select("*").eq("workspace_id", workspaceId).eq("model", model).eq("active", true).order("version", { ascending: false }).limit(1), "pricing") as PricingRow[];
    return rows[0] ?? null;
  }

  async notify(workspaceId: string, runId: string | null, level: "info" | "warning" | "error", title: string, body: string) {
    must(await this.db.from("notifications").insert({ workspace_id: workspaceId, run_id: runId, level, title, body }), "notify");
  }

  async recordNonce(nonce: string, source: string) {
    const res = await this.db.from("scheduler_invocations").insert({ nonce, source });
    if (res.error) {
      if (res.error.code === "23505") return false;
      throw new Error(`Database error (nonce): ${res.error.message}`);
    }
    return true;
  }
}
