// ═══════════════════════════════════════════════════════════════════════════
// ROUND 171 · ITEM 4 — ADDING A PERSON MUST NEVER OVERWRITE ONE.
//
// 🔴 WHAT WAS HAPPENING, ON FIVE PATHS. Every "new person" form matched an
// existing contact on phone or email — that is what `upsertContact` IS — and
// then sent the TYPED NAME onto whoever matched. Families share a phone, so
// adding "John Ortiz" with his mother's number renamed his mother, on every
// record she has, with no error and nothing on screen.
//
// ⚠️ AND GOHIGHLEVEL KEEPS ONLY THE FIRST WORD AS firstName (round 170), so
// "Mary Ann Smith" overwritten by "John Ortiz" does not come back by retyping
// it. The overwrite is lossy as well as silent.
//
// ✅ SO IT ASKS BEFORE IT WRITES, AND NOTHING IS WRITTEN WHILE IT ASKS. The
// question has two answers and neither of them is "create it anyway": a second
// contact on one phone number is the duplicate GoHighLevel's own deduplication
// exists to prevent.
//
// 🔴 ONE FUNCTION, FIVE CALL SITES — Add person met, Log a referral → New
// enquiry, Add partner → New organisation, Add Lead and Add Applicant. The
// previous five copies of "find the contact, then write to it" are how four of
// them had the bug and one (Add partner's promote path) did not.
//
// ⚠️ WHAT IT COSTS, NAMED: up to four requests — the match, their Record Type,
// their cases, and their event. ALL OF THEM ON A PATH THAT WRITES NOTHING and
// ends the request, so none of it is in any load's budget. No match costs one
// or two and is the unchanged happy path.
//
// 🔴 A FAILED LOOK-UP IS NOT "no match". `findContactByEmailOrPhone` throws
// rather than returning null for exactly this reason, and that throw is let
// through: refusing to write because we could not check beats writing because
// we could not check.
// ═══════════════════════════════════════════════════════════════════════════
import {
  findContactByEmailOrPhone,
  getContactCustomFields,
  listContactOpportunities,
} from "@/lib/ghl";
import { existingPersonSentence, caseClause } from "@/lib/peopleSearch";

export interface ExistingPersonRefusal {
  error: string;
  detail: string;
  status: 409;
  /** Round 119 item 3 — the app declined on purpose and the message is the instruction. */
  refusal: true;
  existing: {
    id: string;
    name: string;
    /** Their Record Type, read — "" means they have none, never "unknown". */
    recordType: string;
    caseLabel: string;
    matchedOn: "email" | "phone";
    /** The event they are already recorded at, when one was asked about. */
    atEvent: string;
  };
}

export async function checkExistingPerson(args: {
  phone?: string;
  email?: string;
  /** Resolved id of the Record Type contact field, for the role in the sentence. */
  recordTypeFieldId?: string;
  /** Resolved id of Event Attended, so a second event can be named up front. */
  eventFieldId?: string;
}): Promise<ExistingPersonRefusal | null> {
  const phone = (args.phone || "").trim();
  const email = (args.email || "").trim();
  if (!phone && !email) return null;

  const match = await findContactByEmailOrPhone({ phone, email });
  if (!match) return null;

  // 🔴 THE ROLE IS READ, NEVER INFERRED. "no role" has to mean "their Record
  // Type is empty", and 118 of 120 people holding a client case are exactly
  // that — so it is the COMMON branch and it must be a fact. A search response
  // that happens to omit custom fields would make an absence look like a
  // blank, which is why this is the single-record read and not the search row.
  let recordType = "";
  let atEvent = "";
  try {
    const read = await getContactCustomFields(match.id);
    if (args.recordTypeFieldId) {
      const v = read.values[args.recordTypeFieldId];
      recordType = Array.isArray(v) ? v.map(String).join(", ") : String(v ?? "");
    }
    if (args.eventFieldId) atEvent = String(read.values[args.eventFieldId] ?? "").trim();
  } catch {
    recordType = "";
  }

  let caseLabel = "";
  try {
    caseLabel = caseClause(await listContactOpportunities(match.id));
  } catch {
    caseLabel = "";
  }

  return {
    error: existingPersonSentence(match.matchedOn, {
      id: match.id,
      name: match.name,
      recordType,
      caseLabel,
    }),
    // ⚠️ "Nothing was created" IS THE LOAD-BEARING HALF. Every other refusal
    // in this app ends with it, and here it is the difference between a
    // question and a report of something that already happened.
    detail: atEvent
      ? `They are already recorded at another event (${atEvent}). Nothing was created or changed.`
      : "Nothing was created or changed.",
    status: 409,
    refusal: true,
    existing: {
      id: match.id,
      name: match.name,
      recordType,
      caseLabel,
      matchedOn: match.matchedOn,
      atEvent,
    },
  };
}
