export const RECENT_CASE_MS = 10 * 60 * 1000;

export interface CaseCandidate {
  id: string;
  pipelineId: string;
  createdAt?: string;
}

export type CaseResolution =
  | { ok: true; id: string; how: "payload-id" | "newest-in-pipeline" }
  | { ok: false; why: string };

export function resolveCase(
  payloadId: string,
  idIsOpportunity: boolean,
  pipelineId: string,
  cases: CaseCandidate[],
  now: number,
): CaseResolution {

  if (payloadId && idIsOpportunity)
    return { ok: true, id: payloadId, how: "payload-id" };

  if (!payloadId) return { ok: false, why: "the payload carried no id at all" };
  if (!pipelineId)
    return {
      ok: false,

      why:
        `the payload's id (${payloadId}) is not an opportunity and the payload has no ` +
        "pipeline_id, so there is no safe way to tell which of this contact's cases was meant",
    };

  const fresh = cases
    .filter((c) => c.pipelineId === pipelineId)
    .filter((c) => {
      const t = Date.parse(c.createdAt || "");

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
