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
  // The CAREGIVER equivalent, and a workflow trigger for the same reason: it
  // must be set by the compliance workflow once every check clears, never by a
  // recruiter ticking a box. Blocklisted by NAME now, ahead of contact fields
  // rendering in the panel (that work is item 2), so it cannot arrive editable
  // by default the day they do. A different field from "APP - Compliance
  // Cleared" above — same job, caregiver side.
  "CG - Compliance Cleared",
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
  // 🔴 TASK 1 — SYSTEM-OWNED. Written ONLY by `applyCaseManagers`, from the
  // case-manager map on the Access tab, and rewritten from that map on every
  // apply. There is no human value to preserve.
  //
  // ⚠️ IT IS BLOCKLISTED RATHER THAN HIDDEN, unlike "Reassign Followers".
  // Reading it is the point — "who is watching this case" is exactly what a rep
  // opening the panel wants to know. Only typing into it stops.
  //
  // 🔴 AND WITHOUT THIS THE PICKER WOULD HAVE ARGUED WITH THE MAPPING. A rep
  // could pick a name, and the next owner change would overwrite it silently —
  // the two-mechanisms failure this project has hit four times, arriving
  // through a control nobody thought of as a mechanism.
  "Case Manager",
  // ⚠️ THE APPLY FUNCTION'S OWN RECORD of which followers it added, so its
  // removal can be surgical. Same reasoning as "Reassign Followers" above and
  // deliberately a SEPARATE field: the reassign claim CLEARS that one wholesale,
  // so a shared field would have each mechanism wiping the other's list.
  //
  // 🔴 ROUND 157 — IT IS NOW HIDDEN AS WELL AS BLOCKLISTED, WHICH REVERSES THE
  // PARAGRAPH THAT USED TO SIT HERE. That paragraph said it was "BLOCKLISTED
  // RATHER THAN HIDDEN, unlike Reassign Followers — reading it is the point",
  // and it was wrong about the reading being useful: "Case Manager" answers the
  // same question in names, the Followers control answers it from the live
  // list, and `[casemgr]`'s steps beat the raw ids for anyone debugging a
  // removal. The reasoning lives at HIDDEN_NAMES in lib/fieldFolders.ts.
  //
  // ⚠️ IT STAYS IN THIS LIST TOO, AND THAT IS NOT REDUNDANT. Hidden stops the
  // panel rendering it; blocklisted stops the PATCH route accepting a write to
  // it, and that route takes any field id a caller sends. "Reassign Followers"
  // is in both lists for exactly this reason.
  "Case Manager Followers",
  // 🔴 ROUND 163 — THE STAGE LOG. Machine-written, append-only, and the input
  // to Jack's "two stages a month" KPI. A rep typing into it corrupts a metric
  // nobody would think to re-check, and the PATCH route accepts any field id a
  // caller sends — so blocklisted here as well as hidden in fieldFolders.ts,
  // for the same two reasons "Reassign Followers" is in both lists.
  "Stage History",
];

// ═══ ROUND 151 — FIELDS WHOSE STORED VALUE IS A LIST OF USER IDS ═══════════
//
// 🔴 THE STORED VALUE STAYS IDS. That is deliberate and it is the whole point
// of "Case Manager Followers": it is the machine-readable record rule B reads
// when deciding whom it may remove, and names would be ambiguous the first time
// two people shared one. Only the RENDERING changes.
//
// It was rendering as `V0gYK3HpF1Tan7Uv0Jcp,WiFUXs6SShLwFB0Z5enR` on the record
// panel, to whoever opened the case. "Case Manager" beside it looked right for
// a reason that is worth knowing: it is not resolved at render time either —
// `applyCaseManagers` writes NAMES into that one. There was no id-resolving
// render path anywhere, so this is new behaviour rather than a wiring-up.
//
// ⚠️ MATCHED BY NAME, like READ_ONLY_FIELDS and HIDDEN_NAMES above, and NOT by
// guessing at the shape of the value. A twenty-character alphanumeric string is
// not reliably an id, and "looks like an id" would eventually mangle somebody's
// real data.
//
// "Reassign Followers" is hidden entirely (lib/fieldFolders.ts) so it never
// reaches a renderer — listed anyway, because the day it stops being hidden is
// not the day anyone will remember this.
//
// ═══ ROUND 157 — DORMANT AS OF THIS ROUND, AND ONLY AS OF THIS ROUND ════════
//
// 🔴 SAID OUT LOUD RATHER THAN LEFT TO BE DISCOVERED. "Case Manager Followers"
// joined HIDDEN_NAMES in round 157, and it was the only one of these two that
// ever reached `renderField`. Nothing on the panel calls `asUserNames` today.
//
// ⚠️ IT WAS LIVE UNTIL ROUND 157 AND THE WORDING MATTERS. On v155 in production
// the panel rendered that field as "Mahagony Stewart - Case Manager, Lamarr
// Wesley -Sale" — resolved names, from this code, doing its job. This is a
// consequence of hiding the field, NOT a discovery that the resolver never had
// a consumer. Anyone reading "no consumer" as "always dead" and deleting it
// would be removing working code on a misreading.
//
// ⚠️ AND ONE CORRECTION WORTH HAVING IN WRITING, because the instruction that
// hid the field described this as "the name resolution for Case Manager".
// It is not, and never was. "Case Manager" renders people's names because
// `applyCaseManagers` WRITES names into it — there is no resolution on that
// path and removing this code would not touch it. What this resolves is a
// comma-separated list of raw USER IDS, which only these two fields hold.
//
// 🔴 KEPT ANYWAY, DELIBERATELY. It is the correct rendering for the day either
// field is unhidden or a third id-list field appears, and round 151 exists
// because a field holding ids was rendered raw to whoever opened the case. The
// cost of keeping it is a few lines; the cost of deleting it is that the next
// id-list field gets `asStr` again. ⚠️ But it is dormant, not load-bearing,
// and a proof that claimed to exercise it would be testing nothing.
const USER_ID_LIST_FIELDS = ["Case Manager Followers", "Reassign Followers"];

const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

const USER_ID_LIST_SET = new Set(USER_ID_LIST_FIELDS.map(norm));

/** True if a field's stored value is a comma-separated list of user ids. */
export function isUserIdListField(fieldName: string | undefined | null): boolean {
  if (!fieldName) return false;
  return USER_ID_LIST_SET.has(norm(fieldName));
}

const READ_ONLY_SET = new Set(READ_ONLY_FIELDS.map(norm));

/** True if a field (by name) may be edited. Read-only blocklist wins. */
export function isFieldEditable(fieldName: string | undefined | null): boolean {
  if (!fieldName) return false;
  return !READ_ONLY_SET.has(norm(fieldName));
}
