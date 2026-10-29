import { integrationHealth } from "@/lib/env";
import { Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

const ROWS: { key: keyof ReturnType<typeof integrationHealth>; vars: string; where: string; why: string }[] = [
  { key: "supabase", vars: "NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", where: "Vercel + .env.local", why: "Sign-in and dashboard data" },
  { key: "supabaseServer", vars: "SUPABASE_SECRET_KEY", where: "Vercel (server only)", why: "Scheduler and pipeline writes" },
  { key: "openrouter", vars: "OPENROUTER_API_KEY", where: "Vercel (server only)", why: "Research, writing, review and thumbnails (Google models via OpenRouter)" },
  { key: "encryption", vars: "CREDENTIALS_ENCRYPTION_KEY", where: "Vercel (server only)", why: "Encrypts WordPress application passwords" },
  { key: "scheduler", vars: "CRON_SECRET", where: "Vercel + Supabase Vault", why: "Authenticates the 5-minute scheduler tick" },
  { key: "baseUrl", vars: "APP_BASE_URL", where: "Vercel + Supabase Vault", why: "Auth email links and the scheduler target URL" },
];

/** Public, secret-free configuration checklist shown before Supabase is configured. */
export default function SetupPage() {
  const h = integrationHealth();
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <div className="panel rounded-xl p-7">
        <h1 className="display text-[32px]">Setup checklist</h1>
        <p className="mt-2 text-[14px] text-ink-2">Each item shows only whether a value is present. Values are never displayed. See README.md → Setup for step-by-step instructions.</p>
        <ul className="mt-5 divide-y divide-[var(--sunken)]">
          {ROWS.map((r) => (
            <li key={r.key} className="flex items-start justify-between gap-4 py-3">
              <div>
                <div className="text-sm font-medium">{r.why}</div>
                <code className="text-[12px] text-ink-3">{r.vars}</code>
                <div className="text-[12px] text-ink-3">Set in: {r.where}</div>
              </div>
              <Badge tone={h[r.key] ? "good" : "warn"} icon>{h[r.key] ? "configured" : "missing"}</Badge>
            </li>
          ))}
        </ul>
        {h.supabase && <a href="/login" className="mt-5 inline-block text-sm text-[var(--link)]">Continue to sign in </a>}
      </div>
    </main>
  );
}
