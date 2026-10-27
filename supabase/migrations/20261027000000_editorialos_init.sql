-- EditorialOS initial schema.
-- Reproducible on a fresh Supabase project. Contains NO secrets: scheduler
-- credentials are stored in Supabase Vault by supabase/scheduler/setup_cron.sql.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Profiles, workspaces, membership
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger workspaces_updated before update on public.workspaces
  for each row execute function public.set_updated_at();

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email text not null check (email = lower(email)),
  role text not null check (role in ('editor', 'viewer')),
  token_hash text not null unique,
  invited_by uuid references auth.users (id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index workspace_invitations_ws_idx on public.workspace_invitations (workspace_id);

-- Membership helpers. SECURITY DEFINER so policies on workspace_members do not recurse.
create or replace function public.is_member(ws uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid())
  )
$$;

create or replace function public.has_role(ws uuid, roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws and m.user_id = (select auth.uid()) and m.role = any (roles)
  )
$$;

-- ---------------------------------------------------------------------------
-- Settings, schedules, connections, secrets
-- ---------------------------------------------------------------------------
create table public.workspace_settings (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  timezone text not null default 'Asia/Kolkata',
  automation_enabled boolean not null default false,
  automation_changed_at timestamptz not null default now(),
  publishing_mode text not null default 'draft_only'
    check (publishing_mode in ('dry_run', 'draft_only', 'auto_publish')),
  auto_publish_confirmed_at timestamptz,
  auto_publish_confirmed_by uuid references auth.users (id) on delete set null,
  enabled_categories text[] not null default array['anime', 'gaming', 'esports']
    check (enabled_categories <@ array['anime', 'gaming', 'esports'] and cardinality(enabled_categories) >= 1),
  max_articles_per_run int not null default 1 check (max_articles_per_run between 1 and 3),
  daily_article_limit int not null default 3 check (daily_article_limit between 0 and 24),
  min_candidate_score numeric(4, 3) not null default 0.550 check (min_candidate_score between 0 and 1),
  min_quality_score numeric(4, 3) not null default 0.700 check (min_quality_score between 0 and 1),
  target_words_min int not null default 600 check (target_words_min between 150 and 3000),
  target_words_max int not null default 1200 check (target_words_max between 300 and 4000),
  max_research_rounds int not null default 2 check (max_research_rounds between 1 and 4),
  max_candidates_per_run int not null default 5 check (max_candidates_per_run between 1 and 12),
  image_failure_policy text not null default 'draft' check (image_failure_policy in ('draft', 'fail')),
  quality_fail_policy text not null default 'draft' check (quality_fail_policy in ('draft', 'fail')),
  missed_run_grace_minutes int not null default 90 check (missed_run_grace_minutes between 10 and 360),
  notify_on_failure boolean not null default true,
  inject_json_ld boolean not null default false,
  thumbnail_text_overlay boolean not null default false,
  text_model text check (text_model is null or text_model like 'google/%'),
  research_model text check (research_model is null or research_model like 'google/%'),
  image_model text check (image_model is null or image_model like 'google/%'),
  updated_at timestamptz not null default now(),
  check (target_words_min < target_words_max)
);
create trigger workspace_settings_updated before update on public.workspace_settings
  for each row execute function public.set_updated_at();

create table public.schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  local_time time not null,
  label text not null default '' check (char_length(label) <= 40),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id, local_time)
);

create table public.wordpress_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces (id) on delete cascade,
  site_url text not null check (site_url ~ '^https://'),
  username text not null check (char_length(username) between 1 and 120),
  status text not null default 'untested' check (status in ('untested', 'ok', 'error')),
  last_tested_at timestamptz,
  last_error text,
  seo_plugin text,
  capabilities jsonb not null default '{}'::jsonb,
  category_map jsonb not null default '{}'::jsonb,
  credential_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger wordpress_connections_updated before update on public.wordpress_connections
  for each row execute function public.set_updated_at();

-- Encrypted secrets (AES-256-GCM, app-side). RLS on with NO policies:
-- only the service role (server) can read or write this table.
create table public.workspace_secrets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null check (kind in ('wordpress_app_password', 'notification_webhook')),
  ciphertext text not null,
  key_id text not null,
  updated_at timestamptz not null default now(),
  unique (workspace_id, kind)
);

-- ---------------------------------------------------------------------------
-- Runs (durable job ledger) and stage logs
-- ---------------------------------------------------------------------------
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  trigger text not null check (trigger in ('schedule', 'manual', 'retry')),
  slot_key text,
  scheduled_for timestamptz,
  status text not null default 'queued' check (status in (
    'queued', 'researching', 'deduplicating', 'fact_checking', 'writing', 'quality_check',
    'generating_image', 'publishing', 'published', 'drafted', 'dry_run_completed',
    'skipped', 'duplicate', 'needs_review', 'failed', 'retry_scheduled', 'missed', 'cancelled')),
  resume_stage text,
  publishing_mode text not null check (publishing_mode in ('dry_run', 'draft_only', 'auto_publish')),
  started_at timestamptz,
  completed_at timestamptz,
  attempt int not null default 0,
  stage_attempt int not null default 0,
  next_attempt_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  research_round int not null default 0,
  candidates_checked int not null default 0,
  articles_produced int not null default 0,
  selected_candidate_id uuid,
  article_id uuid,
  outcome_reason text,
  error_code text,
  error_message text,
  triggered_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, slot_key)
);
create index runs_ws_created_idx on public.runs (workspace_id, created_at desc);
create index runs_active_idx on public.runs (status, next_attempt_at)
  where status not in ('published', 'drafted', 'dry_run_completed', 'skipped', 'duplicate',
                       'needs_review', 'failed', 'missed', 'cancelled');
create trigger runs_updated before update on public.runs
  for each row execute function public.set_updated_at();

create table public.run_stage_logs (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.runs (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  stage text not null,
  attempt int not null default 1,
  level text not null check (level in ('started', 'succeeded', 'failed', 'skipped', 'info', 'warning', 'decision')),
  message text not null,
  detail jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms int
);
create index run_stage_logs_run_idx on public.run_stage_logs (run_id, id);
create index run_stage_logs_ws_idx on public.run_stage_logs (workspace_id, started_at desc);

-- ---------------------------------------------------------------------------
-- Research: candidates, sources, claims
-- ---------------------------------------------------------------------------
create table public.topic_candidates (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid not null references public.runs (id) on delete cascade,
  research_round int not null default 0,
  category text not null check (category in ('anime', 'gaming', 'esports')),
  headline text not null,
  topic text not null,
  summary text not null,
  evidence_summary text not null default '',
  event_date date,
  latest_source_at timestamptz,
  entities text[] not null default '{}',
  suggested_format text,
  confidence text check (confidence in ('low', 'medium', 'high')),
  duplicate_risk text check (duplicate_risk in ('low', 'medium', 'high')),
  scores jsonb not null default '{}'::jsonb,
  overall_score numeric(5, 4),
  rank int,
  status text not null default 'discovered' check (status in (
    'discovered', 'ranked', 'below_threshold', 'selected', 'duplicate', 'needs_review',
    'rejected', 'insufficient_evidence', 'drafted', 'published', 'dry_run')),
  decision_reason text,
  duplicate_of jsonb,
  created_at timestamptz not null default now()
);
create index topic_candidates_ws_idx on public.topic_candidates (workspace_id, created_at desc);
create index topic_candidates_run_idx on public.topic_candidates (run_id, rank);

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  url text not null check (url ~ '^https?://'),
  domain text not null,
  title text,
  excerpt text check (char_length(excerpt) <= 2000),
  published_at timestamptz,
  quality_tier text not null default 'unknown' check (quality_tier in ('official', 'established', 'standard', 'unknown', 'low')),
  quality_score numeric(4, 3) not null default 0.4,
  first_seen_at timestamptz not null default now(),
  unique (workspace_id, url)
);

create table public.candidate_sources (
  candidate_id uuid not null references public.topic_candidates (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  origin text not null default 'citation' check (origin in ('citation', 'model_claimed', 'fact_check')),
  primary key (candidate_id, source_id)
);

create table public.claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  candidate_id uuid not null references public.topic_candidates (id) on delete cascade,
  text text not null,
  kind text not null check (kind in ('fact', 'rumor', 'prediction', 'opinion', 'quote')),
  importance text not null default 'normal' check (importance in ('high', 'normal')),
  status text not null check (status in ('confirmed', 'primary_confirmed', 'single_source', 'conflicting', 'unverified')),
  notes text,
  created_at timestamptz not null default now()
);
create index claims_candidate_idx on public.claims (candidate_id);

create table public.claim_sources (
  claim_id uuid not null references public.claims (id) on delete cascade,
  source_id uuid not null references public.sources (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  primary key (claim_id, source_id)
);

-- ---------------------------------------------------------------------------
-- Articles, revisions, images, WordPress sync
-- ---------------------------------------------------------------------------
create table public.articles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid references public.runs (id) on delete set null,
  candidate_id uuid references public.topic_candidates (id) on delete set null,
  category text not null check (category in ('anime', 'gaming', 'esports')),
  status text not null default 'writing' check (status in (
    'writing', 'ready', 'needs_review', 'drafted', 'published', 'failed', 'dry_run')),
  publishing_mode text not null check (publishing_mode in ('dry_run', 'draft_only', 'auto_publish')),
  draft_headline text,
  headline text not null,
  seo_title text not null,
  slug text not null,
  meta_description text not null,
  excerpt text not null,
  primary_keyword text not null,
  secondary_keywords text[] not null default '{}',
  entities text[] not null default '{}',
  tags text[] not null default '{}',
  body_html text not null,
  faq jsonb not null default '[]'::jsonb,
  json_ld jsonb,
  word_count int not null default 0,
  seo_report jsonb not null default '{}'::jsonb,
  originality_report jsonb not null default '{}'::jsonb,
  quality_report jsonb not null default '{}'::jsonb,
  quality_score numeric(4, 3),
  publish_target text check (publish_target in ('none', 'draft', 'publish')),
  wp_post_id bigint,
  wp_url text,
  wp_status text,
  wp_featured_media_id bigint,
  wp_synced_at timestamptz,
  seo_sync jsonb not null default '{}'::jsonb,
  publish_key text not null default replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index articles_ws_created_idx on public.articles (workspace_id, created_at desc);
create unique index articles_ws_wp_post_idx on public.articles (workspace_id, wp_post_id) where wp_post_id is not null;
create trigger articles_updated before update on public.articles
  for each row execute function public.set_updated_at();

create table public.article_revisions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  revision int not null,
  source text not null check (source in ('writer', 'revision', 'user')),
  headline text not null,
  body_html text not null,
  change_summary text not null default '',
  created_at timestamptz not null default now(),
  unique (article_id, revision)
);

create table public.article_images (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null unique references public.articles (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  prompt text not null,
  model text not null,
  status text not null default 'pending' check (status in ('pending', 'generated', 'failed', 'uploaded')),
  storage_path text,
  width int,
  height int,
  mime_type text,
  byte_size int,
  alt_text text,
  title text,
  wp_media_id bigint,
  wp_source_url text,
  attempts int not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger article_images_updated before update on public.article_images
  for each row execute function public.set_updated_at();

-- Cache of the live WordPress site's posts. Refreshed before every dedupe check;
-- never treated as the sole source of truth.
create table public.wp_posts (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  wp_id bigint not null,
  slug text not null,
  title text not null,
  link text not null,
  status text not null,
  date_gmt timestamptz,
  modified_gmt timestamptz,
  excerpt text not null default '',
  synced_at timestamptz not null default now(),
  primary key (workspace_id, wp_id)
);
create index wp_posts_ws_date_idx on public.wp_posts (workspace_id, date_gmt desc);

create table public.wp_sync_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid references public.runs (id) on delete set null,
  article_id uuid references public.articles (id) on delete set null,
  action text not null,
  status text not null check (status in ('ok', 'error', 'skipped')),
  wp_id bigint,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index wp_sync_events_ws_idx on public.wp_sync_events (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Usage, pricing, feedback, preferences
-- ---------------------------------------------------------------------------
create table public.model_pricing (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  model text not null,
  version int not null,
  input_per_mtok numeric(12, 6),
  output_per_mtok numeric(12, 6),
  per_web_search numeric(12, 6),
  per_image numeric(12, 6),
  source_note text not null default '',
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, model, version)
);

create table public.usage_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid references public.runs (id) on delete set null,
  article_id uuid references public.articles (id) on delete set null,
  stage text not null,
  action text not null check (action in ('research', 'dedupe_semantic', 'fact_check', 'write', 'review', 'image', 'health_check')),
  provider text not null default 'openrouter',
  model text not null,
  generation_id text,
  input_tokens int,
  output_tokens int,
  reasoning_tokens int,
  cached_tokens int,
  web_searches int,
  images int,
  cost_usd numeric(12, 6),
  cost_source text not null check (cost_source in ('provider_reported', 'estimated', 'unavailable')),
  pricing_id uuid references public.model_pricing (id) on delete set null,
  success boolean not null,
  is_retry boolean not null default false,
  latency_ms int,
  raw_usage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index usage_events_ws_created_idx on public.usage_events (workspace_id, created_at desc);
create index usage_events_article_idx on public.usage_events (article_id);
create index usage_events_run_idx on public.usage_events (run_id);

create table public.topic_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  candidate_id uuid not null references public.topic_candidates (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  verdict text not null check (verdict in ('interesting', 'irrelevant', 'already_covered', 'needs_research')),
  note text check (char_length(note) <= 500),
  created_at timestamptz not null default now(),
  unique (candidate_id, user_id)
);
create index topic_feedback_ws_idx on public.topic_feedback (workspace_id, created_at desc);

create table public.editorial_preferences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  version int not null,
  active boolean not null default false,
  source text not null check (source in ('default', 'learning', 'manual', 'revert')),
  scoring_weights jsonb not null,
  category_weights jsonb not null,
  entity_adjustments jsonb not null default '{}'::jsonb,
  blocked_terms text[] not null default '{}',
  change_summary text not null default '',
  signals jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (workspace_id, version)
);
create unique index editorial_preferences_active_idx on public.editorial_preferences (workspace_id) where active;

create table public.notifications (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  run_id uuid references public.runs (id) on delete set null,
  level text not null check (level in ('info', 'warning', 'error')),
  title text not null,
  body text not null default '',
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_ws_idx on public.notifications (workspace_id, created_at desc);

create table public.audit_log (
  id bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_user_action_idx on public.audit_log (user_id, action, created_at desc);
create index audit_log_ws_idx on public.audit_log (workspace_id, created_at desc);

-- Scheduler replay protection: each signed tick carries a unique nonce.
create table public.scheduler_invocations (
  nonce text primary key,
  source text not null,
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.workspace_settings enable row level security;
alter table public.schedules enable row level security;
alter table public.wordpress_connections enable row level security;
alter table public.workspace_secrets enable row level security;
alter table public.runs enable row level security;
alter table public.run_stage_logs enable row level security;
alter table public.topic_candidates enable row level security;
alter table public.sources enable row level security;
alter table public.candidate_sources enable row level security;
alter table public.claims enable row level security;
alter table public.claim_sources enable row level security;
alter table public.articles enable row level security;
alter table public.article_revisions enable row level security;
alter table public.article_images enable row level security;
alter table public.wp_posts enable row level security;
alter table public.wp_sync_events enable row level security;
alter table public.model_pricing enable row level security;
alter table public.usage_events enable row level security;
alter table public.topic_feedback enable row level security;
alter table public.editorial_preferences enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_log enable row level security;
alter table public.scheduler_invocations enable row level security;

-- Secrets and scheduler nonces: service role only.
revoke all on public.workspace_secrets from anon, authenticated;
revoke all on public.scheduler_invocations from anon, authenticated;

create policy profiles_self_select on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_self_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy workspaces_member_select on public.workspaces for select to authenticated
  using (public.is_member(id));
create policy workspaces_owner_update on public.workspaces for update to authenticated
  using (public.has_role(id, array['owner'])) with check (public.has_role(id, array['owner']));

create policy members_select on public.workspace_members for select to authenticated
  using (public.is_member(workspace_id));
create policy members_owner_update on public.workspace_members for update to authenticated
  using (public.has_role(workspace_id, array['owner'])) with check (public.has_role(workspace_id, array['owner']));
create policy members_owner_delete on public.workspace_members for delete to authenticated
  using (public.has_role(workspace_id, array['owner']) and user_id <> (select auth.uid()));

create policy invitations_owner_all on public.workspace_invitations for all to authenticated
  using (public.has_role(workspace_id, array['owner'])) with check (public.has_role(workspace_id, array['owner']));

create policy settings_member_select on public.workspace_settings for select to authenticated
  using (public.is_member(workspace_id));
create policy settings_owner_update on public.workspace_settings for update to authenticated
  using (public.has_role(workspace_id, array['owner'])) with check (public.has_role(workspace_id, array['owner']));

create policy schedules_member_select on public.schedules for select to authenticated
  using (public.is_member(workspace_id));
create policy schedules_owner_write on public.schedules for all to authenticated
  using (public.has_role(workspace_id, array['owner'])) with check (public.has_role(workspace_id, array['owner']));

create policy wpconn_member_select on public.wordpress_connections for select to authenticated
  using (public.is_member(workspace_id));
create policy wpconn_owner_update on public.wordpress_connections for update to authenticated
  using (public.has_role(workspace_id, array['owner'])) with check (public.has_role(workspace_id, array['owner']));

create policy pricing_member_select on public.model_pricing for select to authenticated
  using (public.is_member(workspace_id));
create policy pricing_owner_insert on public.model_pricing for insert to authenticated
  with check (public.has_role(workspace_id, array['owner']));
create policy pricing_owner_update on public.model_pricing for update to authenticated
  using (public.has_role(workspace_id, array['owner'])) with check (public.has_role(workspace_id, array['owner']));

create policy feedback_member_select on public.topic_feedback for select to authenticated
  using (public.is_member(workspace_id));
create policy feedback_editor_insert on public.topic_feedback for insert to authenticated
  with check (user_id = (select auth.uid()) and public.has_role(workspace_id, array['owner', 'editor']));
create policy feedback_own_update on public.topic_feedback for update to authenticated
  using (user_id = (select auth.uid()) and public.has_role(workspace_id, array['owner', 'editor']))
  with check (user_id = (select auth.uid()) and public.has_role(workspace_id, array['owner', 'editor']));
create policy feedback_own_delete on public.topic_feedback for delete to authenticated
  using (user_id = (select auth.uid()));

create policy notifications_member_select on public.notifications for select to authenticated
  using (public.is_member(workspace_id));
create policy notifications_editor_update on public.notifications for update to authenticated
  using (public.has_role(workspace_id, array['owner', 'editor']))
  with check (public.has_role(workspace_id, array['owner', 'editor']));

create policy audit_owner_select on public.audit_log for select to authenticated
  using (public.has_role(workspace_id, array['owner']));

-- Read-only (for members) pipeline tables; all writes happen server-side with the service role.
do $$
declare t text;
begin
  foreach t in array array[
    'runs', 'run_stage_logs', 'topic_candidates', 'sources', 'candidate_sources', 'claims',
    'claim_sources', 'articles', 'article_revisions', 'article_images', 'wp_posts',
    'wp_sync_events', 'usage_events', 'editorial_preferences'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_member(workspace_id))',
      t || '_member_select', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Default editorial preference values (version 1). Mirrors src/lib/editorial/preferences.ts.
create or replace function public.default_scoring_weights()
returns jsonb language sql immutable set search_path = '' as $$
  select '{"recency":0.25,"source_quality":0.25,"relevance":0.2,"originality":0.15,"corroboration":0.15}'::jsonb
$$;

create or replace function public.create_workspace(p_name text, p_timezone text default 'Asia/Kolkata')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  ws uuid;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if (select count(*) from public.workspace_members where user_id = uid and role = 'owner') >= 5 then
    raise exception 'workspace limit reached' using errcode = 'P0001';
  end if;
  insert into public.workspaces (name, created_by) values (p_name, uid) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role) values (ws, uid, 'owner');
  insert into public.workspace_settings (workspace_id, timezone) values (ws, coalesce(p_timezone, 'Asia/Kolkata'));
  insert into public.schedules (workspace_id, local_time, label) values
    (ws, '09:00', 'Morning'), (ws, '13:00', 'Afternoon'), (ws, '19:00', 'Evening');
  insert into public.editorial_preferences
    (workspace_id, version, active, source, scoring_weights, category_weights, change_summary)
  values (ws, 1, true, 'default', public.default_scoring_weights(),
          '{"anime":1,"gaming":1,"esports":1}'::jsonb, 'Initial default preferences');
  return ws;
end $$;
revoke execute on function public.create_workspace(text, text) from anon;
grant execute on function public.create_workspace(text, text) to authenticated;

-- Accept an invitation. The token hash is computed server-side (SHA-256).
create or replace function public.accept_invitation(p_token_hash text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  em text := lower(coalesce((select auth.jwt()) ->> 'email', ''));
  inv public.workspace_invitations%rowtype;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into inv from public.workspace_invitations
    where token_hash = p_token_hash and accepted_at is null and revoked_at is null and expires_at > now()
    for update;
  if not found then
    raise exception 'invitation invalid or expired' using errcode = 'P0002';
  end if;
  if inv.email <> em then
    raise exception 'invitation was issued to a different email address' using errcode = '42501';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role)
    values (inv.workspace_id, uid, inv.role)
    on conflict (workspace_id, user_id) do nothing;
  update public.workspace_invitations set accepted_at = now(), accepted_by = uid where id = inv.id;
  return inv.workspace_id;
end $$;
revoke execute on function public.accept_invitation(text) from anon;
grant execute on function public.accept_invitation(text) to authenticated;

-- Atomically claim a run lease. Returns true if this owner now holds the lease.
create or replace function public.claim_run(p_run_id uuid, p_owner text, p_lease_seconds int)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.runs
     set lease_owner = p_owner,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   where id = p_run_id
     and (lease_expires_at is null or lease_expires_at < now() or lease_owner = p_owner)
     and status not in ('published', 'drafted', 'dry_run_completed', 'skipped', 'duplicate',
                        'needs_review', 'failed', 'missed', 'cancelled');
  get diagnostics n = row_count;
  return n = 1;
end $$;

create or replace function public.release_run(p_run_id uuid, p_owner text)
returns void language sql security definer set search_path = '' as $$
  update public.runs set lease_owner = null, lease_expires_at = null
   where id = p_run_id and lease_owner = p_owner
$$;

revoke execute on function public.claim_run(uuid, text, int) from public, anon, authenticated;
revoke execute on function public.release_run(uuid, text) from public, anon, authenticated;

-- Profile row for every new auth user.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Private storage bucket for generated thumbnails (served to the dashboard via signed URLs).
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public) values ('thumbnails', 'thumbnails', false)
    on conflict (id) do nothing;
  end if;
end $$;
