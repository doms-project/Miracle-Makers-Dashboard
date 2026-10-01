// ═══════════════════════════════════════════════════════════════════════════
// ROUND 168 — "CREATED BY", WITHOUT INVENTING GOHIGHLEVEL'S ENUM.
//
// 🔴 I CANNOT LIST THE VALUES, AND I AM NOT GOING TO GUESS THEM.
// `internalSource` appears nowhere else in this repository — not in
// `RawOpportunity`, not in any mapper, not in any fixture — and there are no
// live credentials in the build environment. The ONE value in evidence is from
// the owner's own probe on William Yost (yNdWocl4xWXtIwwU5Nsr):
//
//     internalSource { type: "CREATED", source: "WORKFLOW_NEW", id: "cb82ab6e-…" }
//
// Writing a map of GoHighLevel's source constants from memory would be rule 7
// exactly — "a name is a guess until it is read from the code that consumes
// it" — and a guessed map is worse than no map, because it looks authoritative
// while mislabelling real records. A record created by an import reading
// "Workflow" is a confident lie on a screen somebody is using to decide who to
// ask about a case.
//
// ✅ SO THE KNOWN VALUE IS EXACT AND EVERYTHING ELSE IS MECHANICAL. An
// unrecognised value is made readable FROM ITS OWN TEXT — `PUBLIC_API` becomes
// "Public API" — which is correct for any value GoHighLevel sends, claims to
// know nothing it does not, and reads as a label rather than as a bug. The day
// somebody sends real values, each gets an exact entry in one line, and the
// fallback goes on covering the rest.
//
// ⚠️ ABSENT IS NOT UNKNOWN. No `internalSource` at all means "" and the panel
// renders nothing — never "Unknown", which is a claim, and never a guess from
// the record's age or owner.
// ═══════════════════════════════════════════════════════════════════════════

export interface CreatedBySource {
  sourceType: string;
  sourceValue: string;
  sourceUserId: string;
  /**
   * `internalSource.id`. ⚠️ MEANS SOMETHING DIFFERENT PER SOURCE — a workflow
   * uuid, a possible user id, an app id — so it is read only where the SOURCE
   * says it may be a person. See `createdByLabel`.
   */
  sourceId?: string;
}

/**
 * Exact labels for values actually observed on this account.
 *
 * ⚠️ ONE ENTRY, AND THE LIST IS HONEST ABOUT BEING ONE ENTRY LONG. Keyed on the
 * raw `source` string, compared case-insensitively with separators stripped so
 * `WORKFLOW_NEW`, `workflow-new` and `WorkflowNew` all land here.
 */
const KNOWN: Record<string, string> = {
  // ═══ ROUND 169 — READ LIVE FROM ALL 1,474 CASES, EVERY PIPELINE ═══════════
  //
  // 🔴 ROUND 168 HAD ONE SAMPLE AND SAID SO. It refused to write GoHighLevel's
  // enum from memory and fell back to making an unknown value readable from its
  // own text — which, by luck of their spelling, already rendered the other two
  // of these correctly. These three are now EXACT rather than mechanical, which
  // is a different and stronger claim: the fallback cannot be checked against
  // anything, and these have been counted.
  //
  //     WORKFLOW_NEW  1091   channel ISTIO_MESH
  //     BULK_ACTION    355   channel ISTIO_MESH
  //     INTEGRATION     28   channel OAUTH
  //
  // ⚠️ EVERY CASE HAS ONE, so the absent-internalSource branch below is for a
  // record this account has never produced — kept because "shows nothing" is
  // the only honest answer if one ever appears, not because it fires today.
  workflownew: "Workflow",
  bulkaction: "Bulk action",
  integration: "Integration",
};

// ═══ ROUND 169b — `internalSource.id` IS NEVER A PERSON, FOR ANY SOURCE ═════
//
// 🔴 THE FULL SCAN KILLED THE LOOKUP THIS FUNCTION BRIEFLY HAD. 1,474 cases
// across every pipeline, every one carrying an internalSource, and only three
// values exist on the account:
//
//     1091  WORKFLOW_NEW  channel ISTIO_MESH  id = one of 5 workflow UUIDs
//      355  BULK_ACTION   channel ISTIO_MESH  id = one of 5 batch ids, 20 chars
//       28  INTEGRATION   channel OAUTH       id = one of 2 app ids, 24 hex
//
// All five bulk-action ids were checked against the user list. NONE is a user.
// They identify IMPORT BATCHES — and they are 20 characters, which is exactly
// what a GoHighLevel user id looks like.
//
// 🔴 SO THE 20-CHARACTER SHAPE WAS THE WHOLE EVIDENCE, AND IT WAS WRONG. Round
// 169 said "the gate is the SOURCE, never the shape of the id" and was right
// about which SOURCE may be read — while the lookup itself still assumed that
// an id which RESOLVES to a user IS that user. Same mistake one level up: a
// 20-character string that matches a user proves a collision, not an author.
//
// ⚠️ AND THE COLLISION IS THE REAL HAZARD, not the missing name. Five batch ids
// against twenty-six users today; the day one matches, 355 records credit an
// import to a colleague who had nothing to do with it — a confident lie on the
// screen somebody uses to decide who to ask about a case. The proof asserts
// exactly that case.
//
// ⚠️ `sourceUserId` IS UNAFFECTED AND STAYS. That is an explicit `userId` key,
// which is GoHighLevel asserting a person rather than us inferring one; none of
// these three sources carries it, and the hand-created path still needs it.

const key = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Turn a GoHighLevel constant into something a person can read, using nothing
 * but the string itself.
 *
 *   PUBLIC_API        -> "Public API"
 *   FORM_SUBMISSION   -> "Form submission"
 *   BULK_ACTIONS      -> "Bulk actions"
 *
 * ⚠️ IT GUESSES NOTHING ABOUT MEANING. Every word comes from the value; only
 * the shape changes. "API" and a few other initialisms stay upper-case because
 * title-casing them produces something that reads as a typo.
 */
const INITIALISMS = new Set(["api", "crm", "sms", "url", "id", "csv", "ui"]);

export function humaniseSource(raw: string): string {
  const words = (raw || "")
    .split(/[^A-Za-z0-9]+/)
    .flatMap((w) => w.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "))
    .filter(Boolean);
  if (!words.length) return "";
  return words
    .map((w, i) => {
      const low = w.toLowerCase();
      if (INITIALISMS.has(low)) return low.toUpperCase();
      // Sentence case: only the first word is capitalised, so "Form submission"
      // rather than "Form Submission" — the house style everywhere else.
      return i === 0 ? low.charAt(0).toUpperCase() + low.slice(1) : low;
    })
    .join(" ");
}

/**
 * What created this record, the way GoHighLevel shows it.
 *
 * `nameOf` resolves a GHL user id to a name — passed in rather than imported so
 * this module stays pure and provable with a literal.
 *
 * 🔴 A PERSON WINS OVER A CONSTANT. When the source carries a `userId`, a human
 * made the record by hand and their name is the answer; the constant beside it
 * describes the screen they used, which nobody asked for.
 *
 * ⚠️ AND A uuid IS NOT A PERSON. The one sample's `internalSource.id` is a uuid
 * on a WORKFLOW_NEW source, so it names the WORKFLOW — reading `id` as a user
 * would credit a workflow to whichever user happened to match. Only an explicit
 * `userId` is read as one.
 */
export function createdByLabel(
  src: CreatedBySource,
  nameOf: (userId: string) => string,
): string {
  if (!src || (!src.sourceValue && !src.sourceUserId && !src.sourceType)) return "";

  if (src.sourceUserId) {
    const who = nameOf(src.sourceUserId);
    // ⚠️ AN ID THAT NO LONGER RESOLVES IS SAID, NOT DROPPED. The record was
    // still created by a person; "Former user" is the wording every other
    // screen in this app uses for a departed one.
    return who || "Former user";
  }

  const k = key(src.sourceValue);

  // 🔴 NO LOOKUP ON `internalSource.id`, FOR ANY SOURCE — see the banner above.
  // `sourceId` is still carried, because knowing WHICH workflow or WHICH batch
  // is a real question somebody may want answered later; what it must never do
  // is become a person's name.
  if (KNOWN[k]) return KNOWN[k];
  // ⚠️ ANY VALUE MENTIONING A WORKFLOW IS A WORKFLOW. GoHighLevel has more than
  // one workflow source constant on other accounts; this is a shape match on
  // the one word that cannot mean anything else, not a guess at a full name.
  if (k.includes("workflow")) return "Workflow";

  const human = humaniseSource(src.sourceValue);
  if (human) return human;
  // 🔴 A TYPE WITH NO SOURCE — the last thing worth saying before nothing. The
  // sample's type is "CREATED", which alone says only that the record was made,
  // so it is used only when there is no source at all.
  return humaniseSource(src.sourceType);
}
