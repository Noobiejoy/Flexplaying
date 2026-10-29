import Link from "next/link";
import type { ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

/** Bordered surface. Use for content that belongs together; plain sections don't need one. */
export function Card({ children, className, title, action, subtitle, flush = false }: { children: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; flush?: boolean }) {
  return (
    <section className={cx("panel rounded-xl", flush ? "" : "p-5", className)}>
      {(title || action) && (
        <header className={cx("mb-4 flex items-start justify-between gap-3", flush && "px-5 pt-5")}>
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-3">{subtitle}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Unboxed section with a heading, for grouping on the page without another card. */
export function Section({ title, subtitle, action, children, className, id }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={cx("scroll-mt-6", className)}>
      <header className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-[17px] font-semibold text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 max-w-2xl text-[13px] text-ink-3">{subtitle}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

export function PageHeader({ title, description, actions, kicker }: { title: string; description?: ReactNode; actions?: ReactNode; kicker?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        {kicker && <div className="mb-2 text-[13px] text-ink-3">{kicker}</div>}
        <h1 className="display text-[34px] text-ink sm:text-[40px]">{title}</h1>
        {description && <div className="mt-2 text-[14px] text-ink-2">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "live";
const TONE: Record<Tone, string> = {
  neutral: "bg-[var(--sunken)] text-ink-2",
  good: "bg-[var(--good-bg)] text-[var(--good)]",
  warn: "bg-[var(--warn-bg)] text-[var(--warn)]",
  bad: "bg-[var(--bad-bg)] text-[var(--bad)]",
  info: "bg-[var(--live-bg)] text-[var(--live)]",
  live: "bg-[var(--live-bg)] text-[var(--live)]",
};
const DOT: Record<Tone, string> = { neutral: "var(--ink-3)", good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)", info: "var(--live)", live: "var(--live)" };

export function Badge({ tone = "neutral", children, icon = false }: { tone?: Tone; children: ReactNode; icon?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[12px] font-medium leading-4", TONE[tone])}>
      {icon && <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: DOT[tone] }} />}
      {children}
    </span>
  );
}

const RUN_TONE: Record<string, Tone> = {
  published: "good",
  drafted: "good",
  ready: "good",
  confirmed: "good",
  primary_confirmed: "good",
  selected: "live",
  dry_run_completed: "neutral",
  dry_run: "neutral",
  skipped: "neutral",
  duplicate: "neutral",
  cancelled: "neutral",
  ranked: "neutral",
  below_threshold: "neutral",
  rejected: "neutral",
  needs_review: "warn",
  retry_scheduled: "warn",
  missed: "warn",
  insufficient_evidence: "warn",
  single_source: "warn",
  failed: "bad",
  conflicting: "bad",
};

const LABEL: Record<string, string> = {
  dry_run_completed: "dry run done",
  fact_checking: "fact-checking",
  deduplicating: "checking duplicates",
  quality_check: "quality gate",
  generating_image: "making thumbnail",
  retry_scheduled: "retry scheduled",
  needs_review: "needs review",
  draft_only: "draft only",
  auto_publish: "auto-publish",
};

export function statusLabel(s: string) {
  return LABEL[s] ?? s.replace(/_/g, " ");
}

export function RunStatus({ status }: { status: string }) {
  const tone = RUN_TONE[status] ?? "live";
  return (
    <Badge tone={tone} icon>
      {statusLabel(status)}
    </Badge>
  );
}

const CATEGORY_COLOR: Record<string, string> = { anime: "var(--anime)", gaming: "var(--gaming)", esports: "var(--esports)" };
const CATEGORY_NAME: Record<string, string> = { anime: "Anime", gaming: "Gaming", esports: "Esports" };

export function categoryColor(c: string) {
  return CATEGORY_COLOR[c] ?? "var(--ink-3)";
}

/** Content vertical marker. Each vertical keeps one hue everywhere in the app. */
export function CategoryTag({ category }: { category: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-ink-2">
      <span aria-hidden className="h-2 w-2 rotate-45 rounded-[1px]" style={{ background: categoryColor(category) }} />
      {CATEGORY_NAME[category] ?? category}
    </span>
  );
}

/** A row of figures inside one ruled strip (instead of a grid of identical cards). */
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("grid gap-px overflow-hidden rounded-xl border border-[var(--rule)] bg-[var(--rule)]", className ?? "grid-cols-2 sm:grid-cols-4")}>{children}</div>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0 bg-[var(--surface)] px-4 py-3.5">
      <div className="text-[13px] text-ink-3">{label}</div>
      <div className={cx("figure mt-1.5 text-[28px]", tone === "bad" ? "text-[var(--bad)]" : tone === "warn" ? "text-[var(--warn)]" : "text-ink")}>{value}</div>
      {hint && <div className="mt-1.5 text-[12px] leading-snug text-ink-3">{hint}</div>}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-[var(--rule-strong)] px-5 py-8 text-center">
      <div className="text-[14px] font-medium text-ink">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-md text-[13px] text-ink-3">{children}</div>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

const BTN = "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-[14px] font-medium leading-4 transition disabled:cursor-not-allowed disabled:opacity-50";
const BTN_VARIANT = {
  primary: "bg-[var(--ink)] text-[var(--on-ink)] hover:opacity-90",
  secondary: "border border-[var(--rule-strong)] bg-[var(--surface)] text-ink hover:bg-[var(--sunken)]",
  danger: "border border-[color-mix(in_srgb,var(--bad)_35%,transparent)] bg-[var(--surface)] text-[var(--bad)] hover:bg-[var(--bad-bg)]",
  ghost: "text-ink-2 hover:bg-[var(--sunken)] hover:text-ink",
};

export function Button({ children, variant = "primary", type = "submit", className, disabled, name, value, formAction }: {
  children: ReactNode;
  variant?: keyof typeof BTN_VARIANT;
  type?: "submit" | "button";
  className?: string;
  disabled?: boolean;
  name?: string;
  value?: string;
  formAction?: (fd: FormData) => void | Promise<void>;
}) {
  return (
    <button type={type} name={name} value={value} disabled={disabled} formAction={formAction} className={cx(BTN, BTN_VARIANT[variant], className)}>
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = "secondary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" | "ghost" }) {
  return (
    <Link href={href} className={cx(BTN, BTN_VARIANT[variant])}>
      {children}
    </Link>
  );
}

export function TextLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={cx("font-medium text-[var(--link)] underline-offset-2 hover:underline", className)}>
      {children}
    </Link>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--link)] underline-offset-2 hover:underline">
      {children}
      <span aria-hidden className="ml-0.5 text-[0.85em]">↗</span>
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-ink-3">{hint}</span>}
    </label>
  );
}

/** 0–1 score as a number with a short fill bar, toned by threshold. */
export function Score({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-ink-3">—</span>;
  const color = value >= 0.7 ? "var(--good)" : value >= 0.5 ? "var(--warn)" : "var(--bad)";
  return (
    <span className="inline-flex items-center gap-2" title={`Score ${value.toFixed(2)} of 1`}>
      <span aria-hidden className="h-1.5 w-8 overflow-hidden rounded-full bg-[var(--sunken)]">
        <span className="block h-full rounded-full" style={{ width: `${Math.max(4, Math.min(1, value) * 100)}%`, background: color }} />
      </span>
      <span className="text-[13px] font-semibold tabular-nums text-ink">{value.toFixed(2)}</span>
    </span>
  );
}

export function Table({ head, children, empty, emptyText = "Nothing here yet." }: { head: ReactNode[]; children: ReactNode; empty?: boolean; emptyText?: ReactNode }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-[14px]">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className="border-b border-[var(--rule)] px-2 py-2 text-left text-[12px] font-medium text-ink-3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:border-b [&_td]:border-[var(--rule)] [&_td]:px-2 [&_td]:py-3 [&_td]:align-top [&_tr:last-child_td]:border-0">{children}</tbody>
      </table>
      {empty && <div className="py-8 text-center text-[14px] text-ink-3">{emptyText}</div>}
    </div>
  );
}

export function Notice({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: ReactNode }) {
  const bar = tone === "neutral" ? "var(--rule-strong)" : DOT[tone];
  return (
    <div className="rounded-lg border border-[var(--rule)] bg-[var(--surface)] py-3 pl-4 pr-4 text-[14px] text-ink-2" style={{ boxShadow: `inset 3px 0 0 ${bar}` }}>
      {title && <div className="mb-0.5 font-semibold text-ink">{title}</div>}
      {children}
    </div>
  );
}

/** Label/value rows for small key facts. */
export function KeyValues({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="divide-y divide-[var(--rule)] text-[14px]">
      {rows.map(([k, v], i) => (
        <div key={i} className="flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0">
          <dt className="text-ink-3">{k}</dt>
          <dd className="text-right text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
