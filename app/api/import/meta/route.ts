import { NextResponse } from "next/server";
import { listPipelines, getEditableFieldDefs, GhlError } from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import type { ImportMeta, ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Admin-only. Returns ALL pipelines (+ their stages) and the opportunity custom
// field definitions, so the import wizard's destination + mapping dropdowns are
// fully dynamic — no pipeline/stage/field is hardcoded.
export async function GET(request: Request) {
  try {
    if (ssoConfigured()) {
      const blob = request.headers.get("x-ghl-sso-key");
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      const s = decryptSso(blob);
      if (!isAdminSession(s.role, s.type))
        return NextResponse.json(
          { error: "Admin only.", status: 403 } as ApiError,
          { status: 403 },
        );
    }
    const [pipelines, fieldDefs] = await Promise.all([
      listPipelines(),
      getEditableFieldDefs(),
    ]);
    const body: ImportMeta = { pipelines, fieldDefs };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json({ error: e.message, status: e.status } as ApiError, { status: e.status });
    if (e instanceof GhlError)
      return NextResponse.json({ error: e.message, detail: e.detail } as ApiError, { status: e.status >= 400 ? e.status : 502 });
    return NextResponse.json({ error: "Failed to load import metadata.", detail: String(e) } as ApiError, { status: 500 });
  }
}
