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

/**
 * 🔴 A FIELD NO FOLDER DECISION CAN AFFECT.
 *
 * Both name checks in groupFieldsForPipeline run BEFORE any folder rule and
 * both `continue` (see :320-330, and the comment there: they "win over every
 * folder rule below"). So for these fields, ticking or unticking the folder
 * they happen to sit in changes NOTHING on the record panel:
 *
 *   HIDDEN_NAMES      never rendered anywhere
 *   SYSTEM_INFO_NAMES always rendered, in the System info block, folder or not
 *
 * ⚠️ EXPORTED SO THE PIPELINES SCREEN ASKS THE SAME QUESTION THE PANEL ANSWERS.
 * A checklist that offers a folder the panel will ignore is offering a control
 * that does nothing — and the admin has no way to discover that.
 */
export function fieldIsAlwaysIntercepted(name: string): boolean {
  const n = norm(name);
  return HIDDEN_SET.has(n) || SYSTEM_INFO_SET.has(n);
}

// Reverse: folder id -> semantic key.
const KEY_BY_ID = new Map<string, FolderKey>(
  (Object.keys(FOLDERS) as FolderKey[]).map((k) => [FOLDERS[k], k]),
);

/**
 * A folder id -> its stable code key, or "" for a folder created at runtime.
 * Exported so the seed can store KEYS rather than ids: half the bytes, and
 * legible to whoever opens the custom value in GoHighLevel's own screen.
 */
export function folderKeyById(folderId: string): string {
  return KEY_BY_ID.get(folderId) || "";
}

/** One heading in the unfiled bucket. */
export interface OrphanGroup {
  /** The folder id, or "" for fields with no folder at all. */
  id: string;
  label: string;
  /** True when GoHighLevel gave us the folder's real name. */
  named: boolean;
  fields: EditableFieldDef[];
}

export interface FieldGroup {
  key: string;
  label: string;
  fields: EditableFieldDef[];
  /**
   * Fields in this section that hold NO value. Populated for CLIENT contact
   * sections only, where they are offered through "+ Add a field" instead of
   * being rendered. Undefined everywhere else — the opportunity path and the
   * caregiver path both render every field they are given.
   */
  hidden?: EditableFieldDef[];
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
  // 🔴 THIS FUNCTION IS SYNCHRONOUS AND MUST STAY THAT WAY. It runs inside a
  // useMemo in app/page.tsx. Nothing here can fetch: the admin's stored map has
  // to arrive already loaded, fetched alongside the field defs.
  //
  // ⚠️ THREE STATES, NOT TWO.
  //   undefined — NOT LOADED YET. Falls back to the code map, so the panel
  //               renders correctly on first paint instead of flashing
  //               "not configured".
  //   {}        — LOADED, and this pipeline is not in it.
  //   {…}       — LOADED and configured.
  // Collapsing the first two would make every panel flash an unconfigured
  // warning for one frame on every open.
  storedFolders?: Record<string, string[]>,
  /**
   * The record's values, and the names we hold for folders GoHighLevel will not
   * name for us.
   *
   * 🔴 NO CONFIGURATION. Round 92's `hideWhenEmpty` flag and the three-mode
   * scheme that followed it are both gone: they invented a mechanism that
   * already existed one level down. THE PRESENCE OF A VALUE IS THE WHOLE RULE,
   * ported from groupContactFields (:520) and applied to SECTIONS rather than
   * fields.
   */
  opts?: { values?: Record<string, unknown>; folderNames?: Record<string, string> },
): {
  sections: FieldGroup[];
  systemInfo: EditableFieldDef[];
  orphans: EditableFieldDef[];
  /**
   * The orphans, GROUPED — because they are not all the same thing.
   *
   * 🔴 GOHIGHLEVEL NEVER RETURNS A FOLDER NAME. `parentName` comes back EMPTY
   * on every field (verified live, twice — see :511 from round 55 and round
   * 94), and `GET /custom-fields/object-key/opportunity` answers 400 "Api does
   * not support objectKey of type contact or opportunity". There is no third
   * source.
   *
   * So a group is NAMED only because WE stored the name when WE created the
   * folder — `opts.folderNames`, held in the pipeline config. A folder made in
   * GoHighLevel, or made before we started recording names, has no name
   * anywhere and is labelled BY THE FIELDS INSIDE IT. That is not a fallback;
   * for such a folder it is the only option there has ever been.
   *
   * ⚠️ THIS COMMENT PREVIOUSLY SAID THE OPPOSITE — that `parentName` "is
   * already in the payload, so this costs nothing". It was wrong when written
   * in round 91, the code below it was corrected in round 94, and this was
   * not. Anyone reading the return shape to understand what orphanGroups is
   * for would have rebuilt the parentName path believing it works.
   */
  orphanGroups: OrphanGroup[];
  /**
   * Sections TICKED for this pipeline that hold nothing on this record, so are
   * not drawn. Offered through "+ Add a section" — the whole folder at once.
   *
   * ⚠️ THE WHOLE FOLDER, NEVER ONE FIELD. A rep filling Milestones needs all
   * ten in order; field-by-field would be worse than drawing everything.
   */
  available: FieldGroup[];
  /** True when the map has loaded and has nothing for this pipeline. */
  unconfigured: boolean;
} {
  // ── RESOLUTION ──────────────────────────────────────────────────────────
  // 1. the stored map — the admin's decision, and the only source once seeded
  // 2. the code map — ONLY while the stored map has not loaded yet
  // 3. the Shared folder alone, and say so
  //
  // 🔴 STEP 3 REPLACES THE ALL-TWELVE FALL-THROUGH, and degrades toward LESS.
  // A missing field is a question someone asks. A wrong one misleads quietly —
  // which is exactly how an applicant came to be shown Client SSN.
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
    // 🔴 PRESENCE, NOT NON-EMPTY. This read `PIPELINE_FOLDERS[pipelineId]?.length`,
    // which is FALSY FOR AN EMPTY ARRAY — so a pipeline deliberately mapped to
    // few-or-no folders fell through to "show everything", the exact opposite of
    // what the mapping says. It never bit while every mapping was long; it would
    // have bitten immediately on the caregiver pipelines above.
    allowed = Object.prototype.hasOwnProperty.call(PIPELINE_FOLDERS, pipelineId)
      ? PIPELINE_FOLDERS[pipelineId]
      : [FOLDERS.shared];
  } else {
    allowed = [FOLDERS.shared];
    unconfigured = true;
  }

  // ⚠️ HYBRID TOKENS. The stored map holds folder KEYS; the code map holds
  // folder IDS; a folder created in GoHighLevel has no key at all and is stored
  // as its raw id. One token per folder, resolved here: the code key when there
  // is one, the raw id otherwise.
  //
  // 🔴 THE BUCKETING BELOW MUST USE THE SAME RULE. Round 90 made this list
  // hybrid and left the bucketing keyed on KEY_BY_ID alone, so a field in a
  // GHL-made folder went to `orphans` BEFORE this list was ever consulted —
  // ticking such a folder in Admin → Pipelines did nothing at all. A control
  // with no effect is worse than no control.
  const tokenOf = (entry: string): string =>
    Object.prototype.hasOwnProperty.call(FOLDERS, entry)
      ? entry
      : KEY_BY_ID.get(entry) || entry;
  const allowedTokens = new Set(allowed.map(tokenOf));

  // ⚠️ "NOT MAPPED HERE" AND "NEVER HEARD OF" ARE DIFFERENT, and the difference
  // decides whether a field is dropped or surfaced:
  //
  //   a folder the config KNOWS but this pipeline does not tick  -> dropped,
  //     because somebody decided that
  //   a folder the config has NEVER SEEN                         -> orphaned,
  //     because nobody has decided anything about it yet
  //
  // Without this, the day someone adds a folder in GHL its fields would vanish
  // from every record instead of showing up asking to be filed.
  const knownTokens = new Set<string>(Object.keys(FOLDERS));
  for (const id of Object.values(FOLDERS)) knownTokens.add(id);
  if (loaded)
    for (const list of Object.values(storedFolders)) for (const t of list) knownTokens.add(t);

  const buckets = new Map<string, EditableFieldDef[]>();
  const systemInfo: EditableFieldDef[] = [];
  const orphans: EditableFieldDef[] = [];

  for (const def of defs) {
    // 🔴 BOTH NAME CHECKS RUN FIRST, AND THAT IS LOAD-BEARING. They win over
    // every folder rule below, so a system-written field stays read-only in
    // System info no matter which folder it sits in — including a folder
    // created in GHL. Moving either of them under the parentId logic would let
    // a rep get an editable "Transferred From".
    if (HIDDEN_SET.has(norm(def.name))) continue; // ITEM 1
    if (SYSTEM_INFO_SET.has(norm(def.name))) {
      systemInfo.push(def);
      continue;
    }
    // Same hybrid rule as the allow-list — see tokenOf above.
    const token = def.parentId ? tokenOf(def.parentId) : "";
    if (!token) {
      orphans.push(def); // genuinely loose: no folder at all
      continue;
    }
    if (token === "lostReason") {
      // Option B: only the lost-reason field mapped to THIS pipeline renders.
      if (!LOST_REASON_OVERRIDES[def.id]?.includes(pipelineId)) continue;
    }
    if (!allowedTokens.has(token)) {
      // Known to the config but not ticked here -> a decision, so drop it.
      // Never seen by the config -> surface it rather than lose it.
      if (!knownTokens.has(token)) orphans.push(def);
      continue;
    }
    const arr = buckets.get(token) || [];
    arr.push(def);
    buckets.set(token, arr);
  }

  // Emit sections in the pipeline's configured folder order, each field list in
  // GHL's authored `position` order.
  const vals = opts?.values;
  const names = opts?.folderNames || {};

  // 🔴 THE CONTACT RULE, APPLIED TO SECTIONS.
  //   at least one answered field -> drawn IN FULL, empties included
  //   nothing answered            -> not drawn, offered under "+ Add a section"
  //
  // ✅ This answers round 54 without a flag. A new OLTL record shows no
  // Milestones; the rep adds the section and fills the first one. Nothing is
  // unreachable, which was the whole objection.
  // ✅ And it answers the Facebook lead: four questions nobody asked are not
  // drawn at all — not quietly, not behind a heading still claiming the form
  // applies to this person.
  //
  // ⚠️ A SECTION ADDED AND LEFT EMPTY DISAPPEARS ON RELOAD. Same as the contact
  // rule and for the same reason: "has a value" is evaluated fresh on every
  // load, and there is nowhere to record "this one was deliberately empty"
  // without inventing state GoHighLevel does not hold. The control says so.
  const sections: FieldGroup[] = [];
  const available: FieldGroup[] = [];
  for (const entry of allowed) {
    const token = tokenOf(entry);
    const fields = buckets.get(token);
    if (!fields || !fields.length) continue;
    const group: FieldGroup = {
      key: token,
      // 🔴 NOT parentName — IT IS ALWAYS EMPTY. lib/fieldFolders.ts:491 has
      // recorded that since round 55, verified live, and round 91 labelled
      // runtime folders by it anyway. The only sources are the curated map and
      // the names we stored ourselves when we created the folder.
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
    // With no values supplied at all (a caller that does not have the record)
    // nothing can be judged, so everything is drawn — the old behaviour.
    const answered = !vals || fields.some((f) => hasValue(vals[f.id]));
    (answered ? sections : available).push(group);
  }

  // ── THE UNFILED BUCKET, IN THREE CASES ──────────────────────────────────
  //   1. a folder WE named when we created it -> its own heading, by that name
  //   2. a folder nobody has named            -> labelled by its fields
  //   3. no folder at all                     -> the generic heading
  //
  // 🔴 CASE 1 WAS DEAD CODE. It tested `def.parentName`, which is ALWAYS
  // EMPTY — so every orphan fell to the generic bucket and the named branch
  // could never be reached. Round 94 corrected the section labels and left
  // this builder untouched. The name now comes from the same stored map the
  // sections use.
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

  // ── CLIENT ────────────────────────────────────────────────────────────────
  // Three Meta lead forms feed three different contact folders, so a rep
  // opening one of 103+ live Facebook leads saw a name, a phone and a source
  // and NOTHING the person actually asked for. These four folders are what
  // those answers land in.
  { name: "OLTL Waiver",         id: "fFgtLwCr6B2JyoTR4ymn", label: "OLTL Waiver",        appliesTo: "client" },
  { name: "ODP",                 id: "9PXWAwL3EaaluRPr5yFn", label: "ODP",                appliesTo: "client" },
  { name: "FB Private Pay Form", id: "5QrSWnBaHJlWsDifTlnu", label: "Private Pay Enquiry", appliesTo: "client" },
  // ⚠️ "Form | Form 6" is GoHighLevel's AUTOGENERATED folder name — it is the
  // folder holding "I want to…", age, payment and program. `name` must stay
  // exactly as GHL spells it (it is the match key); `label` is what a rep sees.
  { name: "Form | Form 6",       id: "wE8YbYKaPhigU6rJ10sl", label: "Enquiry Details",     appliesTo: "client" },

  // 🔴 DO NOT ADD "Contact" (O0m1HH8Mou9C9ImAPhJT) or "Additional Info"
  // (4ywdaP7iC0k6zaEkXTTl). Both are GHL STANDARD folders —
  // standardFieldsFolder:true — and adding either drags every native field onto
  // the panel.
  //
  // ⚠️ "FB Private Pay Form" above has an OPPORTUNITY twin,
  // CVwUcXV27zGPUvRDOfBh, with the same name and the same four question names
  // (it is FOLDERS.fbForm). Different models, different ids. Only the CONTACT
  // one belongs in this table — matching by NAME first is what makes the twin
  // dangerous, and why the id is written down.
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
  /**
   * The record's stored contact values. Optional, and only consulted for a
   * CLIENT record — see the branch below.
   */
  values?: Record<string, unknown>,
): FieldGroup[] {
  const folders = CONTACT_FOLDERS.filter((f) => f.appliesTo === kind);
  const byFolder = new Map<string, EditableFieldDef[]>();
  for (const def of defs) {
    if (HIDDEN_SET.has(norm(def.name))) continue;
    // 🔴 ID FIRST, NAME SECOND. This was the other way round.
    //
    // Two reasons, and the second is the one that matters:
    //
    // 1. The name path is DEAD. GoHighLevel returns `parentName` EMPTY on every
    //    contact field — verified live — so the id branch is what has actually
    //    been doing the work all along. Trying a field that is never populated
    //    first is misleading to read.
    //
    // 2. It could match the WRONG FOLDER if GHL ever starts sending it.
    //    "FB Private Pay Form" exists TWICE on this account: as a contact
    //    folder (5QrSWnBaHJlWsDifTlnu) and as an opportunity folder
    //    (CVwUcXV27zGPUvRDOfBh), same name, four same-named questions each. A
    //    name-first match would have no way to tell them apart. An id can only
    //    ever mean one folder.
    //
    // The name is KEPT as a fallback, not deleted: if a folder is recreated in
    // GHL its id changes and its name does not, and a fallback that only fires
    // when the id misses is the one that survives that without being able to
    // cause the collision above.
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
  // ITEM 2 — folders holding at least one answer come FIRST, in a STABLE
  // order within each group so nothing jumps about between loads.
  //
  // 🔴 ONE ANSWERED FIELD LIFTS THE WHOLE FOLDER, never the field on its own.
  // A single value floating out of its section is how the panel stops being
  // organised, which is the problem this solves.
  const anyAnswered = (f: { name: string }) =>
    (byFolder.get(f.name) || []).some((d) => hasValue(values?.[d.id]));
  const ordered = [...folders.filter(anyAnswered), ...folders.filter((f) => !anyAnswered(f))];
  const out: FieldGroup[] = [];
  for (const f of ordered) {
    const fields = byFolder.get(f.name);
    if (!fields || !fields.length) continue;
    const sorted = [...fields].sort(byPosition);

    // ═══════════════════════════════════════════════════════════════════════
    // 🔴 THE TWO KINDS RENDER BY DIFFERENT RULES. THIS IS DELIBERATE.
    //
    //   CAREGIVER — every field, populated or not.
    //   CLIENT    — only fields that HOLD A VALUE; the empty ones are returned
    //               in `hidden` and reached through the section's
    //               "+ Add a field" control.
    //
    // DO NOT "fix" this into consistency. It would break caregiver intake.
    //
    // The difference is WHO AUTHORS THE FIELD. A recruiter FILLS the CG- fields
    // as part of their work, so a field that only appeared once populated could
    // never be filled in the first place — the panel would be a dead end.
    // Client contact fields are the LEAD'S OWN form answers: nobody hand-fills
    // "I want to…", so showing forty empty questions from three different Meta
    // forms would bury the four that were actually answered.
    //
    // ⚠️ A CLIENT FIELD CLEARED BACK TO EMPTY DISAPPEARS AGAIN ON RELOAD, back
    // into "+ Add a field". That is intended, not a bug: the rule is "has a
    // value", and it is evaluated fresh on every load. There is nowhere to
    // record "this one was deliberately emptied" without inventing state GHL
    // does not hold.
    // ═══════════════════════════════════════════════════════════════════════
    if (kind === "client" && values) {
      const filled = sorted.filter((d) => hasValue(values[d.id]));
      const empty = sorted.filter((d) => !hasValue(values[d.id]));
      // A section with nothing filled still renders — otherwise its empty
      // fields would be unreachable and "+ Add a field" could never be used.
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

/**
 * "Does this field hold anything?"
 *
 * Written out rather than a truthiness check because a legitimately stored
 * value can be falsy: the NUMBER 0, and `false` on a checkbox, are both answers
 * a lead gave and must keep the field on screen.
 */
function hasValue(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim() !== "";
  return true;
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


// ---------------------------------------------------------------------------
// ITEM 8 — RESERVED MEDIA FOLDERS.
//
// The Resources tab hides a folder nobody has been granted... except from
// ADMINS, who see every folder by design:
//
//     visible = all.filter((f) => isAdmin || granted.has(f.id) || …)
//
// So "granted to nobody" does not hide anything from the people who run
// imports — the wizard is admin-only, so they are exactly the ones who would
// find `_imports` sitting in Resources.
//
// A RESERVED NAME rather than an env var, deliberately:
//
//   - An env var can be unset, mistyped, or differ between preview and
//     production, and the failure mode is the folder appearing in the tab with
//     nothing to explain why. A name is in the code, the same everywhere.
//   - The collision risk an env var protects against is not real here: the
//     leading underscore is not a character anyone reaches for when naming a
//     folder by hand ("Onboarding Docs", "Policies"), and if someone did create
//     one it would be hidden — a folder that does not list, not data loss.
//   - One rule, one place, and the next reserved folder is one entry.
//
// ⚠️ HIDING, NOT SECURING. These folders are simply not listed by the Resources
// tab. Anyone with GoHighLevel access still sees them there, which is correct:
// the CSVs are the company's own records, not a secret from the company.
// ---------------------------------------------------------------------------
export const RESERVED_MEDIA_FOLDERS = ["_imports"] as const;

/** True when a media folder is one the Resources tab must never list. */
export function isReservedFolder(name: string): boolean {
  const n = (name || "").trim().toLowerCase();
  return RESERVED_MEDIA_FOLDERS.some((r) => r.toLowerCase() === n);
}
