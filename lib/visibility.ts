import type { OpportunityRecord } from "./types";
import type { GhlSession } from "./sso";

// Phase 3 permission model — ASSIGNMENT ONLY (shared by the list + save routes).
// Admin/agency see & edit all; everyone else is limited to records they own or
// follow. Office is NOT a permission gate.

export function isAdminSession(role?: string, type?: string): boolean {
  return role === "admin" || type === "agency";
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
