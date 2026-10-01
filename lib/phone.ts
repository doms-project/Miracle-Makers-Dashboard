// ---------------------------------------------------------------------------
// PHONE — E.164, one rule, one place.
//
// This lives in lib/ rather than inline in the import route because it is
// already needed in two places and will be needed in more: the import wizard
// normalises a CSV column with it, and the duplicate check matches on it. A
// second copy written later is a second rule that can drift, which is exactly
// what happened to the landing-page forms living outside this repo.
//
// ⚠️ THE RULE IS THE FORMS' RULE, deliberately narrow:
//
//     10 digits              -> +1XXXXXXXXXX
//     11 digits starting 1   -> +XXXXXXXXXXX
//     anything else          -> UNCHANGED, and flagged
//
// The last line is the important one. An international number that does not fit
// this shape may be perfectly correct — a UK mobile, a number with an extension
// — and code must not decide that. It is written exactly as the person typed
// it and put on a list for someone to look at. Never dropped, never guessed.
// ---------------------------------------------------------------------------

export interface PhoneResult {
  /** E.164 when it fit the rule; otherwise the original value, untouched. */
  value: string;
  /** True when the rule did not apply — the caller flags it, never drops it. */
  unnormalised: boolean;
}

export function e164(input: unknown): PhoneResult {
  const raw = String(input ?? "").trim();
  if (!raw) return { value: "", unnormalised: false };

  // Digits only for the shape test. A leading "+" is remembered separately: a
  // value that is ALREADY +1XXXXXXXXXX must come back unchanged rather than
  // being rebuilt, and one that is +44… must not be mistaken for 11 digits
  // starting with 1 after the "+" is thrown away.
  const digits = raw.replace(/\D/g, "");

  if (digits.length === 10) return { value: `+1${digits}`, unnormalised: false };
  if (digits.length === 11 && digits.startsWith("1"))
    return { value: `+${digits}`, unnormalised: false };

  // Everything else: as written, and flagged.
  return { value: raw, unnormalised: true };
}

/**
 * The comparison key for "is this the same phone number".
 *
 * NOT e164() — matching must be looser than writing. "(330) 397-5612",
 * "330-397-5612" and "+1 330 397 5612" are one person, and a duplicate check
 * that missed that would create the second record item 5 exists to prevent.
 * Returns "" for anything too short to be a phone number, so a stray "1" in a
 * cell can never match another stray "1".
 */
export function phoneKey(input: unknown): string {
  const digits = String(input ?? "").replace(/\D/g, "");
  if (digits.length < 10) return "";
  // Trailing 10 digits: "+13303975612" and "3303975612" are the same number,
  // and this holds for any country code without needing to know which it is.
  return digits.slice(-10);
}

/** The comparison key for "is this the same email". */
export function emailKey(input: unknown): string {
  return String(input ?? "").trim().toLowerCase();
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUND 169 — "IS THIS THE SAME NAME?"
//
// 🔴 GOHIGHLEVEL RE-SPLITS A NAME ACROSS firstName AND lastName. Sent
// `{ firstName: "TEST e2e 202610011527", lastName: "renamed" }`, it stored the
// same full name split somewhere else — so a read-back comparing the two halves
// separately found both different and reported a rename that had worked as a
// 502. The panel then reverted a correct name and told the rep to go and fix it
// in GoHighLevel, where they would find it already correct.
//
// ⚠️ THIS IS ROUND 134'S RULE, APPLIED TO THE FIELD IT MISSED. That round wrote
// "the read-back must compare MEANING, not text" into this very comparison —
// and then gave `phoneKey` to the phone, `emailKey` to the email, and left the
// NAME on `!==`. The one field GoHighLevel actually re-normalises.
//
// 🔴 IT LIVES HERE BECAUSE THIS FILE IS ALREADY WHERE "the same person" IS
// DECIDED. `emailKey` is not a phone number either; what these share is being
// the one rule for whether two values mean the same contact, which the file's
// own banner says a second copy would drift from.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A name reduced to what it MEANS: the parts joined, runs of whitespace
 * collapsed, case and surrounding space ignored.
 *
 *   nameKey("Mary Ann", "Smith")   === nameKey("Mary", "Ann Smith")
 *   nameKey("  mary   ann smith ") === nameKey("Mary Ann", "Smith")
 *
 * ═══ 🔴 ROUND 170 — HOW GOHIGHLEVEL ACTUALLY SPLITS, MEASURED ══════════════
 *
 * Round 169 left this unprobed and refused to state a rule. The live run
 * answers it: **GoHighLevel keeps only the FIRST WORD as the first name.**
 *
 *     sent    firstName "TEST Mary Ann"   lastName "Smith"
 *     stored  firstName "TEST"            lastName "Mary Ann Smith"
 *
 * ⚠️ SO A MULTI-WORD FIRST NAME CANNOT BE STORED AS ONE. "Mary Ann" will always
 * come back as "Mary" / "Ann …", and this function is what makes that a
 * non-event: the full name is unchanged, so the rename confirms, and the panel
 * shows the split GoHighLevel chose rather than reverting.
 *
 * ⚠️ AND NOTHING TRIES TO BEAT IT. Sending the name pre-split, or re-sending
 * after reading it back, would be fighting a normalisation that is not ours to
 * change — and round 134's rule is that a read-back compares meaning, not the
 * arrangement.
 *
 * ⚠️ PUNCTUATION IS KEPT, DELIBERATELY. "O'Brien" and "OBrien" are different
 * spellings of a surname and a rename from one to the other is a real change
 * somebody meant — stripping punctuation the way `norm()` does elsewhere would
 * silently confirm a write that did not happen. Only whitespace and case are
 * noise here.
 */
export function nameKey(...parts: unknown[]): string {
  return parts
    .map((p) => String(p ?? ""))
    .join(" ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
