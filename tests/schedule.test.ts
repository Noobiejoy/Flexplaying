import { describe, expect, it } from "vitest";
import { evaluateSlots, nextSlot, slotKey, startOfLocalDay, zonedTimeToUtc } from "@/lib/schedule/slots";

const IST = "Asia/Kolkata";

describe("schedule slots (Asia/Kolkata)", () => {
  it("converts 09:00, 13:00 and 19:00 IST to UTC", () => {
    const d = { year: 2026, month: 10, day: 27 };
    expect(zonedTimeToUtc(d, "09:00", IST).toISOString()).toBe("2026-10-27T03:30:00.000Z");
    expect(zonedTimeToUtc(d, "13:00", IST).toISOString()).toBe("2026-10-27T07:30:00.000Z");
    expect(zonedTimeToUtc(d, "19:00", IST).toISOString()).toBe("2026-10-27T13:30:00.000Z");
  });

  it("handles DST zones correctly (America/New_York)", () => {
    expect(zonedTimeToUtc({ year: 2026, month: 7, day: 1 }, "09:00", "America/New_York").toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(zonedTimeToUtc({ year: 2026, month: 12, day: 1 }, "09:00", "America/New_York").toISOString()).toBe("2026-12-01T14:00:00.000Z");
  });

  it("marks a slot due within the grace window and produces a stable key", () => {
    const now = new Date("2026-10-27T03:35:00Z"); // 09:05 IST
    const r = evaluateSlots({ now, timeZone: IST, localTimes: ["09:00", "13:00", "19:00"], graceMinutes: 90, notBefore: new Date("2026-10-01T00:00:00Z") });
    expect(r.due.map((s) => s.slotKey)).toEqual(["2026-10-27T09:00"]);
    expect(r.missed.map((s) => s.slotKey)).toEqual(["2026-10-26T09:00", "2026-10-26T13:00", "2026-10-26T19:00"]);
  });

  it("does not flag slots from before automation was enabled as missed", () => {
    const now = new Date("2026-10-27T14:00:00Z"); // 19:30 IST
    const r = evaluateSlots({ now, timeZone: IST, localTimes: ["09:00", "13:00", "19:00"], graceMinutes: 90, notBefore: new Date("2026-10-27T13:00:00Z") });
    expect(r.due.map((s) => s.slotKey)).toEqual(["2026-10-27T19:00"]);
    expect(r.missed).toEqual([]);
  });

  it("uses the IST date for the slot key across the UTC midnight boundary", () => {
    // 19:00 IST on Oct 27 = 13:30Z; 00:30 IST Oct 28 = 19:00Z Oct 27
    const now = new Date("2026-10-27T19:00:00Z");
    expect(startOfLocalDay(now, IST).toISOString()).toBe("2026-10-27T18:30:00.000Z");
    expect(nextSlot(now, IST, ["09:00", "13:00", "19:00"])!.slotKey).toBe("2026-10-28T09:00");
    expect(slotKey({ year: 2026, month: 1, day: 5 }, "9:00".padStart(5, "0"))).toBe("2026-01-05T09:00");
  });

  it("returns no next slot when nothing is scheduled", () => {
    expect(nextSlot(new Date(), IST, [])).toBeNull();
  });
});
