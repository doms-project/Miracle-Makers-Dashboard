import { NextResponse } from "next/server";
import {
  getOpportunityById,
  invalidateOpportunity,
  getUserMap,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 🔴 ROUND 118 · ITEM 4 — "WHO ENDED UP OWNING THIS?"
 *
 * /api/clients no longer names an owner: the GoHighLevel notification workflow
 * is the only author. But the workflow API returns no triggers and no actions —
 * verified twice — so this app CANNOT PREDICT who it will assign. The only
 * honest thing to do is create the record and then look.
 *
 * ⚠️ A ROUTE OF ITS OWN, RETURNING ONLY THE OWNER. Two reasons, and the second
 * is the one that forced it:
 *
 *   1. MINIMAL DISCLOSURE. The caller needs one name. Returning the record
 *      would hand out a client's details to answer a question about assignment.
 *
 *   2. 🔴 `canEditRecord` WOULD REFUSE THE PERSON WHO JUST CREATED IT. The
 *      PATCH handler on the sibling route gates on owner-or-follower — and a
 *      record the workflow has not assigned yet has NO OWNER, so the creating
 *      rep fails that check on their own new record, every time, for exactly
 *      as long as the answer is interesting. Reusing that gate here would have
 *      produced a 403 that looked like a permissions bug and was really a race.
 *
 * So the rule is: any signed-in user of this location may ask who owns an
 * opportunity. An owner's NAME is not private within the location — it is on
 * every board card already — and "nobody owns this" is the state this route
 * exists to report.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const url = new URL(request.url);
    const blob =
      request.headers.get("x-ghl-sso-key") || url.searchParams.get("ssoKey") || "";

    if (ssoConfigured()) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      decryptSso(blob); // throws SsoError — identity is all we need
    }

    // 🔴 UNCACHED, AND THAT IS THE WHOLE POINT. This is polled precisely because
    // the answer is expected to CHANGE — a cached read would return the
    // ownerless record we just created, forever, and the screen would report
    // "nobody is assigned" about a record the workflow had already assigned.
    invalidateOpportunity(id);
    const rec = await getOpportunityById(id);
    if (!rec)
      return NextResponse.json(
        { error: "Opportunity not found.", status: 404 } as ApiError,
        { status: 404 },
      );

    const ownerId = rec.ownerId || "";
    let ownerName = "";
    if (ownerId) {
      try {
        ownerName = (await getUserMap()).get(ownerId) || "";
      } catch {
        // ⚠️ A NAME WE COULD NOT LOOK UP IS NOT "UNASSIGNED". The id is the
        // fact; the name is the courtesy. Returning ownerId with an empty name
        // lets the caller still say "somebody owns this".
      }
    }
    return NextResponse.json(
      { ownerId, ownerName },
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
        { error: e.message, detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Request failed.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}
