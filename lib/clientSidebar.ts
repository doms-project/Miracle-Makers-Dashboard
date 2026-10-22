// ---------------------------------------------------------------------------
// ROUND 176 — THE CLIENTS SIDEBAR: a heading, "All clients", and one entry per
// client pipeline.
//
// Pure and env-free, so the client bundle and a proof can both drive it (the
// round-167 rule). Nothing here decides what anybody may SEE: the server has
// already sent the records and the pipelines. This only decides which of those
// pipelines get a shortcut in the sidebar, and what clicking one resets.
//
// 🔴 HIDDEN MEANS "NO SIDEBAR ENTRY", AND NOTHING ELSE. A pipeline hidden by
// the Pipelines-screen setting keeps its records in "All clients", Master and
// Moves, and stays in the toolbar Pipeline dropdown. That is the owner's
// decision for round 176, and it is why no function below filters records.
// ---------------------------------------------------------------------------

export interface SidebarPipeline {
  id: string;
  name: string;
}

/**
 * The pipelines this viewer can pick on the client board — the sidebar's
 * entries and the toolbar dropdown's options are BOTH this list, so the two
 * can only differ by the sidebar setting. Admins: every client pipeline in the
 * payload. Reps: their home pipelines. (Moved here from app/page.tsx in round
 * 176 so the proof drives the real rule rather than a copy of it.)
 */
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
  /** Records as the client board shows them with no filters; null when the pipeline failed to load. */
  count: number | null;
  failed: boolean;
  /** What a collapsed sidebar shows in place of the name. Display only. */
  initials: string;
}

export interface SidebarModel {
  /**
   * "All clients" — every record the board would show with no filters.
   * `inHidden` is how many of them sit in pipelines hidden from the sidebar
   * (round 177 · R2): the gap between All and the sum of the entries.
   */
  all: { count: number; shared: number; inHidden: number };
  /**
   * 🔴 ROUND 177 · ADDITION 2 — A COUNT FOR EVERY SELECTABLE PIPELINE, hidden
   * ones included. The toolbar dropdown lists hidden pipelines too, so its
   * numbers must come from here and not from `entries`, or a hidden pipeline
   * would read 0. Same rule as the entries: no REASSIGN, failed → null.
   */
  counts: Record<string, number | null>;
  entries: SidebarEntry[];
  /** True when there are client pipelines to list and every one is hidden. */
  allHidden: boolean;
}

/**
 * The sidebar, from what the account actually returned.
 *
 * @param selectable  the pipelines this viewer can pick on the board — the same
 *                    list the toolbar dropdown offers (admins: every client
 *                    pipeline in the payload; reps: their home pipelines).
 * @param hidden      the `pipelineSidebarHidden` map from the payload, or
 *                    undefined when the config could not be read — in which
 *                    case every pipeline is shown, never none.
 * @param isExcluded  records the board never counts (the REASSIGN queue).
 *
 * 🔴 ENTRIES COME FROM `selectable`, NEVER FROM CONFIG KEYS. A config can hold
 * ids that do not exist on this account (a seed taken from another account's
 * defaults); those must never become a tab that opens an empty board.
 */
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
      // ⚠️ A FAILED PIPELINE IS NOT AN EMPTY ONE. Its records are missing
      // because the read failed, so a count would be a claim we cannot make.
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

/** Whether one pipeline is hidden from the sidebar. Unknown config → shown. */
export function isHiddenFromSidebar(
  hidden: Record<string, true> | undefined,
  pipelineId: string,
): boolean {
  return hidden?.[pipelineId] === true;
}

/** The board's filter state that an entry click touches. */
export interface ClientFilterState {
  view: string;
  adminPipeline: string;
  scope: string;
  stage: string;
  srcF: string;
  office: string;
  clientFocus: unknown;
  q: string;
  /** The open record's pipeline, or null when nothing is open. */
  selPipelineId: string | null;
  /** Whether the open record is a CLIENT record (an applicant is not). */
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
  /** True when the open record must be closed. */
  closeRecord: boolean;
}

/**
 * What one sidebar click does, decided in ONE place and applied in one batch.
 *
 * 🔴 IN THE CLICK, NOT IN AN EFFECT. The stage and source resets in page.tsx
 * are effects, which run after a render — so a pipeline switch left to them
 * paints one frame of an empty list with the old stage still applied. Doing it
 * here means the first render after the click is already the right one. The
 * effects stay as a safety net for every other path that changes the set.
 *
 * ⚠️ THE SEARCH TEXT IS KEPT. It is something the user typed; a filter they
 * picked from a tile is not.
 *
 * ⚠️ THE REP'S DIVISION SCOPE GOES BACK TO "all". "Show: ODP" with an OLTL
 * entry selected can satisfy nothing; the entry is the narrower choice.
 */
export function pickClientPipeline(s: ClientFilterState, id: string): ClientFilterNext {
  const view = s.view === "list" || s.view === "board" ? s.view : "board";
  // ⚠️ "All clients" keeps any open CLIENT record — every one is in it — and
  // closes an applicant's, which is not on this board at all.
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

/**
 * The selection after the hidden map changes.
 *
 * 🔴 ONLY A PIPELINE THAT WAS JUST HIDDEN resets. A hidden pipeline is still
 * in the toolbar dropdown on purpose, so picking one there must stick — the
 * reset is for the admin hiding the pipeline you are standing on, which would
 * otherwise leave a highlight on an entry that no longer exists.
 */
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

/**
 * ROUND 177 · D10 — the sidebar's collapse choice: "expanded" | "collapsed",
 * ABSENT = collapsed. A NEW key on purpose: v176's `mm.railCollapsed` was only
 * written by people who toggled, so reusing it would have kept everyone who
 * tried » expanded and never shown them the new default. app/layout.tsx's
 * inline script reads this same string — keep the two in step.
 */
export const RAIL_KEY = "mm.rail";

/**
 * The remembered entry, validated. Anything no longer selectable, or since
 * hidden, falls back to "all" — a stored id must never become an invisible
 * filter.
 */
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

/**
 * Short labels for a collapsed sidebar.
 *
 * ⚠️ WORDING ONLY. Nothing reads these to decide anything — the entry's id
 * does that — so a rename changes a label and nothing else.
 *
 * An all-capitals word is an acronym and is kept whole ("OLTL Enrollment" →
 * "OLTL·E"); otherwise it is first letters ("Private Pay" → "PP"). Plain first
 * letters would turn this account's "OLTL Enrollment" and "ODP Enrollment" into
 * the same "OE", so any label that still collides gets a number.
 */
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
