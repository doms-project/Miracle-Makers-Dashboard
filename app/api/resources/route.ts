import { NextResponse } from "next/server";
import { listResources, RESOURCES_FOLDER_ID, GhlError } from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import type { ResourcesResponse, ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Resources are not case-specific — available to ALL authenticated users
// (reps + onboarding + admin), no per-record filtering. But a valid SSO session
// is still required (don't leave it open) once SSO is configured. The list is
// always fetched fresh so the signed-URL TTL is handled at display time.
export async function GET(request: Request) {
  try {
    if (ssoConfigured()) {
      const blob = request.headers.get("x-ghl-sso-key");
      if (!blob) {
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      }
      decryptSso(blob); // throws SsoError on bad/absent secret/blob
    }
    const resources = await listResources();
    const body: ResourcesResponse = {
      resources,
      folderId: RESOURCES_FOLDER_ID,
      count: resources.length,
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json(
        { error: "SSO error.", detail: e.message, status: e.status } as ApiError,
        { status: e.status },
      );
    if (e instanceof GhlError) {
      const status = e.status >= 400 && e.status < 600 ? e.status : 502;
      const detail =
        e.status === 401
          ? `${e.detail || ""} (If media specifically fails, the PIT may be missing the medias/media scope — add it to the Private Integration.)`
          : e.detail;
      return NextResponse.json(
        { error: e.message, detail, status: e.status } as ApiError,
        { status },
      );
    }
    return NextResponse.json(
      { error: "Unexpected error loading resources.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}
