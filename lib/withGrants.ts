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
  } catch (e) {
    // ITEM 2 root-cause trail. This was a bare `catch {}`: when the custom-value
    // read failed, the request fell back to the env var with NOTHING said. If
    // PIPELINE_ACCESS_MAP is also unset, every user then has zero home
    // pipelines — no division, no [DIVISION] note prefix, and no clue why.
    // eslint-disable-next-line no-console
    console.error(
      "[grants] could not read the 'MM Pipeline Access' custom value — falling back to PIPELINE_ACCESS_MAP:",
      e instanceof Error ? e.message : String(e),
    );
    stored = null; // fall back to the env var
  }
  try {
    userIds = await getLocationUserIds();
    pipelineIds = new Set((await listPipelines()).map((p) => p.id));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[grants] live user/pipeline lists unavailable — SKIPPING grant validation (failing open on validation, never on access):",
      e instanceof Error ? e.message : String(e),
    );
    userIds = undefined;
    pipelineIds = undefined; // skip validation rather than drop everything
  }

  const grants = buildGrants(stored, userIds, pipelineIds);

  // Validation drops stale ids SILENTLY by design. Silent is right for the
  // filter and wrong for the operator: a grant keyed by a user id that no longer
  // exists (or a pipeline that was deleted) simply stops working, and the only
  // symptom is a rep seeing nothing. Report exactly what was discarded.
  const storedCount = stored ? Object.keys(stored).length : null;
  if (storedCount != null && storedCount !== grants.size) {
    const kept = new Set(grants.keys());
    const dropped = Object.keys(stored!).filter((u) => !kept.has(u));
    // eslint-disable-next-line no-console
    console.warn(
      `[grants] ${storedCount} stored grant(s) -> ${grants.size} effective. Discarded as stale (unknown user, or every pipeline unknown): ${dropped.join(", ") || "(none — entries had no valid pipelines)"}.`,
    );
  }
  if (!grants.size) {
    // eslint-disable-next-line no-console
    console.warn(
      `[grants] NO effective pipeline grants for this request (source: ${stored ? "custom value" : "PIPELINE_ACCESS_MAP env"}). Every non-admin browses nothing, and Move notes get no [DIVISION] prefix.`,
    );
  }

  return runWithGrants(grants, fn);
}
