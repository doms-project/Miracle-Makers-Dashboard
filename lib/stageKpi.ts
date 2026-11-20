import { parseStageHistory, type StageHistoryRow } from "@/lib/stageHistory";

export interface StageKpiRecord {
  id: string;
  stageId: string;

  stageChangedAt?: string;

  createdAt?: string;
  cf: Record<string, unknown>;
}

export const CREATION_WINDOW_MS = 300_000;

export function isCreationRow(rowAt: string, createdAt: string | undefined): boolean {
  if (!createdAt) return false;
  const a = Date.parse(rowAt);
  const c = Date.parse(createdAt);
  if (!Number.isFinite(a) || !Number.isFinite(c)) return false;
  return Math.abs(a - c) <= CREATION_WINDOW_MS;
}

export type StageAgeSource = "history" | "ghl";

export interface StageAge {
  days: number;
  at: string;
  source: StageAgeSource;

  missedMove: boolean;
}

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

function daysBetween(iso: string | undefined | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = Math.floor((now - t) / 86_400_000);
  return d >= 0 ? d : null;
}

export interface StageKpiTally {

  id: string;
  moves: number;
}

export interface StageCluster {

  at: string;
  to: string;
  records: number;
}

export interface StageKpiWindow {

  from: string | null;

  to: string | null;
}

export interface StageKpiResult {
  perRep: StageKpiTally[];
  perManager: StageKpiTally[];

  moves: number;

  unknownOrigin: number;

  creationRows: number;

  unattributed: number;

  unmanaged: number;

  recordsWithHistory: number;
  recordsScanned: number;

  skipped: number;

  missedMoves: number;

  clusters: StageCluster[];

  since: string | null;
}

export interface StageKpiOptions {
  window?: StageKpiWindow;

  clusterMin?: number;
}

const CLUSTER_MIN_DEFAULT = 5;

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
    if (!Number.isFinite(t)) return false;
    if (lo !== null && t < lo) return false;
    if (hi !== null && t >= hi) return false;
    return true;
  };

  for (const r of records) {
    const raw = r.cf[historyFieldId];
    const rows = parseStageHistory(raw);

    const lines = countStageHistoryLines(raw);
    if (lines > rows.length) out.skipped += lines - rows.length;

    if (!rows.length) continue;

    for (const row of rows) {
      if (out.since === null || row.at < out.since) out.since = row.at;
    }

    if (rows[rows.length - 1].to !== r.stageId) out.missedMoves += 1;

    let counted = false;
    for (const row of rows) {
      if (!inWindow(row.at)) continue;
      counted = true;

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

export function countStageHistoryLines(raw: unknown): number {
  const text = Array.isArray(raw) ? raw.join("\n") : String(raw ?? "");
  let n = 0;
  for (const line of text.split(/\r?\n/)) if (line.trim()) n += 1;
  return n;
}

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

function minuteOf(at: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(at) ? at.slice(0, 16) : "";
}

function splitBucketKey(key: string): [string, string] {
  const i = key.indexOf("|");
  return [key.slice(0, i), key.slice(i + 1)];
}

function rank(m: Map<string, number>): StageKpiTally[] {
  return [...m.entries()]
    .map(([id, moves]) => ({ id, moves }))
    .sort((a, b) => b.moves - a.moves || a.id.localeCompare(b.id));
}

export function monthWindow(now: number): StageKpiWindow {
  const d = new Date(now);
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

export interface KpiRecord extends StageKpiRecord {
  pipelineId: string;
  pipelineName: string;
  ownerId: string;

  status: string;

  statusChangedAt?: string;
}

export interface StageDef {
  id: string;
  name: string;
  position?: number;
}

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

function movesOf(r: KpiRecord, historyFieldId: string | null): StageHistoryRow[] {
  if (!historyFieldId) return [];
  return parseStageHistory(r.cf[historyFieldId]).filter(
    (row) => !isCreationRow(row.at, r.createdAt),
  );
}

export interface FunnelRow {
  stageId: string;
  name: string;

  reached: number;

  movedOn: number;

  pct: number | null;
  caseIds: string[];
  movedOnIds: string[];
}

export interface Funnel {
  pipelineId: string;
  pipelineName: string;
  rows: FunnelRow[];
}

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

      let top = -1;
      for (const row of rows) {
        const p = posOf.get(row.to);
        if (p === undefined) continue;
        reached.get(row.to)?.add(r.id);
        if (p > top) top = p;
      }

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

export interface StageDuration {
  stageId: string;
  name: string;
  avg: number;
  median: number;

  n: number;
  caseIds: string[];
}

export interface TimeInStage {
  recorded: StageDuration[];

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

export interface FirstMoveTally {
  id: string;
  avg: number;
  median: number;
  n: number;
  caseIds: string[];
}

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

export interface WonLostTally {
  id: string;
  won: number;
  lost: number;

  winRate: number | null;
  wonIds: string[];
  lostIds: string[];
}

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

export type KpiRange = "week" | "month" | "lastMonth" | "all" | "custom";

export function rangeWindow(range: KpiRange, now: number): StageKpiWindow {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const iso = (t: number) => new Date(t).toISOString();
  if (range === "all") return { from: null, to: null };
  if (range === "week") {

    const dow = (d.getUTCDay() + 6) % 7;
    const start = Date.UTC(y, m, d.getUTCDate() - dow);
    return { from: iso(start), to: iso(start + 7 * 86_400_000) };
  }
  if (range === "month") return { from: iso(Date.UTC(y, m, 1)), to: iso(Date.UTC(y, m + 1, 1)) };
  if (range === "lastMonth")
    return { from: iso(Date.UTC(y, m - 1, 1)), to: iso(Date.UTC(y, m, 1)) };
  return { from: null, to: null };
}
