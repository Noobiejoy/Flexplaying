import type { z } from "zod";
import { AiError } from "./types";

/** Extract and validate a JSON payload from model output (tolerates code fences and prose). */
export function extractJson<T>(text: string, schema: z.ZodType<T>): T {
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) candidates.push(m[1]!.trim());
  const firstObj = text.indexOf("{");
  const firstArr = text.indexOf("[");
  const starts = [firstObj, firstArr].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const s of starts) {
    const closer = text[s] === "{" ? "}" : "]";
    const end = text.lastIndexOf(closer);
    if (end > s) candidates.push(text.slice(s, end + 1));
  }
  candidates.push(text.trim());
  let lastIssue = "no JSON found";
  for (const c of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(c);
    } catch {
      continue;
    }
    const r = schema.safeParse(parsed);
    if (r.success) return r.data;
    lastIssue = r.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
  }
  throw new AiError("parse", `Model output did not match the expected structure (${lastIssue})`);
}
