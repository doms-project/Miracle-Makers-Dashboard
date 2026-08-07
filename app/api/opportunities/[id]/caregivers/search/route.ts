import { NextResponse } from "next/server";
import {
  getOpportunityById,
  searchCaregiverContacts,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canEditRecord } from "@/lib/visibility";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Typeahead for the add-caregiver picker. Same visibility gate as managing the
// record (own/follow, or admin). Filters to Record Type = "Caregiver".
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";
    const blob = request.headers.get("x-ghl-sso-key");

    const enforce = ssoConfigured();
    if (enforce) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      const s = decryptSso(blob);
      const target = await getOpportunityById(id);
      if (!target)
        return NextResponse.json(
          { error: "Opportunity not found." } as ApiError,
          { status: 404 },
        );
      if (!canEditRecord(target, { userId: s.userId, role: s.role, type: s.type }))
        return NextResponse.json(
          { error: "Not permitted.", status: 403 } as ApiError,
          { status: 403 },
        );
    }

    const results = q.trim() ? await searchCaregiverContacts(q) : [];
    return NextResponse.json(
      { results },
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
        { error: e.message, detail: e.detail } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Search failed.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}
