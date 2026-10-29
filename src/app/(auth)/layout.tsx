import { Mark } from "@/components/mark";
import { PRODUCT_NAME } from "@/lib/product";

// A static picture of what the desk does each day: three slots moving through the pipeline.
const DAY = [
  { t: "09:00", fill: 7, note: "Published to your site" },
  { t: "13:00", fill: 4, note: "Writing now", live: true },
  { t: "19:00", fill: 0, note: "Scheduled" },
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(420px,520px)]">
      <section className="bg-[var(--desk)] px-6 py-8 text-[var(--desk-ink)] sm:px-10 lg:flex lg:flex-col lg:justify-between lg:py-12">
        <div className="flex items-center gap-3">
          <Mark size={36} />
          <span className="text-[17px] font-semibold">{PRODUCT_NAME}</span>
        </div>
        <div className="hidden max-w-lg lg:block">
          <p className="display text-[52px]">An editorial desk that works three shifts a day.</p>
          <p className="mt-4 text-[16px] leading-relaxed text-[var(--desk-ink-2)]">It finds anime, gaming and esports stories, checks them against your site and the sources, writes them, and leaves drafts for you, or publishes when you say so.</p>
          <ol className="mt-10 space-y-4" aria-hidden>
            {DAY.map((d) => (
              <li key={d.t} className="grid grid-cols-[64px_160px_1fr] items-center gap-4">
                <span className="figure text-[22px]">{d.t}</span>
                <span className="flex gap-[3px]">
                  {Array.from({ length: 7 }, (_, i) => (
                    <span key={i} className={`h-[7px] flex-1 rounded-[2px] ${i < d.fill ? "bg-[var(--desk-ink)]" : d.live && i === d.fill ? "rail-live" : "bg-[var(--desk-2)]"}`} />
                  ))}
                </span>
                <span className="text-[14px] text-[var(--desk-ink-2)]">{d.note}</span>
              </li>
            ))}
          </ol>
        </div>
        <p className="hidden text-[13px] text-[var(--desk-ink-2)] lg:block">Every claim is sourced. Nothing is published without passing its checks.</p>
      </section>
      <section className="flex items-start justify-center px-4 py-10 sm:px-6 lg:items-center">
        <div className="w-full max-w-sm">{children}</div>
      </section>
    </main>
  );
}
