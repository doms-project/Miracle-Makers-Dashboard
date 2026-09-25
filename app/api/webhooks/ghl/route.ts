import { NextResponse } from "next/server";
import { verifyInbound } from "@/lib/webhooks";
import { applyCaseManagers, getContactCustomFields } from "@/lib/ghl";
import { withGrants } from "@/lib/withGrants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// INBOUND — ONE URL, THREE PAYLOAD SHAPES, ONE OF WHICH NOW ACTS.
//
// ⚠️ THIS HEADER USED TO SAY "deliberately UNWIRED · nothing acts on it". That
// was true for five rounds and is not any more; a comment describing the
// opposite of the code below it is the failure round 138 spent a round on, so
// it is rewritten rather than appended to.
//
// 🔴 WHAT IS STILL TRUE, AND IT IS THE PART WORTH KEEPING: a webhook cannot
// push to an open browser. Receiving an event server-side updates nobody's
// screen. What the case-manager path does is write to GoHighLevel — followers
// and two fields — which the next load reads back. It is not a live channel and
// must not be mistaken for one.
//
// The three shapes and the branch between them are documented at the branch.
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
    /* handled as an unrecognised shape below */
  }
  const body = (parsed ?? {}) as Record<string, unknown>;

  // ═══ THE BRANCH — ROUND 150 ═══════════════════════════════════════════════
  //
  // 🔴 THREE SHAPES ARRIVE AT THIS ONE URL AND A FOURTH WILL. Branching on the
  // payload beats guessing from whichever keys happen to be present:
  //
  //   workflow webhook   contact_id · id · pipeline_id · pipleline_stage ·
  //                      user{} · owner · location{} · workflow{}    NO `type`
  //   native event       type: "OpportunityStageUpdate" · locationId ·
  //                      assignedTo · contactId · pipelineStageId
  //   field-name map     a flat map of custom-field display names to ""
  //                      — no standard key at all
  //
  // ⚠️ AND A STAGE-HISTORY RECORDER IS COMING BUT IS NOT BUILT. GoHighLevel has
  // no history endpoint — `lastStageChangeAt` is one value, not a log — so the
  // "two stages a month per case manager" KPI needs something to write down
  // every transition. That path arrives HERE, and this branch is what keeps the
  // two from being tangled when it does.
  const type = String(body.type ?? "");
  /** GHL sends `location.id` on the workflow shape and `locationId` natively. */
  const payloadLocation = String(
    (body.location as { id?: unknown } | undefined)?.id ?? body.locationId ?? "",
  );
  const wantLocation = (process.env.GHL_LOCATION_ID || "").trim();

  /**
   * 🔴 EVERY EXIT IS A 202 WITH A NAMED REASON. GoHighLevel retries a non-2xx,
   * and there is nothing here a retry would fix — a payload we cannot act on is
   * not a transient failure. The reason is the deliverable: silent acceptance
   * would mean a second payload shape arriving for ever with nobody knowing.
   */
  const done = (reason: string, acted = false, detail?: unknown) => {
    // eslint-disable-next-line no-console
    console.log(`[webhook:in] ${acted ? "ACTED" : "no action"} — ${reason}`, detail ?? "");
    return NextResponse.json({ ok: true, acted, reason }, { status: 202 });
  };

  // ── 1 · THE WRONG ACCOUNT ────────────────────────────────────────────────
  // 🔴 TWO DEPLOYMENTS SHARE THIS CODE. A Webhook action pointed at the wrong
  // URL must be refused rather than quietly acted on — it would add one
  // company's case managers to another company's record.
  if (wantLocation && payloadLocation && payloadLocation !== wantLocation)
    return done(`payload is for location ${payloadLocation}, this deployment is ${wantLocation}`);

  // ── 2 · THE NATIVE STAGE EVENT — RECOGNISED, NOT ACTED ON ────────────────
  if (type === "OpportunityStageUpdate")
    return done(
      "OpportunityStageUpdate — recognised, and stage history is not recorded yet. " +
        "Nothing writes transitions; lastStageChangeAt is a single value, not a log.",
    );

  // ── 3 · THE WORKFLOW SHAPE — THE CASE-MANAGER PATH ───────────────────────
  const contactId = String(body.contact_id ?? body.contactId ?? "").trim();
  const oppId = String(body.id ?? "").trim();
  if (!contactId) {
    // ⚠️ KEY NAMES, NEVER VALUES. A custom-field map's values are client data;
    // its key names are account metadata, and they are what identifies which
    // Webhook action is misconfigured. The existing 1000-character body slice
    // is what truncated the fourth payload out of usefulness — this is smaller
    // and answers the question the next time it fires, with no re-fire.
    const keys = Object.keys(body);
    return done(
      `no contact_id. ${keys.length} top-level key(s), none standard`,
      false,
      keys.slice(0, 12).map((k) => JSON.stringify(k)).join(", "),
    );
  }
  if (!oppId) return done(`contact ${contactId} but no opportunity id in the payload`);

  // 🔴 withGrants FILLS THE CASE-MANAGER STORE from the one custom value it
  // already reads. applyCaseManagers reads it through AsyncLocalStorage, so
  // without this wrapper the map is empty and the rule is inert — which would
  // look exactly like "no managers configured".
  return withGrants(async () => {
    let ownerId = "";
    try {
      // ⚠️ THE CONTACT, NOT THE OPPORTUNITY — see ContactFieldsRead.assignedTo.
      ownerId = (await getContactCustomFields(contactId)).assignedTo;
    } catch (e) {
      return done(
        `could not read contact ${contactId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!ownerId)
      return done(`contact ${contactId} has no owner, so there is no rep to map`);

    // ⚠️ NO PIPELINE TEST HERE. Round 149 made applyCaseManagers refuse a
    // non-client pipeline itself, and a second copy of that test would be a
    // second thing to keep in step. The cost is one contact GET before a
    // caregiver-pipeline event is declined, which is the right trade.
    const r = await applyCaseManagers(oppId, ownerId);
    return done(
      r.skipped
        ? `nothing to do for ${oppId}: ${r.why}`
        : `${oppId}: +${r.added.length} −${r.removed.length} manager(s)`,
      !r.skipped,
      r.steps.join(" · "),
    );
  });
}

// A GET makes it possible to confirm the route is deployed without sending an
// event — the "is this a stale build?" question that cost a round earlier.
export async function GET() {
  return NextResponse.json({
    ok: true,
    route: "/api/webhooks/ghl",
    inbound:
      "verifies the secret, then branches: OpportunityStageUpdate is recognised " +
      "and not recorded; a workflow payload with contact_id applies case " +
      "managers; anything else is 202'd with its top-level key names logged.",
  });
}
