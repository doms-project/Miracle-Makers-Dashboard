import { NextResponse } from "next/server";
import { verifyInbound } from "@/lib/webhooks";
import { appendStageHistory } from "@/lib/ghl";
import { withGrants } from "@/lib/withGrants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ═══ ROUND 163 — THE STAGE RECORDER'S OWN URL ═══════════════════════════════
//
// 🔴 A SEPARATE ROUTE RATHER THAN A FIFTH BRANCH ON /api/webhooks/ghl, AND THE
// REASON IS EVIDENCE, NOT TIDINESS.
//
// The obvious design was to mark the stage workflow's payload with custom data
// and branch on it. That was tried twice, published both times, and the marker
// never arrived: GoHighLevel nests workflow custom data somewhere `body.type`
// does not reach. Branching on a field GHL controls would make this handler's
// correctness depend on a payload shape nobody has documented.
//
// ⚠️ A PATH CANNOT BE RENESTED. The handler knows what arrived because of the
// URL it arrived at, which is a fact about our own routing table.
//
// 🔴 AND THE CURRENT FAILURE IS NOT BENIGN — it is why the workflow is switched
// off until this exists. Pointed at the other endpoint, a stage change lands on
// the workflow branch and RE-RUNS applyCaseManagers:
//
//     [webhook:in] ACTED — apsi2nEorbkJVkNP71AL: +0 −0 manager(s)
//
// `+0 −0` only because the map already matches. The moment a rep's managers
// change, every stage change becomes an unrequested re-apply.
//
// ⚠️ THE NATIVE `OpportunityStageUpdate` EVENT IS NOT THIS. That needs an
// app-level webhook subscription a PIT cannot create; the other handler still
// recognises and declines it, which stays correct.
export async function POST(request: Request) {
  // The HMAC is over the exact bytes, and a consumed body cannot be re-read.
  const raw = await request.text().catch(() => "");

  if (
    !verifyInbound(
      request.headers.get("x-mm-secret"),
      request.headers.get("x-mm-signature"),
      raw,
    )
  ) {
    // Deliberately terse — see the sibling route. A rejection that explains
    // WHICH check failed is a probing aid.
    // eslint-disable-next-line no-console
    console.warn("[webhook:stage] rejected — signature/secret did not verify.");
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    /* handled as an unrecognised shape below */
  }
  const body = (parsed ?? {}) as Record<string, unknown>;

  /**
   * 🔴 EVERY EXIT IS A 202 WITH A NAMED REASON, as on the sibling route.
   * GoHighLevel retries a non-2xx and there is nothing here a retry fixes — a
   * payload we cannot act on is not a transient failure. The reason is the
   * deliverable.
   */
  const done = (why: string, recorded = false, detail?: unknown) => {
    // eslint-disable-next-line no-console
    console.log(`[webhook:stage] ${recorded ? "RECORDED" : "no record"} — ${why}`, detail ?? "");
    return NextResponse.json({ ok: true, recorded, reason: why }, { status: 202 });
  };

  /** GHL sends `location.id` on the workflow shape and `locationId` natively. */
  const payloadLocation = String(
    (body.location as { id?: unknown } | undefined)?.id ?? body.locationId ?? "",
  );
  const wantLocation = (process.env.GHL_LOCATION_ID || "").trim();
  // 🔴 TWO DEPLOYMENTS SHARE THIS CODE. A workflow pointed at the wrong URL must
  // be refused rather than quietly writing one company's history onto another's.
  if (wantLocation && payloadLocation && payloadLocation !== wantLocation)
    return done(`payload is for location ${payloadLocation}, this deployment is ${wantLocation}`);

  const oppId = String(body.id ?? body.opportunityId ?? "").trim();
  if (!oppId) {
    // ⚠️ KEY NAMES, NEVER VALUES — the same rule as the sibling route. A custom
    // field map's values are client data; its key names are account metadata,
    // and they are what identifies a misconfigured Webhook action.
    const keys = Object.keys(body);
    return done(
      `no opportunity id. ${keys.length} top-level key(s), none standard`,
      false,
      keys.slice(0, 12).map((k) => JSON.stringify(k)).join(", "),
    );
  }

  // 🔴 withGrants FILLS THE CASE-MANAGER STORE from the one custom value it
  // already reads. The managers frozen into the row come from there, so without
  // this wrapper every row would record an empty manager list — and look
  // exactly like a record nobody supervises.
  return withGrants(async () => {
    try {
      const r = await appendStageHistory(oppId);
      return done(r.why, r.recorded, r.row);
    } catch (e) {
      // ⚠️ A FAILURE HERE IS A GAP IN A LOG, NOT A BROKEN RECORD. Round 150 §3
      // already set the standard: this is a log with gaps and the KPI has to
      // tolerate them. Still a 202 — GoHighLevel retrying will not fix a field
      // that does not exist or a rate limit we are already inside.
      return done(
        `could not record ${oppId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });
}

// A GET confirms the route is deployed without sending an event — the "is this
// a stale build?" question that cost a round earlier.
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
