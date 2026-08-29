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
import type { ApiError } from "@/lib/types";
import { withGrants } from "@/lib/withGrants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ITEM 4 — edit a note. PUT { ssoKey?, body }
//
// The decision, and the reasons it was made that way:
//   - the AUTHOR only, admins included. On a transferred case the notes are the
//     receiving rep's only account of what happened; someone else rewriting them
//     is worse than the typo.
//   - NO delete route exists, deliberately. A gap nobody can see is worse than a
//     visible correction. There is no DELETE handler here and there should not be.
//   - the edit OVERWRITES the original text — this is not a true audit trail,
//     and the "[edited]" marker is what keeps it honest.
//
// Two things are recovered SERVER-SIDE and never taken from the client: the
// note's author (the gate) and the division stamped at original write time (so
// an edit cannot relabel which division wrote it).
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

    // THE GATE. Author only — an admin is not an exception here.
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

    // 🔴 THE SERVER IS THE BOUNDARY, not the form.
    //
    // The note is re-read from GoHighLevel and rebuilt from its STORED parts:
    // the division stamped at original write time, the [move] flag, and — the
    // one that matters — the SYSTEM half of a Move note. The only thing the
    // client controls is the reason. Anything it sends for the prefix is
    // discarded, so a direct API call cannot rewrite the audit trail however
    // the form is bypassed.
    //
    // Only `body` goes to GHL, so `dateAdded` — the original timestamp — is
    // untouched.
    const original = parseNoteBody(existing.body);
    const note = await updateOpportunityNote(
      record.contactId,
      noteId,
      composeNoteBody({
        division: original.division, // stored
        edited: true,
        removed: false, // editing brings a withdrawn reason back
        isMove: original.isMove, // stored
        system: original.system, // stored — NEVER from the request
        reason: text, // the only client-controlled part
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

// ITEM 5 — SOFT delete. Reversal of the earlier decision, built the safe way.
//
// The note is NOT erased. Its text is replaced with a removal record, and a
// `[removed]` tag marks the slot so the reader can see that something was here
// and who took it away. The original text is gone — this is a removal, not an
// archive — but the GAP is visible, which was the whole objection to deleting:
// on a transferred case these notes are the receiving rep's only account of
// what happened, and an invisible gap is worse than a visible correction.
//
// Author only, exactly the same gate as edit. There is deliberately no way for
// an admin to remove someone else's note.
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

    // Who and when are baked into the text: GHL gives us no metadata field, and
    // the note's own dateAdded is the ORIGINAL write time, not the removal.
    const userMap = await getUserMap();
    const who = (existing.userId && userMap.get(existing.userId)) || "the author";
    const when = new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
    // A MOVE note loses only its reason — the system sentence stays, so the
    // receiving rep still sees how the case reached them. A MANUAL note has no
    // system half, so the whole thing becomes the removal record.
    //
    // The server builds this itself and accepts no body from the client, for
    // the same reason as the edit path.
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
