import { NextResponse } from "next/server";
import {
  getOpportunityById,
  invalidateOpportunity,
  addOpportunityFollowers,
  removeOpportunityFollowers,
  getLocationUserIds,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canManageFollowers } from "@/lib/visibility";
import type { ApiError } from "@/lib/types";
import { withGrants } from "@/lib/withGrants";
import { versionGuard } from "@/lib/concurrency";
import { emit } from "@/lib/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// PATCH { ssoKey?, add?: string[], remove?: string[] } — manage followers via
// GHL's dedicated add/remove endpoints. Only the OWNER or an admin may change
// followers. Returns the follower id list READ BACK FROM THE RECORD, with
// `confirmed` false on the one path where the read-back itself failed (round
// 151 — it used to return a list it computed and had not verified).
// Note: GHL sends NO native notification to a new follower.
async function patchHandler(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      add?: string[];
      remove?: string[];
      expectedVersion?: string;
    };
    const blob = body.ssoKey || request.headers.get("x-ghl-sso-key");

    // ---- identity (server-derived) ----
    let session: { userId: string; role?: string; type?: string } | null = null;
    const enforce = ssoConfigured();
    if (enforce) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      const s = decryptSso(blob);
      session = { userId: s.userId, role: s.role, type: s.type };
    }

    // ---- load target + owner/admin gate ----
    const target = await getOpportunityById(id);
    if (!target)
      return NextResponse.json({ error: "Opportunity not found." } as ApiError, {
        status: 404,
      });
    if (enforce && session && !canManageFollowers(target, session))
      return NextResponse.json(
        {
          error: "Not permitted.",
          detail: "Only the record owner or an admin can change followers.",
          status: 403,
        } as ApiError,
        { status: 403 },
      );

    // ITEM 5 — followers decide who can SEE the record, so losing a race here
    // silently re-shares or un-shares a case.
    const conflict = versionGuard(target, body.expectedVersion, "FOLLOWERS");
    if (conflict) return conflict;

    const add = (body.add || []).filter(Boolean);
    const remove = (body.remove || []).filter(Boolean);
    if (!add.length && !remove.length)
      return NextResponse.json(
        { error: "Nothing to change — provide add and/or remove." } as ApiError,
        { status: 400 },
      );

    // Validate ADD ids against the location's real users. Without this an
    // arbitrary string would be stored and later render as "Former user",
    // indistinguishable from a genuinely deleted account. (REMOVE is not
    // validated — a stale/deleted id must always be removable.)
    if (add.length) {
      const valid = await getLocationUserIds();
      const unknown = add.filter((u) => !valid.has(u));
      if (unknown.length)
        return NextResponse.json(
          {
            error: "Unknown user id(s).",
            detail: `Not users of this location: ${unknown.join(", ")}`,
            status: 400,
          } as ApiError,
          { status: 400 },
        );
    }

    // Remove first, then add (so a same-tick add wins if both are sent).
    if (remove.length) await removeOpportunityFollowers(id, remove);
    if (add.length) await addOpportunityFollowers(id, add);

    // ═══ ROUND 151 — READ BACK, THEN REPORT AND EMIT FROM WHAT GHL STORED ═══
    //
    // 🔴 THIS ROUTE USED TO FABRICATE ITS OWN SUCCESS. It recomputed the final
    // list from `target.followerIds` — the PRE-WRITE read — plus `add`, and
    // returned it as fact. The comment said that was so the result "never
    // depends on the GHL response shape", which was a reasonable hedge while
    // the shape was unknown; the four-variant probe settled the shape, and the
    // reason expired while the code outlived it.
    //
    // What it cost: during the silent refusal this route returned 200 with the
    // follower present. The chip rendered, the rep saw it land, and it was gone
    // on the next load. ⚠️ NOT A BLANK THAT LOOKS LIKE AN ANSWER — AN ANSWER
    // THAT LOOKS CONFIRMED, which is worse: a blank makes somebody ask a
    // question, and this made them doubt the reload.
    //
    // ⚠️ AND THE EMITS MOVED BELOW THE READ-BACK. They fired for every id in
    // `add`, so a refused write still announced `follower.added` to every
    // downstream consumer. They now fire only for what is actually there.
    invalidateOpportunity(id);
    const after = await getOpportunityById(id);

    // ⚠️ A FAILED READ-BACK IS NOT A FAILED WRITE, and must not be reported as
    // one — telling a rep their change failed when it landed sends them to
    // redo it. The echo assertion in `addOpportunityFollowers` is the primary
    // defence and has already run; this is confirmation, so losing it degrades
    // to the old optimistic list with `confirmed:false` rather than to a 502.
    const confirmed = !!after;
    const removeSet = new Set(remove);
    const finalIds = after
      ? after.followerIds
      : Array.from(
          new Set([...target.followerIds.filter((f) => !removeSet.has(f)), ...add]),
        );
    const stored = new Set(finalIds);

    // One event per follower, so a consumer doesn't have to diff two arrays.
    for (const uid of add.filter((u) => !confirmed || stored.has(u)))
      await emit(
        "follower.added",
        { actor: { userId: session?.userId || "" }, opportunityId: id, contactId: target.contactId },
        { followerId: uid },
      );
    for (const uid of remove.filter((u) => !confirmed || !stored.has(u)))
      await emit(
        "follower.removed",
        { actor: { userId: session?.userId || "" }, opportunityId: id, contactId: target.contactId },
        { followerId: uid },
      );

    // 🔴 A PARTIAL IS STILL A FAILURE AND SAYS SO. `addOpportunityFollowers`
    // throws only when NOTHING landed — the one signature that was probed. One
    // of two landing is caught here instead, with both halves named.
    const missing = confirmed ? add.filter((u) => !stored.has(u)) : [];
    const lingering = confirmed ? remove.filter((u) => stored.has(u)) : [];

    // ═══ ROUND 156 — A DISAGREEING READ-BACK IS UNCONFIRMED, NOT FAILED ══════
    //
    // 🔴 THIS WAS A 502 AND THAT WAS THE MIRROR OF THE BUG IT WAS BUILT FOR.
    // GoHighLevel applies some writes asynchronously — 17 of 27 permission
    // writes read back unchanged one second after a 200, all 27 correct
    // minutes later. A read-back cannot tell "did not land" from "has not
    // landed yet", so a 502 here tells a rep their change failed when it
    // worked, and sends them to do it again.
    //
    // ⚠️ THE ECHO IS THE DEFENCE, NOT THIS. `addOpportunityFollowers` throws
    // when GoHighLevel's own response says nothing was stored, and
    // `removeOpportunityFollowers` now does the same on `followersRemoved` —
    // both judge the WRITE's own answer, which cannot be stale. By the time
    // this runs the write has already been vouched for; what is in doubt is
    // only whether a later read has caught up.
    //
    // 🔴 SO IT REPORTS THE THIRD STATE, exactly as the relation badges do:
    // `confirmed:false` with the ids named, and the list we have reason to
    // believe is right. Not a success dressed as certainty, not a failure.
    const unconfirmed = [...missing, ...lingering];
    if (unconfirmed.length) {
      // eslint-disable-next-line no-console
      console.warn(
        `[followers] ${id}: the write was vouched for by GoHighLevel's own response, but the ` +
          `read-back does not show ${unconfirmed.join(", ")}. Reporting unconfirmed rather than ` +
          `failed — GoHighLevel applies some writes asynchronously.`,
      );
      // ⚠️ THE OPTIMISTIC LIST IS THE RIGHT ANSWER HERE, and only here. The
      // echo said the write landed, so what we asked for is the better
      // description of the record than a read that has not caught up.
      const removeSet2 = new Set(remove);
      const believed = Array.from(
        new Set([...target.followerIds.filter((f) => !removeSet2.has(f)), ...add]),
      );
      return NextResponse.json(
        { ok: true, followers: believed, confirmed: false, unconfirmed },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(
      { ok: true, followers: finalIds, confirmed },
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
        {
          error: "Failed to update followers.",
          detail: await explainGhlError(e),
        } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Failed to update followers.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}


// Grants are loaded once per request so canSeeRecord/canEditRecord see the
// live pipeline-access custom value rather than only the env var.
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => patchHandler(request, ctx));
}
