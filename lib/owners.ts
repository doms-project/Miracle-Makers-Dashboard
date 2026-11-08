// ---------------------------------------------------------------------------
// ROUND 193 — FILTER BY OWNER, RELIABLY.
//
// Finding one person's leads meant typing their name into search, which also
// matched clients, caregivers and case managers with that name, or setting
// Group to Owner. The "By rep" tile lists only the top four owners.
//
// 🔴 MATCHED BY OWNER ID, NEVER BY NAME (round 115's rule): a display name is a
// lookup result and can differ between records; the id cannot.
//
// The option list is built from the records the view would show with every
// OTHER filter applied, so each count is what picking it will show.
// ---------------------------------------------------------------------------

/** The value meaning "nobody owns it". Cannot collide with a GoHighLevel id. */
export const UNASSIGNED = "__unassigned";
export const EVERYONE = "all";

/** What the filter reads from a record. */
export interface OwnedRecord {
  ownerId?: unknown;
  rep?: unknown;
}

export interface OwnerOption {
  id: string;
  name: string;
  n: number;
  /** The person viewing the dashboard. */
  me?: boolean;
}

const idOf = (r: OwnedRecord): string => (r.ownerId == null ? "" : String(r.ownerId).trim());

/** The name shown for an owner on a record; "—" is the resolver's "no name". */
export function ownerLabel(r: OwnedRecord): string {
  const n = r.rep == null ? "" : String(r.rep).trim();
  return n && n !== "—" ? n : "";
}

/** Does a record pass the owner filter? */
export function matchesOwner(r: OwnedRecord, filter: string): boolean {
  if (!filter || filter === EVERYONE) return true;
  if (filter === UNASSIGNED) return !idOf(r);
  return idOf(r) === filter;
}

/** Every owner id seen, with the first readable name for it. */
export function ownerNames(...lists: readonly (readonly OwnedRecord[])[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const list of lists)
    for (const r of list) {
      const id = idOf(r);
      const name = ownerLabel(r);
      if (id && name && !m.has(id)) m.set(id, name);
    }
  return m;
}

/**
 * The dropdown's options for these rows: the viewer first ("Me"), then
 * everyone else by name. The selected owner is always listed — with 0 if
 * nothing of theirs is in view — so the control never hides what it is doing.
 */
export function ownerOptions(
  rows: readonly OwnedRecord[],
  opts: { viewerId?: string | null; selected?: string; names?: Map<string, string> } = {},
): { unassigned: number; owners: OwnerOption[] } {
  const tally = new Map<string, OwnerOption>();
  let unassigned = 0;
  for (const r of rows) {
    const id = idOf(r);
    if (!id) {
      unassigned++;
      continue;
    }
    const hit = tally.get(id);
    if (hit) hit.n++;
    else tally.set(id, { id, name: ownerLabel(r) || opts.names?.get(id) || "Former user", n: 1 });
  }
  const sel = opts.selected || "";
  if (sel && sel !== EVERYONE && sel !== UNASSIGNED && !tally.has(sel))
    tally.set(sel, { id: sel, name: opts.names?.get(sel) || "Former user", n: 0 });
  const viewer = (opts.viewerId || "").trim();
  const owners = [...tally.values()]
    .map((o) => (viewer && o.id === viewer ? { ...o, me: true } : o))
    .sort((a, b) => (a.me === b.me ? a.name.localeCompare(b.name) : a.me ? -1 : 1));
  return { unassigned, owners };
}

/** "owner Chris Smith" / "unassigned" / "" — for "filtered by …" sentences. */
export function describeOwner(filter: string, names: Map<string, string>, word = "owner"): string {
  if (!filter || filter === EVERYONE) return "";
  if (filter === UNASSIGNED) return "unassigned";
  return `${word} ${names.get(filter) || "a former user"}`;
}
