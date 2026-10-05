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
  /**
   * 🔴 ROUND 171 — WHEN THE CASE WAS CREATED, AND IT DECIDES WHETHER ROW 1 IS
   * A MOVE. See CREATION_WINDOW_MS. "" or absent means we cannot tell, and the
   * row is then COUNTED — see the comment there for why that direction.
   */
  createdAt?: string;
  cf: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 ROUND 171 — ROW 1 IS NORMALLY A REAL MOVE, AND THE SCREEN COUNTED NONE.
//
// Live, build 169: "Counting 0 moves across 16 records — 16 first sightings
// not counted." Every recorded case had exactly one row and `from === null` on
// row 1 sent all sixteen to `firstSightings`. A Moves screen that counts zero
// moves is not a cautious Moves screen; it is a blank one.
//
// ⚠️ THE OLD REASONING WAS SOUND AND ITS PREMISE WAS WRONG. It said the origin
// "was never observed", which is true, and concluded the record never WENT
// anywhere, which does not follow. The stage workflow fires ON A STAGE CHANGE.
// So a first row means somebody moved this case and we do not know where from
// — an unknown origin, not a non-event.
//
// ✅ THE ONE EXCEPTION, AND IT IS OBSERVED RATHER THAN ASSUMED. The workflow
// also fires on creation: the live workflow test's brand-new case had TWO rows
// after exactly one move. Row 1 there is the case appearing, not going.
//
// 🔴 WHY 2 MINUTES. The separator has to sit above the gap between a case
// being created and its creation row landing, and below the gap between a case
// being created and a human moving it:
//
//   below   the recorder stamps `at` when the WEBHOOK LANDS, not when the move
//           happened. ✅ MEASURED LIVE TWICE ON 5 OCTOBER: a case created at
//           NEW LEAD got its creation row ~60 SECONDS later, both times — the
//           stage workflow's own 30-second wait plus processing. 2 minutes was
//           a guess with 60 seconds of headroom; 5 gives it four times that,
//           which is what a measurement made twice rather than twenty deserves.
//   above   a move inside 5 minutes of creation means somebody created a case
//           and moved it in the same sitting. It happens, and when it does we
//           undercount by one — stated, bounded, and the same direction the old
//           code erred in. ⚠️ RAISING THE WINDOW WIDENS THAT UNDERCOUNT, and
//           that is the trade: a creation row counted as a move is a wrong
//           number nobody can see, while a fast first move lost is a known
//           one. Lose the one we can name.
//
// ⚠️ THE KNOWN COST, NAMED: an IMPORT that creates and immediately files
// records reads as creation, not as moves. That is the right answer for an
// import and the wrong one for a bulk re-stage done seconds after a load. The
// constant is one number so the trade can be re-made without re-recording.
//
// 🔴 AND A MISSING createdAt COUNTS THE ROW. A record whose creation time we
// cannot read is not evidence that the row IS creation — treating it as such
// would silently drop moves for exactly the records we know least about. It
// counts, with an unknown origin, where it is visible.
// ═══════════════════════════════════════════════════════════════════════════
export const CREATION_WINDOW_MS = 300_000;

/** True when this row looks like the case appearing rather than going. */
export function isCreationRow(rowAt: string, createdAt: string | undefined): boolean {
  if (!createdAt) return false;
  const a = Date.parse(rowAt);
  const c = Date.parse(createdAt);
  if (!Number.isFinite(a) || !Number.isFinite(c)) return false;
  return Math.abs(a - c) <= CREATION_WINDOW_MS;
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
   * 🔴 MOVES, INCLUDING THE ONES WHOSE ORIGIN WE NEVER SAW — round 171.
   * perRep sums to AT MOST this (less `unattributed`); perManager sums to
   * MORE, by design.
   */
  moves: number;

  /**
   * 🔴 MOVES COUNTED IN `moves` WHOSE STARTING STAGE IS UNKNOWN. Row 1 of a
   * log, where the recorder had nothing to derive `from` from.
   *
   * ⚠️ A SUBSET, NOT A SEPARATE TOTAL. It is printed so the reader knows how
   * much of the number is "somebody moved this, from somewhere" rather than a
   * fully observed A → B. Subtracting it from `moves` would be wrong.
   */
  unknownOrigin: number;

  /**
   * 🔴 ROWS THAT ARE THE CASE BEING CREATED, EXCLUDED FROM `moves`.
   *
   * The stage workflow fires on creation as well as on a change, so a case's
   * first row can be the case appearing. Those are identified by their time
   * sitting within CREATION_WINDOW_MS of `createdAt` — observed, not assumed:
   * the live workflow test's new case had two rows after one move.
   */
  creationRows: number;

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
    unknownOrigin: 0,
    creationRows: 0,
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

      // 🔴 ROUND 171 — THE ONLY ROW THAT IS NOT A MOVE IS THE CASE APPEARING.
      // See CREATION_WINDOW_MS. Everything else with a null origin is somebody
      // moving a case from a stage we never observed, which is a move.
      if (row.from === null) {
        if (isCreationRow(row.at, r.createdAt)) {
          out.creationRows += 1;
          continue;
        }
        out.unknownOrigin += 1;
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

// ═══════════════════════════════════════════════════════════════════════════
// ROUND 174 — THE MOVES KPIs.
//
// 🔴 EVERY NUMBER HERE COMES OFF THE BOARD PAYLOAD THIS PAGE ALREADY HAS. No
// function below fetches anything, and none of them can: they take arrays. The
// cost of the whole screen is zero extra requests, which is the constraint the
// round was given and the reason it is arithmetic rather than an API.
//
// 🔴 AND EVERY ONE CARRIES THE CASE IDS BEHIND IT. A KPI you cannot click into
// is a number nobody can check — and the records are already in memory, so the
// drill-down costs nothing but the field.
//
// ⚠️ THE FILTERS ARE APPLIED BY THE CALLER, ONCE, TO THE RECORD ARRAY. That is
// deliberate: "every number follows the filters" is then true by construction
// rather than by five functions each remembering to. Only the WINDOW is passed
// in, because a window cuts rows inside a record rather than records.
// ═══════════════════════════════════════════════════════════════════════════

/** What the KPIs need from a record, beyond what stageAge/stageKpi read. */
export interface KpiRecord extends StageKpiRecord {
  pipelineId: string;
  pipelineName: string;
  ownerId: string;
  /** GoHighLevel's status: open / won / lost / abandoned. */
  status: string;
  /**
   * ⚠️ WHEN THE STATUS LAST CHANGED, AND IT IS THE ONE FIGURE ON THIS SCREEN
   * WITH A CAVEAT ATTACHED. See OpportunityRecord.statusChangedAt: a bulk edit
   * moves it, and it only ever describes the CURRENT status.
   */
  statusChangedAt?: string;
}

export interface StageDef {
  id: string;
  name: string;
  position?: number;
}

/** Stages in the pipeline's own order. Position first, declaration order after. */
export function orderedStages(stages: StageDef[]): StageDef[] {
  return [...stages].sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER;
    const pb = b.position ?? Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
}

const inRange = (at: string, w?: StageKpiWindow): boolean => {
  if (!w || (!w.from && !w.to)) return true;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return false;
  if (w.from && t < Date.parse(w.from)) return false;
  if (w.to && t >= Date.parse(w.to)) return false;
  return true;
};

/** Rows that are real movement: a creation row is not one. */
function movesOf(r: KpiRecord, historyFieldId: string | null): StageHistoryRow[] {
  if (!historyFieldId) return [];
  return parseStageHistory(r.cf[historyFieldId]).filter(
    (row) => !isCreationRow(row.at, r.createdAt),
  );
}

// ───────────────────────────────────────────────────────────────────────────
// 1 · THE STAGE FUNNEL
// ───────────────────────────────────────────────────────────────────────────

export interface FunnelRow {
  stageId: string;
  name: string;
  /** Cases recorded as REACHING this stage in the window. */
  reached: number;
  /** Of those, how many are recorded moving to a LATER stage. */
  movedOn: number;
  /** movedOn / reached, or null when nothing reached it (never 0%). */
  pct: number | null;
  caseIds: string[];
  movedOnIds: string[];
}

export interface Funnel {
  pipelineId: string;
  pipelineName: string;
  rows: FunnelRow[];
}

/**
 * Cases that reached each stage, and the share that moved on.
 *
 * 🔴 "REACHED" MEANS A RECORDED ROW SAYS SO, AND NOTHING ELSE. A case sitting
 * in a stage today with no row for it passed through before the recorder
 * existed, and counting it would mix two different facts under one heading —
 * the screen says so instead.
 *
 * ⚠️ "MOVED ON" IS BY POSITION, NOT BY THE NEXT ROW. A case that skipped a
 * stage still moved on from the one before it; requiring the immediately
 * adjacent stage would score a skip as a stall.
 *
 * 🔴 `pct` IS null, NOT 0, WHEN NOTHING REACHED A STAGE. "0% moved on" reads
 * as a stall; "—" reads as what it is.
 */
export function stageFunnel(
  records: KpiRecord[],
  historyFieldId: string | null,
  stagesByPipeline: Record<string, StageDef[]>,
  opts: { window?: StageKpiWindow } = {},
): Funnel[] {
  const byPipeline = new Map<string, KpiRecord[]>();
  for (const r of records) {
    const list = byPipeline.get(r.pipelineId);
    if (list) list.push(r);
    else byPipeline.set(r.pipelineId, [r]);
  }

  const out: Funnel[] = [];
  for (const [pipelineId, recs] of byPipeline) {
    const stages = orderedStages(stagesByPipeline[pipelineId] || []);
    if (!stages.length) continue;
    const posOf = new Map(stages.map((s, i) => [s.id, i]));

    const reached = new Map<string, Set<string>>();
    const movedOn = new Map<string, Set<string>>();
    for (const s of stages) {
      reached.set(s.id, new Set());
      movedOn.set(s.id, new Set());
    }

    for (const r of recs) {
      const rows = movesOf(r, historyFieldId).filter((row) => inRange(row.at, opts.window));
      // Highest position this case is recorded as having reached in the window.
      let top = -1;
      for (const row of rows) {
        const p = posOf.get(row.to);
        if (p === undefined) continue;
        reached.get(row.to)?.add(r.id);
        if (p > top) top = p;
      }
      // Anything below the top it reached, it moved on FROM.
      if (top >= 0)
        for (const [sid, p] of posOf)
          if (p < top && reached.get(sid)?.has(r.id)) movedOn.get(sid)?.add(r.id);
    }

    out.push({
      pipelineId,
      pipelineName: recs[0]?.pipelineName || "",
      rows: stages.map((s) => {
        const hit = reached.get(s.id) ?? new Set<string>();
        const on = movedOn.get(s.id) ?? new Set<string>();
        return {
          stageId: s.id,
          name: s.name,
          reached: hit.size,
          movedOn: on.size,
          pct: hit.size ? Math.round((on.size / hit.size) * 100) : null,
          caseIds: [...hit],
          movedOnIds: [...on],
        };
      }),
    });
  }
  out.sort((a, b) => a.pipelineName.localeCompare(b.pipelineName));
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// 2 · TIME IN STAGE
// ───────────────────────────────────────────────────────────────────────────

export interface StageDuration {
  stageId: string;
  name: string;
  avg: number;
  median: number;
  /** Completed intervals measured, NOT cases. One case can contribute several. */
  n: number;
  caseIds: string[];
}

export interface TimeInStage {
  recorded: StageDuration[];
  /**
   * 🔴 THE SEPARATE, LABELLED FIGURE — never mixed into `recorded`. Cases with
   * no recorded rows at all, dated by GoHighLevel's own stage date. That field
   * is moved by bulk writes (fourteen records share a 2,880-minute gap from one
   * correction while still at NEW LEAD), so averaging it in with measured
   * intervals would launder a known-bad number into a good one.
   */
  approximate: { n: number; avg: number; median: number; caseIds: string[] };
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
};
const mean = (xs: number[]): number =>
  xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0;

/**
 * Days spent in each stage, from consecutive recorded rows.
 *
 * 🔴 COMPLETED INTERVALS ONLY. The last row has no next row, so the case is
 * STILL in that stage and its stay has no length yet. Counting time-so-far as
 * if it were finished drags every average toward "however long ago we looked".
 *
 * ⚠️ AN INTERVAL BELONGS TO THE WINDOW ITS START ROW FALLS IN. A stay that
 * began in March and ended in October is March's; splitting it would invent a
 * duration neither row supports.
 */
export function timeInStage(
  records: KpiRecord[],
  historyFieldId: string | null,
  stageNames: Map<string, string>,
  opts: { window?: StageKpiWindow; now?: number } = {},
): TimeInStage {
  const per = new Map<string, { days: number[]; ids: Set<string> }>();
  const approx: number[] = [];
  const approxIds: string[] = [];
  const now = opts.now ?? Date.now();

  for (const r of records) {
    const rows = historyFieldId ? parseStageHistory(r.cf[historyFieldId]) : [];
    if (rows.length < 2) {
      // 🔴 NO MEASURABLE INTERVAL. Falls to GoHighLevel's date, and lands in
      // the approximate bucket — which the screen prints on its own line.
      const t = Date.parse(r.stageChangedAt || "");
      if (Number.isFinite(t) && now >= t) {
        const d = Math.floor((now - t) / 86_400_000);
        approx.push(d);
        approxIds.push(r.id);
      }
      continue;
    }
    for (let i = 0; i < rows.length - 1; i++) {
      if (!inRange(rows[i].at, opts.window)) continue;
      const a = Date.parse(rows[i].at);
      const b = Date.parse(rows[i + 1].at);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
      const stage = rows[i].to;
      let cur = per.get(stage);
      if (!cur) {
        cur = { days: [], ids: new Set() };
        per.set(stage, cur);
      }
      cur.days.push(Math.round(((b - a) / 86_400_000) * 10) / 10);
      cur.ids.add(r.id);
    }
  }

  return {
    recorded: [...per.entries()]
      .map(([stageId, v]) => ({
        stageId,
        name: stageNames.get(stageId) || stageId,
        avg: mean(v.days),
        median: median(v.days),
        n: v.days.length,
        caseIds: [...v.ids],
      }))
      .sort((a, b) => b.median - a.median || a.name.localeCompare(b.name)),
    approximate: {
      n: approx.length,
      avg: mean(approx),
      median: median(approx),
      caseIds: approxIds,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 3 · SPEED TO FIRST MOVE
// ───────────────────────────────────────────────────────────────────────────

export interface FirstMoveTally {
  id: string;
  avg: number;
  median: number;
  n: number;
  caseIds: string[];
}

/**
 * Days from `createdAt` to the first move off the entry stage, per rep.
 *
 * 🔴 THE CREATION ROW IS NOT A MOVE, so it is filtered before the first row is
 * taken — otherwise every case would read about a minute and the number would
 * measure the workflow's own delay rather than anybody's work.
 *
 * ⚠️ CREDITED TO THE ROW'S OWNER, NOT THE RECORD'S. The record's owner today
 * may not be who moved it; the row recorded who did at the time, which is the
 * whole reason round 163 wrote it down.
 */
export function speedToFirstMove(
  records: KpiRecord[],
  historyFieldId: string | null,
  opts: { window?: StageKpiWindow } = {},
): { perRep: FirstMoveTally[]; noFirstMove: number; noFirstMoveIds: string[] } {
  const per = new Map<string, { days: number[]; ids: Set<string> }>();
  let noFirstMove = 0;
  const noIds: string[] = [];

  for (const r of records) {
    const first = movesOf(r, historyFieldId)[0];
    const born = Date.parse(r.createdAt || "");
    if (!first || !Number.isFinite(born)) {
      noFirstMove += 1;
      noIds.push(r.id);
      continue;
    }
    if (!inRange(first.at, opts.window)) continue;
    const t = Date.parse(first.at);
    if (!Number.isFinite(t) || t < born) continue;
    const who = first.ownerId || "";
    let cur = per.get(who);
    if (!cur) {
      cur = { days: [], ids: new Set() };
      per.set(who, cur);
    }
    cur.days.push(Math.round(((t - born) / 86_400_000) * 10) / 10);
    cur.ids.add(r.id);
  }

  return {
    perRep: [...per.entries()]
      .map(([id, v]) => ({
        id,
        avg: mean(v.days),
        median: median(v.days),
        n: v.days.length,
        caseIds: [...v.ids],
      }))
      .sort((a, b) => a.median - b.median || b.n - a.n),
    noFirstMove,
    noFirstMoveIds: noIds,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 4 · WON / LOST
// ───────────────────────────────────────────────────────────────────────────

export interface WonLostTally {
  id: string;
  won: number;
  lost: number;
  /** won / (won + lost), or null when neither happened. Never 0% by default. */
  winRate: number | null;
  wonIds: string[];
  lostIds: string[];
}

/**
 * Won and lost per rep in the window, dated by `statusChangedAt`.
 *
 * 🔴 CURRENT STATUS ONLY, AND THE SCREEN SAYS SO. A case reopened after being
 * won reads as open: GoHighLevel keeps one status and one timestamp, so the
 * history of a status does not exist to be read. Option 1 of the three in
 * report 173; recording status changes the way stage changes are recorded is
 * its own round.
 *
 * ⚠️ AND `statusChangedAt` IS MOVED BY BULK EDITS. That caveat rides beside
 * every number from here.
 */
export function wonLost(
  records: KpiRecord[],
  opts: { window?: StageKpiWindow } = {},
): { perRep: WonLostTally[]; undated: number; undatedIds: string[] } {
  const per = new Map<string, { won: string[]; lost: string[] }>();
  let undated = 0;
  const undatedIds: string[] = [];

  for (const r of records) {
    const st = (r.status || "").toLowerCase();
    if (st !== "won" && st !== "lost") continue;
    const at = r.statusChangedAt || "";
    if (!at) {
      // 🔴 COUNTED AND NAMED, NEVER DROPPED INTO THE WINDOW SILENTLY. A won
      // case with no date cannot be placed in a period, and treating it as
      // in-period would inflate whichever period was being looked at.
      undated += 1;
      undatedIds.push(r.id);
      continue;
    }
    if (!inRange(at, opts.window)) continue;
    const who = r.ownerId || "";
    let cur = per.get(who);
    if (!cur) {
      cur = { won: [], lost: [] };
      per.set(who, cur);
    }
    (st === "won" ? cur.won : cur.lost).push(r.id);
  }

  return {
    perRep: [...per.entries()]
      .map(([id, v]) => {
        const total = v.won.length + v.lost.length;
        return {
          id,
          won: v.won.length,
          lost: v.lost.length,
          winRate: total ? Math.round((v.won.length / total) * 100) : null,
          wonIds: v.won,
          lostIds: v.lost,
        };
      })
      .sort((a, b) => b.won - a.won || a.id.localeCompare(b.id)),
    undated,
    undatedIds,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// 5 · THE WINDOWS THE FILTER OFFERS
// ───────────────────────────────────────────────────────────────────────────

export type KpiRange = "week" | "month" | "lastMonth" | "all" | "custom";

/**
 * 🔴 UTC, LIKE monthWindow, AND FOR THE SAME REASON. Stage rows are stored in
 * UTC; a window built in the viewer's zone would move the boundary under them
 * and two people in two zones would read different totals for one month. The
 * dashboard DISPLAYS Eastern (round 168) and COMPARES in UTC — those are
 * different jobs and conflating them is how a month gains a day.
 */
export function rangeWindow(range: KpiRange, now: number): StageKpiWindow {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const iso = (t: number) => new Date(t).toISOString();
  if (range === "all") return { from: null, to: null };
  if (range === "week") {
    // Monday as the first day: a sales week that starts on Sunday puts two
    // weekends in one bucket.
    const dow = (d.getUTCDay() + 6) % 7;
    const start = Date.UTC(y, m, d.getUTCDate() - dow);
    return { from: iso(start), to: iso(start + 7 * 86_400_000) };
  }
  if (range === "month") return { from: iso(Date.UTC(y, m, 1)), to: iso(Date.UTC(y, m + 1, 1)) };
  if (range === "lastMonth")
    return { from: iso(Date.UTC(y, m - 1, 1)), to: iso(Date.UTC(y, m, 1)) };
  return { from: null, to: null };
}
