import { NextResponse } from "next/server";
import { listPipelines, getEditableFieldDefs, getLocationTags, GhlError } from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import type { ImportMeta, ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

    const [pipelines, fieldDefs, contactFieldDefs, tags] = await Promise.all([
      listPipelines(),
      getEditableFieldDefs("opportunity"),
      getEditableFieldDefs("contact"),

      getLocationTags().catch(() => [] as string[]),
    ]);
    const body: ImportMeta = { pipelines, fieldDefs, contactFieldDefs, tags };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json({ error: e.message, status: e.status } as ApiError, { status: e.status });
    if (e instanceof GhlError)
      return NextResponse.json({ error: e.message, detail: e.detail } as ApiError, { status: e.status >= 400 ? e.status : 502 });
    return NextResponse.json({ error: "Failed to load import metadata.", detail: String(e) } as ApiError, { status: 500 });
  }
}
