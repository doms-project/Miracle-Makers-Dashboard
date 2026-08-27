import type { OpportunityRecord } from "./types";
import { AsyncLocalStorage } from "node:async_hooks";
import { divisionLabel } from "./division";

// Task 3 — pipeline access (division scoping).
//
// Two separate ways a user reaches a record:
//   1. HOME pipelines — their division(s). They browse these, and may also see
//      UNASSIGNED work there so it can be picked up.
//   2. SHARED records — a record in ANY pipeline they own or follow. They get
//      the RECORD (flagged shared), never the pipeline.
//
// Rule (per viewer, non-admin):
//   home pipeline AND (owner OR follower OR unassigned)  -> visible, shared = false
//   ANY  pipeline AND (owner OR follower)                -> visible, shared = true
//   otherwise                                            -> excluded
// Admin -> everything, shared = false. Fails closed: an ungranted user (no home
// pipelines) browses nothing, but still sees what they own/follow (as shared).
//
// ⚠️ ASYMMETRY: `unassigned` counts ONLY in home pipelines. An unassigned record
// in another division must never surface — otherwise every rep would see every
// unowned lead account-wide, which defeats the scoping.
//
// The MAP SOURCE is deliberately behind getUserHomePipelines() so it can move
// from the env var to a GHL user custom field later without touching callers.
// Env now: PIPELINE_ACCESS_MAP = "userId:pid|pid,userId:pid|pid".

type AccessMap = Map<string, Set<string>>;

// Request-scoped grants. The stored map is fetched ONCE per request and held in
// AsyncLocalStorage — never in a module variable. Two reasons:
//   1. concurrent requests on one lambda must not share another viewer's read;
//   2. the users-lookup bug was a cached EMPTY map that became permanent for a
//      warm lambda. A failed read must never persist.
const grantsStore = new AsyncLocalStorage<AccessMap>();

/** Run `fn` with these grants installed for the duration of the request. */
export function runWithGrants<T>(grants: AccessMap, fn: () => T): T {
  return grantsStore.run(grants, fn);
}

/**
 * Build the effective grants for one request.
 *   stored custom value  -> use it (an empty {} is a real state: all unmapped)
 *   missing / bad / failed fetch -> FALL BACK to PIPELINE_ACCESS_MAP
 * Then validate: a stale userId or pipelineId (deleted user, deleted pipeline)
 * is ignored rather than crashing the filter — intersect against the live lists.
 */
export function buildGrants(
  stored: Record<string, string[]> | null,
  validUserIds?: Set<string>,
  validPipelineIds?: Set<string>,
): AccessMap {
  const map: AccessMap = new Map();
  if (stored) {
    for (const [userId, pids] of Object.entries(stored)) {
      if (validUserIds && !validUserIds.has(userId)) continue; // stale user
      const set = new Set(
        pids.filter((p) => !validPipelineIds || validPipelineIds.has(p)),
      );
      if (set.size) map.set(userId, set);
    }
    return map;
  }
  // Fallback: the env var, validated the same way.
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
  // Entries separated by comma / semicolon / newline; within an entry:
  //   userId : pipelineId | pipelineId | ...
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

// The user's HOME pipelines. Empty set = ungranted (sees only owned/followed).
// Reads the request-scoped grants when a route has installed them
// (runWithGrants); otherwise falls back to the env var so any un-wrapped path
// still behaves, just without the live custom value.
export function getUserHomePipelines(userId: string): Set<string> {
  const scoped = grantsStore.getStore();
  if (scoped) return scoped.get(userId) || new Set<string>();
  return parseAccessMap().get(userId) || new Set<string>();
}

// The division label(s) a user belongs to, derived from their HOME pipelines'
// names. Empty array = no division mapped — the picker renders "—" rather than
// hiding the user (a new hire must not be invisible).
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

// Filter + tag records for one viewer. Returns a NEW array; each surviving
// record gets its `shared` flag set correctly for this viewer.
export function applyAccess(
  records: OpportunityRecord[],
  viewer: { userId: string; isAdmin: boolean },
): OpportunityRecord[] {
  if (viewer.isAdmin) return records.map((r) => ({ ...r, shared: false }));
  const home = getUserHomePipelines(viewer.userId);
  const out: OpportunityRecord[] = [];
  for (const r of records) {
    const owned =
      r.ownerId === viewer.userId || r.followerIds.includes(viewer.userId);
    const isHome = home.has(r.pipelineId);
    const unassigned = !r.ownerId;
    if (isHome && (owned || unassigned)) {
      out.push({ ...r, shared: false });
    } else if (owned) {
      out.push({ ...r, shared: true });
    }
    // else: excluded (includes the asymmetry — non-home unassigned never shows)
  }
  return out;
}
