import type { OpportunityRecord } from "./types";

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

// ---------------------------------------------------------------------------
// Lookups (pipelines, custom fields, users). Cached per warm lambda instance.
// ---------------------------------------------------------------------------

interface Pipeline {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
}

let cache: {
  pipelines?: Pipeline[];
  fieldMap?: Map<string, string>; // custom field id -> field name
  userMap?: Map<string, string>; // user id -> display name
} = {};

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
  const { locationId } = requireEnv();
  const map = new Map<string, string>();
  try {
    const data = await ghlGet<{
      customFields?: { id: string; name?: string; fieldKey?: string }[];
    }>(
      `/locations/${encodeURIComponent(locationId)}/customFields?model=opportunity`,
    );
    for (const f of data.customFields || []) {
      if (f.id) map.set(f.id, f.name || f.fieldKey || "");
    }
  } catch {
    // Non-fatal: without the map we simply can't resolve custom-field names,
    // but stage/owner/contact still populate. Leave the map empty.
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
  assignedTo?: string;
  contactId?: string;
  contact?: {
    id?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
  };
  customFields?: RawCustomField[];
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
  ref: ["referralsource", "referral"],
  src: ["source", "leadsource"],
  asst: ["salesrepassistant", "repassistant", "assistant", "salesassistant"],
  cm: ["casemanager", "casemgr"],
  onb: ["onboardingrep", "onboarding", "onboardingrepresentative"],
  cg: ["caregiver"],
  checked: ["checkedthisweek", "checked", "checkedweek"],
  // Fields below are not sourced from custom fields; listed for completeness.
  id: [],
  first: [],
  last: [],
  stage: [],
  rep: [],
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
  };

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

export async function getOltlOpportunities(): Promise<{
  records: OpportunityRecord[];
  pipeline: { id: string; name: string };
}> {
  const pipeline = await resolvePipeline();
  const stageMap = new Map<string, string>();
  for (const s of pipeline.stages || []) stageMap.set(s.id, s.name);

  const [fieldMap, userMap, raw] = await Promise.all([
    getFieldMap(),
    getUserMap(),
    searchAll(pipeline.id),
  ]);

  const records = raw.map((o) =>
    normalizeOpportunity(o, fieldMap, userMap, stageMap),
  );

  return {
    records,
    pipeline: { id: pipeline.id, name: pipeline.name },
  };
}
