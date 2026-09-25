// Division labels, derived from pipeline NAMES — no hardcoded pipeline→division
// map (we deliberately removed that in Task 6). "OLTL Enrollment" and "OLTL
// Transfer" both reduce to "OLTL"; "Private Pay Clients" to "Private Pay".
// Pure and env-free so both the server and the client bundle can import it.

// 🔴 WHAT DEPENDS ON THE CURRENT BEHAVIOUR — THREE FEATURES, ONE DERIVATION.
//
// This strips a workflow word off the end and returns the rest, which is right
// for "OLTL Enrollment" → "OLTL" and WRONG for every CAREGIVER pipeline on the
// account:
//
//   "OLTL Caregiver Applicants"        →  "OLTL Caregiver"
//   "Private Pay Caregiver Applicants" →  "Private Pay Caregiver"
//   "Events"                           →  "Events"
//
// None of those is a `Partner Division` value, and three separate features now
// account for it rather than relying on it:
//
//   task 2 · §4   a recruiter holding only an applicant pipeline matches NO
//                 partner — handled by sending a withheld count, not by fixing
//                 this function
//   task 2 · §2   `applicantRefs` is deliberately NOT division-scoped, because
//                 scoping it would empty the column rather than narrow it
//   the webhook   the handler derives no division from `pipeline_name` at all
//
// ⚠️ SO A "FIX" HERE IS NOT LOCAL. Anyone changing this must check those three:
// two of them are correct BECAUSE the derivation is wrong in a known way, and
// would need revisiting rather than merely re-testing.
const WORKFLOW_SUFFIX = /\s+(enrollments?|transfers?|clients?|applicants?)$/i;

export function divisionLabel(pipelineName: string): string {
  if (!pipelineName) return "";
  return pipelineName.replace(WORKFLOW_SUFFIX, "").trim() || pipelineName;
}
