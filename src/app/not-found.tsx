import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] items-center justify-center">
      <div className="panel rounded-xl p-8 text-center">
        <h1 className="display text-[32px]">Not found</h1>
        <p className="mt-2 text-[14px] text-ink-2">This page doesn&apos;t exist, or it belongs to a workspace you can&apos;t access.</p>
        <Link href="/overview" className="mt-4 inline-block text-sm text-[var(--link)]">Back to overview</Link>
      </div>
    </main>
  );
}
