import { PIPELINE, type StageState } from "@/lib/dashboard/stages";
import { cx } from "./ui";

const FILL: Record<StageState, string> = {
  done: "bg-[var(--ink)]",
  current: "rail-live",
  failed: "bg-[var(--bad)]",
  pending: "bg-[var(--rule)]",
  skipped: "bg-[repeating-linear-gradient(-45deg,var(--rule)_0_3px,transparent_3px_6px)]",
};
const WORD: Record<StageState, string> = { done: "done", current: "running", failed: "failed", pending: "not reached", skipped: "skipped" };

function summary(states: StageState[]) {
  return PIPELINE.map((p, i) => `${p.label}: ${WORD[states[i] ?? "pending"]}`).join(", ");
}

/** Compact seven-segment pipeline strip for lists. */
export function MiniRail({ states, className }: { states: StageState[]; className?: string }) {
  return (
    <div role="img" aria-label={summary(states)} title={summary(states)} className={cx("flex w-full max-w-[168px] gap-[3px]", className)}>
      {PIPELINE.map((p, i) => (
        <span key={p.key} className={cx("h-[7px] flex-1 rounded-[2px]", FILL[states[i] ?? "pending"])} />
      ))}
    </div>
  );
}

function secs(ms: number | null) {
  if (ms === null) return null;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Full rail with stage names, state and time spent: horizontal on wide screens, a list on phones. */
export function Rail({ states, durations }: { states: StageState[]; durations?: (number | null)[] }) {
  return (
    <ol className="grid gap-x-1.5 gap-y-2.5 sm:grid-cols-7" aria-label="Pipeline stages">
      {PIPELINE.map((p, i) => {
        const st = states[i] ?? "pending";
        const t = secs(durations?.[i] ?? null);
        return (
          <li key={p.key} className="flex items-center gap-3 sm:block">
            <span aria-hidden className={cx("block h-7 w-1.5 shrink-0 rounded-[3px] sm:h-2.5 sm:w-full", FILL[st])} />
            <div className="min-w-0 sm:mt-2">
              <div className={cx("text-[13px] font-semibold", st === "pending" || st === "skipped" ? "text-ink-3" : st === "failed" ? "text-[var(--bad)]" : "text-ink")}>{p.label}</div>
              <div className="text-[12px] text-ink-3">
                {WORD[st]}
                {t && st !== "pending" ? `, ${t}` : ""}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
