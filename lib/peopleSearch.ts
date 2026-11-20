export interface CaseHolder {
  contactId: string;
  name: string;

  pipelineName: string;

  stage: string;

  more: number;
}

export interface CaseRow {
  contactId: string;
  contactName?: string;
  first?: string;
  last?: string;
  pipelineName?: string;
  stage?: string;

  status?: string;

  createdAt?: string;
}

export function indexCaseHolders(rows: CaseRow[]): CaseHolder[] {
  const by = new Map<string, { best: CaseRow; count: number }>();
  for (const r of rows) {
    const id = (r.contactId || "").trim();
    if (!id) continue;
    const cur = by.get(id);
    if (!cur) {
      by.set(id, { best: r, count: 1 });
      continue;
    }
    cur.count += 1;
    if (betterCase(r, cur.best)) cur.best = r;
  }
  const out: CaseHolder[] = [];
  for (const [contactId, { best, count }] of by) {
    out.push({
      contactId,
      name: displayName(best),
      pipelineName: best.pipelineName || "",
      stage: best.stage || "",
      more: count - 1,
    });
  }
  return out;
}

const isOpen = (r: CaseRow): boolean => {
  const s = (r.status || "").toLowerCase();
  return s === "" || s === "open";
};

function betterCase(a: CaseRow, b: CaseRow): boolean {
  if (isOpen(a) !== isOpen(b)) return isOpen(a);
  return (a.createdAt || "") > (b.createdAt || "");
}

function displayName(r: CaseRow): string {
  const two = `${r.first || ""} ${r.last || ""}`.trim();
  return (r.contactName || "").trim() || two || "";
}

export function matchCaseHolders(
  people: CaseHolder[],
  query: string,
  opts: { exclude?: readonly string[]; limit?: number } = {},
): CaseHolder[] {
  const words = (query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const skip = new Set(opts.exclude || []);
  const hits = people.filter((p) => {
    if (skip.has(p.contactId)) return false;
    const hay = p.name.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  hits.sort((a, b) => a.name.localeCompare(b.name));
  return hits.slice(0, opts.limit ?? 20);
}

export interface ExistingPerson {
  id: string;
  name: string;

  recordType?: string;

  caseLabel?: string;
}

export function existingPersonSentence(
  key: "phone" | "email",
  who: ExistingPerson,
): string {

  const what = key === "phone" ? "This phone number" : "This email";
  const name = (who.name || "").trim() || "someone already in GoHighLevel";

  const role = (who.recordType || "").trim() || "no role";
  const where = (who.caseLabel || "").trim();
  return (
    `${what} belongs to ${name} (${role})${where ? `, ${where}` : ""}. ` +
    "Record them, or enter someone new with a different number?"
  );
}

export function caseClause(
  cases: { pipelineName?: string; stage?: string }[],
  noun = "client",
): string {
  const first = cases.find((c) => (c.pipelineName || "").trim());
  if (!first) return "";
  return `a ${noun} in ${String(first.pipelineName).trim()}`;
}
