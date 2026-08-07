// The normalized shape the frontend expects. One object per OLTL opportunity.
export interface OpportunityRecord {
  id: string;
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
  contactId: string; // linked contact — notes are stored on the contact
}

// Custom-field definition sent to the client to drive the dynamic editors.
export interface EditableFieldDef {
  id: string;
  name: string;
  dataType: string; // TEXT | LARGE_TEXT | SINGLE_OPTIONS | MULTIPLE_OPTIONS | DATE | NUMERICAL | MONETORY | CHECKBOX
  options: string[]; // option strings for *_OPTIONS / CHECKBOX
  editable: boolean; // false for the read-only blocklist
}

export interface Note {
  who: string;
  when: string;
  txt: string;
}

export interface Viewer {
  authenticated: boolean; // false when SSO isn't configured (open/setup mode)
  isAdmin: boolean; // role === "admin" || type === "agency"
  userName: string | null;
  role: string | null;
  type?: string | null; // GHL session `type` (agency/location) — diagnostic
  total: number; // total records before the visibility filter
}

// TEMPORARY diagnostic block surfaced in the /api/opportunities response so the
// visibility path can be inspected in the browser Network tab. Remove after the
// filter is confirmed.
export interface VisibilityDebug {
  ssoConfigured: boolean;
  branch: "open-no-sso" | "admin" | "restricted";
  userId: string | null;
  role: string | null;
  type: string | null;
  preFilterCount: number;
  postFilterCount: number;
  sampleAssignedTo: unknown; // raw shape of one opp's owner
  sampleFollowers: unknown; // raw shape of one opp's followers
}

export interface OpportunitiesResponse {
  records: OpportunityRecord[];
  pipeline: { id: string; name: string } | null;
  count: number;
  viewer?: Viewer;
  // Metadata for the Phase 2 editors (same for all records).
  fieldDefs?: EditableFieldDef[]; // OLTL opportunity custom-field definitions
  stages?: { id: string; name: string }[]; // OLTL pipeline stages (name→id)
  users?: { id: string; name: string }[]; // location users (owner picker)
  debug?: VisibilityDebug; // TEMPORARY — visibility diagnostic
}

export interface ApiError {
  error: string;
  detail?: string;
  status?: number;
}

// Resources tab — a file in the OLTL Resources media folder.
export interface ResourceFile {
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
  contactId: string; // the caregiver contact (deep-links to GHL)
  name: string;
}

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
