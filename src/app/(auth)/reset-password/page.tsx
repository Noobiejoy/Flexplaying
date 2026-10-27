import { updatePassword } from "@/app/actions/auth";
import { Flash } from "@/components/flash";
import { Button, Field } from "@/components/ui";

export default function ResetPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  return (
    <>
      <h1 className="mb-4 text-base font-semibold">Choose a new password</h1>
      <Flash searchParams={searchParams} />
      <form action={updatePassword} className="space-y-3">
        <Field label="New password"><input className="field" name="password" type="password" minLength={10} autoComplete="new-password" required /></Field>
        <Field label="Confirm password"><input className="field" name="confirm" type="password" minLength={10} autoComplete="new-password" required /></Field>
        <Button className="w-full">Update password</Button>
      </form>
    </>
  );
}
