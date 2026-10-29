"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

// 20px line icons, drawn on a 20-unit grid with a 1.6 stroke.
const ICON: Record<string, string> = {
  overview: "M3 10.5 10 4l7 6.5M5 9v7h4v-4h2v4h4V9",
  activity: "M2.5 10h3l2-5 3.5 10 2-5h4.5",
  research: "M8.5 14a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Zm4-1.5L17 17",
  articles: "M5 3h7l3 3v11H5V3Zm7 0v3h3M7.5 9.5h5M7.5 12.5h5",
  costs: "M4 16V9m4 7V5m4 11v-5m4 5V7",
  learning: "M15.5 7.5A6 6 0 0 0 4.3 8M4.5 12.5A6 6 0 0 0 15.7 12M15.5 3.5v4h-4M4.5 16.5v-4h4",
  settings: "M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM10 2.5v2m0 11v2M2.5 10h2m11 0h2M4.7 4.7l1.4 1.4m7.8 7.8 1.4 1.4m0-10.6-1.4 1.4m-7.8 7.8-1.4 1.4",
};

const ITEMS = [
  { href: "/overview", label: "Overview", icon: "overview" },
  { href: "/activity", label: "Runs", icon: "activity", count: "active" as const },
  { href: "/research", label: "Research", icon: "research" },
  { href: "/articles", label: "Articles", icon: "articles", count: "review" as const },
  { href: "/costs", label: "Costs", icon: "costs" },
  { href: "/learning", label: "Learning", icon: "learning" },
  { href: "/settings", label: "Settings", icon: "settings" },
];

export function Nav({ counts }: { counts: { active: number; review: number } }) {
  const path = usePathname();
  const current = useRef<HTMLAnchorElement>(null);
  // On phones the nav scrolls sideways; keep the current page's tab in view.
  useEffect(() => {
    const el = current.current;
    const strip = el?.closest("nav");
    if (el && strip && strip.scrollWidth > strip.clientWidth) strip.scrollTo({ left: el.offsetLeft - strip.clientWidth / 2 + el.clientWidth / 2 });
  }, [path]);
  return (
    <nav aria-label="Main" className="scroll-fade -mx-1 overflow-x-auto px-1 lg:mx-0 lg:overflow-visible lg:px-0">
      <ul className="flex gap-0.5 lg:flex-col">
        {ITEMS.map((i) => {
          const active = path === i.href || path.startsWith(`${i.href}/`);
          const n = i.count ? counts[i.count] : 0;
          return (
            <li key={i.href} className="shrink-0">
              <Link
                href={i.href}
                ref={active ? current : undefined}
                aria-current={active ? "page" : undefined}
                className={`relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-[14px] transition ${active ? "bg-[var(--desk-2)] font-semibold text-[var(--desk-ink)]" : "text-[var(--desk-ink-2)] hover:bg-[var(--desk-2)] hover:text-[var(--desk-ink)]"}`}
              >
                {active && <span aria-hidden className="absolute inset-y-2 left-0 hidden w-[3px] rounded-full bg-[var(--desk-ink)] lg:block" />}
                <svg aria-hidden viewBox="0 0 20 20" className="h-[18px] w-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d={ICON[i.icon]} />
                </svg>
                {i.label}
                {n > 0 && (
                  <span className="ml-auto rounded-md bg-[var(--desk-ink)] px-1.5 text-[12px] font-semibold leading-[18px] text-[var(--desk)]" aria-label={i.count === "review" ? `${n} awaiting review` : `${n} running`}>
                    {n}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
