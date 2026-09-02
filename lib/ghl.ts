import type {
  OpportunityRecord,
  EditableFieldDef,
  ResourceFile,
} from "./types";
import { isFieldEditable } from "./editable";
import { PIPELINE_FOLDERS } from "./fieldFolders";
import { divisionLabel } from "./division";
import { mapLimit } from "./concurrency";

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
  // GoHighLevel returns a traceId on its error bodies. It is the ONE field their
  // support can actually look up, and it was being discarded — ghlMessage() only
  // ever kept `message`. Carried through the error, the route response and into
  // the UI's details block so a rep can paste it verbatim.
  traceId?: string;
  // GHL's own machine-readable code (e.g. OPPORTUNITY_NO_DUPLICATE). What the
  // friendly-message mapping keys off, rather than matching on prose.
  code?: string;
  constructor(
    message: string,
    status: number,
    detail?: string,
    meta?: { traceId?: string; code?: string },
  ) {
    super(message);
    this.name = "GhlError";
    this.status = status;
    this.detail = detail;
    this.traceId = meta?.traceId;
    this.code = meta?.code;
  }
}

// Pull the machine-readable bits out of a GHL error body. Kept separate from
// ghlMessage() so the human text and the lookup keys never overwrite each other.
export function ghlErrorMeta(raw: string): { traceId?: string; code?: string } {
  try {
    const j = JSON.parse((raw || "").trim()) as Record<string, unknown>;
    const traceId =
      typeof j.traceId === "string"
        ? j.traceId
        : typeof j.trace_id === "string"
          ? j.trace_id
          : undefined;
    // The code appears as `error` on some shapes and inside `message` on others
    // (e.g. "OPPORTUNITY_NO_DUPLICATE: Can not create..."). Take the first
    // SCREAMING_SNAKE token we find; anything else is prose, not a code.
    const hay = `${typeof j.error === "string" ? j.error : ""} ${
      typeof j.message === "string" ? j.message : ""
    } ${Array.isArray(j.message) ? j.message.join(" ") : ""}`;
    const m = /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,6})\b/.exec(hay);
    return { traceId, code: m ? m[1] : undefined };
  } catch {
    return {};
  }
}

// `opts` lets a feature-specific caller additionally require an account-scoped
// id (resources folder / caregiver association) so it throws AT THE POINT OF USE
// — same fail-loud behaviour as locationId — instead of silently defaulting to
// "" (which would upload to the media root / return an empty caregiver list).
// Unrelated calls (search, pipelines, contacts) omit opts and are unaffected.
// GHL puts a readable reason in the error body — e.g.
//   { "message": "Can not make this user X owner as User does not have
//                 permission to access this pipeline Y.", "statusCode": 400 }
// `message` is sometimes a string and sometimes an array of strings (the 422
// validation shape). Pull it out so callers surface the reason rather than a
// bare status code; fall back to the raw text when it isn't JSON.
function ghlMessage(raw: string): string {
  const text = (raw || "").trim();
  if (!text) return "";
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: unknown };
    const m = j.message ?? j.error;
    if (Array.isArray(m)) return m.map(String).join("; ").slice(0, 500);
    if (typeof m === "string" && m.trim()) return m.trim().slice(0, 500);
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return text.slice(0, 500);
}

// GHL enforces its own Pipeline Permissions on owner assignment, and that is a
// SEPARATE system from our PIPELINE_ACCESS_MAP: ours governs what the dashboard
// shows, GHL's governs who may own a record and see the native screen. They can
// disagree, and a mismatch surfaces as:
//   400 "Can not make this user <userId> owner as User does not have permission
//        to access this pipeline <pipelineId>."
// which names ids, not people. Rewrite it with the real names and the exact
// place to fix it. We deliberately do NOT try to pre-filter the owner dropdown:
// GHL exposes no API for those grants, so any filter would be a guess that
// silently hides valid choices.
export async function explainGhlError(e: unknown): Promise<string> {
  if (!(e instanceof GhlError))
    return e instanceof Error ? e.message : String(e);
  const raw = `${e.message} ${e.detail ?? ""}`;
  const m =
    /can\s*not\s+make\s+this\s+user\s+(\S+?)\s+owner.*?permission\s+to\s+access\s+this\s+pipeline\s+(\S+?)[.\s"]/i.exec(
      raw + " ",
    );
  if (m) {
    const [, userId, pipelineId] = m;
    let who = userId;
    let which = pipelineId;
    try {
      who = (await getUserMap()).get(userId) || userId;
    } catch {
      /* keep the id */
    }
    try {
      which =
        (await getPipelines()).find((p) => p.id === pipelineId)?.name ||
        pipelineId;
    } catch {
      /* keep the id */
    }
    return `${who} doesn't have access to the "${which}" pipeline in GoHighLevel, so they can't be made owner of this record. Grant it in GoHighLevel → Settings → Opportunities → Pipelines → the key icon on "${which}", then try again.`;
  }
  // ITEM 4 — GHL's own one-opportunity-per-contact-per-pipeline rule. Its
  // message says "create" even when the request was an UPDATE (a Move), which
  // reads as "the dashboard tried to duplicate the record" — it did not. Say
  // what actually happened and what to do about it.
  if (
    /OPPORTUNITY_NO_DUPLICATE/i.test(raw) ||
    /duplicate opportunity for the contact/i.test(raw)
  ) {
    return "This client already has a case in the destination pipeline. GoHighLevel allows only ONE opportunity per contact per pipeline, so this record can't be moved there. Close or move the existing case first, then try again. (GoHighLevel's own message says \"create\" — it fires on updates too; nothing was duplicated.)";
  }
  return e.detail ? `${e.message} — ${e.detail}` : e.message;
}

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

// 🔴 GOHIGHLEVEL RETURNS ITS OWN TIMEOUT AS A 401.
//
//   {"statusCode":401,"message":"Command timed out"}
//
// Reproduced outside the dashboard, with a token that had returned 25 users
// minutes earlier — so this is GHL conflating a transient backend timeout with
// an auth failure, and the error layer was faithfully passing it through.
//
// Two consequences, both handled:
//   1. it is TRANSIENT, so it is worth one silent retry. The Access tab makes
//      four reads in Promise.all, giving it four chances to hit an intermittent
//      fault; a single retry per call removes most of that exposure.
//   2. it must NEVER produce the token-troubleshooting text, which sends
//      somebody to check a token that is provably fine.
function isGhlTimeout(status: number, body: string): boolean {
  return status === 401 && /timed?\s*out/i.test(body);
}

// ⚠️ A MITIGATION, NOT THE FIX. GoHighLevel allows ~100 requests per 10s, and
// the real remedy was to stop making requests nobody asked for (refresh-on-focus
// is gone). But a burst can still coincide with somebody else's, and a 429 that
// reaches the UI breaks the page over something that would have succeeded a
// moment later.
//
// One retry, after a pause. GHL sends Retry-After on some 429s; when it does we
// obey it, capped so a long value can't hang the request past the serverless
// timeout. Otherwise a flat 1.2s, which clears a 10-second window's worth of
// burst without making a failure feel like a hang.
function retryAfterMs(res: Response): number {
  const h = Number(res.headers.get("retry-after"));
  if (Number.isFinite(h) && h > 0) return Math.min(h * 1000, 4000);
  return 1200;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ghlGet<T>(path: string, attempt = 1): Promise<T> {
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
    let raw = "";
    try {
      raw = await res.text();
    } catch {
      /* ignore */
    }
    let detail = ghlMessage(raw).slice(0, 500);
    const meta = ghlErrorMeta(raw);

    if (res.status === 429 && attempt === 1) {
      const wait = retryAfterMs(res);
      // eslint-disable-next-line no-console
      console.warn(
        `[ghl] 429 on ${new URL(url).pathname} — rate limited. Retrying once in ${wait}ms.`,
      );
      await sleep(wait);
      return ghlGet<T>(path, 2);
    }

    // ONE retry, then give up. Retrying further would turn a GHL wobble into a
    // request that hangs for the user instead of failing cleanly.
    if (isGhlTimeout(res.status, raw) && attempt === 1) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ghl] 401 "Command timed out" on ${new URL(url).pathname} — GoHighLevel's own timeout, not an auth failure. Retrying once.`,
      );
      return ghlGet<T>(path, 2);
    }

    if (isGhlTimeout(res.status, raw)) {
      // Reported as 502: this was an upstream failure, and calling it 401 makes
      // every layer above treat a working token as expired.
      throw new GhlError(
        "GoHighLevel didn't respond.",
        502,
        `GoHighLevel returned 401 "${detail}" for ${new URL(url).pathname}. That is its own backend timeout, not an authentication failure — the token is fine. Retried once already.`,
        meta,
      );
    }

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
      meta,
    );
  }
  return (await res.json()) as T;
}

async function ghlSend<T>(
  method: "PUT" | "POST" | "PATCH",
  path: string,
  body: unknown,
  attempt = 1,
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
    let raw = "";
    try {
      raw = await res.text();
    } catch {
      /* ignore */
    }
    const detail = ghlMessage(raw);
    const meta = ghlErrorMeta(raw);

    // Same GHL timeout-as-401 as ghlGet. ⚠️ Retried here too, but note the
    // difference: a WRITE that timed out may or may not have landed, so the
    // retry can repeat it. Every write this app makes is idempotent in effect
    // — it PUTs a desired state (stage, owner, field values), never an
    // increment or an append — so applying it twice reaches the same place.
    // The one exception is note creation, which appends; a duplicated note is
    // visible and harmless, whereas a lost one is not.
    if (res.status === 429 && attempt === 1) {
      const wait = retryAfterMs(res);
      // eslint-disable-next-line no-console
      console.warn(
        `[ghl] 429 on ${method} ${new URL(url).pathname} — rate limited. Retrying once in ${wait}ms.`,
      );
      await sleep(wait);
      return ghlSend<T>(method, path, body, 2);
    }

    if (isGhlTimeout(res.status, raw) && attempt === 1) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ghl] 401 "Command timed out" on ${method} ${new URL(url).pathname} — GoHighLevel's own timeout, not auth. Retrying once.`,
      );
      return ghlSend<T>(method, path, body, 2);
    }
    if (isGhlTimeout(res.status, raw)) {
      throw new GhlError(
        "GoHighLevel didn't respond.",
        502,
        `GoHighLevel returned 401 "${detail}" for ${method} ${new URL(url).pathname}. That is its own backend timeout, not an authentication failure — the token is fine. Retried once already.`,
        meta,
      );
    }

    // Log the failing request body alongside the reason — without it a 400 is
    // undiagnosable from the logs alone.
    // eslint-disable-next-line no-console
    console.error(
      `[ghl] ${method} ${new URL(url).pathname} -> ${res.status}: ${detail}${
        meta.traceId ? ` traceId=${meta.traceId}` : ""
      }`,
      JSON.stringify(body)?.slice(0, 800),
    );
    throw new GhlError(
      `GoHighLevel returned ${res.status} for ${method} ${new URL(url).pathname}.`,
      res.status,
      detail,
      meta,
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
  // 🔴 EVICT FIRST, THEN READ UNCACHED. Both are needed: evicting alone would
  // still let a concurrent caller re-populate the entry from a read that
  // started before the write landed. See the note on oppBurst above.
  invalidateOpportunity(id);
  return getOpportunityByIdUncached(id);
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
  // ITEM 3 — CONTACT custom-field definitions, cached SEPARATELY. Deliberately
  // not one merged list: a field id is only meaningful together with its model,
  // and merging would let an opportunity write and a contact write resolve the
  // same name to the wrong field.
  contactFieldDefs?: FieldDefinition[];
  fieldMap?: Map<string, string>; // custom field id -> field name
  userMap?: Map<string, string>; // user id -> display name
} = {};

// Reused by both the read path (name resolution) and the future write path
// (id + dataType + options). Fetched once per warm lambda.
// ITEM 3 — MODEL-AWARE, not caregiver-special.
//
// The caregiver fields (Application 18 / Compliance 16 / Availability 6) are
// CONTACT fields, and this only ever asked for `model=opportunity`, so the panel
// could not see them however they were mapped. Client Care Needs (25) is
// contact-side too — so this is parameterised rather than given a caregiver
// branch, and the client panel gets the same machinery for free. Building it
// twice is how the two drift.
export type FieldModel = "opportunity" | "contact";

export async function getFieldDefinitions(
  model: FieldModel = "opportunity",
): Promise<FieldDefinition[]> {
  const slot = model === "contact" ? "contactFieldDefs" : "fieldDefs";
  const cached = cache[slot];
  if (cached) return cached;
  const { locationId } = requireEnv();
  let defs: FieldDefinition[] = [];
  try {
    const data = await ghlGet<{ customFields?: FieldDefinition[] }>(
      `/locations/${encodeURIComponent(locationId)}/customFields?model=${model}`,
    );
    defs = data.customFields || [];
  } catch (e) {
    // Non-fatal for the read path (stage/owner/contact still resolve), but it
    // is FATAL for every write that resolves a field by name: Move's transfer
    // stamps, Division, the panel's editable-field allowlist. This used to be
    // swallowed silently AND the empty result cached, so one failed fetch made
    // a warm lambda permanently unable to stamp anything — the same defect as
    // the users lookup. Never cache a failed read; say so loudly.
    // eslint-disable-next-line no-console
    console.error(
      "[ghl] custom-field definitions could not be fetched — NOT cached, will retry on the next call. Field-by-name writes (transfer stamps, Division) are skipped until this succeeds:",
      await explainGhlError(e),
    );
    return [];
  }
  if (!defs.length) {
    // eslint-disable-next-line no-console
    console.warn(
      "[ghl] custom-field definitions came back EMPTY. Not caching. Check the PIT's locations/customFields scope.",
    );
    return defs;
  }
  cache[slot] = defs;
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

// ITEM 13 — CAREGIVER PIPELINES, a SEPARATE set.
//
// 🔴 These must never appear in the client list, the client kanban or the
// master view. Keeping them in their own env var rather than adding a flag to
// the client set is what makes that structural: every existing caller reads
// pipelineIds() and therefore cannot see them, without a single one of them
// having to remember a filter.
//
// ⚠️ A THIRD IS COMING. The caregiver form routes to four departments and
// OLTL_CHC — the routing DEFAULT, and where family caregivers go — has no
// pipeline yet. Adding it is one id in CAREGIVER_PIPELINE_IDS, no code change:
// the whole caregiver path is driven by this list.
//
// ⚠️ NO REASSIGN STAGE on these, and none is added. The reassign flow resolves
// REASSIGN by name and REFUSES when a pipeline hasn't got one (see
// moveOpportunity), so a caregiver pipeline simply cannot be reassigned into —
// which is the intended outcome, reached by the existing guard rather than by a
// new special case.
const DEFAULT_CAREGIVER_PIPELINE_IDS = [
  "EXVMveGzgDy9qf4wQR2H", // PP Caregiver Applicants
  "232bytrK7FWNAwC6shME", // ODP DSP Applicant
];

function parseIds(raw: string, fallback: string[]): string[] {
  const t = (raw || "").trim();
  if (!t) return fallback;
  const ids = t.split(/[\s,|]+/).map((x) => x.trim()).filter(Boolean);
  return ids.length ? ids : fallback;
}

/** The CLIENT pipelines. Unchanged behaviour — every existing caller uses this. */
export function pipelineIds(): string[] {
  return parseIds(process.env.PIPELINE_IDS || "", DEFAULT_PIPELINE_IDS);
}

/** The CAREGIVER pipelines. Disjoint from the client set by construction. */
export function caregiverPipelineIds(): string[] {
  return parseIds(
    process.env.CAREGIVER_PIPELINE_IDS || "",
    DEFAULT_CAREGIVER_PIPELINE_IDS,
  );
}

/** Which family of pipelines a read is about. */
export type PipelineScope = "client" | "caregiver";

export function idsForScope(scope: PipelineScope): string[] {
  return scope === "caregiver" ? caregiverPipelineIds() : pipelineIds();
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
export async function getSelectedPipelines(
  scope: PipelineScope = "client",
): Promise<Pipeline[]> {
  if (scope === "client") checkPipelineConfig();
  const pipelines = await getPipelines();
  const byId = new Map(pipelines.map((p) => [p.id, p]));
  const selected: Pipeline[] = [];
  for (const id of idsForScope(scope)) {
    const p = byId.get(id);
    if (p) selected.push(p);
  }
  if (!selected.length) {
    throw new GhlError(
      "None of the configured PIPELINE_IDS matched this account's pipelines.",
      404,
      `Configured: ${idsForScope(scope).join(", ")}. Available: ${pipelines
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
export async function getUserMap(): Promise<Map<string, string>> {
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
    // ITEM #10 — GoHighLevel's opportunity search embeds the contact, and its
    // documented shape includes tags. NOT PREVIOUSLY DECLARED HERE, so nothing
    // read them. Optional and defensively normalised: if this account's
    // response omits it, `tags` lands as [] and the card degrades to the
    // neutral wording instead of claiming a route it cannot know.
    tags?: unknown;
    // ITEM 1 — present on the search response (100/100 records carried
    // email+phone per the tags probe) but never declared, so never read.
    email?: string;
    phone?: string;
  };
  customFields?: RawCustomField[];
  // ITEM 2 — when the record last changed stage. GHL's own field name is
  // lastStageChangeAt; the variants are accepted because this has NEVER been
  // read here before and the exact spelling on this account is unconfirmed.
  lastStageChangeAt?: string;
  lastStageChangedAt?: string;
  lastStatusChangeAt?: string;
  // ITEM 5 — the optimistic-concurrency token. GoHighLevel stamps this on every
  // opportunity write, so it changes whenever ANYBODY edits the record — which
  // is exactly what a version check needs and why nothing had to be invented.
  updatedAt?: string;
  dateUpdated?: string;
}

// Raw custom-field value, arrays preserved (for MULTIPLE_OPTIONS / CHECKBOX).
//
// ITEM 1 (read side) — SETTLED, live.
//
// This used to read exactly four fixed keys. GHL returns a custom field's value
// under a key that varies by dataType, and DATE fields come back under
// **fieldValueDate** — which was not in the list, so every DATE read back as ""
// and was INDISTINGUISHABLE from "never written".
//
// That was the whole of the Transferred Date bug. The write was correct all
// along; the READ was blind. Confirmed by the fallback below firing in
// production:
//   [ghl] custom-field value found under the unhandled key "fieldValueDate"
//         (field XheOieRRGOFtSZc4TBWi)
// The same applied to all ten Milestone dates — they were storing fine and
// showing empty.
//
// fieldValueDate is now a KNOWN key, placed ahead of the generic ones so an
// empty-but-present fieldValueString/fieldValue can never shadow it. The
// `fieldValue*` fallback stays: it is what caught this, and it will catch the
// next typed variant (fieldValueNumber, …) instead of silently blanking it.
const KNOWN_CF_KEYS = [
  "fieldValueArray",
  "fieldValueDate",
  "fieldValueString",
  "fieldValue",
  "value",
];
const _loggedCfKeys = new Set<string>();

function cfRaw(cf: RawCustomField): unknown {
  for (const k of KNOWN_CF_KEYS) {
    const v = (cf as Record<string, unknown>)[k];
    if (v !== undefined && v !== null) return v;
  }
  for (const [k, v] of Object.entries(cf as Record<string, unknown>)) {
    if (!k.startsWith("fieldValue")) continue;
    if (v === undefined || v === null || v === "") continue;
    if (!_loggedCfKeys.has(k)) {
      _loggedCfKeys.add(k);
      // eslint-disable-next-line no-console
      console.warn(
        `[ghl] custom-field value found under the unhandled key "${k}" (field ${cf.id}). It is being read, but add it to KNOWN_CF_KEYS.`,
      );
    }
    return v;
  }
  return "";
}

// ---------------------------------------------------------------------------
// DATE values (ITEM 1).
//
// PROVEN BY A REAL WRITE: GHL accepts a full ISO 8601 string on a DATE custom
// field, returns 200, and stores ONLY the calendar date —
// `"2026-08-28T14:30:00.000Z"` reads back as `"2026-08-28"`. A DATE field
// cannot hold a time, whatever the field is named.
//
// So the time component here is not an attempt to store one; it exists purely
// to pin the date. Midday UTC keeps a bare `"2026-08-28"` from rolling onto the
// previous or next day when a timezone is applied at either end.
//
// Every DATE write in this codebase goes through this function, so the panel,
// the importer and Move all send one shape.
// ---------------------------------------------------------------------------
export function toGhlDate(value: unknown): string {
  if (value == null) return "";
  const s = String(value).trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T12:00:00.000Z`;
  // A zoneless "2026-08-28T14:30" — `new Date()` would read this as LOCAL time
  // and could shift it onto the adjacent DAY at the server's offset, which is
  // the part that survives truncation. The panel no longer produces this shape
  // (the datetime editor was removed once GHL was proven to discard the time),
  // but an imported spreadsheet cell still can. Read it as UTC.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s))
    return new Date(`${s}${s.length === 16 ? ":00" : ""}Z`).toISOString();
  const d = new Date(s);
  if (isNaN(d.getTime())) return s; // let GHL reject it rather than silently blanking
  return d.toISOString();
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
  oppName: [],
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
  contactName: [],
  contactEmail: [],
  contactPhone: [],
  tags: [], // not custom fields — read off the embedded contact
  pipelineId: [],
  pipelineName: [],
  shared: [],
  stageChangedAt: [], // native GHL timestamp, not a custom field
  version: [], // native GHL updatedAt, not a custom field
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
    // Keep the opportunity's OWN name — previously it was only used as a
    // fallback when the contact had no name, so it never reached the UI.
    oppName: (opp.name || "").trim(),
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
    contactName: (
      opp.contact?.name ||
      [opp.contact?.firstName, opp.contact?.lastName].filter(Boolean).join(" ")
    ).trim(),
    contactEmail: (opp.contact?.email || "").trim(),
    contactPhone: (opp.contact?.phone || "").trim(),
    tags: Array.isArray(opp.contact?.tags)
      ? opp.contact.tags.filter((t): t is string => typeof t === "string")
      : [],
    pipelineId,
    pipelineName: pipelineNameById.get(pipelineId) || "",
    shared: false, // set true later by the access filter for non-home pipelines
    // ITEM 2 — days-in-stage. ⚠️ THIS WAS NOT PREVIOUSLY IN THE PAYLOAD: nothing
    // in the codebase read lastStageChangeAt, and RawOpportunity did not declare
    // it, so the brief's "already in the API response" was true of GoHighLevel's
    // response, not of ours. It is read here defensively — several plausible key
    // spellings, and "" when GHL sends none — so an absent value renders nothing
    // rather than "0 days", which would be a confident lie about a record we
    // know nothing about. UNVERIFIED against live GHL: see
    // scripts/stage-age-probe.mjs.
    // ITEM 5 — see OpportunityRecord.version.
    version: String(opp.updatedAt ?? opp.dateUpdated ?? ""),
    stageChangedAt: String(
      opp.lastStageChangeAt ??
        opp.lastStageChangedAt ??
        opp.lastStatusChangeAt ??
        "",
    ),
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
export async function getEditableFieldDefs(
  model: FieldModel = "opportunity",
): Promise<EditableFieldDef[]> {
  const defs = await getFieldDefinitions(model);
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
    // ITEM 3 — the folder NAME when GHL sends one, under any of the spellings
    // seen. Empty when it doesn't, and the folder match falls back to parentId.
    parentName: String(
      (d as Record<string, unknown>).parentName ??
        (d as Record<string, unknown>).folderName ??
        (d as Record<string, unknown>).parentFolderName ??
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

export async function getOltlOpportunities(
  scope: PipelineScope = "client",
): Promise<{
  records: OpportunityRecord[];
  // A pipeline whose fetch failed. Its records are ABSENT from `records`, and
  // that is indistinguishable from "this pipeline is empty" unless we say so.
  failedPipelines?: { id: string; name: string; error: string }[];
  pipeline: { id: string; name: string } | null;
  pipelines: { id: string; name: string }[];
  stages: { id: string; name: string }[];
  stagesByPipeline: Record<string, { id: string; name: string }[]>;
  users: { id: string; name: string }[];
  fieldDefs: EditableFieldDef[];
}> {
  const selected = await getSelectedPipelines(scope);

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

  // PARALLEL, CAPPED. This ran SEQUENTIALLY — `for (const p of selected) await
  // searchAll(p.id)` — so the load's wall-clock was the SUM of five round trips
  // plus their pages, one waiting on the last for no reason. The request COUNT
  // is unchanged (5-10 pages either way, ~8-13 for the whole load); they simply
  // stop queueing behind each other. That is "wait less", never "retry more".
  //
  // The cap is the point: 100 requests per 10 seconds is the budget, and an
  // unbounded wave is how a slow load becomes a 429.
  //
  // 🔴 ONE PIPELINE FAILING MUST NOT FAIL THE LOAD. mapLimit returns settled
  // results rather than rejecting, so a pipeline that times out costs its own
  // records and nothing else.
  //
  // ⚠️ BUT IT MUST NOT BE SILENT EITHER. A dropped pipeline looks exactly like
  // an empty one, and a rep seeing their division empty concludes there is no
  // work rather than that the load half-failed. The names come back in
  // `failedPipelines` so the UI can say which.
  //
  // The 401 "Command timed out" retry lives in ghlGet (report 47) and still
  // applies per request — GoHighLevel returns 401 for its OWN timeouts, so that
  // one retry happens beneath this and usually means nothing lands here at all.
  const PIPELINE_CONCURRENCY = 5;
  const settled = await mapLimit(selected, PIPELINE_CONCURRENCY, (p) =>
    searchAll(p.id),
  );
  const raw: RawOpportunity[] = [];
  const failedPipelines: { id: string; name: string; error: string }[] = [];
  settled.forEach((res, i) => {
    const p = selected[i];
    if (!res.ok) {
      const msg = res.error instanceof Error ? res.error.message : String(res.error);
      // eslint-disable-next-line no-console
      console.error(
        `[load] pipeline "${p.name}" (${p.id}) FAILED — its records are missing from this payload; the other ${selected.length - 1} are unaffected:`,
        msg,
      );
      failedPipelines.push({ id: p.id, name: p.name, error: msg.slice(0, 200) });
      return;
    }
    // GHL returns pipelineId on each opp; stamp it as a fallback so stage +
    // pipeline resolution is never ambiguous.
    for (const o of res.value) if (!o.pipelineId) o.pipelineId = p.id;
    raw.push(...res.value);
  });

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
    failedPipelines,
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
  txt: string; // body text (system + reason)
  // ITEM 2 — a Move note is one note carrying a SYSTEM record and the author's
  // own words. Only the second half may be edited or withdrawn.
  isMove: boolean;
  system: string; // "" for a manual note
  reason: string; // the whole text for a manual note
  // ITEM 4 — note editing. `authorId` is what the edit gate compares against;
  // it is sent to the client so the UI can show the affordance only on the
  // viewer's OWN notes, but the server re-checks it and is the real boundary.
  authorId: string;
  edited: boolean;
  removed: boolean; // ITEM 5 — soft-deleted: the text is a removal record
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
    .map((n) => {
      const parsed = parseNoteBody(n.body || "");
      return {
        id: n.id || "",
        who: (n.userId && userMap.get(n.userId)) || "GoHighLevel",
        when: fmtNoteDate(n.dateAdded),
        // The division stamped at write time — NOT looked up now, so a later
        // division change can never rewrite history.
        division: parsed.division,
        txt: parsed.text,
        authorId: n.userId || "",
        edited: parsed.edited,
        removed: parsed.removed,
        // ITEM 2 — a Move note's two halves, split by the separator Move wrote.
        // The panel greys the system half and lets the author edit only theirs.
        isMove: parsed.isMove,
        system: parsed.system,
        reason: parsed.reason,
      };
    });
}

// ITEM 6 — the author's DIVISION AT WRITE TIME.
// GHL's note object carries only body/userId/dateAdded/relations — there is no
// metadata field to hang this on, so option (b) does not exist and we use (a):
// stamp the division into the body at write time. It cannot drift, because a
// later lookup would relabel every past note if the author changes division.
// Read back with parseNoteBody(); the tag is stripped for display.
const DIVISION_TAG = /^\s*\[([^\]]{1,40})\]\s*/;

// ITEM 4 — the "edited" marker.
//
// GHL's note object carries body / userId / dateAdded / relations and nothing
// else we can hang metadata on, so the marker goes where the division already
// goes: a leading bracket tag. Notes may now carry EITHER or BOTH, in either
// order — `[OLTL] [edited] text` — so the parser consumes every leading tag and
// classifies them, which keeps every pre-existing `[OLTL] text` note reading
// exactly as before.
//
// The original timestamp is kept for free: an edit sends ONLY the body, and GHL
// does not touch `dateAdded` on update. Nothing recomputes it on read.
const EDITED_TAG = "edited";
// ITEM 5 — SOFT delete. The note is never erased: its text is replaced with a
// removal record, and the tag is what tells the reader (and the UI) that this
// slot held something. A hard delete would leave no trace that a note ever
// existed, which is exactly the failure mode that got deletion rejected the
// first time — on a transferred case the notes are the receiving rep's only
// account of what happened.
const REMOVED_TAG = "removed";

// ---------------------------------------------------------------------------
// A Move note carries TWO things in one body:
//
//   "Moved from ODP Enrollment to OLTL Enrollment. New owner: Chris." | "test transfer"
//    └──────────────── SYSTEM record ──────────────────────────────┘   └ rep's words ┘
//
// The author may correct or withdraw THEIR words. They may not erase the fact
// that a transfer happened — the receiving rep would inherit a case with no
// account of how it got there.
//
// THE BOUNDARY MECHANISM: a UNIT SEPARATOR (U+001F) written by Move itself.
//
// Not a "Reason: " substring search — a rep can type that inside their own
// text, and the split would then cut in the wrong place and let them rewrite
// the system record. U+001F is a non-printing control character: it cannot be
// typed into the note box, cannot survive a copy-paste of visible text, and
// renders as nothing in GoHighLevel's own note view. So the split point is
// unforgeable by anything a user can enter.
const REASON_SEP = "\u001F";

// Move-written notes are FLAGGED AT CREATION with [move] rather than recognised
// by their wording — otherwise a rep could type "Moved from X to Y." into a
// manual note and buy their text the same protection from editing.
const MOVE_TAG = "move";

// Notes written BEFORE the flag existed have no [move] tag. They are recognised
// by the sentence Move generated, and ONLY as a fallback for untagged notes —
// never for new ones. The capture keeps the system sentence intact and hands
// back whatever followed "Reason: " as the rep's words.
const LEGACY_MOVE =
  /^(Moved from .+? to .+?\.(?: New owner: .+?\.)?|Stage changed in .+?\.)\s*(?:Reason:\s*)?([\s\S]*)$/;

export interface NoteParts {
  division: string;
  edited: boolean;
  removed: boolean;
  isMove: boolean; // written by Move — its system half is protected
  system: string; // the Move sentence; "" for a manual note
  reason: string; // the author's own words; the WHOLE text for a manual note
  text: string; // system + reason, for anything that just wants to read it
}

export function parseNoteBody(body: string): NoteParts {
  let rest = body || "";
  let division = "";
  let edited = false;
  let removed = false;
  let isMove = false;
  for (;;) {
    const m = DIVISION_TAG.exec(rest);
    if (!m) break;
    const tag = m[1].trim().toLowerCase();
    if (tag === EDITED_TAG) edited = true;
    else if (tag === REMOVED_TAG) removed = true;
    else if (tag === MOVE_TAG) isMove = true;
    else if (!division) division = m[1].trim();
    else break; // a further tag isn't ours — leave it in the text
    rest = rest.slice(m[0].length);
  }

  let system = "";
  let reason = rest;
  const sep = rest.indexOf(REASON_SEP);
  if (sep >= 0) {
    // NEW FORMAT. composeNoteBody writes the separator on EVERY note it
    // creates — a manual note simply has an empty system half — so its presence
    // is what proves the note is new. That is the whole discriminator: the
    // legacy fallback below can then never fire on a note this app wrote, and a
    // rep who types "Moved from A to B." into a manual note gets no protection
    // they didn't earn. `isMove` comes from the [move] TAG alone, never wording.
    system = rest.slice(0, sep).trim();
    reason = rest.slice(sep + REASON_SEP.length).trim();
  } else {
    // LEGACY, and only legacy: written before the separator existed, so the
    // generated sentence is the only signal available. First-run verification
    // caught this branch being unreachable when the note carried a division tag.
    const m = LEGACY_MOVE.exec(rest);
    if (m) {
      system = m[1].trim();
      reason = (m[2] || "").trim();
      isMove = true;
    }
  }

  return {
    division,
    edited,
    removed,
    isMove,
    system,
    reason,
    text: [system, reason].filter(Boolean).join(" "),
  };
}

// Build a note body from its parts. Every write goes through this, so the tag
// order and the separator live in exactly one place.
export function composeNoteBody(p: {
  division?: string;
  edited?: boolean;
  removed?: boolean;
  isMove?: boolean;
  system?: string;
  reason: string;
}): string {
  const clean = (p.division || "").replace(/[[\]]/g, "").trim();
  const tags =
    (clean ? `[${clean}] ` : "") +
    (p.edited ? `[${EDITED_TAG}] ` : "") +
    (p.removed ? `[${REMOVED_TAG}] ` : "") +
    (p.isMove ? `[${MOVE_TAG}] ` : "");
  const system = (p.system || "").trim();
  // The separator is written on EVERY note, including manual ones (where the
  // system half is empty). It costs nothing — U+001F is non-printing — and it
  // is what marks a note as new format, so the legacy wording fallback in
  // parseNoteBody can never misfire on something this app wrote.
  return `${tags}${system}${REASON_SEP}${p.reason}`;
}

// Back-compat wrapper for the plain division stamp on manual notes.
export function stampDivision(body: string, division: string): string {
  return composeNoteBody({ division, reason: body });
}

// Kept for the edit route, which rebuilds a note from its stored parts.
export function buildNoteBody(
  text: string,
  division: string,
  edited: boolean,
  removed = false,
): string {
  return composeNoteBody({ division, edited, removed, reason: text });
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
  const parsed = parseNoteBody(n.body || body);
  return {
    id: n.id || "",
    who: (userId && userMap.get(userId)) || "You",
    when: fmtNoteDate(n.dateAdded) || "just now",
    txt: parsed.text,
    authorId: userId || "",
    edited: parsed.edited,
    removed: parsed.removed,
    isMove: parsed.isMove,
    system: parsed.system,
    reason: parsed.reason,
  };
}

// ITEM 4 — edit a note IN PLACE.
//
// Decided deliberately, and the limits are real:
//   - the AUTHOR only. Not admins: on a transferred case the notes are the
//     receiving rep's account of what happened, and someone else rewriting them
//     is worse than a typo.
//   - NO delete. A gap nobody can see is worse than a visible correction.
//   - this OVERWRITES the original text, so it is NOT a true audit trail. It is
//     for typos, which is the actual need. The "[edited]" marker is what keeps
//     it honest — a reader can always tell the text changed.
//   - only `body` is sent, so GHL leaves `dateAdded` alone and the original
//     timestamp stands.
export async function updateOpportunityNote(
  contactId: string,
  noteId: string,
  body: string,
  userId: string,
): Promise<OppNote> {
  const res = await ghlSend<{ note?: RawNote }>(
    "PUT",
    `/contacts/${encodeURIComponent(contactId)}/notes/${encodeURIComponent(noteId)}`,
    { body, ...(userId ? { userId } : {}) },
  );
  const userMap = await getUserMap();
  const n = res.note || {};
  const parsed = parseNoteBody(n.body || body);
  return {
    id: n.id || noteId,
    who: (userId && userMap.get(userId)) || "You",
    when: fmtNoteDate(n.dateAdded) || "",
    txt: parsed.text,
    authorId: userId || "",
    edited: parsed.edited,
    removed: parsed.removed,
    isMove: parsed.isMove,
    system: parsed.system,
    reason: parsed.reason,
  };
}

// Fetch ONE note raw, so the edit route can verify authorship and recover the
// division stamped at original write time. Never trust the client for either.
export async function getRawNote(
  contactId: string,
  noteId: string,
): Promise<{ id: string; body: string; userId: string } | null> {
  const data = await ghlGet<{ notes?: RawNote[] }>(
    `/contacts/${encodeURIComponent(contactId)}/notes`,
  );
  const hit = (data.notes || []).find((n) => n.id === noteId);
  if (!hit) return null;
  return { id: hit.id || "", body: hit.body || "", userId: hit.userId || "" };
}

// Fetch + normalize a single opportunity (used by the save route to re-check
// permissions and to return a fresh record after a write).
// ITEM 1 — IN-FLIGHT DEDUPE + A 3s TTL.
//
// Opening ONE record fires three requests — notes, caregivers, contact-fields —
// and EVERY ONE of them starts by reading the same opportunity to decide
// permission. That was three identical GET /opportunities/{id} calls against a
// 100-per-10s budget, for one click, before any of the work those routes exist
// to do. On a warm lambda they now collapse to one.
//
// Deliberately TINY (3 seconds) and keyed by id: this is a burst-collapser for
// one user action, not a cache of record state. Anything longer would risk a
// permission decision made against a stale owner, which is the one thing this
// read must never get wrong.
//
// 🔴 AND IT MUST BE INVALIDATED ON WRITE. This is the bug it caused in v59-v61,
// which is worth spelling out because the shape is easy to reintroduce:
//
//   1. PATCH /api/opportunities/{id} reads the record to check permission
//      -> caches the PRE-WRITE record at T0
//   2. it writes (PUT), which takes a few hundred ms
//   3. updateOpportunity re-reads to return "the fresh record"
//      -> still inside the 3s window, so it gets the CACHED PRE-WRITE record
//   4. the route answers {ok:true, record:<pre-write>} and the client, doing
//      exactly the right thing, replaces its correct optimistic update with
//      that stale record
//
// The card snaps back to its old stage, the write HAS landed in GoHighLevel,
// and a reload shows the new value. Not a race — deterministic, because a write
// always completes well inside 3 seconds.
//
// It hit every write on both boards, not just caregivers; it only LOOKED like a
// caregiver drag bug because v59-v61 shipped together, so the dedupe and the
// caregiver board went live in the same deploy.
//
// `invalidateOpportunity` is therefore not optional bookkeeping — any write to
// an opportunity MUST call it before re-reading.
const oppBurst = new Map<string, { at: number; p: Promise<OpportunityRecord | null> }>();
const OPP_BURST_MS = 3000;

export async function getOpportunityById(
  id: string,
): Promise<OpportunityRecord | null> {
  const hit = oppBurst.get(id);
  if (hit && Date.now() - hit.at < OPP_BURST_MS) return hit.p;
  const p = getOpportunityByIdUncached(id);
  oppBurst.set(id, { at: Date.now(), p });
  // A rejected promise must never be served to the next caller.
  p.catch(() => oppBurst.delete(id));
  if (oppBurst.size > 200) {
    const cutoff = Date.now() - OPP_BURST_MS;
    for (const [k, v] of oppBurst) if (v.at < cutoff) oppBurst.delete(k);
  }
  return p;
}

/**
 * Drop the burst entry for one opportunity. MUST be called by anything that
 * writes to that opportunity, before it re-reads — see the note above.
 */
export function invalidateOpportunity(id: string): void {
  oppBurst.delete(id);
}

async function getOpportunityByIdUncached(
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
  // 🔴 EVERY PIPELINE ON THE LOCATION, not `getSelectedPipelines()`.
  //
  // That helper defaults to scope "client", so this map only ever held the five
  // CLIENT pipelines. A CAREGIVER record read by id therefore resolved NEITHER
  // its stage name NOR its pipeline name:
  //
  //     rec.stage = stageNameByKey.get(stageKey(pipelineId, stageId)) || ""
  //                                                                     ^^ ""
  //
  // This function is what the PATCH route returns as "the fresh record" after a
  // write. So a caregiver drag wrote correctly, then handed the client back a
  // record with an EMPTY stage — the card matched no column and vanished, which
  // reads exactly like "it snapped back". A reload fixed it because
  // loadCaregivers() fetches with scope=caregiver, where the stages do resolve.
  //
  // Reading by ID is inherently scope-free: the caller has an opportunity id and
  // no idea which family it belongs to, so restricting the lookup to one family
  // could only ever be wrong. `stageKey` is namespaced by pipelineId, so a
  // union cannot collide even though stage NAMES repeat across pipelines.
  // getPipelines() is cached per warm lambda, so this costs nothing extra.
  const selected = await getPipelines();
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

// ---------------------------------------------------------------------------
// ITEM 6 — Resource FOLDERS. Three endpoints, all Version 2021-07-28:
//
//   CREATE  POST   /medias/folder   { name, altId, altType: "location" }
//   DELETE  DELETE /medias/{id}?altType=location&altId={loc}
//   LIST    GET    /medias/files?altId=…&altType=location&type=folder
//
// NOT /medias/files for create — that is the LISTING endpoint, and posting to
// it is the kind of near-miss that returns a confusing error rather than an
// obvious one.
//
// 🔴 ORGANISATION, NOT SECURITY. GHL media URLs are publicly reachable once
// known. Everything here scopes what people SEE in the tab; it cannot stop
// anyone who already has a URL. Client-specific documents belong on the client's
// RECORD, where they inherit its permissions — not in a shared folder.
// ---------------------------------------------------------------------------
export interface MediaFolder {
  id: string;
  name: string;
}

export async function listMediaFolders(): Promise<MediaFolder[]> {
  const { locationId } = requireEnv();
  const params = new URLSearchParams({
    altId: locationId,
    altType: "location",
    type: "folder",
    limit: "100",
  });
  const data = await ghlGet<{ files?: RawMedia[]; medias?: RawMedia[] }>(
    `/medias/files?${params.toString()}`,
  );
  const raw = data.files || data.medias || [];
  const folders = raw
    .map((f) => ({
      // 🔴 THE FOLDER-FETCH BUG. This read `f.id` ONLY. GoHighLevel's media API
      // returns the Mongo id as **_id** — which RawMedia has always declared,
      // three lines above where it was being ignored. Every folder therefore
      // mapped to id:"" and was then dropped by the .filter() below, so the call
      // SUCCEEDED and returned an empty array. No error, no 4xx, nothing to see
      // in a log: the Access tab simply reported "no media folders" for an
      // account that has two. Read both, _id first.
      id: String(f._id ?? f.id ?? ""),
      name: String(f.name ?? f.fileName ?? "Untitled"),
    }))
    .filter((f) => f.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  // If GHL returned rows and we kept none, the shape changed again. Say so —
  // that is precisely the failure this bug was, and it is invisible otherwise.
  if (raw.length && !folders.length)
    // eslint-disable-next-line no-console
    console.error(
      `[media] /medias/files?type=folder returned ${raw.length} row(s) but NONE had a usable id. Keys on the first row: ${Object.keys(raw[0] || {}).join(", ")}`,
    );
  return folders;
}

// ⚠️ GHL AUTO-RENAMES ON COLLISION: creating "OLTL" when one exists yields
// "OLTL (1)" with NO error. So the caller is told the name GHL ACTUALLY
// assigned, and we re-read the folder list to find it rather than assuming the
// create response echoes it.
export async function createMediaFolder(
  name: string,
): Promise<{ id: string; name: string; renamed: boolean; requested: string }> {
  const { locationId } = requireEnv();
  const requested = name.trim();
  if (!requested) throw new GhlError("A folder needs a name.", 400);

  const before = await listMediaFolders();
  const res = await ghlSend<{
    id?: string;
    _id?: string;
    name?: string;
    folder?: { id?: string; _id?: string; name?: string };
  }>("POST", "/medias/folder", {
    name: requested,
    altId: locationId,
    altType: "location",
  });
  // Same _id/id trap as listMediaFolders — read both here too, or a successful
  // create reports an empty id and the UI can't select the folder it just made.
  const id = String(
    res.folder?._id ?? res.folder?.id ?? res._id ?? res.id ?? "",
  );
  let actual = String(res.folder?.name ?? res.name ?? "");

  if (!actual || !id) {
    // The response shape isn't guaranteed; find the new folder by diffing.
    const after = await listMediaFolders();
    const seen = new Set(before.map((f) => f.id));
    const fresh = after.find((f) => !seen.has(f.id));
    if (fresh) return { ...fresh, renamed: fresh.name !== requested, requested };
  }
  return {
    id,
    name: actual || requested,
    renamed: !!actual && actual !== requested,
    requested,
  };
}

// 🔴 DELETING A FOLDER REMOVES ITS CONTENTS. The route counts the files first so
// the confirmation can say how many, and the count is taken SERVER-SIDE — a
// client-supplied number could be stale or forged.
export async function countFilesInFolder(folderId: string): Promise<number> {
  const { locationId } = requireEnv();
  const params = new URLSearchParams({
    altId: locationId,
    altType: "location",
    type: "file",
    parentId: folderId,
    limit: "100",
  });
  const data = await ghlGet<{ files?: RawMedia[]; medias?: RawMedia[] }>(
    `/medias/files?${params.toString()}`,
  );
  return (data.files || data.medias || []).filter(
    (f) => String(f.parentId ?? f.folderId ?? "") === folderId,
  ).length;
}

// ITEM 11 — delete ONE file. Same endpoint as the folder delete: GoHighLevel's
// media rows are files or folders alike, so /medias/{id} removes either. Kept
// as a separate named function anyway — the call sites mean different things
// and one of them destroys a folder's whole contents.
export async function deleteMediaFile(fileId: string): Promise<void> {
  return deleteMediaFolder(fileId);
}

export async function deleteMediaFolder(folderId: string): Promise<void> {
  const { locationId } = requireEnv();
  const params = new URLSearchParams({
    altType: "location",
    altId: locationId,
  });
  const url = `${BASE_URL}/medias/${encodeURIComponent(folderId)}?${params.toString()}`;
  const res = await fetch(url, { method: "DELETE", headers: headers(), cache: "no-store" });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new GhlError(
      `GoHighLevel returned ${res.status} deleting the folder.`,
      res.status,
      ghlMessage(raw),
      ghlErrorMeta(raw),
    );
  }
}

// Files in ONE folder. listResources() keeps its single-folder env behaviour for
// the legacy path; this is what the per-folder tab uses.
export async function listFolderFiles(folderId: string): Promise<ResourceFile[]> {
  const { locationId } = requireEnv();
  const limit = 100;
  const all: RawMedia[] = [];
  for (let page = 0, offset = 0; page < 50; page++, offset += limit) {
    const params = new URLSearchParams({
      altType: "location",
      altId: locationId,
      type: "file",
      sortBy: "createdAt",
      sortOrder: "desc",
      parentId: folderId,
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
  // Filter again in code so a mis-supported parentId can never leak the library.
  return all
    .filter((f) => String(f.parentId ?? f.folderId ?? "") === folderId)
    .map((f) => ({
      // Same _id/id trap as the folder list — read both.
      id: String(f._id ?? f.id ?? ""),
      name: String(f.name ?? f.fileName ?? f.originalName ?? "Untitled"),
      url: String(f.url ?? f.fileUrl ?? f.link ?? ""),
      type: String(f.type ?? f.mimeType ?? f.contentType ?? ""),
      size: Number(f.size ?? f.fileSize ?? 0) || 0,
    }))
    .filter((f) => f.url);
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
      // Same _id/id trap as the folder list — read both.
      id: String(f._id ?? f.id ?? ""),
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

// ---------------------------------------------------------------------------
// ITEM 4 — the contact's OTHER opportunities, for the Move dialog's pre-check.
//
// GoHighLevel enforces ONE opportunity per contact per pipeline. Attempting to
// move a record into a pipeline where that contact already has a case fails
// with a 400 `OPPORTUNITY_NO_DUPLICATE` — and the message says "Can not create
// duplicate opportunity", which reads as though the dashboard tried to create
// something. It didn't; the rule fires on updates too.
//
// This is a READ, so the dialog can grey out the destinations that would fail
// instead of letting the rep discover the rule by hitting it.
// ---------------------------------------------------------------------------
export interface ContactOpportunity {
  id: string;
  name: string;
  pipelineId: string;
  pipelineName: string;
  stage: string;
  status: string;
}

export async function listContactOpportunities(
  contactId: string,
): Promise<ContactOpportunity[]> {
  if (!contactId) return [];
  const { locationId } = requireEnv();
  const params = new URLSearchParams({
    location_id: locationId,
    contact_id: contactId,
    limit: "100",
  });
  const data = await ghlGet<SearchResponse>(
    `/opportunities/search?${params.toString()}`,
  );
  const pipelines = await getPipelines();
  const nameById = new Map(pipelines.map((p) => [p.id, p.name]));
  const stageNames = new Map<string, string>();
  for (const p of pipelines)
    for (const s of p.stages || []) stageNames.set(stageKey(p.id, s.id), s.name);

  return (data.opportunities || []).map((o) => {
    const pid = o.pipelineId || "";
    return {
      id: o.id,
      name: (o.name || "").trim(),
      pipelineId: pid,
      pipelineName: nameById.get(pid) || "",
      stage:
        stageNames.get(stageKey(pid, o.pipelineStageId || o.stageId || "")) || "",
      status: o.status || "",
    };
  });
}

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

// ---------------------------------------------------------------------------
// Pipeline Access (admin tab) — everything here is fetched LIVE, nothing is
// hardcoded: users and pipelines come from GHL, grants from a Location Custom
// Value. Adding a sixth division = create the pipeline in GHL and tick a box.
//
// Storage is a Location CUSTOM VALUE (not a custom object, so it doesn't touch
// the 10-per-account cap). Verified working:
//   GET  /locations/{loc}/customValues
//   POST /locations/{loc}/customValues            (create)
//   PUT  /locations/{loc}/customValues/{id}       (update)
// Shape: { "<userId>": ["<pipelineId>", …], … }
// ---------------------------------------------------------------------------
export const ACCESS_CUSTOM_VALUE_NAME = "MM Pipeline Access";

export interface LocationUser {
  id: string;
  name: string;
  email: string;
  role: string; // "admin" | "user" | ""
}

interface RawUser {
  id?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  role?: string;
  roles?: { role?: string };
}

// Full user list (id/name/email/role) for the admin grid. Admins bypass the map
// entirely, so the tab needs the role to label them.
export async function listLocationUsers(): Promise<LocationUser[]> {
  const { locationId } = requireEnv();
  const data = await ghlGet<{ users?: RawUser[] }>(
    `/users/?locationId=${encodeURIComponent(locationId)}`,
  );
  return (data.users || [])
    .map((u) => ({
      id: String(u.id ?? ""),
      name:
        u.name ||
        [u.firstName, u.lastName].filter(Boolean).join(" ").trim() ||
        String(u.email ?? "") ||
        "Unnamed user",
      email: String(u.email ?? ""),
      role: String(u.roles?.role ?? u.role ?? ""),
    }))
    .filter((u) => u.id)
    .sort((a, b) => a.name.localeCompare(b.name));
}

interface RawCustomValue {
  id?: string;
  _id?: string;
  name?: string;
  value?: unknown;
}

async function findAccessCustomValue(): Promise<{
  id: string;
  value: string;
} | null> {
  const { locationId } = requireEnv();
  const data = await ghlGet<{ customValues?: RawCustomValue[] }>(
    `/locations/${encodeURIComponent(locationId)}/customValues`,
  );
  const hit = (data.customValues || []).find(
    (c) =>
      String(c.name ?? "").trim().toLowerCase() ===
      ACCESS_CUSTOM_VALUE_NAME.toLowerCase(),
  );
  if (!hit) return null;
  return {
    id: String(hit.id ?? hit._id ?? ""),
    value: typeof hit.value === "string" ? hit.value : JSON.stringify(hit.value ?? ""),
  };
}

export type AccessGrants = Record<string, string[]>;

// ---------------------------------------------------------------------------
// v2 SHAPE. The custom value used to be a FLAT map of userId -> pipelineIds.
// Items 4 and 6 add two more scopes, so it becomes:
//
//   { "pipelines": { "<userId>": ["<pipelineId>"] },
//     "folders":   { "<userId>": ["<folderId>"]   },
//     "master":    ["<userId>"] }
//
// 🔴 THE LEGACY SHAPE MUST KEEP WORKING. Every pipeline grant on the account
// today is stored flat. Reading a flat object as v2 would find no `pipelines`
// key, hand back empty grants, and silently revoke everyone — the exact failure
// mode that a users-scope 401 caused two rounds ago. So the reader detects the
// shape and migrates in memory; the first SAVE writes v2.
//
// FOLDERS ARE THEIR OWN SCOPE, deliberately not derived from pipeline access: a
// compliance folder may belong to case managers who hold no pipeline at all.
// MASTER is a plain list — it grants a VIEW, not a set of records, and the
// records it shows are still filtered by the viewer's own pipeline access.
// ---------------------------------------------------------------------------
export interface AccessGrantsV2 {
  pipelines: AccessGrants;
  folders: AccessGrants;
  master: string[];
}

const emptyV2 = (): AccessGrantsV2 => ({ pipelines: {}, folders: {}, master: [] });

function asIdMap(v: unknown): AccessGrants {
  const out: AccessGrants = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, ids] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(ids)) continue; // ignores the {"test":"ok"} placeholder
    out[k] = ids.map(String).filter(Boolean);
  }
  return out;
}

/** Parse either shape. Returns null only when there is nothing usable at all. */
export function parseAccessValue(raw: string): AccessGrantsV2 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;

  // v2 — recognised by ANY of its three keys, so a value holding only folders
  // (no pipelines yet) is still read as v2 rather than mistaken for legacy.
  if ("pipelines" in o || "folders" in o || "master" in o) {
    return {
      pipelines: asIdMap(o.pipelines),
      folders: asIdMap(o.folders),
      master: Array.isArray(o.master) ? o.master.map(String).filter(Boolean) : [],
    };
  }

  // Legacy flat map -> pipelines. An empty {} is a REAL state (everyone
  // unmapped) and must not read as "missing", or we would fall back to the env
  // var and hand back access the admin deliberately removed.
  const flat = asIdMap(o);
  if (Object.keys(flat).length || Object.keys(o).length === 0)
    return { ...emptyV2(), pipelines: flat };
  return null;
}

/** Full v2 grants, or null when the custom value is missing/unreadable. */
export async function fetchAccessGrantsV2(): Promise<AccessGrantsV2 | null> {
  try {
    const cv = await findAccessCustomValue();
    if (!cv || !cv.value) return null;
    return parseAccessValue(cv.value);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      "[access] couldn't read the access custom value; falling back to PIPELINE_ACCESS_MAP.",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

// Back-compat: the pipeline half only. Every existing caller keeps working.
export async function fetchPipelineAccessGrants(): Promise<AccessGrants | null> {
  const v2 = await fetchAccessGrantsV2();
  return v2 ? v2.pipelines : null;
}

// A deliberately-empty saved map ({}) is a real state — everyone unmapped — and
// must NOT be treated as "missing" or we'd silently fall back to the env var.
function isEmptyGrantsObject(parsed: unknown): boolean {
  return (
    !!parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Object.keys(parsed as object).length === 0
  );
}

// Write the whole map as one JSON value. Creates the custom value if it's absent.
export async function saveAccessGrantsV2(
  patch: Partial<AccessGrantsV2>,
): Promise<{ id: string }> {
  const { locationId } = requireEnv();
  // MERGE, never replace. The Access tab may save only the folder grid; writing
  // just that would wipe every pipeline grant on the account.
  const current = (await fetchAccessGrantsV2()) ?? emptyV2();
  const next: AccessGrantsV2 = {
    pipelines: patch.pipelines ?? current.pipelines,
    folders: patch.folders ?? current.folders,
    master: patch.master ?? current.master,
  };
  const body = JSON.stringify(next);
  const existing = await findAccessCustomValue();
  if (existing?.id) {
    await ghlSend(
      "PUT",
      `/locations/${encodeURIComponent(locationId)}/customValues/${encodeURIComponent(existing.id)}`,
      { name: ACCESS_CUSTOM_VALUE_NAME, value: body },
    );
    return { id: existing.id };
  }
  const res = await ghlSend<{ customValue?: { id?: string }; id?: string }>(
    "POST",
    `/locations/${encodeURIComponent(locationId)}/customValues`,
    { name: ACCESS_CUSTOM_VALUE_NAME, value: body },
  );
  return { id: String(res.customValue?.id ?? res.id ?? "") };
}

export async function savePipelineAccessGrants(
  grants: AccessGrants,
): Promise<{ id: string }> {
  return saveAccessGrantsV2({ pipelines: grants });
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

// ---------------------------------------------------------------------------
// ITEM 4 — the hybrid picker's write half.
//
// Fields like Onboarding Rep / Case Manager / Sales Rep Assistant / HR-Assigned
// Team are SINGLE_OPTIONS (or MULTIPLE_OPTIONS) holding a plain string. Most of
// the people who belong in them ARE GHL users, so the picker lists those
// automatically. But some — subcontractors, staff without a login — are not, and
// those names have to live in the field's own picklist.
//
// Appending is ADMIN ONLY and gated in the route. This function does the write:
// read the current options, append, PUT the whole list back (GHL replaces the
// array, so it must be sent complete or existing options are destroyed).
// ---------------------------------------------------------------------------
export async function addFieldOption(
  fieldId: string,
  option: string,
): Promise<string[]> {
  const value = option.trim();
  if (!value) throw new GhlError("An option needs a name.", 400);

  const { locationId } = requireEnv();
  let defs = await getFieldDefinitions();
  let def = defs.find((d) => d.id === fieldId);
  if (!def) {
    // The definitions are cached per warm lambda, so a field created (or an id
    // changed) after this instance warmed up would look like it doesn't exist.
    // Drop the cache and look once more before saying so — a wrong 404 here
    // reads exactly like a missing route and sends you hunting in the wrong place.
    cache.fieldDefs = undefined;
    defs = await getFieldDefinitions();
    def = defs.find((d) => d.id === fieldId);
  }
  if (!def)
    throw new GhlError(
      "That field no longer exists in GoHighLevel.",
      404,
      `No opportunity custom field has id ${fieldId}. ${defs.length} definitions were checked (cache refreshed). If the field was renamed or deleted in GoHighLevel, reload the dashboard.`,
    );

  const t = String(def.dataType || "").toUpperCase();
  if (t !== "SINGLE_OPTIONS" && t !== "MULTIPLE_OPTIONS")
    throw new GhlError(
      "That field does not have an option list.",
      400,
      `${def.name} is ${def.dataType}.`,
    );

  const current = optionStrings(def);
  // Case-insensitive: "jhune" and "Jhune" must not both end up in the list.
  if (current.some((o) => o.trim().toLowerCase() === value.toLowerCase()))
    return current;

  // ═══════════════════════════════════════════════════════════════════════
  // 🔴 GOHIGHLEVEL NORMALISES EN-DASHES. PROVEN, AND IT IS SILENT.
  //
  //   sent   : "100 – Uploaded into HHA"   (U+2013 EN DASH)
  //   stored : "100 - Uploaded into HHA"   (U+002D HYPHEN-MINUS)
  //
  // No error, no warning, no hint in the response. The value simply comes back
  // different from the one you wrote.
  //
  // WHY THIS MATTERS FOR THE WORKFLOW REBUILD:
  // The old account's compliance picklists mixed en-dashes and hyphens. Those
  // values CANNOT be reproduced on this account — anything with an en-dash is
  // silently converted. So ANY workflow condition copied across from the old
  // account that matches on an en-dash WILL NEVER FIRE. It will not error; the
  // workflow will just sit there doing nothing, which is the worst failure
  // shape to debug. Rewrite such conditions against plain hyphens.
  //
  // ⚠️ THE SEPARATOR DISTINCTION IS DELIBERATE AND DOES SURVIVE — it is a
  // hyphen-vs-nothing difference, not a dash-type difference, so GHL leaves it
  // alone. Do not "tidy" these into one shape:
  //
  //   CG - HHA App Status / DocuSign Status / E-Verify Status / Medi Check
  //       -> "100 - Uploaded into HHA"     (number, space, HYPHEN, space, text)
  //   CG - Patch Check / LEIE Status / FBI Check / Child Line Status
  //       -> "100 Uploaded into HHA"       (number, space, text — NO separator)
  //
  // This function does NOT transliterate on the way out: the value is sent as
  // typed, and GHL decides. Normalising here would hide the behaviour rather
  // than record it, and the option list would then disagree with what an admin
  // typed for a different reason.
  // ═══════════════════════════════════════════════════════════════════════
  const options = [...current, value];
  const path = `/locations/${encodeURIComponent(locationId)}/customFields/${encodeURIComponent(fieldId)}`;
  try {
    await ghlSend("PUT", path, { name: def.name, options });
  } catch (e) {
    // Name the exact upstream call. A 404 from GHL and a 404 from Next look
    // identical in the browser otherwise, and they need opposite fixes.
    // eslint-disable-next-line no-console
    console.error(
      `[fields] PUT ${path} failed while adding "${value}" to "${def.name}" (${def.dataType}, ${current.length} existing options):`,
      e instanceof GhlError ? `${e.status} ${e.detail || e.message}` : String(e),
    );
    if (e instanceof GhlError && e.status === 404)
      throw new GhlError(
        `GoHighLevel returned 404 for the field "${def.name}".`,
        404,
        `The dashboard reached GoHighLevel; GoHighLevel rejected it. PUT ${path} — check the Private Integration has the locations/customFields WRITE scope, and that this field belongs to location ${locationId}.`,
      );
    throw e;
  }
  // The definitions cache now holds a stale option list; drop it so the next
  // read sees the new name rather than the panel showing an option that isn't
  // in its own dropdown.
  cache.fieldDefs = undefined;
  return options;
}

// Generic contact typeahead, for the Add Client duplicate check. Same endpoint
// and body shape as searchCaregiverContacts (proven live), minus the Record Type
// filter — here we WANT every match, because the point is to notice that the
// person already exists before creating them a second time.
export async function searchContacts(
  query: string,
): Promise<{ id: string; name: string; email: string; phone: string }[]> {
  const { locationId } = requireEnv();
  if (!query.trim()) return [];
  const data = await ghlSend<{ contacts?: RawContact[] }>(
    "POST",
    "/contacts/search",
    { locationId, page: 1, pageLimit: 10, query: query.trim() },
  );
  return (data.contacts || []).map((c) => ({
    id: String(c.id ?? c.contactId ?? ""),
    name: contactDisplay(c),
    email: String(c.email ?? ""),
    phone: String(c.phone ?? ""),
  }));
}

export async function createOpportunity(o: {
  pipelineId: string;
  stageId: string;
  contactId: string;
  name: string;
  source?: string;
  status?: string;
  assignedTo?: string; // Add Client — the owner, forced server-side for reps
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
  if (o.assignedTo) body.assignedTo = o.assignedTo;
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
// A CONTACT TAG is written on the transfer path: `transferred-to-<division>`.
// This reverses an earlier decision recorded here, and the reason for that
// decision still stands — tags are contact-scoped, so on a contact with several
// opportunities the tag cannot say which record moved. It is written anyway
// because its job is different: it is the handle GHL-side smart lists and
// workflows use to FIND these people. The opportunity-scoped Transferred From /
// Transferred Date / note remain the per-record history.
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
  // ITEM 5b — the followers THIS reassign added, so 5c can remove exactly those
  // and leave anyone who was already following the record alone.
  addedFollowers?: string[];
}

// ITEM 5 — resolved BY NAME on each pipeline, exactly as TRANSFERRED IN is.
// The stage ids exist on all five pipelines but are deliberately not hardcoded.
export const REASSIGN_STAGE_NAME = "REASSIGN";

// ITEM 5c — the durable record of WHICH followers this dashboard added during a
// reassign, so the claim can remove exactly those.
//
// A CUSTOM FIELD, not the move note. A note is editable and deletable by its
// author, so a rep tidying their own wording could silently destroy the list —
// and a claim reading a destroyed list would strip a follower who was there
// first, which is the single failure this whole mechanism exists to prevent.
// Nothing else writes to this field: it is hidden from the panel and on the
// read-only blocklist, so even a direct API call can't corrupt it through us.
export const REASSIGN_FOLLOWERS_FIELD = "Reassign Followers";

/** Store the ids WE added. Never the full follower list. */
export async function setReassignFollowers(
  oppId: string,
  userIds: string[],
): Promise<boolean> {
  const def = findDefByName(await getFieldDefinitions(), REASSIGN_FOLLOWERS_FIELD);
  if (!def) {
    // eslint-disable-next-line no-console
    console.error(
      `[reassign] no "${REASSIGN_FOLLOWERS_FIELD}" custom field on this account — the follower list cannot be recorded, so a later claim will remove NOTHING rather than guess. Create the field (TEXT, opportunity).`,
    );
    return false;
  }
  await putOpportunityVerified(
    oppId,
    { customFields: [{ id: def.id, value: userIds.join(",") }] },
    "reassign-followers",
  );
  return true;
}

/** The ids we added, or [] when the field is empty/absent. */
export async function getReassignFollowers(
  rec: { cf: Record<string, unknown> },
): Promise<string[]> {
  const def = findDefByName(await getFieldDefinitions(), REASSIGN_FOLLOWERS_FIELD);
  if (!def) return [];
  const raw = rec.cf[def.id];
  const text = Array.isArray(raw) ? raw.join(",") : String(raw ?? "");
  return text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Clear it once the claim has removed them. */
export async function clearReassignFollowers(oppId: string): Promise<void> {
  const def = findDefByName(await getFieldDefinitions(), REASSIGN_FOLLOWERS_FIELD);
  if (!def) return;
  await putOpportunityVerified(
    oppId,
    { customFields: [{ id: def.id, value: "" }] },
    "reassign-followers-clear",
  );
}

const normOpt = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");

// Find a field definition by (normalized) name — never by hardcoded id.
//
// ITEM 1 diagnostic: if the account holds TWO fields whose names normalize the
// same ("Transferred Date" in the Transfer folder and a stray "Transferred
// Date" elsewhere), `find` silently takes the first and every write lands on
// the wrong field — which looks exactly like "the value was dropped" when you
// check the field you meant. Name the collision instead of hiding it.
function findDefByName(
  defs: FieldDefinition[],
  name: string,
): FieldDefinition | undefined {
  const target = norm(name);
  const hits = defs.filter((d) => norm(d.name || "") === target);
  if (hits.length > 1) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ghl] ${hits.length} custom fields are named "${name}": ${hits
        .map((h) => `${h.id} (${h.dataType}, folder ${String(h.parentId ?? "—")})`)
        .join(" | ")}. Writing to the FIRST. If a stamp appears to vanish, this is why.`,
    );
  }
  return hits[0];
}

// ---------------------------------------------------------------------------
// PUT /opportunities/{id} that VERIFIES the custom fields actually landed.
//
// ITEM 1, stated by the user and correct: "A 200 doesn't mean the field was
// written." GHL validates each customFields entry INDEPENDENTLY — it can accept
// one entry and drop another from the very same array, with no error and no
// mention in the response. That is why "Transferred From and Transferred Date
// ride the same array" is both TRUE and consistent with only one of them
// landing; the array is not the unit of success, the entry is.
//
// So every Move write now reads its own result back: what we sent vs what the
// response reports, per field id, by name. A dropped or altered value is logged
// with both values. Verification NEVER fails the move — the write already
// happened; this only makes a silent drop visible.
// ---------------------------------------------------------------------------
interface PutOppResponse {
  opportunity?: { customFields?: RawCustomField[] };
  customFields?: RawCustomField[];
}

async function putOpportunityVerified(
  oppId: string,
  body: Record<string, unknown>,
  label: string,
): Promise<void> {
  const res = await ghlSend<PutOppResponse>(
    "PUT",
    `/opportunities/${encodeURIComponent(oppId)}`,
    body,
  );

  const sent = (body.customFields as { id: string; value: unknown }[]) || [];
  if (!sent.length) return;

  const returned = res.opportunity?.customFields ?? res.customFields;
  if (!returned) {
    // eslint-disable-next-line no-console
    console.warn(
      `[move:${label}] PUT returned 200 but carried no customFields to verify against. Sent ${sent.length} field(s); run scripts/date-write-probe.mjs to confirm they stored.`,
    );
    return;
  }

  let names = new Map<string, string>();
  try {
    names = new Map(
      (await getFieldDefinitions()).map((d) => [d.id, d.name || d.id]),
    );
  } catch {
    /* ids are still useful on their own */
  }
  const byId = new Map(returned.filter((c) => c.id).map((c) => [c.id!, c]));

  for (const s of sent) {
    const label2 = names.get(s.id) || s.id;
    const got = byId.get(s.id);
    if (!got) {
      // eslint-disable-next-line no-console
      console.error(
        `[move:${label}] ✗ "${label2}" (${s.id}) was SENT as ${JSON.stringify(s.value)} but is ABSENT from the response — GoHighLevel dropped it silently.`,
      );
      continue;
    }
    const stored = cfRaw(got);
    const a = String(Array.isArray(stored) ? stored.join(",") : stored);
    const b = String(Array.isArray(s.value) ? (s.value as unknown[]).join(",") : s.value);
    // A DATE round-trips as the calendar date, so compare on the leading 10
    // characters before calling it a mismatch.
    const same = a === b || (a && b && a.slice(0, 10) === b.slice(0, 10));
    if (!same) {
      // eslint-disable-next-line no-console
      console.warn(
        `[move:${label}] ⚠ "${label2}" (${s.id}) sent ${JSON.stringify(b)} but GoHighLevel stored ${JSON.stringify(a)}.`,
      );
    }
  }
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
export async function divisionCustomField(
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
  actorDivision?: string; // the author's division AT WRITE TIME (stamped, never looked up)
  addSenderAsFollower?: boolean; // Option A switch; default OFF (Option B)
  // ITEM 5b — master-view holders, read LIVE by the ROUTE from the access map
  // and passed in. Resolved there rather than here because the request-scoped
  // store lives in the route's async context.
  masterUsers?: string[];
}): Promise<MoveResult> {
  const steps: string[] = [];
  const addedFollowers: string[] = [];
  const current = await getOpportunityById(args.oppId);
  if (!current)
    throw new GhlError("Opportunity not found.", 404, `id ${args.oppId}`);

  const isTransfer =
    typeof args.newOwnerId === "string" &&
    (args.newOwnerId || "") !== (current.ownerId || "");
  // ITEM 4 — a transfer whose new owner is NOBODY. Still an owner change (so it
  // keeps the transfer permission rule: only the owner or an admin may do it),
  // but there is no incoming person, which changes three things downstream: no
  // user to validate, TRANSFERRED IN stops being mandatory, and the sender is
  // kept as a follower so the record does not vanish from their view.
  const unassigning = isTransfer && !args.newOwnerId;

  // ITEM 2 — the note's [DIVISION] prefix comes from actorDivision. When that
  // arrives empty, stampDivision correctly returns the body UNCHANGED — which is
  // indistinguishable from "the stamp is broken". It was silent; now it isn't.
  // The route logs WHY it is empty; this logs THAT it is, at the point of use.
  if (!args.actorDivision?.trim()) {
    // eslint-disable-next-line no-console
    console.warn(
      `[move] actorDivision is EMPTY for user "${args.actorUserId || "(none)"}" — the note will be written with NO [DIVISION] prefix. See the [move:division] line above for the reason.`,
    );
  }

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
    // Transfers land in TRANSFERRED IN — verified BEFORE any write, otherwise we
    // would fail at the final step with the owner already changed.
    const ti = (dest.stages || []).find(
      (s) => (s.name || "").trim().toUpperCase() === "TRANSFERRED IN",
    );
    // ITEM 4 — HANDING A RECORD TO A DEPARTMENT RATHER THAN A PERSON.
    //
    // This threw "New owner is not a user of this location." for an EMPTY owner
    // — while the Move dialog's owner dropdown has always offered "Unassigned"
    // as its first option. Choosing it produced a 400 whose message named a
    // problem that did not exist, and the REASSIGN column could never fill
    // because nothing was able to put a record into a pipeline unowned.
    //
    // An unassigned move is legitimate: it is a hand-off to a DEPARTMENT, and
    // the absence of an owner is exactly what marks it as unclaimed. So it is
    // allowed, and only the "is this a real user" check is skipped — there is no
    // user to check.
    if (unassigning) {
      // ITEM 5 — a REASSIGN lands in the destination's REASSIGN stage, resolved
      // BY NAME exactly as TRANSFERRED IN is. The ids exist on all five
      // pipelines but are deliberately not written down: a name match survives a
      // pipeline being rebuilt, an id does not.
      const ra = (dest.stages || []).find(
        (s) => (s.name || "").trim().toUpperCase() === REASSIGN_STAGE_NAME,
      );
      if (!ra)
        throw new GhlError(
          `"${dest.name}" has no ${REASSIGN_STAGE_NAME} stage.`,
          400,
          `Add a ${REASSIGN_STAGE_NAME} stage to that pipeline. Every reassigned case lands there, and without it nobody could claim work handed to that department.`,
        );
      destStageId = ra.id;
    } else {
      if (!ti)
        throw new GhlError(
          `"${dest.name}" has no TRANSFERRED IN stage.`,
          400,
          "Add a TRANSFERRED IN stage to that pipeline before transferring into it.",
        );
      destStageId = ti.id;
    }
    // Skipped entirely when unassigning — there is no user id to validate, and
    // running it would emit a warning naming an owner that doesn't exist.
    if (!unassigning) {
      const validUsers = await getLocationUserIds();
      // Same trap as withGrants: getUserMap() swallows a failure and returns an
      // EMPTY map, so a PIT missing `users.readonly` would make this reject EVERY
      // transfer with a flatly untrue message ("not a user of this location") that
      // sends you looking at the wrong thing entirely. An empty list means we
      // cannot verify, not that the user is invalid — let GoHighLevel be the
      // authority and reject it on the write if it really is bad.
      if (!validUsers.size) {
        // eslint-disable-next-line no-console
        console.warn(
          `[move] cannot verify that "${args.newOwnerId}" is a location user — the users lookup is empty (check the PIT's users.readonly scope). Proceeding; GoHighLevel will reject the owner change if the id is invalid.`,
        );
      } else if (!validUsers.has(args.newOwnerId as string)) {
        throw new GhlError(
          "New owner is not a user of this location.",
          400,
          String(args.newOwnerId),
        );
      }
    }
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

  // ---- SIMPLE MOVE (owner unchanged) ----
  // ITEM 2: the reason and the note used to be written ONLY on the transfer
  // path, so this early return dropped both. The real gate was `isTransfer`
  // (owner changed) — NOT the division, which is why a same-division move that
  // also changed the owner appeared to "work". A reason the rep typed must
  // ALWAYS be written, so it is recorded here too.
  if (!isTransfer) {
    await putOpportunityVerified(
      args.oppId,
      {
        pipelineId: args.toPipelineId,
        pipelineStageId: destStageId,
        ...(divisionCf.length ? { customFields: divisionCf } : {}),
      },
      "simple",
    );
    steps.push(
      `moved pipeline+stage${divisionCf.length ? " + Division" : ""}`,
    );
    // Note the move (with the reason) whenever anything actually changed.
    if (current.contactId && (pipelineChanged || args.reason?.trim())) {
      try {
        // ITEM 2 — the SYSTEM half and the rep's words are written as separate
        // parts, FLAGGED as a Move note at creation. The author may later edit
        // or withdraw their reason; the system sentence is protected.
        const system = pipelineChanged
          ? `Moved from ${
              pipelines.find((p) => p.id === current.pipelineId)?.name || "—"
            } to ${dest.name}.`
          : `Stage changed in ${dest.name}.`;
        await addOpportunityNote(
          current.contactId,
          args.oppId,
          composeNoteBody({
            division: args.actorDivision || "",
            isMove: true,
            system,
            reason: args.reason?.trim() || "",
          }),
          args.actorUserId,
        );
        steps.push("note written");
      } catch (e) {
        // The move itself succeeded; don't fail it because the note didn't land.
        // eslint-disable-next-line no-console
        console.error("[move] note failed on simple move:", await explainGhlError(e));
      }
    }
    return { transferred: false, steps };
  }

  // ---- TRANSFER ----
  const defs = await getFieldDefinitions();
  const fromDef = findDefByName(defs, "Transferred From");
  const dateDef = findDefByName(defs, "Transferred Date");
  const reasonDef = findDefByName(defs, "Transfer Reason");
  const sourceName =
    pipelines.find((p) => p.id === current.pipelineId)?.name || "";

  // ITEM 1 — say out loud which stamp fields resolved. If a name lookup misses,
  // the entry is never built, and "the field didn't land" is then a LOCAL fact
  // (we never sent it), not a GHL one. That distinction was unavailable before.
  if (!fromDef || !dateDef) {
    // eslint-disable-next-line no-console
    console.warn(
      `[move] transfer stamp fields resolved: Transferred From=${fromDef?.id ?? "NOT FOUND"} Transferred Date=${dateDef?.id ?? "NOT FOUND"} (from ${defs.length} opportunity custom-field definitions). A NOT FOUND is never sent.`,
    );
  }

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
      // Full ISO 8601 — the one shape proven to store (a bare "2026-08-27" is
      // not). Routed through toGhlDate so Move, the panel and the importer all
      // send DATE the same way.
      value: toGhlDate(new Date().toISOString()),
    });
  if (reasonDef && args.reason?.trim())
    customFields.push({ id: reasonDef.id, value: args.reason.trim() });

  // 1. Owner + stamps in ONE atomic write (fails => nothing written).
  try {
    await putOpportunityVerified(
      args.oppId,
      {
        // ITEM 4 — clearing the owner is sent as NULL, not "". null is the shape
        // the panel's own save route has always used to unassign
        // (`assignedTo = body.assignedTo ? body.assignedTo : null`), so the two
        // paths now clear an owner identically instead of one of them guessing.
        assignedTo: unassigning ? null : args.newOwnerId,
        ...(customFields.length ? { customFields } : {}),
      },
      "transfer-stamps",
    );
    steps.push("owner changed + transfer stamps");
  } catch (e) {
    return {
      transferred: false,
      steps,
      failedStep: "owner change",
      // Full reason, with GHL's pipeline-permission 400 resolved to names.
      error: await explainGhlError(e),
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
    // ITEM 4 — ⚠️ THE ACCESS RULE DOES **NOT** KEEP THE SENDER. Verified against
    // applyAccess: a record is visible when it is in a HOME pipeline and (owned
    // OR followed OR unassigned), or in ANY pipeline when owned/followed. After
    // an unassigned move OUT of Bill's division he is neither owner nor
    // follower, and the destination is not his home pipeline — so the record
    // disappears from his dashboard entirely, which is exactly what would defeat
    // the REASSIGN column.
    //
    // Fixed HERE rather than in applyAccess. Loosening the access rule to "the
    // sender can see it" would need a sender to be recorded on every record and
    // would widen visibility for everyone; making the sender a FOLLOWER uses the
    // mechanism that already exists, is visible in GHL, and can be removed by
    // hand. So an unassign always keeps the sender, regardless of the flag.
    const keepSender =
      (unassigning || args.addSenderAsFollower) && !!current.ownerId;

    // ITEM 5b — 🔴 FOLLOWERS GO ON **BEFORE** THE STAGE CHANGE.
    //
    // The stage change into REASSIGN is what fires the GoHighLevel workflow that
    // notifies "Followers". Added afterwards, that workflow has already run and
    // notified an empty list — the record sits there and nobody is told. The
    // pipeline/stage write is the LAST step of this function, so everything here
    // is safely ahead of it.
    //
    // The list is read LIVE from the request-scoped access map (see
    // getMasterUsers): anyone granted the Master view before this moment is in
    // this reassign's followers, with no backfill.
    const wanted = new Set<string>();
    if (keepSender) wanted.add(current.ownerId!);
    if (unassigning)
      for (const u of args.masterUsers || []) if (u) wanted.add(u);
    // Never re-add someone already on the record: we must be able to tell OUR
    // additions apart from a follower who was there first, or claiming the case
    // would strip a person who has nothing to do with the reassign.
    const already = new Set(current.followerIds);
    const added = [...wanted].filter((u) => !already.has(u));
    if (added.length) {
      await addOpportunityFollowers(args.oppId, added);
      addedFollowers.push(...added);
      steps.push(
        unassigning
          ? `added ${added.length} follower(s) BEFORE the stage change (sender + master-view holders) so the GHL workflow notifies a real list`
          : "kept sender as follower",
      );
      // ITEM 5c — recorded IMMEDIATELY after the additions it describes, and
      // before the stage change, so a later failure still leaves an accurate
      // list rather than followers with no record of who put them there.
      // ONLY the ids we added — anyone already following is deliberately absent.
      if (unassigning) {
        try {
          const stored = await setReassignFollowers(args.oppId, added);
          steps.push(
            stored
              ? `recorded ${added.length} added follower(s) for the claim to undo`
              : `could NOT record the added followers (no "${REASSIGN_FOLLOWERS_FIELD}" field) — a claim will remove none`,
          );
        } catch (e) {
          // Not fatal: the reassign itself is correct and the record is where
          // it should be. The cost is that the claim removes nothing, which is
          // the safe direction — it never strips the wrong person.
          // eslint-disable-next-line no-console
          console.error("[reassign] could not record added followers:", e);
          steps.push("recording the added followers FAILED (claim will remove none)");
        }
      }
    }
  } catch (e) {
    return {
      transferred: true,
      steps,
      failedStep: "clear followers",
      // Full reason, with GHL's pipeline-permission 400 resolved to names.
      error: await explainGhlError(e),
      attemptedFollowerRemovals: toRemove,
    };
  }

  // 3. Note — only now, when the transfer is real.
  try {
    if (current.contactId) {
      // "New owner: ." is what this produced for an unassigned move. Say what
      // actually happened — the receiving department reads this note to work out
      // why the record landed on them.
      const toName = unassigning
        ? "Unassigned — for the receiving team to claim"
        : (await getUserMap()).get(args.newOwnerId!) || args.newOwnerId!;
      const system = `Moved from ${sourceName || "—"} to ${dest.name}. New owner: ${toName}.`;
      await addOpportunityNote(
        current.contactId,
        args.oppId,
        composeNoteBody({
          division: args.actorDivision || "",
          isMove: true,
          system,
          reason: args.reason?.trim() || "",
        }),
        args.actorUserId,
      );
      steps.push("note written");
    }
  } catch (e) {
    return {
      transferred: true,
      steps,
      failedStep: "note",
      // Full reason, with GHL's pipeline-permission 400 resolved to names.
      error: await explainGhlError(e),
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
      await putOpportunityVerified(
        args.oppId,
        {
          pipelineId: args.toPipelineId,
          pipelineStageId: destStageId,
          // Division rides along with the pipeline change (same PUT).
          ...(divisionCf.length ? { customFields: divisionCf } : {}),
        },
        "transfer-pipeline",
      );
      steps.push(
        `moved pipeline+stage (${unassigning ? REASSIGN_STAGE_NAME : "TRANSFERRED IN"})${divisionCf.length ? " + Division" : ""}${attempt > 1 ? ` after ${attempt} attempts` : ""}`,
      );

      // 5. Tag the CONTACT. Written only HERE — after the pipeline move actually
      // landed — so the tag can never claim a transfer that stopped half way.
      // A failure is logged and swallowed: the transfer is complete and correct
      // at this point, and failing it over a tag would be worse than the missing
      // tag. The step list records whether it made it.
      if (current.contactId) {
        const destLabel = normalizeTag(divisionLabel(dest.name) || dest.name);
        // ITEM C — HOW THE RECORD GOT HERE. An ordinary transfer and a reassign
        // hand-off both land in Sent out and, until now, wrote the SAME tag —
        // so the card could not say which had happened. The reassign path
        // (`unassigning`: a transfer whose new owner is nobody) now writes a
        // second, distinct tag beside it.
        //
        // Chosen over the note text (editable by its author, so the marker can
        // be edited away) and over a new field. A field WAS considered: the
        // existing "Reassign Followers" field is written on this path — but
        // `clearReassignFollowers` wipes it when the case is CLAIMED, and a card
        // only becomes Sent out after a claim, so it is gone exactly when this
        // needs it.
        //
        // ⚠️ KNOWN LIMIT, ACCEPTED. Tags are CONTACT-scoped, not
        // opportunity-scoped. A contact reassigned once and transferred later
        // carries both tags, and a card cannot then tell which event was its
        // own. The existing `transferred-to-` tag already has that limit, so
        // this is no worse — but it is not exact, and the UI says so rather
        // than hiding it. Only an opportunity-scoped field would be exact.
        const tag = `transferred-to-${destLabel}`;
        const tags = unassigning ? [tag, `reassigned-from-${normalizeTag(divisionLabel(current.pipelineName) || current.pipelineName)}`] : [tag];
        try {
          await addContactTags(current.contactId, tags);
          steps.push(`tagged contact ${tags.map((t) => `"${t}"`).join(" + ")}`);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(
            `[move] contact tags "${tags.join('", "')}" failed for ${current.contactId} — the transfer itself is complete:`,
            await explainGhlError(e),
          );
          steps.push(`tags ${tags.map((t) => `"${t}"`).join(" + ")} FAILED (transfer completed)`);
        }
      }
      return { transferred: true, steps, addedFollowers };
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
    error: await explainGhlError(lastErr),
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
      detail = ghlMessage(await res.text());
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
  // ITEM 6c — WHICH folder. With several visible folders "upload" alone is
  // ambiguous, and defaulting to the env folder would quietly file a document in
  // a folder the uploader wasn't looking at. When a folder is named, the env var
  // is not required at all — that is why requireEnv is called conditionally.
  folderId?: string;
}): Promise<{ id: string; url: string; name: string }> {
  const target = (file.folderId || "").trim();
  const { resourcesFolderId } = requireEnv({ resourcesFolder: !target });
  const parentId = target || resourcesFolderId;
  const form = new FormData();
  const blob = new Blob([file.buffer], {
    type: file.contentType || "application/octet-stream",
  });
  // GHL /medias/upload-file form fields.
  form.append("file", blob, file.filename);
  form.append("hosted", "false");
  form.append("name", file.filename);
  form.append("parentId", parentId);

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
      detail = ghlMessage(await res.text());
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
  contactId: string; // the OTHER contact in the relation
  name: string;
  // Which side the other contact is on. THE ASSOCIATION IS DIRECTIONAL and the
  // dashboard used to ignore that: it took "whichever side isn't me" and called
  // it a caregiver, so on a CAREGIVER's record their clients were listed under
  // "Caregivers".
  role: "caregiver" | "client";
}

// What the association definition says about each slot. Read LIVE from GHL
// rather than hardcoded, because the labels are the authority on direction and
// this is exactly the thing that was assumed and got wrong.
export interface AssociationDirection {
  firstIsCaregiver: boolean; // firstRecordId holds the caregiver
  firstLabel: string;
  secondLabel: string;
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

// ---------------------------------------------------------------------------
// DIRECTION. The association definition names each slot:
//
//   firstObjectLabel  "Caregiver"   -> firstRecordId  is the caregiver
//   secondObjectLabel "Client"      -> secondRecordId is the client
//
// so which side you are on decides what the OTHER side is:
//
//   this record is firstRecordId   -> the other side is a CLIENT
//   this record is secondRecordId  -> the other side is a CAREGIVER
//
// The labels are read live from GHL, not hardcoded, because a hardcoded guess
// about direction is precisely what produced the bug. Cached per warm lambda;
// a failed read is never cached.
// ---------------------------------------------------------------------------
let _assocDir: AssociationDirection | undefined;

export async function getAssociationDirection(): Promise<AssociationDirection> {
  if (_assocDir) return _assocDir;
  const { caregiverAssociationId } = requireEnv({ caregiverAssociation: true });
  let first = "";
  let second = "";
  try {
    const data = await ghlGet<{
      association?: { firstObjectLabel?: string; secondObjectLabel?: string };
      firstObjectLabel?: string;
      secondObjectLabel?: string;
    }>(`/associations/${encodeURIComponent(caregiverAssociationId)}`);
    const a = data.association ?? data;
    first = String(a.firstObjectLabel ?? "");
    second = String(a.secondObjectLabel ?? "");
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      "[associations] could not read the association definition — falling back to the documented direction (first = Caregiver). NOT cached; will retry.",
      e instanceof Error ? e.message : String(e),
    );
    return { firstIsCaregiver: true, firstLabel: "Caregiver", secondLabel: "Client" };
  }
  // Decide from the labels themselves. If neither says "caregiver" we keep the
  // documented order rather than inventing one, and say so.
  const firstIsCaregiver = /caregiver/i.test(first)
    ? true
    : /caregiver/i.test(second)
      ? false
      : true;
  if (!/caregiver/i.test(first) && !/caregiver/i.test(second))
    // eslint-disable-next-line no-console
    console.warn(
      `[associations] neither label mentions "caregiver" (first="${first}", second="${second}") — assuming first is the caregiver.`,
    );
  _assocDir = {
    firstIsCaregiver,
    firstLabel: first || "Caregiver",
    secondLabel: second || "Client",
  };
  return _assocDir;
}

// Every caregiver_client relation this contact is part of, with the direction
// resolved. Works from EITHER side: pass a client and you get their caregivers,
// pass a caregiver and you get their clients.
export async function listCaregiverRelations(
  contactId: string,
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
    `/associations/relations/${encodeURIComponent(contactId)}?${params.toString()}`,
  );
  const relations = (data.relations || []).filter(
    (r) => String(r.associationId ?? "") === caregiverAssociationId,
  );
  const dir = await getAssociationDirection();

  const sides = relations.map((r) => {
    const rid = String(r.id ?? r._id ?? r.relationId ?? "");
    const isFirst = String(r.firstRecordId ?? "") === contactId;
    const other = isFirst
      ? String(r.secondRecordId ?? "")
      : String(r.firstRecordId ?? "");
    // I am in the caregiver slot  -> the other side is a client, and vice versa.
    const iAmCaregiver = isFirst === dir.firstIsCaregiver;
    return {
      relationId: rid,
      contactId: other,
      role: (iAmCaregiver ? "client" : "caregiver") as "caregiver" | "client",
    };
  });

  // Resolve names (best-effort; a failed lookup still shows the id).
  const out: CaregiverRelation[] = [];
  for (const c of sides) {
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
    out.push({ ...c, name });
  }
  return out;
}

// Counts only, for the list/board badges. No contact lookups — the badge needs a
// number, not names, and resolving names here would multiply the request count
// by the number of relations.
export async function countCaregiverRelations(
  contactId: string,
): Promise<{ caregivers: number; clients: number }> {
  const { locationId, caregiverAssociationId } = requireEnv({
    caregiverAssociation: true,
  });
  const params = new URLSearchParams({ locationId, skip: "0", limit: "100" });
  const data = await ghlGet<{ relations?: RawRelation[] }>(
    `/associations/relations/${encodeURIComponent(contactId)}?${params.toString()}`,
  );
  const dir = await getAssociationDirection();
  let caregivers = 0;
  let clients = 0;
  for (const r of data.relations || []) {
    if (String(r.associationId ?? "") !== caregiverAssociationId) continue;
    const isFirst = String(r.firstRecordId ?? "") === contactId;
    if (isFirst === dir.firstIsCaregiver) clients++;
    else caregivers++;
  }
  return { caregivers, clients };
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
  // ⚠️ SLOT ORDER IS UNRESOLVED — DO NOT "FIX" IT WITHOUT EVIDENCE.
  //
  // Report 29 claimed this was inverted and changed it. The claim was made by
  // reading THIS function alone, without checking the caller, and the only real
  // relation in the account contradicts it: a link created through the dashboard
  // audits as OK (caregiver in the caregiver slot).
  //
  // What is actually established:
  //   - the caller passes (a.contactId, body.caregiverContactId), i.e. the
  //     OPPORTUNITY'S OWN CONTACT first and the picked contact second;
  //   - so this puts the opportunity's contact in firstRecordId, which the
  //     definition labels "Caregiver";
  //   - in the intended flow (open a CLIENT's case, add their caregiver) that
  //     would store the client in the caregiver slot — inverted;
  //   - but the one observed relation is OK, which is explainable EITHER by
  //     GoHighLevel normalising the slots on create, OR by that link having been
  //     made from the CAREGIVER's own record (so the roles were reversed by the
  //     user's action, landing correctly by accident).
  //
  // Those two explanations demand OPPOSITE fixes, and there is no data to choose
  // between them. scripts/relation-slot-order-probe.mjs settles it in one write:
  // POST with a known first/second and read back which slot each landed in.
  //
  // Until then this keeps the ORIGINAL ordering, unchanged since the feature
  // shipped — because flipping it on an unproven theory would invert the one
  // relation that currently reads correctly.
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

// ---------------------------------------------------------------------------
// Contact tags.
//
// Tags live on the CONTACT — opportunities don't carry them in GoHighLevel — so
// this is contact-scoped by necessity, not by choice. That has one consequence
// worth stating plainly: a contact with several opportunities gets one tag for
// all of them, and the tag cannot say WHICH case moved. It answers "has this
// person been transferred to ODP", not "which of their three cases went there".
// The note and the Transferred From / Transferred Date fields remain the
// per-record history; the tag is the GHL-side handle for smart lists and
// workflows, which is exactly what it is for.
//
// GoHighLevel lowercases tags on its side regardless, so they are normalised
// here too — otherwise the same tag looks like two different strings in our own
// logs and comparisons.
// ---------------------------------------------------------------------------
export function normalizeTag(s: string): string {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function addContactTags(
  contactId: string,
  tags: string[],
): Promise<string[]> {
  const clean = [...new Set(tags.map(normalizeTag).filter(Boolean))];
  if (!contactId || !clean.length) return [];
  const res = await ghlSend<{ tags?: string[] }>(
    "POST",
    `/contacts/${encodeURIComponent(contactId)}/tags`,
    { tags: clean },
  );
  return res.tags ?? clean;
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
      detail = ghlMessage(await res.text());
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
      detail = ghlMessage(await res.text());
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
      detail = ghlMessage(await res.text());
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

// ═════════════════════════════════════════════════════════════════════════
// ITEM 3 — CONTACT CUSTOM FIELDS
//
// The caregiver field block (Application 18 / Compliance 16 / Availability 6)
// and the client's Client Care Needs (25) all live on the CONTACT, not the
// opportunity. These are the read and write halves; the definitions come from
// getEditableFieldDefs("contact").
//
// ⚠️ A CONTACT CAN HOLD SEVERAL OPPORTUNITIES. Writing one of these changes it
// for every one of them. That is correct — the value describes the PERSON, not
// the case — but it is why the read below also returns how many opportunities
// the contact has, so the panel can say so instead of implying case scope.
// ═════════════════════════════════════════════════════════════════════════

export interface ContactFieldsRead {
  contactId: string;
  /** fieldId -> raw stored value. Codes, never labels — see the note below. */
  values: Record<string, unknown>;
  /**
   * 🔴 GHL's `dateUpdated` — CONTACTS DO NOT HAVE `updatedAt` AT ALL.
   *
   * VERIFIED LIVE: `"dateUpdated": "2026-09-01T14:39:06.979Z"`, with no
   * `updatedAt` key in the response. Opportunities are the other way round
   * (normalizeOpportunity reads `updatedAt` first), so a guard written against
   * the opportunity spelling finds NOTHING on a contact — and `isStale()`
   * treats a missing stored version as "go ahead". The concurrency check would
   * then silently no-op: precisely the failure it exists to prevent, with no
   * error to notice. Read `dateUpdated` FIRST and keep it that way.
   */
  version: string;
}

/**
 * Read a contact's custom-field values.
 *
 * ⚠️ VALUES ARE CODES, NOT LABELS — "PAID", "LIVE_IN", "DRIVE_CLIENTS". The
 * application form's routing conditions on these exact strings. Nothing here
 * transliterates, title-cases or trims them into something friendlier: a
 * display map belongs in the UI, and the stored value must stay the code.
 */
export async function getContactCustomFields(
  contactId: string,
): Promise<ContactFieldsRead> {
  const data = await ghlGet<{ contact?: RawContact }>(
    `/contacts/${encodeURIComponent(contactId)}`,
  );
  const c = data.contact || {};
  const values: Record<string, unknown> = {};
  const raw = (c as Record<string, unknown>).customFields;
  if (Array.isArray(raw)) {
    for (const f of raw as Record<string, unknown>[]) {
      const id = String(f.id ?? f.customFieldId ?? "");
      if (!id) continue;
      // ✅ `value` FIRST — that is what a CONTACT returns (verified live). The
      // rest are tolerated fallbacks for field types seen to differ; do not
      // reorder them to match the opportunity path.
      values[id] = f.value ?? f.field_value ?? f.fieldValue ?? f.selectedOptions ?? "";
    }
  }
  return {
    contactId,
    values,
    version: String(
      (c as Record<string, unknown>).dateUpdated ??
        (c as Record<string, unknown>).updatedAt ??
        "",
    ),
  };
}

/** How many opportunities this contact holds — the scope the panel must state. */
export async function countContactOpportunities(contactId: string): Promise<number> {
  const { locationId } = requireEnv();
  const params = new URLSearchParams({
    location_id: locationId,
    contact_id: contactId,
    limit: "100",
  });
  try {
    const res = await ghlGet<{ opportunities?: unknown[]; meta?: { total?: number } }>(
      `/opportunities/search?${params.toString()}`,
    );
    return res.meta?.total ?? (res.opportunities?.length || 0);
  } catch {
    // Best-effort. The panel says "all of this person's records" rather than a
    // number when this fails — never blocks the read.
    return 0;
  }
}

/**
 * Write custom-field values onto a contact.
 *
 * The value is sent AS GIVEN. See the codes-not-labels note above.
 */
export async function updateContactCustomFields(
  contactId: string,
  entries: { id: string; value: unknown }[],
): Promise<void> {
  if (!entries.length) return;
  await ghlSend(
    "PUT",
    `/contacts/${encodeURIComponent(contactId)}`,
    // 🔴 `value`, NOT `field_value`. VERIFIED LIVE: contacts speak
    // { id, value }; opportunities speak { id, field_value }. This originally
    // sent the OPPORTUNITY spelling — the exact "assume the shapes match"
    // mistake. The read side below was already `value`-first; the write was not.
    //
    // ✅ VERIFIED LIVE: a PARTIAL customFields array UPDATES, it does not
    // replace. Writing one field left Record Type (and every other unlisted
    // field) intact. So the panel sends ONLY the field that changed — no
    // read-modify-write, and no risk of a stale read blanking a field someone
    // else set in between.
    { customFields: entries.map((e) => ({ id: e.id, value: e.value })) },
  );
}
