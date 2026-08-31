// ---------------------------------------------------------------------------
// Phase 2 editing — READ-ONLY BLOCKLIST.
//
// Fields listed here are ALWAYS rendered display-only and are stripped from any
// write body server-side, even if a client tries to send them. Matching is by
// normalized name (case/spacing/punctuation-insensitive), so renames in GHL
// still match as long as the words are the same.
//
// Two categories:
//   1. External identifiers — editing breaks linkage to other systems.
//   2. Automation-critical — editing misfires a GHL automation.
// ---------------------------------------------------------------------------

// v2 correction (Task 4): only fields where editing causes HARM are read-only.
//   - Harmony ID / County ID are now EDITABLE — the state assigns a Harmony ID
//     weeks into enrollment and a rep types it; nobody else can enter it.
//   - Airtable Record ID is EDITABLE (rendered in a collapsed System info
//     section); expected empty on a clean build. Switch to read-only later if a
//     live Airtable sync is ever set up.
export const READ_ONLY_FIELDS: string[] = [
  // Automation-critical — this field TRIGGERS the compliance automation (WF3).
  "APP - Compliance Cleared",
  // Derived by the Move action — must not be hand-edited.
  "Transferred From",
  "Transferred Date",
  // Synced from the caregiver associations.
  "Caregiver Name",
  // ITEM 5c — written ONLY by the reassign flow and cleared ONLY by the claim.
  // Blocklisted as well as hidden: the panel never renders it, but the PATCH
  // route accepts any field id a caller sends, so without this a direct API
  // write could corrupt the list and make a claim strip the wrong follower.
  "Reassign Followers",
];

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

const READ_ONLY_SET = new Set(READ_ONLY_FIELDS.map(norm));

/** True if a field (by name) may be edited. Read-only blocklist wins. */
export function isFieldEditable(fieldName: string | undefined | null): boolean {
  if (!fieldName) return false;
  return !READ_ONLY_SET.has(norm(fieldName));
}
