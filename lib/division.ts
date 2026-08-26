// Division labels, derived from pipeline NAMES — no hardcoded pipeline→division
// map (we deliberately removed that in Task 6). "OLTL Enrollment" and "OLTL
// Transfer" both reduce to "OLTL"; "Private Pay Clients" to "Private Pay".
// Pure and env-free so both the server and the client bundle can import it.

const WORKFLOW_SUFFIX = /\s+(enrollments?|transfers?|clients?|applicants?)$/i;

export function divisionLabel(pipelineName: string): string {
  if (!pipelineName) return "";
  return pipelineName.replace(WORKFLOW_SUFFIX, "").trim() || pipelineName;
}
