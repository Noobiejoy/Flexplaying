import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { switchWorkspace } from "@/app/actions/workspace";
import { Nav } from "@/components/nav";
import { Badge } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";
import { PRODUCT_NAME } from "@/lib/product";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, sb, membership, memberships } = await currentWorkspace();
  const { data: settings } = await sb.from("workspace_settings").select("automation_enabled, publishing_mode").eq("workspace_id", membership.workspace_id).single();
  return (
    <div className="mx-auto flex min-h-screen max-w-[1400px] flex-col gap-4 p-3 lg:flex-row lg:gap-6 lg:p-6">
      <aside className="glass flex flex-col gap-4 rounded-3xl p-4 lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)] lg:w-60 lg:shrink-0">
        <Link href="/overview" className="flex items-center gap-2.5 px-1">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--accent)] text-sm font-bold text-white">E</span>
          <span className="text-[15px] font-semibold tracking-tight">{PRODUCT_NAME}</span>
        </Link>
        <form action={switchWorkspace} className="flex gap-1.5">
          <select name="workspace_id" defaultValue={membership.workspace_id} className="field !py-1.5 !text-xs" aria-label="Workspace">
            {memberships.map((m) => (
              <option key={m.workspace_id} value={m.workspace_id}>{m.name} ({m.role})</option>
            ))}
          </select>
          {memberships.length > 1 && <button className="rounded-lg px-2 text-xs text-ink-2 hover:bg-[var(--hairline)]">Go</button>}
        </form>
        <div className="flex flex-wrap gap-1.5 px-1">
          <Badge tone={settings?.automation_enabled ? "good" : "warn"} icon>{settings?.automation_enabled ? "Automation on" : "Paused"}</Badge>
          <Badge tone={settings?.publishing_mode === "auto_publish" ? "info" : "neutral"}>{(settings?.publishing_mode ?? "").replace("_", " ")}</Badge>
        </div>
        <Nav />
        <div className="mt-auto hidden space-y-2 px-1 text-xs text-ink-3 lg:block">
          <Link href="/profile" className="block truncate hover:text-ink">{user.email}</Link>
          <form action={signOut}><button className="hover:text-ink">Sign out</button></form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 pb-12">{children}</main>
    </div>
  );
}
