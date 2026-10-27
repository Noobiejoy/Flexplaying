import { Notice } from "./ui";

export async function Flash({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const ok = typeof sp.ok === "string" ? sp.ok : null;
  const err = typeof sp.err === "string" ? sp.err : null;
  if (!ok && !err) return null;
  return (
    <div className="mb-5" role="status">
      <Notice tone={err ? "bad" : "good"}>{err ?? ok}</Notice>
    </div>
  );
}
