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

// ---------------------------------------------------------------------------
// ITEM 4 + 6 — the two scopes that are NOT pipelines.
//
// Held in the same request-scoped store as the pipeline grants (same reasons:
// never a module variable, never a cached failure), but kept SEPARATE from them
// on purpose:
//
//   FOLDERS  a compliance folder may belong to case managers who hold no
//            pipeline at all, so deriving folder access from pipeline access
//            would either over-grant or make that impossible.
//   MASTER   grants a VIEW, not records. The records shown in it are still
//            filtered by the viewer's own pipeline access — so granting Master
//            can never widen what someone can see, only how they see it.
// ---------------------------------------------------------------------------
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
  // Admins always have it — the Master view shows what they can already see,
  // and requiring an admin to grant themselves a view they can't be excluded
  // from would be a footgun with no upside.
  if (isAdmin) return true;
  return masterStore.getStore()?.has(userId) ?? false;
}

// ITEM 5b — WHO holds the Master view, not just whether one person does.
//
// 🔴 READ LIVE, EVERY TIME. This comes from the request-scoped store that
// withGrants fills from the custom value on every request — never a module
// cache, never a list carried over from a previous reassign. That is exactly
// what makes a newly-granted user work with no backfill: anyone granted access
// BEFORE a reassign happens is in that reassign's follower list, because the
// list is built at the moment of the reassign from the map as it then stands.
//
// Admins are NOT in this array — they are not written to the access map (they
// bypass it via isAdminSession). But they DO hold the Master view, so they must
// be added to a reassign's followers too. That union — mapped holders + admins,
// read live from GET /users — is done at the async call site (the move route),
// because this function is sync and shared with hasMasterView's per-record path,
// which cannot become async. A future caller that needs "everyone who can see
// the queue" must union admins the same way, not rely on this array alone.
export function getMasterUsers(): string[] {
  return [...(masterStore.getStore() ?? [])];
}

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 TASK 1 — CASE MANAGERS. Rep user id → the managers who follow their cases.
//
// Same store discipline as the three above: request-scoped, filled by
// `withGrants` from the one custom value it already reads, NEVER a module
// variable. A module cache here would mean a mapping changed on the Access tab
// did not take effect until the lambda recycled.
// ═══════════════════════════════════════════════════════════════════════════
const caseManagerStore = new AsyncLocalStorage<AccessMap>();

export function runWithCaseManagers<T>(map: AccessMap, fn: () => T): T {
  return caseManagerStore.run(map, fn);
}

/**
 * 🔴 `null` AND `[]` ARE DIFFERENT ANSWERS AND THE CALLER MUST TELL THEM APART.
 *
 *   null  this rep has NO ENTRY in the map — they are not managed by this
 *         system at all. Rule A: add nothing, remove nothing, touch nothing.
 *         Most of the 26 users on this account are in this state.
 *   []    this rep HAS an entry and it is deliberately empty — somebody removed
 *         their last manager on the Access tab. That is an instruction to clear,
 *         not an absence.
 *
 * ⚠️ COLLAPSING THEM WOULD BLANK THE Case Manager FIELD ON EVERY UNMANAGED
 * REP'S CASES, on every owner change — 21 of 26 users' records, silently.
 */
// ═══ ROUND 161 — REFERRAL ACCESS: A LAYER ON TOP OF DERIVED, NOT A REPLACEMENT ══
//
// 🔴 A SEPARATE RESOLVER, AND `userDivisions` IS UNTOUCHED BELOW IT. That
// function has five call sites and only two are about referrals:
//
//   referrals/route.ts:511   the partner picker      ← visibility
//   referrals/route.ts:626   the main scoping        ← visibility
//   opportunities/route.ts:48  "Name — DIV" labels   ← provenance
//   notes/route.ts:135         the [DIVISION] prefix ← provenance
//   move/route.ts:68           the transfer division ← provenance
//
// ⚠️ THE LAST THREE SHARE A WORD WITH THIS FEATURE, NOT A QUESTION. Somebody
// granted agency-wide REFERRAL access must not start writing a different
// [DIVISION] prefix on their notes, or relabel themselves in every picker.
// Changing `userDivisions` would move all five; this moves the two that mean
// "what may this person see".
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

/**
 * The divisions whose referrals this viewer may see.
 *
 *   null              EVERY division — an agency grant, or an admin
 *   string[]          exactly these. An EMPTY array means none, and it is a
 *                     real answer rather than a missing one
 *
 * 🔴 `null` IS "ALL" AND `[]` IS "NONE", which is the convention the two
 * referral call sites already use for admins (`pickerDivisions = null`). Kept
 * deliberately so this drops into them without inverting a test.
 */
export function referralDivisions(
  userId: string,
  pipelineNameById: Map<string, string>,
  isAdmin: boolean,
  /**
   * ═══ ROUND 168 — WHAT A PARTNER CAN ACTUALLY BE LABELLED WITH ═════════════
   *
   * 🔴 DERIVED DIVISIONS CAME FROM PIPELINE NAMES AND PIPELINES ARE NOT
   * DIVISIONS. `userDivisions` runs every HOME pipeline through
   * `divisionLabel`, which only strips a workflow suffix — so "ODP DSP
   * Applicant" became "ODP DSP" and "OLTL Caregiver Applicants" became "OLTL
   * Caregiver". Bill, holding four ODP pipelines, derived three divisions of
   * which exactly one can ever match a partner, and his Referrals heading read
   * "ODP DSP + ODP + ODP Staff" with a switcher.
   *
   * ⚠️ ROUND 167 IS WHAT MADE IT VISIBLE, AND THAT WAS THE RIGHT CHANGE. The
   * heading used to come from the records, which never carry those names.
   * Putting access into the heading — so a held division with no data still
   * shows — surfaced a fault one layer below it. The filter was always correct;
   * only the label was wrong, which is why a live check found no leak.
   *
   * 🔴 NARROWED HERE AND NOT IN `userDivisions`, DELIBERATELY. That function
   * has three other callers and not one of them is a permission decision:
   *
   *     app/api/opportunities/route.ts:48            the owner picker's labels
   *     app/api/opportunities/[id]/notes/route.ts    the [DIVISION] note prefix
   *     app/api/opportunities/[id]/move/route.ts     the same prefix on a move
   *
   * Those ask "which programme does this person work in", where "ODP DSP" is a
   * true and useful answer — and the note prefix is already written on live
   * records. Round 162 drew this line; this keeps it.
   *
   * ⚠️ AN EMPTY LIST MEANS "NO OPINION", NOT "NOTHING IS ALLOWED". If
   * `Partner Division` is not a dropdown on an account, its options read `[]` —
   * and filtering against that would empty EVERY non-admin's referral access
   * because a field is the wrong type. A total silent lockout is far worse than
   * three phantom divisions, so the derivation passes through untouched.
   *
   * ⚠️ AND AN EXPLICIT OVERRIDE IS NEVER FILTERED. An admin naming a division
   * means it, even one no partner carries yet — round 162's orphan chips exist
   * to show exactly that. Only the DERIVED path is narrowed.
   */
  partnerDivisionOptions?: readonly string[] | null,
): string[] | null {
  if (isAdmin) return null;
  const entry = userId ? referralAccessStore.getStore()?.get(userId) : undefined;
  // 🔴 ABSENT IS DERIVED, AND IT IS THE DEFAULT ON PURPOSE. Anyone an admin has
  // never touched keeps the behaviour that already works: a grant on OLTL
  // Enrollment means OLTL referrals, with nobody saying so twice.
  if (!entry) return narrowToOptions(userDivisions(userId, pipelineNameById), partnerDivisionOptions);
  if (entry.mode === "agency") return null;
  // ⚠️ AND AN EXPLICIT EMPTY LIST IS RETURNED AS SUCH. `[]` here means "sees no
  // referrals" — an instruction, not an absence. Falling back to derived on an
  // empty list is the one bug this whole three-state design exists to prevent.
  return [...entry.divisions];
}

/**
 * Keep only the divisions a partner or an event can actually be labelled with.
 *
 * ⚠️ "All" IS EXCLUDED FROM THE ALLOW-LIST. It is a value a RECORD can hold,
 * meaning "appears under every division", and it is handled by `inDivision` on
 * the way out. A viewer whose derived access was "All" would match every record
 * by name as well, which is a different and much wider thing than holding a
 * division.
 */
function narrowToOptions(
  derived: string[],
  options?: readonly string[] | null,
): string[] {
  if (!options || !options.length) return derived;
  const allow = new Set(options.filter((o) => o && o !== "All"));
  return derived.filter((d) => allow.has(d));
}

/**
 * 🔴 ROUND 167 — WHY `referralDivisions` ANSWERED WHAT IT ANSWERED.
 *
 * The list alone cannot explain itself. An empty one has TWO causes since round
 * 162 added the override, and they need different sentences on screen:
 *
 *   "all"       admin, or an explicit Agency grant — nothing is withheld.
 *   "derived"   no override; divisions come from the pipelines they hold.
 *   "none"      no override AND no pipelines. The case manager's intended
 *               state: nothing is misconfigured and nobody needs to fix it.
 *   "unmatched" holds pipelines, but not one of their divisions is a value a
 *               partner can carry — a recruiter with only applicant pipelines.
 *               Different from "none": they DO hold something, so telling them
 *               they hold nothing sends them to check a grant they have.
 *   "explicit"  an override holding an EMPTY division list. They may hold
 *               several pipelines; an admin decided they see no referrals.
 *
 * ⚠️ IT REPORTS THE SHAPE OF THE GRANT, NEVER A ROLE. "none" says "holds no
 * pipeline", which is a fact about grants. It does NOT say "is a case manager"
 * — nothing in this system knows that, and reading it off an absent grant would
 * infer a role from an absence, the same rule that bans reading one off a
 * `-Sale` name suffix.
 *
 * ⚠️ AND IT DERIVES FROM THE SAME STORE AS `referralDivisions`, in the same
 * order, so the two cannot disagree. A second function reading a second source
 * is how two answers to one question get shipped.
 */
export type ReferralScopeKind = "all" | "derived" | "none" | "explicit" | "unmatched";

export function referralScopeKind(
  userId: string,
  pipelineNameById: Map<string, string>,
  isAdmin: boolean,
  /**
   * ⚠️ ROUND 168 — THE SAME ALLOW-LIST, AND IT HAS TO BE THE SAME. This decides
   * which sentence a viewer reads about why they see nothing, so it must agree
   * with `referralDivisions` about what "derived" resolves to. Without it a
   * viewer holding only applicant pipelines would be told "you hold pipelines
   * in these divisions" while the resolver had narrowed them to none.
   */
  partnerDivisionOptions?: readonly string[] | null,
): ReferralScopeKind {
  if (isAdmin) return "all";
  const entry = userId ? referralAccessStore.getStore()?.get(userId) : undefined;
  if (!entry) {
    const raw = userDivisions(userId, pipelineNameById);
    if (narrowToOptions(raw, partnerDivisionOptions).length) return "derived";
    // ═══ ROUND 168 — THE FOURTH STATE, FOUND BY A PROOF FROM ROUND 143 ═══════
    //
    // 🔴 "HOLDS PIPELINES, NONE OF WHICH IS A REFERRAL DIVISION." A recruiter
    // granted only "OLTL Caregiver Applicants" used to derive "OLTL Caregiver"
    // — a phantom division that matched no partner but WAS non-empty, so
    // `viewerDivisions` read 1 and the empty-state sentence correctly said
    // "they belong to divisions you do not hold".
    //
    // ⚠️ ITEM 1'S NARROWING MAKES THAT LIST EMPTY, AND EMPTY USED TO MEAN
    // "holds no pipeline at all" — so the sentence would have told a recruiter
    // who holds a pipeline that they hold none, and sent them to check grants
    // they already have. task2-partners-proof caught it: its assertion is
    // annotated "they HOLD a division, it just matches nothing", which is the
    // distinction this state exists to keep.
    //
    // 🔴 FOUR CAUSES, FOUR SENTENCES. This is the third time one number has
    // gained a cause in this file — round 162 added the override, round 167
    // split the sentence, and this is the narrowing's turn.
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

/** The whole map, for the Access tab's own rendering. */
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
