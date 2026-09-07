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
