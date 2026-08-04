import { NextResponse } from "next/server";
import { getOltlOpportunities, GhlError } from "@/lib/ghl";
import type { OpportunitiesResponse, ApiError } from "@/lib/types";

// Always run this route dynamically on the server — never statically cached at
// build time, and the GHL token is only ever read here (never sent to the browser).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { records, pipeline } = await getOltlOpportunities();
    const body: OpportunitiesResponse = {
      records,
      pipeline,
      count: records.length,
    };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    if (e instanceof GhlError) {
      const body: ApiError = {
        error: e.message,
        detail: e.detail,
        status: e.status,
      };
      // Map upstream auth/rate errors to sensible statuses; default to 502.
      const status =
        e.status >= 400 && e.status < 600 ? e.status : 502;
      return NextResponse.json(body, { status });
    }
    const body: ApiError = {
      error: "Unexpected server error while loading opportunities.",
      detail: e instanceof Error ? e.message : String(e),
    };
    return NextResponse.json(body, { status: 500 });
  }
}
