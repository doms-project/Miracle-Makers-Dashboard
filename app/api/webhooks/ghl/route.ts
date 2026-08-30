import { NextResponse } from "next/server";
import { verifyInbound } from "@/lib/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ITEM 5 — INBOUND, deliberately UNWIRED.
//
// The route exists, validates the shared secret, logs what arrived and no-ops.
// Nothing acts on it, and that is the point:
//
// 🔴 A WEBHOOK CANNOT PUSH TO AN OPEN BROWSER. Receiving an event server-side
// does not update anyone's screen. Acting on inbound needs polling, SSE or
// websockets held open per viewer — a materially bigger change than it sounds,
// with its own reconnect, auth and cost questions. Refresh-on-focus (item 4)
// covers the realistic case: someone switches back to the tab and sees current
// data. Building the transport before there is a confirmed need would be
// speculative work that has to be maintained regardless of whether it is used.
//
// So this is the handshake half only — enough for GHL or Make to be pointed at
// a real URL and get a 200, and enough to prove the secret works, without
// pretending the dashboard reacts.
export async function POST(request: Request) {
  // Read the body ONCE as text: the HMAC is over the exact bytes, and
  // re-reading a consumed body throws.
  const raw = await request.text().catch(() => "");

  if (
    !verifyInbound(
      request.headers.get("x-mm-secret"),
      request.headers.get("x-mm-signature"),
      raw,
    )
  ) {
    // Deliberately terse. A rejection message that explains WHY (bad signature
    // vs missing secret vs none configured) is a probing aid.
    // eslint-disable-next-line no-console
    console.warn("[webhook:in] rejected — signature/secret did not verify.");
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    /* logged as raw below */
  }
  // eslint-disable-next-line no-console
  console.log(
    "[webhook:in] accepted (no action taken):",
    JSON.stringify(parsed ?? raw).slice(0, 1000),
  );

  // 202: received and understood, nothing acted on. A 200 would imply the
  // dashboard did something with it.
  return NextResponse.json(
    { ok: true, acted: false, note: "Received. Inbound handling is not wired up." },
    { status: 202 },
  );
}

// A GET makes it possible to confirm the route is deployed without sending an
// event — the "is this a stale build?" question that cost a round earlier.
export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "/api/webhooks/ghl",
    inbound: "stubbed — validates the secret, takes no action",
  });
}
