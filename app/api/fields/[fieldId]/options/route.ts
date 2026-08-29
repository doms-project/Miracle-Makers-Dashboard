import { NextResponse } from "next/server";
import { addFieldOption, explainGhlError, GhlError } from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ITEM 4 — add a name to a custom field's picklist. POST { ssoKey?, option }
//
// 🔴 ADMIN ONLY, enforced HERE. Hiding the "+ Add name…" row from reps is
// convenience; this check is the boundary. Adding an option edits a LOCATION
// -level object that every record and every GHL workflow reads, so it is a very
// different act from picking one — which stays open to anyone who can edit the
// record.
async function postHandler(
  request: Request,
  ctx: { params: Promise<{ fieldId: string }> },
) {
  try {
    const { fieldId } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      option?: string;
    };
    const blob = body.ssoKey || request.headers.get("x-ghl-sso-key");

    if (ssoConfigured()) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      const s = decryptSso(blob);
      if (!isAdminSession(s.role, s.type))
        return NextResponse.json(
          {
            error: "Not permitted.",
            detail:
              "Only an admin can add a name to a field's list. Anyone who can edit the record may choose from it.",
            status: 403,
          } as ApiError,
          { status: 403 },
        );
    }

    const option = (body.option || "").trim();
    if (!option)
      return NextResponse.json(
        { error: "Type the name to add.", status: 400 } as ApiError,
        { status: 400 },
      );
    if (option.length > 100)
      return NextResponse.json(
        { error: "That name is too long.", status: 400 } as ApiError,
        { status: 400 },
      );

    const options = await addFieldOption(fieldId, option);
    return NextResponse.json(
      { ok: true, options },
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
        { error: "Could not add the name.", detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Could not add the name.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ fieldId: string }> },
) {
  return postHandler(request, ctx);
}
