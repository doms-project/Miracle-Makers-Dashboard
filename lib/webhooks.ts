import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// ITEM 5 — OUTBOUND webhooks. The real requirement.
//
// WHY THIS EXISTS RATHER THAN GHL TRIGGERS. GoHighLevel fires on stage and owner
// changes, but not reliably on custom-field writes — and a Move is SEVERAL API
// writes that GHL sees as unrelated events. Only the dashboard knows that "a
// transfer happened, from X to Y, owner A to B, reason R" is ONE thing. That
// knowledge is lost the moment it reaches GHL, so it has to be emitted here.
//
// 🔴 FIRE AND FORGET. A webhook failure must NEVER fail the user's action. The
// save already succeeded; the notification is secondary. Every dispatch is
// wrapped, logged on failure, and awaited only long enough not to be killed by
// the serverless runtime cutting the request short.
//
// The endpoint is an ENV VAR so Make or GHL can be repointed without a redeploy.
// ---------------------------------------------------------------------------

export type WebhookEventName =
  | "opportunity.moved"
  | "opportunity.assigned"
  | "opportunity.created"
  | "field.changed"
  | "note.added"
  | "follower.added"
  | "follower.removed";

export interface WebhookActor {
  userId: string;
  name?: string;
}

export interface WebhookEvent {
  event: WebhookEventName;
  /** ISO 8601, set here so every consumer sees one clock. */
  at: string;
  actor: WebhookActor;
  opportunityId: string;
  contactId: string;
  locationId: string;
  /** Event-specific payload. Kept flat and named, never a raw GHL body. */
  data: Record<string, unknown>;
}

function config(): { url: string; secret: string } | null {
  const url = (process.env.WEBHOOK_URL || "").trim();
  if (!url) return null;
  return { url, secret: (process.env.WEBHOOK_SECRET || "").trim() };
}

/** True when outbound webhooks are configured — lets routes skip the work. */
export function webhooksEnabled(): boolean {
  return !!config();
}

// The shared secret goes in a HEADER, and an HMAC of the exact body goes beside
// it. The header alone proves the caller knows the secret; the signature also
// proves the BODY wasn't altered in transit, which is what a receiver actually
// needs before acting on "owner changed to X".
function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Send one event. Never throws — callers do not need a try/catch, and must not
 * make the user's save depend on this.
 */
export async function emit(
  event: WebhookEventName,
  base: {
    actor: WebhookActor;
    opportunityId?: string;
    contactId?: string;
    locationId?: string;
  },
  data: Record<string, unknown> = {},
): Promise<void> {
  const cfg = config();
  if (!cfg) return; // not configured — silently inert, by design

  const payload: WebhookEvent = {
    event,
    at: new Date().toISOString(),
    actor: base.actor,
    opportunityId: base.opportunityId || "",
    contactId: base.contactId || "",
    locationId: base.locationId || (process.env.GHL_LOCATION_ID || "").trim(),
    data,
  };
  const body = JSON.stringify(payload);

  try {
    // A slow receiver must not hold the user's request open. 5s is generous for
    // a webhook and short enough that nobody notices.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-MM-Event": event,
        ...(cfg.secret
          ? {
              "X-MM-Secret": cfg.secret,
              "X-MM-Signature": `sha256=${sign(body, cfg.secret)}`,
            }
          : {}),
      },
      body,
      signal: ac.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // eslint-disable-next-line no-console
      console.error(
        `[webhook] ${event} -> ${res.status} ${text.slice(0, 300)}`,
      );
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      `[webhook] ${event} failed (the user's action still succeeded):`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

/** Verify an INBOUND call came from a party holding the secret. */
export function verifyInbound(
  headerSecret: string | null,
  signature: string | null,
  body: string,
): boolean {
  const cfg = config();
  const secret = cfg?.secret || (process.env.WEBHOOK_SECRET || "").trim();
  // No secret configured = nothing to verify against. Refuse rather than accept
  // everything: an unauthenticated write endpoint is worse than a missing one.
  if (!secret) return false;
  if (signature) {
    const expected = `sha256=${sign(body, secret)}`;
    // Constant-time compare — a plain === leaks length and prefix by timing.
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (headerSecret) {
    const a = Buffer.from(headerSecret);
    const b = Buffer.from(secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return false;
}
