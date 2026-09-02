// The normalized shape the frontend expects. One object per OLTL opportunity.
export interface OpportunityRecord {
  id: string;
  // The OPPORTUNITY's own name (GHL `name`). Distinct from the contact — one
  // contact can hold several opportunities, and showing only the contact name
  // makes them indistinguishable in the list and panel header.
  oppName: string;
  first: string;
  last: string;
  stage: string; // pipeline stage name
  harmony: string; // Harmony ID (custom field)
  countyId: string; // County ID (custom field)
  office: string; // Office (custom field)
  county: string; // County (custom field)
  block: string; // Road Blocker (custom field); "None" when empty
  ref: string; // Referral Source (custom field)
  src: string; // Source (custom field)
  rep: string; // owner / assigned user name
  asst: string; // Sales Rep Assistant (custom field)
  cm: string; // Case Manager (custom field)
  onb: string; // Onboarding Rep (custom field)
  cg: string; // Caregiver (custom field)
  checked: boolean; // "Checked this week" (custom field)
  // Identity fields used for the Phase 3 visibility filter (assignment-only).
  ownerId: string; // GHL opportunity `assignedTo` user id ("" when unassigned)
  followerIds: string[]; // GHL opportunity `followers` (array of user ids)
  followerNames: string[]; // follower ids resolved to names via the users lookup
  // Phase 2 editing — native fields + raw custom-field values keyed by field id.
  stageId: string; // native pipelineStageId (the stable key; `stage` is the name)
  status: string; // native opportunity status (open/won/lost/abandoned)
  monetaryValue: number; // native value
  cf: Record<string, unknown>; // fieldId -> current raw value (arrays preserved)
  // ITEM #10 — the CONTACT's tags, carried through so a card can say HOW a
  // record reached Sent out. `transferred-to-*` is written on every transfer;
  // `reassigned-from-*` only on the reassign path, so its PRESENCE is the
  // discriminator. Deliberately only presence: tags are contact-scoped, so the
  // value's "from" half is unreliable (a within-division reassign writes
  // `reassigned-from-oltl` beside `transferred-to-oltl`). The accurate source
  // comes from the "Transferred From" FIELD instead — one job each.
  //
  // [] when GoHighLevel's opportunity search sends no contact tags. The card
  // then falls back to the neutral wording rather than guessing.
  // ITEM 1 — the contact's NATIVE name/phone/email, carried through so the panel
  // can say how to reach the person. NOT custom fields and NOT in any folder, so
  // CONTACT_FOLDERS never sees them; they get their own block at the top.
  //
  // ⚠️ NO EXTRA GHL CALL. These already ride along in the opportunity search's
  // embedded `contact` object — the same object `tags` came from. They were
  // simply never declared, so nothing read them.
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  tags: string[];
  contactId: string; // linked contact — notes are stored on the contact
  // Multi-pipeline (v2). A record now belongs to one of several pipelines.
  pipelineId: string; // the opportunity's native pipelineId
  pipelineName: string; // resolved pipeline name (for the division badge)
  shared: boolean; // true when surfaced via a NON-home pipeline (owner/follower)
  // ITEM 2 — when this record last changed stage, for the Master view's
  // days-in-stage. "" when GoHighLevel didn't send it; the UI then renders
  // NOTHING rather than "0 days", which would be a confident claim about a
  // record whose history we don't actually know.
  stageChangedAt?: string;
  // ITEM 5 — OPTIMISTIC CONCURRENCY. GoHighLevel's `updatedAt`, carried through
  // to the client and sent back on every write. The server compares it to the
  // stored value and refuses the write if anyone else has touched the record in
  // between, instead of silently overwriting their change.
  //
  // "" when GoHighLevel sent no timestamp — the check then cannot run and the
  // write proceeds. That is deliberate: refusing every write because we can't
  // read a version would break the app over a missing field, whereas the old
  // behaviour (last write wins) is what we already had.
  version?: string;
}

// Custom-field definition sent to the client to drive the dynamic editors.
export interface EditableFieldDef {
  id: string;
  name: string;
  dataType: string; // TEXT | LARGE_TEXT | SINGLE_OPTIONS | MULTIPLE_OPTIONS | DATE | NUMERICAL | MONETORY | CHECKBOX
  options: string[]; // option strings for *_OPTIONS / CHECKBOX
  // ITEM 3 — the folder's NAME when GoHighLevel supplies one. Folders are
  // matched by name first (a name survives a folder being recreated; an id does
  // not), falling back to parentId when absent.
  parentName?: string;
  editable: boolean; // false for the read-only blocklist
  parentId: string; // custom-field folder id (drives folder-driven field sets)
  // GHL's authored display order WITHIN a folder (spaced in 50s so fields can be
  // inserted between later — never renumber, just respect it). The search API
  // returns fields in an arbitrary order, so this is the only reliable ordering.
  position: number;
}

export interface Note {
  id: string;
  who: string;
  when: string;
  txt: string;
  // The author's division AT WRITE TIME, stamped into the note body. Never
  // looked up later — a lookup would relabel past notes if the author moves
  // division, rewriting history.
  division?: string;
  // ITEM 4 — note editing. The UI shows the edit affordance only when
  // authorId === the viewer; the server re-checks and is the real boundary.
  // `edited` renders the marker that keeps an overwrite honest.
  authorId?: string;
  edited?: boolean;
  // ITEM 5 — soft-deleted. The note stays in history, struck through, showing
  // who removed it and when; the original text is not kept.
  removed?: boolean;
  // ITEM 2 — a Move note carries a SYSTEM record plus the author's words. The
  // author may correct or withdraw only their half; the system half is what
  // tells the receiving rep how the case got to them.
  isMove?: boolean;
  system?: string; // "" for a manual note
  reason?: string; // the whole text for a manual note
}

// Add Client (item 3) — what the modal posts. `assignedTo` is ADVISORY: the
// server forces a rep to themselves and only honours it for an admin.
export interface NewClientPayload {
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  pipelineId: string;
  stageId?: string;
  assignedTo?: string;
  oppName?: string;
  contactId?: string; // set when the user picked an existing contact
  // ITEM 3 — the collapsed "more details" fields, keyed BY FIELD ID with real
  // option values. They were three free-text strings; Office is MULTIPLE_OPTIONS
  // and County / Referral Source Type are SINGLE_OPTIONS, so free text produced
  // values no filter, report or GHL workflow could read.
  details?: Record<string, string | string[]>;
}

export interface ContactMatch {
  id: string;
  name: string;
  email: string;
  phone: string;
  // Pipelines where this contact ALREADY has a case — each one is a destination
  // GHL will refuse (OPPORTUNITY_NO_DUPLICATE).
  pipelines: { pipelineId: string; pipelineName: string; stage: string }[];
}

export interface Viewer {
  authenticated: boolean; // false when SSO isn't configured (open/setup mode)
  isAdmin: boolean; // role === "admin" || type === "agency"
  userName: string | null;
  role: string | null;
  type?: string | null; // GHL session `type` (agency/location) — diagnostic
  total: number; // total records before the visibility filter
  // v2 — the viewer's HOME pipelines (admins: all selected). Drives the board
  // (home pipelines only) and the division filter.
  homePipelineIds?: string[];
  // ITEM 4 — Master view grant. Not a role: it changes the LAYOUT of records the
  // viewer can already see, never which records those are.
  canSeeMaster?: boolean;
}

export interface OpportunitiesResponse {
  records: OpportunityRecord[];
  // A pipeline whose fetch failed. Its records are ABSENT from `records`, and
  // that is indistinguishable from "this pipeline is empty" unless we say so.
  failedPipelines?: { id: string; name: string; error: string }[];
  pipeline: { id: string; name: string } | null; // legacy single-pipeline summary (v2: null)
  count: number;
  viewer?: Viewer;
  // Metadata for the Phase 2 editors (same for all records).
  fieldDefs?: EditableFieldDef[]; // OLTL opportunity custom-field definitions
  stages?: { id: string; name: string }[]; // union of stages across pipelines (deduped by id)
  // Location users for the owner/follower pickers. `divisions` labels each user
  // (empty = none mapped -> the picker shows "—", never hides them).
  users?: { id: string; name: string; divisions?: string[]; pipelineIds?: string[] }[];
  // Multi-pipeline (v2).
  pipelines?: { id: string; name: string }[]; // the selected pipelines, in order
  stagesByPipeline?: Record<string, { id: string; name: string }[]>; // pipelineId -> its stages
}

export interface ApiError {
  error: string;
  detail?: string;
  status?: number;
}

// Resources tab — a file in the OLTL Resources media folder.
export interface ResourceFile {
  // ITEM 11 — needed to delete one file. "" when GHL sent no id, and the UI
  // hides the delete affordance in that case rather than sending a blank id.
  id: string;
  name: string;
  url: string;
  type: string;
  size: number;
}

export interface ResourcesResponse {
  resources: ResourceFile[];
  folderId: string;
  count: number;
}

// Bulk import — metadata for the wizard (all dynamic, nothing hardcoded).
export interface ImportPipeline {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}
export interface ImportMeta {
  pipelines: ImportPipeline[];
  fieldDefs: EditableFieldDef[]; // opportunity custom fields (map targets)
}
export interface ImportRowError {
  row: number; // 1-based row index within the file
  error: string;
}
export interface ImportSummary {
  created: number;
  skipped: number; // existing contact (deduped)
  failed: number;
  errors: ImportRowError[];
}

// Task 4 — a caregiver linked to a client via the caregiver_client association.
export interface Caregiver {
  relationId: string; // used to remove the link
  contactId: string; // the OTHER contact in the relation (deep-links to GHL)
  name: string;
  // The association is DIRECTIONAL. On a client's record the other side is a
  // caregiver; on a caregiver's record it is a client. The heading and the
  // wording follow this — they used to say "Caregivers" on both.
  role?: "caregiver" | "client";
}

// Caregiver/client link counts for the list + board badges, keyed by contactId.
export type RelationCounts = Record<
  string,
  { caregivers: number; clients: number }
>;

// Task 5 — email send. A selectable recipient (client or caregiver contact).
export interface EmailRecipient {
  contactId: string;
  name: string;
  email: string;
  role: "client" | "caregiver";
}
export interface EmailSendResult {
  contactId: string;
  name: string;
  ok: boolean;
  error?: string;
}
