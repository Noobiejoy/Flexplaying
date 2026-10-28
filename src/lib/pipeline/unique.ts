/** First occurrence wins. Postgres rejects an upsert that contains the same key twice. */
export function uniqueBy<T>(items: T[], key: (item: T) => string | number): T[] {
  const seen = new Set<string | number>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
