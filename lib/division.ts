const WORKFLOW_SUFFIX = /\s+(enrollments?|transfers?|clients?|applicants?)$/i;

export function divisionLabel(pipelineName: string): string {
  if (!pipelineName) return "";
  return pipelineName.replace(WORKFLOW_SUFFIX, "").trim() || pipelineName;
}
