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
  round: "163",
  /** One line naming what that round changed, for a reader who has the tab open. */
  summary:
    "140 · “Log a referral” only offers — and only accepts — a pipeline the " +
    "viewer holds, and an empty picker says whether that is a grant you lack " +
    "or a pipeline nobody configured · 141 · no product change: the referrals " +
    "route proof now counts its own results and can fail, having printed FAIL " +
    "and exited 0 for a round · 143 · partner rows are scoped to the divisions you hold, plus any partner assigned to you; the switcher lists the divisions actually present rather than the field's whole picklist, and disappears when there is nothing to switch · 144 · no product change, a design report only — and it found a live defect from 143: a partner withheld by division reads as one that was deleted · 145 · that defect fixed: the count is computed server-side against the full partner list, so a partner you may not see is no longer reported as one that was deleted · 146 · the aggregates are scoped by DIVISION — a rep reads their division's revenue, win rate and clients won, every scoped number names its scope, and the applicant column stays account-wide on purpose · 147 · no product change, a design report only — and its sweep found a third place where a filtered list is read as an absence · 148 · that third one fixed — the “Referred by” picker told a viewer no referral partners existed on an account with five, and following its advice would have created a duplicate of one they cannot see · 149 · case managers apply on CLIENT pipelines only — a caregiver applicant assigned to a sales rep no longer picks up that rep's case managers, and a case moved onto a caregiver pipeline loses the ones it had · 150 · the inbound webhook acts: a workflow payload applies case managers through the contact's owner, a native stage event is recognised and declined, and anything unreadable is 202'd with its key names logged · 151 · a follower write that GoHighLevel accepts and does not store is now caught instead of reported as success — the panel no longer shows a follower that was never saved, a refused removal can no longer disown a manager for ever, and “Case Manager Followers” renders names instead of raw user ids · 152 · the relation-count badges stop asking for contacts they are already asking about — the storm that produced 13,851 timeouts in two minutes — and a count that could not be read now says “links unknown” instead of being recorded as no links · 153 · no product change on the screens — a report on the zero-grant first-day experience, plus the round archive dropping 1.7 MB of write-only screenshots and a tsc cache · 154 · no product change — a report finding that four of the tree’s read-after-write checks can be fooled by GoHighLevel applying a write asynchronously, the worst of them able to clear the record that decides which followers we may remove · 155 · a new seat with no pipelines now gets the same screen on Recruiting that Clients already gave them — an explanation instead of a pipeline picker listing pipelines they hold no access to, and the names are withheld from the payload rather than only from the screen · 156 · GoHighLevel applies some writes asynchronously, so a check made a second later can see the old value — a follower change that really landed is no longer reported as failed, and a slow read can no longer wipe the record that says which followers we may remove · 157 · the “Case Manager Followers” row is gone from the record panel — it held raw user ids and the same question is already answered by the Case Manager field and the Followers control; the field itself is untouched and still written · 158 · a backfill driver for the ~600 client records that predate the case-manager rule — resumable, paced under the rate limit, and keeping a refused write apart from a correct no-op so nothing looks finished that is not · 159 · no product change — a report on the stage recorder, finding that the only storage this app has cannot survive the bulk edit the recorder exists to spot, and that a per-record field can · 160 · no product change — a sweep of the proofs themselves, which found a guard that had been unable to see the thing it forbids since the day it was written · 161 · no product change — a design report on per-user referral access · 162 · Jack can now override which divisions any one person sees referrals for — derived from their pipeline grants by default, an explicit list, or agency-wide — and “an explicit list with nothing in it” is a real setting meaning they see none · 163 · every stage change is now written down on the record it happened to — who owned it, which case managers were watching at that moment, and when — so “two stages a month” can be counted per manager instead of estimated",
} as const;

export const BUILD_LABEL = `v${BUILD.round}`;
