-- One run per category per slot, and editor-defined topics that get one
-- article a day until their end date.

create table public.editorial_topics (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null check (char_length(title) between 3 and 160),
  category text not null check (category in ('anime', 'gaming', 'esports')),
  notes text not null default '' check (char_length(notes) <= 600),
  end_date date not null,
  -- null: runs in the workspace's normal schedule slots; otherwise its own daily time.
  local_time time,
  enabled boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index editorial_topics_ws_idx on public.editorial_topics (workspace_id, end_date desc);
create trigger editorial_topics_updated before update on public.editorial_topics
  for each row execute function public.set_updated_at();

alter table public.editorial_topics enable row level security;
create policy editorial_topics_member_select on public.editorial_topics for select to authenticated
  using (public.is_member(workspace_id));
create policy editorial_topics_editor_insert on public.editorial_topics for insert to authenticated
  with check (public.has_role(workspace_id, array['owner', 'editor']));
create policy editorial_topics_editor_update on public.editorial_topics for update to authenticated
  using (public.has_role(workspace_id, array['owner', 'editor']))
  with check (public.has_role(workspace_id, array['owner', 'editor']));
create policy editorial_topics_editor_delete on public.editorial_topics for delete to authenticated
  using (public.has_role(workspace_id, array['owner', 'editor']));

-- What a run is for: one category, one topic, or (legacy rows) every enabled category.
alter table public.runs
  add column category text check (category in ('anime', 'gaming', 'esports')),
  add column topic_id uuid references public.editorial_topics (id) on delete set null,
  -- 0 = normal search, 1 = wider search (more rounds, last 7 days), 2 = feature/explainer fallback.
  add column escalation int not null default 0 check (escalation between 0 and 2);
create index runs_topic_idx on public.runs (topic_id, created_at desc) where topic_id is not null;

alter table public.articles
  add column topic_id uuid references public.editorial_topics (id) on delete set null;
create index articles_topic_idx on public.articles (topic_id, created_at desc) where topic_id is not null;
