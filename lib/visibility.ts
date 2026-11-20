import type { OpportunityRecord } from "./types";
import type { GhlSession } from "./sso";
import { getUserHomePipelines, staffingLevel, canUsePeerTransfer } from "./pipelineAccess";
import { canTakeUnowned, type Viewer } from "./sorting";
import { isAdminRole } from "./adminRole";

export function isAdminSession(role?: string, type?: string): boolean {
  void type;
  return isAdminRole(role);
}

export function canSeeRecord(
  rec: Pick<OpportunityRecord, "ownerId" | "followerIds" | "pipelineId">,
  session: Pick<GhlSession, "userId" | "role" | "type">,
): boolean {
  if (isAdminSession(session.role, session.type)) return true;
  if (rec.ownerId === session.userId || rec.followerIds.includes(session.userId))
    return true;

  const home = getUserHomePipelines(session.userId);
  const unassigned = !rec.ownerId;
  return unassigned && home.has(rec.pipelineId);
}

export const canEditRecord = canSeeRecord;

export function canChangeOwner(
  rec: Pick<OpportunityRecord, "ownerId"> & Partial<Pick<OpportunityRecord, "pipelineId" | "stage">>,
  session: Pick<GhlSession, "userId" | "role" | "type">,
  newOwnerId?: string,
): boolean {
  if (isAdminSession(session.role, session.type)) return true;
  if (rec.ownerId) return rec.ownerId === session.userId;

  if (!rec.pipelineId || newOwnerId === undefined) return false;
  return canTakeUnowned(
    { ownerId: "", pipelineId: rec.pipelineId, stage: rec.stage || "" },
    viewerFor(session),
    newOwnerId,
  ).ok;
}

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

export function canManageFollowers(
  rec: Pick<OpportunityRecord, "ownerId">,
  session: Pick<GhlSession, "userId" | "role" | "type">,
): boolean {
  if (isAdminSession(session.role, session.type)) return true;
  return rec.ownerId === session.userId;
}
