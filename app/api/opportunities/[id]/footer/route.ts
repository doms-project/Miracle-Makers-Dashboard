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

    const users = await getUserMap();
    const footer = got.footer;
    return NextResponse.json(
      {
        ok: true,
        createdAt: footer.createdAt,
        updatedAt: footer.updatedAt,

        createdBy: createdByLabel(footer, (uid) => users.get(uid) || ""),

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

  return withGrants(() => getHandler(request, ctx));
}
