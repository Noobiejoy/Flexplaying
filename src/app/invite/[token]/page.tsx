import { acceptInvitation } from "@/app/actions/workspace";
import { Flash } from "@/components/flash";
import { Button } from "@/components/ui";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { token } = await params;
  const { user } = await requireUser();
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="glass w-full max-w-md rounded-3xl p-6">
        <h1 className="text-lg font-semibold">Join a workspace</h1>
        <p className="mt-1 text-sm text-ink-2">Accept this invitation as <strong>{user.email}</strong>. The invitation only works for the email address it was issued to.</p>
        <div className="mt-4"><Flash searchParams={searchParams} /></div>
        <form action={acceptInvitation} className="mt-3">
          <input type="hidden" name="token" value={token} />
          <Button>Accept invitation</Button>
        </form>
      </div>
    </main>
  );
}
