// ---------------------------------------------------------------------------
// ROUND 175 — WHICH CASE DID THIS WEBHOOK MEAN?
//
// 🔴 PURE, SO A PROOF CAN DRIVE IT WITH LITERALS. Nothing here fetches. The
// route does the reads; this decides.
//
// 🔴 WHY THE PAYLOAD'S `id` CANNOT BE TRUSTED. In the owner's notification
// workflows the trigger IS the opportunity, so `id` is the case. But CAREGIVER
// APPLICATION ROUTING is triggered by an inbound application and CREATES the
// case inside the workflow — so `id` there may be the CONTACT. Writing an owner
// to a contact id would either 404 or, worse, hit something that is not the
// case we meant.
//
// ⚠️ AND THE FALLBACK MUST NEVER REACH THE FAMILY'S OTHER CASES. Families
// answer both the OLTL and the ODP ad, so one contact legitimately holds two
// cases in two pipelines. The fallback is therefore scoped to the payload's OWN
// `pipeline_id` AND to a case created in the last few minutes. With no
// pipeline_id there is no safe answer and the route changes nothing.
// ---------------------------------------------------------------------------

/**
 * How recent a case must be to be the one this workflow just created.
 *
 * ⚠️ TEN MINUTES, AND IT IS A CEILING RATHER THAN AN ESTIMATE. The measured
 * workflow latency is ~60 seconds (round 174's creation-row probe), but a
 * workflow with a Wait step can take longer, and the cost of being generous is
 * bounded: the family's OTHER case is days or weeks old, so no realistic
 * widening of this window can reach it. The cost of being too tight is a
 * silently unresolved case, which is the worse failure.
 */
export const RECENT_CASE_MS = 10 * 60 * 1000;

export interface CaseCandidate {
  id: string;
  pipelineId: string;
  createdAt?: string;
}

export type CaseResolution =
  | { ok: true; id: string; how: "payload-id" | "newest-in-pipeline" }
  | { ok: false; why: string };

/**
 * Pick the case a workflow payload meant, given what the account actually holds.
 *
 * @param payloadId      the payload's `id` — the case, or the contact, or junk
 * @param idIsOpportunity whether a live read confirmed `payloadId` is a case
 * @param pipelineId     the payload's `pipeline_id`
 * @param cases          this contact's cases, as read from GoHighLevel
 * @param now            ms
 */
export function resolveCase(
  payloadId: string,
  idIsOpportunity: boolean,
  pipelineId: string,
  cases: CaseCandidate[],
  now: number,
): CaseResolution {
  // ✅ THE CHEAP, CERTAIN PATH. A confirmed opportunity id needs no guessing.
  if (payloadId && idIsOpportunity)
    return { ok: true, id: payloadId, how: "payload-id" };

  if (!payloadId) return { ok: false, why: "the payload carried no id at all" };
  if (!pipelineId)
    return {
      ok: false,
      // 🔴 NOT A GUESS ACROSS PIPELINES. Without a pipeline the only way to
      // choose would be "the newest case anywhere", and on a family in two
      // divisions that is a coin flip between two live cases.
      why:
        `the payload's id (${payloadId}) is not an opportunity and the payload has no ` +
        "pipeline_id, so there is no safe way to tell which of this contact's cases was meant",
    };

  const fresh = cases
    .filter((c) => c.pipelineId === pipelineId)
    .filter((c) => {
      const t = Date.parse(c.createdAt || "");
      // ⚠️ AN UNDATEABLE CASE IS NOT "RECENT". Treating a missing createdAt as
      // in-window would make the fallback pick the family's older case the
      // moment GoHighLevel omitted one field.
      return Number.isFinite(t) && now - t >= 0 && now - t <= RECENT_CASE_MS;
    })
    .sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));

  if (!fresh.length) {
    const inPipe = cases.filter((c) => c.pipelineId === pipelineId).length;
    return {
      ok: false,
      why:
        `the payload's id (${payloadId}) is not an opportunity, and this contact has ` +
        `${inPipe} case(s) in pipeline ${pipelineId} but none created in the last ` +
        `${Math.round(RECENT_CASE_MS / 60000)} minutes`,
    };
  }
  return { ok: true, id: fresh[0].id, how: "newest-in-pipeline" };
}
