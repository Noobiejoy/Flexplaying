import { createWorkspace } from "@/app/actions/workspace";
import { signOut } from "@/app/actions/auth";
import { Flash } from "@/components/flash";
import { Button, Field } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function Onboarding({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { user } = await requireUser();
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="panel w-full max-w-md rounded-xl p-7">
        <h1 className="display text-[32px]">Create a workspace</h1>
        <p className="mt-2 text-[14px] text-ink-2">A workspace holds one WordPress site, its schedule, articles, research history and costs. Signed in as {user.email}.</p>
        <div className="mt-4"><Flash searchParams={searchParams} /></div>
        <form action={createWorkspace} className="mt-2 space-y-3">
          <Field label="Workspace name"><input className="field" name="name" defaultValue="FlexPlaying" required maxLength={80} /></Field>
          <Field label="Timezone" hint="Schedules run at 9:00, 13:00 and 19:00 in this timezone by default.">
            <input className="field" name="timezone" defaultValue="Asia/Kolkata" required />
          </Field>
          <Button className="w-full">Create workspace</Button>
        </form>
        <p className="mt-4 text-xs text-ink-3">Were you invited? Open the invitation link you received instead.</p>
        <form action={signOut} className="mt-3"><Button variant="ghost">Sign out</Button></form>
      </div>
    </main>
  );
}
