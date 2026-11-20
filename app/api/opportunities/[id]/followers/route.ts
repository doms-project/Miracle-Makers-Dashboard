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

    const conflict = versionGuard(target, body.expectedVersion, "FOLLOWERS");
    if (conflict) return conflict;

    const add = (body.add || []).filter(Boolean);
    const remove = (body.remove || []).filter(Boolean);
    if (!add.length && !remove.length)
      return NextResponse.json(
        { error: "Nothing to change — provide add and/or remove." } as ApiError,
        { status: 400 },
      );

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

    if (remove.length) await removeOpportunityFollowers(id, remove);
    if (add.length) await addOpportunityFollowers(id, add);

    invalidateOpportunity(id);
    const after = await getOpportunityById(id);

    const confirmed = !!after;
    const removeSet = new Set(remove);
    const finalIds = after
      ? after.followerIds
      : Array.from(
          new Set([...target.followerIds.filter((f) => !removeSet.has(f)), ...add]),
        );
    const stored = new Set(finalIds);

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

    const missing = confirmed ? add.filter((u) => !stored.has(u)) : [];
    const lingering = confirmed ? remove.filter((u) => stored.has(u)) : [];

    const unconfirmed = [...missing, ...lingering];
    if (unconfirmed.length) {
      // eslint-disable-next-line no-console
      console.warn(
        `[followers] ${id}: the write was vouched for by GoHighLevel's own response, but the ` +
          `read-back does not show ${unconfirmed.join(", ")}. Reporting unconfirmed rather than ` +
          `failed — GoHighLevel applies some writes asynchronously.`,
      );

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

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => patchHandler(request, ctx));
}
