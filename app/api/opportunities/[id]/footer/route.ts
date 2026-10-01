import { NextResponse } from "next/server";
import {
  getOpportunityWithFooter,
  getUserMap,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canSeeRecord } from "@/lib/visibility";
import { createdByLabel } from "@/lib/createdBy";
import type { ApiError } from "@/lib/types";
import { withGrants } from "@/lib/withGrants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ═══════════════════════════════════════════════════════════════════════════
// ROUND 168 — THE RECORD FOOTER: GoHighLevel's own, in our panel.
//
// 🔴 A SINGLE-RECORD READ DID NOT EXIST, AND THAT IS NOT AN OVERSIGHT. Round
// 135 settled that the panel renders from the BOARD LIST — one payload, no
// per-record fetch, which is what keeps opening a card instant and the request
// count flat. This route exists because `internalSource` is the one thing the
// panel needs that the search endpoint does not return, probed live:
//
//     GET /opportunities/{id}        internalSource: { type: CREATED,
//                                      source: WORKFLOW_NEW, id: cb82ab6e-… }
//     GET /opportunities/search      absent
//
// ⚠️ ONE READ PER PANEL OPEN, AND NEVER ADDED TO THE BOARD PAYLOAD. Folding it
// into the list would mean several hundred single-record GETs on every load, on
// an account whose budget is 100 requests per 10 seconds. The whole reason the
// panel reads from the list is to avoid exactly that.
//
// 🔴 GATED LIKE EVERY OTHER PER-RECORD ROUTE — `canSeeRecord`, the same test
// `conflicts/route.ts` uses, on the same mapped record. Without it this would
// be a way to confirm a record's existence, its creation time and who made it
// for any id a viewer could guess, on records their board withholds.
// ═══════════════════════════════════════════════════════════════════════════
async function getHandler(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const blob =
      request.headers.get("x-ghl-sso-key") ||
      new URL(request.url).searchParams.get("ssoKey");

    let session: { userId: string; role?: string; type?: string } | null = null;
    if (ssoConfigured()) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      const s = decryptSso(blob);
      session = { userId: s.userId, role: s.role, type: s.type };
    }

    const got = await getOpportunityWithFooter(id);
    if (!got)
      return NextResponse.json({ error: "Opportunity not found." } as ApiError, {
        status: 404,
      });
    if (session && !canSeeRecord(got.rec, session))
      return NextResponse.json(
        { error: "Not permitted.", status: 403 } as ApiError,
        { status: 403 },
      );

    // ⚠️ RESOLVED SERVER-SIDE, because the label needs the user map and the
    // client has only the users in its own payload — which is scoped. A record
    // created by somebody outside the viewer's divisions would read "Former
    // user" on the client and the right name here.
    const users = await getUserMap();
    const footer = got.footer;
    return NextResponse.json(
      {
        ok: true,
        createdAt: footer.createdAt,
        updatedAt: footer.updatedAt,
        /** "" when GoHighLevel sent no internalSource — the panel shows nothing. */
        createdBy: createdByLabel(footer, (uid) => users.get(uid) || ""),
        /**
         * ⚠️ THE RAW VALUE TRAVELS TOO, and it is deliberate. When the label
         * falls through to the mechanical fallback, the only way anyone can
         * send us the real value to map is if they can see it. It is account
         * metadata — a GoHighLevel enum name — not client data.
         */
        createdBySource: footer.sourceValue,
        recordId: id,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json(
        { error: "Sign-in failed.", detail: e.message, status: 401 } as ApiError,
        { status: 401 },
      );
    if (e instanceof GhlError)
      return NextResponse.json(
        { error: "Could not read the record footer.", detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Could not read the record.", status: 500 } as ApiError,
      { status: 500 },
    );
  }
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  // Grants are loaded once per request so canSeeRecord sees this viewer's
  // pipelines — the same wrapper every other per-record route uses.
  return withGrants(() => getHandler(request, ctx));
}
