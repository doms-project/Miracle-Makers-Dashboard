// ═══════════════════════════════════════════════════════════════════════════
// ROUND 181 · "NEW LEAD" UNTIL SOMEBODY OPENS IT.
//
// A case — on the Clients board OR the Recruiting board — shows a "New lead"
// label on its card and list row until any signed-in user, a rep or an admin,
// opens it in the dashboard. The first
// open is written onto the case, and from then on nobody sees the label.
//
// 🔴 WHY A FIELD ON THE CASE. GoHighLevel has no "viewed" flag, and GoHighLevel
// is the only storage this app has. A per-record field is the same choice the
// Stage History made (lib/stageHistory.ts) and for the same reason: two people
// opening two cases write two DIFFERENT records, so nothing contends. A shared
// list in one custom value would lose opens under exactly that load.
//
// ⚠️ ONE WRITE PER CASE, EVER. The route writes only when the field is empty.
// It is a real GoHighLevel write, so a workflow triggered on "opportunity
// changed" sees it once per case — say so to whoever owns the workflows.
//
// ⚠️ ONLY CASES CREATED ON OR AFTER `NEW_LEAD_SINCE`. Every case before it has
// never been "opened" by this definition — ~1,356 sit in NEW LEAD today — and
// lighting all of them up would make the label meaningless on day one.
//
// ⚠️ NO FIELD, NO LABEL. Until a "First Opened" opportunity field exists, an
// open cannot be recorded, so a label could never clear. The route reports
// `tracking: false` and no card shows it.
//
// NO IMPORTS — the browser (app/page.tsx) and the server both use this.
// ═══════════════════════════════════════════════════════════════════════════

/** The opportunity custom field holding the first open. Single-line text. */
export const FIRST_OPENED_FIELD = "First Opened";

/**
 * Cases created at or after this moment are eligible. 00:00 Eastern on
 * 26 Oct 2026, the day the label was asked for. Override with NEW_LEAD_SINCE
 * (any date `Date` reads) without a code change.
 */
export const NEW_LEAD_SINCE_DEFAULT = "2026-10-26T04:00:00.000Z";

/** The cutoff in force. Server-side: reads the env; an unreadable value falls back. */
export function newLeadSince(env: string | undefined = typeof process !== "undefined" ? process.env.NEW_LEAD_SINCE : undefined): string {
  const raw = (env || "").trim();
  if (raw) {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return NEW_LEAD_SINCE_DEFAULT;
}

/** The stored value: when, and by whom. `2026-10-26T15:04:05.000Z|<userId>`. */
export function encodeFirstOpened(at: string, userId: string): string {
  return `${at}|${userId}`;
}

export function parseFirstOpened(v: unknown): { at: string; userId: string } | null {
  const s = Array.isArray(v) ? String(v[0] ?? "") : String(v ?? "");
  const t = s.trim();
  if (!t) return null;
  const i = t.indexOf("|");
  const at = i < 0 ? t : t.slice(0, i);
  const userId = i < 0 ? "" : t.slice(i + 1);
  return { at, userId };
}

/**
 * Is this case a "new lead" right now?
 *
 *   open (not won/lost/abandoned) · created on/after `since` · never opened
 *
 * 🔴 A MISSING OR UNREADABLE createdAt IS NOT NEW. Guessing "new" for a case
 * whose age we cannot read would put the label on records that may be years
 * old — the same reason the card's Created line renders nothing rather than
 * today's date (round 178).
 */
export function isNewLead(
  rec: { firstOpened?: string; createdAt?: string; status?: string },
  since: string,
): boolean {
  if (parseFirstOpened(rec.firstOpened)) return false;
  if ((rec.status || "open").toLowerCase() !== "open") return false;
  const created = new Date(String(rec.createdAt || ""));
  const cutoff = new Date(since);
  if (isNaN(created.getTime()) || isNaN(cutoff.getTime())) return false;
  return created.getTime() >= cutoff.getTime();
}
