/**
 * Timezone-correct schedule slot calculation without external dependencies.
 * Schedules are stored as local wall-clock times plus an IANA timezone; each
 * concrete execution window is identified by a stable slot key
 * "<local date>T<HH:MM>" (e.g. "2026-10-27T09:00"), which the database uses
 * as a uniqueness constraint so a slot can never run twice.
 */

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a timezone. */
export function zonedParts(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(instant)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<"year" | "month" | "day" | "hour" | "minute" | "second", number>;
  return parts;
}

/** Offset (ms) of the timezone from UTC at the given instant. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Convert a local wall-clock time in `timeZone` to a UTC instant. */
export function zonedTimeToUtc(date: LocalDate, hhmm: string, timeZone: string): Date {
  const [h, m] = parseHHMM(hhmm);
  const guess = Date.UTC(date.year, date.month - 1, date.day, h, m, 0);
  let result = guess - offsetMs(new Date(guess), timeZone);
  // Re-evaluate once in case the offset differs at the corrected instant (DST edges).
  const second = guess - offsetMs(new Date(result), timeZone);
  if (second !== result) result = second;
  return new Date(result);
}

export function parseHHMM(value: string): [number, number] {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!m) throw new Error(`Invalid time "${value}"`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time "${value}"`);
  return [h, min];
}

export function normalizeHHMM(value: string): string {
  const [h, m] = parseHHMM(value);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function localDateOf(instant: Date, timeZone: string): LocalDate {
  const p = zonedParts(instant, timeZone);
  return { year: p.year, month: p.month, day: p.day };
}

export function addDays(d: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function formatLocalDate(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

export function slotKey(d: LocalDate, hhmm: string): string {
  return `${formatLocalDate(d)}T${normalizeHHMM(hhmm)}`;
}

export interface SlotInstance {
  slotKey: string;
  localTime: string;
  scheduledFor: Date;
}

export interface SlotEvaluation {
  due: SlotInstance[];
  missed: SlotInstance[];
}

/**
 * Determine which slots should start now (within the grace window) and which
 * were missed entirely. Only slots at or after `notBefore` (for example the
 * moment automation was enabled) are considered, so enabling automation in the
 * evening does not retroactively flag the morning slot as missed.
 */
export function evaluateSlots(params: {
  now: Date;
  timeZone: string;
  localTimes: string[];
  graceMinutes: number;
  notBefore: Date;
}): SlotEvaluation {
  const { now, timeZone, localTimes, graceMinutes, notBefore } = params;
  const today = localDateOf(now, timeZone);
  const due: SlotInstance[] = [];
  const missed: SlotInstance[] = [];
  for (const day of [addDays(today, -1), today]) {
    for (const t of localTimes) {
      const scheduledFor = zonedTimeToUtc(day, t, timeZone);
      if (scheduledFor > now || scheduledFor < notBefore) continue;
      const inst = { slotKey: slotKey(day, t), localTime: normalizeHHMM(t), scheduledFor };
      const lateMs = now.getTime() - scheduledFor.getTime();
      if (lateMs <= graceMinutes * 60_000) due.push(inst);
      else missed.push(inst);
    }
  }
  return { due, missed };
}

/** The next scheduled instant strictly after `now`, or null if there are no enabled times. */
export function nextSlot(now: Date, timeZone: string, localTimes: string[]): SlotInstance | null {
  if (localTimes.length === 0) return null;
  const today = localDateOf(now, timeZone);
  let best: SlotInstance | null = null;
  for (const day of [today, addDays(today, 1), addDays(today, 2)]) {
    for (const t of localTimes) {
      const at = zonedTimeToUtc(day, t, timeZone);
      if (at <= now) continue;
      if (!best || at < best.scheduledFor) best = { slotKey: slotKey(day, t), localTime: normalizeHHMM(t), scheduledFor: at };
    }
    if (best) return best;
  }
  return best;
}

/** Start of the local day (as a UTC instant) in the given timezone. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  return zonedTimeToUtc(localDateOf(now, timeZone), "00:00", timeZone);
}

export function startOfLocalMonth(now: Date, timeZone: string): Date {
  const d = localDateOf(now, timeZone);
  return zonedTimeToUtc({ ...d, day: 1 }, "00:00", timeZone);
}

export function formatInZone(instant: Date | string | null | undefined, timeZone: string, withDate = true): string {
  if (!instant) return "—";
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    ...(withDate ? { day: "numeric", month: "short" } : {}),
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}
