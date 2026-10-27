import type { Category } from "@/lib/editorial/categories";
import type { SourceTier } from "@/lib/editorial/domains";
import type { ClaimKind, ClaimStatus } from "@/lib/editorial/evidence";
import type { EditorialPreferences } from "@/lib/editorial/preferences";
import type { ExistingPost } from "@/lib/editorial/dedupe";

export const STAGE_STATUSES = [
  "queued",
  "researching",
  "deduplicating",
  "fact_checking",
  "writing",
  "quality_check",
  "generating_image",
  "publishing",
] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const TERMINAL_STATUSES = [
  "published",
  "drafted",
  "dry_run_completed",
  "skipped",
  "duplicate",
  "needs_review",
  "failed",
  "missed",
  "cancelled",
] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];
export type RunStatus = StageStatus | TerminalStatus | "retry_scheduled";

export function isTerminal(s: string): s is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(s);
}

export type PublishingMode = "dry_run" | "draft_only" | "auto_publish";

export interface RunRecord {
  id: string;
  workspace_id: string;
  trigger: "schedule" | "manual" | "retry";
  slot_key: string | null;
  scheduled_for: string | null;
  status: RunStatus;
  resume_stage: StageStatus | null;
  publishing_mode: PublishingMode;
  started_at: string | null;
  completed_at: string | null;
  attempt: number;
  stage_attempt: number;
  next_attempt_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  research_round: number;
  candidates_checked: number;
  articles_produced: number;
  selected_candidate_id: string | null;
  article_id: string | null;
  outcome_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  triggered_by: string | null;
  created_at: string;
}

export interface WorkspaceSettings {
  workspace_id: string;
  timezone: string;
  automation_enabled: boolean;
  automation_changed_at: string;
  publishing_mode: PublishingMode;
  enabled_categories: Category[];
  max_articles_per_run: number;
  daily_article_limit: number;
  min_candidate_score: number;
  min_quality_score: number;
  target_words_min: number;
  target_words_max: number;
  max_research_rounds: number;
  max_candidates_per_run: number;
  image_failure_policy: "draft" | "fail";
  quality_fail_policy: "draft" | "fail";
  missed_run_grace_minutes: number;
  notify_on_failure: boolean;
  inject_json_ld: boolean;
  thumbnail_text_overlay: boolean;
  text_model: string | null;
  research_model: string | null;
  image_model: string | null;
}

export interface WordPressConnectionInfo {
  id: string;
  site_url: string;
  username: string;
  status: "untested" | "ok" | "error";
  seo_plugin: string | null;
  category_map: Partial<Record<Category, number>>;
}

export interface WorkspaceContext {
  workspaceId: string;
  workspaceName: string;
  settings: WorkspaceSettings;
  prefs: EditorialPreferences & { id: string };
  wp: WordPressConnectionInfo | null;
}

export interface SourceInput {
  url: string;
  domain: string;
  title: string | null;
  excerpt: string | null;
  published_at: string | null;
  quality_tier: SourceTier;
  quality_score: number;
}

export interface SourceRecord extends SourceInput {
  id: string;
}

export interface CandidateInput {
  category: Category;
  headline: string;
  topic: string;
  summary: string;
  evidence_summary: string;
  event_date: string | null;
  latest_source_at: string | null;
  entities: string[];
  suggested_format: string | null;
  confidence: "low" | "medium" | "high";
  duplicate_risk: "low" | "medium" | "high";
  scores: Record<string, unknown>;
  overall_score: number;
  rank: number;
  status: CandidateStatus;
  decision_reason: string | null;
}

export type CandidateStatus =
  | "discovered"
  | "ranked"
  | "below_threshold"
  | "selected"
  | "duplicate"
  | "needs_review"
  | "rejected"
  | "insufficient_evidence"
  | "drafted"
  | "published"
  | "dry_run";

export interface CandidateRecord extends CandidateInput {
  id: string;
  run_id: string;
  workspace_id: string;
  research_round: number;
  duplicate_of: Record<string, unknown> | null;
  created_at: string;
}

export interface ClaimInputRecord {
  text: string;
  kind: ClaimKind;
  importance: "high" | "normal";
  status: ClaimStatus;
  notes: string | null;
  sourceIds: string[];
}

export interface ClaimRecord {
  id: string;
  text: string;
  kind: ClaimKind;
  importance: "high" | "normal";
  status: ClaimStatus;
  notes: string | null;
  sources: SourceRecord[];
}

export interface ArticleRecord {
  id: string;
  workspace_id: string;
  run_id: string | null;
  candidate_id: string | null;
  category: Category;
  status: "writing" | "ready" | "needs_review" | "drafted" | "published" | "failed" | "dry_run";
  publishing_mode: PublishingMode;
  draft_headline: string | null;
  headline: string;
  seo_title: string;
  slug: string;
  meta_description: string;
  excerpt: string;
  primary_keyword: string;
  secondary_keywords: string[];
  entities: string[];
  tags: string[];
  body_html: string;
  faq: { question: string; answer: string }[];
  json_ld: Record<string, unknown> | null;
  word_count: number;
  seo_report: Record<string, unknown>;
  originality_report: Record<string, unknown>;
  quality_report: Record<string, unknown>;
  quality_score: number | null;
  publish_target: "none" | "draft" | "publish" | null;
  wp_post_id: number | null;
  wp_url: string | null;
  wp_status: string | null;
  wp_featured_media_id: number | null;
  wp_synced_at: string | null;
  seo_sync: Record<string, unknown>;
  publish_key: string;
  created_at: string;
}

export type ArticleInput = Omit<ArticleRecord, "id" | "created_at" | "publish_key" | "wp_post_id" | "wp_url" | "wp_status" | "wp_featured_media_id" | "wp_synced_at" | "seo_sync" | "publish_target" | "quality_score" | "quality_report" | "json_ld"> & {
  json_ld?: Record<string, unknown> | null;
};

export interface ImageRecord {
  id: string;
  article_id: string;
  workspace_id: string;
  prompt: string;
  model: string;
  status: "pending" | "generated" | "failed" | "uploaded";
  storage_path: string | null;
  width: number | null;
  height: number | null;
  mime_type: string | null;
  byte_size: number | null;
  alt_text: string | null;
  title: string | null;
  wp_media_id: number | null;
  wp_source_url: string | null;
  attempts: number;
  error: string | null;
}

export interface UsageEventInput {
  workspace_id: string;
  run_id: string | null;
  article_id: string | null;
  stage: string;
  action: "research" | "dedupe_semantic" | "fact_check" | "write" | "review" | "image" | "health_check";
  model: string;
  generation_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
  web_searches: number | null;
  images: number | null;
  cost_usd: number | null;
  cost_source: "provider_reported" | "estimated" | "unavailable";
  pricing_id: string | null;
  success: boolean;
  is_retry: boolean;
  latency_ms: number | null;
  raw_usage: Record<string, unknown>;
}

export interface StageLogInput {
  run_id: string;
  workspace_id: string;
  stage: string;
  attempt: number;
  level: "started" | "succeeded" | "failed" | "skipped" | "info" | "warning" | "decision";
  message: string;
  detail?: Record<string, unknown>;
  started_at?: string;
  finished_at?: string | null;
  duration_ms?: number | null;
}

export interface AutomatedWorkspace {
  workspaceId: string;
  timezone: string;
  automationChangedAt: string;
  graceMinutes: number;
  publishingMode: PublishingMode;
  localTimes: string[];
}

export interface NewRunInput {
  workspace_id: string;
  trigger: RunRecord["trigger"];
  slot_key: string | null;
  scheduled_for: string | null;
  status: "queued" | "missed";
  publishing_mode: PublishingMode;
  triggered_by: string | null;
  outcome_reason?: string | null;
}

/** Persistence boundary for the pipeline. Implemented by Supabase (prod) and memory (tests). */
export interface PipelineStore {
  // runs
  createRun(input: NewRunInput): Promise<RunRecord | null>;
  getRun(id: string): Promise<RunRecord | null>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<void>;
  claimRun(id: string, owner: string, leaseSeconds: number): Promise<boolean>;
  releaseRun(id: string, owner: string): Promise<void>;
  listRunnableRuns(now: Date, limit: number): Promise<RunRecord[]>;
  hasOtherActiveRun(workspaceId: string, excludeRunId: string): Promise<boolean>;
  log(entry: StageLogInput): Promise<void>;
  // workspace
  loadContext(workspaceId: string): Promise<WorkspaceContext>;
  listAutomatedWorkspaces(): Promise<AutomatedWorkspace[]>;
  getSecretCiphertext(workspaceId: string, kind: "wordpress_app_password" | "notification_webhook"): Promise<string | null>;
  // research
  insertCandidates(runId: string, workspaceId: string, round: number, input: CandidateInput[]): Promise<CandidateRecord[]>;
  updateCandidate(id: string, patch: Partial<CandidateRecord>): Promise<void>;
  listCandidates(runId: string): Promise<CandidateRecord[]>;
  getCandidate(id: string): Promise<CandidateRecord | null>;
  upsertSources(workspaceId: string, sources: SourceInput[]): Promise<SourceRecord[]>;
  linkCandidateSources(candidateId: string, workspaceId: string, sourceIds: string[], origin: "citation" | "model_claimed" | "fact_check"): Promise<void>;
  getCandidateSources(candidateId: string): Promise<(SourceRecord & { origin: string })[]>;
  replaceClaims(workspaceId: string, candidateId: string, claims: ClaimInputRecord[]): Promise<void>;
  getClaims(candidateId: string): Promise<ClaimRecord[]>;
  recentHeadlines(workspaceId: string, sinceIso: string): Promise<string[]>;
  // wordpress cache
  upsertWpPosts(workspaceId: string, posts: ExistingPost[]): Promise<void>;
  listWpPosts(workspaceId: string, limit: number): Promise<ExistingPost[]>;
  recordWpSync(event: { workspace_id: string; run_id: string | null; article_id: string | null; action: string; status: "ok" | "error" | "skipped"; wp_id: number | null; detail: Record<string, unknown> }): Promise<void>;
  // articles
  createArticle(input: ArticleInput): Promise<ArticleRecord>;
  updateArticle(id: string, patch: Partial<ArticleRecord>): Promise<void>;
  getArticle(id: string): Promise<ArticleRecord | null>;
  findArticleForCandidate(runId: string, candidateId: string): Promise<ArticleRecord | null>;
  runArticleStatuses(runId: string): Promise<string[]>;
  addRevision(articleId: string, workspaceId: string, source: "writer" | "revision" | "user", headline: string, bodyHtml: string, changeSummary: string): Promise<number>;
  listLocalArticles(workspaceId: string, limit: number): Promise<ExistingPost[]>;
  countProducedSince(workspaceId: string, sinceIso: string): Promise<number>;
  recentCategoryCounts(workspaceId: string, sinceIso: string): Promise<Partial<Record<Category, number>>>;
  // images
  getImage(articleId: string): Promise<ImageRecord | null>;
  upsertImage(articleId: string, workspaceId: string, patch: Partial<ImageRecord> & { prompt: string; model: string }): Promise<ImageRecord>;
  saveImageBytes(path: string, data: Buffer, mimeType: string): Promise<void>;
  loadImageBytes(path: string): Promise<Buffer>;
  // usage, notifications
  recordUsage(event: UsageEventInput): Promise<void>;
  getPricing(workspaceId: string, model: string): Promise<import("@/lib/costs/pricing").PricingRow | null>;
  notify(workspaceId: string, runId: string | null, level: "info" | "warning" | "error", title: string, body: string): Promise<void>;
  // scheduler
  recordNonce(nonce: string, source: string): Promise<boolean>;
}
