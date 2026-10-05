// ---------------------------------------------------------------------------
// ROUND 171 · ITEM 5 — THE CASE-MANAGER LIST'S WORDING.
//
// 🔴 THIS FILE IMPORTS NOTHING, AND THAT IS THE WHOLE REASON IT EXISTS. The
// Access tab is a client component; lib/pipelineAccess.ts owns the
// AsyncLocalStorage stores, so importing it from the browser pulls
// `node:async_hooks` into the bundle and `next build` fails outright. Round
// 165 hit this with lib/stageKpi.ts and solved it by extracting the pure part
// (lib/stageHistory.ts). Same disease, same cure — and this time the build
// caught it rather than a reviewer.
// ---------------------------------------------------------------------------
// ROUND 171 · ITEM 5 — SAYING WHICH WAY THE CASE-MANAGER MAP RUNS.
//
// 🔴 IT WAS SET UP BACKWARDS ONCE, LIVE, AND THE SCREEN GAVE NO WAY TO NOTICE.
// A row was a name and a row of chips with nothing saying which was which —
// and the two views SWAP the meaning of both columns, so a reader who had it
// the wrong way round saw nothing to correct them. Getting it backwards is not
// a typo: it gives the wrong people access to the wrong cases, which is the
// one mistake the whole Access tab exists to make visible.
//
// 🔴 AND THESE ARE FUNCTIONS, NOT JSX, DELIBERATELY. Round 167 reverted an
// inline `useMemo` and the proof came back GREEN — rule 10, a revert that
// changes nothing is a proof that is not reaching the code. Wording a proof
// must be able to check does not live inside a component.
// ═══════════════════════════════════════════════════════════════════════════

/** The two column headings, for whichever way the list is being read. */
export function caseManagerColumns(
  view: "manager" | "rep",
): { who: string; what: string } {
  // 🔴 "Case owner", NOT "Rep", AND THE PROOF IS WHY. task1-tab asserts that
  // this section carries NO ROLE LABELS — round 137's rule, because the system
  // cannot know who is a rep: "-Sale" and "Case Manager" in a display name are
  // conventions, not data. My first version wrote "Rep" and went red against
  // working code.
  //
  // ⚠️ AND THE RULE IS RIGHT, SO THE WORDS CHANGED RATHER THAN THE RULE.
  // "Case manager" is what the map stores — somebody IS one because they are
  // in it — and "Case owner" is what the other side literally is. Neither is
  // inferred from a name, which is the whole of round 137's objection.
  return view === "manager"
    ? { who: "Case manager", what: "Follows cases owned by" }
    : { who: "Case owner", what: "Their cases are followed by" };
}

/**
 * One sentence per row, in the order the rule actually runs.
 *
 * ⚠️ THE OWNER COMES FIRST BECAUSE THE OWNER COMES FIRST: an owner is set, and
 * then a manager is added. A sentence in the other order would read true to
 * somebody holding the map backwards, which is the entire failure.
 */
export function caseManagerPreview(repName: string, managerName: string): string {
  const rep = (repName || "").trim();
  const mgr = (managerName || "").trim();
  if (!rep || !mgr) return "";
  return `When ${rep} owns a case, ${mgr} is added.`;
}
