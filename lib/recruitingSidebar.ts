import {
  entryInitials,
  isHiddenFromSidebar,
  type SidebarPipeline,
} from "./clientSidebar";

export type RecruitingGroup = "caregiver" | "staff";

export function groupOf(
  groups: Record<string, RecruitingGroup | undefined>,
  pipelineId: string,
): RecruitingGroup {
  return groups[pipelineId] === "staff" ? "staff" : "caregiver";
}

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

  count: number | null;
  failed: boolean;
  initials: string;
}

export interface RecruitingModel {
  caregiver: RecruitingEntry[];
  staff: RecruitingEntry[];

  counts: Record<string, number | null>;

  allHidden: boolean;
}

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
