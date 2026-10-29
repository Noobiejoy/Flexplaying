export const PIPELINE: { key: string; label: string; short: string }[] = [
  { key: "researching", label: "Research", short: "Research" },
  { key: "deduplicating", label: "Duplicate check", short: "Dedupe" },
  { key: "fact_checking", label: "Fact-check", short: "Facts" },
  { key: "writing", label: "Write", short: "Write" },
  { key: "quality_check", label: "Quality gate", short: "Quality" },
  { key: "generating_image", label: "Thumbnail", short: "Image" },
  { key: "publishing", label: "Publish", short: "Publish" },
];

export const ACTIVE_STATUSES = ["queued", "researching", "deduplicating", "fact_checking", "writing", "quality_check", "generating_image", "publishing", "retry_scheduled"];

export type StageState = "done" | "current" | "failed" | "pending" | "skipped";

export interface RailRun {
  status: string;
  resume_stage?: string | null;
  publishing_mode?: string | null;
}

/**
 * Per-stage state for the pipeline rail, derived only from the run row and
 * its recorded stage logs (succeeded / failed entries). Nothing is inferred
 * beyond what the ledger shows.
 */
export function railStates(run: RailRun, logs: { stage: string; level: string }[]): StageState[] {
  const active = ACTIVE_STATUSES.includes(run.status);
  return PIPELINE.map((p) => {
    const s = logs.filter((l) => l.stage === p.key && (l.level === "succeeded" || l.level === "failed"));
    if (run.status === p.key || (run.status === "retry_scheduled" && run.resume_stage === p.key)) return "current";
    if (run.status === "failed" && run.resume_stage === p.key) return "failed";
    if (s.length) return s.at(-1)!.level === "failed" && !s.some((l) => l.level === "succeeded") ? "failed" : "done";
    if (!active && p.key === "publishing" && (run.publishing_mode === "dry_run" || run.status === "dry_run_completed")) return "skipped";
    return "pending";
  });
}

/** Total recorded time per stage, in ms (null when the stage logged no duration). */
export function stageDurations(logs: { stage: string; duration_ms: number | null }[]): (number | null)[] {
  return PIPELINE.map((p) => {
    const d = logs.filter((l) => l.stage === p.key && l.duration_ms !== null);
    return d.length ? d.reduce((a, l) => a + (l.duration_ms ?? 0), 0) : null;
  });
}
