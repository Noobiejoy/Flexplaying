import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { switchWorkspace } from "@/app/actions/workspace";
import { Mark } from "@/components/mark";
import { Nav } from "@/components/nav";
import { statusLabel } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { ACTIVE_STATUSES } from "@/lib/dashboard/stages";
import { formatInZone } from "@/lib/dashboard/time";
import { PRODUCT_NAME } from "@/lib/product";
import { nextSlot, normalizeHHMM } from "@/lib/schedule/slots";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, sb, membership, memberships } = await currentWorkspace();
  const ws = membership.workspace_id;
  const [{ data: settings }, { data: schedules }, review, active] = await Promise.all([
    sb.from("workspace_settings").select("automation_enabled, publishing_mode, timezone").eq("workspace_id", ws).single(),
    sb.from("schedules").select("local_time").eq("workspace_id", ws).eq("enabled", true),
    sb.from("articles").select("id", { count: "exact", head: true }).eq("workspace_id", ws).in("status", ["needs_review", "drafted"]),
    sb.from("runs").select("id", { count: "exact", head: true }).eq("workspace_id", ws).in("status", ACTIVE_STATUSES),
  ]);
  const tz = settings?.timezone ?? "Asia/Kolkata";
  const on = Boolean(settings?.automation_enabled);
  const next = on ? nextSlot(new Date(), tz, (schedules ?? []).map((s) => normalizeHHMM(s.local_time as string))) : null;
  const counts = { review: review.count ?? 0, active: active.count ?? 0 };

  const status = (
    <div className="flex items-center gap-2 text-[13px]">
      <span aria-hidden className={`h-2 w-2 rounded-full ${on ? "bg-[#4fd19c]" : "bg-[#f2b84b]"}`} />
      <span className="font-semibold text-[var(--desk-ink)]">{on ? "Automation on" : "Automation paused"}</span>
    </div>
  );

  const workspacePicker = (
    <form action={switchWorkspace} className="flex gap-1.5">
      <select name="workspace_id" defaultValue={ws} aria-label="Workspace" className="w-full rounded-lg border border-[var(--desk-2)] bg-[var(--desk-2)] px-2.5 py-1.5 text-[13px] text-[var(--desk-ink)] outline-none focus-visible:shadow-[var(--focus)]">
        {memberships.map((m) => (
          <option key={m.workspace_id} value={m.workspace_id}>{m.name} ({m.role})</option>
        ))}
      </select>
      {memberships.length > 1 && <button className="rounded-lg px-2 text-[13px] text-[var(--desk-ink-2)] hover:text-[var(--desk-ink)]">Switch</button>}
    </form>
  );

  return (
    <div className="min-h-screen lg:flex">
      <aside className="sticky top-0 z-20 bg-[var(--desk)] text-[var(--desk-ink)] lg:flex lg:h-screen lg:w-[244px] lg:shrink-0 lg:flex-col lg:gap-6 lg:px-4 lg:py-5">
        {/* Top bar on phones and tablets, sidebar head on desktop */}
        <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3 lg:p-0 lg:px-1">
          <Link href="/overview" className="flex items-center gap-2.5">
            <Mark />
            <span className="leading-tight">
              <span className="block text-[15px] font-semibold">{PRODUCT_NAME}</span>
              <span className="block text-[12px] text-[var(--desk-ink-2)]">{membership.name}</span>
            </span>
          </Link>
          <details className="relative lg:hidden">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg bg-[var(--desk-2)] px-2.5 py-1.5 text-[13px]">
              <span aria-hidden className={`h-2 w-2 rounded-full ${on ? "bg-[#4fd19c]" : "bg-[#f2b84b]"}`} />
              {on ? "On" : "Paused"}
              <span className="sr-only">Account and workspace menu</span>
            </summary>
            <div className="absolute right-0 top-full z-30 mt-2 w-64 space-y-3 rounded-xl bg-[var(--desk)] p-4 shadow-xl ring-1 ring-[var(--desk-2)]">
              {status}
              <div className="text-[12px] text-[var(--desk-ink-2)]">{next ? `Next run ${formatInZone(next.scheduledFor, tz)}` : "Scheduled runs are off"}. Mode: {statusLabel(settings?.publishing_mode ?? "")}.</div>
              {workspacePicker}
              <div className="flex items-center justify-between border-t border-[var(--desk-2)] pt-3 text-[13px]">
                <Link href="/profile" className="truncate text-[var(--desk-ink-2)] hover:text-[var(--desk-ink)]">{user.email}</Link>
                <form action={signOut}><button className="text-[var(--desk-ink-2)] hover:text-[var(--desk-ink)]">Sign out</button></form>
              </div>
            </div>
          </details>
        </div>
        <div className="hidden lg:block">{workspacePicker}</div>
        <div className="px-3 pb-2 lg:p-0">
          <Nav counts={counts} />
        </div>
        <div className="mt-auto hidden space-y-4 lg:block">
          <div className="rounded-xl bg-[var(--desk-2)] p-3.5">
            {status}
            <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--desk-ink-2)]">
              {next ? <>Next run {formatInZone(next.scheduledFor, tz)}</> : on ? "No run times set" : "Scheduled runs are off"}
              <br />
              Mode: {statusLabel(settings?.publishing_mode ?? "")}
            </p>
          </div>
          <div className="flex items-center justify-between gap-2 px-1 text-[13px] text-[var(--desk-ink-2)]">
            <Link href="/profile" className="truncate hover:text-[var(--desk-ink)]">{user.email}</Link>
            <form action={signOut}><button className="shrink-0 hover:text-[var(--desk-ink)]">Sign out</button></form>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 pb-16 pt-6 sm:px-6 lg:px-10 lg:pt-9">
        <div className="mx-auto max-w-[1180px]">{children}</div>
      </main>
    </div>
  );
}
