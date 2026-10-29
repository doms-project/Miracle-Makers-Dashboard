// ---------------------------------------------------------------------------
// ROUND 188 — FILTER THE CLIENTS AND RECRUITING BOARDS BY CREATED DATE.
//
// 🔴 EASTERN CALENDAR DAYS, NOT UTC. Every card shows "Created <date>" in
// Eastern time (round 168), so "Today" must mean the Eastern day a rep reads on
// the card. A case created at 9pm EST is the next day in UTC; filtered in UTC,
// it would vanish from "Today" while its card still says today.
//
// ⚠️ This is deliberately NOT the Moves screen's `rangeWindow`, which compares
// in UTC because it counts stored stage moves. Different job, different clock.
//
// Days are compared as "YYYY-MM-DD" strings, which sort the same as the dates.
// ---------------------------------------------------------------------------
import { DASHBOARD_TZ } from "./dates";

export type CreatedRange = "all" | "today" | "week" | "month" | "lastMonth" | "custom";

export const CREATED_RANGE_OPTIONS: [CreatedRange, string][] = [
  ["all", "Any time"],
  ["today", "Today"],
  ["week", "This week"],
  ["month", "This month"],
  ["lastMonth", "Last month"],
  ["custom", "Custom range…"],
];

/** Inclusive Eastern day bounds; null means open on that side. */
export interface CreatedWindow {
  from: string | null;
  to: string | null;
}

const DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: DASHBOARD_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Eastern calendar day of a timestamp, "YYYY-MM-DD"; "" when unreadable. */
export function easternDayKey(v: unknown): string {
  if (v == null || v === "") return "";
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(d.getTime())) return "";
  const p: Record<string, string> = {};
  for (const x of DAY.formatToParts(d)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/** A "YYYY-MM-DD" key shifted by whole days (calendar arithmetic, no zones). */
function shift(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const validKey = (s: string | undefined | null): string =>
  s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";

export function createdWindow(
  range: CreatedRange,
  now: Date,
  customFrom?: string,
  customTo?: string,
): CreatedWindow {
  if (range === "all") return { from: null, to: null };
  const today = easternDayKey(now);
  const [y, m] = today.split("-").map(Number);
  if (range === "today") return { from: today, to: today };
  if (range === "week") {
    // Monday to Sunday — the same week the Moves screen uses.
    const [yy, mm, dd] = today.split("-").map(Number);
    const dow = (new Date(Date.UTC(yy, mm - 1, dd)).getUTCDay() + 6) % 7;
    const start = shift(today, -dow);
    return { from: start, to: shift(start, 6) };
  }
  if (range === "month") {
    const first = `${y}-${String(m).padStart(2, "0")}-01`;
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { from: first, to: last };
  }
  if (range === "lastMonth") {
    const first = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    const last = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
    return { from: first, to: last };
  }
  // Custom: either end may be left open. Typed backwards, it is read forwards
  // rather than matching nothing.
  let from = validKey(customFrom) || null;
  let to = validKey(customTo) || null;
  if (from && to && from > to) [from, to] = [to, from];
  return { from, to };
}

/** True when a window actually narrows anything. */
export const windowActive = (w: CreatedWindow): boolean => !!(w.from || w.to);

/**
 * Does a record created at `createdAt` fall in the window? With no window,
 * everything does. With one, a record with no readable created date does NOT —
 * the caller counts those and says so rather than hiding them silently.
 */
export function inCreatedWindow(createdAt: unknown, w: CreatedWindow): boolean {
  if (!windowActive(w)) return true;
  const k = easternDayKey(createdAt);
  if (!k) return false;
  if (w.from && k < w.from) return false;
  if (w.to && k > w.to) return false;
  return true;
}

/** A short description of the active window, for "Nothing matches" messages. */
export function describeWindow(range: CreatedRange, w: CreatedWindow): string {
  if (!windowActive(w)) return "";
  const label = CREATED_RANGE_OPTIONS.find(([k]) => k === range)?.[1] || "";
  if (range !== "custom") return `created ${label.toLowerCase()}`;
  if (w.from && w.to) return `created ${w.from} to ${w.to}`;
  return w.from ? `created on or after ${w.from}` : `created on or before ${w.to}`;
}
