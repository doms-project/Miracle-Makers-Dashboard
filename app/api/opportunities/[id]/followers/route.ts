import { NextResponse } from "next/server";
import {
  getOpportunityById,
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

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// PATCH { ssoKey?, add?: string[], remove?: string[] } — manage followers via
// GHL's dedicated add/remove endpoints. Only the OWNER or an admin may change
// followers. Returns the recomputed follower id list (never depends on GHL's
// response shape). Note: GHL sends NO native notification to a new follower.
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

    // Recompute the final set from the known-current followers so the result
    // never depends on the GHL response shape.
    const removeSet = new Set(remove);
    const finalIds = Array.from(
      new Set([...target.followerIds.filter((f) => !removeSet.has(f)), ...add]),
    );

    return NextResponse.json(
      { ok: true, followers: finalIds },
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
