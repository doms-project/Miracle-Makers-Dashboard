/**
 * ═════════════════════════════════════════════════════════════════════════
 * 🔴 THE OTHER COMPANY'S ACCOUNT. THE ONLY MODULE THAT HOLDS ITS TOKEN.
 * ═════════════════════════════════════════════════════════════════════════
 *
 * The ODP division has been sold. Two companies, two GoHighLevel sub-accounts,
 * two deployments of this codebase — and nothing is shared between sub-accounts,
 * so moving a client or a caregiver is not a move. It is recreate-there,
 * close-here.
 *
 * 🔴 WHY THIS IS A SEPARATE FILE AND NOT A PARAMETER ON `lib/ghl.ts`.
 *
 * `requireEnv()` has 41 call sites and all three transports — `ghlGet`,
 * `ghlSend`, `ghlDelete` — read it. Threading an account argument through that
 * is a large diff in the file every screen depends on, and its failure mode is
 * the worst one available in this whole divestment: **an ordinary request
 * addressed to the wrong company.** A caregiver's compliance tick written into
 * the other business's account, silently, because one call site was missed.
 *
 * So `lib/ghl.ts` never learns that a second account exists. This file holds
 * the peer token, speaks to the peer location, and offers ONLY the calls a
 * transfer makes. A bug in here cannot mis-address anything else, because
 * nothing else imports it.
 *
 * ⚠️ AND NOTHING HERE IS EXPORTED TO THE BROWSER. Every caller is a route
 * handler. `PEER_PIT` is a server environment variable and must never reach a
 * payload, an error detail, or a log line.
 *
 * ⚠️ ON THE NAMES. The brief calls them PIT_SELF and PIT_PEER. `GHL_PIT` and
 * `GHL_LOCATION_ID` ALREADY ARE PIT_SELF — renaming them would touch all 41
 * call sites plus both deployments' environment configuration, to change
 * nothing. So SELF keeps its name and the new pair are `PEER_PIT` /
 * `PEER_LOCATION_ID`, matching `scripts/field-map-probe.mjs`, which is the
 * thing an operator has already run with those names in their hand.
 */
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

/** Whether this deployment has a peer at all. Every screen asks before offering. */
export function peerConfigured(): boolean {
  return !!(process.env.PEER_PIT?.trim() && process.env.PEER_LOCATION_ID?.trim());
}

/** The peer's human name, for every sentence on the screen. Never an id. */
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

/**
 * 🔴 EVERY ERROR OUT OF HERE SAYS WHICH ACCOUNT IT CAME FROM.
 *
 * A transfer touches two locations in one request. "Couldn't save" is useless
 * when the interesting part of the answer is WHICH SIDE refused — that is the
 * difference between "nothing happened" and "a contact now exists over there
 * with no case attached to it".
 */
function peerError(path: string, status: number, raw: string): GhlError {
  let message = "";
  try {
    const j = JSON.parse(raw) as { message?: unknown };
    message = Array.isArray(j.message) ? j.message.join("; ") : String(j.message ?? "");
  } catch {
    message = raw.slice(0, 300);
  }
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

// ---------------------------------------------------------------------------
// THE SIX CALLS. Four reads for the preflight, three writes for the delivery.
// Nothing else belongs in this file: every function added here widens the
// surface on which a bug can reach the other company's data.
// ---------------------------------------------------------------------------

/** The peer's custom-field definitions — the right-hand side of the map. */
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
    // ⚠️ BOTH SPELLINGS, as `optionStrings` does on the self side: GoHighLevel
    // has answered with each depending on the field's age.
    options: (
      (f.picklistOptions as unknown[]) ??
      (f.options as unknown[]) ??
      []
    ).map((o) =>
      typeof o === "string" ? o : String((o as { value?: unknown })?.value ?? o ?? ""),
    ),
  }));
}

/** The peer's pipelines and stages — where a transfer can land. */
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
      // ⚠️ `position` IS SENT — verified live on both accounts, round 126. Array
      // order is the fallback and is wrong in the same way it has always been
      // wrong, rather than newly wrong.
      position: typeof s.position === "number" ? s.position : i,
    })),
  }));
}

/**
 * Is this person already on the peer? Matched the way `upsertContact` matches,
 * so the preflight's answer is the one the write will actually produce.
 *
 * 🔴 `POST /contacts/search`, THE ENDPOINT THIS CODEBASE ALREADY PROVES LIVE.
 *
 * The first version of this used `GET /contacts/?locationId=&query=` — a real
 * GoHighLevel endpoint that NOTHING in this app has ever called. `searchContacts`
 * uses the POST, with this exact body, and has run in production for months.
 * Inventing a second shape for the same question, on the account we can test
 * least, is how a preflight comes back "nobody there" for somebody who is.
 *
 * ⚠️ AND THE HARNESS ANSWERED THE INVENTED ONE, so the proof passed for the
 * wrong reason. Caught by grepping `lib/ghl.ts` for how it asks this question,
 * not by a red test.
 */
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

/**
 * 🔴 WHAT DOES THIS PERSON ALREADY HOLD IN THAT PIPELINE?
 *
 * GoHighLevel allows ONE opportunity per contact per pipeline. A second
 * transfer of the same person is therefore not a duplicate to be tidied up
 * afterwards — it is a write that will be rejected, and the honest place to say
 * so is before anything is written.
 */
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
  // ⚠️ FILTERED AGAIN HERE. `pipeline_id` is honoured by GoHighLevel, but this
  // answer decides whether a transfer is refused — so it does not rest on a
  // query parameter being respected.
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
  // 🔴 `value`, NOT `field_value`. Contacts speak one spelling and
  // opportunities the other — verified live, and written down in
  // `updateContactCustomFields` after this exact mistake was made there.
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
  // ⚠️ NATIVE, AND THEREFORE UNCHECKABLE BY THE FIELD MAP — round 131's lesson.
  // Only sent when it is a real number, so a missing value never writes 0 and
  // calls it a figure.
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
  // ⚠️ NO userId. Peer user ids are not ours to guess — a note authored as a
  // user from the wrong account is either rejected or attributed to a stranger.
  // GoHighLevel attributes an unauthored note to the token's owner, which is
  // the truthful answer: this company's integration wrote it.
  await peerSend("POST", `/contacts/${encodeURIComponent(contactId)}/notes`, { body });
}
