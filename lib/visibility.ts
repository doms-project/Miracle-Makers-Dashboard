import type { OpportunityRecord } from "./types";
import type { GhlSession } from "./sso";

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

/** Can this user SEE this record? (owner OR follower, or admin) */
export function canSeeRecord(
  rec: Pick<OpportunityRecord, "ownerId" | "followerIds">,
  session: Pick<GhlSession, "userId" | "role" | "type">,
): boolean {
  if (isAdminSession(session.role, session.type)) return true;
  return rec.ownerId === session.userId || rec.followerIds.includes(session.userId);
}

// Edit permission == visibility (same rule). Kept as a named alias so intent is
// explicit at the call site.
export const canEditRecord = canSeeRecord;
