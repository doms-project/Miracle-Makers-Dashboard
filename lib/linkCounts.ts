import type { Caregiver, RelationCount, RelationCounts } from "./types";

export function countFromLinks(links: Caregiver[]): RelationCount {
  let caregivers = 0;
  let clients = 0;
  for (const l of links) {
    if (l.role === "client") clients++;
    else caregivers++;
  }
  return { caregivers, clients };
}

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
