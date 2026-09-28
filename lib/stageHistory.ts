// ═══════════════════════════════════════════════════════════════════════════
// ROUND 165 — THE ROW FORMAT, LIFTED OUT OF lib/ghl.ts.
//
// 🔴 IT WAS IN THE SERVER MODULE AND THAT BROKE THE BUILD THE MOMENT THE
// CLIENT NEEDED IT. `parseStageHistory` lived beside the writer in lib/ghl.ts,
// which imports AsyncLocalStorage; the first client import of it dragged
// `node:async_hooks` into the browser bundle and Turbopack refused:
//
//     the chunking context (unknown) does not support external modules
//     (request: node:async_hooks)
//
// ⚠️ NOTHING CAUGHT IT FOR TWO ROUNDS BECAUSE NOTHING HAD IMPORTED IT YET. A
// function placed in the wrong module is invisible until a second caller with
// different constraints arrives — the failure only exists at the boundary, and
// there was no boundary. Loud when it finally happened, which is the good
// outcome; silent would have been a server bundle shipped to the browser.
//
// 🔴 SO THE FORMAT IS ITS OWN MODULE, DEPENDING ON NOTHING. The writer
// (lib/ghl.ts) and the reader (lib/stageKpi.ts) both import it, neither owns
// it, and the day the encoding changes exactly one file changes. lib/ghl.ts
// re-exports these names so every existing caller and proof keeps working.
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// ROUND 159/163 — THE STAGE RECORDER.
//
// 🔴 GOHIGHLEVEL HAS NO STAGE HISTORY. `lastStageChangeAt` is one value, not a
// log, so "two stages a month per case manager" needs something to write every
// transition down as it happens. This is that something.
//
// ⚠️ PER-RECORD, AND THE CONCURRENCY ARGUMENT IS WHY — not preference. A shared
// location custom value would mean read-modify-write with no compare-and-swap:
// a bulk edit firing fourteen events in one second would lose thirteen rows,
// and a bulk edit is exactly the thing this log needs to be able to show. Here
// fourteen events write fourteen DIFFERENT records and nothing contends.
//
// ✅ AND THE CAP IS NOT A CONSTRAINT. Probed live against a LARGE_TEXT
// opportunity field: 4 / 30 / 120 / 400 / 1,200 rows — 243 B to 73,199 B — read
// back byte-identical every time. A record's real life is 4-8 moves, so
// trimming never arises and no history is ever dropped.
// ═══════════════════════════════════════════════════════════════════════════
export const STAGE_HISTORY_FIELD = "Stage History";

/**
 * One recorded transition.
 *
 * 🔴 `from` IS NOT STORED, IT IS DERIVED — and `null` is a real answer.
 *
 * The previous stage is the previous row's `to`, so storing it as well would be
 * a second copy of one fact that could disagree with the first. The exception
 * is the FIRST row for a record: the case was already in some stage when the
 * recorder started, and nothing knows which. That is `from: null` — an
 * explicit unknown, not a zero and not an empty string, because a reader
 * computing days-in-stage must be able to tell "no origin" from "origin blank".
 */
export interface StageHistoryRow {
  at: string;
  from: string | null;
  to: string;
  ownerId: string;
  managerIds: string[];
}

/** `2026-09-26T12:04:11Z|stg_cao|u_ern|u_carla,u_edmark` — one row per line. */
export function encodeStageRow(at: string, to: string, ownerId: string, managerIds: string[]): string {
  return [at, to, ownerId, managerIds.join(",")].join("|");
}

/**
 * Parse the stored field. Tolerant by design: a malformed line is SKIPPED
 * rather than throwing, because this log is read to produce a number and one
 * bad row must not take the whole KPI down with it.
 */
export function parseStageHistory(raw: unknown): StageHistoryRow[] {
  const text = Array.isArray(raw) ? raw.join("\n") : String(raw ?? "");
  const out: StageHistoryRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const [at, to, ownerId, managers] = t.split("|");
    if (!at || !to) continue;
    out.push({
      at,
      // 🔴 THE PREVIOUS ROW'S DESTINATION, AND null FOR THE FIRST.
      from: out.length ? out[out.length - 1].to : null,
      to,
      ownerId: ownerId || "",
      managerIds: (managers || "").split(",").map((x) => x.trim()).filter(Boolean),
    });
  }
  return out;
}

