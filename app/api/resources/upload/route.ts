import { NextResponse } from "next/server";
import { uploadResource, GhlError } from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Vercel serverless functions reject request bodies larger than ~4.5 MB. We cap
// below that so uploads fail fast with a clear message instead of a platform
// 413. Bump MAX_UPLOAD_MB only if the deployment target allows larger bodies.
const MAX_UPLOAD_MB = 4;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

// Admin-only. Reps must not be able to call this even though the button is
// hidden for them — the gate is here, server-side.
export async function POST(request: Request) {
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

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string")
      return NextResponse.json(
        { error: "No file provided." } as ApiError,
        { status: 400 },
      );

    if (file.size === 0)
      return NextResponse.json(
        { error: "File is empty." } as ApiError,
        { status: 400 },
      );
    if (file.size > MAX_UPLOAD_BYTES)
      return NextResponse.json(
        {
          error: `File too large. Max ${MAX_UPLOAD_MB} MB (Vercel serverless body limit). Split the file or upload directly in GoHighLevel.`,
        } as ApiError,
        { status: 413 },
      );

    const buffer = await file.arrayBuffer();
    const result = await uploadResource({
      buffer,
      filename: file.name || "upload",
      contentType: file.type || "application/octet-stream",
    });

    return NextResponse.json(
      { ok: true, file: result },
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
      { error: "Upload failed.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}
