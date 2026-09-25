/**
 * 🔴 WHICH BUILD IS ON THE SCREEN — round 115.
 *
 * Five rounds running, a harness has passed and the live dashboard has behaved
 * differently, and every one of those investigations began by ASSUMING the
 * deployed code was the code I had just written. That assumption has never once
 * been checked, because there was nothing on screen to check it with.
 *
 * ⚠️ THIS IS NOT A VERSION NUMBER FOR ITS OWN SAKE. It is the first question of
 * every bug report from here on: "what does the footer say?" If it says 114 and
 * the fix went out in 115, the investigation is over in one line instead of a
 * round. If it says 115 and the bug is still there, then the bug is real and I
 * stop looking for deployment explanations.
 *
 * Bump ROUND in the same commit as the round's work. Nothing derives it
 * automatically on purpose: a stamp that updates itself on every rebuild tells
 * you when the bundle was made, not which round's changes are in it.
 */
export const BUILD = {
  /**
   * The round whose changes this build contains.
   *
   * ⚠️ A STRING, NOT A NUMBER. The regression investigation took the 115 slot
   * before the wording round could use it, so the labels are 115 and 115b. A
   * numeric field would have forced a renumber, and renumbering a stamp whose
   * whole job is to identify a build defeats the stamp.
   */
  /*
   * ⚠️ 135, 136 AND 137 NEVER MOVED THIS. Task 1's three steps shipped under a
   * stamp that read 134, which is the one failure this file exists to prevent:
   * "what does the footer say?" would have answered with a round that predates
   * the case-manager work entirely. The jump 134 → 138 is that gap, left visible
   * rather than backfilled — a stamp rewritten after the fact is a stamp that
   * cannot be trusted to mean anything.
   */
  round: "148",
  /** One line naming what that round changed, for a reader who has the tab open. */
  summary:
    "140 · “Log a referral” only offers — and only accepts — a pipeline the " +
    "viewer holds, and an empty picker says whether that is a grant you lack " +
    "or a pipeline nobody configured · 141 · no product change: the referrals " +
    "route proof now counts its own results and can fail, having printed FAIL " +
    "and exited 0 for a round · 143 · partner rows are scoped to the divisions you hold, plus any partner assigned to you; the switcher lists the divisions actually present rather than the field's whole picklist, and disappears when there is nothing to switch · 144 · no product change, a design report only — and it found a live defect from 143: a partner withheld by division reads as one that was deleted · 145 · that defect fixed: the count is computed server-side against the full partner list, so a partner you may not see is no longer reported as one that was deleted · 146 · the aggregates are scoped by DIVISION — a rep reads their division's revenue, win rate and clients won, every scoped number names its scope, and the applicant column stays account-wide on purpose · 147 · no product change, a design report only — and its sweep found a third place where a filtered list is read as an absence · 148 · that third one fixed — the “Referred by” picker told a viewer no referral partners existed on an account with five, and following its advice would have created a duplicate of one they cannot see",
} as const;

export const BUILD_LABEL = `v${BUILD.round}`;
