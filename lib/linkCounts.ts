// ---------------------------------------------------------------------------
// ROUND 183 — KEEP THE CARD BADGES IN STEP WITH THE CAREGIVERS PANEL.
//
// The "⇄ 1 caregiver" badge was counted once per page load and never again,
// so a link added or removed in the panel showed on the card only after a
// reload. These are the pure halves of the fix, kept out of page.tsx so a
// proof can exercise them without a browser.
// ---------------------------------------------------------------------------
import type { Caregiver, RelationCount, RelationCounts } from "./types";

/**
 * A record's count from its own link list, counted the way
 * `countCaregiverRelations` counts: `role` is the OTHER side's role, so a
 * "client" is one client and anything else is one caregiver.
 */
export function countFromLinks(links: Caregiver[]): RelationCount {
  let caregivers = 0;
  let clients = 0;
  for (const l of links) {
    if (l.role === "client") clients++;
    else caregivers++;
  }
  return { caregivers, clients };
}

/**
 * The counts after a link change seen in the panel.
 *
 *  - `selfContactId` gets the count of `links`, the list GoHighLevel returned
 *    straight after the write (the same read the panel shows).
 *  - `otherContactId`, the person just linked or unlinked, is REMOVED, so the
 *    board re-asks for them instead of showing their old count.
 *
 * Returns `prev` itself when nothing changes, so React skips the re-render
 * and the count effect does not re-run for nothing.
 */
export function applyLinkChangeToCounts(
  prev: RelationCounts,
  selfContactId: string,
  links: Caregiver[],
  otherContactId?: string,
): RelationCounts {
  if (!selfContactId) return prev;
  const own = countFromLinks(links);
  const other =
    otherContactId && otherContactId !== selfContactId ? otherContactId : "";
  const cur = prev[selfContactId];
  const selfSame =
    !!cur &&
    !cur.unknown &&
    cur.caregivers === own.caregivers &&
    cur.clients === own.clients;
  if (selfSame && !(other && other in prev)) return prev;
  const next: RelationCounts = { ...prev, [selfContactId]: own };
  if (other) delete next[other];
  return next;
}
