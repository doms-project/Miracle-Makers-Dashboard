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
  round: "132",
  /** One line naming what that round changed, for a reader who has the tab open. */
  summary:
    "a case can be transferred to the other company's sub-account: fields are " +
    "translated by name and by option value, it lands at TRANSFERRED IN, this " +
    "side closes into Transferred Out and is never deleted — and every skipped " +
    "field is named on the screen before anything is sent",
} as const;

export const BUILD_LABEL = `v${BUILD.round}`;
