// ---------------------------------------------------------------------------
// ROUND 195 — SEARCH THAT UNDERSTANDS WHAT YOU TYPED.
//
// The owner asked for no extra dropdowns: one search box that finds a lead
// instantly. This file is the engine behind it; app/page.tsx only draws it.
//
// MATCHING (what stays on the board while you type)
//   · Words in any order: "smith john" finds John Smith. Every word you type
//     must appear somewhere in the record.
//   · Accents, capitals and punctuation ignored: "o'neil" finds "ONeil".
//   · A phone number in any format: "(717) 692-1647", "717.692.1647",
//     "+1 717 692 1647" or just "1647" — digits are compared, nothing else.
//   · Part of an email: "jsmith@gm" finds jsmith@gmail.com.
//
// SUGGESTIONS (the list under the box)
//   · People — Sales rep / Recruiter, Case manager — picked to show exactly
//     their cases. Matched by owner ID downstream, so a client who happens to
//     share the name never sneaks in.
//   · Offices, and the best-matching leads themselves (picking one opens it,
//     even when the filters on screen would hide it).
//   · Ranked: a whole word beats the start of a word beats the middle of one,
//     and one typo is forgiven in words of four letters or more ("darus" →
//     Darius). Ties go to the person with more cases / the newer lead.
// ---------------------------------------------------------------------------

/** Lower-case, accents removed, anything not a letter or digit → one space. */
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

/** A US number's last ten digits, so +1 and no +1 compare equal. */
const lastTen = (d: string): string => (d.length > 10 ? d.slice(-10) : d);

export interface ParsedQuery {
  /** What was typed, trimmed. "" means no search. */
  raw: string;
  /** Normalised words, every one of which must match. */
  tokens: string[];
  /** Digits when the query is a phone number (4+ digits, nothing but phone punctuation); else "". */
  phone: string;
}

export function parseQuery(q: unknown): ParsedQuery {
  const raw = q == null ? "" : String(q).trim();
  const d = digitsOf(raw);
  const phone = raw && /^[\d\s()+.\-]+$/.test(raw) && d.length >= 4 ? lastTen(d) : "";
  return { raw, tokens: norm(raw).split(" ").filter(Boolean), phone };
}

/** One record's searchable text, prepared once per load rather than per keystroke. */
export interface Indexed {
  /** Every searchable field, normalised and joined. */
  hay: string;
  /** The person's phone, digits only (last ten). */
  phone: string;
}

export function indexRecord(fields: unknown[], phone: unknown, email?: unknown): Indexed {
  return { hay: ` ${norm([...fields, email].filter((x) => x != null && x !== "").join(" "))} `, phone: lastTen(digitsOf(phone)) };
}

/** Does a record pass the typed search? An empty search passes everything. */
export function matchesQuery(ix: Indexed | undefined, pq: ParsedQuery): boolean {
  if (!pq.raw) return true;
  if (!ix) return false;
  const words = pq.tokens.length > 0 && pq.tokens.every((t) => ix.hay.includes(t));
  // A number is a phone OR whatever field holds those digits (a Harmony ID is
  // all digits too, and must not be mistaken for a phone and lost).
  if (pq.phone) return (!!ix.phone && ix.phone.includes(pq.phone)) || words;
  return words;
}

/** True when a and b differ by at most one edit (insert, delete, change, or swap of two neighbours). */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // one change
    return i + 1 < la && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // swap
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1); // insert / delete
}

/**
 * How well a NAME matches the typed words, 0 when it does not.
 * Per word: whole word 3 · start of a word 2 · inside a word 1 · one typo 0.6.
 * Every typed word must score, and a name that is exactly the query gets a bonus.
 */
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

export type SuggestionKind = "owner" | "unassigned" | "cm" | "office" | "record";

export interface Suggestion {
  kind: SuggestionKind;
  /** owner id / case-manager name / office name / record id. */
  value: string;
  /** What the row says, e.g. "Darius Boyce". */
  label: string;
  /** The small grey part, e.g. "Sales rep · 235 cases". */
  detail: string;
  score: number;
}

export interface SuggestInput {
  query: string;
  /** "Sales rep" on the client boards, "Recruiter" on Recruiting. */
  ownerWord: string;
  owners: { id: string; name: string; n: number; me?: boolean }[];
  unassigned?: number;
  caseManagers?: { name: string; n: number }[];
  offices?: { name: string; n: number }[];
  records: { id: string; name: string; detail: string; ix: Indexed; activity: number }[];
  /** At most this many leads (default 6) and people (default 5). */
  maxRecords?: number;
  maxPeople?: number;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The suggestion list for what has been typed, best first within each group. */
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
      // Not in the name but everywhere else (an email, a phone typed as words): still a match, ranked below.
      if (!s && matchesQuery(r.ix, pq)) s = 0.5;
    }
    if (s) recs.push({ kind: "record", value: r.id, label: r.name || "(no name)", detail: r.detail, score: s + r.activity / 1e16 });
  }
  out.push(...recs.sort((a, b) => b.score - a.score).slice(0, inp.maxRecords ?? 6));
  return out;
}

/** Case-manager names on a record: the field may hold several, comma- or slash-separated. */
export function splitNames(v: unknown): string[] {
  if (v == null) return [];
  return String(v)
    .split(/\s*(?:,|;|\/|&|\band\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s && s !== "—" && s !== "-");
}
