// ---------------------------------------------------------------------------
// THE IMPORT BATCH TAG — one optional free-text tag applied to every CONTACT in
// one import, so a batch can be found again afterwards. Nothing else does that
// today.
//
// 🔴 IT IS NOT THE SOURCE. `source` is its own field, stamped on BOTH the
// contact and the opportunity, and it drives the logo, the "By source" tile and
// the filter. This tag identifies ONE IMPORT. A tag repeating a source value
// invites someone to filter on the wrong one, which is why the four source
// strings are blocked below.
//
// 🔴 THIS MODULE MUST STAY ISOMORPHIC. The wizard validates as you type and the
// route validates again on the way in — a client check is a courtesy, never a
// gate — so both sides must run THE SAME code. That is why this is its own file
// and imports nothing: `lib/ghl.ts` is server-only and cannot be pulled into a
// client component.
// ---------------------------------------------------------------------------

/**
 * GHL tags are lowercase and hyphenated. Every tag this app writes goes through
 * here, so "Batch — Google Ads Aug 2026" and "batch google ads aug 2026" cannot
 * become two different tags on the same account.
 *
 * ⚠️ This is also what makes the deny-list below airtight: "CHC", "chc " and
 * "C.H.C." all collapse to `chc` and are all caught.
 */
export function normalizeTag(s: string): string {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// 🔴 MAINTAINED BY HAND. UPDATE THIS WHENEVER A WORKFLOW CHANGES.
//
// These are the tags that START AN AUTOMATION on this account. Applying one to
// a 200-row import fires that workflow for all 200 — "chc" would route every
// record to Chris.
//
// It is hardcoded because the GoHighLevel API WILL NOT TELL US.
// `GET /workflows/?locationId=` returns only id, name, status, version and
// timestamps — no triggers, no conditions, no actions — and there is no
// per-workflow detail endpoint in the public v2 API. There is no way to read
// which tag fires which workflow, so there is no way to derive this list.
//
// That makes this list the single point of failure: a workflow added with a new
// trigger tag is not blocked until someone adds it here. If GHL ever exposes
// trigger tags, DELETE THIS and read them instead.
// ---------------------------------------------------------------------------
export const AUTOMATION_TAGS = [
  "chc",
  "facebook-ad",
  "private-pay-lp",
  "website-intent-form",
  "disqualified-mm-intent-form",
  "indeed-import",
] as const;

/**
 * The four fixed source values. Blocked for a different reason from the
 * automation tags: nothing breaks, but a tag that repeats the source field
 * makes it ambiguous which one a filter is reading.
 *
 * Kept in normalised form so it lines up with `normalizeTag`; the picker's own
 * vocabulary lives in `components/ImportWizard.tsx` (SOURCE_OPTIONS).
 */
export const SOURCE_TAGS = ["indeed", "facebook", "google-ads", "website"] as const;

export type BatchTagCheck = {
  /** The normalised tag, "" when nothing usable was typed. */
  tag: string;
  /** Why it cannot be used, or null. A blank input is not an error. */
  error: string | null;
};

/**
 * The one gate, run on both sides.
 *
 * ⚠️ A BLANK TAG IS VALID and means no tag is applied. The whole feature is
 * optional; an empty box must never stop an import.
 */
export function checkBatchTag(raw: string): BatchTagCheck {
  const tag = normalizeTag(raw);
  if (!tag) return { tag: "", error: null };

  if ((AUTOMATION_TAGS as readonly string[]).includes(tag))
    return { tag, error: "That tag starts an automation. Choose a different one." };

  if ((SOURCE_TAGS as readonly string[]).includes(tag))
    return {
      tag,
      error:
        "That is a source value, and source is already its own field on every record. Choose a different one.",
    };

  // Not a rule anyone asked for — a guard against a pasted paragraph becoming a
  // tag on 200 people. GHL itself accepts long tags; this is about legibility.
  if (tag.length > 64)
    return { tag, error: "Too long for a tag — keep it under 64 characters." };

  return { tag, error: null };
}
