// ---------------------------------------------------------------------------
// ROUND 177 — THE RECRUITING SIDEBAR: a heading, two sub-labels (Caregivers /
// Office staff), and one entry per recruiting pipeline under the right one.
//
// Pure and env-free, so the client bundle and round177-proof drive the same
// rules (the round-167 rule). Nothing here decides what anybody may see: the
// server already scoped the caregiver payload. This only decides which of
// those pipelines get a shortcut, under which sub-label, and what a click does.
//
// ⚠️ A SEPARATE FILE FROM clientSidebar.ts ON PURPOSE. The rules differ in
// three places that matter: the list is the B5 rule (home ∪ pipelines you
// already hold records in) rather than home only, there are two groups, and
// there is no "All" entry. What IS shared — the hidden test, the initials and
// the reset-on-hide — is imported, not copied.
// ---------------------------------------------------------------------------
import {
  entryInitials,
  isHiddenFromSidebar,
  type SidebarPipeline,
} from "./clientSidebar";

export type RecruitingGroup = "caregiver" | "staff";

/** A pipeline's group. Unset reads as caregiver — the one default, in one place. */
export function groupOf(
  groups: Record<string, RecruitingGroup | undefined>,
  pipelineId: string,
): RecruitingGroup {
  return groups[pipelineId] === "staff" ? "staff" : "caregiver";
}

/**
 * The recruiting pipelines this viewer can open — page.tsx's B5 rule, moved
 * here so the proof drives the real one.
 *
 * Admins: every caregiver pipeline in the payload. Everyone else: their home
 * pipelines PLUS any pipeline they already hold records in.
 *
 * 🔴 THE UNION IS NOT OPTIONAL (round 155). applyAccess admits a record you
 * own or follow without consulting a grant, so a recruiter with no grant can
 * have applicants on screen; home-only — the client rule — would give them no
 * entry and no way in. It cannot widen anything: every id it adds is already
 * on a record the server sent this viewer.
 */
export function recruitingVisible<P extends SidebarPipeline>(
  isAdmin: boolean,
  cgPipelines: P[],
  homeIds: string[],
  records: { pipelineId: string }[],
): P[] {
  if (isAdmin) return cgPipelines;
  const home = new Set(homeIds);
  const inData = new Set(records.map((r) => r.pipelineId));
  return cgPipelines.filter((p) => home.has(p.id) || inData.has(p.id));
}

/** The visible list narrowed to the heading switcher's group. */
export function inGroup<P extends SidebarPipeline>(
  visible: P[],
  cgGroup: RecruitingGroup | "all",
  groups: Record<string, RecruitingGroup | undefined>,
): P[] {
  return cgGroup === "all" ? visible : visible.filter((p) => groupOf(groups, p.id) === cgGroup);
}

export interface RecruitingEntry {
  id: string;
  name: string;
  /** Applicants as the board shows them with no filters; null when it failed to load. */
  count: number | null;
  failed: boolean;
  initials: string;
}

export interface RecruitingModel {
  caregiver: RecruitingEntry[];
  staff: RecruitingEntry[];
  /** A count for EVERY visible pipeline, hidden ones included (the dropdown's numbers). */
  counts: Record<string, number | null>;
  /** True when there are pipelines to list and every one is hidden. */
  allHidden: boolean;
}

/**
 * The two lists. Payload order within each group — the order #cgPipeSel uses.
 *
 * ⚠️ NO "All" ENTRY, AND THE GROUPS NEVER MIX: a staff pipeline is only ever
 * under Office staff and a caregiver pipeline only under Caregivers, decided by
 * `groupOf` and nothing else.
 *
 * ⚠️ COUNTS: caregiver pipelines have no REASSIGN stage (ghl.ts — the reassign
 * flow refuses a pipeline without one), and the board filters by pipeline and
 * search only, so a count is simply that pipeline's records.
 */
export function recruitingModel(args: {
  visible: SidebarPipeline[];
  records: { pipelineId: string }[];
  hidden: Record<string, true> | undefined;
  failed: { id: string }[];
  groups: Record<string, RecruitingGroup | undefined>;
}): RecruitingModel {
  const { visible, records, hidden, failed, groups } = args;
  const failedIds = new Set(failed.map((f) => f.id));
  const per = new Map<string, number>();
  for (const r of records) per.set(r.pipelineId, (per.get(r.pipelineId) || 0) + 1);
  const counts: Record<string, number | null> = {};
  for (const p of visible) counts[p.id] = failedIds.has(p.id) ? null : per.get(p.id) || 0;
  const shown = visible.filter((p) => !isHiddenFromSidebar(hidden, p.id));
  const initials = entryInitials(shown.map((p) => p.name));
  const out: RecruitingModel = { caregiver: [], staff: [], counts, allHidden: false };
  shown.forEach((p, i) => {
    out[groupOf(groups, p.id)].push({
      id: p.id,
      name: p.name,
      count: counts[p.id],
      failed: failedIds.has(p.id),
      initials: initials[i],
    });
  });
  out.allHidden = visible.length > 0 && shown.length === 0;
  return out;
}

/**
 * Which pipeline the board shows, given what was picked.
 *
 * 🔴 ROUND 177 · B7 — THE PICK MUST BE IN THE LIST. page.tsx returned
 * `cgPipeline` whatever it was, so a staff pipeline picked under "All
 * applicants" stayed on the board after switching to Caregivers, and #cgPipeSel
 * showed a value that was not among its options. A pick outside the group's
 * list now falls through to the default, so that state cannot be drawn.
 *
 * Default (nothing picked): the first SHOWN pipeline; if every one in the group
 * is hidden, the first hidden one — data on the board, the dropdown still
 * offers them, and no entry lights (the owner's Q3 answer).
 */
export function activeRecruitingPipeline(
  cgPipeline: string,
  groupList: SidebarPipeline[],
  hidden: Record<string, true> | undefined,
): string {
  if (cgPipeline !== "all" && groupList.some((p) => p.id === cgPipeline)) return cgPipeline;
  return (
    groupList.find((p) => !isHiddenFromSidebar(hidden, p.id))?.id ||
    groupList[0]?.id ||
    ""
  );
}

export interface RecruitingFilterState {
  cgGroup: RecruitingGroup | "all";
  cgView: "list" | "board" | "resources";
  cgQuery: string;
  /** The open record's pipeline, or null when nothing is open (client records too). */
  selPipelineId: string | null;
}

export interface RecruitingFilterNext {
  view: "caregivers";
  cgPipeline: string;
  cgGroup: RecruitingGroup | "all";
  cgView: "list" | "board";
  cgStage: null;
  cgFocus: null;
  cgQuery: string;
  closeRecord: boolean;
}

/**
 * One Recruiting sidebar click — every reset in one batch.
 *
 * ⚠️ THE GROUP RULE IS AddCaregiverDialog's onAdded rule: "all" stays "all"
 * (the pipeline is already in that list); otherwise the group becomes the
 * pipeline's own, so the board never shows a pipeline under the wrong half.
 *
 * Stage and tile focus reset (both are values of ONE pipeline). Sort and
 * group-by are kept (they are field-based preferences, not pipeline values).
 * Search text is kept (the user typed it). An open record outside the picked
 * pipeline — including a CLIENT record — is closed.
 */
export function pickRecruitingPipeline(
  s: RecruitingFilterState,
  id: string,
  groups: Record<string, RecruitingGroup | undefined>,
): RecruitingFilterNext {
  return {
    view: "caregivers",
    cgPipeline: id,
    cgGroup: s.cgGroup === "all" ? "all" : groupOf(groups, id),
    cgView: s.cgView === "list" ? "list" : "board",
    cgStage: null,
    cgFocus: null,
    cgQuery: s.cgQuery,
    closeRecord: s.selPipelineId != null && s.selPipelineId !== id,
  };
}

export const REMEMBERED_CG_KEY = "mm.cgPipeline";

/** The remembered Recruiting pipeline, validated: unopenable or hidden → "all". */
export function restoreRememberedCg(
  stored: string | null | undefined,
  visible: SidebarPipeline[],
  hidden: Record<string, true> | undefined,
): string {
  const id = String(stored ?? "").trim();
  if (!id || id === "all") return "all";
  if (!visible.some((p) => p.id === id)) return "all";
  if (isHiddenFromSidebar(hidden, id)) return "all";
  return id;
}

export type RecruitingEmptyCause =
  | "loadFailed"
  | "noAccess"
  | "noneSetUp"
  | "withheld"
  | "allHidden"
  | null;

/**
 * Why there is nothing under the Recruiting heading — the sidebar's short
 * form of the board's `recruitingEmpty`, in the same order of precedence.
 *
 * 🔴 A FAILED LOAD COMES FIRST (round 177 · M3). An outage that read "no
 * pipelines assigned" would send a recruiter to an admin about access they
 * already have.
 */
export function recruitingEmptyCause(args: {
  loadFailed: boolean;
  noRecruitingAccess: boolean;
  visibleCount: number;
  withheld: number;
  allHidden: boolean;
}): RecruitingEmptyCause {
  if (args.loadFailed) return "loadFailed";
  if (args.visibleCount === 0) {
    if (args.noRecruitingAccess) return "noAccess";
    if (args.withheld > 0) return "withheld";
    return "noneSetUp";
  }
  if (args.allHidden) return "allHidden";
  return null;
}

export const RECRUITING_EMPTY_LINE: Record<Exclude<RecruitingEmptyCause, null>, string> = {
  loadFailed: "Recruiting didn't load.",
  noAccess: "No recruiting pipelines assigned yet.",
  withheld: "None of the recruiting pipelines on this account are yours yet.",
  noneSetUp: "No recruiting pipelines are set up yet.",
  allHidden: "No recruiting pipelines are shown in the sidebar. An admin can change this on Pipelines.",
};
