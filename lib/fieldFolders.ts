import type { EditableFieldDef } from "./types";

// Task 4 — folder-driven field sets.
//
// Every opportunity custom field carries a `parentId` (its GHL custom-field
// FOLDER). The record panel renders sections from the folders mapped to the
// record's pipeline — replacing the old hardcoded, name-based five sections.
// Adding/moving a field in GHL changes the panel with no code change.

// Folder id ↔ semantic key (ids from the account build log).
export const FOLDERS = {
  webIntake: "q9YrpYwe9T0mQyRIJOr9", // 4
  shared: "B6cunntgpATjWseEb1iC", // 6
  client: "KKiWnjidBN65xGhJESgc", // 8
  enrollment: "Jh2YEtaeoFYkx0o1YC2M", // 8
  flags: "16CS34KrKsL8MCQHrbMG", // 3
  milestones: "qsILANZN39yUarsgINk6", // 10
  transfer: "7qJlA2QBcha929nsphFk", // 3
  odp: "TIMuXWr8CgAVJhnBJtTj", // 3
  lostReason: "EpVxmToo9FWx2Vsf9iLA", // 6
  ppIntake: "P01rOtXIQddconuzrunx", // 6
  adAttrib: "YwoE8EaNqcnd76TwMvkw", // 7
  fbForm: "CVwUcXV27zGPUvRDOfBh", // 4
} as const;

type FolderKey = keyof typeof FOLDERS;

// Section header shown for each folder.
export const FOLDER_LABELS: Record<FolderKey, string> = {
  webIntake: "Web Intake",
  shared: "Shared",
  client: "Client",
  enrollment: "Enrollment",
  flags: "Flags",
  milestones: "Milestones",
  transfer: "Transfer",
  odp: "ODP",
  lostReason: "Lost Reason",
  ppIntake: "Private Pay Intake",
  adAttrib: "Ad Attribution",
  fbForm: "Facebook Form",
};

// Which folders render for which pipeline (order = section order).
const F = FOLDERS;
export const PIPELINE_FOLDERS: Record<string, string[]> = {
  // OLTL Enrollment
  KGjdCMG4F8xILk0ineB9: [
    F.webIntake, F.shared, F.client, F.enrollment, F.flags, F.milestones, F.transfer, F.lostReason,
  ],
  // OLTL Transfer
  "74Pt3XX4hgBIqD10mW4G": [
    F.webIntake, F.shared, F.client, F.enrollment, F.flags, F.transfer, F.lostReason,
  ],
  // ODP Enrollment
  a14NtTi18ACxs99bHPmL: [
    F.webIntake, F.shared, F.client, F.enrollment, F.flags, F.odp, F.transfer, F.lostReason,
  ],
  // ODP Transfer
  PIs1iWVk0HqHZFNtmoTn: [
    F.webIntake, F.shared, F.client, F.enrollment, F.flags, F.odp, F.transfer, F.lostReason,
  ],
  // Private Pay Clients
  BJBWdRim6SOgjoMelVSZ: [
    F.webIntake, F.shared, F.client, F.ppIntake, F.adAttrib, F.fbForm, F.transfer, F.lostReason,
  ],

  // ── CAREGIVER / DSP APPLICANT PIPELINES ────────────────────────────────
  // 🔴 Deliberately ONE folder. These were absent from this map entirely, so
  // they took the fall-through below and rendered ALL TWELVE folders — more
  // than any client pipeline. An applicant was shown Harmony ID, Client SSN,
  // Client Address, all ten IEB/AAA/MCO milestones, Insurance Type, Road
  // Blocker, Case Manager, Ad Attribution and the Facebook Form block. None of
  // it describes a job applicant.
  //
  // ⚠️ `transfer` is NOT here, on purpose. An applicant does not move between
  // PP Caregiver Applicants and ODP DSP Applicant: those are different jobs
  // with different training, not two stages of one process — applying for both
  // is two applications. And the Transfer folder's fields (Transferred
  // From/Date, Transfer Reason) are stamped by the client Move flow, which a
  // caregiver pipeline is not a destination for.
  //
  // ⚠️ `webIntake` and `shared` are left out for now rather than guessed at.
  // Adding one folder later is trivial; rendering twelve in the meantime is
  // the bug being fixed here.
  //
  // Almost everything a recruiter needs is a CONTACT field, not an opportunity
  // one, and lives in the Caregiver Application / Compliance / Availability
  // folders rendered by the contact-field path.
  EXVMveGzgDy9qf4wQR2H: [F.lostReason], // PP Caregiver Applicants
  "232bytrK7FWNAwC6shME": [F.lostReason], // ODP DSP Applicant
};

// Option B — the Lost Reasons folder holds six fields (one per pipeline +
// Caregiver Rejection). A lost-reason field renders ONLY on its pipeline.
// ⚠️ ONE FIELD MAY SERVE SEVERAL PIPELINES, hence string[] rather than string.
// Caregiver Rejection Reason covers BOTH applicant pipelines: its options
// (failed screening / no-show / withdrew / not hired) apply equally to a PP
// caregiver and an ODP DSP applicant, and a second field would mean two places
// recording the same fact. Every client field still names exactly one pipeline.
export const LOST_REASON_OVERRIDES: Record<string, string[]> = {
  mf2biwVVXPgJv02laVs2: ["KGjdCMG4F8xILk0ineB9"], // OLTL Enrollment Lost Reason
  "69Xa84NK1bCjWZRPDFhE": ["74Pt3XX4hgBIqD10mW4G"], // OLTL Transfer Lost Reason
  "0lBuWb1a20jI5bwHuLjr": ["a14NtTi18ACxs99bHPmL"], // ODP Enrollment Lost Reason
  nd271LsbIi4u2eZMXOCh: ["PIs1iWVk0HqHZFNtmoTn"], // ODP Transfer Lost Reason
  dgP14Vpa1iqybLSnNPs1: ["BJBWdRim6SOgjoMelVSZ"], // Private Pay Lost Reason
  // Caregiver Rejection Reason — BOTH applicant pipelines.
  AiuRVUF6UPcnLbZnHC7w: ["EXVMveGzgDy9qf4wQR2H", "232bytrK7FWNAwC6shME"],
};

// Fields that always live in the collapsed System info section, regardless of
// their folder (external ids / derived / automation). Matched by normalized name.
// ITEM 1 — fields deliberately NOT rendered in the panel. "Transfer Reason"
// duplicates the Move note, and the note is strictly better: it carries author
// + timestamp, and it is per-transfer, whereas the field is overwritten by the
// next move. The field still exists in GHL; it just isn't shown.
// ITEM 5c — "Reassign Followers" holds the raw user ids THIS dashboard added as
// followers during a reassign, so a claim can remove exactly those. It is
// bookkeeping, not information: to a rep it is a string of meaningless ids that
// reads as a fault. Hidden ENTIRELY — not in System info either — while staying
// visible in native GoHighLevel for debugging.
const HIDDEN_NAMES = ["Transfer Reason", "Reassign Followers"];
const HIDDEN_SET = new Set(HIDDEN_NAMES.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "")));

const SYSTEM_INFO_NAMES = [
  "Airtable Record ID",
  "APP - Compliance Cleared",
  "Transferred From",
  "Transferred Date",
];

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const SYSTEM_INFO_SET = new Set(SYSTEM_INFO_NAMES.map(norm));

// Reverse: folder id -> semantic key.
const KEY_BY_ID = new Map<string, FolderKey>(
  (Object.keys(FOLDERS) as FolderKey[]).map((k) => [FOLDERS[k], k]),
);

export interface FieldGroup {
  key: string;
  label: string;
  fields: EditableFieldDef[];
}

// GHL authors a display order per folder via `position` (spaced in 50s so new
// fields can be slotted between existing ones — we never renumber, only read).
// The opportunity/custom-field APIs return fields in an arbitrary order, so
// without this "Client First Name" (position 50) can land seventh and
// Milestones can lead with MCO instead of IEB. Ties and missing positions fall
// back to a name sort so the order is at least stable.
function byPosition(a: EditableFieldDef, b: EditableFieldDef): number {
  const pa = Number.isFinite(a.position) ? a.position : Number.MAX_SAFE_INTEGER;
  const pb = Number.isFinite(b.position) ? b.position : Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return (a.name || "").localeCompare(b.name || "");
}

// Group a record's fields for its pipeline:
//   sections  — folder sections (in PIPELINE_FOLDERS order) with ≥1 field
//   systemInfo — the collapsed read-only-ish block
//   orphans   — fields with no/unknown folder (collapsed "Other", never hidden)
export function groupFieldsForPipeline(
  defs: EditableFieldDef[],
  pipelineId: string,
): { sections: FieldGroup[]; systemInfo: EditableFieldDef[]; orphans: EditableFieldDef[] } {
  // 🔴 PRESENCE, NOT NON-EMPTY. This read `PIPELINE_FOLDERS[pipelineId]?.length`,
  // which is FALSY FOR AN EMPTY ARRAY — so a pipeline deliberately mapped to
  // few-or-no folders fell through to "show everything", the exact opposite of
  // what the mapping says. It never bit while every mapping was long; it would
  // have bitten immediately on the caregiver pipelines above.
  const allowed = Object.prototype.hasOwnProperty.call(
    PIPELINE_FOLDERS,
    pipelineId,
  )
    ? PIPELINE_FOLDERS[pipelineId]
    : Object.values(FOLDERS); // genuinely UNMAPPED pipeline → show all folders
  const allowedKeys = new Set(
    allowed.map((id) => KEY_BY_ID.get(id)).filter(Boolean) as FolderKey[],
  );

  const buckets = new Map<FolderKey, EditableFieldDef[]>();
  const systemInfo: EditableFieldDef[] = [];
  const orphans: EditableFieldDef[] = [];

  for (const def of defs) {
    if (HIDDEN_SET.has(norm(def.name))) continue; // ITEM 1
    if (SYSTEM_INFO_SET.has(norm(def.name))) {
      systemInfo.push(def);
      continue;
    }
    const key = def.parentId ? KEY_BY_ID.get(def.parentId) : undefined;
    if (!key) {
      orphans.push(def);
      continue;
    }
    if (key === "lostReason") {
      // Option B: only the lost-reason field mapped to THIS pipeline renders.
      if (!LOST_REASON_OVERRIDES[def.id]?.includes(pipelineId)) continue;
    }
    if (!allowedKeys.has(key)) continue; // folder not mapped to this pipeline
    const arr = buckets.get(key) || [];
    arr.push(def);
    buckets.set(key, arr);
  }

  // Emit sections in the pipeline's configured folder order, each field list in
  // GHL's authored `position` order.
  const sections: FieldGroup[] = [];
  for (const folderId of allowed) {
    const key = KEY_BY_ID.get(folderId);
    if (!key) continue;
    const fields = buckets.get(key);
    if (fields && fields.length) {
      sections.push({
        key,
        label: FOLDER_LABELS[key],
        fields: [...fields].sort(byPosition),
      });
    }
  }

  return {
    sections,
    systemInfo: [...systemInfo].sort(byPosition),
    orphans: [...orphans].sort(byPosition),
  };
}

// ═════════════════════════════════════════════════════════════════════════
// ITEM 3 — CONTACT-SIDE FOLDERS.
//
// Model-aware, NOT caregiver-special: Client Care Needs is contact-side too, so
// it sits in the same table and the client panel gets it from the same code.
//
// ⚠️ FOLDER MATCHING IS BY NAME FIRST, id second. The name is the stable thing
// a person edits in GoHighLevel and the thing the brief specifies; the id is
// recorded because a def only carries `parentId`, and GHL does not reliably
// return a folder NAME on a custom-field definition. So: if the API gives us a
// folder name we match on it, and otherwise we fall back to the known id. If a
// folder is ever recreated in GHL its id changes and its name does not — the
// name path is the one that survives that, which is why it is tried first.
// ═════════════════════════════════════════════════════════════════════════
export interface ContactFolder {
  /** The GoHighLevel folder name. THE identifier — matched first. */
  name: string;
  /** Known id, for the fallback match only. */
  id: string;
  /** Section heading in the panel. */
  label: string;
  /** Which record kind shows this section. */
  appliesTo: "caregiver" | "client";
}

export const CONTACT_FOLDERS: ContactFolder[] = [
  { name: "Caregiver Application",  id: "EeU1n8FZZ4WziJwsgwpX", label: "Caregiver Application",  appliesTo: "caregiver" },
  { name: "Caregiver Compliance",   id: "H718HDV7Zaj1QNq6teQC", label: "Caregiver Compliance",   appliesTo: "caregiver" },
  { name: "Caregiver Availability", id: "whcRgJb0Mcfv6uruGAD9", label: "Caregiver Availability", appliesTo: "caregiver" },
  // ⬜ Client Care Needs (25) — contact-side, and the reason this is a table
  // rather than a caregiver branch. Add its name/id here and the CLIENT panel
  // renders it with no further code.
];

/**
 * Group contact custom-field definitions into panel sections for a record kind.
 *
 * Anything whose folder is not in CONTACT_FOLDERS is dropped, NOT shown as an
 * "Other" bucket — the opposite of the opportunity path, deliberately: a
 * location's contact fields include every unrelated form field on the account,
 * and an orphan bucket there would be a wall of noise.
 */
export function groupContactFields(
  defs: EditableFieldDef[],
  kind: "caregiver" | "client",
): FieldGroup[] {
  const folders = CONTACT_FOLDERS.filter((f) => f.appliesTo === kind);
  const byFolder = new Map<string, EditableFieldDef[]>();
  for (const def of defs) {
    if (HIDDEN_SET.has(norm(def.name))) continue;
    const folderName = (def.parentName || "").trim();
    const match = folders.find((f) =>
      folderName ? norm(f.name) === norm(folderName) : f.id === def.parentId,
    );
    if (!match) continue;
    const arr = byFolder.get(match.name) || [];
    arr.push(def);
    byFolder.set(match.name, arr);
  }
  const out: FieldGroup[] = [];
  for (const f of folders) {
    const fields = byFolder.get(f.name);
    if (fields && fields.length)
      out.push({ key: `contact:${f.name}`, label: f.label, fields: [...fields].sort(byPosition) });
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════
// ITEM 2 — DISPLAY LABEL ONLY. NEVER A KEY.
//
// GoHighLevel field names carry an organisational prefix — "CG - Work State",
// and "CL - …" once the client contact folder is built. It groups the fields in
// GHL's own field list and means nothing to a recruiter looking at a record.
//
// 🔴 THE STORED NAME IS UNCHANGED. Field resolution in this codebase is BY NAME
// everywhere — the read-only blocklist (`isFieldEditable`), the system-info set,
// the hidden set, the Transferred From lookup, the folder matcher. Stripping the
// prefix anywhere a name is used as a KEY breaks resolution silently, which is
// the failure mode that has bitten this project repeatedly. So this function is
// called at exactly one place: rendering a <label>. Not the lookup, not the save
// payload, not the folder map.
//
// Written as a GENERAL prefix strip rather than a "CG - " special case, so
// "CL - Care Needs" is handled the day Client Care Needs lands, with no edit.
// Matches an uppercase 2–4 letter code followed by a spaced hyphen — narrow
// enough that a genuine field name like "E-Verify Status" or a value like
// "100 - Uploaded into HHA" is untouched.
const FIELD_PREFIX = /^[A-Z]{2,4}\s+-\s+/;

/** The label to SHOW for a field. The stored name is never modified. */
export function fieldLabel(name: string): string {
  const stripped = (name || "").replace(FIELD_PREFIX, "").trim();
  // Never return an empty label: a field named exactly "CG - " would otherwise
  // render as a blank row with an editor and no clue what it is.
  return stripped || name;
}
