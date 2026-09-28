import { parseStageHistory, type StageHistoryRow } from "@/lib/stageHistory";

// ═══════════════════════════════════════════════════════════════════════════
// ROUND 165 — READING THE STAGE LOG.
//
// 🔴 PURE, AND THAT IS THE POINT. Nothing here fetches, reads a clock it was
// not handed, or touches React. Two screens consume it — the KPI section and
// the Master view's days-in-stage — and a proof can drive it with a literal
// array and no server at all. Round 163 built the writer with a fake HTTP
// server and a child process; none of that is needed to prove arithmetic.
//
// 🔴 AND IT IS THE ONLY CONSUMER OF THE ROW FORMAT. `parseStageHistory` is the
// contract (lib/ghl.ts); everything above it reads StageHistoryRow objects and
// never splits a string. The day the encoding changes, one function changes.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The shape this module needs from a record. Deliberately STRUCTURAL rather
 * than importing OpportunityRecord: it documents exactly what is read, and a
 * proof can build one in four lines.
 */
export interface StageKpiRecord {
  id: string;
  stageId: string;
  /** GoHighLevel's native `lastStageChangeAt`. */
  stageChangedAt?: string;
  cf: Record<string, unknown>;
}

// ───────────────────────────────────────────────────────────────────────────
// DAYS IN STAGE
// ───────────────────────────────────────────────────────────────────────────

/**
 * 🔴 WHERE THE NUMBER CAME FROM, ON EVERY NUMBER.
 *
 *   "history"  the stage log's last row, and its `to` IS the record's current
 *              stage. Authoritative: it was written when the move happened.
 *   "ghl"      GoHighLevel's `lastStageChangeAt`. Complete back to the
 *              beginning and KNOWN TO BE MOVED BY BULK WRITES — see the
 *              comment at lib/ghl.ts:1582. Best available, not trustworthy.
 */
export type StageAgeSource = "history" | "ghl";

export interface StageAge {
  days: number;
  at: string;
  source: StageAgeSource;
  /**
   * ⚠️ TRUE WHEN THE LOG HAS ROWS BUT ITS LAST `to` IS NOT THE CURRENT STAGE.
   * That means a move happened which the recorder never saw — a webhook that
   * did not fire or did not land. The log cannot date the current stage, so
   * this falls back to "ghl", but the DISCREPANCY IS ITSELF A FINDING and the
   * screen counts it. Round 150 §3: a gap is a gap, not a zero.
   */
  missedMove: boolean;
}

/**
 * How long this record has been in its current stage, and on whose authority.
 *
 * 🔴 THE LAST ROW IS ONLY USABLE IF ITS DESTINATION IS WHERE THE RECORD ACTUALLY
 * IS. Without that check a record moved while the recorder was down would be
 * dated by the move BEFORE last — a confident number that is wrong by however
 * long the gap was, which is worse than the field it replaces.
 *
 * Returns null when neither source has anything. The caller renders NOTHING,
 * never "0 days" — the rule daysInStage() has followed since it was written.
 */
export function stageAge(
  r: StageKpiRecord,
  historyFieldId: string | null,
  now: number,
): StageAge | null {
  let missedMove = false;

  if (historyFieldId) {
    const rows = parseStageHistory(r.cf[historyFieldId]);
    const last = rows[rows.length - 1];
    if (last) {
      if (last.to === r.stageId) {
        const d = daysBetween(last.at, now);
        if (d !== null) return { days: d, at: last.at, source: "history", missedMove: false };
      } else {
        missedMove = true;
      }
    }
  }

  const d = daysBetween(r.stageChangedAt, now);
  if (d === null) return null;
  return { days: d, at: String(r.stageChangedAt), source: "ghl", missedMove };
}

/** Whole days from an ISO timestamp to `now`. null when unparseable or future. */
function daysBetween(iso: string | undefined | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = Math.floor((now - t) / 86_400_000);
  return d >= 0 ? d : null;
}

// ───────────────────────────────────────────────────────────────────────────
// THE COUNTS
// ───────────────────────────────────────────────────────────────────────────

export interface StageKpiTally {
  /** User id. Resolved to a name by the caller — this module never guesses. */
  id: string;
  moves: number;
}

export interface StageCluster {
  /** The minute the cluster landed in, ISO, truncated. */
  at: string;
  to: string;
  records: number;
}

export interface StageKpiWindow {
  /** Inclusive ISO lower bound, or null for "everything recorded". */
  from: string | null;
  /** Exclusive ISO upper bound, or null for "up to now". */
  to: string | null;
}

export interface StageKpiResult {
  perRep: StageKpiTally[];
  perManager: StageKpiTally[];

  /**
   * 🔴 TRANSITIONS, NOT ROWS. A move needs an origin, and row 1 of any record
   * has none — see `firstSightings`. perRep sums to AT MOST this (less
   * `unattributed`); perManager sums to MORE, by design.
   */
  moves: number;

  /**
   * 🔴 ROWS WITH `from === null`, EXCLUDED FROM `moves` AND PRINTED BESIDE IT.
   *
   * The recorder cannot know where a record came from on its first row —
   * whatever fired the event, the origin was never observed. So the first row
   * is evidence the record is SOMEWHERE, not that it WENT anywhere, and
   * counting it would inflate every rep by one per record they own. In month
   * one that is nearly the whole number.
   *
   * ⚠️ THIS IS AN UNDERCOUNT AND THE SCREEN SAYS SO. Where a first row WAS a
   * real move, we lose it. The trade is deliberate: a bounded, stated
   * undercount beats an unbounded, silent overcount.
   */
  firstSightings: number;

  /**
   * 🔴 TRANSITIONS WHOSE ROW CARRIES NO OWNER. Counted in `moves`, credited to
   * nobody — so perRep does NOT sum to `moves`, and this is the difference.
   *
   * ⚠️ IT IS NOT HYPOTHETICAL. A live row reads `...|b43041b2-…||` — empty
   * owner, empty managers. A move that belongs to no one is a third state, not
   * a zero for someone, and without this number the per-rep column silently
   * fails to add up with nothing on screen to explain it.
   */
  unattributed: number;

  /** Transitions whose row carries no managers. Same reasoning, manager side. */
  unmanaged: number;

  /** Records that had at least one parseable row in range. */
  recordsWithHistory: number;
  recordsScanned: number;

  /**
   * ⚠️ NON-BLANK LINES THAT parseStageHistory REFUSED. It skips a malformed row
   * rather than throwing, which is right — one bad line must not take the KPI
   * down. But a silent skip turns a lost move into an invisible one, so it is
   * counted here and shown. Expected to be 0 forever; interesting the day it
   * is not.
   */
  skipped: number;

  /** Records whose log disagrees with their current stage — see `missedMove`. */
  missedMoves: number;

  /**
   * 🔴 SURFACED, NEVER FILTERED. Many records entering one stage inside one
   * minute is not a person working. The rows already carry the timestamp and
   * the stage, so the threshold can change — or a reader can disagree with it
   * entirely — WITHOUT re-recording anything. Round 163 kept the verdict out
   * of the row for exactly this.
   */
  clusters: StageCluster[];

  /** Earliest row seen anywhere, or null. "Recording since …" comes from here. */
  since: string | null;
}

export interface StageKpiOptions {
  window?: StageKpiWindow;
  /** Records in one stage inside one minute before it counts as a cluster. */
  clusterMin?: number;
}

const CLUSTER_MIN_DEFAULT = 5;

/**
 * Tally moves per rep and per manager across a set of records.
 *
 * 🔴 THE WHOLE LOG IS PARSED BEFORE THE WINDOW IS APPLIED, AND THE ORDER IS
 * LOAD-BEARING. `from` is the previous row's `to`, so filtering the text by
 * date first would hand row N a null origin it does not have — every record
 * would gain a phantom "first sighting" at the window's edge and lose a real
 * move. Parse, derive, THEN filter.
 */
export function stageKpi(
  records: StageKpiRecord[],
  historyFieldId: string | null,
  opts: StageKpiOptions = {},
): StageKpiResult {
  const rep = new Map<string, number>();
  const mgr = new Map<string, number>();
  const clusterBuckets = new Map<string, Set<string>>();

  const out: StageKpiResult = {
    perRep: [],
    perManager: [],
    moves: 0,
    firstSightings: 0,
    unattributed: 0,
    unmanaged: 0,
    recordsWithHistory: 0,
    recordsScanned: records.length,
    skipped: 0,
    missedMoves: 0,
    clusters: [],
    since: null,
  };

  if (!historyFieldId) return out;

  const lo = opts.window?.from ? Date.parse(opts.window.from) : null;
  const hi = opts.window?.to ? Date.parse(opts.window.to) : null;
  const inWindow = (at: string): boolean => {
    if (lo === null && hi === null) return true;
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return false; // an undateable row cannot be placed
    if (lo !== null && t < lo) return false;
    if (hi !== null && t >= hi) return false;
    return true;
  };

  for (const r of records) {
    const raw = r.cf[historyFieldId];
    const rows = parseStageHistory(raw);

    // ⚠️ ONE FACT, TWO FUNCTIONS, NO SECOND PARSER. The skip count is the
    // non-blank line count minus the rows that survived. Re-splitting the text
    // here with its own field rules would be a second copy of the format —
    // exactly what deriving `from` was avoiding.
    const lines = countStageHistoryLines(raw);
    if (lines > rows.length) out.skipped += lines - rows.length;

    if (!rows.length) continue;

    // "since" is the earliest row ANYWHERE, ignoring the window — it answers
    // "how far back does this log go", which a window must not narrow.
    for (const row of rows) {
      if (out.since === null || row.at < out.since) out.since = row.at;
    }

    // The log disagreeing with the record is a missed move whether or not any
    // of its rows fall in the window.
    if (rows[rows.length - 1].to !== r.stageId) out.missedMoves += 1;

    let counted = false;
    for (const row of rows) {
      if (!inWindow(row.at)) continue;
      counted = true;

      if (row.from === null) {
        out.firstSightings += 1;
        continue; // NOT a move — see StageKpiResult.firstSightings
      }

      out.moves += 1;
      bump(clusterBuckets, `${minuteOf(row.at)}|${row.to}`, r.id);

      if (row.ownerId) rep.set(row.ownerId, (rep.get(row.ownerId) || 0) + 1);
      else out.unattributed += 1;

      if (row.managerIds.length)
        for (const m of row.managerIds) mgr.set(m, (mgr.get(m) || 0) + 1);
      else out.unmanaged += 1;
    }
    if (counted) out.recordsWithHistory += 1;
  }

  const min = opts.clusterMin ?? CLUSTER_MIN_DEFAULT;
  for (const [key, ids] of clusterBuckets) {
    if (ids.size < min) continue;
    const [at, to] = splitBucketKey(key);
    out.clusters.push({ at, to, records: ids.size });
  }
  out.clusters.sort((a, b) => b.records - a.records || a.at.localeCompare(b.at));

  out.perRep = rank(rep);
  out.perManager = rank(mgr);
  return out;
}

/**
 * Non-blank lines in a stored history value.
 *
 * ⚠️ BLANK-LINE RULE COPIED FROM parseStageHistory DELIBERATELY AND ONLY THAT
 * ONE. Anything more — the pipe split, the at/to requirement — would be a
 * second implementation of the format, and the two would drift.
 */
export function countStageHistoryLines(raw: unknown): number {
  const text = Array.isArray(raw) ? raw.join("\n") : String(raw ?? "");
  let n = 0;
  for (const line of text.split(/\r?\n/)) if (line.trim()) n += 1;
  return n;
}

/** Rows in a record's log that are real transitions. Exported for the panel. */
export function transitionsOf(rows: StageHistoryRow[]): StageHistoryRow[] {
  return rows.filter((r) => r.from !== null);
}

function bump(m: Map<string, Set<string>>, key: string, id: string): void {
  let s = m.get(key);
  if (!s) {
    s = new Set();
    m.set(key, s);
  }
  s.add(id);
}

/** `2026-09-28T09:53:26.440Z` -> `2026-09-28T09:53`. "" when unparseable. */
function minuteOf(at: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at) ? at.slice(0, 16) : "";
}

// The bucket key is `<minute>|<stageId>`, and a stage id never contains "|"
// because encodeStageRow joins on it. Split on the FIRST pipe only.
function splitBucketKey(key: string): [string, string] {
  const i = key.indexOf("|");
  return [key.slice(0, i), key.slice(i + 1)];
}

/**
 * Highest first, then by id so the order is stable across renders.
 *
 * ⚠️ NO NAMES IN HERE. Resolving a user id is the caller's job — this module
 * has no user map, and a module that invented "Former user" strings would make
 * the arithmetic depend on a lookup table.
 */
function rank(m: Map<string, number>): StageKpiTally[] {
  return [...m.entries()]
    .map(([id, moves]) => ({ id, moves }))
    .sort((a, b) => b.moves - a.moves || a.id.localeCompare(b.id));
}

/** The calendar month containing `now`, as a window. Jack's unit is a month. */
export function monthWindow(now: number): StageKpiWindow {
  const d = new Date(now);
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}
