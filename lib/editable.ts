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

export const READ_ONLY_FIELDS: string[] = [
  // External identifiers
  "Harmony ID",
  "County ID",
  "Airtable Record ID",
  // Automation-critical — this field TRIGGERS the compliance automation.
  "APP - Compliance Cleared",
];

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

const READ_ONLY_SET = new Set(READ_ONLY_FIELDS.map(norm));

/** True if a field (by name) may be edited. Read-only blocklist wins. */
export function isFieldEditable(fieldName: string | undefined | null): boolean {
  if (!fieldName) return false;
  return !READ_ONLY_SET.has(norm(fieldName));
}
