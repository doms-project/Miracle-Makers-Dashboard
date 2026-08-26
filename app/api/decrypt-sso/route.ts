import { NextResponse } from "next/server";
import { decryptSso, SsoError } from "@/lib/sso";

// Server-side SSO decryption endpoint. The frontend obtains the encrypted blob
// from GHL (via postMessage) and POSTs it here as { key }. We decrypt with the
// Shared Secret and return the session. The secret never leaves the server.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  // Accept a few key names to be forgiving of the client shape.
  const b = body as Record<string, unknown>;
  const blob =
    (typeof b?.key === "string" && b.key) ||
    (typeof b?.ssoKey === "string" && b.ssoKey) ||
    (typeof b?.encryptedData === "string" && b.encryptedData) ||
    "";

  try {
    const session = decryptSso(blob as string);
    // Return only the fields the UI needs; the whole object is fine too since
    // it is the viewer's own session, but keep it tidy.
    return NextResponse.json(
      {
        userId: session.userId,
        companyId: session.companyId ?? null,
        role: session.role ?? null,
        type: session.type ?? null,
        userName: session.userName ?? null,
        email: session.email ?? null,
        activeLocation: session.activeLocation ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof SsoError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: "Unexpected error decrypting SSO." },
      { status: 500 },
    );
  }
}
