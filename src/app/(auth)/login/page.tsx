import Link from "next/link";
import { signIn } from "@/app/actions/auth";
import { Flash } from "@/components/flash";
import { LinkError } from "@/components/link-error";
import { Button, Field } from "@/components/ui";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return (
    <>
      <h1 className="display mb-6 text-[34px]">Sign in</h1>
      <Flash searchParams={searchParams} />
      <LinkError fromQuery={sp.error === "link"} />
      <form action={signIn} className="space-y-3">
        <input type="hidden" name="next" value={sp.next ?? "/overview"} />
        <Field label="Email"><input className="field" name="email" type="email" autoComplete="email" required /></Field>
        <Field label="Password"><input className="field" name="password" type="password" autoComplete="current-password" required /></Field>
        <Button className="w-full !py-2.5">Sign in</Button>
      </form>
      <div className="mt-5 flex justify-between text-[13px] text-ink-3">
        <Link href="/forgot-password" className="hover:text-ink">Forgot password?</Link>
        <Link href="/signup" className="hover:text-ink">Create account</Link>
      </div>
    </>
  );
}
