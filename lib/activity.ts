// ---------------------------------------------------------------------------
// ROUND 191 — THE NEWEST ACTIVITY GOES TO THE TOP.
//
// The owner's rule: a new lead, an edited case, and a case whose person comes
// back (fills in another form) all go to the top of the board and the list.
//
// "Latest activity" is the newest of the timestamps a record carries:
//   · createdAt        a new case
//   · updatedAt        any change GoHighLevel stores on the case — a field
//                      edit, a workflow's "Create/Update Opportunity" step run
//                      again when the same person sends in another form
//   · stageChangedAt   a stage move
//   · statusChangedAt  open / won / lost / abandoned
//
// ⚠️ updatedAt IS OPTIONAL HERE ON PURPOSE. Until the board payload carries it
// (a server change, see V2-REPORT-191), the order still follows created, stage
// and status changes, and nothing breaks.
//
// ⚠️ NOT EVERY "updatedAt" BUMP IS A PERSON'S EDIT. The dashboard's own writes
// (the "First Opened" stamp, the stage log, a backfill) also move it. That is
// accepted: the rule is "changed recently goes up", and those are changes.
//
// 🔴 ROUND 192 — UNOPENED NEW LEADS STAY ON TOP. A case still carrying the gold
// "New lead" label (round 181: nobody has opened it yet) sits above every other
// case, newest first among them, until someone opens it. Opening clears the
// label for everyone, and the case then takes its place by latest activity.
// So an older case whose stage changes today goes to the top of the REST —
// just below the unopened leads, never above them. Owner's request.
//
// The sort is STABLE: records with the same latest moment keep the server's
// order, and a record with no readable timestamp at all goes last rather than
// being treated as the newest or the oldest moment in time.
// ---------------------------------------------------------------------------

/** The timestamps the order can read. Any of them may be missing. */
export interface ActivityStamps {
  createdAt?: unknown;
  updatedAt?: unknown;
  stageChangedAt?: unknown;
  statusChangedAt?: unknown;
  /** True while the gold "New lead" label shows (nobody has opened it). */
  newLead?: unknown;
}

function ms(v: unknown): number {
  if (v == null || v === "") return 0;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) && t > 0 ? t : 0;
}

/** The newest readable timestamp on a record, in ms; 0 when it has none. */
export function latestActivity(r: ActivityStamps): number {
  return Math.max(ms(r.createdAt), ms(r.updatedAt), ms(r.stageChangedAt), ms(r.statusChangedAt));
}

/** Pinned above everything else: a lead nobody has opened yet. */
export const isUnopenedNewLead = (r: ActivityStamps): boolean => r.newLead === true;

/**
 * A new array: unopened new leads first, then everything else; newest
 * activity first within each group. The input is not changed.
 */
export function byLatestActivity<T extends ActivityStamps>(rows: readonly T[]): T[] {
  return rows
    .map((r, i) => ({ r, i, t: latestActivity(r), pin: isUnopenedNewLead(r) }))
    .sort((a, b) => {
      if (a.pin !== b.pin) return a.pin ? -1 : 1;
      if (a.t !== b.t) {
        if (!a.t) return 1;
        if (!b.t) return -1;
        return b.t - a.t;
      }
      return a.i - b.i;
    })
    .map((x) => x.r);
}
