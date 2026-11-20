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
      decryptSso(blob);
    }

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
