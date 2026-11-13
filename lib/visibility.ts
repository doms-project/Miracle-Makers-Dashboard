import type { OpportunityRecord } from "./types";
import type { GhlSession } from "./sso";
import { getUserHomePipelines, staffingLevel, canUsePeerTransfer } from "./pipelineAccess";
import { canTakeUnowned, type Viewer } from "./sorting";
import { isAdminRole } from "./adminRole";

// Phase 3 permission model — ASSIGNMENT ONLY (shared by the list + save routes).
// Admins see & edit all; everyone else is limited to records they own or follow.
// Office is NOT a permission gate.
//
// ROUND 180 — "owner" is an admin too: GoHighLevel sends the Agency Owner as
// role "owner", and they were being treated as a rep. The rule lives in
// lib/adminRole.ts so the browser uses the same one.
//
// Admin is decided by ROLE ONLY (`isAdminRole`). We deliberately do NOT use
// `type === "agency"`: GHL's SSO `type` reflects the account *context*
// (agency vs location), not permission — an agency-context user with
// `role: "user"` is still a restricted rep. Using `|| type === "agency"` wrongly
// let those reps bypass the filter and see every record. GHL admins carry
// `role: "admin"` (or "owner"), so they keep full access.
export function isAdminSession(role?: string, type?: string): boolean {
  void type; // intentionally unused — see note above
  return isAdminRole(role);
}

/**
 * Can this user SEE/EDIT this record?
 *   admin                              -> true
 *   owner OR follower (any pipeline)   -> true  (the shared path)
 *   home pipeline AND unassigned       -> true  (rep can claim it)
 *   otherwise                          -> false
 * Matches the list-scoping rule in pipelineAccess.applyAccess, minus the
 * `shared` tagging (which only the list needs). The home+unassigned branch is
 * why a rep can open and claim an unowned lead in their own division.
 */
export function canSeeRecord(
  rec: Pick<OpportunityRecord, "ownerId" | "followerIds" | "pipelineId">,
  session: Pick<GhlSession, "userId" | "role" | "type">,
): boolean {
  if (isAdminSession(session.role, session.type)) return true;
  if (rec.ownerId === session.userId || rec.followerIds.includes(session.userId))
    return true;
  // Division predicate: an unassigned record in a HOME pipeline is claimable.
  const home = getUserHomePipelines(session.userId);
  const unassigned = !rec.ownerId;
  return unassigned && home.has(rec.pipelineId);
}

// Edit permission == visibility (same rule). Kept as a named alias so intent is
// explicit at the call site.
//
// ⚠️ FIELDS ONLY. This does NOT cover changing the OWNER — see canChangeOwner.
export const canEditRecord = canSeeRecord;

/**
 * ITEM 14 — who may change the OWNER: the owner or an admin, never a follower.
 *
 * canEditRecord is a literal alias of canSeeRecord, so a FOLLOWER could edit
 * every field including this one. That let someone who transferred a case away
 * and kept visibility hand it on to a third person, in a division they don't
 * work in — and it contradicted canManageFollowers, which is already
 * owner-or-admin on the reasoning that "a follower cannot re-share a record
 * onward". Changing the owner is the larger version of that same action, so it
 * gets the same rule.
 *
 * Deliberately identical to canManageFollowers rather than calling it: they
 * answer different questions and should be free to diverge later.
 */
export function canChangeOwner(
  rec: Pick<OpportunityRecord, "ownerId"> & Partial<Pick<OpportunityRecord, "pipelineId" | "stage">>,
  session: Pick<GhlSession, "userId" | "role" | "type">,
  newOwnerId?: string,
): boolean {
  if (isAdminSession(session.role, session.type)) return true;
  if (rec.ownerId) return rec.ownerId === session.userId;
  // 🔴 ROUND 197 — AN UNOWNED CASE COULD NOT BE PICKED UP BY ANYONE BUT AN
  // ADMIN. `rec.ownerId === session.userId` is unsatisfiable when ownerId is
  // empty, so a rep saw "Unassigned — you can pick it up" and was refused when
  // they tried. Now: an unowned case in a pipeline they hold may be given an
  // owner; one waiting in Staffing needed follows their Staffing setting.
  // Callers that do not pass the pipeline keep the old (stricter) answer.
  if (!rec.pipelineId || newOwnerId === undefined) return false;
  return canTakeUnowned(
    { ownerId: "", pipelineId: rec.pipelineId, stage: rec.stage || "" },
    viewerFor(session),
    newOwnerId,
  ).ok;
}

/**
 * ROUND 197 — the request's viewer as the pure rules in lib/sorting.ts want
 * it. Read from the grants installed by withGrants for THIS request.
 */
export function viewerFor(session: Pick<GhlSession, "userId" | "role" | "type">): Viewer {
  const isAdmin = isAdminSession(session.role, session.type);
  return {
    userId: session.userId,
    isAdmin,
    home: getUserHomePipelines(session.userId),
    staffing: staffingLevel(session.userId, isAdmin),
    peerTransfer: canUsePeerTransfer(session.userId, isAdmin),
  };
}

/**
 * Who may add/remove FOLLOWERS on a record: the OWNER or an admin only.
 * A follower cannot re-share a record onward — this keeps the originating
 * division in control of who its cases are shared with (Task 5).
 */
export function canManageFollowers(
  rec: Pick<OpportunityRecord, "ownerId">,
  session: Pick<GhlSession, "userId" | "role" | "type">,
): boolean {
  if (isAdminSession(session.role, session.type)) return true;
  return rec.ownerId === session.userId;
}
