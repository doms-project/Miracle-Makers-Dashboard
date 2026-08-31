import { NextResponse } from "next/server";
import { deleteMediaFile, explainGhlError, GhlError } from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ITEM 11 — delete ONE file from a resources folder.
//
// Folders could already be deleted and the files inside them could not, so the
// only way to remove a single document was to delete its whole folder.
//
// ADMIN ONLY, gated HERE. Hiding the button is convenience; this is the
// boundary and it holds against a direct DELETE.
export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    if (ssoConfigured()) {
      const blob =
        url.searchParams.get("ssoKey") || request.headers.get("x-ghl-sso-key");
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      const s = decryptSso(blob);
      if (!isAdminSession(s.role, s.type))
        return NextResponse.json(
          {
            error: "Admin only.",
            detail: "Only an admin can delete resource files.",
            status: 403,
          } as ApiError,
          { status: 403 },
        );
    }

    const id = (url.searchParams.get("id") || "").trim();
    if (!id)
      return NextResponse.json(
        { error: "Which file?", status: 400 } as ApiError,
        { status: 400 },
      );

    await deleteMediaFile(id);
    // eslint-disable-next-line no-console
    console.warn(`[resources] file ${id} deleted.`);
    return NextResponse.json(
      { ok: true, deleted: true },
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
        { error: "Couldn't delete the file.", detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Couldn't delete the file.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}
