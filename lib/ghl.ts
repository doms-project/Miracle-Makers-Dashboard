import type {
  OpportunityRecord,
  EditableFieldDef,
  ResourceFile,
} from "./types";
import { isFieldEditable } from "./editable";
import { PIPELINE_FOLDERS } from "./fieldFolders";
import { divisionLabel } from "./division";

// Account-specific — MUST come from env (re-derive per account with
// scripts/rederive-ids-probe.mjs). No stale fallback: an unset value fails
// visibly rather than silently pointing at another account's folder.
export const RESOURCES_FOLDER_ID = (
  process.env.RESOURCES_FOLDER_ID || ""
).trim();

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

// `opts` lets a feature-specific caller additionally require an account-scoped
// id (resources folder / caregiver association) so it throws AT THE POINT OF USE
// — same fail-loud behaviour as locationId — instead of silently defaulting to
// "" (which would upload to the media root / return an empty caregiver list).
// Unrelated calls (search, pipelines, contacts) omit opts and are unaffected.
function requireEnv(opts?: {
  resourcesFolder?: boolean;
  caregiverAssociation?: boolean;
}): {
  token: string;
  locationId: string;
  resourcesFolderId: string;
  caregiverAssociationId: string;
} {
  // Trim to defend against a trailing space / newline pasted into the env var,
  // which GHL rejects as "invalid jwt". Also strip an accidental "Bearer "
  // prefix baked into the value so the scheme is controlled in one place below.
  const token = process.env.GHL_PIT?.trim().replace(/^Bearer\s+/i, "");
  const locationId = process.env.GHL_LOCATION_ID?.trim();
  const resourcesFolderId = process.env.RESOURCES_FOLDER_ID?.trim() || "";
  const caregiverAssociationId =
    process.env.CAREGIVER_ASSOCIATION_ID?.trim() || "";
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
  if (opts?.resourcesFolder && !resourcesFolderId) {
    throw new GhlError(
      "Server is not configured: RESOURCES_FOLDER_ID is missing.",
      500,
      "Re-derive it for this account (scripts/rederive-ids-probe.mjs) and set RESOURCES_FOLDER_ID.",
    );
  }
  if (opts?.caregiverAssociation && !caregiverAssociationId) {
    throw new GhlError(
      "Server is not configured: CAREGIVER_ASSOCIATION_ID is missing.",
      500,
      "Re-derive/create it for this account and set CAREGIVER_ASSOCIATION_ID.",
    );
  }
  return { token, locationId, resourcesFolderId, caregiverAssociationId };
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

function headers(version?: string): HeadersInit {
  const { token } = requireEnv();
  const scheme = effectiveScheme();
  return {
    Authorization: scheme ? `${scheme} ${token}` : token,
    Version: version || process.env.GHL_API_VERSION || "2021-07-28",
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
  // GHL returns option lists under varying keys across API versions
  // (options / picklistOptions / picklistOptionsV2), and each element may be a
  // plain string OR an object ({ value, label, name, key }). Keep it permissive
  // and normalize downstream via optionStrings().
  [key: string]: unknown;
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

// Multi-pipeline (v2). The dashboard now spans several client pipelines. The
// set is data-driven (env PIPELINE_IDS), defaulting to the five confirmed for
// the anzcWt3S0tzpu2fEaS8X account. `OLTL_PIPELINE_ID` and the `/oltl/i` name
// fallback are retired — four pipelines match that name now.
const DEFAULT_PIPELINE_IDS = [
  "KGjdCMG4F8xILk0ineB9", // OLTL Enrollment      12 stages
  "74Pt3XX4hgBIqD10mW4G", // OLTL Transfer         8
  "a14NtTi18ACxs99bHPmL", // ODP Enrollment        9
  "PIs1iWVk0HqHZFNtmoTn", // ODP Transfer          9
  "BJBWdRim6SOgjoMelVSZ", // Private Pay Clients  11
];

// Parse PIPELINE_IDS (comma / pipe / whitespace separated); fall back to the
// defaults above. Order is preserved — it drives the admin selector order.
export function pipelineIds(): string[] {
  const raw = (process.env.PIPELINE_IDS || "").trim();
  if (!raw) return DEFAULT_PIPELINE_IDS;
  const ids = raw.split(/[\s,|]+/).map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : DEFAULT_PIPELINE_IDS;
}

// Loud config check (memoized) — surfaces the two silent failure modes:
//   1. running on baked-in DEFAULT_PIPELINE_IDS because PIPELINE_IDS is unset;
//   2. a selected pipeline with no PIPELINE_FOLDERS mapping (its fields would
//      silently dump into "Other fields", which reads as working).
let _configChecked = false;
function checkPipelineConfig(): void {
  if (_configChecked) return;
  _configChecked = true;
  if (!(process.env.PIPELINE_IDS || "").trim()) {
    // eslint-disable-next-line no-console
    console.warn(
      "[config] PIPELINE_IDS is not set — using baked-in DEFAULT_PIPELINE_IDS. Set PIPELINE_IDS to control scope for this account.",
    );
  }
  const unmapped = pipelineIds().filter((id) => !PIPELINE_FOLDERS[id]);
  if (unmapped.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[config] pipeline(s) with no PIPELINE_FOLDERS mapping (fields will fall into "Other"): ${unmapped.join(", ")}. Add them to lib/fieldFolders.ts.`,
    );
  }
}

// Resolve the configured pipeline IDs to full Pipeline objects, in configured
// order. Unknown IDs are skipped (logged via the error only if NONE match).
export async function getSelectedPipelines(): Promise<Pipeline[]> {
  checkPipelineConfig();
  const pipelines = await getPipelines();
  const byId = new Map(pipelines.map((p) => [p.id, p]));
  const selected: Pipeline[] = [];
  for (const id of pipelineIds()) {
    const p = byId.get(id);
    if (p) selected.push(p);
  }
  if (!selected.length) {
    throw new GhlError(
      "None of the configured PIPELINE_IDS matched this account's pipelines.",
      404,
      `Configured: ${pipelineIds().join(", ")}. Available: ${pipelines
        .map((p) => `${p.name} (${p.id})`)
        .join(", ")}`,
    );
  }
  return selected;
}

// Composite stage-map key — stage names repeat across pipelines
// (TRANSFERRED IN, UNCATEGORIZED, INACTIVE, LOST all exist in several), so the
// map MUST be keyed by pipelineId + stageId, never by name alone.
function stageKey(pipelineId: string, stageId: string): string {
  return `${pipelineId}::${stageId}`;
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

// Exported so write routes can VALIDATE user ids (e.g. followers) against the
// location's real users before writing — an arbitrary string would otherwise be
// stored and render as "Former user", indistinguishable from a deleted account.
export async function getLocationUserIds(): Promise<Set<string>> {
  return new Set((await getUserMap()).keys());
}

// The users lookup is fetched SERVER-SIDE with the PIT and is NOT gated on the
// viewer's role — every viewer gets the same map. It backs owner names, follower
// names, the owner dropdown and the follower picker, so an empty map degrades
// all of them at once.
//
// It used to swallow the error AND cache the empty result, which made a single
// transient failure (or a PIT missing the users scope) permanent for the life of
// that warm lambda: every later request on that instance silently rendered raw
// ids. Now a failure is logged loudly and NOT cached, so the next request retries.
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
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      "[users] lookup FAILED — owner/follower names and the owner + follower pickers will be empty. Check the PIT's users.readonly scope.",
      e instanceof Error ? e.message : String(e),
    );
    return map; // do NOT cache a failure — retry on the next request
  }
  if (!map.size) {
    // eslint-disable-next-line no-console
    console.warn(
      "[users] lookup returned ZERO users — pickers will be empty. Not caching, will retry.",
    );
    return map;
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
  contactId: [],
  pipelineId: [],
  pipelineName: [],
  shared: [],
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
  stageNameByKey: Map<string, string>, // key = pipelineId::stageId
  pipelineNameById: Map<string, string>,
): OpportunityRecord {
  const pipelineId = opp.pipelineId || "";
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
    contactId: opp.contactId || opp.contact?.id || "",
    pipelineId,
    pipelineName: pipelineNameById.get(pipelineId) || "",
    shared: false, // set true later by the access filter for non-home pipelines
  };
  // Resolve follower ids -> names via the same users lookup used for the owner.
  // Never leak a raw user id to the UI — an unresolvable id reads "Former user"
  // everywhere (matches userLabel() in app/page.tsx).
  rec.followerNames = rec.followerIds.map(
    (id) => userMap.get(id) || "Former user",
  );

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

  // Stage name from pipelineId + stage id (names repeat across pipelines).
  const stageId = opp.pipelineStageId || opp.stageId || "";
  rec.stage = stageNameByKey.get(stageKey(pipelineId, stageId)) || "";

  // Owner name — same rule: an unresolvable id reads "Former user", never the
  // raw id (this leaked in the list "Rep" column and on board cards too).
  if (opp.assignedTo) {
    rec.rep = userMap.get(opp.assignedTo) || "Former user";
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

// Normalize a single option element (string OR object) to its stored string.
function optionToString(o: unknown): string {
  if (o == null) return "";
  if (typeof o === "string") return o;
  if (typeof o === "object") {
    const r = o as Record<string, unknown>;
    // Prefer the value GHL actually stores; fall back to a human label.
    const v = r.value ?? r.name ?? r.label ?? r.key ?? r.option ?? "";
    return typeof v === "string" ? v : String(v ?? "");
  }
  return String(o);
}

// Pull option strings out of a field definition, tolerant of GHL's varying
// shapes: any property whose name contains "option" and holds an array is
// treated as the option list (options, picklistOptions, picklistOptionsV2, …).
function optionStrings(def: FieldDefinition): string[] {
  const collected: unknown[] = [];
  for (const [k, v] of Object.entries(def)) {
    if (/option/i.test(k) && Array.isArray(v)) collected.push(...v);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const el of collected) {
    const s = optionToString(el).trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// Editable field definitions for the client (id, dataType, options, editable).
export async function getEditableFieldDefs(): Promise<EditableFieldDef[]> {
  const defs = await getFieldDefinitions();
  return defs.map((d) => ({
    id: d.id,
    name: d.name,
    dataType: d.dataType,
    options: optionStrings(d),
    editable: isFieldEditable(d.name),
    parentId: String(
      (d as Record<string, unknown>).parentId ??
        (d as Record<string, unknown>).folderId ??
        "",
    ),
    // GHL's authored order within the folder. Missing/unparseable sorts last
    // (Number.MAX_SAFE_INTEGER) so it falls back to the name sort downstream.
    position: (() => {
      const p = Number((d as Record<string, unknown>).position);
      return Number.isFinite(p) ? p : Number.MAX_SAFE_INTEGER;
    })(),
  }));
}

export async function getOltlOpportunities(): Promise<{
  records: OpportunityRecord[];
  pipeline: { id: string; name: string } | null;
  pipelines: { id: string; name: string }[];
  stages: { id: string; name: string }[];
  stagesByPipeline: Record<string, { id: string; name: string }[]>;
  users: { id: string; name: string }[];
  fieldDefs: EditableFieldDef[];
}> {
  const selected = await getSelectedPipelines();

  // Build: composite stage map (pipelineId::stageId -> name), pipeline-name
  // lookup, per-pipeline stage lists, and a deduped union of stages.
  const stageNameByKey = new Map<string, string>();
  const pipelineNameById = new Map<string, string>();
  const stagesByPipeline: Record<string, { id: string; name: string }[]> = {};
  const unionSeen = new Set<string>();
  const unionStages: { id: string; name: string }[] = [];
  for (const p of selected) {
    pipelineNameById.set(p.id, p.name);
    stagesByPipeline[p.id] = (p.stages || []).map((s) => ({ id: s.id, name: s.name }));
    for (const s of p.stages || []) {
      stageNameByKey.set(stageKey(p.id, s.id), s.name);
      if (!unionSeen.has(s.id)) {
        unionSeen.add(s.id);
        unionStages.push({ id: s.id, name: s.name });
      }
    }
  }

  // Shared lookups (fetched once, in parallel).
  const [fieldMap, userMap, fieldDefs] = await Promise.all([
    getFieldMap(),
    getUserMap(),
    getEditableFieldDefs(),
  ]);

  // Fetch each pipeline's opportunities SEQUENTIALLY to stay well under GHL's
  // 100-req/10s burst limit. Budget: ceil(records/100) pages per pipeline. Even
  // the largest observed (OLTL Transfer, 100+ ≈ 2 pages) across five pipelines
  // plus the three shared lookups totals ~10-15 requests — comfortably safe.
  const raw: RawOpportunity[] = [];
  for (const p of selected) {
    const batch = await searchAll(p.id);
    // GHL returns pipelineId on each opp; stamp it as a fallback so stage +
    // pipeline resolution is never ambiguous.
    for (const o of batch) if (!o.pipelineId) o.pipelineId = p.id;
    raw.push(...batch);
  }

  const records = raw.map((o) =>
    normalizeOpportunity(o, fieldMap, userMap, stageNameByKey, pipelineNameById),
  );

  const users = [...userMap.entries()].map(([id, name]) => ({ id, name }));

  return {
    records,
    pipeline: null, // v2: no single pipeline — see `pipelines`
    pipelines: selected.map((p) => ({ id: p.id, name: p.name })),
    stages: unionStages,
    stagesByPipeline,
    users,
    fieldDefs,
  };
}

// ---------------------------------------------------------------------------
// Contact notes — scoped to an opportunity via the note `relations` array.
// ---------------------------------------------------------------------------

interface RawNote {
  id?: string;
  body?: string;
  userId?: string;
  dateAdded?: string;
  relations?: { objectKey?: string; recordId?: string }[];
}

export interface OppNote {
  id: string;
  who: string; // author name
  when: string; // formatted date
  txt: string; // body text
}

function fmtNoteDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function noteBelongsToOpp(n: RawNote, oppId: string): boolean {
  return (n.relations || []).some(
    (r) => r.objectKey === "opportunity" && r.recordId === oppId,
  );
}

// List a contact's notes, filtered to just this opportunity's, newest first.
export async function listOpportunityNotes(
  contactId: string,
  oppId: string,
): Promise<OppNote[]> {
  const data = await ghlGet<{ notes?: RawNote[] }>(
    `/contacts/${encodeURIComponent(contactId)}/notes`,
  );
  const userMap = await getUserMap();
  return (data.notes || [])
    .filter((n) => noteBelongsToOpp(n, oppId))
    .sort(
      (a, b) =>
        new Date(b.dateAdded || 0).getTime() -
        new Date(a.dateAdded || 0).getTime(),
    )
    .map((n) => ({
      id: n.id || "",
      who: (n.userId && userMap.get(n.userId)) || "GoHighLevel",
      when: fmtNoteDate(n.dateAdded),
      txt: n.body || "",
    }));
}

// Add a note on the contact, related to both the opportunity and the contact so
// it appears under the opportunity's Notes/Associated objects in native GHL.
export async function addOpportunityNote(
  contactId: string,
  oppId: string,
  body: string,
  userId: string,
): Promise<OppNote> {
  const res = await ghlSend<{ note?: RawNote }>(
    "POST",
    `/contacts/${encodeURIComponent(contactId)}/notes`,
    {
      body,
      userId,
      relations: [
        { objectKey: "opportunity", recordId: oppId },
        { objectKey: "contact", recordId: contactId },
      ],
    },
  );
  const userMap = await getUserMap();
  const n = res.note || {};
  return {
    id: n.id || "",
    who: (userId && userMap.get(userId)) || "You",
    when: fmtNoteDate(n.dateAdded) || "just now",
    txt: n.body || body,
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
  // Build the composite stage map + pipeline-name lookup across all selected
  // pipelines, so this single opp resolves its stage name by pipelineId+stageId.
  const selected = await getSelectedPipelines();
  const stageNameByKey = new Map<string, string>();
  const pipelineNameById = new Map<string, string>();
  for (const p of selected) {
    pipelineNameById.set(p.id, p.name);
    for (const s of p.stages || []) stageNameByKey.set(stageKey(p.id, s.id), s.name);
  }
  const [fieldMap, userMap] = await Promise.all([getFieldMap(), getUserMap()]);
  return normalizeOpportunity(opp, fieldMap, userMap, stageNameByKey, pipelineNameById);
}

// ---------------------------------------------------------------------------
// Resources — files in the OLTL Resources media folder only.
//
// The Media Library is shared across the whole sub-account, so we scope BOTH at
// the API (parentId param) AND again in code (belt-and-suspenders) to the
// RESOURCES_FOLDER_ID. Media URLs are signed with a TTL, so we always LIST fresh
// (never store a URL). Field names vary across GHL versions — read defensively.
// ---------------------------------------------------------------------------

interface RawMedia {
  _id?: string;
  id?: string;
  name?: string;
  fileName?: string;
  originalName?: string;
  url?: string;
  fileUrl?: string;
  link?: string;
  parentId?: string;
  folderId?: string;
  type?: string;
  mimeType?: string;
  contentType?: string;
  size?: number;
  fileSize?: number;
}

export async function listResources(): Promise<ResourceFile[]> {
  const { locationId, resourcesFolderId } = requireEnv({ resourcesFolder: true });
  const folderId = resourcesFolderId;
  const limit = 100;
  const all: RawMedia[] = [];
  for (let page = 0, offset = 0; page < 50; page++, offset += limit) {
    const params = new URLSearchParams({
      altType: "location",
      altId: locationId,
      type: "file",
      sortBy: "createdAt",
      sortOrder: "desc",
      parentId: folderId, // scope at the API when supported…
      limit: String(limit),
      offset: String(offset),
    });
    const data = await ghlGet<{ files?: RawMedia[]; medias?: RawMedia[] }>(
      `/medias/files?${params.toString()}`,
    );
    const batch = data.files || data.medias || [];
    all.push(...batch);
    if (batch.length < limit) break;
  }
  // …and filter again in code so a mis-supported param can never leak the library.
  return all
    .filter((f) => String(f.parentId ?? f.folderId ?? "") === folderId)
    .map((f) => ({
      name: String(f.name ?? f.fileName ?? f.originalName ?? "Untitled"),
      url: String(f.url ?? f.fileUrl ?? f.link ?? ""),
      type: String(f.type ?? f.mimeType ?? f.contentType ?? ""),
      size: Number(f.size ?? f.fileSize ?? 0) || 0,
    }))
    .filter((f) => f.url);
}

// ---------------------------------------------------------------------------
// Bulk import — list all pipelines, upsert contacts (dedupe), create opps.
// ---------------------------------------------------------------------------

export async function listPipelines(): Promise<
  { id: string; name: string; stages: { id: string; name: string }[] }[]
> {
  const ps = await getPipelines();
  return ps.map((p) => ({
    id: p.id,
    name: p.name,
    stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name })),
  }));
}

// Upsert dedupes by email/phone at GHL; `isNew` distinguishes created vs matched.
export async function upsertContact(fields: {
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  source?: string;
  customFields?: { id: string; value: unknown }[];
}): Promise<{ id: string; isNew: boolean }> {
  const { locationId } = requireEnv();
  const body: Record<string, unknown> = { locationId };
  for (const k of ["firstName", "lastName", "name", "email", "phone", "source"] as const)
    if (fields[k]) body[k] = fields[k];
  if (fields.customFields?.length) body.customFields = fields.customFields;
  const res = await ghlSend<{ contact?: { id?: string }; new?: boolean }>(
    "POST",
    "/contacts/upsert",
    body,
  );
  return { id: res.contact?.id || "", isNew: res.new !== false };
}

export async function createOpportunity(o: {
  pipelineId: string;
  stageId: string;
  contactId: string;
  name: string;
  source?: string;
  status?: string;
  customFields?: { id: string; value: unknown }[];
}): Promise<string> {
  const { locationId } = requireEnv();
  const body: Record<string, unknown> = {
    pipelineId: o.pipelineId,
    locationId,
    pipelineStageId: o.stageId,
    contactId: o.contactId,
    name: o.name,
    status: o.status || "open",
  };
  if (o.source) body.source = o.source;
  if (o.customFields?.length) body.customFields = o.customFields;
  const res = await ghlSend<{ opportunity?: { id?: string }; id?: string }>(
    "POST",
    "/opportunities/",
    body,
  );
  return res.opportunity?.id || res.id || "";
}

// ---------------------------------------------------------------------------
// The Move action (Task 6).
//
// One control; the system classifies. Two paths:
//
//   owner UNCHANGED -> simple move: change pipelineId + stage. Nothing else.
//   owner CHANGED   -> transfer. ORDERING IS DELIBERATE:
//     0. PREFLIGHT (no writes): destination pipeline resolves, it HAS a
//        "TRANSFERRED IN" stage, and the new owner is a real location user.
//     1. PUT #1 — assignedTo + Transferred From/Date (+ Transfer Reason) in ONE
//        atomic write. The owner change is the step that can fail for permission
//        reasons, so it goes FIRST: if it fails, NOTHING has been written and the
//        record is untouched. (Stamping first would leave a record marked
//        "transferred" while still owned by the old rep.)
//     2. Clear followers — all except the new owner (G1: a transferred lead must
//        leave the old division entirely).
//     3. Note with the reason — written AFTER the owner actually moved, so a note
//        can never claim a transfer that did not happen.
//     4. PUT #2 — pipelineId + stage = TRANSFERRED IN. MUST come after the owner
//        change: GHL blocks revoking pipeline access from a user who still owns
//        opportunities in that pipeline.
//
// No tag is written: GHL tags are contact-scoped, so a transfer tag on a contact
// with several opportunities cannot identify which record moved. The
// opportunity-scoped Transferred From / Transferred Date / note carry the history.
//
// There are no transactions — on a step failure we STOP and report exactly which
// steps completed, rather than silently half-moving.
// ---------------------------------------------------------------------------

export interface MoveResult {
  transferred: boolean; // false = simple move
  steps: string[]; // completed steps, in order
  failedStep?: string; // set when we stopped early
  error?: string;
  stranded?: boolean; // owner moved but the record never left the source pipeline
  attemptedFollowerRemovals?: string[]; // ids we asked GHL to clear (on failure)
}

const normOpt = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");

// Find a field definition by (normalized) name — never by hardcoded id.
function findDefByName(
  defs: FieldDefinition[],
  name: string,
): FieldDefinition | undefined {
  const target = norm(name);
  return defs.find((d) => norm(d.name || "") === target);
}

// Match a pipeline NAME to one of a SINGLE_OPTIONS field's option values.
// Tolerates singular/plural drift ("ODP Enrollment" vs the option "ODP
// Enrollments") without hardcoding either spelling.
function matchOption(options: string[], value: string): string | null {
  const v = normOpt(value);
  for (const o of options) if (normOpt(o) === v) return o;
  return null;
}

// Division follows the pipeline. The account was backfilled once from each
// record's pipeline, but that is a SNAPSHOT — the first record moved between
// pipelines would carry a stale Division and drift from there. So whenever Move
// changes the pipeline, it writes Division in the SAME PUT (no extra call, no
// new failure point).
//
// The value is derived with divisionLabel(pipelineName) — the same function the
// UI uses — so there is ONE source of truth, not a second hardcoded map. The
// field is SINGLE_OPTIONS, so the label is matched against its real options and
// skipped if nothing matches (never write an invalid option).
//
// Division stays a normal EDITABLE field: Move only ensures it is right by
// default when the pipeline changes. It is deliberately NOT in READ_ONLY_FIELDS.
async function divisionCustomField(
  destPipelineName: string,
): Promise<{ id: string; value: unknown }[]> {
  const defs = await getFieldDefinitions();
  const def = findDefByName(defs, "Division");
  if (!def) return [];
  const label = divisionLabel(destPipelineName);
  if (!label) return [];
  const opts = optionStrings(def);
  const value = opts.length ? matchOption(opts, label) : label;
  if (!value) {
    // eslint-disable-next-line no-console
    console.warn(
      `[move] Division not written: "${label}" is not one of the field's options (${opts.join(", ")}).`,
    );
    return [];
  }
  return [{ id: def.id, value }];
}

export async function moveOpportunity(args: {
  oppId: string;
  toPipelineId: string;
  toStageId?: string; // honoured on the simple path only
  newOwnerId?: string | null; // undefined/equal to current => simple move
  reason?: string;
  actorUserId: string; // note authorship (server-derived)
  addSenderAsFollower?: boolean; // Option A switch; default OFF (Option B)
}): Promise<MoveResult> {
  const steps: string[] = [];
  const current = await getOpportunityById(args.oppId);
  if (!current)
    throw new GhlError("Opportunity not found.", 404, `id ${args.oppId}`);

  const isTransfer =
    typeof args.newOwnerId === "string" &&
    (args.newOwnerId || "") !== (current.ownerId || "");

  // ---- PREFLIGHT (no writes) ----
  const pipelines = await getSelectedPipelines();
  const dest = pipelines.find((p) => p.id === args.toPipelineId);
  if (!dest)
    throw new GhlError(
      "Destination pipeline is not available.",
      400,
      `${args.toPipelineId} is not in PIPELINE_IDS.`,
    );

  let destStageId = args.toStageId || "";
  if (isTransfer) {
    // Transfers always land in TRANSFERRED IN — verify it EXISTS before any
    // write, otherwise we would fail at the final step with the owner already moved.
    const ti = (dest.stages || []).find(
      (s) => (s.name || "").trim().toUpperCase() === "TRANSFERRED IN",
    );
    if (!ti)
      throw new GhlError(
        `"${dest.name}" has no TRANSFERRED IN stage.`,
        400,
        "Add a TRANSFERRED IN stage to that pipeline before transferring into it.",
      );
    destStageId = ti.id;
    const validUsers = await getLocationUserIds();
    if (!args.newOwnerId || !validUsers.has(args.newOwnerId))
      throw new GhlError(
        "New owner is not a user of this location.",
        400,
        String(args.newOwnerId ?? ""),
      );
  } else {
    if (!destStageId) {
      const first = (dest.stages || [])[0];
      if (!first)
        throw new GhlError(`"${dest.name}" has no stages.`, 400);
      destStageId = first.id;
    } else if (!(dest.stages || []).some((s) => s.id === destStageId)) {
      throw new GhlError(
        "Chosen stage does not belong to the destination pipeline.",
        400,
        destStageId,
      );
    }
  }
  steps.push("preflight");

  // Division follows the pipeline — only when the pipeline actually changes
  // (a stage-only move within the same pipeline must not touch it).
  const pipelineChanged = args.toPipelineId !== current.pipelineId;
  const divisionCf = pipelineChanged
    ? await divisionCustomField(dest.name)
    : [];

  // ---- SIMPLE MOVE ----
  if (!isTransfer) {
    await ghlSend("PUT", `/opportunities/${encodeURIComponent(args.oppId)}`, {
      pipelineId: args.toPipelineId,
      pipelineStageId: destStageId,
      ...(divisionCf.length ? { customFields: divisionCf } : {}),
    });
    steps.push(
      `moved pipeline+stage${divisionCf.length ? " + Division" : ""}`,
    );
    return { transferred: false, steps };
  }

  // ---- TRANSFER ----
  const defs = await getFieldDefinitions();
  const fromDef = findDefByName(defs, "Transferred From");
  const dateDef = findDefByName(defs, "Transferred Date");
  const reasonDef = findDefByName(defs, "Transfer Reason");
  const sourceName =
    pipelines.find((p) => p.id === current.pipelineId)?.name || "";

  const customFields: { id: string; value: unknown }[] = [];
  if (fromDef && sourceName) {
    // SINGLE_OPTIONS — must send an EXISTING option value.
    const opts = optionStrings(fromDef);
    const matched = opts.length ? matchOption(opts, sourceName) : sourceName;
    if (matched) customFields.push({ id: fromDef.id, value: matched });
  }
  if (dateDef)
    customFields.push({
      id: dateDef.id,
      value: new Date().toISOString().slice(0, 10),
    });
  if (reasonDef && args.reason?.trim())
    customFields.push({ id: reasonDef.id, value: args.reason.trim() });

  // 1. Owner + stamps in ONE atomic write (fails => nothing written).
  try {
    await ghlSend("PUT", `/opportunities/${encodeURIComponent(args.oppId)}`, {
      assignedTo: args.newOwnerId,
      ...(customFields.length ? { customFields } : {}),
    });
    steps.push("owner changed + transfer stamps");
  } catch (e) {
    return {
      transferred: false,
      steps,
      failedStep: "owner change",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // 2. Clear followers — all except the new owner (G1).
  // removeOpportunityFollowers sends ONE DELETE with the whole array (no loop),
  // so we never partially clear from this side. GHL's server-side handling of a
  // failed batch is unverified, so on failure we report exactly which ids were
  // ATTEMPTED — any still attached keep shared access until cleared manually.
  const toRemove = current.followerIds.filter((f) => f !== args.newOwnerId);
  try {
    if (toRemove.length) {
      await removeOpportunityFollowers(args.oppId, toRemove);
      steps.push(`cleared ${toRemove.length} follower(s)`);
    }
    if (args.addSenderAsFollower && current.ownerId) {
      await addOpportunityFollowers(args.oppId, [current.ownerId]);
      steps.push("kept sender as follower");
    }
  } catch (e) {
    return {
      transferred: true,
      steps,
      failedStep: "clear followers",
      error: e instanceof Error ? e.message : String(e),
      attemptedFollowerRemovals: toRemove,
    };
  }

  // 3. Note — only now, when the transfer is real.
  try {
    if (current.contactId) {
      const toName = (await getUserMap()).get(args.newOwnerId!) || args.newOwnerId!;
      const body =
        `Moved from ${sourceName || "—"} to ${dest.name}. New owner: ${toName}.` +
        (args.reason?.trim() ? ` Reason: ${args.reason.trim()}` : "");
      await addOpportunityNote(current.contactId, args.oppId, body, args.actorUserId);
      steps.push("note written");
    }
  } catch (e) {
    return {
      transferred: true,
      steps,
      failedStep: "note",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // 4. Pipeline + TRANSFERRED IN — after the owner change (GHL constraint).
  // This is the step whose failure STRANDS the record: the owner has already
  // changed and followers are cleared, but the record is still in the SOURCE
  // pipeline — which is not in the new owner's home set, so they see it only as
  // "shared", and the previous owner cannot see it at all. Nobody finds it by
  // browsing. Retry a couple of times before giving up, then flag it loudly.
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ghlSend("PUT", `/opportunities/${encodeURIComponent(args.oppId)}`, {
        pipelineId: args.toPipelineId,
        pipelineStageId: destStageId,
        // Division rides along with the pipeline change (same PUT).
        ...(divisionCf.length ? { customFields: divisionCf } : {}),
      });
      steps.push(
        `moved pipeline+stage (TRANSFERRED IN)${divisionCf.length ? " + Division" : ""}${attempt > 1 ? ` after ${attempt} attempts` : ""}`,
      );
      return { transferred: true, steps };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }
  return {
    transferred: true,
    stranded: true,
    steps,
    failedStep: "move pipeline",
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  };
}

// ---------------------------------------------------------------------------
// Followers (Task 5) — dedicated add/remove endpoints (no full-opportunity PUT).
// GHL sends NO native notification to a newly added follower. Shapes follow
// GHL v2; scripts/followers-probe.mjs confirms them live. Each returns the
// response's follower array best-effort, but the route recomputes the final set
// from the known current followers so it never depends on the response shape.
// ---------------------------------------------------------------------------
export async function addOpportunityFollowers(
  oppId: string,
  userIds: string[],
): Promise<string[]> {
  if (!userIds.length) return [];
  const res = await ghlSend<{ followers?: string[]; followersAdded?: string[] }>(
    "POST",
    `/opportunities/${encodeURIComponent(oppId)}/followers`,
    { followers: userIds },
  );
  return res.followers ?? res.followersAdded ?? [];
}

export async function removeOpportunityFollowers(
  oppId: string,
  userIds: string[],
): Promise<string[]> {
  if (!userIds.length) return [];
  // DELETE with a JSON body — ghlSend only covers PUT/POST/PATCH.
  const url = `${BASE_URL}/opportunities/${encodeURIComponent(oppId)}/followers`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "DELETE",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ followers: userIds }),
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
      detail = (await res.text()).slice(0, 400);
    } catch {
      /* ignore */
    }
    throw new GhlError(
      `GoHighLevel returned ${res.status} for DELETE /opportunities/{id}/followers.`,
      res.status,
      detail,
    );
  }
  const j = (await res.json().catch(() => ({}))) as {
    followers?: string[];
    followersRemoved?: string[];
  };
  return j.followers ?? j.followersRemoved ?? [];
}

// ---------------------------------------------------------------------------
// Resources upload (Task 1) — multipart to the GHL Media Library.
// Server-only; the token never leaves this module. `parentId` targets the
// OLTL Resources folder so uploads don't pollute the media root. NOTE: some
// GHL tenants ignore parentId on upload and drop the file at root — the
// probe (scripts/resources-upload-probe.mjs) verifies this live. If it lands
// at root, listResources() (which filters by parentId) simply won't show it.
// ---------------------------------------------------------------------------
export async function uploadResource(file: {
  buffer: ArrayBuffer;
  filename: string;
  contentType: string;
}): Promise<{ id: string; url: string; name: string }> {
  const { resourcesFolderId } = requireEnv({ resourcesFolder: true });
  const form = new FormData();
  const blob = new Blob([file.buffer], {
    type: file.contentType || "application/octet-stream",
  });
  // GHL /medias/upload-file form fields.
  form.append("file", blob, file.filename);
  form.append("hosted", "false");
  form.append("name", file.filename);
  form.append("parentId", resourcesFolderId);

  const url = `${BASE_URL}/medias/upload-file`;
  // IMPORTANT: do NOT set Content-Type here — fetch derives the multipart
  // boundary from the FormData automatically. `headers()` only sets auth +
  // Version + Accept, which is exactly what we want.
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: headers(), body: form });
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
    if (res.status === 401)
      detail = `${detail} (The PIT likely needs the medias/media WRITE scope — add it to the Private Integration.)`;
    throw new GhlError(
      `GoHighLevel returned ${res.status} for POST /medias/upload-file.`,
      res.status,
      detail,
    );
  }
  const j = (await res.json().catch(() => ({}))) as {
    id?: string;
    fileId?: string;
    url?: string;
    fileUrl?: string;
    name?: string;
  };
  return {
    id: String(j.id ?? j.fileId ?? ""),
    url: String(j.url ?? j.fileUrl ?? ""),
    name: String(j.name ?? file.filename),
  };
}

// ---------------------------------------------------------------------------
// Associations / relations (Task 4) — caregiver <-> client links.
// The many-to-many association id is fixed for this tenant. Endpoint shapes
// follow GHL v2; the probe (scripts/associations-probe.mjs) confirms the exact
// query params + delete shape live. Every helper surfaces a clear GhlError so a
// PIT that lacks associations access fails loudly, not silently.
// ---------------------------------------------------------------------------
// The caregiver_client association id is account-specific and is now read +
// guarded via requireEnv({ caregiverAssociation: true }) at each point of use,
// so it fails loudly when unset (no module-level const / stale fallback).

export interface CaregiverRelation {
  relationId: string; // used to DELETE the link
  contactId: string; // the caregiver contact
  name: string;
}

interface RawRelation {
  id?: string;
  _id?: string;
  relationId?: string;
  associationId?: string;
  firstRecordId?: string;
  secondRecordId?: string;
  firstObjectKey?: string;
  secondObjectKey?: string;
  [key: string]: unknown;
}

interface RawContact {
  id?: string;
  contactId?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  contactName?: string;
  email?: string;
  [key: string]: unknown;
}

const contactDisplay = (c: RawContact): string =>
  (c.name || c.contactName || [c.firstName, c.lastName].filter(Boolean).join(" "))
    ?.toString()
    .trim() ||
  c.email?.toString().trim() ||
  "Unnamed contact";

// List the caregivers associated with a given client contact. `clientContactId`
// is the opportunity's linked contact. Returns each relation's id (for removal)
// and the caregiver contact id + name.
export async function listCaregiverRelations(
  clientContactId: string,
): Promise<CaregiverRelation[]> {
  const { locationId, caregiverAssociationId } = requireEnv({
    caregiverAssociation: true,
  });
  // GHL "get relations by record": the record id goes in the PATH, and the only
  // accepted query params are locationId + skip + limit (both required). Passing
  // recordId/associationId as query props returns 422 ("property should not
  // exist"). The endpoint returns ALL of the record's relations across every
  // association, so we filter to the caregiver_client association in code.
  const params = new URLSearchParams({
    locationId,
    skip: "0",
    limit: "100",
  });
  const data = await ghlGet<{ relations?: RawRelation[] }>(
    `/associations/relations/${encodeURIComponent(clientContactId)}?${params.toString()}`,
  );
  const relations = (data.relations || []).filter(
    (r) => String(r.associationId ?? "") === caregiverAssociationId,
  );
  // The caregiver is whichever side of the relation is NOT the client contact.
  const caregiverIds = relations.map((r) => {
    const rid = String(r.id ?? r._id ?? r.relationId ?? "");
    const other =
      String(r.firstRecordId ?? "") === clientContactId
        ? String(r.secondRecordId ?? "")
        : String(r.firstRecordId ?? "");
    return { relationId: rid, contactId: other };
  });
  // Resolve names (best-effort; a failed lookup still shows the id).
  const out: CaregiverRelation[] = [];
  for (const c of caregiverIds) {
    if (!c.contactId) continue;
    let name = c.contactId;
    try {
      const cd = await ghlGet<{ contact?: RawContact }>(
        `/contacts/${encodeURIComponent(c.contactId)}`,
      );
      if (cd.contact) name = contactDisplay(cd.contact);
    } catch {
      /* keep id as name */
    }
    out.push({ relationId: c.relationId, contactId: c.contactId, name });
  }
  return out;
}

// Typeahead: search contacts filtered to Record Type = "Caregiver" so clients
// never appear. Record Type on this tenant is a contact custom field; we filter
// defensively both at the API (when supported) and in code.
export async function searchCaregiverContacts(
  query: string,
): Promise<{ id: string; name: string; email: string }[]> {
  const { locationId } = requireEnv();
  if (!query.trim()) return [];
  const body = {
    locationId,
    page: 1,
    pageLimit: 20,
    query: query.trim(),
  };
  const data = await ghlSend<{ contacts?: RawContact[] }>(
    "POST",
    "/contacts/search",
    body,
  );
  const contacts = data.contacts || [];
  const isCaregiver = (c: RawContact): boolean => {
    // Look for a Record Type value of "Caregiver" anywhere obvious.
    const rt =
      (c.recordType as string) ??
      (c.type as string) ??
      (c.contactType as string) ??
      "";
    if (String(rt).toLowerCase().includes("caregiver")) return true;
    // customFields may carry Record Type; scan permissively.
    const cf = c.customFields;
    if (Array.isArray(cf)) {
      for (const f of cf as { value?: unknown }[]) {
        if (String(f?.value ?? "").toLowerCase() === "caregiver") return true;
      }
    }
    return false;
  };
  const filtered = contacts.filter(isCaregiver);
  // If the tenant doesn't expose Record Type on search, fall back to all
  // matches rather than showing nothing (the picker still assigns a real
  // contact; the caller is warned in the UI note).
  const list = filtered.length ? filtered : contacts;
  return list.map((c) => ({
    id: String(c.id ?? c.contactId ?? ""),
    name: contactDisplay(c),
    email: String(c.email ?? ""),
  }));
}

export async function createCaregiverRelation(
  clientContactId: string,
  caregiverContactId: string,
): Promise<string> {
  const { locationId, caregiverAssociationId } = requireEnv({
    caregiverAssociation: true,
  });
  const body = {
    locationId,
    associationId: caregiverAssociationId,
    firstRecordId: clientContactId,
    secondRecordId: caregiverContactId,
  };
  const res = await ghlSend<{ relation?: RawRelation; id?: string }>(
    "POST",
    "/associations/relations",
    body,
  );
  return String(res.relation?.id ?? res.id ?? "");
}

// Fetch a contact's display name + email (for email recipients).
export async function getContactBrief(
  contactId: string,
): Promise<{ id: string; name: string; email: string }> {
  const data = await ghlGet<{ contact?: RawContact }>(
    `/contacts/${encodeURIComponent(contactId)}`,
  );
  const c = data.contact || {};
  return {
    id: contactId,
    name: contactDisplay(c),
    email: String(c.email ?? ""),
  };
}

// The Version header the email endpoints want. GHL's outbound-message +
// templates endpoints are documented against 2021-04-15 (different from the
// 2021-07-28 the rest of the v2 API uses). Overridable per tenant without a code
// change; the probe confirms which this location accepts.
const EMAIL_API_VERSION = (
  process.env.GHL_EMAIL_API_VERSION || "2021-04-15"
).trim();

// A verified sending address is required by GHL for outbound email; it must
// belong to the authenticated sub-account domain. Set once the domain is
// authenticated (Jack/DNS). When blank we omit it and let GHL use the
// sub-account default.
const EMAIL_FROM = (process.env.GHL_EMAIL_FROM || "").trim();

export interface EmailTemplateLite {
  id: string;
  name: string;
  subject: string;
  body: string; // HTML (GHL email-builder output) or plain text
}

interface RawTemplate {
  id?: string;
  _id?: string;
  templateId?: string;
  name?: string;
  title?: string;
  subject?: string;
  body?: string;
  html?: string;
  template?: { html?: string; body?: string; subject?: string };
  [key: string]: unknown;
}

// Step 1 — pull the sub-account's EMAIL templates from GHL so Jack's team can
// manage them in the native builder (no code change to add/edit). Shape varies
// across tenants; normalize permissively. Uses the email Version header.
export async function listEmailTemplates(): Promise<EmailTemplateLite[]> {
  const { locationId } = requireEnv();
  const params = new URLSearchParams({
    locationId,
    type: "email",
    limit: "100",
    offset: "0",
  });
  const url = `${BASE_URL}/locations/${encodeURIComponent(
    locationId,
  )}/templates?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: headers(EMAIL_API_VERSION),
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
      detail = (await res.text()).slice(0, 400);
    } catch {
      /* ignore */
    }
    if (res.status === 401)
      detail = `${detail} (The PIT likely needs the templates READ scope.)`;
    throw new GhlError(
      `GoHighLevel returned ${res.status} for GET /locations/{id}/templates.`,
      res.status,
      detail,
    );
  }
  const j = (await res.json().catch(() => ({}))) as {
    templates?: RawTemplate[];
    data?: RawTemplate[];
  };
  const raw = j.templates || j.data || [];
  return raw
    .map((t) => ({
      id: String(t.id ?? t._id ?? t.templateId ?? ""),
      name: String(t.name ?? t.title ?? "Untitled template"),
      subject: String(t.subject ?? t.template?.subject ?? ""),
      body: String(t.html ?? t.body ?? t.template?.html ?? t.template?.body ?? ""),
    }))
    .filter((t) => t.id);
}

// Task 5 — send an email to a contact via the Conversations outbound endpoint.
// Option B (default): send the composer's edited HTML as `emailBody`. Option A:
// pass `templateId` to let GHL render a template directly. Confirm shape with
// scripts/email-templates-probe.mjs. NOTE: deliverability depends on the sending
// domain being authenticated + a verified emailFrom — until then messages may
// land in spam even on a 2xx here.
export async function sendEmail(args: {
  contactId: string;
  subject: string;
  html?: string; // Option B — rendered/edited HTML body
  templateId?: string; // Option A — send by GHL template id
  cc?: string[];
}): Promise<string> {
  const body: Record<string, unknown> = {
    type: "Email",
    contactId: args.contactId,
    emailSubject: args.subject,
    subject: args.subject, // harmless duplicate for tenants reading `subject`
  };
  if (args.templateId) body.templateId = args.templateId;
  if (args.html) {
    body.emailBody = args.html;
    body.html = args.html; // duplicate for tenants reading `html`
  }
  if (EMAIL_FROM) body.emailFrom = EMAIL_FROM;
  if (args.cc?.length) body.emailCc = args.cc;

  const url = `${BASE_URL}/conversations/messages/outbound`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { ...headers(EMAIL_API_VERSION), "Content-Type": "application/json" },
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
      detail = (await res.text()).slice(0, 400);
    } catch {
      /* ignore */
    }
    throw new GhlError(
      `GoHighLevel returned ${res.status} for POST /conversations/messages/outbound.`,
      res.status,
      detail,
    );
  }
  const j = (await res.json().catch(() => ({}))) as {
    messageId?: string;
    id?: string;
    conversationId?: string;
  };
  return String(j.messageId ?? j.id ?? j.conversationId ?? "");
}

export async function deleteCaregiverRelation(
  relationId: string,
): Promise<void> {
  const { locationId } = requireEnv();
  const url = `${BASE_URL}/associations/relations/${encodeURIComponent(
    relationId,
  )}?locationId=${encodeURIComponent(locationId)}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "DELETE", headers: headers() });
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
      `GoHighLevel returned ${res.status} for DELETE /associations/relations.`,
      res.status,
      detail,
    );
  }
}
