import { NextResponse } from "next/server";
import { verifyInbound } from "@/lib/webhooks";
import { appendStageHistory } from "@/lib/ghl";
import { withGrants } from "@/lib/withGrants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {

  const raw = await request.text().catch(() => "");

  if (
    !verifyInbound(
      request.headers.get("x-mm-secret"),
      request.headers.get("x-mm-signature"),
      raw,
    )
  ) {

    // eslint-disable-next-line no-console
    console.warn("[webhook:stage] rejected — signature/secret did not verify.");
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {

  }
  const body = (parsed ?? {}) as Record<string, unknown>;

  const done = (why: string, recorded = false, detail?: unknown) => {
    // eslint-disable-next-line no-console
    console.log(`[webhook:stage] ${recorded ? "RECORDED" : "no record"} — ${why}`, detail ?? "");
    return NextResponse.json({ ok: true, recorded, reason: why }, { status: 202 });
  };

  const payloadLocation = String(
    (body.location as { id?: unknown } | undefined)?.id ?? body.locationId ?? "",
  );
  const wantLocation = (process.env.GHL_LOCATION_ID || "").trim();

  if (wantLocation && payloadLocation && payloadLocation !== wantLocation)
    return done(`payload is for location ${payloadLocation}, this deployment is ${wantLocation}`);

  const oppId = String(body.id ?? body.opportunityId ?? "").trim();
  if (!oppId) {

    const keys = Object.keys(body);
    return done(
      `no opportunity id. ${keys.length} top-level key(s), none standard`,
      false,
      keys.slice(0, 12).map((k) => JSON.stringify(k)).join(", "),
    );
  }

  return withGrants(async () => {
    try {
      const r = await appendStageHistory(oppId);
      return done(r.why, r.recorded, r.row);
    } catch (e) {

      return done(
        `could not record ${oppId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "/api/webhooks/ghl/stage",
    inbound:
      "verifies the secret, reads the opportunity for its stage id and owner, " +
      "and appends one row to the Stage History field. The stage comes from the " +
      "record, never from the payload's pipleline_stage, which is a name.",
  });
}
