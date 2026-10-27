-- EditorialOS scheduler: Supabase Cron (pg_cron) + pg_net -> signed POST to /api/cron/tick every 5 minutes.
--
-- Run this ONCE in the Supabase SQL editor AFTER applying the migrations and deploying the app.
-- Replace the two placeholders in step 2 first. Do NOT commit a copy of this file with real values.
-- Re-running is safe: secrets are updated in place and the job is re-scheduled.

-- 1. Extensions (available on all Supabase plans).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2. Secrets in Supabase Vault (encrypted at rest; never stored in migrations).
do $$
declare
  app_url text := 'https://REPLACE-WITH-YOUR-APP.vercel.app';  -- no trailing slash
  cron_secret text := 'REPLACE-WITH-THE-SAME-CRON_SECRET-AS-VERCEL';
  existing uuid;
begin
  if app_url like '%REPLACE%' or cron_secret like '%REPLACE%' then
    raise exception 'Edit the placeholders in step 2 before running this script';
  end if;
  select id into existing from vault.secrets where name = 'editorialos_app_url';
  if existing is null then perform vault.create_secret(app_url, 'editorialos_app_url');
  else perform vault.update_secret(existing, app_url); end if;
  select id into existing from vault.secrets where name = 'editorialos_cron_secret';
  if existing is null then perform vault.create_secret(cron_secret, 'editorialos_cron_secret');
  else perform vault.update_secret(existing, cron_secret); end if;
end $$;

-- 3. Signed tick: HMAC-SHA256(secret, "<unix ts>.<nonce>") verified by the app with replay protection.
create or replace function public.editorialos_tick()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  app_url text;
  secret text;
  ts text;
  nonce text;
  sig text;
begin
  select decrypted_secret into app_url from vault.decrypted_secrets where name = 'editorialos_app_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'editorialos_cron_secret';
  if app_url is null or secret is null then
    raise exception 'EditorialOS scheduler secrets are missing from Vault';
  end if;
  ts := floor(extract(epoch from now()))::bigint::text;
  nonce := gen_random_uuid()::text;
  sig := encode(extensions.hmac(ts || '.' || nonce, secret, 'sha256'), 'hex');
  return net.http_post(
    url := app_url || '/api/cron/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-EditorialOS-Timestamp', ts,
      'X-EditorialOS-Nonce', nonce,
      'X-EditorialOS-Signature', sig
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 290000
  );
end $$;

revoke execute on function public.editorialos_tick() from public, anon, authenticated;

-- 4. Schedule: every 5 minutes. The app decides which workspace slots (09:00/13:00/19:00 IST by default)
--    are due, so changing a workspace's times in the dashboard needs no SQL change.
select cron.unschedule(jobid) from cron.job where jobname in ('editorialos-tick', 'editorialos-cleanup');
select cron.schedule('editorialos-tick', '*/5 * * * *', $$ select public.editorialos_tick(); $$);
select cron.schedule('editorialos-cleanup', '17 3 * * *', $$ delete from public.scheduler_invocations where received_at < now() - interval '3 days'; $$);

-- 5. Verify (optional):
--   select * from cron.job where jobname like 'editorialos%';
--   select public.editorialos_tick();                         -- fire one tick now
--   select id, status_code, left(content, 300), error_msg, created from net._http_response order by created desc limit 5;
--   select jobname, status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
