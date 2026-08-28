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
};

// Option B — the Lost Reasons folder holds six fields (one per pipeline +
// Caregiver Rejection). A lost-reason field renders ONLY on its pipeline.
export const LOST_REASON_OVERRIDES: Record<string, string> = {
  mf2biwVVXPgJv02laVs2: "KGjdCMG4F8xILk0ineB9", // OLTL Enrollment Lost Reason
  "69Xa84NK1bCjWZRPDFhE": "74Pt3XX4hgBIqD10mW4G", // OLTL Transfer Lost Reason
  "0lBuWb1a20jI5bwHuLjr": "a14NtTi18ACxs99bHPmL", // ODP Enrollment Lost Reason
  nd271LsbIi4u2eZMXOCh: "PIs1iWVk0HqHZFNtmoTn", // ODP Transfer Lost Reason
  dgP14Vpa1iqybLSnNPs1: "BJBWdRim6SOgjoMelVSZ", // Private Pay Lost Reason
  AiuRVUF6UPcnLbZnHC7w: "EXVMveGzgDy9qf4wQR2H", // Caregiver Rejection Reason (recruiting pipeline)
};

// Fields that always live in the collapsed System info section, regardless of
// their folder (external ids / derived / automation). Matched by normalized name.
// ITEM 1 — fields deliberately NOT rendered in the panel. "Transfer Reason"
// duplicates the Move note, and the note is strictly better: it carries author
// + timestamp, and it is per-transfer, whereas the field is overwritten by the
// next move. The field still exists in GHL; it just isn't shown.
const HIDDEN_NAMES = ["Transfer Reason"];
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
  const allowed =
    PIPELINE_FOLDERS[pipelineId]?.length
      ? PIPELINE_FOLDERS[pipelineId]
      : Object.values(FOLDERS); // unmapped pipeline → show all folders
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
      if (LOST_REASON_OVERRIDES[def.id] !== pipelineId) continue;
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
