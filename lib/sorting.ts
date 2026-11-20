export const NEW_LEAD_STAGE = "NEW LEAD";

export const STAFFING_STAGE = "REASSIGN";

const up = (s: string | null | undefined) => (s || "").trim().toUpperCase();
export const isNewLeadStage = (name: string | null | undefined) =>
  up(name) === NEW_LEAD_STAGE;
export const isStaffingStage = (name: string | null | undefined) =>
  up(name) === STAFFING_STAGE;

export const isPickableStage = (name: string | null | undefined) =>
  !isNewLeadStage(name) && !isStaffingStage(name);

export interface TabLabels {

  newLeads: string;

  staffingTab: string;

  staffingStage: string;

  pipelines: Record<string, string>;
}

export const DEFAULT_LABELS: Readonly<Omit<TabLabels, "pipelines">> = {
  newLeads: "New Leads (to sort)",
  staffingTab: "Staffing needed lead",
  staffingStage: "Staffing needed",
};

export const LABEL_MAX = 40;

export type LabelKey = "newLeads" | "staffingTab" | "staffingStage" | `pipeline:${string}`;

const clean = (v: unknown) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";

export function resolveLabels(stored: Record<string, unknown> | null | undefined): TabLabels {
  const s = stored && typeof stored === "object" ? stored : {};
  const pick = (k: keyof typeof DEFAULT_LABELS) => {
    const v = clean((s as Record<string, unknown>)[k]);
    return v && v.length <= LABEL_MAX ? v : DEFAULT_LABELS[k];
  };
  const pipelines: Record<string, string> = {};
  for (const [k, v] of Object.entries(s)) {
    if (!k.startsWith("pipeline:")) continue;
    const id = k.slice("pipeline:".length);
    const n = clean(v);
    if (id && n && n.length <= LABEL_MAX) pipelines[id] = n;
  }
  return {
    newLeads: pick("newLeads"),
    staffingTab: pick("staffingTab"),
    staffingStage: pick("staffingStage"),
    pipelines,
  };
}

export function labelProblem(name: string, taken: string[]): string | null {
  const n = clean(name);
  if (!n) return null;
  if (n.length > LABEL_MAX) return `Keep it to ${LABEL_MAX} characters.`;
  if (taken.some((t) => clean(t).toLowerCase() === n.toLowerCase()))
    return "Another tab already has that name.";
  return null;
}

export function withLabel(
  stored: Record<string, string> | null | undefined,
  key: LabelKey,
  name: string,
): Record<string, string> {
  const next = { ...(stored || {}) };
  const n = clean(name);
  if (!n) delete next[key];
  else next[key] = n.slice(0, LABEL_MAX);
  return next;
}

export function stageDisplay(name: string, labels: Pick<TabLabels, "staffingStage">): string {
  return isStaffingStage(name) ? labels.staffingStage : name;
}

export interface SortRec {
  ownerId: string;
  pipelineId: string;
  stage: string;
  followerIds?: string[];
}
export interface Viewer {
  userId: string;
  isAdmin: boolean;

  home: Set<string> | string[];

  staffing?: "admin" | "any" | "self" | "off";

  peerTransfer?: boolean;
}
export type Verdict = { ok: true } | { ok: false; why: string };
const yes: Verdict = { ok: true };
const no = (why: string): Verdict => ({ ok: false, why });
const holds = (v: Viewer, pipelineId: string) =>
  v.home instanceof Set ? v.home.has(pipelineId) : v.home.includes(pipelineId);

export function staffingGateHides(rec: SortRec, v: Pick<Viewer, "isAdmin" | "staffing">): boolean {
  if (v.isAdmin) return false;
  if (rec.ownerId) return false;
  if (!isStaffingStage(rec.stage)) return false;
  return (v.staffing ?? "off") === "off";
}

export function canSort(
  rec: SortRec,
  v: Viewer,
  req: { toPipelineId: string; newOwnerId?: string },
): Verdict {
  if (!isNewLeadStage(rec.stage)) return no("Only a case at New lead can be sorted from this tab.");
  if (v.isAdmin) return yes;
  const mine = !!rec.ownerId && rec.ownerId === v.userId;
  const unownedHere = !rec.ownerId && holds(v, rec.pipelineId);
  if (!mine && !unownedHere)
    return no(
      rec.ownerId
        ? "Only its owner or an admin can sort a lead somebody already owns."
        : "This lead is in a pipeline you don't have access to.",
    );
  const finalOwner = req.newOwnerId === undefined ? rec.ownerId : req.newOwnerId;
  if (!holds(v, req.toPipelineId) && finalOwner)
    return no(
      "You don't have access to that pipeline, so you can only send it there with no owner — its team sorts it.",
    );
  return yes;
}

export function canAssignStaffing(rec: SortRec, v: Viewer, newOwnerId: string): Verdict {
  if (!isStaffingStage(rec.stage)) return no("This case isn't waiting in Staffing needed.");
  if (rec.ownerId) return no("This case already has an owner.");
  if (!newOwnerId) return no("Pick who will own it.");
  if (v.isAdmin) return yes;
  if (!holds(v, rec.pipelineId)) return no("This case is in a pipeline you don't have access to.");
  const level = v.staffing ?? "off";
  if (level === "any" || level === "admin") return yes;
  if (level === "self")
    return newOwnerId === v.userId ? yes : no("You can assign Staffing needed cases to yourself only.");
  return no("You don't have access to Staffing needed. Ask an admin.");
}

export function canSendToStaffing(rec: SortRec, v: Viewer): Verdict {
  if (isStaffingStage(rec.stage)) return no("It's already in Staffing needed.");
  if (v.isAdmin) return yes;
  if (rec.ownerId) return rec.ownerId === v.userId ? yes : no("Only its owner or an admin can send this case.");
  return holds(v, rec.pipelineId) ? yes : no("This case is in a pipeline you don't have access to.");
}

export function canTakeUnowned(rec: SortRec, v: Viewer, newOwnerId: string): Verdict {
  if (rec.ownerId) return no("This case already has an owner.");
  if (v.isAdmin) return yes;
  if (!holds(v, rec.pipelineId)) return no("This case is in a pipeline you don't have access to.");
  if (isStaffingStage(rec.stage)) return canAssignStaffing(rec, v, newOwnerId);
  return yes;
}

export function canPeerTransfer(rec: SortRec, v: Viewer): Verdict {
  if (v.isAdmin) return yes;
  if (!v.peerTransfer) return no("You don't have the transfer permission. Ask an admin to tick it in Access.");
  if (rec.ownerId === v.userId && rec.ownerId) return yes;
  if (!rec.ownerId && holds(v, rec.pipelineId)) return yes;
  return no(
    rec.ownerId
      ? "Only its owner or an admin can transfer a case somebody owns."
      : "This case is in a pipeline you don't have access to.",
  );
}

export function sortStageProblem(args: {
  toStageName: string | null;
  finalOwner: string;
  pipelineChanged: boolean;
}): string | null {
  const { toStageName, finalOwner, pipelineChanged } = args;
  if (!toStageName) {
    if (!finalOwner && pipelineChanged) return null;
    return "Choose a stage.";
  }
  if (isNewLeadStage(toStageName))
    return finalOwner || !pipelineChanged ? "Choose a stage other than New lead." : null;
  if (isStaffingStage(toStageName)) return "Use Staffing needed for that.";
  return null;
}

export const SORTED_FIELD = "Sorted From New Leads";

export type SortedKind = "pipeline" | "staffing";
export interface SortedStamp {
  at: string;
  kind: SortedKind;
  pipelineId: string;
  userId: string;
}

export function encodeSorted(s: SortedStamp): string {
  return [s.at, s.kind, s.pipelineId, s.userId].join("|");
}

export function parseSorted(raw: unknown): SortedStamp | null {
  const text = (Array.isArray(raw) ? raw.join("") : String(raw ?? "")).trim();
  if (!text) return null;
  const [at, kind, pipelineId, userId] = text.split("|");
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  if (kind !== "pipeline" && kind !== "staffing") return null;
  if (!pipelineId) return null;
  return { at, kind, pipelineId, userId: userId || "" };
}

export interface SortStats {

  total: number;

  byPipeline: Map<string, number>;

  staffing: number;

  ids: string[];
}

export function sortStats(
  records: { id: string; cf: Record<string, unknown> }[],
  fieldId: string | null,
  sinceMs: number,
): SortStats {
  const out: SortStats = { total: 0, byPipeline: new Map(), staffing: 0, ids: [] };
  if (!fieldId) return out;
  const hits: { id: string; t: number }[] = [];
  for (const r of records) {
    const s = parseSorted(r.cf?.[fieldId]);
    if (!s) continue;
    const t = Date.parse(s.at);
    if (sinceMs && t < sinceMs) continue;
    out.total++;
    if (s.kind === "staffing") out.staffing++;
    else out.byPipeline.set(s.pipelineId, (out.byPipeline.get(s.pipelineId) || 0) + 1);
    hits.push({ id: r.id, t });
  }
  out.ids = hits.sort((a, b) => b.t - a.t).map((h) => h.id);
  return out;
}

export type StatsWindow = "today" | "7d" | "30d" | "all";
export function windowStart(w: StatsWindow, now: number): number {
  if (w === "all") return 0;
  if (w === "7d") return now - 7 * 86_400_000;
  if (w === "30d") return now - 30 * 86_400_000;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  return now - ((g("hour") * 60 + g("minute")) * 60 + g("second")) * 1000 - (now % 1000);
}
