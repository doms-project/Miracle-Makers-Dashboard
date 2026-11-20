export function norm(v: unknown): string {
  if (v == null) return "";
  return String(v)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export const digitsOf = (v: unknown): string => (v == null ? "" : String(v).replace(/\D/g, ""));

const lastTen = (d: string): string => (d.length > 10 ? d.slice(-10) : d);

export interface ParsedQuery {

  raw: string;

  tokens: string[];

  phone: string;
}

export function parseQuery(q: unknown): ParsedQuery {
  const raw = q == null ? "" : String(q).trim();
  const d = digitsOf(raw);
  const phone = raw && /^[\d\s()+.\-]+$/.test(raw) && d.length >= 4 ? lastTen(d) : "";
  return { raw, tokens: norm(raw).split(" ").filter(Boolean), phone };
}

export interface Indexed {

  hay: string;

  phone: string;
}

export function indexRecord(fields: unknown[], phone: unknown, email?: unknown): Indexed {
  return { hay: ` ${norm([...fields, email].filter((x) => x != null && x !== "").join(" "))} `, phone: lastTen(digitsOf(phone)) };
}

export function matchesQuery(ix: Indexed | undefined, pq: ParsedQuery): boolean {
  if (!pq.raw) return true;
  if (!ix) return false;
  const words = pq.tokens.length > 0 && pq.tokens.every((t) => ix.hay.includes(t));

  if (pq.phone) return (!!ix.phone && ix.phone.includes(pq.phone)) || words;
  return words;
}

export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export function nameScore(name: string, tokens: string[]): number {
  const n = norm(name);
  if (!n || !tokens.length) return 0;
  const words = n.split(" ");
  let total = 0;
  for (const t of tokens) {
    let best = 0;
    for (const w of words) {
      if (w === t) best = Math.max(best, 3);
      else if (w.startsWith(t)) best = Math.max(best, 2);
      else if (t.length >= 3 && w.includes(t)) best = Math.max(best, 1);
      else if (t.length >= 4 && (withinOneEdit(t, w) || withinOneEdit(t, w.slice(0, t.length)))) best = Math.max(best, 0.6);
    }
    if (!best) return 0;
    total += best;
  }
  return total / tokens.length + (n === tokens.join(" ") ? 1 : 0);
}

export type SuggestionKind = "owner" | "unassigned" | "cm" | "office" | "record" | "pipeline" | "source";

export interface Suggestion {
  kind: SuggestionKind;

  value: string;

  label: string;

  detail: string;
  score: number;
}

export interface SuggestInput {
  query: string;

  ownerWord: string;
  owners: { id: string; name: string; n: number; me?: boolean }[];
  unassigned?: number;
  caseManagers?: { name: string; n: number }[];
  offices?: { name: string; n: number }[];
  records: { id: string; name: string; detail: string; ix: Indexed; activity: number }[];

  maxRecords?: number;
  maxPeople?: number;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function suggest(inp: SuggestInput): Suggestion[] {
  const pq = parseQuery(inp.query);
  if (!pq.raw) return [];
  const out: Suggestion[] = [];
  const maxPeople = inp.maxPeople ?? 5;

  if (!pq.phone) {
    const people: Suggestion[] = [];
    for (const o of inp.owners) {
      let s = nameScore(o.name, pq.tokens);
      if (!s && o.me && pq.tokens.length === 1 && "me".startsWith(pq.tokens[0])) s = 2.5;
      if (s) people.push({ kind: "owner", value: o.id, label: o.me ? `${o.name} (me)` : o.name, detail: `${inp.ownerWord} · ${plural(o.n, "case")}`, score: s + Math.min(o.n, 999) / 10000 });
    }
    if (inp.unassigned && pq.tokens.length === 1 && pq.tokens[0].length >= 2 && ("unassigned".startsWith(pq.tokens[0]) || "nobody".startsWith(pq.tokens[0])))
      people.push({ kind: "unassigned", value: "", label: "Unassigned", detail: `no ${inp.ownerWord.toLowerCase()} · ${plural(inp.unassigned, "case")}`, score: 2 });
    for (const c of inp.caseManagers || []) {
      const s = nameScore(c.name, pq.tokens);
      if (s) people.push({ kind: "cm", value: c.name, label: c.name, detail: `Case manager · ${plural(c.n, "case")}`, score: s + Math.min(c.n, 999) / 10000 - 0.001 });
    }
    out.push(...people.sort((a, b) => b.score - a.score).slice(0, maxPeople));

    const places: Suggestion[] = [];
    for (const o of inp.offices || []) {
      const s = nameScore(o.name, pq.tokens);
      if (s) places.push({ kind: "office", value: o.name, label: o.name, detail: `Office · ${plural(o.n, "case")}`, score: s });
    }
    out.push(...places.sort((a, b) => b.score - a.score).slice(0, 3));
  }

  const recs: Suggestion[] = [];
  for (const r of inp.records) {
    let s = 0;
    if (pq.phone) s = r.ix.phone && r.ix.phone.includes(pq.phone) ? (r.ix.phone.endsWith(pq.phone) ? 3 : 2) : matchesQuery(r.ix, pq) ? 1 : 0;
    else {
      s = nameScore(r.name, pq.tokens);

      if (!s && matchesQuery(r.ix, pq)) s = 0.5;
    }
    if (s) recs.push({ kind: "record", value: r.id, label: r.name || "(no name)", detail: r.detail, score: s + r.activity / 1e16 });
  }
  out.push(...recs.sort((a, b) => b.score - a.score).slice(0, inp.maxRecords ?? 6));
  return out;
}

export function splitNames(v: unknown): string[] {
  if (v == null) return [];
  return String(v)
    .split(/\s*(?:,|;|\/|&|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s && s !== "—" && s !== "-");
}
