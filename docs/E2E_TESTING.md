# Manual end-to-end test (real integrations)

Run this after the credentials are configured. It never publishes unless you choose to in step 7.

1. **Health**: `/setup` shows every item as configured. **Settings → Integration health** shows Database healthy.
2. **Models**: Settings → AI models → **Check default models now**. Every model shows ✓. If one is missing, the message lists the available `google/*` models; set an override.
3. **WordPress**: connect with an Application Password. The success message names the site, the SEO plugin (`yoast` on flexplaying.com) and the category mapping. Then **Test connection**.
4. **Scheduler**: in the Supabase SQL editor run `select public.editorialos_tick();`. Within a minute, Settings shows "Last signed tick … ago". `net._http_response` shows status 200 with `"auth":"signed"`.
5. **Dry run**: Live activity → **Start dry run**. Watch the stages: research (citations listed per category), duplicate check (number of posts synced from WordPress), fact-check (claims with statuses), writing, quality gate, thumbnail. Expected result: `dry run completed`, and WordPress unchanged (check Posts → All). Review the article and its claims on the Articles page.
6. **Draft**: Overview → Run now (Workspace mode = Draft only). Expected result: `drafted`, a new draft in WordPress with the featured image, category and tags set, and the hidden `editorialos:` marker visible in the Code editor. Article detail shows the WordPress post ID, the edit link and the SEO sync status.
7. **Optional auto-publish**: switch to Auto-publish (type the confirmation), run once, and confirm the post is live and the article shows `published`. Switch back to Draft only if you're not ready to leave it on.
8. **Duplicate rejection**: run again immediately. Expect the same story to be rejected as a duplicate of the draft or post from step 6 (Research page → `duplicate`, with a link to the matched post), and either a different story to be chosen or the run to end as `duplicate` / `skipped`.
9. **Pause/resume**: pause automation on the Overview page; ticks create no new scheduled runs. Resume it; the next slot appears on the Overview page.
10. **Isolation**: sign up a second account and create its own workspace. It sees none of the first workspace's runs, articles, costs or WordPress connection. Invite it as a viewer from Settings → Members, accept the link while signed in as the second account, and confirm it can read but not change settings.
11. **Costs**: the Costs page lists every call from steps 5–8, with provider-reported costs (or "unknown" where OpenRouter did not report one).
