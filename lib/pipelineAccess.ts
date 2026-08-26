import type { OpportunityRecord } from "./types";
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
let _cache: AccessMap | null = null;

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
// Swap the body for a GHL user-field read later; the signature stays the same.
export function getUserHomePipelines(userId: string): Set<string> {
  if (!_cache) _cache = parseAccessMap();
  return _cache.get(userId) || new Set<string>();
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
