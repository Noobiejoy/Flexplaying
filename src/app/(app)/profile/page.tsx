import Link from "next/link";
import { updateProfile } from "@/app/actions/workspace";
import { Flash } from "@/components/flash";
import { Badge, Button, Card, Field, PageHeader } from "@/components/ui";
import { currentWorkspace } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Profile({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { sb, user, memberships } = await currentWorkspace();
  const { data: profile } = await sb.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
  return (
    <>
      <PageHeader title="Profile" />
      <Flash searchParams={searchParams} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Your details">
          <form action={updateProfile} className="space-y-3">
            <Field label="Email"><input className="field" value={user.email ?? ""} disabled /></Field>
            <Field label="Display name"><input className="field" name="display_name" defaultValue={profile?.display_name ?? ""} maxLength={120} /></Field>
            <Button>Save</Button>
          </form>
          <p className="mt-4 text-xs text-ink-3">To change your password, use <Link className="text-[var(--link)]" href="/forgot-password">password reset</Link>.</p>
        </Card>
        <Card title="Workspaces">
          <ul className="space-y-2">{memberships.map((m) => <li key={m.workspace_id} className="flex items-center justify-between text-sm">{m.name}<Badge>{m.role}</Badge></li>)}</ul>
          <Link href="/onboarding" className="mt-4 inline-block text-sm text-[var(--link)]">Create another workspace</Link>
        </Card>
      </div>
    </>
  );
}
