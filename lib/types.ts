export interface OpportunityRecord {
  id: string;

  oppName: string;
  first: string;
  last: string;
  stage: string;
  harmony: string;
  countyId: string;
  office: string;
  county: string;
  block: string;
  ref: string;
  src: string;
  rep: string;
  asst: string;
  cm: string;
  onb: string;
  cg: string;
  checked: boolean;

  ownerId: string;
  followerIds: string[];
  followerNames: string[];

  stageId: string;
  status: string;
  monetaryValue: number;
  cf: Record<string, unknown>;

  contactName: string;
  contactEmail: string;
  contactPhone: string;
  tags: string[];
  contactId: string;

  pipelineId: string;
  pipelineName: string;
  shared: boolean;

  stageChangedAt?: string;

  statusChangedAt?: string;
  createdAt?: string;

  version?: string;

  firstOpened?: string;

  newLead?: boolean;
}

export interface EditableFieldDef {
  id: string;
  name: string;
  dataType: string;
  options: string[];

  parentName?: string;
  editable: boolean;
  parentId: string;

  position: number;
}

export interface Note {
  id: string;
  who: string;
  when: string;
  txt: string;

  division?: string;

  authorId?: string;
  edited?: boolean;

  removed?: boolean;

  isMove?: boolean;
  system?: string;
  reason?: string;
}

export interface NewClientPayload {
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  pipelineId: string;
  stageId?: string;
  assignedTo?: string;
  oppName?: string;
  contactId?: string;

  details?: Record<string, string | string[]>;
}

export interface ContactMatch {
  id: string;
  name: string;
  email: string;
  phone: string;

  pipelines: { pipelineId: string; pipelineName: string; stage: string }[];
}

export interface Viewer {
  authenticated: boolean;
  isAdmin: boolean;
  userName: string | null;
  role: string | null;
  type?: string | null;
  total: number;

  homePipelineIds?: string[];

  canSeeMaster?: boolean;

  staffing?: "admin" | "any" | "self" | "off";

  canPeerTransfer?: boolean;
}

export interface OpportunitiesResponse {
  records: OpportunityRecord[];

  newLeads?: { tracking: boolean; since: string };

  failedPipelines?: { id: string; name: string; error: string }[];
  pipeline: { id: string; name: string } | null;
  count: number;
  viewer?: Viewer;

  fieldDefs?: EditableFieldDef[];

  pipelineFolders?: Record<string, string[]>;

  pipelineExclusions?: Record<string, string[]>;

  pipelineGroups?: Record<string, "caregiver" | "staff">;

  pipelineSidebarHidden?: Record<string, true>;

  pipelinesWithheld?: number;

  folderNames?: Record<string, string>;
  stages?: { id: string; name: string }[];

  users?: { id: string; name: string; divisions?: string[]; pipelineIds?: string[] }[];

  pipelines?: { id: string; name: string }[];
  stagesByPipeline?: Record<string, { id: string; name: string }[]>;

  peer?: { configured: boolean; label: string };

  tabLabels?: Record<string, string>;

  sortTargets?: { id: string; name: string }[];
}

export interface ApiError {
  error: string;
  detail?: string;
  status?: number;

  refusal?: boolean;
}

export interface ResourceFile {

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

export interface ImportPipeline {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}
export interface ImportMeta {
  pipelines: ImportPipeline[];
  fieldDefs: EditableFieldDef[];

  contactFieldDefs: EditableFieldDef[];

  tags: string[];
}

export interface ImportDuplicate {
  row: number;
  name: string;
  contactId: string;
  matchedOn: "email" | "phone";
}

export type DuplicateMode = "update" | "overwrite" | "skip";

export interface ImportRowError {
  row: number;
  error: string;
}
export interface ImportSummary {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  noted: number;
  notesSkipped: number;

  tagged: number;
  errors: ImportRowError[];

  flagged: ImportFlag[];
}

export interface ImportFlag {
  row: number;
  column: string;
  value: string;
  reason: string;
}

export interface Caregiver {
  relationId: string;
  contactId: string;
  name: string;

  role?: "caregiver" | "client";
}

export type RelationCount =
  | { caregivers: number; clients: number; unknown?: false }

  | { caregivers?: undefined; clients?: undefined; unknown: true };

export type RelationCounts = Record<string, RelationCount>;

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
