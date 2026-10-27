import { randomUUID } from "node:crypto";
import type { ExistingPost } from "@/lib/editorial/dedupe";
import type { Category } from "@/lib/editorial/categories";
import { DEFAULT_PREFERENCES } from "@/lib/editorial/preferences";
import type { PricingRow } from "@/lib/costs/pricing";
import {
  isTerminal,
  type ArticleInput,
  type ArticleRecord,
  type AutomatedWorkspace,
  type CandidateInput,
  type CandidateRecord,
  type ClaimInputRecord,
  type ClaimRecord,
  type ImageRecord,
  type NewRunInput,
  type PipelineStore,
  type RunRecord,
  type SourceInput,
  type SourceRecord,
  type StageLogInput,
  type UsageEventInput,
  type WorkspaceContext,
  type WorkspaceSettings,
  type WordPressConnectionInfo,
} from "./types";

export function defaultSettings(workspaceId: string, overrides: Partial<WorkspaceSettings> = {}): WorkspaceSettings {
  return {
    workspace_id: workspaceId,
    timezone: "Asia/Kolkata",
    automation_enabled: true,
    automation_changed_at: "2026-01-01T00:00:00Z",
    publishing_mode: "draft_only",
    enabled_categories: ["anime", "gaming", "esports"],
    max_articles_per_run: 1,
    daily_article_limit: 3,
    min_candidate_score: 0.55,
    min_quality_score: 0.7,
    target_words_min: 600,
    target_words_max: 1200,
    max_research_rounds: 2,
    max_candidates_per_run: 5,
    image_failure_policy: "draft",
    quality_fail_policy: "draft",
    missed_run_grace_minutes: 90,
    notify_on_failure: true,
    inject_json_ld: false,
    thumbnail_text_overlay: false,
    text_model: null,
    research_model: null,
    image_model: null,
    ...overrides,
  };
}

/** Pipeline store backed by plain arrays; mirrors the SQL constraints that matter (slot uniqueness, leases). */
export class MemoryStore implements PipelineStore {
  runs: RunRecord[] = [];
  logs: StageLogInput[] = [];
  candidates: CandidateRecord[] = [];
  sources: SourceRecord[] = [];
  candidateSources: { candidate_id: string; source_id: string; origin: string }[] = [];
  claims: (ClaimRecord & { candidate_id: string })[] = [];
  wpPosts: (ExistingPost & { workspace_id: string })[] = [];
  wpSync: Record<string, unknown>[] = [];
  articles: ArticleRecord[] = [];
  revisions: { article_id: string; revision: number; source: string; headline: string; change_summary: string }[] = [];
  images: ImageRecord[] = [];
  blobs = new Map<string, Buffer>();
  usage: UsageEventInput[] = [];
  notifications: { workspace_id: string; level: string; title: string; body: string }[] = [];
  nonces = new Set<string>();
  pricing: (PricingRow & { workspace_id: string })[] = [];
  settings = new Map<string, WorkspaceSettings>();
  connections = new Map<string, WordPressConnectionInfo>();
  secrets = new Map<string, string>();
  schedules = new Map<string, string[]>();
  now: () => Date = () => new Date();

  addWorkspace(id: string, opts: { settings?: Partial<WorkspaceSettings>; wp?: WordPressConnectionInfo | null; times?: string[] } = {}) {
    this.settings.set(id, defaultSettings(id, opts.settings));
    if (opts.wp !== null) {
      this.connections.set(id, opts.wp ?? {
        id: `conn-${id}`,
        site_url: "https://mock-wordpress.example",
        username: "editor",
        status: "ok",
        seo_plugin: "yoast",
        category_map: { anime: 11, gaming: 12, esports: 13 },
      });
    }
    this.schedules.set(id, opts.times ?? ["09:00", "13:00", "19:00"]);
  }

  async createRun(input: NewRunInput) {
    if (input.slot_key && this.runs.some((r) => r.workspace_id === input.workspace_id && r.slot_key === input.slot_key)) return null;
    const run: RunRecord = {
      id: randomUUID(),
      workspace_id: input.workspace_id,
      trigger: input.trigger,
      slot_key: input.slot_key,
      scheduled_for: input.scheduled_for,
      status: input.status,
      resume_stage: null,
      publishing_mode: input.publishing_mode,
      started_at: null,
      completed_at: input.status === "missed" ? this.now().toISOString() : null,
      attempt: 0,
      stage_attempt: 0,
      next_attempt_at: null,
      lease_owner: null,
      lease_expires_at: null,
      research_round: 0,
      candidates_checked: 0,
      articles_produced: 0,
      selected_candidate_id: null,
      article_id: null,
      outcome_reason: input.outcome_reason ?? null,
      error_code: null,
      error_message: null,
      triggered_by: input.triggered_by,
      created_at: this.now().toISOString(),
    };
    this.runs.push(run);
    return { ...run };
  }

  async getRun(id: string) {
    const r = this.runs.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  async updateRun(id: string, patch: Partial<RunRecord>) {
    const r = this.runs.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
  }

  async claimRun(id: string, owner: string, leaseSeconds: number) {
    const r = this.runs.find((x) => x.id === id);
    if (!r || isTerminal(r.status)) return false;
    const now = this.now();
    if (r.lease_expires_at && new Date(r.lease_expires_at) > now && r.lease_owner !== owner) return false;
    r.lease_owner = owner;
    r.lease_expires_at = new Date(now.getTime() + leaseSeconds * 1000).toISOString();
    return true;
  }

  async releaseRun(id: string, owner: string) {
    const r = this.runs.find((x) => x.id === id);
    if (r && r.lease_owner === owner) {
      r.lease_owner = null;
      r.lease_expires_at = null;
    }
  }

  async listRunnableRuns(now: Date, limit: number) {
    return this.runs
      .filter((r) => !isTerminal(r.status))
      .filter((r) => !r.next_attempt_at || new Date(r.next_attempt_at) <= now)
      .filter((r) => !r.lease_expires_at || new Date(r.lease_expires_at) < now)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }

  async hasOtherActiveRun(workspaceId: string, excludeRunId: string) {
    const self = this.runs.find((r) => r.id === excludeRunId);
    return this.runs.some(
      (r) => r.workspace_id === workspaceId && r.id !== excludeRunId && !isTerminal(r.status) && (!self || r.created_at < self.created_at || r.status !== "queued"),
    );
  }

  async log(entry: StageLogInput) {
    this.logs.push(entry);
  }

  async loadContext(workspaceId: string): Promise<WorkspaceContext> {
    const settings = this.settings.get(workspaceId);
    if (!settings) throw new Error("workspace not found");
    return {
      workspaceId,
      workspaceName: "Test",
      settings: { ...settings },
      prefs: { ...DEFAULT_PREFERENCES, id: "pref-1" },
      wp: this.connections.get(workspaceId) ?? null,
    };
  }

  async listAutomatedWorkspaces(): Promise<AutomatedWorkspace[]> {
    return [...this.settings.values()]
      .filter((s) => s.automation_enabled)
      .map((s) => ({
        workspaceId: s.workspace_id,
        timezone: s.timezone,
        automationChangedAt: s.automation_changed_at,
        graceMinutes: s.missed_run_grace_minutes,
        publishingMode: s.publishing_mode,
        localTimes: this.schedules.get(s.workspace_id) ?? [],
      }));
  }

  async getSecretCiphertext(workspaceId: string, kind: string) {
    return this.secrets.get(`${workspaceId}:${kind}`) ?? null;
  }

  async insertCandidates(runId: string, workspaceId: string, round: number, input: CandidateInput[]) {
    const recs = input.map((c) => ({
      ...c,
      id: randomUUID(),
      run_id: runId,
      workspace_id: workspaceId,
      research_round: round,
      duplicate_of: null,
      created_at: this.now().toISOString(),
    }));
    this.candidates.push(...recs);
    return recs.map((r) => ({ ...r }));
  }

  async updateCandidate(id: string, patch: Partial<CandidateRecord>) {
    const c = this.candidates.find((x) => x.id === id);
    if (c) Object.assign(c, patch);
  }

  async listCandidates(runId: string) {
    return this.candidates.filter((c) => c.run_id === runId).map((c) => ({ ...c }));
  }

  async getCandidate(id: string) {
    const c = this.candidates.find((x) => x.id === id);
    return c ? { ...c } : null;
  }

  async upsertSources(_workspaceId: string, sources: SourceInput[]) {
    const out: SourceRecord[] = [];
    for (const s of sources) {
      let rec = this.sources.find((x) => x.url === s.url);
      if (!rec) {
        rec = { ...s, id: randomUUID() };
        this.sources.push(rec);
      } else {
        if (!rec.published_at && s.published_at) rec.published_at = s.published_at;
        if (!rec.title && s.title) rec.title = s.title;
        if (!rec.excerpt && s.excerpt) rec.excerpt = s.excerpt;
      }
      out.push({ ...rec });
    }
    return out;
  }

  async linkCandidateSources(candidateId: string, _ws: string, sourceIds: string[], origin: string) {
    for (const sid of sourceIds) {
      if (!this.candidateSources.some((x) => x.candidate_id === candidateId && x.source_id === sid)) {
        this.candidateSources.push({ candidate_id: candidateId, source_id: sid, origin });
      }
    }
  }

  async getCandidateSources(candidateId: string) {
    return this.candidateSources
      .filter((x) => x.candidate_id === candidateId)
      .map((x) => ({ ...this.sources.find((s) => s.id === x.source_id)!, origin: x.origin }));
  }

  async replaceClaims(_ws: string, candidateId: string, claims: ClaimInputRecord[]) {
    this.claims = this.claims.filter((c) => c.candidate_id !== candidateId);
    for (const c of claims) {
      this.claims.push({
        id: randomUUID(),
        candidate_id: candidateId,
        text: c.text,
        kind: c.kind,
        importance: c.importance,
        status: c.status,
        notes: c.notes,
        sources: c.sourceIds.map((id) => this.sources.find((s) => s.id === id)!).filter(Boolean),
      });
    }
  }

  async getClaims(candidateId: string) {
    return this.claims.filter((c) => c.candidate_id === candidateId);
  }

  async recentHeadlines(workspaceId: string, sinceIso: string) {
    return this.candidates.filter((c) => c.workspace_id === workspaceId && c.created_at >= sinceIso).map((c) => c.headline);
  }

  async upsertWpPosts(workspaceId: string, posts: ExistingPost[]) {
    for (const p of posts) {
      this.wpPosts = this.wpPosts.filter((x) => !(x.workspace_id === workspaceId && x.id === p.id));
      this.wpPosts.push({ ...p, workspace_id: workspaceId });
    }
  }

  async listWpPosts(workspaceId: string, limit: number) {
    return this.wpPosts.filter((p) => p.workspace_id === workspaceId).slice(0, limit);
  }

  async recordWpSync(event: Record<string, unknown>) {
    this.wpSync.push(event);
  }

  async createArticle(input: ArticleInput) {
    const a: ArticleRecord = {
      ...input,
      json_ld: input.json_ld ?? null,
      id: randomUUID(),
      created_at: this.now().toISOString(),
      publish_key: randomUUID().replace(/-/g, ""),
      quality_report: {},
      quality_score: null,
      publish_target: null,
      wp_post_id: null,
      wp_url: null,
      wp_status: null,
      wp_featured_media_id: null,
      wp_synced_at: null,
      seo_sync: {},
    };
    this.articles.push(a);
    return { ...a };
  }

  async updateArticle(id: string, patch: Partial<ArticleRecord>) {
    const a = this.articles.find((x) => x.id === id);
    if (a) Object.assign(a, patch);
  }

  async getArticle(id: string) {
    const a = this.articles.find((x) => x.id === id);
    return a ? { ...a } : null;
  }

  async findArticleForCandidate(runId: string, candidateId: string) {
    const a = this.articles.find((x) => x.run_id === runId && x.candidate_id === candidateId);
    return a ? { ...a } : null;
  }

  async runArticleStatuses(runId: string) {
    return this.articles.filter((a) => a.run_id === runId).map((a) => a.status);
  }

  async addRevision(articleId: string, _ws: string, source: string, headline: string, _body: string, changeSummary: string) {
    const revision = this.revisions.filter((r) => r.article_id === articleId).length + 1;
    this.revisions.push({ article_id: articleId, revision, source, headline, change_summary: changeSummary });
    return revision;
  }

  async listLocalArticles(workspaceId: string, limit: number): Promise<ExistingPost[]> {
    return this.articles
      .filter((a) => a.workspace_id === workspaceId && ["drafted", "published", "needs_review"].includes(a.status))
      .slice(-limit)
      .map((a, i) => ({ id: a.wp_post_id ?? -(i + 1), title: a.headline, slug: a.slug, link: a.wp_url ?? "", status: a.status, excerpt: a.excerpt, origin: "local" as const }));
  }

  async countProducedSince(workspaceId: string, sinceIso: string) {
    return this.articles.filter((a) => a.workspace_id === workspaceId && a.created_at >= sinceIso && ["drafted", "published", "needs_review"].includes(a.status)).length;
  }

  async recentCategoryCounts(workspaceId: string, sinceIso: string) {
    const out: Partial<Record<Category, number>> = {};
    for (const a of this.articles) {
      if (a.workspace_id === workspaceId && a.created_at >= sinceIso && ["drafted", "published"].includes(a.status)) {
        out[a.category] = (out[a.category] ?? 0) + 1;
      }
    }
    return out;
  }

  async getImage(articleId: string) {
    const i = this.images.find((x) => x.article_id === articleId);
    return i ? { ...i } : null;
  }

  async upsertImage(articleId: string, workspaceId: string, patch: Partial<ImageRecord> & { prompt: string; model: string }) {
    let i = this.images.find((x) => x.article_id === articleId);
    if (!i) {
      i = {
        id: randomUUID(),
        article_id: articleId,
        workspace_id: workspaceId,
        status: "pending",
        storage_path: null,
        width: null,
        height: null,
        mime_type: null,
        byte_size: null,
        alt_text: null,
        title: null,
        wp_media_id: null,
        wp_source_url: null,
        attempts: 0,
        error: null,
        ...patch,
      };
      this.images.push(i);
    } else Object.assign(i, patch);
    return { ...i };
  }

  async saveImageBytes(path: string, data: Buffer) {
    this.blobs.set(path, data);
  }

  async loadImageBytes(path: string) {
    const b = this.blobs.get(path);
    if (!b) throw new Error(`blob not found: ${path}`);
    return b;
  }

  async recordUsage(event: UsageEventInput) {
    this.usage.push(event);
  }

  async getPricing(workspaceId: string, model: string) {
    return this.pricing.filter((p) => p.workspace_id === workspaceId && p.model === model).sort((a, b) => b.version - a.version)[0] ?? null;
  }

  async notify(workspaceId: string, _runId: string | null, level: string, title: string, body: string) {
    this.notifications.push({ workspace_id: workspaceId, level, title, body });
  }

  async recordNonce(nonce: string, _source: string) {
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    return true;
  }
}
