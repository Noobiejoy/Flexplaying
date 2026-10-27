# Deployment, operations and recovery

## Deploy checklist

1. **Supabase**: restore the project if it is paused; apply `supabase/migrations/*`; configure the Auth URLs (README step 1).
2. **Vercel**: import `Noobiejoy/Flexplaying`, set the environment variables from `.env.example` (Production and Preview), and deploy. Confirm that `https://<app>/api/health` returns `{ ok: true }`.
3. **Scheduler**: run `supabase/scheduler/setup_cron.sql` once with your real URL and `CRON_SECRET`.
4. **App**: sign up, create a workspace, connect WordPress, start a dry run, review the trace, then enable automation.

### Why not Vercel Cron?

On the Hobby plan, Vercel Cron runs at most once a day, with imprecise timing. Three windows a day need either Pro or an external trigger. Supabase Cron is available on every Supabase plan, so it drives a 5-minute tick, and the app decides which slots are due. If you move to Vercel Pro and prefer Vercel Cron, add the following to `vercel.json`. The endpoint accepts `Authorization: Bearer $CRON_SECRET`, which Vercel sends automatically when `CRON_SECRET` is set:

```json
{ "crons": [{ "path": "/api/cron/tick", "schedule": "*/5 * * * *" }] }
```

Only run one of the two schedulers. Running both is harmless, because ticks are idempotent, but wasteful.

## Operations

- **Integration health**: Settings → Integration health shows Database, WordPress, OpenRouter and Scheduler (last signed tick).
- **Alerts**: failed and missed runs create in-app alerts on the Overview page, plus an optional webhook (Settings → Notifications).
- **Scheduler debugging (Supabase SQL)**:
  ```sql
  select jobname, status, return_message, start_time from cron.job_run_details order by start_time desc limit 20;
  select status_code, left(content, 300), error_msg, created from net._http_response order by created desc limit 10;
  ```
  - `401` from the tick: `CRON_SECRET` differs between Vercel and Vault.
  - `409`: a nonce was replayed (should not happen in normal operation).
  - `timed_out`: normal for long ticks. The function keeps running on Vercel, and the run lease ensures resumption.

## Recovery

| Situation | What happens / what to do |
|---|---|
| Function times out mid-stage | Lease expires after 330 s; the next tick resumes the same stage. No action needed. |
| WordPress create succeeded but the response was lost | The next attempt finds the post by its hidden marker and updates it. No duplicate is created. |
| Run `failed` (credits, auth, unmapped category) | Fix the cause, then **Live activity → run → Retry from <stage>**. |
| OpenRouter 402 (out of credits) | Runs fail with `ai_credits` and raise an alert. Top up the credits, then retry. |
| Model removed from OpenRouter | Runs fail with `ai_model_unavailable` and the error lists alternatives. Set a new model in Settings → AI models or in the env var. There is never a silent fallback. |
| Supabase project paused (free plan) | Ticks fail and slots show as `missed` after restore. Restore the project; consider the Pro plan. |
| Wrong article published | Unpublish it in WordPress. EditorialOS never overwrites a post that a human has since published. |

## Key rotation

- **CREDENTIALS_ENCRYPTION_KEY**: set the new key as `CREDENTIALS_ENCRYPTION_KEY` with a new `CREDENTIALS_ENCRYPTION_KEY_ID`, and move the old one to `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` / `_PREVIOUS_ID`. Redeploy, re-save each workspace's WordPress credential (Settings → WordPress → new application password), then remove the previous key.
- **CRON_SECRET**: update it in Vercel, redeploy, then re-run step 2 of `setup_cron.sql` (it updates Vault in place).
- **OPENROUTER_API_KEY**: create a new key on OpenRouter, update Vercel, redeploy, then revoke the old key.
- **SUPABASE_SECRET_KEY**: roll it in Supabase API settings, update Vercel and redeploy.
