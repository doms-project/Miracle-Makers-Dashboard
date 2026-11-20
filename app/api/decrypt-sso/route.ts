import { NextResponse } from "next/server";
import { decryptSso, SsoError } from "@/lib/sso";
import { ssoProbeEnabled, ssoProbeLine } from "@/lib/ssoProbe";

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

  const b = body as Record<string, unknown>;
  const blob =
    (typeof b?.key === "string" && b.key) ||
    (typeof b?.ssoKey === "string" && b.ssoKey) ||
    (typeof b?.encryptedData === "string" && b.encryptedData) ||
    "";

  try {
    const session = decryptSso(blob as string);

    if (ssoProbeEnabled()) {
      // eslint-disable-next-line no-console
      console.log(ssoProbeLine(session));
    }

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
