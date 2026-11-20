import type { OpportunityRecord } from "./types";
import { AsyncLocalStorage } from "node:async_hooks";
import { divisionLabel } from "./division";
import { staffingGateHides } from "./sorting";

type AccessMap = Map<string, Set<string>>;

const grantsStore = new AsyncLocalStorage<AccessMap>();

export function runWithGrants<T>(grants: AccessMap, fn: () => T): T {
  return grantsStore.run(grants, fn);
}

export function buildGrants(
  stored: Record<string, string[]> | null,
  validUserIds?: Set<string>,
  validPipelineIds?: Set<string>,
): AccessMap {
  const map: AccessMap = new Map();
  if (stored) {
    for (const [userId, pids] of Object.entries(stored)) {
      if (validUserIds && !validUserIds.has(userId)) continue;
      const set = new Set(
        pids.filter((p) => !validPipelineIds || validPipelineIds.has(p)),
      );
      if (set.size) map.set(userId, set);
    }
    return map;
  }

  for (const [userId, set] of parseAccessMap()) {
    if (validUserIds && !validUserIds.has(userId)) continue;
    const kept = new Set(
      [...set].filter((p) => !validPipelineIds || validPipelineIds.has(p)),
    );
    if (kept.size) map.set(userId, kept);
  }
  return map;
}

function parseAccessMap(): AccessMap {
  const map: AccessMap = new Map();
  const raw = (process.env.PIPELINE_ACCESS_MAP || "").trim();
  if (!raw) return map;

  for (const entry of raw.split(/[,;\n]+/)) {
    const e = entry.trim();
    if (!e) continue;
    const idx = e.indexOf(":");
    if (idx < 0) continue;
    const userId = e.slice(0, idx).trim();
    const pids = e
      .slice(idx + 1)
      .split(/[|\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!userId || !pids.length) continue;
    const set = map.get(userId) || new Set<string>();
    for (const p of pids) set.add(p);
    map.set(userId, set);
  }
  return map;
}

export function getUserHomePipelines(userId: string): Set<string> {
  const scoped = grantsStore.getStore();
  if (scoped) return scoped.get(userId) || new Set<string>();
  return parseAccessMap().get(userId) || new Set<string>();
}

export function userDivisions(
  userId: string,
  pipelineNameById: Map<string, string>,
): string[] {
  const out = new Set<string>();
  for (const pid of getUserHomePipelines(userId)) {
    const name = pipelineNameById.get(pid);
    if (name) out.add(divisionLabel(name));
  }
  return [...out];
}

export function applyAccess(
  records: OpportunityRecord[],
  viewer: { userId: string; isAdmin: boolean },

  opts?: { staffingGate?: boolean },
): OpportunityRecord[] {
  if (viewer.isAdmin) return records.map((r) => ({ ...r, shared: false }));
  const home = getUserHomePipelines(viewer.userId);
  const level = opts?.staffingGate ? staffingLevel(viewer.userId, false) : "any";
  const out: OpportunityRecord[] = [];
  for (const r of records) {
    const owned =
      r.ownerId === viewer.userId || r.followerIds.includes(viewer.userId);
    const isHome = home.has(r.pipelineId);
    const unassigned = !r.ownerId;

    if (!owned && staffingGateHides(r, { isAdmin: false, staffing: level })) continue;
    if (isHome && (owned || unassigned)) {
      out.push({ ...r, shared: false });
    } else if (owned) {
      out.push({ ...r, shared: true });
    }

  }
  return out;
}

const folderStore = new AsyncLocalStorage<AccessMap>();
const masterStore = new AsyncLocalStorage<Set<string>>();

export function runWithExtraGrants<T>(
  folders: AccessMap,
  master: Set<string>,
  fn: () => T,
): T {
  return folderStore.run(folders, () => masterStore.run(master, fn));
}

export function getUserFolders(userId: string): Set<string> {
  return folderStore.getStore()?.get(userId) ?? new Set<string>();
}

export function hasMasterView(userId: string, isAdmin: boolean): boolean {

  if (isAdmin) return true;
  return masterStore.getStore()?.has(userId) ?? false;
}

export function getMasterUsers(): string[] {
  return [...(masterStore.getStore() ?? [])];
}

const staffingStore = new AsyncLocalStorage<{
  staffing: Map<string, "self" | "any">;
  peer: Set<string>;
}>();

export function runWithStaffing<T>(
  staffing: Map<string, "self" | "any">,
  peer: Set<string>,
  fn: () => T,
): T {
  return staffingStore.run({ staffing, peer }, fn);
}

export function staffingLevel(
  userId: string,
  isAdmin: boolean,
): "admin" | "any" | "self" | "off" {
  if (isAdmin) return "admin";
  return staffingStore.getStore()?.staffing.get(userId) ?? "off";
}

export function canUsePeerTransfer(userId: string, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return staffingStore.getStore()?.peer.has(userId) ?? false;
}

const caseManagerStore = new AsyncLocalStorage<AccessMap>();

export function runWithCaseManagers<T>(map: AccessMap, fn: () => T): T {
  return caseManagerStore.run(map, fn);
}

type ReferralAccessEntry =
  | { mode: "agency" }
  | { mode: "divisions"; divisions: string[] };

const referralAccessStore = new AsyncLocalStorage<Map<string, ReferralAccessEntry>>();

export function runWithReferralAccess<T>(
  map: Map<string, ReferralAccessEntry>,
  fn: () => T,
): T {
  return referralAccessStore.run(map, fn);
}

export function referralDivisions(
  userId: string,
  pipelineNameById: Map<string, string>,
  isAdmin: boolean,

  partnerDivisionOptions?: readonly string[] | null,
): string[] | null {
  if (isAdmin) return null;
  const entry = userId ? referralAccessStore.getStore()?.get(userId) : undefined;

  if (!entry) return narrowToOptions(userDivisions(userId, pipelineNameById), partnerDivisionOptions);
  if (entry.mode === "agency") return null;

  return [...entry.divisions];
}

function narrowToOptions(
  derived: string[],
  options?: readonly string[] | null,
): string[] {
  if (!options || !options.length) return derived;
  const allow = new Set(options.filter((o) => o && o !== "All"));
  return derived.filter((d) => allow.has(d));
}

export type ReferralScopeKind = "all" | "derived" | "none" | "explicit" | "unmatched";

export function referralScopeKind(
  userId: string,
  pipelineNameById: Map<string, string>,
  isAdmin: boolean,

  partnerDivisionOptions?: readonly string[] | null,
): ReferralScopeKind {
  if (isAdmin) return "all";
  const entry = userId ? referralAccessStore.getStore()?.get(userId) : undefined;
  if (!entry) {
    const raw = userDivisions(userId, pipelineNameById);
    if (narrowToOptions(raw, partnerDivisionOptions).length) return "derived";

    return raw.length ? "unmatched" : "none";
  }
  if (entry.mode === "agency") return "all";
  return entry.divisions.length ? "derived" : "explicit";
}

export function getCaseManagers(repId: string): string[] | null {
  const store = caseManagerStore.getStore();
  if (!store || !repId) return null;
  const hit = store.get(repId);
  return hit ? [...hit] : null;
}

export function allCaseManagers(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [rep, mgrs] of caseManagerStore.getStore() ?? []) out[rep] = [...mgrs];
  return out;
}

export function buildIdMap(stored: Record<string, string[]> | undefined): AccessMap {
  const map: AccessMap = new Map();
  for (const [k, ids] of Object.entries(stored || {}))
    map.set(k, new Set(ids.filter(Boolean)));
  return map;
}

export { caseManagerColumns, caseManagerPreview } from "@/lib/caseManagerLabels";
