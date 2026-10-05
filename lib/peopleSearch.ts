// ---------------------------------------------------------------------------
// ROUND 171 — FINDING A PERSON BY WHAT THEY HAVE, NOT BY WHAT THEY ARE LABELLED.
//
// 🔴 PURE, FOR THE SAME REASON lib/stageKpi.ts IS. Nothing here fetches or
// reads a clock. Two routes consume it and a proof can drive it with a literal
// array and no server at all.
//
// 🔴 AND IT EXISTS BECAUSE Record Type IS NOT A FACT ABOUT MOST PEOPLE. Probed
// live on 1 October: of 120 contacts holding a client case, 118 have NO Record
// Type at all, two say "Caregiver", and not one says "Client" — because no
// path in this codebase has ever written "Client". A Clients picker filtered on
// Record Type = "Client" would return nobody on this account, forever, and
// would look exactly like a broken search.
//
// So a client is identified by the thing that actually makes them one: THEY
// HAVE A CASE IN A CLIENT PIPELINE.
// ---------------------------------------------------------------------------

/** One person who holds at least one case, as a picker row. */
export interface CaseHolder {
  contactId: string;
  name: string;
  /** The pipeline of the case shown beside the name. */
  pipelineName: string;
  /** That case's stage. */
  stage: string;
  /** Cases this person holds beyond the one shown. 0 for most. */
  more: number;
}

/** The shape indexing needs from an opportunity. Structural, like StageKpiRecord. */
export interface CaseRow {
  contactId: string;
  contactName?: string;
  first?: string;
  last?: string;
  pipelineName?: string;
  stage?: string;
  /** GoHighLevel's status: open / won / lost / abandoned. */
  status?: string;
  /** For "which of this person's cases do we show" — newest wins. */
  createdAt?: string;
}

/**
 * Collapse a board into one row per contact.
 *
 * 🔴 ONE ROW PER PERSON, NOT PER CASE. A picker that lists "Haydee Ortiz" three
 * times because she has three cases makes the reader pick one at random, and
 * the association is with the PERSON — which case they are in is context, not
 * the thing being chosen.
 *
 * ⚠️ AN OPEN CASE OUTRANKS A CLOSED ONE, and after that the newest wins. A
 * person whose only ODP case was lost last year and who is open in OLTL today
 * should read as OLTL — showing the lost one would be true and useless.
 */
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

/**
 * Narrow a picker list by what the user typed.
 *
 * ⚠️ EVERY WORD TYPED MUST APPEAR, IN ANY ORDER. "ortiz hay" finds "Haydee
 * Ortiz". A single `includes` on the whole string would not, and a first-word
 * match would rank a stranger above the person being looked for.
 *
 * 🔴 `exclude` IS THE OPEN RECORD'S OWN CONTACT. Offering somebody themselves
 * is an association a person can make with two clicks and nothing in
 * GoHighLevel refuses — the one case where the picker is the only guard.
 */
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

// ═══════════════════════════════════════════════════════════════════════════
// ROUND 171 · ITEM 4 — THE SENTENCE THAT STOPS A SILENT RENAME.
//
// 🔴 ONE FUNCTION, FIVE CALL SITES. Add person met, Log a referral, Add
// partner, Add Applicant and Add Lead all matched an existing person on phone
// or email and sent the TYPED name onto them. Families share a phone, so
// adding "John Ortiz" with his mother's number renamed his mother — on every
// record she has, with no error and nothing on screen.
//
// ⚠️ AND IT IS WORSE THAN A RENAME, because GoHighLevel keeps only the first
// word as firstName (round 170). "Mary Ann Smith" overwritten by "John Ortiz"
// does not come back by retyping it.
//
// 🔴 THE WORDING IS THE OWNER'S, VERBATIM. It is a question with two answers,
// and NEITHER of them is "create it anyway" — there is no third path, because
// a second contact on one phone number is the duplicate GoHighLevel's own
// deduplication exists to prevent.
// ═══════════════════════════════════════════════════════════════════════════

export interface ExistingPerson {
  id: string;
  name: string;
  /** Their Record Type, or "" when they have none. NEVER inferred. */
  recordType?: string;
  /** "a client in OLTL Enrollment" — the case clause, already composed. */
  caseLabel?: string;
}

/**
 * The refusal shown when a "new person" turns out to be somebody who exists.
 *
 * ⚠️ `key` IS WHICH ONE MATCHED, NOT WHICH ONE WAS SENT. Both can be sent and
 * only one match; naming the wrong one sends the user to edit a field that is
 * fine.
 */
export function existingPersonSentence(
  key: "phone" | "email",
  who: ExistingPerson,
): string {
  // ✅ ROUND 174 — IT NAMES THE DETAIL, AND GOHIGHLEVEL SAYS WHICH ONE. The
  // refusal body carries `meta.matchingField`, so this is no longer inferred
  // from which fields happened to be sent — which got it wrong whenever both
  // were.
  const what = key === "phone" ? "This phone number" : "This email";
  const name = (who.name || "").trim() || "someone already in GoHighLevel";
  // 🔴 "no role" IS A STATED ABSENCE, NOT A GUESS. 118 of 120 people with a
  // client case have no Record Type, so this is the COMMON branch and it must
  // read as a fact rather than as something missing.
  const role = (who.recordType || "").trim() || "no role";
  const where = (who.caseLabel || "").trim();
  return (
    `${what} belongs to ${name} (${role})${where ? `, ${where}` : ""}. ` +
    "Record them, or enter someone new with a different number?"
  );
}

/**
 * "a client in OLTL Enrollment", or "" when they hold no case.
 *
 * ⚠️ THE NOUN IS "a client" ONLY BECAUSE THE CASE SAYS SO. It comes from
 * holding a case in that pipeline, never from a Record Type and never from a
 * name — the same rule the Clients picker above is built on.
 */
export function caseClause(
  cases: { pipelineName?: string; stage?: string }[],
  noun = "client",
): string {
  const first = cases.find((c) => (c.pipelineName || "").trim());
  if (!first) return "";
  return `a ${noun} in ${String(first.pipelineName).trim()}`;
}
