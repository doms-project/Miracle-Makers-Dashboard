export function caseManagerColumns(
  view: "manager" | "rep",
): { who: string; what: string } {

  return view === "manager"
    ? { who: "Case manager", what: "Follows cases owned by" }
    : { who: "Case owner", what: "Their cases are followed by" };
}

export function caseManagerPreview(repName: string, managerName: string): string {
  const rep = (repName || "").trim();
  const mgr = (managerName || "").trim();
  if (!rep || !mgr) return "";
  return `When ${rep} owns a case, ${mgr} is added.`;
}
