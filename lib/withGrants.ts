import {
  fetchAccessGrantsV2,
  getLocationUserIds,
  listPipelines,
} from "./ghl";
import {
  buildGrants,
  buildIdMap,
  runWithGrants,
  runWithExtraGrants,
  runWithCaseManagers,
  runWithReferralAccess,
  runWithStaffing,
} from "./pipelineAccess";

export async function withGrants<T>(fn: () => Promise<T>): Promise<T> {
  let stored: Record<string, string[]> | null = null;

  let folderGrants: Record<string, string[]> = {};
  let masterUsers: string[] = [];

  let caseManagers: Record<string, string[]> = {};

  let referralAccess: Record<string, { mode: "agency" } | { mode: "divisions"; divisions: string[] }> = {};

  let staffing: Record<string, "self" | "any"> = {};
  let peerTransfer: string[] = [];
  let userIds: Set<string> | undefined;
  let pipelineIds: Set<string> | undefined;

  try {
    const v2 = await fetchAccessGrantsV2();
    stored = v2 ? v2.pipelines : null;
    folderGrants = v2?.folders ?? {};
    masterUsers = v2?.master ?? [];
    caseManagers = v2?.caseManagers ?? {};
    referralAccess = v2?.referralAccess ?? {};
    staffing = v2?.staffing ?? {};
    peerTransfer = v2?.peerTransfer ?? [];
  } catch (e) {

    // eslint-disable-next-line no-console
    console.error(
      "[grants] could not read the 'MM Pipeline Access' custom value — falling back to PIPELINE_ACCESS_MAP:",
      e instanceof Error ? e.message : String(e),
    );
    stored = null;
  }
  try {
    userIds = await getLocationUserIds();
    pipelineIds = new Set((await listPipelines()).map((p) => p.id));

    if (!userIds.size) {
      // eslint-disable-next-line no-console
      console.warn(
        "[grants] the users lookup returned ZERO users (usually a PIT missing the users.readonly scope) — SKIPPING grant validation so the access map is not wiped. Grant that scope: owner/follower names, the pickers and transfer owner-validation all depend on it.",
      );
      userIds = undefined;
    }
    if (!pipelineIds.size) {
      // eslint-disable-next-line no-console
      console.warn(
        "[grants] the pipeline list came back EMPTY — SKIPPING grant validation rather than discarding every grant.",
      );
      pipelineIds = undefined;
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[grants] live user/pipeline lists unavailable — SKIPPING grant validation (failing open on validation, never on access):",
      e instanceof Error ? e.message : String(e),
    );
    userIds = undefined;
    pipelineIds = undefined;
  }

  const grants = buildGrants(stored, userIds, pipelineIds);

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

  return runWithGrants(grants, () =>
    runWithExtraGrants(buildIdMap(folderGrants), new Set(masterUsers), () =>

      runWithCaseManagers(buildIdMap(caseManagers), () =>

        runWithReferralAccess(new Map(Object.entries(referralAccess)), () =>
          runWithStaffing(new Map(Object.entries(staffing)), new Set(peerTransfer), fn)))),
  );
}
