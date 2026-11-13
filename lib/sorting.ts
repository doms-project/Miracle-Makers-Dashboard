// ---------------------------------------------------------------------------
// ROUND 197 — NEW LEADS (TO SORT) AND STAFFING NEEDED.
//
// 🔴 PURE AND ENV-FREE, so the server routes, the browser and round197-proof
// all read ONE copy of every rule. Nothing here fetches, and nothing here may
// import pipelineAccess (it pulls in node:async_hooks, which the browser
// bundle cannot load). Callers pass the viewer's facts in.
//
// THE MODEL, IN FOUR LINES
//   NEW LEAD   the sorting stage. Every case at it shows in "New Leads (to
//              sort)" and nowhere else on the Clients side.
//   REASSIGN   shown everywhere as "Staffing needed". Unowned cases at it show
//              in "Staffing needed lead", for people allowed to work it.
//   labels     tab and stage NAMES are display only. Every rule below matches
//              the REAL GoHighLevel stage name, never a label, so renaming a
//              tab cannot change which cases it holds or who may touch them.
//   rules      a viewer acts only on cases the server already sends them.
// ---------------------------------------------------------------------------

/** The GHL stage leads arrive in. Matched BY NAME, exactly as REASSIGN is. */
export const NEW_LEAD_STAGE = "NEW LEAD";
/** The GHL stage the dashboard calls "Staffing needed". Never renamed in GHL. */
export const STAFFING_STAGE = "REASSIGN";

const up = (s: string | null | undefined) => (s || "").trim().toUpperCase();
export const isNewLeadStage = (name: string | null | undefined) =>
  up(name) === NEW_LEAD_STAGE;
export const isStaffingStage = (name: string | null | undefined) =>
  up(name) === STAFFING_STAGE;
/** Stages a person may PICK. Arrival and the queue are reached other ways. */
export const isPickableStage = (name: string | null | undefined) =>
  !isNewLeadStage(name) && !isStaffingStage(name);

// ═══ LABELS ═════════════════════════════════════════════════════════════
export interface TabLabels {
  /** Sidebar tab 1 — every case at NEW LEAD. */
  newLeads: string;
  /** Sidebar tab 2 — unowned cases at REASSIGN. */
  staffingTab: string;
  /** What the REASSIGN stage is called everywhere on the dashboard. */
  staffingStage: string;
  /** Optional per-pipeline display names: pipelineId → label. */
  pipelines: Record<string, string>;
}

export const DEFAULT_LABELS: Readonly<Omit<TabLabels, "pipelines">> = {
  newLeads: "New Leads (to sort)",
  staffingTab: "Staffing needed lead",
  staffingStage: "Staffing needed",
};

export const LABEL_MAX = 40;
/** Keys an admin may rename. A pipeline key is `pipeline:<id>`. */
export type LabelKey = "newLeads" | "staffingTab" | "staffingStage" | `pipeline:${string}`;

const clean = (v: unknown) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";

/**
 * The stored map → the labels to SHOW. Anything missing, empty, too long or
 * not a string falls back to the default, so a damaged value can never put a
 * blank tab on screen.
 */
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

/**
 * Validate one rename. `taken` are the OTHER tab names currently on screen,
 * so two tabs can never read the same. Returns null when the name is fine.
 * An empty name is NOT an error here: the caller treats it as "reset".
 */
export function labelProblem(name: string, taken: string[]): string | null {
  const n = clean(name);
  if (!n) return null;
  if (n.length > LABEL_MAX) return `Keep it to ${LABEL_MAX} characters.`;
  if (taken.some((t) => clean(t).toLowerCase() === n.toLowerCase()))
    return "Another tab already has that name.";
  return null;
}

/**
 * Apply one rename to the stored map. An empty name REMOVES the key, which
 * is what "Reset to default" means. Returns a new object.
 */
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

/** A stage name as the dashboard SHOWS it. Only REASSIGN is relabelled. */
export function stageDisplay(name: string, labels: Pick<TabLabels, "staffingStage">): string {
  return isStaffingStage(name) ? labels.staffingStage : name;
}

// ═══ PERMISSIONS ══════════════════════════════════════════════════════════
export interface SortRec {
  ownerId: string;
  pipelineId: string;
  stage: string;
  followerIds?: string[];
}
export interface Viewer {
  userId: string;
  isAdmin: boolean;
  /** Pipeline ids the user holds in the Access tab. */
  home: Set<string> | string[];
  /** Staffing needed setting. Admins are "admin". */
  staffing?: "admin" | "any" | "self" | "off";
  /** The cross-account transfer tick. */
  peerTransfer?: boolean;
}
export type Verdict = { ok: true } | { ok: false; why: string };
const yes: Verdict = { ok: true };
const no = (why: string): Verdict => ({ ok: false, why });
const holds = (v: Viewer, pipelineId: string) =>
  v.home instanceof Set ? v.home.has(pipelineId) : v.home.includes(pipelineId);

/**
 * The server's list rule, narrowed: a NON-admin with Staffing needed OFF is
 * not sent unowned REASSIGN client cases (the home+unassigned path would
 * otherwise deliver them). Owned or followed records are untouched.
 */
export function staffingGateHides(rec: SortRec, v: Pick<Viewer, "isAdmin" | "staffing">): boolean {
  if (v.isAdmin) return false;
  if (rec.ownerId) return false;
  if (!isStaffingStage(rec.stage)) return false;
  return (v.staffing ?? "off") === "off";
}

/**
 * SORT — a NEW LEAD case, from the New Leads (to sort) tab.
 *   newOwnerId  undefined = keep the current owner; "" = no owner.
 */
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

/** ASSIGN — an unowned case waiting at REASSIGN ("Staffing needed"). */
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

/**
 * SEND TO STAFFING NEEDED — mirrors the existing move-route gate exactly
 * (owner or admin; or an unowned case in a pipeline you hold), so the new
 * buttons cannot be wider than Master's drag already is.
 */
export function canSendToStaffing(rec: SortRec, v: Viewer): Verdict {
  if (isStaffingStage(rec.stage)) return no("It's already in Staffing needed.");
  if (v.isAdmin) return yes;
  if (rec.ownerId) return rec.ownerId === v.userId ? yes : no("Only its owner or an admin can send this case.");
  return holds(v, rec.pipelineId) ? yes : no("This case is in a pipeline you don't have access to.");
}

/**
 * TAKE AN UNOWNED CASE from the record panel's owner field. Until round 197
 * only an admin could give an unowned case an owner, so a rep could see an
 * unassigned case in their pipeline and never pick it up.
 */
export function canTakeUnowned(rec: SortRec, v: Viewer, newOwnerId: string): Verdict {
  if (rec.ownerId) return no("This case already has an owner.");
  if (v.isAdmin) return yes;
  if (!holds(v, rec.pipelineId)) return no("This case is in a pipeline you don't have access to.");
  if (isStaffingStage(rec.stage)) return canAssignStaffing(rec, v, newOwnerId);
  return yes;
}

/** TRANSFER TO THE OTHER COMPANY — the tick, plus a case you own or may sort. */
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

/**
 * The stage a SORT lands on. A sort with no owner that only re-routes keeps
 * the case at NEW LEAD of the destination (it stays in the sorting tab, in
 * its new pipeline). Every other sort must name a real, pickable stage.
 */
export function sortStageProblem(args: {
  toStageName: string | null;
  finalOwner: string;
  pipelineChanged: boolean;
}): string | null {
  const { toStageName, finalOwner, pipelineChanged } = args;
  if (!toStageName) {
    if (!finalOwner && pipelineChanged) return null; // stays at New lead
    return "Choose a stage.";
  }
  if (isNewLeadStage(toStageName))
    return finalOwner || !pipelineChanged ? "Choose a stage other than New lead." : null;
  if (isStaffingStage(toStageName)) return "Use Staffing needed for that.";
  return null;
}
