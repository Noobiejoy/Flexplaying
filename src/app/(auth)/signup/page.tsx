import Link from "next/link";
import { signUp } from "@/app/actions/auth";
import { Flash } from "@/components/flash";
import { Button, Field } from "@/components/ui";

export default function SignupPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  return (
    <>
      <h1 className="mb-4 text-base font-semibold">Create your account</h1>
      <Flash searchParams={searchParams} />
      <form action={signUp} className="space-y-3">
        <Field label="Name"><input className="field" name="name" autoComplete="name" required maxLength={80} /></Field>
        <Field label="Email"><input className="field" name="email" type="email" autoComplete="email" required /></Field>
        <Field label="Password" hint="At least 10 characters"><input className="field" name="password" type="password" autoComplete="new-password" minLength={10} required /></Field>
        <Button className="w-full">Create account</Button>
      </form>
      <p className="mt-4 text-center text-xs text-ink-3">Already have an account? <Link href="/login" className="text-[var(--accent)]">Sign in</Link></p>
    </>
  );
}
