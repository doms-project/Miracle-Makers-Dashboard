import { GhlError } from "./ghl";

const BASE_URL = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";

export interface PeerFieldDef {
  id: string;
  name: string;
  dataType: string;
  options: string[];
}

export interface PeerPipeline {
  id: string;
  name: string;
  stages: { id: string; name: string; position: number }[];
}

export function peerConfigured(): boolean {
  return !!(process.env.PEER_PIT?.trim() && process.env.PEER_LOCATION_ID?.trim());
}

export function peerLabel(): string {
  return process.env.PEER_LABEL?.trim() || "the other account";
}

function requirePeerEnv(): { token: string; locationId: string } {
  const token = process.env.PEER_PIT?.trim().replace(/^Bearer\s+/i, "");
  const locationId = process.env.PEER_LOCATION_ID?.trim();
  if (!token || !locationId)
    throw new GhlError(
      `This deployment has no link to ${peerLabel()}.`,
      503,
      "PEER_PIT and PEER_LOCATION_ID are not both set on the server. Transfers are unavailable until they are.",
    );
  return { token, locationId };
}

export function peerLocationId(): string {
  return requirePeerEnv().locationId;
}

function peerHeaders(): HeadersInit {
  const { token } = requirePeerEnv();
  return {
    Authorization: `Bearer ${token}`,
    Version: process.env.GHL_API_VERSION || "2021-07-28",
    Accept: "application/json",
  };
}

function peerError(path: string, status: number, raw: string): GhlError {
  let message = "";
  try {
    const j = JSON.parse(raw) as { message?: unknown };
    message = Array.isArray(j.message) ? j.message.join("; ") : String(j.message ?? "");
  } catch {
    message = raw.slice(0, 300);
  }

  if (/at least one of.*(number|email)/i.test(message))
    return new GhlError(
      "That person has no phone number and no email address.",
      status,
      `GoHighLevel needs one of them to create a contact — it will not accept a person with neither, on any account. Add one on the record panel — the phone and the email are editable there — then transfer. (${peerLabel()}: ${path} → ${status})`,
    );
  return new GhlError(
    `${peerLabel()} refused the request.`,
    status,
    `${path} → ${status}${message ? ` — ${message}` : ""}`,
  );
}

async function peerGet<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { headers: peerHeaders(), cache: "no-store" });
  } catch (e) {
    throw new GhlError(
      `Could not reach ${peerLabel()}.`,
      502,
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!res.ok) throw peerError(path, res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

async function peerSend<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { ...peerHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new GhlError(
      `Could not reach ${peerLabel()}.`,
      502,
      e instanceof Error ? e.message : String(e),
    );
  }
  if (!res.ok) throw peerError(path, res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

export async function peerFieldDefs(
  model: "contact" | "opportunity",
): Promise<PeerFieldDef[]> {
  const { locationId } = requirePeerEnv();
  const data = await peerGet<{ customFields?: Record<string, unknown>[] }>(
    `/locations/${encodeURIComponent(locationId)}/customFields?model=${model}`,
  );
  return (data.customFields || []).map((f) => ({
    id: String(f.id ?? ""),
    name: String(f.name ?? ""),
    dataType: String(f.dataType ?? ""),

    options: (
      (f.picklistOptions as unknown[]) ??
      (f.options as unknown[]) ??
      []
    ).map((o) =>
      typeof o === "string" ? o : String((o as { value?: unknown })?.value ?? o ?? ""),
    ),
  }));
}

export async function peerPipelines(): Promise<PeerPipeline[]> {
  const { locationId } = requirePeerEnv();
  const data = await peerGet<{ pipelines?: Record<string, unknown>[] }>(
    `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`,
  );
  return (data.pipelines || []).map((p) => ({
    id: String(p.id ?? ""),
    name: String(p.name ?? ""),
    stages: ((p.stages as Record<string, unknown>[]) || []).map((s, i) => ({
      id: String(s.id ?? ""),
      name: String(s.name ?? ""),

      position: typeof s.position === "number" ? s.position : i,
    })),
  }));
}

export async function peerFindContact(
  by: { email?: string; phone?: string },
): Promise<{ id: string; name: string; email: string; phone: string } | null> {
  const { locationId } = requirePeerEnv();
  for (const q of [by.email, by.phone]) {
    if (!q?.trim()) continue;
    const data = await peerSend<{ contacts?: Record<string, unknown>[] }>(
      "POST",
      "/contacts/search",
      { locationId, page: 1, pageLimit: 10, query: q.trim() },
    );
    const hit = (data.contacts || [])[0];
    if (hit)
      return {
        id: String(hit.id ?? ""),
        name: String(
          hit.contactName ??
            hit.name ??
            [hit.firstName, hit.lastName].filter(Boolean).join(" "),
        ).trim(),
        email: String(hit.email ?? ""),
        phone: String(hit.phone ?? ""),
      };
  }
  return null;
}

export async function peerOpportunityInPipeline(
  contactId: string,
  pipelineId: string,
): Promise<{ id: string; name: string; stageId: string } | null> {
  const { locationId } = requirePeerEnv();
  const params = new URLSearchParams({
    location_id: locationId,
    contact_id: contactId,
    pipeline_id: pipelineId,
    limit: "20",
  });
  const data = await peerGet<{ opportunities?: Record<string, unknown>[] }>(
    `/opportunities/search?${params.toString()}`,
  );

  const hit = (data.opportunities || []).find(
    (o) => String(o.pipelineId ?? "") === pipelineId,
  );
  return hit
    ? {
        id: String(hit.id ?? ""),
        name: String(hit.name ?? ""),
        stageId: String(hit.pipelineStageId ?? hit.stageId ?? ""),
      }
    : null;
}

export async function peerUpsertContact(c: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  source: string;
  tags: string[];
  customFields: { id: string; value: unknown }[];
}): Promise<{ id: string; isNew: boolean }> {
  const { locationId } = requirePeerEnv();
  const body: Record<string, unknown> = { locationId };
  if (c.firstName) body.firstName = c.firstName;
  if (c.lastName) body.lastName = c.lastName;
  const name = [c.firstName, c.lastName].filter(Boolean).join(" ");
  if (name) body.name = name;
  if (c.email) body.email = c.email;
  if (c.phone) body.phone = c.phone;
  if (c.source) body.source = c.source;
  if (c.tags.length) body.tags = c.tags;

  if (c.customFields.length)
    body.customFields = c.customFields.map((f) => ({ id: f.id, value: f.value }));
  const res = await peerSend<{ contact?: { id?: string }; new?: boolean }>(
    "POST",
    "/contacts/upsert",
    body,
  );
  const id = res.contact?.id || "";
  if (!id)
    throw new GhlError(
      `${peerLabel()} accepted the person but returned no id.`,
      502,
      "Nothing further was written. Check the account before retrying — a contact may exist there.",
    );
  return { id, isNew: res.new !== false };
}

export async function peerCreateOpportunity(o: {
  pipelineId: string;
  stageId: string;
  contactId: string;
  name: string;
  source: string;
  monetaryValue: number;
  customFields: { id: string; value: unknown }[];
}): Promise<string> {
  const { locationId } = requirePeerEnv();
  const body: Record<string, unknown> = {
    locationId,
    pipelineId: o.pipelineId,
    pipelineStageId: o.stageId,
    contactId: o.contactId,
    name: o.name,
    status: "open",
  };
  if (o.source) body.source = o.source;

  if (Number.isFinite(o.monetaryValue) && o.monetaryValue > 0)
    body.monetaryValue = o.monetaryValue;
  if (o.customFields.length) body.customFields = o.customFields;
  const res = await peerSend<{ opportunity?: { id?: string }; id?: string }>(
    "POST",
    "/opportunities/",
    body,
  );
  const id = res.opportunity?.id || res.id || "";
  if (!id)
    throw new GhlError(
      `${peerLabel()} accepted the case but returned no id.`,
      502,
      "The case may exist there without this side knowing its id. Check before retrying.",
    );
  return id;
}

export async function peerAddNote(
  contactId: string,
  body: string,
): Promise<void> {

  await peerSend("POST", `/contacts/${encodeURIComponent(contactId)}/notes`, { body });
}
