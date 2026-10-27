"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/overview", label: "Overview", icon: "◎" },
  { href: "/activity", label: "Live activity", icon: "◉" },
  { href: "/research", label: "Research", icon: "◇" },
  { href: "/articles", label: "Articles", icon: "▤" },
  { href: "/costs", label: "Costs & usage", icon: "◔" },
  { href: "/learning", label: "Learning", icon: "↻" },
  { href: "/settings", label: "Settings", icon: "⚙" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible" aria-label="Main">
      {ITEMS.map((i) => {
        const active = path === i.href || path.startsWith(`${i.href}/`);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? "page" : undefined}
            className={`flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition ${active ? "glass-strong font-medium text-ink" : "text-ink-2 hover:bg-[var(--hairline)]"}`}
          >
            <span aria-hidden className="w-4 text-center text-ink-3">{i.icon}</span>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
