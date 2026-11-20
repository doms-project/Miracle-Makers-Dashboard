import { NextResponse } from "next/server";
import {
  getOpportunityById,
  getRawNote,
  updateOpportunityNote,
  parseNoteBody,
  composeNoteBody,
  getUserMap,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canEditRecord } from "@/lib/visibility";
import { formatEasternDay } from "@/lib/dates";
import type { ApiError } from "@/lib/types";
import { withGrants } from "@/lib/withGrants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function putHandler(
  request: Request,
  ctx: { params: Promise<{ id: string; noteId: string }> },
) {
  try {
    const { id, noteId } = await ctx.params;
    const payload = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      body?: string;
    };
    const blob = payload.ssoKey || request.headers.get("x-ghl-sso-key") || null;
    const text = (payload.body || "").trim();
    if (!text)
      return NextResponse.json(
        {
          error: "Note text is required.",
          detail:
            "An empty edit would erase the note, and deletion is deliberately not supported.",
          status: 400,
        } as ApiError,
        { status: 400 },
      );

    const enforce = ssoConfigured();
    let session: { userId: string; role?: string; type?: string } | null = null;
    if (enforce) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      const s = decryptSso(blob);
      session = { userId: s.userId, role: s.role, type: s.type };
    }

    const record = await getOpportunityById(id);
    if (!record)
      return NextResponse.json({ error: "Opportunity not found." } as ApiError, {
        status: 404,
      });
    if (enforce && session && !canEditRecord(record, session))
      return NextResponse.json(
        {
          error: "Not permitted.",
          detail: "You can only edit notes on records you own or follow.",
          status: 403,
        } as ApiError,
        { status: 403 },
      );
    if (!record.contactId)
      return NextResponse.json(
        { error: "This opportunity has no linked contact." } as ApiError,
        { status: 422 },
      );

    const existing = await getRawNote(record.contactId, noteId);
    if (!existing)
      return NextResponse.json({ error: "Note not found." } as ApiError, {
        status: 404,
      });

    if (enforce && session && existing.userId !== session.userId)
      return NextResponse.json(
        {
          error: "Not permitted.",
          detail:
            "Only the author can edit a note. Add a new note instead — on a transferred case the notes are the receiving rep's account of what happened.",
          status: 403,
        } as ApiError,
        { status: 403 },
      );

    const original = parseNoteBody(existing.body);
    const note = await updateOpportunityNote(
      record.contactId,
      noteId,
      composeNoteBody({
        division: original.division,
        edited: true,
        removed: false,
        isMove: original.isMove,
        system: original.system,
        reason: text,
      }),
      existing.userId,
    );

    return NextResponse.json(
      { ok: true, note: { ...note, division: original.division } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json(
        { error: e.message, status: e.status } as ApiError,
        { status: e.status },
      );
    if (e instanceof GhlError)
      return NextResponse.json(
        { error: "Could not save the edit.", detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Could not save the edit.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}

async function deleteHandler(
  request: Request,
  ctx: { params: Promise<{ id: string; noteId: string }> },
) {
  try {
    const { id, noteId } = await ctx.params;
    const blob =
      request.headers.get("x-ghl-sso-key") ||
      new URL(request.url).searchParams.get("ssoKey");

    const enforce = ssoConfigured();
    let session: { userId: string; role?: string; type?: string } | null = null;
    if (enforce) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      const s = decryptSso(blob);
      session = { userId: s.userId, role: s.role, type: s.type };
    }

    const record = await getOpportunityById(id);
    if (!record)
      return NextResponse.json({ error: "Opportunity not found." } as ApiError, {
        status: 404,
      });
    if (enforce && session && !canEditRecord(record, session))
      return NextResponse.json(
        { error: "Not permitted.", status: 403 } as ApiError,
        { status: 403 },
      );
    if (!record.contactId)
      return NextResponse.json(
        { error: "This opportunity has no linked contact." } as ApiError,
        { status: 422 },
      );

    const existing = await getRawNote(record.contactId, noteId);
    if (!existing)
      return NextResponse.json({ error: "Note not found." } as ApiError, {
        status: 404,
      });
    if (enforce && session && existing.userId !== session.userId)
      return NextResponse.json(
        {
          error: "Not permitted.",
          detail: "Only the author can remove their own note.",
          status: 403,
        } as ApiError,
        { status: 403 },
      );

    const original = parseNoteBody(existing.body);
    if (original.removed)
      return NextResponse.json(
        { ok: true, note: null, alreadyRemoved: true },
        { headers: { "Cache-Control": "no-store" } },
      );

    const userMap = await getUserMap();
    const who = (existing.userId && userMap.get(existing.userId)) || "the author";

    const when = formatEasternDay(new Date());

    const note = await updateOpportunityNote(
      record.contactId,
      noteId,
      composeNoteBody({
        division: original.division,
        edited: original.edited,
        removed: true,
        isMove: original.isMove,
        system: original.system,
        reason: original.isMove
          ? `Reason removed by ${who} · ${when}`
          : `Note removed by ${who} · ${when}`,
      }),
      existing.userId,
    );

    return NextResponse.json(
      { ok: true, note: { ...note, division: original.division } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json(
        { error: e.message, status: e.status } as ApiError,
        { status: e.status },
      );
    if (e instanceof GhlError)
      return NextResponse.json(
        { error: "Could not remove the note.", detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Could not remove the note.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string; noteId: string }> },
) {
  return withGrants(() => putHandler(request, ctx));
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string; noteId: string }> },
) {
  return withGrants(() => deleteHandler(request, ctx));
}
