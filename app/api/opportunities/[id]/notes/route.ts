import { NextResponse } from "next/server";
import {
  getOpportunityById,
  listOpportunityNotes,
  addOpportunityNote,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canEditRecord, isAdminSession } from "@/lib/visibility";
import type { ApiError, OpportunityRecord } from "@/lib/types";
import { withGrants } from "@/lib/withGrants";
import { emit } from "@/lib/webhooks";
import { userDivisions } from "@/lib/pipelineAccess";
import { listPipelines, stampDivision } from "@/lib/ghl";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
    const s = decryptSso(blob);
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

async function getHandler(
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

async function postHandler(
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

    let userId = "";
    if (ssoConfigured() && blob) userId = decryptSso(blob).userId;

    let division = "";
    if (userId) {
      try {
        division = userDivisions(
          userId,
          new Map((await listPipelines()).map((p) => [p.id, p.name])),
        ).join(" · ");

        if (!division && ssoConfigured() && blob) {
          const s = decryptSso(blob);
          if (isAdminSession(s.role, s.type)) division = "Admin";
        }
      } catch {

      }
    }

    const noteBody = stampDivision(text, division);
    // eslint-disable-next-line no-console
    console.log(
      `[notes] user=${userId || "(none)"} division=${JSON.stringify(division)} -> body=${JSON.stringify(noteBody.slice(0, 120))}`,
    );
    const note = await addOpportunityNote(gate.contactId, id, noteBody, userId);
    await emit(
      "note.added",
      { actor: { userId }, opportunityId: id, contactId: gate.contactId },
      { text, division, noteId: note.id },
    );
    return NextResponse.json(

      { ok: true, note: { ...note, division } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => getHandler(request, ctx));
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => postHandler(request, ctx));
}
