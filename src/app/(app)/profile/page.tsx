import Link from "next/link";
import { updatePassword } from "@/app/actions/auth";
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
        </Card>
        <Card title="Change password">
          <form action={updatePassword} className="space-y-3">
            <input type="hidden" name="from" value="/profile" />
            <Field label="New password" hint="At least 10 characters"><input className="field" name="password" type="password" minLength={10} autoComplete="new-password" required /></Field>
            <Field label="Confirm new password"><input className="field" name="confirm" type="password" minLength={10} autoComplete="new-password" required /></Field>
            <Button>Update password</Button>
          </form>
        </Card>
        <Card title="Workspaces">
          <ul className="space-y-2">{memberships.map((m) => <li key={m.workspace_id} className="flex items-center justify-between text-sm">{m.name}<Badge>{m.role}</Badge></li>)}</ul>
          <Link href="/onboarding" className="mt-4 inline-block text-sm text-[var(--link)]">Create another workspace</Link>
        </Card>
      </div>
    </>
  );
}
