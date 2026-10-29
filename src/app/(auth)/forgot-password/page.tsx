import Link from "next/link";
import { requestPasswordReset } from "@/app/actions/auth";
import { Flash } from "@/components/flash";
import { Button, Field } from "@/components/ui";

export default function ForgotPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  return (
    <>
      <h1 className="display mb-6 text-[34px]">Reset your password</h1>
      <Flash searchParams={searchParams} />
      <form action={requestPasswordReset} className="space-y-3">
        <Field label="Email"><input className="field" name="email" type="email" required /></Field>
        <Button className="w-full !py-2.5">Send reset link</Button>
      </form>
      <p className="mt-5 text-center text-[13px]"><Link href="/login" className="text-ink-3 hover:text-ink">Back to sign in</Link></p>
    </>
  );
}
