import Link from "next/link";
import { signUp } from "@/app/actions/auth";
import { Flash } from "@/components/flash";
import { Button, Field } from "@/components/ui";

export default function SignupPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  return (
    <>
      <h1 className="display mb-6 text-[34px]">Create your account</h1>
      <Flash searchParams={searchParams} />
      <form action={signUp} className="space-y-3">
        <Field label="Name"><input className="field" name="name" autoComplete="name" required maxLength={80} /></Field>
        <Field label="Email"><input className="field" name="email" type="email" autoComplete="email" required /></Field>
        <Field label="Password" hint="At least 10 characters"><input className="field" name="password" type="password" autoComplete="new-password" minLength={10} required /></Field>
        <Button className="w-full !py-2.5">Create account</Button>
      </form>
      <p className="mt-5 text-center text-[13px] text-ink-3">Already have an account? <Link href="/login" className="text-[var(--link)]">Sign in</Link></p>
    </>
  );
}
