import type {
  OpportunityRecord,
  EditableFieldDef,
  ResourceFile,
} from "./types";
import { isFieldEditable } from "./editable";
import {
  PIPELINE_FOLDERS,
  FOLDERS,
  folderKeyById,
  folderIdsPresent,
} from "./fieldFolders";
import { divisionLabel } from "./division";
import { formatEasternNoZone } from "./dates";
import { e164, emailKey, phoneKey } from "./phone";
import { mapLimit, type Settled } from "./concurrency";
import { getCaseManagers } from "./pipelineAccess";
import { indexCaseHolders, matchCaseHolders } from "./peopleSearch";

export const RESOURCES_FOLDER_ID = (
  process.env.RESOURCES_FOLDER_ID || ""
).trim();

import { normalizeTag } from "./batchTag";
import {
  PIPELINE_CONFIG_CUSTOM_VALUE_NAME,
  parsePipelineConfig,
  serialisePipelineConfig,
  emptyPipelineConfig,
  idsInScope,
  SEED_FOLDER_NAMES,
  SEED_TICKED_ON_CLIENT,
  type StoredPipelineConfig,
  type PipelineScope as StoredScope,
} from "./pipelineConfig";

const BASE_URL = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";

export class GhlError extends Error {
  status: number;
  detail?: string;

  traceId?: string;

  code?: string;

  dupContactId?: string;
  dupField?: string;
  dupName?: string;
  constructor(
    message: string,
    status: number,
    detail?: string,
    meta?: {
      traceId?: string;
      code?: string;
      dupContactId?: string;
      dupField?: string;
      dupName?: string;
    },
  ) {
    super(message);
    this.name = "GhlError";
    this.status = status;
    this.detail = detail;
    this.traceId = meta?.traceId;
    this.code = meta?.code;
    this.dupContactId = meta?.dupContactId;
    this.dupField = meta?.dupField;
    this.dupName = meta?.dupName;
  }
}

export function ghlErrorMeta(raw: string): {
  traceId?: string;
  code?: string;

  dupContactId?: string;

  dupField?: string;

  dupName?: string;
} {
  try {
    const j = JSON.parse((raw || "").trim()) as Record<string, unknown>;
    const traceId =
      typeof j.traceId === "string"
        ? j.traceId
        : typeof j.trace_id === "string"
          ? j.trace_id
          : undefined;

    const hay = `${typeof j.error === "string" ? j.error : ""} ${
      typeof j.message === "string" ? j.message : ""
    } ${Array.isArray(j.message) ? j.message.join(" ") : ""}`;
    const m = /\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,6})\b/.exec(hay);

    const meta = (j.meta ?? {}) as Record<string, unknown>;
    const nested = (meta.contact ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v ? v : undefined;
    return {
      traceId,
      code: m ? m[1] : undefined,
      dupContactId:
        str(meta.contactId) ??
        str(meta.contact_id) ??
        str(nested.id) ??
        str(j.contactId) ??
        str((j as Record<string, unknown>).contact_id),

      dupField: str(meta.matchingField) ?? str(meta.matching_field),
      dupName: str(meta.contactName) ?? str(meta.contact_name) ?? str(nested.name),
    };
  } catch {
    return {};
  }
}

function ghlMessage(raw: string): string {
  const text = (raw || "").trim();
  if (!text) return "";
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: unknown };
    const m = j.message ?? j.error;
    if (Array.isArray(m)) return m.map(String).join("; ").slice(0, 500);
    if (typeof m === "string" && m.trim()) return m.trim().slice(0, 500);
  } catch {

  }
  return text.slice(0, 500);
}

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

    }
    try {
      which =
        (await getPipelines()).find((p) => p.id === pipelineId)?.name ||
        pipelineId;
    } catch {

    }
    return `${who} doesn't have access to the "${which}" pipeline in GoHighLevel, so they can't be made owner of this record. Grant it in GoHighLevel → Settings → Opportunities → Pipelines → the key icon on "${which}", then try again.`;
  }

  if (
    /OPPORTUNITY_NO_DUPLICATE/i.test(raw) ||
    /duplicate opportunity for the contact/i.test(raw)
  ) {

    if (/\bevents?\b/i.test(raw))
      return (
        "GoHighLevel allows only ONE opportunity per contact per pipeline, and " +
        "this partner already hosts an event. That is a limit in GoHighLevel, " +
        "not a rule this dashboard chose — and it means a partner can currently " +
        "hold one event ever. Nothing was created and nothing was changed."
      );
    return "This client already has a case in the destination pipeline. GoHighLevel allows only ONE opportunity per contact per pipeline, so this record can't be moved there. Close or move the existing case first, then try again. (GoHighLevel's own message says \"create\" — it fires on updates too; nothing was duplicated.)";
  }

  if (/duplicated\s+contacts/i.test(raw) || /DUPLICATED_CONTACT/i.test(raw))
    return (
      "That phone number or email address already belongs to another person in " +
      "GoHighLevel, and this account does not allow two contacts to share one. " +
      "Nothing was changed. Find the other person and merge or correct them in " +
      "GoHighLevel, then try again."
    );

  return e.detail || e.message;
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

function isGhlTimeout(status: number, body: string): boolean {
  return status === 401 && /timed?\s*out/i.test(body);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RateLimitSnapshot {
  max: number | null;
  remaining: number | null;
  intervalMs: number | null;
  dailyLimit: number | null;
  dailyRemaining: number | null;

  at: number;
}

let lastRateLimit: RateLimitSnapshot | null = null;

export function getRateLimitSnapshot(): RateLimitSnapshot | null {
  return lastRateLimit;
}

function num(res: Response, name: string): number | null {

  const h = res.headers.get(name);
  if (h === null || h.trim() === "") return null;
  const v = Number(h);
  return Number.isFinite(v) ? v : null;
}

function readRateLimit(res: Response): void {
  const max = num(res, "x-ratelimit-max");
  const remaining = num(res, "x-ratelimit-remaining");
  if (max == null && remaining == null) return;
  lastRateLimit = {
    max,
    remaining,
    intervalMs: num(res, "x-ratelimit-interval-milliseconds"),
    dailyLimit: num(res, "x-ratelimit-limit-daily"),
    dailyRemaining: num(res, "x-ratelimit-daily-remaining"),
    at: Date.now(),
  };
}

function rateLimitWaitMs(res: Response, attempt: number): number {
  const explicit = Number(res.headers.get("retry-after"));
  if (Number.isFinite(explicit) && explicit > 0)
    return Math.min(explicit * 1000, 6000);
  const interval = num(res, "x-ratelimit-interval-milliseconds") ?? 10000;

  const wait = Math.round((interval * attempt) / 5);
  return Math.min(Math.max(wait, 800), 6000);
}

const RL_FLOOR = 5;
async function pauseIfNearLimit(): Promise<void> {
  const s = lastRateLimit;
  if (!s || s.remaining == null) return;

  const interval = s.intervalMs ?? 10000;
  if (Date.now() - s.at > interval) return;
  if (s.remaining > RL_FLOOR) return;
  // eslint-disable-next-line no-console
  console.warn(
    `[ghl] ${s.remaining} of ${s.max ?? "?"} requests left in this ${interval}ms window — pausing briefly.`,
  );
  await sleep(Math.min(Math.round(interval / 10), 1200));
}

function rateLimitError(pathname: string, attempts: number): GhlError {
  const s = lastRateLimit;
  return new GhlError(
    "GoHighLevel is rate-limiting us. Try again in a few seconds.",
    429,
    `${pathname} was refused with 429 after ${attempts} attempts. ` +
      (s
        ? `Last headers: ${s.remaining ?? "?"} of ${s.max ?? "?"} left in a ` +
          `${s.intervalMs ?? "?"}ms window; ${s.dailyRemaining ?? "?"} of ` +
          `${s.dailyLimit ?? "?"} left today.`
        : "No rate-limit headers were returned.") +
      " This is a burst limit, not a quota problem — nothing is wrong with the account.",
  );
}

const RL_ATTEMPTS = 3;

async function ghlGet<T>(path: string, attempt = 1): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  let res: Response;

  await pauseIfNearLimit();
  try {
    res = await fetch(url, { headers: headers(), cache: "no-store" });
  } catch (e) {
    throw new GhlError(
      "Could not reach GoHighLevel.",
      502,
      e instanceof Error ? e.message : String(e),
    );
  }
  readRateLimit(res);
  if (!res.ok) {
    let raw = "";
    try {
      raw = await res.text();
    } catch {

    }
    let detail = ghlMessage(raw).slice(0, 500);
    const meta = ghlErrorMeta(raw);

    if (res.status === 429) {
      if (attempt < RL_ATTEMPTS) {
        const wait = rateLimitWaitMs(res, attempt);
        // eslint-disable-next-line no-console
        console.warn(
          `[ghl] 429 on ${new URL(url).pathname} — attempt ${attempt} of ` +
            `${RL_ATTEMPTS}, retrying in ${wait}ms. ` +
            `remaining=${lastRateLimit?.remaining ?? "?"}`,
        );
        await sleep(wait);
        return ghlGet<T>(path, attempt + 1);
      }

      throw rateLimitError(new URL(url).pathname, RL_ATTEMPTS);
    }

    if (isGhlTimeout(res.status, raw) && attempt === 1) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ghl] 401 "Command timed out" on ${new URL(url).pathname} — GoHighLevel's own timeout, not an auth failure. Retrying once.`,
      );
      return ghlGet<T>(path, 2);
    }

    if (isGhlTimeout(res.status, raw)) {

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

function retryableWrite(method: string, idempotent?: boolean): boolean {
  if (idempotent) return true;
  return method === "PUT" || method === "PATCH";
}

async function ghlDelete<T = unknown>(
  path: string,
  opts?: { body?: unknown; goneOk?: RegExp; what?: string },
  attempt = 1,
): Promise<T | null> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  const what = opts?.what || "the record";
  await pauseIfNearLimit();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "DELETE",
      headers:
        opts?.body === undefined
          ? headers()
          : { ...headers(), "Content-Type": "application/json" },
      ...(opts?.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      cache: "no-store",
    });
  } catch (e) {
    throw new GhlError(
      "Could not reach GoHighLevel.",
      502,
      e instanceof Error ? e.message : String(e),
    );
  }
  readRateLimit(res);

  if (res.ok) {
    const txt = await res.text().catch(() => "");
    if (!txt.trim()) return null;
    try {
      return JSON.parse(txt) as T;
    } catch {
      return null;
    }
  }

  const raw = await res.text().catch(() => "");

  if (res.status === 429) {
    if (attempt < RL_ATTEMPTS) {
      const wait = rateLimitWaitMs(res, attempt);
      // eslint-disable-next-line no-console
      console.warn(
        `[ghl] 429 on DELETE ${new URL(url).pathname} — attempt ${attempt} of ` +
          `${RL_ATTEMPTS}, retrying in ${wait}ms.`,
      );
      await sleep(wait);
      return ghlDelete<T>(path, opts, attempt + 1);
    }
    throw rateLimitError(`DELETE ${new URL(url).pathname}`, RL_ATTEMPTS);
  }

  if (opts?.goneOk && (res.status === 404 || opts.goneOk.test(raw))) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ghl] DELETE ${new URL(url).pathname} -> ${res.status}, but GoHighLevel ` +
        `says it is already gone. Treating as success: ${ghlMessage(raw).slice(0, 120)}`,
    );
    return null;
  }

  throw new GhlError(
    `GoHighLevel returned ${res.status} deleting ${what}.`,
    res.status,
    ghlMessage(raw),
    ghlErrorMeta(raw),
  );
}

async function ghlSend<T>(
  method: "PUT" | "POST" | "PATCH",
  path: string,
  body: unknown,
  attempt = 1,
  opts?: { idempotent?: boolean },
): Promise<T> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  let res: Response;
  await pauseIfNearLimit();
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

    }
    const detail = ghlMessage(raw);
    const meta = ghlErrorMeta(raw);

    if (res.status === 429) {
      const safe = retryableWrite(method, opts?.idempotent);
      if (safe && attempt < RL_ATTEMPTS) {
        const wait = rateLimitWaitMs(res, attempt);
        // eslint-disable-next-line no-console
        console.warn(
          `[ghl] 429 on ${method} ${new URL(url).pathname} — attempt ${attempt} ` +
            `of ${RL_ATTEMPTS}, retrying in ${wait}ms.`,
        );
        await sleep(wait);
        return ghlSend<T>(method, path, body, attempt + 1, opts);
      }
      if (!safe)
        // eslint-disable-next-line no-console
        console.warn(
          `[ghl] 429 on ${method} ${new URL(url).pathname} — NOT retried: a ` +
            "POST here creates a record, and a retry after a 429 that landed " +
            "server-side would duplicate it. Surfacing it instead.",
        );
      throw rateLimitError(
        `${method} ${new URL(url).pathname}`,
        safe ? RL_ATTEMPTS : 1,
      );
    }

    if (isGhlTimeout(res.status, raw) && attempt === 1) {
      // eslint-disable-next-line no-console
      console.warn(
        `[ghl] 401 "Command timed out" on ${method} ${new URL(url).pathname} — GoHighLevel's own timeout, not auth. Retrying once.`,
      );
      return ghlSend<T>(method, path, body, 2, opts);
    }
    if (isGhlTimeout(res.status, raw)) {
      throw new GhlError(
        "GoHighLevel didn't respond.",
        502,
        `GoHighLevel returned 401 "${detail}" for ${method} ${new URL(url).pathname}. That is its own backend timeout, not an authentication failure — the token is fine. Retried once already.`,
        meta,
      );
    }

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

export async function updateOpportunity(
  id: string,
  body: Record<string, unknown>,
): Promise<OpportunityRecord | null> {
  await ghlSend("PUT", `/opportunities/${encodeURIComponent(id)}`, body);

  invalidateOpportunity(id);
  const rec = await getOpportunityByIdUncached(id);

  if ("assignedTo" in body)

    await applyCaseManagers(id, String(body.assignedTo ?? ""), rec);

  return rec;
}

interface Pipeline {
  id: string;
  name: string;

  stages: { id: string; name: string; position?: number }[];
}

const NEW_ENQUIRY_STAGE = /\bnew\b|enquir|inquir|\bintake\b|\blead\b|initial call|\bapplied\b|\bapplicant\b/i;
const TRANSFER_STAGE = /transferred\s*in|^\s*transfer\b/i;

export function entryStage(
  p: { stages?: { id: string; name: string; position?: number }[] } | null | undefined,
): { id: string; name: string; fellBack: boolean; why: string } {
  const stages = p?.stages || [];
  if (!stages.length) return { id: "", name: "", fellBack: true, why: "the pipeline has no stages" };
  const byPosition = [...stages].sort((a, b) => {
    const pa = Number.isFinite(a.position) ? (a.position as number) : Number.MAX_SAFE_INTEGER;
    const pb = Number.isFinite(b.position) ? (b.position as number) : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
  const named = byPosition.find(
    (s) => NEW_ENQUIRY_STAGE.test(s.name) && !TRANSFER_STAGE.test(s.name),
  );
  if (named) return { id: named.id, name: named.name, fellBack: false, why: "named as a new enquiry" };
  const notTransfer = byPosition.find((s) => !TRANSFER_STAGE.test(s.name));
  if (notTransfer)
    return {
      id: notTransfer.id,
      name: notTransfer.name,
      fellBack: false,
      why: "the earliest stage that is not a transfer",
    };

  const f = byPosition[0];
  return {
    id: f.id,
    name: f.name,
    fellBack: true,
    why: "every stage in this pipeline reads as a transfer",
  };
}

export function firstStage(
  p: { stages?: { id: string; name: string; position?: number }[] } | null | undefined,
): { id: string; name: string } {
  const stages = p?.stages || [];
  if (!stages.length) return { id: "", name: "" };
  const ordered = [...stages].sort((a, b) => {
    const pa = Number.isFinite(a.position) ? (a.position as number) : Number.MAX_SAFE_INTEGER;
    const pb = Number.isFinite(b.position) ? (b.position as number) : Number.MAX_SAFE_INTEGER;
    return pa - pb;
  });
  return { id: ordered[0].id, name: ordered[0].name };
}

export interface FieldDefinition {
  id: string;
  name: string;
  dataType: string;
  fieldKey?: string;

  [key: string]: unknown;
}

let cache: {
  pipelines?: Pipeline[];
  fieldDefs?: FieldDefinition[];

  contactFieldDefs?: FieldDefinition[];
  fieldMap?: Map<string, string>;
  userMap?: Map<string, string>;
} = {};

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

const DEFAULT_PIPELINE_IDS = [
  "KGjdCMG4F8xILk0ineB9",
  "74Pt3XX4hgBIqD10mW4G",
  "a14NtTi18ACxs99bHPmL",
  "PIs1iWVk0HqHZFNtmoTn",
  "BJBWdRim6SOgjoMelVSZ",
];

const DEFAULT_CAREGIVER_PIPELINE_IDS = [
  "EXVMveGzgDy9qf4wQR2H",
  "232bytrK7FWNAwC6shME",
];

function parseIds(raw: string, fallback: string[]): string[] {
  const t = (raw || "").trim();
  if (!t) return fallback;
  const ids = t.split(/[\s,|]+/).map((x) => x.trim()).filter(Boolean);
  return ids.length ? ids : fallback;
}

export function pipelineIds(): string[] {
  return parseIds(process.env.PIPELINE_IDS || "", DEFAULT_PIPELINE_IDS);
}

export function caregiverPipelineIds(): string[] {
  return parseIds(
    process.env.CAREGIVER_PIPELINE_IDS || "",
    DEFAULT_CAREGIVER_PIPELINE_IDS,
  );
}

export type PipelineScope = "client" | "caregiver" | "none";

export function idsForScope(scope: PipelineScope): string[] {

  if (scope === "caregiver") return caregiverPipelineIds();
  if (scope === "none") return [];
  return pipelineIds();
}

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

export async function getSelectedPipelines(
  scope: PipelineScope = "client",
): Promise<Pipeline[]> {
  if (scope === "client") checkPipelineConfig();

  let ids: string[];
  try {
    ids = await configuredIds(scope);
    if (!ids.length) ids = idsForScope(scope);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[config] pipeline config unreadable, falling back to env:", e);
    ids = idsForScope(scope);
  }
  const pipelines = await getPipelines();
  const byId = new Map(pipelines.map((p) => [p.id, p]));
  const selected: Pipeline[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    if (p) selected.push(p);
  }

  if (scope === "none" && !ids.length) return [];
  if (!selected.length) {
    throw new GhlError(
      "None of the configured pipelines matched this account's pipelines.",
      404,
      `Configured: ${ids.join(", ")}. Available: ${pipelines
        .map((p) => `${p.name} (${p.id})`)
        .join(", ")}`,
    );
  }
  return selected;
}

function stageKey(pipelineId: string, stageId: string): string {
  return `${pipelineId}::${stageId}`;
}

async function getFieldMap(): Promise<Map<string, string>> {
  if (cache.fieldMap) return cache.fieldMap;
  const map = new Map<string, string>();

  for (const f of await getFieldDefinitions()) {
    if (f.id) map.set(f.id, f.name || f.fieldKey || "");
  }
  cache.fieldMap = map;
  return map;
}

export async function getLocationUserIds(): Promise<Set<string>> {
  return new Set((await getUserMap()).keys());
}

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
    return map;
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
  assignedTo?: string | null;
  followers?: string[];
  source?: string;
  status?: string;
  monetaryValue?: number;
  contactId?: string;
  contact?: {
    id?: string;
    name?: string;
    firstName?: string;
    lastName?: string;

    tags?: unknown;

    email?: string;
    phone?: string;
  };
  customFields?: RawCustomField[];

  lastStageChangeAt?: string;
  lastStageChangedAt?: string;
  lastStatusChangeAt?: string;

  updatedAt?: string;
  dateUpdated?: string;

  createdAt?: string;
  dateAdded?: string;
}

const KNOWN_CF_KEYS = [
  "fieldValueArray",
  "fieldValueDate",
  "fieldValueNumber",
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

export function toGhlDate(value: unknown): string {
  if (value == null) return "";
  const s = String(value).trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T12:00:00.000Z`;

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s))
    return new Date(`${s}${s.length === 16 ? ":00" : ""}Z`).toISOString();
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
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

    if (meta.startAfterId === startAfterId && meta.startAfter === startAfter) {
      break;
    }
    startAfter = meta.startAfter;
    startAfterId = meta.startAfterId;
  }
  return all;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const FIELD_ALIASES: Record<keyof OpportunityRecord, string[]> = {
  harmony: ["harmonyid", "harmony"],
  countyId: ["countyid"],
  office: ["office"],
  county: ["county"],
  block: ["roadblocker", "roadblock", "blocker", "roadblockers"],
  ref: ["referralsourcetype", "referralsource", "referral"],
  src: [],
  asst: ["salesrepassistant", "repassistant", "assistant", "salesassistant"],
  cm: ["casemanager", "casemgr"],
  onb: ["onboardingrep", "onboarding", "onboardingrepresentative"],
  cg: ["caregivername", "caregiver"],
  checked: ["checkedthisweek", "checked", "checkedweek"],

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
  tags: [],
  pipelineId: [],
  pipelineName: [],
  shared: [],
  stageChangedAt: [],
  createdAt: [],

  statusChangedAt: [],
  version: [],

  firstOpened: ["firstopened"],
  newLead: [],
};

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
  stageNameByKey: Map<string, string>,
  pipelineNameById: Map<string, string>,
): OpportunityRecord {
  const pipelineId = opp.pipelineId || "";
  const rec: OpportunityRecord = {
    id: opp.id,

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
    shared: false,

    version: String(opp.updatedAt ?? opp.dateUpdated ?? ""),

    stageChangedAt: String(opp.lastStageChangeAt ?? ""),

    statusChangedAt: String(opp.lastStatusChangeAt ?? ""),
    createdAt: String(opp.createdAt ?? opp.dateAdded ?? ""),

    firstOpened: "",
  };

  rec.followerNames = rec.followerIds.map(
    (id) => userMap.get(id) || "Former user",
  );

  rec.src = opp.source || "";

  for (const cf of opp.customFields || []) {
    if (cf.id) rec.cf[cf.id] = cfRaw(cf);
  }

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

  const stageId = opp.pipelineStageId || opp.stageId || "";
  rec.stage = stageNameByKey.get(stageKey(pipelineId, stageId)) || "";

  if (opp.assignedTo) {
    rec.rep = userMap.get(opp.assignedTo) || "Former user";
  }

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

      if (val) (rec[key] as string) = val;
    }
  }

  if (!rec.block) rec.block = "None";
  return rec;
}

function optionToString(o: unknown): string {
  if (o == null) return "";
  if (typeof o === "string") return o;
  if (typeof o === "object") {
    const r = o as Record<string, unknown>;

    const v = r.value ?? r.name ?? r.label ?? r.key ?? r.option ?? "";
    return typeof v === "string" ? v : String(v ?? "");
  }
  return String(o);
}

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

    parentName: String(
      (d as Record<string, unknown>).parentName ??
        (d as Record<string, unknown>).folderName ??
        (d as Record<string, unknown>).parentFolderName ??
        "",
    ),

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

  failedPipelines?: { id: string; name: string; error: string }[];
  pipeline: { id: string; name: string } | null;
  pipelines: { id: string; name: string }[];
  stages: { id: string; name: string }[];
  stagesByPipeline: Record<string, { id: string; name: string }[]>;
  users: { id: string; name: string }[];
  fieldDefs: EditableFieldDef[];
}> {
  const selected = await getSelectedPipelines(scope);

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

  const [fieldMap, userMap, fieldDefs] = await Promise.all([
    getFieldMap(),
    getUserMap(),
    getEditableFieldDefs(),
  ]);

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

    for (const o of res.value) if (!o.pipelineId) o.pipelineId = p.id;
    raw.push(...res.value);
  });

  const records = raw.map((o) =>
    normalizeOpportunity(o, fieldMap, userMap, stageNameByKey, pipelineNameById),
  );

  const users = [...userMap.entries()].map(([id, name]) => ({ id, name }));

  return {
    records,
    pipeline: null,
    pipelines: selected.map((p) => ({ id: p.id, name: p.name })),
    stages: unionStages,
    stagesByPipeline,
    users,
    fieldDefs,
    failedPipelines,
  };
}

export async function getOpportunitiesInPipeline(pipe: {
  id: string;
  name: string;
  stages?: { id: string; name: string }[];
}): Promise<OpportunityRecord[]> {
  const [fieldMap, userMap] = await Promise.all([getFieldMap(), getUserMap()]);
  const stageNameByKey = new Map<string, string>();
  for (const st of pipe.stages || []) stageNameByKey.set(stageKey(pipe.id, st.id), st.name);
  const pipelineNameById = new Map<string, string>([[pipe.id, pipe.name]]);
  const raw = await searchAll(pipe.id);
  for (const o of raw) if (!o.pipelineId) o.pipelineId = pipe.id;
  return raw.map((o) =>
    normalizeOpportunity(o, fieldMap, userMap, stageNameByKey, pipelineNameById),
  );
}

interface RawNote {
  id?: string;
  body?: string;
  userId?: string;
  dateAdded?: string;
  relations?: { objectKey?: string; recordId?: string }[];
}

export interface OppNote {
  id: string;
  who: string;
  when: string;
  txt: string;

  isMove: boolean;
  system: string;
  reason: string;

  authorId: string;
  edited: boolean;
  removed: boolean;
}

function fmtNoteDate(iso?: string): string {
  if (!iso) return "";
  const out = formatEasternNoZone(iso);
  return out || iso;
}

function noteBelongsToOpp(n: RawNote, oppId: string): boolean {
  return (n.relations || []).some(
    (r) => r.objectKey === "opportunity" && r.recordId === oppId,
  );
}

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

        division: parsed.division,
        txt: parsed.text,
        authorId: n.userId || "",
        edited: parsed.edited,
        removed: parsed.removed,

        isMove: parsed.isMove,
        system: parsed.system,
        reason: parsed.reason,
      };
    });
}

export async function latestContactNoteAt(contactId: string): Promise<string> {
  const data = await ghlGet<{ notes?: RawNote[] }>(
    `/contacts/${encodeURIComponent(contactId)}/notes`,
  );
  let newest = "";
  for (const n of data.notes || []) {
    const d = String(n.dateAdded || "");
    if (!d) continue;
    if (!newest || new Date(d).getTime() > new Date(newest).getTime()) newest = d;
  }
  return newest;
}

export async function setContactOwner(contactId: string, userId: string): Promise<void> {
  if (!contactId || !userId) return;
  await ghlSend("PUT", `/contacts/${encodeURIComponent(contactId)}`, {
    assignedTo: userId,
  });

  const back = await getContactCustomFields(contactId).catch(() => null);
  if (back && back.assignedTo && back.assignedTo !== userId)

    // eslint-disable-next-line no-console
    console.warn(
      `[contact-owner] ${contactId}: wrote assignedTo=${userId} and the read-back still says ` +
        `${back.assignedTo}. Either GoHighLevel has not applied it yet (it applies some writes ` +
        `asynchronously) or the write was refused. NOT treated as a failure — the promote stands.`,
    );

}

export async function listContactNotes(
  contactId: string,
): Promise<{ id: string; when: string; dateAdded: string; who: string; txt: string }[]> {
  const data = await ghlGet<{ notes?: RawNote[] }>(
    `/contacts/${encodeURIComponent(contactId)}/notes`,
  );
  const userMap = await getUserMap();
  return (data.notes || [])
    .sort(
      (a, b) =>
        new Date(b.dateAdded || 0).getTime() - new Date(a.dateAdded || 0).getTime(),
    )
    .map((n) => ({
      id: n.id || "",
      when: fmtNoteDate(n.dateAdded),
      dateAdded: String(n.dateAdded || ""),
      who: (n.userId && userMap.get(n.userId)) || "GoHighLevel",

      txt: String(n.body || ""),
    }));
}

export async function addContactNote(
  contactId: string,
  body: string,
  userId: string,
): Promise<{ id: string; dateAdded: string }> {
  const res = await ghlSend<{ note?: RawNote }>(
    "POST",
    `/contacts/${encodeURIComponent(contactId)}/notes`,
    {
      body,
      ...(userId ? { userId } : {}),
      relations: [{ objectKey: "contact", recordId: contactId }],
    },
  );
  const n = res.note || {};
  return { id: n.id || "", dateAdded: String(n.dateAdded || "") };
}

const DIVISION_TAG = /^\s*\[([^\]]{1,40})\]\s*/;

const EDITED_TAG = "edited";

const REMOVED_TAG = "removed";

const REASON_SEP = "\u001F";

const MOVE_TAG = "move";

const LEGACY_MOVE =
  /^(Moved from .+? to .+?\.(?: New owner: .+?\.)?|Stage changed in .+?\.)\s*(?:Reason:\s*)?([\s\S]*)$/;

export interface NoteParts {
  division: string;
  edited: boolean;
  removed: boolean;
  isMove: boolean;
  system: string;
  reason: string;
  text: string;
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
    else break;
    rest = rest.slice(m[0].length);
  }

  let system = "";
  let reason = rest;
  const sep = rest.indexOf(REASON_SEP);
  if (sep >= 0) {

    system = rest.slice(0, sep).trim();
    reason = rest.slice(sep + REASON_SEP.length).trim();
  } else {

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

  return `${tags}${system}${REASON_SEP}${p.reason}`;
}

export function stampDivision(body: string, division: string): string {
  return composeNoteBody({ division, reason: body });
}

export function buildNoteBody(
  text: string,
  division: string,
  edited: boolean,
  removed = false,
): string {
  return composeNoteBody({ division, edited, removed, reason: text });
}

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

const oppBurst = new Map<string, { at: number; p: Promise<OpportunityRecord | null> }>();
const OPP_BURST_MS = 3000;

export async function getOpportunityById(
  id: string,
): Promise<OpportunityRecord | null> {
  const hit = oppBurst.get(id);
  if (hit && Date.now() - hit.at < OPP_BURST_MS) return hit.p;
  const p = getOpportunityByIdUncached(id);
  oppBurst.set(id, { at: Date.now(), p });

  p.catch(() => oppBurst.delete(id));
  if (oppBurst.size > 200) {
    const cutoff = Date.now() - OPP_BURST_MS;
    for (const [k, v] of oppBurst) if (v.at < cutoff) oppBurst.delete(k);
  }
  return p;
}

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

      id: String(f._id ?? f.id ?? ""),
      name: String(f.name ?? f.fileName ?? "Untitled"),
    }))
    .filter((f) => f.id)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (raw.length && !folders.length)
    // eslint-disable-next-line no-console
    console.error(
      `[media] /medias/files?type=folder returned ${raw.length} row(s) but NONE had a usable id. Keys on the first row: ${Object.keys(raw[0] || {}).join(", ")}`,
    );
  return folders;
}

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

  const id = String(
    res.folder?._id ?? res.folder?.id ?? res._id ?? res.id ?? "",
  );
  let actual = String(res.folder?.name ?? res.name ?? "");

  if (!actual || !id) {

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

export async function deleteMediaFile(fileId: string): Promise<void> {
  return deleteMediaFolder(fileId);
}

export async function deleteMediaFolder(folderId: string): Promise<void> {
  const { locationId } = requireEnv();
  const params = new URLSearchParams({
    altType: "location",
    altId: locationId,
  });

  await ghlDelete(`/medias/${encodeURIComponent(folderId)}?${params.toString()}`, {
    what: "the folder",
  });
}

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

  return all
    .filter((f) => String(f.parentId ?? f.folderId ?? "") === folderId)
    .map((f) => ({

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

  return all
    .filter((f) => String(f.parentId ?? f.folderId ?? "") === folderId)
    .map((f) => ({

      id: String(f._id ?? f.id ?? ""),
      name: String(f.name ?? f.fileName ?? f.originalName ?? "Untitled"),
      url: String(f.url ?? f.fileUrl ?? f.link ?? ""),
      type: String(f.type ?? f.mimeType ?? f.contentType ?? ""),
      size: Number(f.size ?? f.fileSize ?? 0) || 0,
    }))
    .filter((f) => f.url);
}

export interface ContactOpportunity {
  id: string;
  name: string;
  pipelineId: string;
  pipelineName: string;
  stage: string;
  status: string;

  createdAt: string;
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
      createdAt: String(o.createdAt ?? o.dateAdded ?? ""),
    };
  });
}

export async function listPipelines(): Promise<
  { id: string; name: string; stages: { id: string; name: string; position?: number }[] }[]
> {
  const ps = await getPipelines();
  return ps.map((p) => ({
    id: p.id,
    name: p.name,

    stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name, position: s.position })),
  }));
}

export const ACCESS_CUSTOM_VALUE_NAME = "MM Pipeline Access";

export interface LocationUser {
  id: string;
  name: string;
  email: string;
  role: string;
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

export interface AccessGrantsV2 {
  pipelines: AccessGrants;
  folders: AccessGrants;
  master: string[];

  caseManagers: AccessGrants;

  referralAccess: Record<string, ReferralAccess>;

  staffing: Record<string, StaffingLevel>;

  peerTransfer: string[];
}

export type StaffingLevel = "self" | "any";

export type ReferralAccess =
  | { mode: "agency" }
  | { mode: "divisions"; divisions: string[] };

const emptyV2 = (): AccessGrantsV2 => ({
  pipelines: {},
  folders: {},
  master: [],
  caseManagers: {},
  referralAccess: {},
  staffing: {},
  peerTransfer: [],
});

function asIdMap(v: unknown): AccessGrants {
  const out: AccessGrants = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, ids] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(ids)) continue;
    out[k] = ids.map(String).filter(Boolean);
  }
  return out;
}

function asReferralAccess(v: unknown): Record<string, ReferralAccess> {
  const out: Record<string, ReferralAccess> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [userId, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!userId || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const e = raw as Record<string, unknown>;
    if (e.mode === "agency") out[userId] = { mode: "agency" };
    else if (e.mode === "divisions")
      out[userId] = {
        mode: "divisions",
        divisions: Array.isArray(e.divisions)
          ? [...new Set(e.divisions.map(String).filter(Boolean))]
          : [],
      };
  }
  return out;
}

export function asStaffing(v: unknown): Record<string, StaffingLevel> {
  const out: Record<string, StaffingLevel> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [userId, raw] of Object.entries(v as Record<string, unknown>))
    if (userId && (raw === "self" || raw === "any")) out[userId] = raw;
  return out;
}

export function parseAccessValue(raw: string): AccessGrantsV2 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;

  if (
    "pipelines" in o || "folders" in o || "master" in o ||
    "caseManagers" in o || "referralAccess" in o ||
    "staffing" in o || "peerTransfer" in o
  ) {
    return {
      pipelines: asIdMap(o.pipelines),
      folders: asIdMap(o.folders),
      master: Array.isArray(o.master) ? o.master.map(String).filter(Boolean) : [],

      caseManagers: asIdMap(o.caseManagers),
      referralAccess: asReferralAccess(o.referralAccess),
      staffing: asStaffing(o.staffing),
      peerTransfer: Array.isArray(o.peerTransfer)
        ? [...new Set(o.peerTransfer.map(String).filter(Boolean))]
        : [],
    };
  }

  const flat = asIdMap(o);
  if (Object.keys(flat).length || Object.keys(o).length === 0)
    return { ...emptyV2(), pipelines: flat };
  return null;
}

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

export async function fetchPipelineAccessGrants(): Promise<AccessGrants | null> {
  const v2 = await fetchAccessGrantsV2();
  return v2 ? v2.pipelines : null;
}

function isEmptyGrantsObject(parsed: unknown): boolean {
  return (
    !!parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Object.keys(parsed as object).length === 0
  );
}

export async function saveAccessGrantsV2(
  patch: Partial<AccessGrantsV2>,
): Promise<{ id: string }> {
  const { locationId } = requireEnv();

  const current = (await fetchAccessGrantsV2()) ?? emptyV2();

  const next: AccessGrantsV2 = {
    pipelines: patch.pipelines ?? current.pipelines,
    folders: patch.folders ?? current.folders,
    master: patch.master ?? current.master,
    caseManagers: patch.caseManagers ?? current.caseManagers,
    referralAccess: patch.referralAccess ?? current.referralAccess,
    staffing: patch.staffing ?? current.staffing,
    peerTransfer: patch.peerTransfer ?? current.peerTransfer,
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

function bustFieldCaches(): void {
  cache.fieldDefs = undefined;
  cache.contactFieldDefs = undefined;
  cache.fieldMap = undefined;
}

export async function createFieldFolder(args: {
  name: string;
  model?: "opportunity" | "contact";
}): Promise<{ id: string; name: string }> {
  const { locationId } = requireEnv();
  const name = args.name.trim();
  if (!name) throw new GhlError("A section needs a name.", 400);

  const res = await ghlSend<Record<string, unknown>>(
    "POST",
    `/locations/${encodeURIComponent(locationId)}/customFields`,
    {
      name,
      documentType: "folder",
      model: args.model === "contact" ? "contact" : "opportunity",
    },
  );

  const id = pickCreatedId(res);
  if (!id)
    throw new GhlError(
      "GoHighLevel accepted the section but this app could not find an id in the reply — a section may now exist in GoHighLevel. Check before creating it again.",
      502,
      `Reply keys: ${Object.keys(res).join(", ") || "(empty)"}`,
    );
  bustFieldCaches();

  await rememberFolderName(id, name).catch(() => {});
  return { id, name };
}

export async function rememberFolderName(folderId: string, name: string): Promise<void> {
  if (!folderId || !name.trim()) return;
  const cfg = await getPipelineConfig();
  await savePipelineConfig({
    ...cfg,
    folderNames: { ...cfg.folderNames, [folderId]: name.trim() },
  });
}

export async function moveFieldToFolder(
  fieldId: string,
  parentId: string,
): Promise<{ ok: boolean; storedParent: string }> {
  const { locationId } = requireEnv();
  if (!fieldId || !parentId) throw new GhlError("A field and a section are required.", 400);

  const res = await ghlSend<Record<string, unknown>>(
    "PUT",
    `/locations/${encodeURIComponent(locationId)}/customFields/${encodeURIComponent(fieldId)}`,
    { parentId },
  );
  const storedParent = String(pickCreated(res).parentId ?? "");
  bustFieldCaches();
  return { ok: !storedParent || storedParent === parentId, storedParent };
}

function pickCreatedId(res: Record<string, unknown>): string {
  const direct = res.id ?? res._id;
  if (typeof direct === "string" && direct) return direct;
  for (const k of ["customField", "customFieldFolder", "field", "folder", "data"]) {
    const w = res[k];
    if (w && typeof w === "object") {
      const v = (w as Record<string, unknown>).id ?? (w as Record<string, unknown>)._id;
      if (typeof v === "string" && v) return v;
    }
  }
  return "";
}

function pickCreated(res: Record<string, unknown>): Record<string, unknown> {
  for (const k of ["customField", "customFieldFolder", "field", "folder", "data"]) {
    const w = res[k];
    if (w && typeof w === "object") return w as Record<string, unknown>;
  }
  return res;
}

export async function createCustomField(args: {
  name: string;
  dataType: string;
  parentId: string;
  options?: string[];
  model?: "opportunity" | "contact";
}): Promise<{ id: string; name: string; parentId: string; parentIdHonoured: boolean }> {
  const { locationId } = requireEnv();
  const name = args.name.trim();
  if (!name) throw new GhlError("A field needs a name.", 400);

  const body: Record<string, unknown> = {
    name,
    dataType: args.dataType,
    model: args.model === "contact" ? "contact" : "opportunity",
    documentType: "field",
  };
  if (args.parentId) body.parentId = args.parentId;

  if (args.options?.length)
    body.options = args.options.map((o) => String(o).trim()).filter(Boolean);

  const res = await ghlSend<Record<string, unknown>>(
    "POST",
    `/locations/${encodeURIComponent(locationId)}/customFields`,
    body,
  );
  const cf = pickCreated(res);
  const id = pickCreatedId(res);
  if (!id)
    throw new GhlError(
      "GoHighLevel accepted the field but this app could not find an id in the reply — a field may now exist in GoHighLevel. Check before creating it again.",
      502,
      `Reply keys: ${Object.keys(res).join(", ") || "(empty)"}`,
    );
  const storedParent = String(cf.parentId ?? "");
  bustFieldCaches();
  return {
    id,
    name: String(cf.name ?? name),
    parentId: storedParent,

    parentIdHonoured: !args.parentId || storedParent === args.parentId,
  };
}

export async function createPipeline(args: {
  name: string;
  stages: string[];
}): Promise<{ id: string; name: string; stages: { id: string; name: string }[] }> {
  const { locationId } = requireEnv();
  const name = args.name.trim();
  if (!name) throw new GhlError("A pipeline needs a name.", 400);
  const stageNames = args.stages.map((x) => x.trim()).filter(Boolean);

  if (!stageNames.length) throw new GhlError("A pipeline needs at least one stage.", 400);

  const res = await ghlSend<{ pipeline?: Pipeline; id?: string }>(
    "POST",
    "/opportunities/pipelines",
    {
      locationId,
      name,

      stages: stageNames.map((n, i) => ({ name: n, position: i })),
    },
  );
  cache.pipelines = undefined;
  const p = res.pipeline;
  return {
    id: String(p?.id ?? res.id ?? ""),
    name: String(p?.name ?? name),
    stages: (p?.stages || []).map((st) => ({ id: String(st.id), name: String(st.name) })),
  };
}

export async function countOpportunitiesInPipeline(
  pipelineId: string,
): Promise<number | null> {
  if (!pipelineId) return null;
  const { locationId } = requireEnv();
  const params = new URLSearchParams({
    location_id: locationId,
    pipeline_id: pipelineId,
    limit: "1",
  });
  const data = await ghlGet<SearchResponse>(
    `/opportunities/search?${params.toString()}`,
  );
  const total = data.meta?.total ?? data.total;
  if (typeof total === "number" && Number.isFinite(total)) return total;

  if ((data.opportunities || []).length) return (data.opportunities || []).length;
  return null;
}

export async function deleteOpportunity(oppId: string): Promise<void> {
  const id = String(oppId || "").trim();
  if (!id) throw new GhlError("No opportunity id.", 400);
  try {
    await ghlDelete(`/opportunities/${encodeURIComponent(id)}`, {
      what: "the record",
      goneOk: /\bis deleted\b|\bnot found\b|\bdoes ?n[o']?t exist\b/i,
    });
  } finally {
    invalidateOpportunity(id);
  }
}

export async function deletePipeline(pipelineId: string): Promise<void> {
  const { locationId } = requireEnv();
  const id = String(pipelineId || "").trim();
  if (!id) throw new GhlError("No pipeline id.", 400);
  try {
    await ghlDelete(
      `/opportunities/pipelines/${encodeURIComponent(id)}?locationId=${encodeURIComponent(locationId)}`,
      {
        what: "the pipeline",

        goneOk: /\bis deleted\b|\bnot found\b|\bdoes ?n[o']?t exist\b/i,
      },
    );
  } finally {

    cache.pipelines = undefined;
  }
}

async function findPipelineConfigValue(): Promise<{ id: string; value: string } | null> {
  const { locationId } = requireEnv();
  const data = await ghlGet<{ customValues?: RawCustomValue[] }>(
    `/locations/${encodeURIComponent(locationId)}/customValues`,
  );
  const hit = (data.customValues || []).find(
    (c) =>
      String(c.name ?? "").trim().toLowerCase() ===
      PIPELINE_CONFIG_CUSTOM_VALUE_NAME.toLowerCase(),
  );
  if (!hit) return null;
  return {
    id: String(hit.id ?? hit._id ?? ""),
    value: typeof hit.value === "string" ? hit.value : JSON.stringify(hit.value ?? ""),
  };
}

export async function savePipelineConfig(
  next: StoredPipelineConfig,
): Promise<StoredPipelineConfig> {
  const { locationId } = requireEnv();
  const body = serialisePipelineConfig(next);
  const existing = await findPipelineConfigValue();
  if (existing?.id) {
    await ghlSend(
      "PUT",
      `/locations/${encodeURIComponent(locationId)}/customValues/${encodeURIComponent(existing.id)}`,
      { name: PIPELINE_CONFIG_CUSTOM_VALUE_NAME, value: body },
    );
  } else {
    await ghlSend("POST", `/locations/${encodeURIComponent(locationId)}/customValues`, {
      name: PIPELINE_CONFIG_CUSTOM_VALUE_NAME,
      value: body,
    });
  }

  let parsed: StoredPipelineConfig | null = null;
  let lastRaw = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt > 1) await sleep(attempt * 400);
    const after = await findPipelineConfigValue();
    lastRaw = after?.value ?? "";
    parsed = after ? parsePipelineConfig(after.value) : null;
    if (parsed && sameConfig(parsed, next)) return parsed;
  }

  if (!parsed)
    throw new GhlError(
      "Pipeline configuration was written but could not be read back. Nothing has been changed on screen — check the \"MM Pipeline Folders\" custom value in GoHighLevel before trying again.",
      502,
    );

  throw new GhlError(
    "Pipeline configuration was saved, but reading it back three times still shows something different. Check it in GoHighLevel before changing anything else.",
    502,
    `${describeConfigDiff(next, parsed)} Stored value is ${lastRaw.length} characters; ` +
      `${body.length} were sent. (Round 90 stored 100,000 characters intact, so length is not the cause.)`,
  );
}

function sameConfig(a: StoredPipelineConfig, b: StoredPipelineConfig): boolean {
  const norm = (c: StoredPipelineConfig) => {
    const round = parsePipelineConfig(serialisePipelineConfig(c));
    return round ? serialisePipelineConfig(round) : "";
  };
  const na = norm(a);
  return !!na && na === norm(b);
}

function describeConfigDiff(
  sent: StoredPipelineConfig,
  got: StoredPipelineConfig,
): string {
  const ids = new Set([...Object.keys(sent.pipelines), ...Object.keys(got.pipelines)]);
  const diffs: string[] = [];
  for (const id of ids) {
    const a = sent.pipelines[id];
    const b = got.pipelines[id];
    if (!a) diffs.push(`${id}: stored but not sent`);
    else if (!b) diffs.push(`${id}: sent but not stored`);
    else if (JSON.stringify(a) !== JSON.stringify(b))
      diffs.push(`${id}: sent ${JSON.stringify(a)}, stored ${JSON.stringify(b)}`);
  }
  if (!diffs.length) return "The pipelines match; the difference is elsewhere in the value.";
  return `Differs on ${diffs.length} pipeline(s): ${diffs.slice(0, 4).join(" · ")}.`;
}

let folderNameBackfillDone = false;

function backfillFolderNames(
  cfg: StoredPipelineConfig,

  present?: Set<string>,
): {
  cfg: StoredPipelineConfig;
  added: string[];
} {
  const added = Object.keys(SEED_FOLDER_NAMES).filter(
    (id) => !(cfg.folderNames || {})[id] && !!present?.has(id),
  );
  if (!added.length) return { cfg, added };
  const folderNames = { ...cfg.folderNames };

  for (const id of added) folderNames[id] = SEED_FOLDER_NAMES[id];
  return { cfg: { ...cfg, folderNames }, added };
}

export async function getPipelineConfig(): Promise<StoredPipelineConfig> {
  const found = await findPipelineConfigValue();
  const parsed = found ? parsePipelineConfig(found.value) : null;
  if (parsed?.seeded) {

    let present: Set<string> | undefined;
    try {
      const [oppDefs, contactDefs] = await Promise.all([
        getEditableFieldDefs("opportunity"),
        getEditableFieldDefs("contact"),
      ]);
      present = folderIdsPresent([...oppDefs, ...contactDefs]);
    } catch {

      present = undefined;
    }
    const { cfg, added } = backfillFolderNames(parsed, present);
    if (!added.length) return parsed;

    if (!folderNameBackfillDone) {
      folderNameBackfillDone = true;
      try {
        return await savePipelineConfig(cfg);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[pipeline-config] could not persist ${added.length} seeded folder name(s) (${added.join(", ")}); serving them from memory instead: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return cfg;
  }
  if (found && !parsed) {

    throw new GhlError(
      `The "${PIPELINE_CONFIG_CUSTOM_VALUE_NAME}" custom value exists but is not readable JSON. It is not being overwritten — repair or clear it in GoHighLevel.`,
      502,
    );
  }
  return seedPipelineConfig();
}

export async function seedPipelineConfig(): Promise<StoredPipelineConfig> {
  const next = emptyPipelineConfig();

  let present = new Set<string>();
  try {
    const [oppDefs, contactDefs] = await Promise.all([
      getEditableFieldDefs("opportunity"),
      getEditableFieldDefs("contact"),
    ]);
    present = folderIdsPresent([...oppDefs, ...contactDefs]);
  } catch {
    present = new Set<string>();
  }
  const mine = (fid: string) => present.has(fid);
  next.folderNames = Object.fromEntries(
    Object.entries(SEED_FOLDER_NAMES).filter(([id]) => mine(id)),
  );

  const seededFolderIds = [...SEED_TICKED_ON_CLIENT].filter(mine);
  const add = (ids: string[], scope: StoredScope) => {
    for (const id of ids) {
      const mapped = Object.prototype.hasOwnProperty.call(PIPELINE_FOLDERS, id)
        ? PIPELINE_FOLDERS[id]
        : [FOLDERS.shared];

      const folders = mapped.filter(mine).map((fid) => folderKeyById(fid) || fid);
      if (scope === "client") for (const fid of seededFolderIds) folders.push(fid);
      next.pipelines[id] = { scope, folders };
    }
  };
  add(pipelineIds(), "client");
  add(caregiverPipelineIds(), "caregiver");
  next.seeded = true;
  return savePipelineConfig(next);
}

export async function configuredIds(scope: StoredScope): Promise<string[]> {
  return idsInScope(await getPipelineConfig(), scope);
}

export async function upsertContact(fields: {
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
  phone?: string;
  source?: string;

  assignedTo?: string;

  companyName?: string;
  customFields?: { id: string; value: unknown }[];
}): Promise<{ id: string; isNew: boolean }> {
  const { locationId } = requireEnv();
  const body: Record<string, unknown> = { locationId };
  for (const k of [
    "firstName",
    "lastName",
    "name",
    "email",
    "phone",
    "source",
    "assignedTo",
    "companyName",
  ] as const)
    if (fields[k]) body[k] = fields[k];
  if (fields.customFields?.length) body.customFields = fields.customFields;
  const res = await ghlSend<{ contact?: { id?: string }; new?: boolean }>(
    "POST",
    "/contacts/upsert",
    body,
  );
  return { id: res.contact?.id || "", isNew: res.new !== false };
}

const CREATE_NEEDS_A_NAME = 422;

export async function createContact(fields: {

  name?: string;
  firstName?: string;
  lastName?: string;

  companyName?: string;
  email?: string;
  phone?: string;
  source?: string;
  assignedTo?: string;
  customFields?: { id: string; value: unknown }[];
}): Promise<{ id: string }> {
  const { locationId } = requireEnv();
  const first = (fields.firstName || fields.name || "").trim();
  const body: Record<string, unknown> = { locationId };
  if (first) body.firstName = first;
  for (const k of ["lastName", "email", "phone", "source", "assignedTo", "companyName"] as const)
    if (fields[k]) body[k] = fields[k];
  if (fields.customFields?.length) body.customFields = fields.customFields;

  if (!first && !fields.lastName && !fields.email && !fields.phone)
    throw new GhlError(
      "A contact needs a name, a phone number or an email address.",
      400,
      "GoHighLevel refuses a contact with none of firstName, lastName, phone or email. Nothing was sent.",
      { code: "CONTACT_NEEDS_IDENTITY" },
    );

  try {
    const res = await ghlSend<{ contact?: { id?: string }; id?: string }>(
      "POST",
      "/contacts/",
      body,
    );
    return { id: String(res.contact?.id || res.id || "") };
  } catch (e) {

    if (e instanceof GhlError && e.status === CREATE_NEEDS_A_NAME)
      throw new GhlError(
        "GoHighLevel would not create that contact.",
        422,
        `It needs at least one of a first name, last name, phone number or email address. GoHighLevel said: "${e.detail || ""}". Nothing was created.`,
        { code: "CONTACT_NEEDS_IDENTITY" },
      );
    throw e;
  }
}

export interface EnsureContactResult {
  id: string;

  how: "upserted" | "reused" | "created";
}

export async function ensureContact(fields: {
  name: string;
  firstName?: string;
  lastName?: string;

  companyName?: string;
  email?: string;
  phone?: string;
  source?: string;
  assignedTo?: string;
  customFields?: { id: string; value: unknown }[];

  nameIdentifies: boolean;

  excludeIds?: readonly string[];
}): Promise<EnsureContactResult> {
  const { excludeIds, nameIdentifies, ...rest } = fields;

  if (fields.email || fields.phone) {
    const up = await upsertContact(rest);
    return { id: up.id, how: "upserted" };
  }

  const want = (fields.name || "").trim();
  if (nameIdentifies && want) {
    const exclude = new Set(excludeIds || []);
    const hits = await searchContacts(want).catch(() => []);
    const match = hits.find(
      (c) => normName(c.name) === normName(want) && !exclude.has(c.id),
    );
    if (match) return { id: match.id, how: "reused" };
  }

  const made = await createContact(rest);
  return { id: made.id, how: "created" };
}

const normName = (s: string): string =>
  (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

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

  if (current.some((o) => o.trim().toLowerCase() === value.toLowerCase()))
    return current;

  const options = [...current, value];
  const path = `/locations/${encodeURIComponent(locationId)}/customFields/${encodeURIComponent(fieldId)}`;
  try {
    await ghlSend("PUT", path, { name: def.name, options });
  } catch (e) {

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

  cache.fieldDefs = undefined;
  return options;
}

export interface ContactHit {
  id: string;
  name: string;
  email: string;
  phone: string;

  fields: Record<string, string>;
  fieldsKnown: boolean;
}

export async function searchContacts(query: string): Promise<ContactHit[]> {
  const { locationId } = requireEnv();
  if (!query.trim()) return [];
  const data = await ghlSend<{ contacts?: RawContact[] }>(
    "POST",
    "/contacts/search",
    { locationId, page: 1, pageLimit: 10, query: query.trim() },
  );
  return (data.contacts || []).map((c) => {
    const cf = contactCfMap(c);
    return {
      id: String(c.id ?? c.contactId ?? ""),
      name: contactDisplay(c),
      email: String(c.email ?? ""),
      phone: String(c.phone ?? ""),
      fields: cf || {},

      fieldsKnown: cf != null && Object.keys(cf).length > 0,
    };
  });
}

export interface ContactByField {
  id: string;
  name: string;

  company?: string;
  email: string;
  phone: string;
  assignedTo: string;

  fields: Record<string, string>;

  version: string;
}

export interface ContactSearchResult {
  rows: ContactByField[];

  total: number;

  truncated: boolean;

  hydrated: number;

  unreadable: number;
}

const CF_PAGE = 100;
const CF_MAX_PAGES = 10;

const CF_HYDRATE_CAP = 150;

const CF_CHUNK = 12;
const CF_CONCURRENCY = 4;
const CF_PAUSE_MS = 1500;

function contactCfMap(c: RawContact): Record<string, string> | null {
  const raw = (c as Record<string, unknown>).customFields;
  if (!Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const f of raw as Record<string, unknown>[]) {
    const id = String(f.id ?? f.customFieldId ?? "");
    if (!id) continue;

    const v = f.value ?? f.field_value ?? f.fieldValue ?? f.selectedOptions ?? "";
    out[id] = Array.isArray(v) ? v.map(String).join(", ") : String(v ?? "");
  }
  return out;
}

function cfHasValue(stored: string | undefined, want: string): boolean {
  const s = (stored ?? "").trim().toLowerCase();
  const w = want.trim().toLowerCase();
  if (!s) return false;
  if (s === w) return true;
  return s.split(",").some((part) => part.trim() === w);
}

export async function ghlSearchContacts(
  fieldId: string,
  value: string,
): Promise<ContactSearchResult> {
  const { locationId } = requireEnv();
  if (!fieldId || !value)
    throw new GhlError(
      "Cannot list contacts without both a field and a value to match.",
      400,
      `Asked for field "${fieldId}" = "${value}". A missing field id means the custom field does not exist on this account under the expected name.`,
    );

  const filters = [
    { field: `customFields.${fieldId}`, operator: "eq", value },
  ];
  const sent: Record<string, unknown> = {
    locationId,
    pageLimit: CF_PAGE,
    filters,

    sort: [{ field: "dateAdded", direction: "desc" }],
  };

  const raw: RawContact[] = [];
  let total = -1;
  let truncated = false;
  let searchAfter: unknown[] | undefined;

  for (let page = 0; page < CF_MAX_PAGES; page++) {
    let data: { contacts?: RawContact[]; total?: number };
    try {
      data = await ghlSend<{ contacts?: RawContact[]; total?: number }>(
        "POST",
        "/contacts/search",
        searchAfter ? { ...sent, searchAfter } : sent,
      );
    } catch (e) {
      if (e instanceof GhlError)
        throw new GhlError(
          "GoHighLevel refused the contact search used to list referral partners.",
          e.status,
          `${e.detail || e.message} — the request sent was ${JSON.stringify(sent)}. This filter shape is the one call in the referral dashboard that could not be tested against a live account before shipping; it is the only place that needs changing (lib/ghl.ts, ghlSearchContacts).`,
          { traceId: e.traceId, code: e.code },
        );
      throw e;
    }
    const batch = data.contacts || [];
    if (typeof data.total === "number") total = data.total;
    raw.push(...batch);
    if (batch.length < CF_PAGE) break;
    const last = batch[batch.length - 1] as Record<string, unknown>;
    const after = last.searchAfter;
    if (!Array.isArray(after) || !after.length) {

      truncated = total < 0 || total > raw.length;
      break;
    }
    searchAfter = after;
    if (page === CF_MAX_PAGES - 1) truncated = true;
  }

  if (!raw.length)
    return { rows: [], total: total < 0 ? 0 : total, truncated, hydrated: 0, unreadable: 0 };

  const mapped = raw.map((c) => {
    const cf = contactCfMap(c);
    const rec = c as Record<string, unknown>;
    return {
      carried: cf != null && Object.keys(cf).length > 0,
      row: {
        id: String(c.id ?? c.contactId ?? ""),
        name: contactDisplay(c),
        company: String(rec.companyName ?? "").trim(),
        email: String(c.email ?? ""),
        phone: String(rec.phone ?? ""),
        assignedTo: String(rec.assignedTo ?? rec.assignedUserId ?? ""),
        fields: cf || {},
        version: String(rec.dateUpdated ?? rec.updatedAt ?? ""),
      } as ContactByField,
    };
  });

  let rows = mapped.map((m) => m.row);
  let hydrated = 0;
  let unreadable = 0;

  if (!mapped.some((m) => m.carried)) {

    const targets = rows.slice(0, CF_HYDRATE_CAP);
    if (rows.length > CF_HYDRATE_CAP) truncated = true;

    const got: Settled<ContactFieldsRead>[] = [];
    for (let i = 0; i < targets.length; i += CF_CHUNK) {
      const slice = targets.slice(i, i + CF_CHUNK);
      got.push(
        ...(await mapLimit(slice, CF_CONCURRENCY, (r) => getContactCustomFields(r.id))),
      );
      if (i + CF_CHUNK < targets.length)
        await new Promise((r) => setTimeout(r, CF_PAUSE_MS));
    }
    hydrated = targets.length;
    const out: ContactByField[] = [];
    for (let i = 0; i < targets.length; i++) {
      const s = got[i];
      if (!s || !s.ok) {
        unreadable++;
        continue;
      }
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.value.values))
        fields[k] = Array.isArray(v) ? v.map(String).join(", ") : String(v ?? "");

      out.push({ ...targets[i], fields, version: s.value.version || targets[i].version });
    }
    rows = out;
  }

  const kept = rows.filter((r) => cfHasValue(r.fields[fieldId], value));
  if (!kept.length && rows.length) {
    const seen = Object.keys(rows[0].fields).slice(0, 12).join(", ") || "(none)";
    throw new GhlError(
      "GoHighLevel's contact search did not apply the filter, so the referral partners could not be listed.",
      502,
      `Asked for ${JSON.stringify(filters)} and got ${rows.length} contact${rows.length === 1 ? "" : "s"} back, not one of which carries that value — which means the reply is every contact in the account rather than the partners. Nothing is shown, because showing it would have looked like a real partner list. The field ids that did come back on the first row were: ${seen}. Fix the filter shape in lib/ghl.ts → ghlSearchContacts; it is the only place it is written.`,
    );
  }

  return { rows: kept, total: total < 0 ? kept.length : total, truncated, hydrated, unreadable };
}

export interface FieldSetSearch {
  rows: ContactByField[];

  via: "exists" | "empty" | "unsupported";
  truncated: boolean;
}

let existsOperatorWorks: boolean | null = null;

export function resetExistsProbe(): void {
  existsOperatorWorks = null;
}

export async function ghlSearchContactsWhereSet(
  fieldId: string,
): Promise<FieldSetSearch> {
  if (!fieldId || existsOperatorWorks === false)
    return { rows: [], via: "unsupported", truncated: false };

  const { locationId } = requireEnv();
  const sent: Record<string, unknown> = {
    locationId,
    pageLimit: CF_PAGE,
    filters: [{ field: `customFields.${fieldId}`, operator: "exists" }],
    sort: [{ field: "dateAdded", direction: "desc" }],
  };

  const raw: RawContact[] = [];
  let truncated = false;
  let searchAfter: unknown[] | undefined;
  for (let page = 0; page < CF_MAX_PAGES; page++) {
    let data: { contacts?: RawContact[] };
    try {
      data = await ghlSend<{ contacts?: RawContact[] }>(
        "POST",
        "/contacts/search",
        searchAfter ? { ...sent, searchAfter } : sent,
      );
    } catch (e) {

      const status = e instanceof GhlError ? e.status : 0;
      if (status >= 400 && status < 500) existsOperatorWorks = false;
      return { rows: [], via: "unsupported", truncated: false };
    }
    const batch = data.contacts || [];
    raw.push(...batch);
    if (batch.length < CF_PAGE) break;
    const last = batch[batch.length - 1] as Record<string, unknown>;
    const after = last.searchAfter;
    if (!Array.isArray(after) || !after.length) {
      truncated = true;
      break;
    }
    searchAfter = after;
    if (page === CF_MAX_PAGES - 1) truncated = true;
  }

  const rows: ContactByField[] = raw.map((c) => {
    const rec = c as Record<string, unknown>;
    return {
      id: String(c.id ?? c.contactId ?? ""),
      name: contactDisplay(c),
      email: String(c.email ?? ""),
      phone: String(rec.phone ?? ""),
      assignedTo: String(rec.assignedTo ?? rec.assignedUserId ?? ""),
      fields: contactCfMap(c) || {},
      version: String(rec.dateUpdated ?? rec.updatedAt ?? ""),
    };
  });

  if (!rows.length) return { rows: [], via: "empty", truncated: false };
  const applied = rows.every((r) => String(r.fields[fieldId] ?? "").trim() !== "");
  if (!applied) {
    existsOperatorWorks = false;
    return { rows: [], via: "unsupported", truncated: false };
  }
  existsOperatorWorks = true;
  return { rows, via: "exists", truncated };
}

export async function ghlSearchContactsAnyOf(
  fieldId: string,
  values: readonly string[],
): Promise<{ rows: ContactByField[]; truncated: boolean; asked: number }> {
  const want = [...new Set(values.map((v) => (v || "").trim()).filter(Boolean))];
  if (!fieldId || !want.length) return { rows: [], truncated: false, asked: 0 };
  const targets = want.slice(0, EVENT_FANOUT_CAP);
  const truncated = want.length > targets.length;

  const byId = new Map<string, ContactByField>();
  for (let i = 0; i < targets.length; i += CF_CHUNK) {
    const slice = targets.slice(i, i + CF_CHUNK);
    const got = await mapLimit(slice, CF_CONCURRENCY, (v) =>
      ghlSearchContacts(fieldId, v),
    );
    for (const s of got) {

      if (!s.ok) continue;
      for (const r of s.value.rows) byId.set(r.id, r);
    }
    if (i + CF_CHUNK < targets.length)
      await new Promise((r) => setTimeout(r, CF_PAUSE_MS));
  }
  return { rows: [...byId.values()], truncated, asked: targets.length };
}

const EVENT_FANOUT_CAP = 40;

export interface ContactMatch {
  id: string;
  name: string;
  email: string;
  phone: string;

  matchedOn: "email" | "phone";
}

export async function findContactByEmailOrPhone(args: {
  email?: string;
  phone?: string;
}): Promise<ContactMatch | null> {
  const { locationId } = requireEnv();
  const wantEmail = emailKey(args.email);
  const wantPhone = phoneKey(args.phone);

  const queries: { q: string; on: "email" | "phone" }[] = [];
  if (wantEmail) queries.push({ q: wantEmail, on: "email" });
  if (wantPhone) queries.push({ q: wantPhone, on: "phone" });
  if (!queries.length) return null;

  for (const { q, on } of queries) {
    let rows: RawContact[] = [];
    try {
      const data = await ghlSend<{ contacts?: RawContact[] }>(
        "POST",
        "/contacts/search",
        { locationId, page: 1, pageLimit: 20, query: q },
      );
      rows = data.contacts || [];
    } catch {

      throw new GhlError(
        "Could not check for an existing contact.",
        502,
        `Lookup failed for ${on}.`,
      );
    }
    for (const c of rows) {
      const id = String(c.id ?? c.contactId ?? "");
      if (!id) continue;
      const email = String(c.email ?? "");
      const phone = String(c.phone ?? "");
      const hit =
        (on === "email" && wantEmail && emailKey(email) === wantEmail) ||
        (on === "phone" && wantPhone && phoneKey(phone) === wantPhone);
      if (hit)
        return { id, name: contactDisplay(c), email, phone, matchedOn: on };
    }
  }
  return null;
}

export async function lookupDuplicateContact(args: {
  phone?: string;
  email?: string;
}): Promise<{ id: string; name: string } | null> {
  const { locationId } = requireEnv();

  const phone = e164(args.phone || "").value || (args.phone || "").trim();
  const email = (args.email || "").trim();
  if (!phone && !email) return null;
  const params = new URLSearchParams({ locationId });
  if (phone) params.set("number", phone);
  if (email) params.set("email", email);
  try {
    const data = await ghlGet<{ contact?: { id?: string; [k: string]: unknown } }>(
      `/contacts/search/duplicate?${params.toString()}`,
    );
    const c = data.contact;
    const id = String(c?.id ?? "");
    if (!id) return null;
    return { id, name: contactDisplay(c as RawContact) };
  } catch {

    return null;
  }
}

export async function createOpportunity(o: {
  pipelineId: string;
  stageId: string;
  contactId: string;
  name: string;
  source?: string;
  status?: string;
  assignedTo?: string;

  monetaryValue?: number;
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
  if (typeof o.monetaryValue === "number" && Number.isFinite(o.monetaryValue))
    body.monetaryValue = o.monetaryValue;
  if (o.source) body.source = o.source;
  if (o.customFields?.length) body.customFields = o.customFields;
  const res = await ghlSend<{ opportunity?: { id?: string }; id?: string }>(
    "POST",
    "/opportunities/",
    body,
  );
  return res.opportunity?.id || res.id || "";
}

export interface MoveResult {
  transferred: boolean;
  steps: string[];
  failedStep?: string;
  error?: string;
  stranded?: boolean;
  attemptedFollowerRemovals?: string[];

  addedFollowers?: string[];
}

export const REASSIGN_STAGE_NAME = "REASSIGN";

export async function stampSortedFromNewLeads(
  oppId: string,
  kind: SortedKind,
  pipelineId: string,
  actorUserId: string,
): Promise<"stamped" | "no field" | "failed"> {
  try {
    const def = findDefByName(await getFieldDefinitions(), SORTED_FIELD);
    if (!def) {
      // eslint-disable-next-line no-console
      console.warn(
        `[sort] no "${SORTED_FIELD}" field on this account — the New Leads stats can't count this sort. Create it in GoHighLevel (TEXT, opportunity).`,
      );
      return "no field";
    }
    await putOpportunityVerified(
      oppId,
      {
        customFields: [
          { id: def.id, value: encodeSorted({ at: new Date().toISOString(), kind, pipelineId, userId: actorUserId }) },
        ],
      },
      "sorted-stamp",
    );
    invalidateOpportunity(oppId);
    return "stamped";
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[sort] stats stamp failed:", await explainGhlError(e));
    return "failed";
  }
}

export const REASSIGN_FOLLOWERS_FIELD = "Reassign Followers";

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

    const same = a === b || (a && b && a.slice(0, 10) === b.slice(0, 10));
    if (!same) {
      // eslint-disable-next-line no-console
      console.warn(
        `[move:${label}] ⚠ "${label2}" (${s.id}) sent ${JSON.stringify(b)} but GoHighLevel stored ${JSON.stringify(a)}.`,
      );
    }
  }
}

function matchOption(options: string[], value: string): string | null {
  const v = normOpt(value);
  for (const o of options) if (normOpt(o) === v) return o;
  return null;
}

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

export async function sortOpportunity(args: {
  mode: "sort" | "assign";
  oppId: string;
  toPipelineId: string;

  toStageId?: string;

  newOwnerId?: string;
  reason?: string;
  actorUserId: string;
  actorDivision?: string;
}): Promise<MoveResult> {
  const steps: string[] = [];
  const current = await getOpportunityById(args.oppId);
  if (!current) throw new GhlError("Opportunity not found.", 404, `id ${args.oppId}`);
  const fromStage = (current.stage || "").trim().toUpperCase();
  if (args.mode === "sort" && fromStage !== "NEW LEAD")
    throw new GhlError(
      "This case is no longer a new lead.",
      409,
      `It is at ${current.stage || "another stage"} now — somebody may have sorted it already. Refresh to see where it is.`,
    );
  if (args.mode === "assign" && fromStage !== REASSIGN_STAGE_NAME)
    throw new GhlError(
      "This case is no longer waiting in Staffing needed.",
      409,
      `It is at ${current.stage || "another stage"} now — somebody may have assigned it already. Refresh to see where it is.`,
    );
  if (args.mode === "assign" && current.ownerId)
    throw new GhlError("This case already has an owner.", 409, "Somebody assigned it a moment ago. Refresh.");

  const pipelines = await getSelectedPipelines();
  const dest = pipelines.find((p) => p.id === args.toPipelineId);
  if (!dest)
    throw new GhlError("Destination pipeline is not available.", 400, `${args.toPipelineId} is not a client pipeline.`);
  const pipelineChanged = args.toPipelineId !== current.pipelineId;
  if (args.mode === "assign" && pipelineChanged)
    throw new GhlError(
      "Assign keeps the case in its pipeline.",
      400,
      "Use Move this case to send it to another pipeline.",
    );

  const finalOwner = args.newOwnerId === undefined ? current.ownerId || "" : args.newOwnerId;
  const ownerChanged = finalOwner !== (current.ownerId || "");
  if (args.mode === "assign" && !finalOwner)
    throw new GhlError("Pick who will own it.", 400);

  const stages = dest.stages || [];
  let destStageId = args.toStageId || "";
  const chosen = destStageId ? stages.find((st) => st.id === destStageId) : undefined;
  if (destStageId && !chosen)
    throw new GhlError("Chosen stage does not belong to the destination pipeline.", 400, destStageId);
  const chosenName = (chosen?.name || "").trim().toUpperCase();
  if (!destStageId) {
    if (args.mode === "sort" && !finalOwner && pipelineChanged) {
      const nl = stages.find((st) => (st.name || "").trim().toUpperCase() === "NEW LEAD");
      if (!nl)
        throw new GhlError(
          `"${dest.name}" has no NEW LEAD stage.`,
          400,
          "Add a NEW LEAD stage to that pipeline, or give the lead an owner and a stage.",
        );
      destStageId = nl.id;
    } else {
      throw new GhlError("Choose a stage.", 400);
    }
  } else if (chosenName === "NEW LEAD") {
    if (finalOwner || !pipelineChanged || args.mode === "assign")
      throw new GhlError("Choose a stage other than New lead.", 400);
  } else if (chosenName === REASSIGN_STAGE_NAME) {
    throw new GhlError("Use Staffing needed for that.", 400);
  }

  if (ownerChanged && finalOwner) {
    const validUsers = await getLocationUserIds();
    if (validUsers.size && !validUsers.has(finalOwner))
      throw new GhlError("New owner is not a user of this location.", 400, finalOwner);
  }
  steps.push("preflight");

  const divisionCf = pipelineChanged ? await divisionCustomField(dest.name) : [];
  await putOpportunityVerified(
    args.oppId,
    {
      pipelineId: args.toPipelineId,
      pipelineStageId: destStageId,
      ...(ownerChanged ? { assignedTo: finalOwner || null } : {}),
      ...(divisionCf.length ? { customFields: divisionCf } : {}),
    },
    args.mode,
  );
  steps.push(
    `${args.mode === "sort" ? "sorted" : "assigned"}: pipeline+stage${ownerChanged ? " + owner" : ""}${divisionCf.length ? " + Division" : ""}`,
  );
  invalidateOpportunity(args.oppId);

  if (args.mode === "sort" && (stages.find((st) => st.id === destStageId)?.name || "").trim().toUpperCase() !== "NEW LEAD")
    steps.push(`stats: ${await stampSortedFromNewLeads(args.oppId, "pipeline", args.toPipelineId, args.actorUserId)}`);

  if (args.mode === "assign") {
    try {
      const added = await getReassignFollowers(current);
      const toRemove = added.filter((u) => u && u !== finalOwner);
      if (toRemove.length) await removeOpportunityFollowers(args.oppId, toRemove);
      if (added.length) await clearReassignFollowers(args.oppId);
      steps.push(`followers cleared: ${toRemove.length}`);
    } catch (e) {

      console.error("[assign] follower cleanup failed:", e);
      steps.push("followers: cleanup failed (remove by hand)");
    }
  }

  if (current.contactId) {
    try {
      const from = pipelines.find((p) => p.id === current.pipelineId)?.name || "—";
      const stageName = stages.find((st) => st.id === destStageId)?.name || "";
      const system =
        args.mode === "sort"
          ? pipelineChanged
            ? `Sorted from New leads: ${from} → ${dest.name}${stageName ? ` (${stageName})` : ""}.`
            : `Sorted from New leads in ${dest.name}${stageName ? ` → ${stageName}` : ""}.`
          : `Assigned from Staffing needed in ${dest.name}${stageName ? ` → ${stageName}` : ""}.`;
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
      console.error("[sort] note failed:", await explainGhlError(e));
    }
  }
  return { transferred: false, steps };
}

export async function moveOpportunity(args: {
  oppId: string;
  toPipelineId: string;
  toStageId?: string;
  newOwnerId?: string | null;
  reason?: string;
  actorUserId: string;
  actorDivision?: string;
  addSenderAsFollower?: boolean;

  masterUsers?: string[];
}): Promise<MoveResult> {
  const steps: string[] = [];
  const addedFollowers: string[] = [];
  const current = await getOpportunityById(args.oppId);
  if (!current)
    throw new GhlError("Opportunity not found.", 404, `id ${args.oppId}`);

  const ownerChanged =
    typeof args.newOwnerId === "string" &&
    (args.newOwnerId || "") !== (current.ownerId || "");

  const unassigning =
    typeof args.newOwnerId === "string" && args.newOwnerId === "";

  const isTransfer = ownerChanged || unassigning;

  if (!args.actorDivision?.trim()) {
    // eslint-disable-next-line no-console
    console.warn(
      `[move] actorDivision is EMPTY for user "${args.actorUserId || "(none)"}" — the note will be written with NO [DIVISION] prefix. See the [move:division] line above for the reason.`,
    );
  }

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

    const ti = (dest.stages || []).find(
      (s) => (s.name || "").trim().toUpperCase() === "TRANSFERRED IN",
    );

    if (unassigning) {

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

    if (!unassigning) {
      const validUsers = await getLocationUserIds();

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

  const pipelineChanged = args.toPipelineId !== current.pipelineId;
  const divisionCf = pipelineChanged
    ? await divisionCustomField(dest.name)
    : [];

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

    if (current.contactId && (pipelineChanged || args.reason?.trim())) {
      try {

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

        // eslint-disable-next-line no-console
        console.error("[move] note failed on simple move:", await explainGhlError(e));
      }
    }
    return { transferred: false, steps };
  }

  const defs = await getFieldDefinitions();
  const fromDef = findDefByName(defs, "Transferred From");
  const dateDef = findDefByName(defs, "Transferred Date");
  const reasonDef = findDefByName(defs, "Transfer Reason");
  const sourceName =
    pipelines.find((p) => p.id === current.pipelineId)?.name || "";

  if (!fromDef || !dateDef) {
    // eslint-disable-next-line no-console
    console.warn(
      `[move] transfer stamp fields resolved: Transferred From=${fromDef?.id ?? "NOT FOUND"} Transferred Date=${dateDef?.id ?? "NOT FOUND"} (from ${defs.length} opportunity custom-field definitions). A NOT FOUND is never sent.`,
    );
  }

  const customFields: { id: string; value: unknown }[] = [];
  if (fromDef && sourceName) {

    const opts = optionStrings(fromDef);
    const matched = opts.length ? matchOption(opts, sourceName) : sourceName;
    if (matched) customFields.push({ id: fromDef.id, value: matched });
  }
  if (dateDef)
    customFields.push({
      id: dateDef.id,

      value: toGhlDate(new Date().toISOString()),
    });
  if (reasonDef && args.reason?.trim())
    customFields.push({ id: reasonDef.id, value: args.reason.trim() });

  try {
    await putOpportunityVerified(
      args.oppId,
      {

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

      error: await explainGhlError(e),
    };
  }

  const toRemove = current.followerIds.filter((f) => f !== args.newOwnerId);
  try {
    if (toRemove.length) {
      await removeOpportunityFollowers(args.oppId, toRemove);
      steps.push(`cleared ${toRemove.length} follower(s)`);
    }

    const keepSender = args.addSenderAsFollower === true && !!current.ownerId;

    const wanted = new Set<string>();
    if (keepSender) wanted.add(current.ownerId!);
    if (unassigning)
      for (const u of args.masterUsers || []) if (u) wanted.add(u);

    const removed = new Set(toRemove);
    const already = new Set(
      current.followerIds.filter((f) => !removed.has(f)),
    );
    const added = [...wanted].filter((u) => !already.has(u));
    if (added.length) {
      await addOpportunityFollowers(args.oppId, added);
      addedFollowers.push(...added);
      steps.push(
        unassigning
          ? `added ${added.length} follower(s) BEFORE the stage change (sender + master-view holders) so the GHL workflow notifies a real list`
          : "kept sender as follower",
      );

      if (unassigning) {
        try {
          const stored = await setReassignFollowers(args.oppId, added);
          steps.push(
            stored
              ? `recorded ${added.length} added follower(s) for the claim to undo`
              : `could NOT record the added followers (no "${REASSIGN_FOLLOWERS_FIELD}" field) — a claim will remove none`,
          );
        } catch (e) {

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

      error: await explainGhlError(e),
      attemptedFollowerRemovals: toRemove,
    };
  }

  try {
    if (current.contactId) {

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

      error: await explainGhlError(e),
    };
  }

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await putOpportunityVerified(
        args.oppId,
        {
          pipelineId: args.toPipelineId,
          pipelineStageId: destStageId,

          ...(divisionCf.length ? { customFields: divisionCf } : {}),
        },
        "transfer-pipeline",
      );
      steps.push(
        `moved pipeline+stage (${unassigning ? REASSIGN_STAGE_NAME : "TRANSFERRED IN"})${divisionCf.length ? " + Division" : ""}${attempt > 1 ? ` after ${attempt} attempts` : ""}`,
      );

      if (!unassigning && args.newOwnerId) {
        const cm = await applyCaseManagers(args.oppId, args.newOwnerId);
        if (!cm.skipped && (cm.added.length || cm.removed.length))
          steps.push(`case managers: ${cm.steps.join("; ")}`);
      }

      if (current.contactId) {
        const destLabel = normalizeTag(divisionLabel(dest.name) || dest.name);

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

function echoedFollowers(j: unknown): Set<string> {
  const o = (j ?? {}) as Record<string, unknown>;
  const out = new Set<string>();
  for (const key of ["followers", "followersAdded", "followersRemoved"]) {
    const v = o[key];
    if (!Array.isArray(v)) continue;
    for (const x of v.flat(2)) if (typeof x === "string" && x) out.add(x);
  }
  return out;
}

export async function addOpportunityFollowers(
  oppId: string,
  userIds: string[],
): Promise<string[]> {
  if (!userIds.length) return [];
  const res = await ghlSend<{
    followers?: string[];
    followersAdded?: string[][];
  }>("POST", `/opportunities/${encodeURIComponent(oppId)}/followers`, {
    followers: userIds,
  });
  const echoed = echoedFollowers(res);
  const landed = userIds.filter((u) => echoed.has(u));

  if (!landed.length)
    throw new GhlError(
      "GoHighLevel stored no followers.",
      502,
      `The request was accepted (200) and none of the ${userIds.length} follower(s) were stored. ` +
        `This is what GoHighLevel does when the record's pipeline is shared with selected users ` +
        `only and the people being added are not among them — it does not refuse, it returns success ` +
        `and writes nothing. Open GoHighLevel → Settings → Opportunities → Pipelines → the key icon ` +
        `on this record's pipeline and either share it with these users or with all users.`,
      { code: "FOLLOWERS_NOT_STORED" },
    );
  return landed;
}

export async function removeOpportunityFollowers(
  oppId: string,
  userIds: string[],
): Promise<string[]> {
  if (!userIds.length) return [];

  const j =
    (await ghlDelete<{ followers?: string[]; followersRemoved?: string[][] }>(
      `/opportunities/${encodeURIComponent(oppId)}/followers`,
      { body: { followers: userIds }, what: "the followers" },
    )) ?? {};

  const removedEcho = Array.isArray(j.followersRemoved)
    ? new Set(j.followersRemoved.flat(2).filter((x): x is string => typeof x === "string" && !!x))
    : null;
  if (removedEcho && !userIds.some((u) => removedEcho.has(u)))
    throw new GhlError(
      "GoHighLevel removed no followers.",
      502,
      `The request was accepted (200) and none of the ${userIds.length} follower(s) were removed. ` +
        `As with adding, this is what GoHighLevel does when the record's pipeline is shared with ` +
        `selected users only. Open GoHighLevel → Settings → Opportunities → Pipelines → the key ` +
        `icon on this record's pipeline.`,
      { code: "FOLLOWERS_NOT_REMOVED" },
    );
  return [...echoedFollowers(j)].filter((u) => userIds.includes(u));
}

export const CASE_MANAGER_FIELD = "Case Manager";

export const CASE_MANAGER_FOLLOWERS_FIELD = "Case Manager Followers";

export {
  STAGE_HISTORY_FIELD,
  parseStageHistory,
  encodeStageRow,
  type StageHistoryRow,
} from "@/lib/stageHistory";
import {
  STAGE_HISTORY_FIELD,
  parseStageHistory,
  encodeStageRow,
} from "@/lib/stageHistory";
import { FIRST_OPENED_FIELD, encodeFirstOpened, parseFirstOpened } from "@/lib/newLead";
import { SORTED_FIELD, encodeSorted, type SortedKind } from "@/lib/sorting";

export interface StageRecordResult {
  recorded: boolean;
  why: string;
  row?: string;
  rows?: number;
}

export async function appendStageHistory(oppId: string): Promise<StageRecordResult> {
  const rec = await getOpportunityByIdUncached(oppId);
  if (!rec) return { recorded: false, why: "the record could not be read back" };

  const defs = await getFieldDefinitions();
  const def = findDefByName(defs, STAGE_HISTORY_FIELD);
  if (!def)
    return {
      recorded: false,
      why: `no "${STAGE_HISTORY_FIELD}" custom field on this account — create it (LARGE_TEXT, opportunity)`,
    };

  const to = String(rec.stageId || "");
  if (!to) return { recorded: false, why: "the record has no stage id" };

  const rows = parseStageHistory(rec.cf[def.id]);

  const last = rows[rows.length - 1];
  if (last && last.to === to)
    return { recorded: false, why: `already the last recorded stage (${to})`, rows: rows.length };

  const managers = getCaseManagers(rec.ownerId || "") ?? [];
  const row = encodeStageRow(new Date().toISOString(), to, rec.ownerId || "", managers);
  const next = [...rows.map((r) => encodeStageRow(r.at, r.to, r.ownerId, r.managerIds)), row].join("\n");

  await putOpportunityVerified(oppId, { customFields: [{ id: def.id, value: next }] }, "stage-history");
  return { recorded: true, why: `${rows.length ? "appended" : "first row"} for ${oppId}`, row, rows: rows.length + 1 };
}

export const FIRST_OPENED_RECHECK_MS = 60_000;
let firstOpenedLastRecheck = 0;
export async function firstOpenedFieldId(): Promise<string | null> {
  let def = findDefByName(await getFieldDefinitions(), FIRST_OPENED_FIELD);
  if (!def && Date.now() - firstOpenedLastRecheck >= FIRST_OPENED_RECHECK_MS) {
    firstOpenedLastRecheck = Date.now();

    cache.fieldDefs = undefined;
    def = findDefByName(await getFieldDefinitions(), FIRST_OPENED_FIELD);
  }
  return def?.id ? String(def.id) : null;
}

export function resetFirstOpenedRecheck(): void {
  firstOpenedLastRecheck = 0;
}

export interface FirstOpenedResult {
  recorded: boolean;

  value: string | null;
  why: string;
}

export async function markFirstOpened(oppId: string, userId: string): Promise<FirstOpenedResult> {
  const fieldId = await firstOpenedFieldId();
  if (!fieldId)
    return { recorded: false, value: null, why: `no "${FIRST_OPENED_FIELD}" opportunity field on this account` };
  invalidateOpportunity(oppId);
  const rec = await getOpportunityByIdUncached(oppId);
  if (!rec) return { recorded: false, value: null, why: "the record could not be read" };
  const existing = parseFirstOpened(rec.cf[fieldId]);
  if (existing)
    return { recorded: false, value: encodeFirstOpened(existing.at, existing.userId), why: "already opened" };
  const value = encodeFirstOpened(new Date().toISOString(), userId);
  await putOpportunityVerified(oppId, { customFields: [{ id: fieldId, value }] }, "first-opened");
  invalidateOpportunity(oppId);
  return { recorded: true, value, why: "first open recorded" };
}

export interface CaseManagerResult {

  skipped: boolean;
  why: string;
  added: string[];
  removed: string[];

  fieldValue: string | null;

  noRecordField: boolean;

  mismatch: { missing: string[]; lingering: string[] } | null;
  steps: string[];
}

function readOwnRecord(
  rec: { cf: Record<string, unknown> },
  def: FieldDefinition | undefined,
): string[] {
  if (!def) return [];
  const raw = rec.cf[def.id];
  const text = Array.isArray(raw) ? raw.join(",") : String(raw ?? "");
  return text.split(",").map((x) => x.trim()).filter(Boolean);
}

export async function setOpportunityOwner(
  oppId: string,
  userId: string,
): Promise<void> {
  if (!oppId) throw new GhlError("No opportunity id to set an owner on.", 400);
  await ghlSend("PUT", `/opportunities/${encodeURIComponent(oppId)}`, {

    assignedTo: userId || null,
  });
  invalidateOpportunity(oppId);
}

export async function applyCaseManagers(
  oppId: string,
  ownerId: string,

  known?: OpportunityRecord | null,
): Promise<CaseManagerResult> {
  const steps: string[] = [];
  const out = (r: Partial<CaseManagerResult>): CaseManagerResult => ({
    skipped: false, why: "", added: [], removed: [], fieldValue: null,
    noRecordField: false, mismatch: null, steps, ...r,
  });

  try {

    const rec = known ?? (await getOpportunityByIdUncached(oppId));
    if (!rec) return out({ skipped: true, why: "the record could not be read back" });

    let onClientPipeline = false;
    try {
      const clientPipes = await getSelectedPipelines("client");
      onClientPipeline = clientPipes.some((p) => p.id === rec.pipelineId);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        `[casemgr] ${oppId}: could not establish whether ${rec.pipelineId} is client-scoped — treating it as NOT, so nothing is added. Case managers will not be applied here until the pipeline config reads.`,
        e instanceof Error ? e.message : String(e),
      );
    }
    const mapped = onClientPipeline ? getCaseManagers(ownerId) : null;
    const want = mapped ?? [];

    const defs = await getFieldDefinitions();
    const recordDef = findDefByName(defs, CASE_MANAGER_FOLLOWERS_FIELD);
    const nameDef = findDefByName(defs, CASE_MANAGER_FIELD);
    const noRecordField = !recordDef;
    if (noRecordField)
      // eslint-disable-next-line no-console
      console.error(
        `[casemgr] no "${CASE_MANAGER_FOLLOWERS_FIELD}" custom field on this account — the follower list cannot be recorded, so this apply will ADD but REMOVE NOTHING rather than guess. Create the field (TEXT, opportunity).`,
      );

    const mine = readOwnRecord(rec, recordDef);
    const current = new Set(rec.followerIds);

    if (mapped === null && mine.length === 0)
      return out({
        skipped: true,

        why: !ownerId
          ? "the record has no owner"
          : !onClientPipeline
            ? "this pipeline is not client-scoped, so case managers do not apply to it"

            : `${rec.rep || "that owner"} (${ownerId}) has no entry in the case-manager map, so this function added nothing to this record`,
        noRecordField,
      });

    const added = want.filter((u) => u && u !== rec.ownerId && !current.has(u));

    const removed = noRecordField
      ? []
      : mine.filter((u) => u && !want.includes(u) && current.has(u));

    if (removed.length) {
      await removeOpportunityFollowers(oppId, removed);
      steps.push(`removed ${removed.length} follower(s) this function had added`);
    }
    if (added.length) {
      await addOpportunityFollowers(oppId, added);
      steps.push(`added ${added.length} manager(s) as follower(s)`);
    }
    if (noRecordField && mine.length === 0 && !removed.length)
      steps.push(`⚠️ no "${CASE_MANAGER_FOLLOWERS_FIELD}" field — nothing was removed`);

    let fieldValue: string | null = null;
    if (nameDef) {
      const users = await getUserMap();
      fieldValue = want.map((u) => users.get(u) || "").filter(Boolean).join(", ");
      await putOpportunityVerified(
        oppId,
        { customFields: [{ id: nameDef.id, value: fieldValue }] },
        "casemgr-name",
      );
      steps.push(fieldValue ? `Case Manager = "${fieldValue}"` : "Case Manager cleared");
    } else {
      steps.push(`⚠️ no "${CASE_MANAGER_FIELD}" field on this account — the name was not written`);
    }

    let missing: string[] = [];
    let lingering: string[] = [];
    let verified: Set<string> | null = null;
    if (added.length || removed.length) {
      invalidateOpportunity(oppId);
      const after = await getOpportunityByIdUncached(oppId);
      verified = new Set(after?.followerIds ?? []);
      missing = want.filter((u) => u !== rec.ownerId && !verified!.has(u));
      lingering = removed.filter((u) => verified!.has(u));
      if (missing.length || lingering.length) {
        steps.push(
          `🔴 read-back MISMATCH — ${missing.length} manager(s) are still not following${
            lingering.length ? `, ${lingering.length} removal(s) did not take` : ""
          }`,
        );
        // eslint-disable-next-line no-console
        console.error(
          `[casemgr] ${oppId}: wrote followers and the read-back disagrees. missing=${missing.join(",")} lingering=${lingering.join(",")}`,
        );
      } else {
        steps.push("read-back confirms the followers");
      }
    }

    const claimed = new Set([
      ...want.filter((u) => added.includes(u) || mine.includes(u)),
      ...lingering,
    ]);

    const nowOurs = [...claimed];
    if (recordDef) {
      await putOpportunityVerified(
        oppId,
        { customFields: [{ id: recordDef.id, value: nowOurs.join(",") }] },
        "casemgr-record",
      );
    }

    return out({
      added,
      removed,
      fieldValue,
      noRecordField,
      mismatch: missing.length || lingering.length ? { missing, lingering } : null,
    });
  } catch (e) {

    const why =
      e instanceof GhlError ? e.detail || e.message : e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error(`[casemgr] ${oppId}: apply failed — the owner change stands.`, e);
    steps.push(`🔴 failed: ${why}`);
    return out({ skipped: true, why: `the apply failed — ${why}` });
  }
}

export async function uploadResource(file: {
  buffer: ArrayBuffer;
  filename: string;
  contentType: string;

  folderId?: string;
}): Promise<{ id: string; url: string; name: string }> {
  const target = (file.folderId || "").trim();
  const { resourcesFolderId } = requireEnv({ resourcesFolder: !target });
  const parentId = target || resourcesFolderId;
  const form = new FormData();
  const blob = new Blob([file.buffer], {
    type: file.contentType || "application/octet-stream",
  });

  form.append("file", blob, file.filename);
  form.append("hosted", "false");
  form.append("name", file.filename);
  form.append("parentId", parentId);

  const url = `${BASE_URL}/medias/upload-file`;

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

export interface CaregiverRelation {
  relationId: string;
  contactId: string;
  name: string;

  role: "caregiver" | "client";
}

export interface AssociationDirection {
  firstIsCaregiver: boolean;
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

export async function listCaregiverRelations(
  contactId: string,
): Promise<CaregiverRelation[]> {
  const { locationId, caregiverAssociationId } = requireEnv({
    caregiverAssociation: true,
  });

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

    const iAmCaregiver = isFirst === dir.firstIsCaregiver;
    return {
      relationId: rid,
      contactId: other,
      role: (iAmCaregiver ? "client" : "caregiver") as "caregiver" | "client",
    };
  });

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

    }
    out.push({ ...c, name });
  }
  return out;
}

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

const CLIENT_CASE_TTL_MS = 60_000;
let clientCaseCache: { at: number; rows: OpportunityRecord[] } | null = null;

export function resetClientCaseCache(): void {
  clientCaseCache = null;
}

export async function getClientCaseRows(): Promise<OpportunityRecord[]> {
  const now = Date.now();
  if (clientCaseCache && now - clientCaseCache.at < CLIENT_CASE_TTL_MS)
    return clientCaseCache.rows;
  const { records } = await getOltlOpportunities("client");
  clientCaseCache = { at: now, rows: records };
  return records;
}

const CAREGIVER_RECORD_TYPE_FIELD = "Record Type";
const CAREGIVER_RECORD_TYPE = "Caregiver";

const CAREGIVER_CASE_TTL_MS = 60_000;
let caregiverCaseCache: { at: number; rows: OpportunityRecord[] } | null = null;
let caregiverLabelCache: { at: number; rows: ContactByField[] } | null = null;

export function resetCaregiverPickerCache(): void {
  caregiverCaseCache = null;
  caregiverLabelCache = null;
  bustFieldCaches();
}

export async function getCaregiverCaseRows(): Promise<OpportunityRecord[]> {
  const now = Date.now();
  if (caregiverCaseCache && now - caregiverCaseCache.at < CAREGIVER_CASE_TTL_MS)
    return caregiverCaseCache.rows;
  const { records } = await getOltlOpportunities("caregiver");
  caregiverCaseCache = { at: now, rows: records };
  return records;
}

async function caregiversByLabel(): Promise<ContactByField[]> {
  const now = Date.now();
  if (caregiverLabelCache && now - caregiverLabelCache.at < CAREGIVER_CASE_TTL_MS)
    return caregiverLabelCache.rows;
  const defs = await getEditableFieldDefs("contact");
  const rt = defs.find((d) => norm(d.name) === norm(CAREGIVER_RECORD_TYPE_FIELD));
  if (!rt) throw new GhlError(
    `This account has no "${CAREGIVER_RECORD_TYPE_FIELD}" contact field.`,
    409,
    "Caregivers can still be found by the applicant case they hold, but nobody can be found by their label until that field exists.",
    { code: "NO_RECORD_TYPE_FIELD" },
  );
  const res = await ghlSearchContacts(rt.id, CAREGIVER_RECORD_TYPE);
  caregiverLabelCache = { at: now, rows: res.rows };
  return res.rows;
}

export interface CaregiverHit {
  id: string;
  name: string;

  pipelineName: string;
  stage: string;

  more: number;
}

export interface CaregiverSearchResult {
  results: CaregiverHit[];

  labelsUnavailable: boolean;
}

export async function searchCaregiverContacts(
  query: string,
): Promise<CaregiverSearchResult> {
  if (!query.trim()) return { results: [], labelsUnavailable: false };

  const cases = await getCaregiverCaseRows();
  let labels: ContactByField[] = [];
  let labelsUnavailable = false;
  try {
    labels = await caregiversByLabel();
  } catch {

    labelsUnavailable = true;
  }

  const holders = indexCaseHolders(
    cases.map((r) => ({
      contactId: r.contactId,
      contactName: r.contactName,
      first: r.first,
      last: r.last,
      pipelineName: r.pipelineName,
      stage: r.stage,
      status: r.status,
      createdAt: r.createdAt,
    })),
  );
  const byId = new Map(holders.map((h) => [h.contactId, h]));

  for (const l of labels)
    if (!byId.has(l.id))
      byId.set(l.id, { contactId: l.id, name: l.name, pipelineName: "", stage: "", more: 0 });

  const hits = matchCaseHolders([...byId.values()], query);
  return {
    results: hits.map((h) => ({
      id: h.contactId,
      name: h.name,
      pipelineName: h.pipelineName,
      stage: h.stage,
      more: h.more,
    })),
    labelsUnavailable,
  };
}

export async function createCaregiverRelation(

  roles: { clientContactId: string; caregiverContactId: string },
): Promise<string> {
  const { clientContactId, caregiverContactId } = roles;
  const { locationId, caregiverAssociationId } = requireEnv({
    caregiverAssociation: true,
  });

  const dir = await getAssociationDirection();
  const body = {
    locationId,
    associationId: caregiverAssociationId,
    firstRecordId: dir.firstIsCaregiver ? caregiverContactId : clientContactId,
    secondRecordId: dir.firstIsCaregiver ? clientContactId : caregiverContactId,
  };
  const res = await ghlSend<{ relation?: RawRelation; id?: string }>(
    "POST",
    "/associations/relations",
    body,
  );
  return String(res.relation?.id ?? res.id ?? "");
}

export { normalizeTag };

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

export async function getLocationTags(): Promise<string[]> {
  const { locationId } = requireEnv();
  const data = await ghlGet<{ tags?: { name?: unknown }[] }>(
    `/locations/${encodeURIComponent(locationId)}/tags`,
  );
  const names = (data.tags ?? [])
    .map((t) => (typeof t?.name === "string" ? t.name : ""))
    .filter(Boolean);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

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

const EMAIL_API_VERSION = (
  process.env.GHL_EMAIL_API_VERSION || "2021-04-15"
).trim();

const EMAIL_FROM = (process.env.GHL_EMAIL_FROM || "").trim();

export interface EmailTemplateLite {
  id: string;
  name: string;
  subject: string;
  body: string;
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

export async function sendEmail(args: {
  contactId: string;
  subject: string;
  html?: string;
  templateId?: string;
  cc?: string[];
}): Promise<string> {
  const body: Record<string, unknown> = {
    type: "Email",
    contactId: args.contactId,
    emailSubject: args.subject,
    subject: args.subject,
  };
  if (args.templateId) body.templateId = args.templateId;
  if (args.html) {
    body.emailBody = args.html;
    body.html = args.html;
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

  await ghlDelete(
    `/associations/relations/${encodeURIComponent(relationId)}?locationId=${encodeURIComponent(locationId)}`,
    { what: "the association", goneOk: /\bnot found\b|\bdoes ?n[o']?t exist\b|\bis deleted\b/i },
  );
}

export interface ContactFieldsRead {
  contactId: string;

  values: Record<string, unknown>;

  version: string;

  firstName: string;
  lastName: string;

  assignedTo: string;

  email: string;
  phone: string;
}

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

      values[id] = f.value ?? f.field_value ?? f.fieldValue ?? f.selectedOptions ?? "";
    }
  }

  const rc = c as Record<string, unknown>;
  let firstName = String(rc.firstName ?? "").trim();
  let lastName = String(rc.lastName ?? "").trim();
  if (!firstName && !lastName) {
    const parts = String(rc.name ?? "").trim().split(/\s+/).filter(Boolean);
    firstName = parts.shift() || "";
    lastName = parts.join(" ");
  }
  return {
    contactId,
    assignedTo: String(rc.assignedTo ?? ""),
    values,
    version: String(rc.dateUpdated ?? rc.updatedAt ?? ""),
    firstName,
    lastName,
    email: String(rc.email ?? "").trim(),
    phone: String(rc.phone ?? "").trim(),
  };
}

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

    return 0;
  }
}

export async function updateContactCustomFields(
  contactId: string,
  entries: { id: string; value: unknown }[],
): Promise<void> {
  if (!entries.length) return;
  await ghlSend(
    "PUT",
    `/contacts/${encodeURIComponent(contactId)}`,

    { customFields: entries.map((e) => ({ id: e.id, value: e.value })) },
  );
}

export async function updateContactNative(
  contactId: string,
  n: { firstName?: string; lastName?: string; email?: string; phone?: string },
): Promise<void> {
  const body: Record<string, unknown> = {};

  if (n.firstName !== undefined || n.lastName !== undefined) {
    const firstName = (n.firstName ?? "").trim();
    const lastName = (n.lastName ?? "").trim();
    if (!firstName && !lastName) throw new GhlError("A person needs a name.", 400);
    body.firstName = firstName;
    body.lastName = lastName;
    body.name = [firstName, lastName].filter(Boolean).join(" ");
  }

  if (n.email !== undefined) body.email = n.email.trim();
  if (n.phone !== undefined) body.phone = n.phone.trim() ? e164(n.phone).value : "";

  if (!Object.keys(body).length) return;
  await ghlSend("PUT", `/contacts/${encodeURIComponent(contactId)}`, body);
}

export interface OppFooter {
  createdAt: string;
  updatedAt: string;

  sourceType: string;
  sourceValue: string;

  sourceUserId: string;

  sourceId: string;
}

export async function getOpportunityWithFooter(
  id: string,
): Promise<{ rec: OpportunityRecord; footer: OppFooter } | null> {
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

  const selected = await getPipelines();
  const stageNameByKey = new Map<string, string>();
  const pipelineNameById = new Map<string, string>();
  for (const p of selected) {
    pipelineNameById.set(p.id, p.name);
    for (const st of p.stages || []) stageNameByKey.set(stageKey(p.id, st.id), st.name);
  }
  const [fieldMap, userMap] = await Promise.all([getFieldMap(), getUserMap()]);
  const rec = normalizeOpportunity(opp, fieldMap, userMap, stageNameByKey, pipelineNameById);

  const src = (opp as unknown as {
    internalSource?: { type?: unknown; source?: unknown; id?: unknown; userId?: unknown };
  }).internalSource;
  return {
    rec,
    footer: {
      createdAt: String(opp.createdAt ?? opp.dateAdded ?? ""),
      updatedAt: String(opp.updatedAt ?? opp.dateUpdated ?? ""),
      sourceType: src ? String(src.type ?? "") : "",
      sourceValue: src ? String(src.source ?? "") : "",

      sourceUserId: src && src.userId ? String(src.userId) : "",
      sourceId: src && src.id ? String(src.id) : "",
    },
  };
}
