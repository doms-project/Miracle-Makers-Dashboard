import type { OpportunityRecord } from "./types";
import type { GhlSession } from "./sso";
import { getUserHomePipelines } from "./pipelineAccess";

// Phase 3 permission model — ASSIGNMENT ONLY (shared by the list + save routes).
// Admins see & edit all; everyone else is limited to records they own or follow.
// Office is NOT a permission gate.
//
// Admin is decided by ROLE ONLY (`role === "admin"`). We deliberately do NOT use
// `type === "agency"`: GHL's SSO `type` reflects the account *context*
// (agency vs location), not permission — an agency-context user with
// `role: "user"` is still a restricted rep. Using `|| type === "agency"` wrongly
// let those reps bypass the filter and see every record. GHL admins carry
// `role: "admin"`, so they keep full access.
export function isAdminSession(role?: string, type?: string): boolean {
  void type; // intentionally unused — see note above
  return role === "admin";
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
export const canEditRecord = canSeeRecord;

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
