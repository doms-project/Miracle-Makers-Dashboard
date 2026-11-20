import crypto from "node:crypto";

export type WebhookEventName =
  | "opportunity.moved"
  | "opportunity.assigned"
  | "opportunity.created"

  | "opportunity.deleted"

  | "opportunity.transferred"
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

  at: string;
  actor: WebhookActor;
  opportunityId: string;
  contactId: string;
  locationId: string;

  data: Record<string, unknown>;
}

function config(): { url: string; secret: string } | null {
  const url = (process.env.WEBHOOK_URL || "").trim();
  if (!url) return null;
  return { url, secret: (process.env.WEBHOOK_SECRET || "").trim() };
}

export function webhooksEnabled(): boolean {
  return !!config();
}

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

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
  if (!cfg) return;

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

export function verifyInbound(
  headerSecret: string | null,
  signature: string | null,
  body: string,
): boolean {
  const cfg = config();
  const secret = cfg?.secret || (process.env.WEBHOOK_SECRET || "").trim();

  if (!secret) return false;
  if (signature) {
    const expected = `sha256=${sign(body, secret)}`;

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
