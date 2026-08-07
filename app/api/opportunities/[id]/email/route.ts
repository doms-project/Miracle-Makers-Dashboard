import { NextResponse } from "next/server";
import {
  getOpportunityById,
  getContactBrief,
  listCaregiverRelations,
  listEmailTemplates,
  sendEmail,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canEditRecord } from "@/lib/visibility";
import { EMAIL_TEMPLATES } from "@/lib/emailTemplates";
import type { ApiError, EmailRecipient, EmailSendResult } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type Session = { userId: string; role?: string; type?: string } | null;

async function authorize(
  id: string,
  blob: string | null,
): Promise<
  | { ok: true; contactId: string }
  | { ok: false; res: NextResponse }
> {
  let session: Session = null;
  const enforce = ssoConfigured();
  if (enforce) {
    if (!blob)
      return {
        ok: false,
        res: NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        ),
      };
    const s = decryptSso(blob);
    session = { userId: s.userId, role: s.role, type: s.type };
  }
  const target = await getOpportunityById(id);
  if (!target)
    return {
      ok: false,
      res: NextResponse.json({ error: "Opportunity not found." } as ApiError, {
        status: 404,
      }),
    };
  if (enforce && session && !canEditRecord(target, session))
    return {
      ok: false,
      res: NextResponse.json(
        {
          error: "Not permitted.",
          detail: "You can only email on records you own or follow.",
          status: 403,
        } as ApiError,
        { status: 403 },
      ),
    };
  if (!target.contactId)
    return {
      ok: false,
      res: NextResponse.json(
        { error: "This opportunity has no linked client contact." } as ApiError,
        { status: 400 },
      ),
    };
  return { ok: true, contactId: target.contactId };
}

function fail(e: unknown): NextResponse {
  if (e instanceof SsoError)
    return NextResponse.json(
      { error: e.message, status: e.status } as ApiError,
      { status: e.status },
    );
  if (e instanceof GhlError) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 502;
    const detail =
      e.status === 401 || e.status === 403
        ? `${e.detail || ""} (If email sends specifically fail, the PIT may lack the conversations/email send scope — add it to the Private Integration.)`
        : e.detail;
    return NextResponse.json(
      { error: e.message, detail, status: e.status } as ApiError,
      { status },
    );
  }
  return NextResponse.json(
    { error: "Email operation failed.", detail: String(e) } as ApiError,
    { status: 500 },
  );
}

// GET — recipients (client + caregivers, with emails) + templates for the composer.
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const blob = request.headers.get("x-ghl-sso-key");
    const a = await authorize(id, blob);
    if (!a.ok) return a.res;

    const recipients: EmailRecipient[] = [];
    // Client (the enrollment contact).
    try {
      const c = await getContactBrief(a.contactId);
      recipients.push({ ...c, contactId: c.id, role: "client" });
    } catch {
      /* client brief best-effort */
    }
    // Caregivers (from the Task 4 associations), with emails resolved.
    try {
      const rels = await listCaregiverRelations(a.contactId);
      for (const r of rels) {
        let email = "";
        try {
          email = (await getContactBrief(r.contactId)).email;
        } catch {
          /* keep blank */
        }
        recipients.push({
          contactId: r.contactId,
          name: r.name,
          email,
          role: "caregiver",
        });
      }
    } catch {
      /* associations may be unavailable — client still emailable */
    }

    // Prefer live GHL templates (Jack's team manages them in the native
    // builder); fall back to the config templates if the call fails or returns
    // none, so the composer never comes up empty.
    let templates = EMAIL_TEMPLATES as { id: string; name: string; subject: string; body: string }[];
    let templatesSource: "ghl" | "config" = "config";
    try {
      const live = await listEmailTemplates();
      if (live.length) {
        templates = live;
        templatesSource = "ghl";
      }
    } catch {
      /* keep config fallback */
    }

    return NextResponse.json(
      { recipients, templates, templatesSource },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}

// POST { ssoKey?, recipientContactIds[], subject, html, cc? } — send per recipient.
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      recipientContactIds?: string[];
      subject?: string;
      html?: string;
      templateId?: string;
      cc?: string[];
    };
    const blob = body.ssoKey || request.headers.get("x-ghl-sso-key");
    const a = await authorize(id, blob);
    if (!a.ok) return a.res;

    const recipientContactIds = (body.recipientContactIds || []).filter(Boolean);
    if (!recipientContactIds.length)
      return NextResponse.json(
        { error: "Pick at least one recipient." } as ApiError,
        { status: 400 },
      );
    if (!body.subject?.trim() || !body.html?.trim())
      return NextResponse.json(
        { error: "Subject and body are required." } as ApiError,
        { status: 400 },
      );

    // If the body already looks like HTML (GHL builder output), send it as-is;
    // otherwise convert plain-text newlines to <br> for readable email.
    const looksHtml = /<[a-z][\s\S]*>/i.test(body.html);
    const html = looksHtml ? body.html : body.html.replace(/\n/g, "<br>");
    const cc = (body.cc || []).map((s) => s.trim()).filter(Boolean);

    const results: EmailSendResult[] = [];
    for (const contactId of recipientContactIds) {
      let name = contactId;
      try {
        await sendEmail({
          contactId,
          subject: body.subject,
          html,
          templateId: body.templateId,
          cc,
        });
        results.push({ contactId, name, ok: true });
      } catch (e) {
        if (e instanceof GhlError && (e.status === 401 || e.status === 403))
          return fail(e); // auth/scope problem is global — stop and surface it
        try {
          name = (await getContactBrief(contactId)).name;
        } catch {
          /* keep id */
        }
        results.push({
          contactId,
          name,
          ok: false,
          error:
            e instanceof GhlError
              ? `${e.message}${e.detail ? ` — ${e.detail}` : ""}`.slice(0, 300)
              : e instanceof Error
                ? e.message
                : String(e),
        });
      }
    }

    return NextResponse.json(
      { ok: results.some((r) => r.ok), results },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}
