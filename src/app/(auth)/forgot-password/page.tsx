import Link from "next/link";
import { requestPasswordReset } from "@/app/actions/auth";
import { Flash } from "@/components/flash";
import { Button, Field } from "@/components/ui";

export default function ForgotPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  return (
    <>
      <h1 className="mb-4 text-base font-semibold">Reset your password</h1>
      <Flash searchParams={searchParams} />
      <form action={requestPasswordReset} className="space-y-3">
        <Field label="Email"><input className="field" name="email" type="email" required /></Field>
        <Button className="w-full">Send reset link</Button>
      </form>
      <p className="mt-4 text-center text-xs"><Link href="/login" className="text-ink-3 hover:text-ink">Back to sign in</Link></p>
    </>
  );
}
