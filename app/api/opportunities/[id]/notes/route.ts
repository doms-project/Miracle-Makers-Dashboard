import { NextResponse } from "next/server";
import {
  getOpportunityById,
  listOpportunityNotes,
  addOpportunityNote,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canEditRecord } from "@/lib/visibility";
import type { ApiError, OpportunityRecord } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Shared gate: resolve the target opp and confirm the caller may see it.
// Returns the record on success, or a Response to return immediately.
async function authorize(
  id: string,
  blob: string | null,
): Promise<OpportunityRecord | Response> {
  const enforce = ssoConfigured();
  let session: { userId: string; role?: string; type?: string } | null = null;
  if (enforce) {
    if (!blob) {
      return NextResponse.json(
        { error: "Sign-in required.", status: 401 } as ApiError,
        { status: 401 },
      );
    }
    const s = decryptSso(blob); // throws SsoError
    session = { userId: s.userId, role: s.role, type: s.type };
  }
  const record = await getOpportunityById(id);
  if (!record) {
    return NextResponse.json(
      { error: "Opportunity not found." } as ApiError,
      { status: 404 },
    );
  }
  if (enforce && session && !canEditRecord(record, session)) {
    return NextResponse.json(
      {
        error: "Not permitted.",
        detail: "You can only view notes for records you own or follow.",
        status: 403,
      } as ApiError,
      { status: 403 },
    );
  }
  if (!record.contactId) {
    return NextResponse.json(
      { error: "This opportunity has no linked contact." } as ApiError,
      { status: 422 },
    );
  }
  return record;
}

function errorResponse(e: unknown): Response {
  if (e instanceof SsoError)
    return NextResponse.json(
      { error: "SSO error.", detail: e.message, status: e.status } as ApiError,
      { status: e.status },
    );
  if (e instanceof GhlError) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 502;
    return NextResponse.json(
      { error: e.message, detail: e.detail, status: e.status } as ApiError,
      { status },
    );
  }
  return NextResponse.json(
    { error: "Unexpected error with notes.", detail: String(e) } as ApiError,
    { status: 500 },
  );
}

// GET — list this opportunity's notes. SSO blob passed via header.
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const blob = request.headers.get("x-ghl-sso-key");
    const gate = await authorize(id, blob);
    if (gate instanceof Response) return gate;
    const notes = await listOpportunityNotes(gate.contactId, id);
    return NextResponse.json(
      { notes },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

// POST — add a note (author = the decrypted session's userId).
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      body?: string;
    };
    const blob =
      body.ssoKey || request.headers.get("x-ghl-sso-key") || null;
    const text = (body.body || "").trim();
    if (!text) {
      return NextResponse.json(
        { error: "Note text is required." } as ApiError,
        { status: 400 },
      );
    }
    const gate = await authorize(id, blob);
    if (gate instanceof Response) return gate;

    // Author = the server-derived session userId (never a client-sent id). When
    // SSO isn't configured (dev), fall back to no author.
    let userId = "";
    if (ssoConfigured() && blob) userId = decryptSso(blob).userId;

    const note = await addOpportunityNote(gate.contactId, id, text, userId);
    return NextResponse.json(
      { ok: true, note },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
