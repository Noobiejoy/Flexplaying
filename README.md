# EditorialOS

EditorialOS is an autonomous editorial desk for an existing WordPress site. Three times a day, at 09:00, 13:00 and 19:00 Asia/Kolkata by default, it:

1. Researches recent **Anime, Gaming and Esports** stories using web-grounded Google models through OpenRouter.
2. Ranks the candidates with a transparent scoring model.
3. Checks the live WordPress site for duplicates. If a candidate is already covered, it moves to the next one.
4. Fact-checks the chosen story into a claim-to-source ledger.
5. Writes an original article, then validates its SEO/AEO fields and originality.
6. Generates a 16:9 thumbnail.
7. Runs a final quality gate.
8. Publishes, saves a draft, or does nothing (a dry run), depending on the workspace's publishing mode.

The scheduler runs in the database, so nobody needs to open the dashboard. The dashboard exists to show what the agent did and to let you control it.

> **Product name** is configurable with `NEXT_PUBLIC_PRODUCT_NAME`.

---

## Architecture

```
 Supabase Cron (pg_cron, every 5 min)
   └─ editorialos_tick()  ── signed POST (HMAC + nonce) ──▶  Vercel: /api/cron/tick
                                                              │  1. verify signature, reject replays
                                                              │  2. materialise due slots (unique per workspace+slot)
                                                              │  3. lease one run per workspace, advance stages
                                                              ▼
 ┌──────────────────────────── durable pipeline (state in Postgres) ───────────────────────────┐
 │ queued → researching → deduplicating → fact_checking → writing → quality_check →            │
 │          generating_image → publishing → published | drafted | dry_run_completed            │
 │ side exits: skipped · duplicate · needs_review · failed · retry_scheduled · missed · cancelled│
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
        │ OpenRouter (google/* only, provider pinned to google-vertex / google-ai-studio)
        │   • research + fact-check: openrouter:web_search server tool → url_citation annotations
        │   • writing / review / semantic dedupe: structured JSON output
        │   • thumbnails: modalities [image,text], image_config.aspect_ratio 16:9 → sharp → 1200×675 JPEG
        │ WordPress REST API (Application Password over HTTPS)
        │   • posts (all statuses, paginated) · media · tags · categories · Yoast/Rank Math detection
        ▼
 Next.js 16 dashboard (App Router, RSC, server actions) ── Supabase Auth + RLS ── per-workspace data
```

| Layer | Choice | Why |
|---|---|---|
| App | Next.js 16 App Router, TypeScript (strict), Tailwind v4 | Server components and server actions keep every privileged call server-side |
| Auth and data | Supabase Auth, Postgres, RLS, Storage, Vault | Auth, tenant isolation, job ledger, thumbnails and scheduler secrets on one platform |
| Scheduler | Supabase Cron → signed HTTP tick | Vercel Hobby cron only runs once a day; Supabase Cron runs every 5 minutes on every plan |
| AI | OpenRouter → Google models only | Per your instructions; `provider.only` pins requests to Google infrastructure with fallbacks off |
| Hosting | Vercel (`bom1` Mumbai, next to the Supabase `ap-south-1` project) | Git-based deploys; Fluid Compute allows a 300 s function duration |

### Durability and correctness

- **Resumable stages.** The result of each stage is written to Postgres before the next stage starts. If a stage starts but its request dies, the run lease expires (330 s) and the next tick resumes **at that stage**. Earlier stages are not repeated.
- **No duplicate execution.** Slots are keyed `"<local date>T<HH:MM>"`, with `unique (workspace_id, slot_key)`. Runs are claimed with the atomic `claim_run()` lease, and only one active run per workspace is advanced at a time.
- **No duplicate publishing.** Every article carries a hidden `<!-- editorialos:<publish_key> -->` marker. Before creating a post, the publisher searches WordPress for the marker. If the response to an earlier create was lost, it adopts the existing post. Media uploads are reconciled the same way. After writing, it reads the post back and checks the ID, status, permalink and featured media.
- **Retries.** Transient errors (429/5xx/timeouts/malformed model output) retry with 2, 8 and 20 minute backoff, at most 3 attempts per stage. Permanent errors (auth, out of credits, unavailable model, unmapped category) fail immediately with a clear code. Failed runs can be retried from the failed stage in the dashboard.
- **Missed runs.** If no tick arrives within the grace window (default 90 minutes), the slot is recorded as `missed` and an alert is raised.
- **Pause and resume.** Pausing stops new slots and cancels queued scheduled runs. Resuming starts again from the next slot. It never back-fills slots that passed while paused.

### Editorial safeguards

- **Untrusted content.** Web content is treated as data, never as instructions. Source pages are fetched only to confirm they exist and to read title and date metadata. Page text is never passed to the model.
- **Source verification.** A URL the model claims as a source must appear in the search citations or resolve to a real page. Otherwise it is discarded as possibly fabricated.
- **Evidence policy.** Key facts need two independent reliable domains, or one official primary source. Single-source claims may only appear with attribution. Unverified claims are excluded. If more than one key claim conflicts across sources, the story is rejected.
- **Generated HTML is sanitised.** Tags come from an allow-list. Links are allowed only to verified sources or to existing site posts; anything else is unwrapped to plain text. Scripts and event handlers are removed.
- **Quality gate.** Deterministic checks (SEO fields, originality shingle overlap, duplicate recheck, invented-quote detection) are combined with an AI review against the claim list. A failed gate never auto-publishes. Depending on policy, the article is saved as a draft for review or the run stops.
- **No forced output.** If nothing meets the threshold, the run is skipped.

---

## Repository layout

```
supabase/migrations/       schema, RLS policies, RPCs (create_workspace, accept_invitation, claim_run)
supabase/scheduler/        setup_cron.sql (pg_cron + pg_net + Vault; run once, contains placeholders only)
src/lib/pipeline/          engine (state machine), stages/*, prompts, Supabase + in-memory stores
src/lib/ai/                OpenRouter client (Google-only), JSON extraction, mock provider
src/lib/wordpress/         REST client (pagination, media, tags, SEO plugin detection), URL guard, mock
src/lib/editorial/         scoring, dedupe, evidence, SEO, schema.org, originality, sanitiser, learning
src/lib/schedule|scheduler timezone slot maths, HMAC verification, tick
src/app/(app)/             overview, activity, research, articles, costs, learning, settings, profile
src/app/actions/           server actions (all re-check role server-side; RLS enforces again)
tests/                     84+ tests: pipeline (mocked), Postgres/RLS (PGlite), clients, scheduler, editorial
```

---

## Setup

### 1. Supabase

1. Production project: **EditorialOS** (`hulycdfkvjqjhusgvuqz`, ap-south-1 Mumbai). Its migrations and scheduler are already applied. For a fresh project, continue with step 2.
2. Apply the migrations in order: `supabase db push` with the Supabase CLI linked to the project, or paste each file in `supabase/migrations/` into the SQL editor.
3. In **Authentication → URL configuration**, set Site URL to your `APP_BASE_URL` and add `APP_BASE_URL/auth/callback` to the redirect URLs.
4. Copy the project URL, the **publishable key** and the **secret key** from **Project Settings → API Keys**.

### 2. Environment variables

See `.env.example`. Where each variable belongs:

| Variable | Local `.env.local` | Vercel | Supabase Vault |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | ✓ | ✓ | |
| `SUPABASE_SECRET_KEY` | ✓ | ✓ (server) | |
| `OPENROUTER_API_KEY` and `OPENROUTER_*` models | ✓ | ✓ (server) | |
| `CREDENTIALS_ENCRYPTION_KEY` (`openssl rand -base64 32`) | ✓ | ✓ (server) | |
| `CRON_SECRET` (`openssl rand -hex 32`) | ✓ | ✓ (server) | ✓ as `editorialos_cron_secret` |
| `APP_BASE_URL` | `http://localhost:3000` | ✓ | ✓ as `editorialos_app_url` |

The `/setup` page shows which values are present, never the values themselves.

### 3. Deploy to Vercel

Import the GitHub repo in Vercel (framework: Next.js; region `sin1` is set in `vercel.json`), add the environment variables, and deploy. Fluid Compute must be enabled (it is the default for new projects) for the 300 s `maxDuration` on `/api/cron/tick`.

### 4. Scheduler

Edit the two placeholders in `supabase/scheduler/setup_cron.sql` and run it **once** in the Supabase SQL editor. Don't commit the edited copy. It stores the URL and secret in Vault and schedules `editorialos-tick` every 5 minutes. To verify, run `select public.editorialos_tick();` and check that **Settings → Integration health → Scheduler** shows a recent tick.

### 5. First use

1. Sign up, then create a workspace (timezone defaults to Asia/Kolkata).
2. **Settings → WordPress**: enter `https://flexplaying.com`, a WordPress username and an **Application Password** (see `docs/WORDPRESS.md`). The connection is tested, the password is encrypted with AES-256-GCM, and categories are auto-mapped. Check the Anime / Gaming / Esports mapping.
3. Start a **Dry run** from Live activity and watch the trace.
4. Keep **Draft only** (the default) for a few days and review the drafts in WordPress.
5. Turn on **Automation** on the Overview page.
6. When you trust the output, switch to **Auto-publish** (you must type a confirmation).

---

## Development

```bash
npm ci
cp .env.example .env.local      # fill in values
npm run dev                     # http://localhost:3000
npm run lint && npm run typecheck && npm test && npm run build
```

Automated tests never call OpenRouter or WordPress. They use the scriptable `MockAiProvider` and `MockWordPress`, plus PGlite (Postgres compiled to WASM), which runs the real migration and RLS policies. `EDITORIALOS_MOCK_PROVIDERS=true` (development only) swaps in an in-memory WordPress so you can exercise the pipeline without touching the real site.

Manual end-to-end checks with real credentials: `docs/E2E_TESTING.md`. Deployment, key rotation and recovery: `docs/DEPLOYMENT.md`.

---

## Costs (estimates; verify current prices)

| Service | What uses it | Expected cost |
|---|---|---|
| OpenRouter → Google models | ~6–9 text calls per run (3 research calls with web search, 1 fact-check with web search, 1–2 writing, 1 review, 0–2 dedupe) plus 1 image | Third-party pricing reports (unverified; Oct 2026) put Gemini 3.x Flash at about $0.75 / $3.75 per 1M input/output tokens, with Google Search grounding free for the first 5,000 requests/month and about $14 per 1,000 after that. Image pricing for the default image model is **unknown**. A run plausibly costs a few cents, but the dashboard records OpenRouter's reported per-call cost, so use the Costs page for real figures. |
| Supabase | DB, Auth, Storage, Cron | Free plan works, but free projects **pause after inactivity**. The scheduler's own ticks may not count as activity. The Pro plan (about $25/month) avoids pausing. |
| Vercel | Dashboard + tick endpoint | Hobby is enough for function duration. Hobby is for non-commercial use, so a monetised site may require Pro (about $20/month). About 290 tick invocations per day fit Hobby limits. |
| WordPress / Hostinger | Existing hosting | No change |

All workspaces share the server's OpenRouter key, so **all AI charges go to the key's owner**. The per-workspace breakdown is for visibility only.

---

## Known limitations and honest notes

- **Yoast SEO** is active on flexplaying.com. By default, Yoast's meta fields (`_yoast_wpseo_metadesc`, etc.) can't be written through the REST API. EditorialOS writes them, reads `yoast_head_json` back, and records `written` or `not_writable` on each article. `docs/WORDPRESS.md` has an optional snippet that makes them writable. JSON-LD is not injected because Yoast already outputs Article schema.
- **Rank Math** writes go through its `rankmath/v1/updateMeta` endpoint and are recorded as `written_unverified`.
- **Web search** runs through OpenRouter's `openrouter:web_search` tool. With Google models and no engine set, OpenRouter documents native Google search, but this hasn't been verified live from this environment. If citations come back empty, source verification falls back to checking the URLs directly, and candidates without verifiable sources are rejected rather than published.
- **Originality** is checked against retrieved source excerpts and existing site posts only. It is no guarantee against every plagiarism detector, and nothing here tries to evade AI-detection tools.
- Rankings in Google or AI answer engines cannot be promised. The app optimises the factors it controls and reports them.
