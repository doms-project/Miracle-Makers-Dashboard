import type { OpportunityRecord, EditableFieldDef } from "./types";
import { isFieldEditable } from "./editable";

// ---------------------------------------------------------------------------
// Server-only GoHighLevel client.
//
// This module must never be imported into a client component. The token is
// read from process.env here and used only in server-side fetches.
// ---------------------------------------------------------------------------

const BASE_URL = "https://services.leadconnectorhq.com";

export class GhlError extends Error {
  status: number;
  detail?: string;
  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "GhlError";
    this.status = status;
    this.detail = detail;
  }
}

function requireEnv(): { token: string; locationId: string } {
  // Trim to defend against a trailing space / newline pasted into the env var,
  // which GHL rejects as "invalid jwt". Also strip an accidental "Bearer "
  // prefix baked into the value so the scheme is controlled in one place below.
  const token = process.env.GHL_PIT?.trim().replace(/^Bearer\s+/i, "");
  const locationId = process.env.GHL_LOCATION_ID?.trim();
  if (!token) {
    throw new GhlError(
      "Server is not configured: GHL_PIT is missing.",
      500,
      "Set the GHL_PIT environment variable in Vercel (or .env.local).",
    );
  }
  if (!locationId) {
    throw new GhlError(
      "Server is not configured: GHL_LOCATION_ID is missing.",
      500,
      "Set the GHL_LOCATION_ID environment variable.",
    );
  }
  return { token, locationId };
}

// The effective auth scheme for the Authorization header. GHL's v2
// (LeadConnector) endpoints expect the Private Integration Token as a Bearer
// credential — verified against /opportunities/pipelines (raw -> 401,
// Bearer -> 200). Default to "Bearer"; override with GHL_AUTH_SCHEME for a
// different scheme, or set it to "none"/"raw" to send the bare token.
function effectiveScheme(): string {
  const override = process.env.GHL_AUTH_SCHEME?.trim();
  if (override === undefined || override === "") return "Bearer";
  if (/^(none|raw)$/i.test(override)) return "";
  return override;
}

function headers(): HeadersInit {
  const { token } = requireEnv();
  const scheme = effectiveScheme();
  return {
    Authorization: scheme ? `${scheme} ${token}` : token,
    Version: process.env.GHL_API_VERSION || "2021-07-28",
    Accept: "application/json",
  };
}

async function ghlGet<T>(path: string): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: headers(), cache: "no-store" });
  } catch (e) {
    throw new GhlError(
      "Could not reach GoHighLevel.",
      502,
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    detail = detail.slice(0, 500);
    if (res.status === 401) {
      const scheme = effectiveScheme();
      detail =
        `GHL rejected the token (auth scheme currently: ${
          scheme ? `"${scheme} <token>"` : "raw token, no prefix"
        }). ` +
        `Check for: a trailing space/newline in GHL_PIT, the wrong token/sub-account, ` +
        `or that the Private Integration has the "opportunities" scope. Flip the scheme ` +
        `with GHL_AUTH_SCHEME (Bearer, or none/raw) if needed. ` +
        `GHL said: ${detail}`;
    }
    throw new GhlError(
      `GoHighLevel returned ${res.status} for ${new URL(url).pathname}.`,
      res.status,
      detail,
    );
  }
  return (await res.json()) as T;
}

async function ghlSend<T>(
  method: "PUT" | "POST" | "PATCH",
  path: string,
  body: unknown,
): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch (e) {
    throw new GhlError(
      "Could not reach GoHighLevel.",
      502,
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    throw new GhlError(
      `GoHighLevel returned ${res.status} for ${method} ${new URL(url).pathname}.`,
      res.status,
      detail,
    );
  }
  return (await res.json()) as T;
}

// PUT /opportunities/{id} with the confirmed body shape, then return the fresh
// normalized record. `body` should already have values formatted per dataType.
export async function updateOpportunity(
  id: string,
  body: Record<string, unknown>,
): Promise<OpportunityRecord | null> {
  await ghlSend("PUT", `/opportunities/${encodeURIComponent(id)}`, body);
  return getOpportunityById(id);
}

// ---------------------------------------------------------------------------
// Lookups (pipelines, custom fields, users). Cached per warm lambda instance.
// ---------------------------------------------------------------------------

interface Pipeline {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

// Full custom-field definition — the single source of truth for editing:
// `id` for the write body, `dataType` for which input to render, `options`
// for dropdowns. Automatically covers any field added in GHL later.
export interface FieldDefinition {
  id: string;
  name: string;
  dataType: string; // e.g. TEXT, LARGE_TEXT, SINGLE_OPTIONS, MULTIPLE_OPTIONS, DATE, NUMERICAL
  fieldKey?: string;
  options?: { name?: string; value?: string }[] | string[];
}

let cache: {
  pipelines?: Pipeline[];
  fieldDefs?: FieldDefinition[]; // full opportunity custom-field definitions
  fieldMap?: Map<string, string>; // custom field id -> field name
  userMap?: Map<string, string>; // user id -> display name
} = {};

// Reused by both the read path (name resolution) and the future write path
// (id + dataType + options). Fetched once per warm lambda.
export async function getFieldDefinitions(): Promise<FieldDefinition[]> {
  if (cache.fieldDefs) return cache.fieldDefs;
  const { locationId } = requireEnv();
  let defs: FieldDefinition[] = [];
  try {
    const data = await ghlGet<{ customFields?: FieldDefinition[] }>(
      `/locations/${encodeURIComponent(locationId)}/customFields?model=opportunity`,
    );
    defs = data.customFields || [];
  } catch {
    // Non-fatal: leave empty (read path still resolves stage/owner/contact).
  }
  cache.fieldDefs = defs;
  return defs;
}

async function getPipelines(): Promise<Pipeline[]> {
  if (cache.pipelines) return cache.pipelines;
  const { locationId } = requireEnv();
  const data = await ghlGet<{ pipelines?: Pipeline[] }>(
    `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`,
  );
  cache.pipelines = data.pipelines || [];
  return cache.pipelines;
}

export async function resolvePipeline(): Promise<Pipeline> {
  const pipelines = await getPipelines();
  const configured = process.env.OLTL_PIPELINE_ID;
  if (configured) {
    const match = pipelines.find((p) => p.id === configured);
    if (match) return match;
    throw new GhlError(
      `No pipeline found with id "${configured}".`,
      404,
      `Available pipelines: ${pipelines.map((p) => `${p.name} (${p.id})`).join(", ")}`,
    );
  }
  // Fall back to matching by name when no id is configured.
  const byName = pipelines.find((p) => /oltl/i.test(p.name));
  if (byName) return byName;
  throw new GhlError(
    "Could not identify the OLTL Enrollments pipeline.",
    404,
    `Set OLTL_PIPELINE_ID. Available pipelines: ${pipelines
      .map((p) => `${p.name} (${p.id})`)
      .join(", ")}`,
  );
}

async function getFieldMap(): Promise<Map<string, string>> {
  if (cache.fieldMap) return cache.fieldMap;
  const map = new Map<string, string>();
  // Built from the same definitions fetch used by the write path.
  for (const f of await getFieldDefinitions()) {
    if (f.id) map.set(f.id, f.name || f.fieldKey || "");
  }
  cache.fieldMap = map;
  return map;
}

async function getUserMap(): Promise<Map<string, string>> {
  if (cache.userMap) return cache.userMap;
  const { locationId } = requireEnv();
  const map = new Map<string, string>();
  try {
    const data = await ghlGet<{
      users?: { id: string; name?: string; firstName?: string; lastName?: string }[];
    }>(`/users/?locationId=${encodeURIComponent(locationId)}`);
    for (const u of data.users || []) {
      const name =
        u.name || [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
      if (u.id) map.set(u.id, name);
    }
  } catch {
    // Non-fatal: owner will fall back to the raw id / "—".
  }
  cache.userMap = map;
  return map;
}

// ---------------------------------------------------------------------------
// Opportunity search + normalization.
// ---------------------------------------------------------------------------

interface RawCustomField {
  id?: string;
  key?: string;
  fieldKey?: string;
  value?: unknown;
  fieldValue?: unknown;
  fieldValueString?: unknown;
  fieldValueArray?: unknown;
}

interface RawOpportunity {
  id: string;
  name?: string;
  pipelineId?: string;
  pipelineStageId?: string;
  stageId?: string;
  assignedTo?: string | null; // owner user id (can be null)
  followers?: string[]; // follower (co-rep) user ids — confirmed field name
  source?: string; // native source field (Part A: the dashboard "Source" column)
  status?: string; // native status (open/won/lost/abandoned)
  monetaryValue?: number; // native value
  contactId?: string;
  contact?: {
    id?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
  };
  customFields?: RawCustomField[];
}

// Raw custom-field value, arrays preserved (for MULTIPLE_OPTIONS / CHECKBOX).
function cfRaw(cf: RawCustomField): unknown {
  return (
    cf.fieldValueArray ??
    cf.fieldValueString ??
    cf.fieldValue ??
    cf.value ??
    ""
  );
}

interface SearchResponse {
  opportunities?: RawOpportunity[];
  meta?: {
    total?: number;
    nextPageUrl?: string | null;
    startAfter?: number | null;
    startAfterId?: string | null;
  };
  total?: number;
}

async function searchAll(
  pipelineId: string,
): Promise<RawOpportunity[]> {
  const { locationId } = requireEnv();
  const limit = 100;
  const all: RawOpportunity[] = [];
  let startAfter: number | null | undefined;
  let startAfterId: string | null | undefined;
  // Hard cap on pages as a runaway guard (100 * 50 = 5000 records).
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({
      location_id: locationId,
      pipeline_id: pipelineId,
      limit: String(limit),
    });
    if (startAfter != null) params.set("startAfter", String(startAfter));
    if (startAfterId != null) params.set("startAfterId", startAfterId);
    const data = await ghlGet<SearchResponse>(
      `/opportunities/search?${params.toString()}`,
    );
    const batch = data.opportunities || [];
    all.push(...batch);
    const meta = data.meta;
    if (!meta || batch.length < limit) break;
    if (meta.startAfterId == null && meta.startAfter == null) break;
    // Avoid an infinite loop if the cursor doesn't advance.
    if (meta.startAfterId === startAfterId && meta.startAfter === startAfter) {
      break;
    }
    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
  }
  return all;
}

// Normalize a custom-field name into a lookup key: lowercase, alphanumeric only.
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Map normalized custom-field names to the target record keys. Multiple
// aliases per target so we tolerate slight naming differences in GHL.
const FIELD_ALIASES: Record<keyof OpportunityRecord, string[]> = {
  harmony: ["harmonyid", "harmony"],
  countyId: ["countyid"],
  office: ["office"],
  county: ["county"],
  block: ["roadblocker", "roadblock", "blocker", "roadblockers"],
  ref: ["referralsourcetype", "referralsource", "referral"], // fix: "Referral Source Type"
  src: [], // native `source` field, not a custom field — read directly (Part A)
  asst: ["salesrepassistant", "repassistant", "assistant", "salesassistant"],
  cm: ["casemanager", "casemgr"],
  onb: ["onboardingrep", "onboarding", "onboardingrepresentative"],
  cg: ["caregivername", "caregiver"], // fix: "Caregiver Name"
  checked: ["checkedthisweek", "checked", "checkedweek"],
  // Fields below are not sourced from custom fields; listed for completeness.
  id: [],
  first: [],
  last: [],
  stage: [],
  rep: [],
  ownerId: [],
  followerIds: [],
  followerNames: [],
  stageId: [],
  status: [],
  monetaryValue: [],
  cf: [],
};

// Reverse lookup: normalized alias -> target key.
const ALIAS_TO_KEY = new Map<string, keyof OpportunityRecord>();
for (const [key, aliases] of Object.entries(FIELD_ALIASES)) {
  for (const a of aliases) ALIAS_TO_KEY.set(a, key as keyof OpportunityRecord);
}

function cfValue(cf: RawCustomField): string {
  const raw =
    cf.fieldValueString ??
    cf.fieldValue ??
    cf.value ??
    cf.fieldValueArray ??
    "";
  if (Array.isArray(raw)) return raw.map((x) => String(x)).join(", ");
  if (raw == null) return "";
  return String(raw).trim();
}

function truthy(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1" || s === "checked" || s === "on";
}

function normalizeOpportunity(
  opp: RawOpportunity,
  fieldMap: Map<string, string>,
  userMap: Map<string, string>,
  stageMap: Map<string, string>,
): OpportunityRecord {
  const rec: OpportunityRecord = {
    id: opp.id,
    first: "",
    last: "",
    stage: "",
    harmony: "",
    countyId: "",
    office: "",
    county: "",
    block: "None",
    ref: "",
    src: "",
    rep: "—",
    asst: "—",
    cm: "—",
    onb: "—",
    cg: "—",
    checked: false,
    ownerId: typeof opp.assignedTo === "string" ? opp.assignedTo : "",
    followerIds: Array.isArray(opp.followers)
      ? opp.followers.filter((x): x is string => typeof x === "string")
      : [],
    followerNames: [],
    stageId: opp.pipelineStageId || opp.stageId || "",
    status: opp.status || "",
    monetaryValue: typeof opp.monetaryValue === "number" ? opp.monetaryValue : 0,
    cf: {},
  };
  // Resolve follower ids -> names via the same users lookup used for the owner.
  rec.followerNames = rec.followerIds.map((id) => userMap.get(id) || id);

  // Part A: the dashboard "Source" column is the native `source` field.
  rec.src = opp.source || "";

  // Raw custom-field values keyed by field id — drives the Phase 2 editors.
  for (const cf of opp.customFields || []) {
    if (cf.id) rec.cf[cf.id] = cfRaw(cf);
  }

  // Contact name -> first / last.
  const c = opp.contact;
  if (c?.firstName || c?.lastName) {
    rec.first = c.firstName || "";
    rec.last = c.lastName || "";
  } else {
    const full = (c?.name || opp.name || "").trim();
    const parts = full.split(/\s+/);
    rec.first = parts.shift() || "";
    rec.last = parts.join(" ");
  }

  // Stage name from stage id.
  const stageId = opp.pipelineStageId || opp.stageId || "";
  rec.stage = stageMap.get(stageId) || "";

  // Owner name.
  if (opp.assignedTo) {
    rec.rep = userMap.get(opp.assignedTo) || opp.assignedTo;
  }

  // Custom fields -> target keys by name.
  for (const cf of opp.customFields || []) {
    const fname = (cf.id && fieldMap.get(cf.id)) || cf.fieldKey || cf.key || "";
    if (!fname) continue;
    const key = ALIAS_TO_KEY.get(norm(fname));
    if (!key) continue;
    const val = cfValue(cf);
    if (key === "checked") {
      rec.checked = truthy(val);
    } else if (key === "block") {
      rec.block = val || "None";
    } else if (typeof rec[key] === "string") {
      // Only assign non-empty; keep defaults otherwise.
      if (val) (rec[key] as string) = val;
    }
  }

  if (!rec.block) rec.block = "None";
  return rec;
}

// Normalize GHL option definitions (array of strings OR {name,value}) to strings.
function optionStrings(
  options?: { name?: string; value?: string }[] | string[],
): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => (typeof o === "string" ? o : o?.value ?? o?.name ?? ""))
    .filter(Boolean) as string[];
}

// Editable field definitions for the client (id, dataType, options, editable).
export async function getEditableFieldDefs(): Promise<EditableFieldDef[]> {
  const defs = await getFieldDefinitions();
  return defs.map((d) => ({
    id: d.id,
    name: d.name,
    dataType: d.dataType,
    options: optionStrings(d.options),
    editable: isFieldEditable(d.name),
  }));
}

export async function getOltlOpportunities(): Promise<{
  records: OpportunityRecord[];
  pipeline: { id: string; name: string };
  stages: { id: string; name: string }[];
  users: { id: string; name: string }[];
  fieldDefs: EditableFieldDef[];
}> {
  const pipeline = await resolvePipeline();
  const stageMap = new Map<string, string>();
  for (const s of pipeline.stages || []) stageMap.set(s.id, s.name);

  const [fieldMap, userMap, raw, fieldDefs] = await Promise.all([
    getFieldMap(),
    getUserMap(),
    searchAll(pipeline.id),
    getEditableFieldDefs(),
  ]);

  const records = raw.map((o) =>
    normalizeOpportunity(o, fieldMap, userMap, stageMap),
  );

  const users = [...userMap.entries()].map(([id, name]) => ({ id, name }));

  return {
    records,
    pipeline: { id: pipeline.id, name: pipeline.name },
    stages: (pipeline.stages || []).map((s) => ({ id: s.id, name: s.name })),
    users,
    fieldDefs,
  };
}

// Fetch + normalize a single opportunity (used by the save route to re-check
// permissions and to return a fresh record after a write).
export async function getOpportunityById(
  id: string,
): Promise<OpportunityRecord | null> {
  let data: { opportunity?: RawOpportunity };
  try {
    data = await ghlGet<{ opportunity?: RawOpportunity }>(
      `/opportunities/${encodeURIComponent(id)}`,
    );
  } catch (e) {
    if (e instanceof GhlError && e.status === 404) return null;
    throw e;
  }
  const opp = data.opportunity;
  if (!opp) return null;
  const pipeline = await resolvePipeline();
  const stageMap = new Map<string, string>();
  for (const s of pipeline.stages || []) stageMap.set(s.id, s.name);
  const [fieldMap, userMap] = await Promise.all([getFieldMap(), getUserMap()]);
  return normalizeOpportunity(opp, fieldMap, userMap, stageMap);
}
