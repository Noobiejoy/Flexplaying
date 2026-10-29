/** Product mark: one tile per content vertical (anime, gaming, esports) and an empty slot. */
export function Mark({ size = 32 }: { size?: number }) {
  return (
    <span aria-hidden className="grid shrink-0 grid-cols-2 gap-[3px] rounded-lg bg-[var(--desk-ink)]" style={{ width: size, height: size, padding: size * 0.22 }}>
      <span className="rounded-[1px] bg-[var(--anime)]" />
      <span className="rounded-[1px] bg-[var(--gaming)]" />
      <span className="rounded-[1px] bg-[var(--esports)]" />
      <span className="rounded-[1px] bg-[var(--desk)]" />
    </span>
  );
}
