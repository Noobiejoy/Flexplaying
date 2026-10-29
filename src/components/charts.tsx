"use client";

import { useState } from "react";

export interface BarDatum {
  label: string;
  value: number | null;
  display: string;
}

/**
 * Single-series vertical bar chart (magnitude over time). Thin bars with
 * rounded data-ends on the baseline, recessive grid, per-bar hover tooltip
 * and a screen-reader table. Null values render as an explicit gap.
 */
export function BarChart({ data, title, height = 160 }: { data: BarDatum[]; title: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...data.map((d) => d.value ?? 0));
  const w = 100 / Math.max(1, data.length);
  return (
    <figure className="relative">
      <div className="relative" style={{ height }} role="img" aria-label={title}>
        {[0.25, 0.5, 0.75, 1].map((g) => (
          <div key={g} className="absolute inset-x-0 border-t" style={{ bottom: `${g * 100}%`, borderColor: "var(--grid)" }} />
        ))}
        <div className="absolute inset-0 flex items-end">
          {data.map((d, i) => {
            const h = max > 0 && d.value ? Math.max(2, (d.value / max) * 100) : 0;
            return (
              <div key={i} className="relative flex h-full items-end justify-center" style={{ width: `${w}%` }} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <div
                  className="w-[60%] max-w-[18px] rounded-t-[4px] transition-opacity"
                  style={{ height: `${h}%`, background: "var(--series-1)", opacity: hover === null || hover === i ? 1 : 0.45 }}
                />
                {hover === i && (
                  <div className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-md bg-[var(--ink)] px-2 py-1 text-[12px] text-[var(--on-ink)]">
                    <div className="opacity-70">{d.label}</div>
                    <div className="font-semibold tabular-nums">{d.display}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-1.5 flex justify-between text-[12px] text-ink-3">
        <span>{data[0]?.label}</span>
        <span>{data.at(-1)?.label}</span>
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th>{d.label}</th>
              <td>{d.display}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Horizontal magnitude bars with direct value labels (text in ink, not series colour). */
export function HBars({ data }: { data: { label: string; value: number; display: string }[] }) {
  const max = Math.max(0, ...data.map((d) => d.value));
  return (
    <ul className="space-y-2.5">
      {data.map((d) => (
        <li key={d.label} title={`${d.label}: ${d.display}`}>
          <div className="mb-1 flex justify-between gap-3 text-[13px]">
            <span className="text-ink-2">{d.label}</span>
            <span className="font-medium tabular-nums text-ink">{d.display}</span>
          </div>
          <div className="h-2 rounded-full bg-[var(--sunken)]">
            <div className="h-2 rounded-full" style={{ width: `${max > 0 ? Math.max(2, (d.value / max) * 100) : 0}%`, background: "var(--series-1)" }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
