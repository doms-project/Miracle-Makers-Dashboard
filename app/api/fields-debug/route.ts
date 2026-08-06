import { NextResponse } from "next/server";
import { getFieldDefinitions, getEditableFieldDefs, GhlError } from "@/lib/ghl";
import type { ApiError } from "@/lib/types";

// TEMPORARY diagnostic: returns the RAW GHL custom-field definitions alongside
// the normalized editable defs, so we can confirm which property holds the
// option list (options / picklistOptions / …) and the element shape.
// Returns metadata only (field names + options), never opportunity data.
// Safe to delete once editing is confirmed.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const [raw, normalized] = await Promise.all([
      getFieldDefinitions(),
      getEditableFieldDefs(),
    ]);
    return NextResponse.json(
      { count: raw.length, raw, normalized },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    const status = e instanceof GhlError ? e.status : 500;
    return NextResponse.json(
      { error: "fields-debug failed", detail: String(e) } as ApiError,
      { status },
    );
  }
}
