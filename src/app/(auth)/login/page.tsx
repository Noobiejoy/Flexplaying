import Link from "next/link";
import { signIn } from "@/app/actions/auth";
import { Flash } from "@/components/flash";
import { Button, Field } from "@/components/ui";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return (
    <>
      <h1 className="mb-4 text-base font-semibold">Sign in</h1>
      <Flash searchParams={searchParams} />
      {sp.error === "link" && <p className="mb-3 text-xs text-[var(--bad)]">That link is invalid or expired.</p>}
      <form action={signIn} className="space-y-3">
        <input type="hidden" name="next" value={sp.next ?? "/overview"} />
        <Field label="Email"><input className="field" name="email" type="email" autoComplete="email" required /></Field>
        <Field label="Password"><input className="field" name="password" type="password" autoComplete="current-password" required /></Field>
        <Button className="w-full">Sign in</Button>
      </form>
      <div className="mt-4 flex justify-between text-xs text-ink-3">
        <Link href="/forgot-password" className="hover:text-ink">Forgot password?</Link>
        <Link href="/signup" className="hover:text-ink">Create account</Link>
      </div>
    </>
  );
}
