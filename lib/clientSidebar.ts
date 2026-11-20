export interface SidebarPipeline {
  id: string;
  name: string;
}

export function selectableFor<P extends SidebarPipeline>(
  isAdmin: boolean,
  pipelines: P[],
  homePipelineIds: string[],
): P[] {
  if (isAdmin) return pipelines;
  const home = new Set(homePipelineIds);
  return pipelines.filter((p) => home.has(p.id));
}

export interface SidebarRecord {
  pipelineId: string;
  shared?: boolean;
}

export interface SidebarEntry {
  id: string;
  name: string;

  count: number | null;
  failed: boolean;

  initials: string;
}

export interface SidebarModel {

  all: { count: number; shared: number; inHidden: number };

  counts: Record<string, number | null>;
  entries: SidebarEntry[];

  allHidden: boolean;
}

export function sidebarModel<R extends SidebarRecord>(args: {
  selectable: SidebarPipeline[];
  records: R[];
  hidden: Record<string, true> | undefined;
  failed: { id: string }[];
  isExcluded: (r: R) => boolean;
}): SidebarModel {
  const { selectable, records, hidden, failed, isExcluded } = args;
  const failedIds = new Set(failed.map((f) => f.id));
  const perPipeline = new Map<string, number>();
  let all = 0;
  let shared = 0;
  let inHidden = 0;
  for (const r of records) {
    if (isExcluded(r)) continue;
    all += 1;
    if (r.shared) shared += 1;
    if (isHiddenFromSidebar(hidden, r.pipelineId)) inHidden += 1;
    perPipeline.set(r.pipelineId, (perPipeline.get(r.pipelineId) || 0) + 1);
  }
  const shown = selectable.filter((p) => !isHiddenFromSidebar(hidden, p.id));
  const initials = entryInitials(shown.map((p) => p.name));
  const entries: SidebarEntry[] = shown.map((p, i) => {
    const isFailed = failedIds.has(p.id);
    return {
      id: p.id,
      name: p.name,

      count: isFailed ? null : perPipeline.get(p.id) || 0,
      failed: isFailed,
      initials: initials[i],
    };
  });
  const counts: Record<string, number | null> = {};
  for (const p of selectable)
    counts[p.id] = failedIds.has(p.id) ? null : perPipeline.get(p.id) || 0;
  return {
    all: { count: all, shared, inHidden },
    counts,
    entries,
    allHidden: selectable.length > 0 && shown.length === 0,
  };
}

export function isHiddenFromSidebar(
  hidden: Record<string, true> | undefined,
  pipelineId: string,
): boolean {
  return hidden?.[pipelineId] === true;
}

export interface ClientFilterState {
  view: string;
  adminPipeline: string;
  scope: string;
  stage: string;
  srcF: string;
  office: string;
  clientFocus: unknown;
  q: string;

  selPipelineId: string | null;

  selIsClient: boolean;
}

export interface ClientFilterNext {
  view: string;
  adminPipeline: string;
  scope: string;
  stage: string;
  srcF: string;
  office: string;
  clientFocus: null;
  q: string;

  closeRecord: boolean;
}

export function pickClientPipeline(s: ClientFilterState, id: string): ClientFilterNext {
  const view = s.view === "list" || s.view === "board" ? s.view : "board";

  const closeRecord =
    s.selPipelineId != null &&
    (id === "all" ? !s.selIsClient : s.selPipelineId !== id);
  return {
    view,
    adminPipeline: id,
    scope: "all",
    stage: "all",
    srcF: "all",
    office: "all",
    clientFocus: null,
    q: s.q,
    closeRecord,
  };
}

export function selectionAfterHide(
  selected: string,
  before: Record<string, true> | undefined,
  after: Record<string, true> | undefined,
): string {
  if (selected === "all") return selected;
  return isHiddenFromSidebar(after, selected) && !isHiddenFromSidebar(before, selected)
    ? "all"
    : selected;
}

export const REMEMBERED_ENTRY_KEY = "mm.clientPipeline";

export const RAIL_KEY = "mm.rail";

export function restoreRemembered(
  stored: string | null | undefined,
  selectable: SidebarPipeline[],
  hidden: Record<string, true> | undefined,
): string {
  const id = String(stored ?? "").trim();
  if (!id || id === "all") return "all";
  if (!selectable.some((p) => p.id === id)) return "all";
  if (isHiddenFromSidebar(hidden, id)) return "all";
  return id;
}

export function entryInitials(names: string[]): string[] {
  const base = names.map((n) => {
    const words = n.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "?";
    const head = words[0];
    const acronym = /^[A-Z0-9]{2,5}$/.test(head);
    if (acronym)
      return words.length > 1 ? `${head}·${words[1][0].toUpperCase()}` : head;
    return words
      .slice(0, 3)
      .map((w) => w[0].toUpperCase())
      .join("");
  });
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const b of base) total.set(b, (total.get(b) || 0) + 1);
  return base.map((b) => {
    if ((total.get(b) || 0) < 2) return b;
    const n = (seen.get(b) || 0) + 1;
    seen.set(b, n);
    return `${b}${n}`;
  });
}
