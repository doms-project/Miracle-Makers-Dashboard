import {
  fetchPipelineAccessGrants,
  getLocationUserIds,
  listPipelines,
} from "./ghl";
import { buildGrants, runWithGrants } from "./pipelineAccess";

// Loads the pipeline-access grants ONCE for this request and runs the handler
// with them installed, so getUserHomePipelines() (and therefore canSeeRecord,
// applyAccess and userDivisions) sees the live custom value instead of the env
// var.
//
// Deliberate properties:
//   - per-REQUEST only; nothing is cached across requests, and a failed read is
//     never cached (that was the users-lookup bug).
//   - a missing / unparseable / failed read falls back to PIPELINE_ACCESS_MAP
//     rather than locking everyone out.
//   - the map is validated against the live user and pipeline lists, so a stale
//     id (deleted user, deleted pipeline) is ignored instead of crashing the
//     filter. If those lists can't be fetched we skip validation rather than
//     treating every id as stale — failing open on VALIDATION, never on access.
export async function withGrants<T>(fn: () => Promise<T>): Promise<T> {
  let stored: Record<string, string[]> | null = null;
  let userIds: Set<string> | undefined;
  let pipelineIds: Set<string> | undefined;

  try {
    stored = await fetchPipelineAccessGrants();
  } catch {
    stored = null; // fall back to the env var
  }
  try {
    userIds = await getLocationUserIds();
    pipelineIds = new Set((await listPipelines()).map((p) => p.id));
  } catch {
    userIds = undefined;
    pipelineIds = undefined; // skip validation rather than drop everything
  }

  const grants = buildGrants(stored, userIds, pipelineIds);
  return runWithGrants(grants, fn);
}
