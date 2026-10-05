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
  lookupDuplicateContact,
  createContact,
  GhlError,
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
    /**
     * ⚠️ ROUND 173 — HOW THE MATCH WAS IDENTIFIED: the create's own refusal,
     * GoHighLevel's duplicate lookup, or the (lagging) search index. Carried
     * because when the live window reopens, this names which link held.
     */
    via?: "refusal" | "lookup" | "search";
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


// ═══════════════════════════════════════════════════════════════════════════
// ROUND 173 · ITEM 1 — THE DECISION AND THE WRITE NOW SHARE ONE SOURCE.
//
// 🔴 THE DEFECT, OBSERVED LIVE ON v172. A caregiver was created through Add
// Applicant; seven seconds later Add person met → New person was given the
// same phone. It returned 200, not the 409, and the caregiver's Record Type
// became "Event Attendee". The same check PASSED on an earlier run with a
// twelve-second gap.
//
// ⚠️ SO ROUND 171'S FIX WAS RIGHT AND ITS FOUNDATION WAS WRONG. The check read
// `/contacts/search` — an index that lags a new contact by up to a minute —
// while the write went through `/contacts/upsert`, which matches on phone
// instantly. Two sources of truth about one question, and the faster one did
// the damage. A check cannot guard a write it does not share a view with.
//
// ✅ SO "NEW PERSON" NEVER UPSERTS. It calls `POST /contacts/` — a plain
// create, which has no merge behaviour at all — and GoHighLevel's own
// duplicate refusal IS the answer. That answer is instant by construction:
// it comes from the same store the write would have hit.
//
// 🔴 AND THE WORST CASE IS NOW A REFUSAL RATHER THAN A SILENT MERGE. If the
// colliding contact cannot be identified, the 409 still fires and nothing is
// written; the message simply cannot name them. Round 171's version, failing
// the same way, renamed a stranger.
//
// Two family members added thirty seconds apart on one phone — the owner's
// real case — now stops on the second.
// ═══════════════════════════════════════════════════════════════════════════

/** GoHighLevel's wording for the rule, and the code some shapes carry. */
const DUPLICATE_RULE = /duplicated\s+contacts|DUPLICATED_CONTACT|duplicate\s+contact/i;

export function isDuplicateRefusal(e: unknown): boolean {
  if (!(e instanceof GhlError)) return false;
  return DUPLICATE_RULE.test(`${e.code || ""} ${e.message} ${e.detail || ""}`);
}

export type CreatePersonResult =
  | { ok: true; id: string }
  | { ok: false; conflict: ExistingPersonRefusal };

/**
 * Create a person, or refuse because somebody already has that key.
 *
 * ⚠️ THE ORDER OF THE THREE WAYS TO IDENTIFY THE MATCH IS THE WHOLE DESIGN,
 * fastest-and-most-certain first:
 *
 *   1. the refusal body itself   — instant and authoritative when GoHighLevel
 *                                  names the contact. UNPROVEN on this account;
 *                                  scripts/duplicate-refusal-probe.mjs settles it.
 *   2. the duplicate lookup      — GoHighLevel's own instant matcher. Also
 *                                  unproven here, hence second rather than first.
 *   3. the search index          — PROVEN, and known to lag by up to a minute.
 *                                  Last, because it is the one that failed.
 *
 * 🔴 NONE OF THEM CAN TURN THE REFUSAL INTO A WRITE. They only decide how much
 * the message can say. That is the inversion from round 171, where failing to
 * identify the match meant going ahead and overwriting them.
 */
export async function createPersonOrConflict(
  fields: Parameters<typeof createContact>[0] & { phone?: string; email?: string },
): Promise<CreatePersonResult> {
  try {
    const made = await createContact(fields);
    return { ok: true, id: made.id };
  } catch (e) {
    if (!isDuplicateRefusal(e)) throw e;

    const phone = (fields.phone || "").trim();
    const email = (fields.email || "").trim();
    const err = e instanceof GhlError ? e : null;
    let id = err?.dupContactId || "";
    // ✅ ROUND 174 — THE NAME COMES OFF THE REFUSAL TOO, so the common path
    // needs no extra read at all.
    let name = err?.dupName || "";
    let via: "refusal" | "lookup" | "search" | "none" = id ? "refusal" : "none";
    // ✅ WHICH DETAIL COLLIDED, FROM GOHIGHLEVEL. `meta.matchingField` is
    // "phone" on the live probe; the fallback is only for a tenant that sends
    // nothing, and it is a last resort rather than the rule.
    const field = (err?.dupField || "").toLowerCase();
    const matchedOn: "phone" | "email" = field.includes("email")
      ? "email"
      : field.includes("phone")
        ? "phone"
        : phone
          ? "phone"
          : "email";

    if (!id) {
      const dup = await lookupDuplicateContact({ phone, email });
      if (dup) {
        id = dup.id;
        name = dup.name;
        via = "lookup";
      }
    }
    if (!id) {
      const hit = await findContactByEmailOrPhone({ phone, email }).catch(() => null);
      if (hit) {
        id = hit.id;
        name = hit.name;
        via = "search";
      }
    }

    if (!id)
      return {
        ok: false,
        conflict: {
          // ⚠️ IT SAYS WHAT IT KNOWS AND NOT MORE. GoHighLevel refused the
          // create because the key is taken; we could not find out whose. That
          // is still a complete answer to "may I create this person" — no.
          error:
            `${matchedOn === "phone" ? "That phone number" : "That email address"} already ` +
            "belongs to somebody in GoHighLevel. Nothing was created.",
          detail:
            "GoHighLevel refused the new contact because the " +
            `${matchedOn === "phone" ? "number" : "address"} is already in use, and the ` +
            "matching person could not be looked up — a contact created in the last " +
            "minute is not searchable yet. Search for them in GoHighLevel and add the " +
            "event, referral or application to that record.",
          status: 409,
          refusal: true,
          existing: {
            id: "",
            name: "",
            recordType: "",
            caseLabel: "",
            matchedOn,
            atEvent: "",
          },
        },
      };

    // The full sentence, through the same composer every other path uses.
    const full = await describeExisting({ id, name, matchedOn });
    return {
      ok: false,
      conflict: {
        ...full,
        existing: { ...full.existing, via: via === "none" ? undefined : via },
      },
    };
  }
}

/** The 409 for a contact we have an id for. Shared with `checkExistingPerson`. */
async function describeExisting(m: {
  id: string;
  name: string;
  matchedOn: "phone" | "email";
}): Promise<ExistingPersonRefusal> {
  let recordType = "";
  let name = m.name;
  try {
    const read = await getContactCustomFields(m.id);
    // ⚠️ The read carries the name too, and it is better than the lookup's:
    // one of the three identification routes gives no name at all.
    if (!name) name = `${read.firstName} ${read.lastName}`.trim();
    const defs = await import("@/lib/ghl").then((g) => g.getEditableFieldDefs("contact"));
    const rt = defs.find(
      (d) => d.name.toLowerCase().replace(/[^a-z0-9]/g, "") === "recordtype",
    );
    if (rt) {
      const v = read.values[rt.id];
      recordType = Array.isArray(v) ? v.map(String).join(", ") : String(v ?? "");
    }
  } catch {
    recordType = "";
  }
  let caseLabel = "";
  try {
    caseLabel = caseClause(await listContactOpportunities(m.id));
  } catch {
    caseLabel = "";
  }
  return {
    error: existingPersonSentence(m.matchedOn, {
      id: m.id,
      name,
      recordType,
      caseLabel,
    }),
    detail: "Nothing was created or changed.",
    status: 409,
    refusal: true,
    existing: {
      id: m.id,
      name,
      recordType,
      caseLabel,
      matchedOn: m.matchedOn,
      atEvent: "",
    },
  };
}
