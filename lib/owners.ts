export const UNASSIGNED = "__unassigned";
export const EVERYONE = "all";

export interface OwnedRecord {
  ownerId?: unknown;
  rep?: unknown;
}

export interface OwnerOption {
  id: string;
  name: string;
  n: number;

  me?: boolean;
}

const idOf = (r: OwnedRecord): string => (r.ownerId == null ? "" : String(r.ownerId).trim());

export function ownerLabel(r: OwnedRecord): string {
  const n = r.rep == null ? "" : String(r.rep).trim();
  return n && n !== "—" ? n : "";
}

export function matchesOwner(r: OwnedRecord, filter: string): boolean {
  if (!filter || filter === EVERYONE) return true;
  if (filter === UNASSIGNED) return !idOf(r);
  return idOf(r) === filter;
}

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

export function describeOwner(filter: string, names: Map<string, string>, word = "owner"): string {
  if (!filter || filter === EVERYONE) return "";
  if (filter === UNASSIGNED) return "unassigned";
  return `${word} ${names.get(filter) || "a former user"}`;
}
