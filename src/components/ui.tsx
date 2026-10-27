import Link from "next/link";
import type { ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Card({ children, className, title, action, subtitle }: { children: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <section className={cx("glass rounded-2xl p-5", className)}>
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

type Tone = "neutral" | "good" | "warn" | "bad" | "info";
const TONE: Record<Tone, string> = {
  neutral: "bg-[var(--hairline)] text-ink-2",
  good: "bg-[var(--good-bg)] text-[var(--good)]",
  warn: "bg-[var(--warn-bg)] text-[var(--warn)]",
  bad: "bg-[var(--bad-bg)] text-[var(--bad)]",
  info: "bg-[var(--info-bg)] text-[var(--accent)]",
};
const DOT: Record<Tone, string> = { neutral: "○", good: "●", warn: "▲", bad: "■", info: "◆" };

export function Badge({ tone = "neutral", children, icon = false }: { tone?: Tone; children: ReactNode; icon?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium", TONE[tone])}>
      {icon && <span aria-hidden className="text-[8px]">{DOT[tone]}</span>}
      {children}
    </span>
  );
}

const RUN_TONE: Record<string, Tone> = {
  published: "good",
  drafted: "good",
  dry_run_completed: "info",
  skipped: "neutral",
  duplicate: "neutral",
  cancelled: "neutral",
  needs_review: "warn",
  retry_scheduled: "warn",
  missed: "warn",
  failed: "bad",
};

export function statusLabel(s: string) {
  return s.replace(/_/g, " ");
}

export function RunStatus({ status }: { status: string }) {
  const tone = RUN_TONE[status] ?? "info";
  return (
    <Badge tone={tone} icon>
      {statusLabel(status)}
    </Badge>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="glass rounded-2xl p-4">
      <div className="text-xs font-medium text-ink-3">{label}</div>
      <div className={cx("mt-1.5 text-2xl font-semibold tracking-tight tabular-nums", tone === "bad" ? "text-[var(--bad)]" : tone === "warn" ? "text-[var(--warn)]" : "text-ink")}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-3">{hint}</div>}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--hairline)] px-4 py-8 text-center">
      <div className="text-sm font-medium text-ink-2">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-md text-xs text-ink-3">{children}</div>}
    </div>
  );
}

export function Button({ children, variant = "primary", type = "submit", className, disabled, name, value, formAction }: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  type?: "submit" | "button";
  className?: string;
  disabled?: boolean;
  name?: string;
  value?: string;
  formAction?: (fd: FormData) => void | Promise<void>;
}) {
  const v = {
    primary: "bg-[var(--accent)] text-white hover:brightness-110",
    secondary: "glass-strong text-ink hover:bg-[var(--hairline)]",
    danger: "bg-[var(--bad-bg)] text-[var(--bad)] hover:brightness-95",
    ghost: "text-ink-2 hover:bg-[var(--hairline)]",
  }[variant];
  return (
    <button type={type} name={name} value={value} disabled={disabled} formAction={formAction} className={cx("inline-flex items-center justify-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50", v, className)}>
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = "secondary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" }) {
  return (
    <Link href={href} className={cx("inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition", variant === "primary" ? "bg-[var(--accent)] text-white hover:brightness-110" : "glass-strong text-ink hover:bg-[var(--hairline)]")}>
      {children}
    </Link>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline-offset-2 hover:underline">
      {children}
    </a>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-3">{hint}</span>}
    </label>
  );
}

export function Score({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="text-ink-3">—</span>;
  const tone: Tone = value >= 0.7 ? "good" : value >= 0.5 ? "warn" : "bad";
  return <Badge tone={tone}>{value.toFixed(2)}</Badge>;
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className="border-b border-[var(--hairline)] px-2 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-ink-3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&_td]:border-b [&_td]:border-[var(--hairline)] [&_td]:px-2 [&_td]:py-2.5 [&_tr:last-child_td]:border-0">{children}</tbody>
      </table>
      {empty && <div className="py-6 text-center text-sm text-ink-3">Nothing here yet.</div>}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return <div className={cx("rounded-xl px-3.5 py-2.5 text-sm", TONE[tone])}>{children}</div>;
}
