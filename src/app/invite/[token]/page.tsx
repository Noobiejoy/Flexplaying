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
      <div className="panel w-full max-w-md rounded-xl p-7">
        <h1 className="display text-[32px]">Join a workspace</h1>
        <p className="mt-2 text-[14px] text-ink-2">Accept this invitation as <strong>{user.email}</strong>. The invitation only works for the email address it was issued to.</p>
        <div className="mt-4"><Flash searchParams={searchParams} /></div>
        <form action={acceptInvitation} className="mt-3">
          <input type="hidden" name="token" value={token} />
          <Button>Accept invitation</Button>
        </form>
      </div>
    </main>
  );
}
