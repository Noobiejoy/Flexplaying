"use client";

import { useEffect, useState } from "react";
import { THEME_KEY, type Theme } from "@/lib/theme";

const OPTIONS: { value: Theme; label: string; icon: string }[] = [
  { value: "system", label: "System", icon: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 0v14" },
  { value: "light", label: "Light", icon: "M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM10 2.5v1.5m0 12v1.5M2.5 10H4m12 0h1.5M4.7 4.7l1 1m8.6 8.6 1 1m0-10.6-1 1m-8.6 8.6-1 1" },
  { value: "dark", label: "Dark", icon: "M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2Z" },
];

const EVENT = "eos-theme";

function apply(theme: Theme) {
  const root = document.documentElement;
  // Switch every colour at once instead of letting transitions fade some of them.
  const still = document.createElement("style");
  still.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(still);
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  void getComputedStyle(root).color;
  requestAnimationFrame(() => still.remove());
  try {
    if (theme === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked: the choice still applies for this page view.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: theme }));
}

function current(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
}

/** Light / Dark / System picker for the dark desk sidebar. Remembered per browser. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    // Sync with the value the init script applied before hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(current());
    // Keep every switch on the page, and other tabs, in step.
    const onChange = (e: Event) => setTheme((e as CustomEvent<Theme>).detail);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_KEY) return;
      const t: Theme = e.newValue === "light" || e.newValue === "dark" ? e.newValue : "system";
      if (t === "system") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = t;
      setTheme(t);
    };
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return (
    <div role="radiogroup" aria-label="Colour theme" className="grid grid-cols-3 gap-0.5 rounded-lg bg-[var(--desk-2)] p-0.5">
      {OPTIONS.map((o) => {
        const on = theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => apply(o.value)}
            className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium transition ${on ? "bg-[var(--desk-ink)] text-[var(--desk)]" : "text-[var(--desk-ink-2)] hover:text-[var(--desk-ink)]"}`}
          >
            <svg aria-hidden viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d={o.icon} />
            </svg>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
