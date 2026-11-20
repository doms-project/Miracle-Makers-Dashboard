import type { EditableFieldDef } from "./types";

export const FOLDERS = {
  webIntake: "q9YrpYwe9T0mQyRIJOr9",
  shared: "B6cunntgpATjWseEb1iC",
  client: "KKiWnjidBN65xGhJESgc",
  enrollment: "Jh2YEtaeoFYkx0o1YC2M",
  flags: "16CS34KrKsL8MCQHrbMG",
  milestones: "qsILANZN39yUarsgINk6",
  transfer: "7qJlA2QBcha929nsphFk",
  odp: "TIMuXWr8CgAVJhnBJtTj",
  lostReason: "EpVxmToo9FWx2Vsf9iLA",
  ppIntake: "P01rOtXIQddconuzrunx",
  adAttrib: "YwoE8EaNqcnd76TwMvkw",
  fbForm: "CVwUcXV27zGPUvRDOfBh",
} as const;

type FolderKey = keyof typeof FOLDERS;

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

const F = FOLDERS;
export const PIPELINE_FOLDERS: Record<string, string[]> = {

  KGjdCMG4F8xILk0ineB9: [
    F.webIntake, F.shared, F.client, F.enrollment, F.flags, F.milestones, F.transfer, F.lostReason,
  ],

  "74Pt3XX4hgBIqD10mW4G": [
    F.webIntake, F.shared, F.client, F.enrollment, F.flags, F.transfer, F.lostReason,
  ],

  a14NtTi18ACxs99bHPmL: [
    F.webIntake, F.shared, F.client, F.enrollment, F.flags, F.odp, F.transfer, F.lostReason,
  ],

  PIs1iWVk0HqHZFNtmoTn: [
    F.webIntake, F.shared, F.client, F.enrollment, F.flags, F.odp, F.transfer, F.lostReason,
  ],

  BJBWdRim6SOgjoMelVSZ: [
    F.webIntake, F.shared, F.client, F.ppIntake, F.adAttrib, F.fbForm, F.transfer, F.lostReason,
  ],

  EXVMveGzgDy9qf4wQR2H: [F.lostReason],
  "232bytrK7FWNAwC6shME": [F.lostReason],
};

export const LOST_REASON_OVERRIDES: Record<string, string[]> = {
  mf2biwVVXPgJv02laVs2: ["KGjdCMG4F8xILk0ineB9"],
  "69Xa84NK1bCjWZRPDFhE": ["74Pt3XX4hgBIqD10mW4G"],
  "0lBuWb1a20jI5bwHuLjr": ["a14NtTi18ACxs99bHPmL"],
  nd271LsbIi4u2eZMXOCh: ["PIs1iWVk0HqHZFNtmoTn"],
  dgP14Vpa1iqybLSnNPs1: ["BJBWdRim6SOgjoMelVSZ"],

  AiuRVUF6UPcnLbZnHC7w: ["EXVMveGzgDy9qf4wQR2H", "232bytrK7FWNAwC6shME"],
};

const HIDDEN_NAMES = [
  "Transfer Reason", "Reassign Followers", "Case Manager Followers", "Stage History",

  "First Opened",

  "Sorted From New Leads",
];
const HIDDEN_SET = new Set(HIDDEN_NAMES.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "")));

const SYSTEM_INFO_NAMES = [
  "Airtable Record ID",
  "APP - Compliance Cleared",
  "Transferred From",
  "Transferred Date",

  "Peer Record Id",
  "Peer Opportunity Id",
  "Transferred To Id",
  "Transferred Record Id",
];

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const SYSTEM_INFO_SET = new Set(SYSTEM_INFO_NAMES.map(norm));

export function fieldIsAlwaysIntercepted(name: string): boolean {
  const n = norm(name);
  return HIDDEN_SET.has(n) || SYSTEM_INFO_SET.has(n);
}

const KEY_BY_ID = new Map<string, FolderKey>(
  (Object.keys(FOLDERS) as FolderKey[]).map((k) => [FOLDERS[k], k]),
);

export function folderKeyById(folderId: string): string {
  return KEY_BY_ID.get(folderId) || "";
}

export interface OrphanGroup {

  id: string;
  label: string;

  named: boolean;
  fields: EditableFieldDef[];
}

export interface FieldGroup {
  key: string;
  label: string;
  fields: EditableFieldDef[];

  hidden?: EditableFieldDef[];
}

function byPosition(a: EditableFieldDef, b: EditableFieldDef): number {
  const pa = Number.isFinite(a.position) ? a.position : Number.MAX_SAFE_INTEGER;
  const pb = Number.isFinite(b.position) ? b.position : Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return (a.name || "").localeCompare(b.name || "");
}

export function groupFieldsForPipeline(
  defs: EditableFieldDef[],
  pipelineId: string,

  storedFolders?: Record<string, string[]>,

  opts?: {
    values?: Record<string, unknown>;
    folderNames?: Record<string, string>;

    exclude?: Iterable<string>;
  },
): {
  sections: FieldGroup[];
  systemInfo: EditableFieldDef[];
  orphans: EditableFieldDef[];

  orphanGroups: OrphanGroup[];

  available: FieldGroup[];

  unconfigured: boolean;
} {

  const loaded = storedFolders !== undefined;
  const stored =
    loaded && Object.prototype.hasOwnProperty.call(storedFolders, pipelineId)
      ? storedFolders[pipelineId]
      : null;

  let unconfigured = false;
  let allowed: string[];
  if (stored) {
    allowed = stored;
  } else if (!loaded) {

    allowed = Object.prototype.hasOwnProperty.call(PIPELINE_FOLDERS, pipelineId)
      ? PIPELINE_FOLDERS[pipelineId]
      : [FOLDERS.shared];
  } else {
    allowed = [FOLDERS.shared];
    unconfigured = true;
  }

  const tokenOf = (entry: string): string =>
    Object.prototype.hasOwnProperty.call(FOLDERS, entry)
      ? entry
      : KEY_BY_ID.get(entry) || entry;
  const allowedTokens = new Set(allowed.map(tokenOf));

  const knownTokens = new Set<string>(Object.keys(FOLDERS));
  for (const id of Object.values(FOLDERS)) knownTokens.add(id);
  if (loaded)
    for (const list of Object.values(storedFolders)) for (const t of list) knownTokens.add(t);

  const buckets = new Map<string, EditableFieldDef[]>();
  const systemInfo: EditableFieldDef[] = [];
  const orphans: EditableFieldDef[] = [];

  const excluded = new Set(opts?.exclude ?? []);

  for (const def of defs) {

    if (HIDDEN_SET.has(norm(def.name))) continue;
    if (SYSTEM_INFO_SET.has(norm(def.name))) {
      systemInfo.push(def);
      continue;
    }

    if (excluded.has(def.id)) continue;

    const token = def.parentId ? tokenOf(def.parentId) : "";
    if (!token) {
      orphans.push(def);
      continue;
    }
    if (token === "lostReason") {

      if (!LOST_REASON_OVERRIDES[def.id]?.includes(pipelineId)) continue;
    }
    if (!allowedTokens.has(token)) {

      if (!knownTokens.has(token)) orphans.push(def);
      continue;
    }
    const arr = buckets.get(token) || [];
    arr.push(def);
    buckets.set(token, arr);
  }

  const vals = opts?.values;
  const names = opts?.folderNames || {};

  const sections: FieldGroup[] = [];
  const available: FieldGroup[] = [];
  for (const entry of allowed) {
    const token = tokenOf(entry);
    const fields = buckets.get(token);
    if (!fields || !fields.length) continue;
    const group: FieldGroup = {
      key: token,

      label:
        FOLDER_LABELS[token as FolderKey] ||
        names[token] ||
        names[entry] ||
        `Unnamed section · ${fields
          .slice(0, 2)
          .map((f) => f.name)
          .join(", ")}${fields.length > 2 ? "…" : ""}`,
      fields: [...fields].sort(byPosition),
    };

    const answered = !vals || fields.some((f) => hasValue(vals[f.id]));
    (answered ? sections : available).push(group);
  }

  const namedGroups = new Map<string, OrphanGroup>();
  const unnamed: EditableFieldDef[] = [];
  for (const def of orphans) {
    const folderName = (names[def.parentId] || "").trim();
    if (def.parentId && folderName) {
      const g = namedGroups.get(def.parentId) || {
        id: def.parentId,
        label: folderName,
        named: true,
        fields: [],
      };
      g.fields.push(def);
      namedGroups.set(def.parentId, g);
    } else {
      unnamed.push(def);
    }
  }
  const orphanGroups: OrphanGroup[] = [...namedGroups.values()]
    .map((g) => ({ ...g, fields: [...g.fields].sort(byPosition) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (unnamed.length)
    orphanGroups.push({
      id: "",
      label: "Fields not yet assigned to a section",
      named: false,
      fields: [...unnamed].sort(byPosition),
    });

  return {
    sections,
    systemInfo: [...systemInfo].sort(byPosition),
    orphans: [...orphans].sort(byPosition),
    orphanGroups,
    available,
    unconfigured,
  };
}

export interface ContactFolder {

  name: string;

  id: string;

  label: string;

  appliesTo: "caregiver" | "client" | "both";
}

export const CONTACT_FOLDERS: ContactFolder[] = [
  { name: "Caregiver Application",  id: "EeU1n8FZZ4WziJwsgwpX", label: "Caregiver Application",  appliesTo: "caregiver" },
  { name: "Caregiver Compliance",   id: "H718HDV7Zaj1QNq6teQC", label: "Caregiver Compliance",   appliesTo: "caregiver" },
  { name: "Caregiver Availability", id: "whcRgJb0Mcfv6uruGAD9", label: "Caregiver Availability", appliesTo: "caregiver" },

  { name: "OLTL Waiver",         id: "fFgtLwCr6B2JyoTR4ymn", label: "OLTL Waiver",        appliesTo: "client" },
  { name: "ODP",                 id: "9PXWAwL3EaaluRPr5yFn", label: "ODP",                appliesTo: "client" },
  { name: "FB Private Pay Form", id: "5QrSWnBaHJlWsDifTlnu", label: "Private Pay Enquiry", appliesTo: "client" },

  { name: "Form | Form 6",       id: "wE8YbYKaPhigU6rJ10sl", label: "Enquiry Details",     appliesTo: "client" },

  { name: "Referral Partner", id: "SjOstzm64Ur7tBkQxhUg", label: "Referral Partner", appliesTo: "client" },
  { name: "Event Attendance", id: "7ygQ0GymjbM5l8kTXrkX", label: "Event Attendance", appliesTo: "client" },

  { name: "Attribution", id: "HeEHQZGk9fMUP7HeGYLU", label: "Attribution", appliesTo: "both" },

];

export function folderIdsPresent(defs: { parentId?: string }[]): Set<string> {
  const out = new Set<string>();
  for (const d of defs) {
    const pid = (d.parentId || "").trim();
    if (pid) out.add(pid);
  }
  return out;
}

export function builtInFoldersAreForeign(defs: { parentId?: string }[]): boolean {
  const here = folderIdsPresent(defs);
  if (!here.size) return false;
  const mine = [...Object.values(FOLDERS), ...CONTACT_FOLDERS.map((f) => f.id)];
  return !mine.some((id) => here.has(id));
}

export function resolveFolderId(
  builtInId: string,
  names: readonly string[],
  here: Set<string>,
  folderNames?: Record<string, string>,
): string {
  if (builtInId && here.has(builtInId)) return builtInId;
  if (folderNames)
    for (const [id, nm] of Object.entries(folderNames)) {
      if (!here.has(id)) continue;
      if (names.some((n) => norm(n) === norm(nm))) return id;
    }
  return "";
}

export function groupContactFields(
  defs: EditableFieldDef[],
  kind: "caregiver" | "client",

  values?: Record<string, unknown>,

  folderNames?: Record<string, string>,
): FieldGroup[] {

  const base = CONTACT_FOLDERS.filter(
    (f) => f.appliesTo === kind || f.appliesTo === "both",
  );

  const here = folderIdsPresent(defs);
  const folders = base.map((f) => ({
    ...f,
    id: resolveFolderId(f.id, [f.name, f.label], here, folderNames) || f.id,
  }));
  const byFolder = new Map<string, EditableFieldDef[]>();
  for (const def of defs) {
    if (HIDDEN_SET.has(norm(def.name))) continue;

    const folderName = (def.parentName || "").trim();
    const match =
      folders.find((f) => f.id && f.id === def.parentId) ||
      (folderName
        ? folders.find((f) => norm(f.name) === norm(folderName))
        : undefined);
    if (!match) continue;
    const arr = byFolder.get(match.name) || [];
    arr.push(def);
    byFolder.set(match.name, arr);
  }

  const anyAnswered = (f: { name: string }) =>
    (byFolder.get(f.name) || []).some((d) => hasValue(values?.[d.id]));
  const ordered = [...folders.filter(anyAnswered), ...folders.filter((f) => !anyAnswered(f))];
  const out: FieldGroup[] = [];
  for (const f of ordered) {
    const fields = byFolder.get(f.name);
    if (!fields || !fields.length) continue;
    const sorted = [...fields].sort(byPosition);

    if (kind === "client" && values) {
      const filled = sorted.filter((d) => hasValue(values[d.id]));
      const empty = sorted.filter((d) => !hasValue(values[d.id]));

      out.push({
        key: `contact:${f.name}`,
        label: f.label,
        fields: filled,
        hidden: empty,
      });
      continue;
    }

    out.push({ key: `contact:${f.name}`, label: f.label, fields: sorted });
  }
  return out;
}

export function hasValue(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

const FIELD_PREFIX = /^[A-Z]{2,4}\s+-\s+/;

export function fieldLabel(name: string): string {
  const stripped = (name || "").replace(FIELD_PREFIX, "").trim();

  return stripped || name;
}

export const RESERVED_MEDIA_FOLDERS = ["_imports"] as const;

export function isReservedFolder(name: string): boolean {
  const n = (name || "").trim().toLowerCase();
  return RESERVED_MEDIA_FOLDERS.some((r) => r.toLowerCase() === n);
}
