import { NextResponse } from "next/server";
import { verifyInbound } from "@/lib/webhooks";
import {
  applyCaseManagers,
  getContactCustomFields,
  getOpportunityById,
  invalidateOpportunity,
  listContactOpportunities,
  setOpportunityOwner,
  getUserMap,
  explainGhlError,
} from "@/lib/ghl";
import { withGrants } from "@/lib/withGrants";
import { resolveCase, RECENT_CASE_MS } from "@/lib/webhookCase";

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

  // ── 3 · THE WORKFLOW SHAPE — OWNER, THEN CASE MANAGERS ───────────────────
  //
  // ═══ ROUND 175 · ONE OWNER PER CASE ══════════════════════════════════════
  //
  // 🔴 `?setOwner=1` IS OPT-IN PER WEBHOOK STEP, AND THAT IS THE DESIGN. Only a
  // step that FOLLOWS an `Assign to user` step knows the contact's owner is the
  // person the rotation just picked. On every other step the contact's owner is
  // whatever it happened to be — on a family in two divisions that is the OTHER
  // division's rep — so copying it onto this case would be the round-174 bug
  // with a new cause.
  //
  // ⚠️ WITHOUT THE FLAG THIS ROUTE NEVER CHANGES AN OWNER. Not "usually does
  // not": there is no other path to the write.
  const setOwner = new URL(request.url).searchParams.get("setOwner") === "1";

  const contactId = String(body.contact_id ?? body.contactId ?? "").trim();
  const oppId = String(body.id ?? "").trim();
  const pipelineId = String(body.pipeline_id ?? body.pipelineId ?? "").trim();
  // 🔴 THE SHAPE, LOGGED ON EVERY REQUEST. The owner asked which payload shape
  // each workflow actually sends; only their live logs can answer that, and
  // this is the line that answers it. Key NAMES, never values — a workflow
  // payload's values are client data.
  // eslint-disable-next-line no-console
  console.log(
    `[webhook:in] shape — keys: ${Object.keys(body).join(",")} · ` +
      `setOwner=${setOwner} · has id=${!!oppId} · has pipeline_id=${!!pipelineId}`,
  );
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
  if (!oppId && !pipelineId)
    return done(`contact ${contactId} but neither an id nor a pipeline_id to find a case with`);

  // 🔴 withGrants FILLS THE CASE-MANAGER STORE from the one custom value it
  // already reads. applyCaseManagers reads it through AsyncLocalStorage, so
  // without this wrapper the map is empty and the rule is inert — which would
  // look exactly like "no managers configured".
  return withGrants(async () => {
    let contactOwner = "";
    try {
      // ⚠️ THE CONTACT'S OWNER — with `setOwner` this is the person the rotation
      // just picked, and that is the ONLY thing it is read for here.
      contactOwner = (await getContactCustomFields(contactId)).assignedTo;
    } catch (e) {
      return done(
        `could not read contact ${contactId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // ── 3a · WHICH CASE? ──────────────────────────────────────────────────
    //
    // 🔴 THE PAYLOAD'S `id` IS CHECKED, NOT ASSUMED. CAREGIVER APPLICATION
    // ROUTING is triggered by an inbound application and creates the case
    // inside the workflow, so its `id` may be the CONTACT. See lib/webhookCase.ts.
    let idIsOpp = false;
    if (oppId) {
      // ⚠️ UNCACHED. A burst entry from another request in the same instance
      // would answer a question about a different moment.
      invalidateOpportunity(oppId);
      try {
        idIsOpp = !!(await getOpportunityById(oppId));
      } catch {
        idIsOpp = false;
      }
    }
    let cases: { id: string; pipelineId: string; createdAt?: string }[] = [];
    if (!idIsOpp) {
      try {
        cases = (await listContactOpportunities(contactId)).map((o) => ({
          id: o.id,
          pipelineId: o.pipelineId,
          createdAt: o.createdAt,
        }));
      } catch {
        cases = [];
      }
    }
    const resolved = resolveCase(oppId, idIsOpp, pipelineId, cases, Date.now());
    // 🔴 UNRESOLVED MEANS CHANGE NOTHING AND SAY SO. A webhook that guesses
    // which of a family's two cases it meant is the defect this round exists
    // to close, arrived at from the other side.
    if (!resolved.ok) return done(`cannot identify the case — ${resolved.why}`);
    const caseId = resolved.id;
    const via = resolved.how === "payload-id" ? "" : ` (found by newest in pipeline)`;

    // ── 3b · THE OWNER ────────────────────────────────────────────────────
    const nameOf = async (id: string): Promise<string> => {
      if (!id) return "nobody";
      try {
        return (await getUserMap()).get(id) || id;
      } catch {
        return id;
      }
    };

    let ownerId = "";
    let ownerNote = "";
    if (setOwner) {
      if (!contactOwner)
        return done(
          `setOwner asked for, but contact ${contactId} has no owner to copy — ` +
            "the Assign to user step before this one did not set one. Nothing changed.",
        );
      try {
        await setOpportunityOwner(caseId, contactOwner);
      } catch (e) {
        // 🔴 ROUND 151'S REFUSAL, AND IT IS EXPECTED RATHER THAN EXCEPTIONAL.
        // GoHighLevel rejects an opportunity-owner write when that user has no
        // access to the pipeline — an OLTL rep picked by rotation for an ODP DSP
        // applicant. `explainGhlError` already resolves that 400 to the person's
        // name and the pipeline's name.
        //
        // ⚠️ AND IT IS NEVER RETRIED. A permission grant is not transient, and a
        // loop against a 100-per-10-second budget is how round 152 produced
        // 13,851 timeouts.
        return done(
          `setOwner refused: ${await explainGhlError(e)} The case ${caseId} is unchanged.`,
        );
      }
      // 🔴 READ BACK UNCACHED. `setOpportunityOwner` invalidates, so this is a
      // read of GoHighLevel. A 200 is not a success — round 151 found this exact
      // endpoint accepting a write it did not store.
      const after = await getOpportunityById(caseId).catch(() => null);
      if (!after || after.ownerId !== contactOwner)
        return done(
          `🔴 ${caseId}: owner write accepted and NOT stored — asked for ` +
            `${await nameOf(contactOwner)}, the record says ` +
            `${after ? await nameOf(after.ownerId) : "unreadable"}. No managers applied.`,
        );
      ownerId = contactOwner;
      ownerNote = `owner set to ${await nameOf(ownerId)} from the rotation`;
    } else {
      // 🔴 THE CASE'S OWN OWNER, READ UNCACHED — line 125's bug, which put
      // Ern's OLTL case managers on ODP case KkYzrHKSkodCNmLH3C2D because it
      // read the CONTACT's owner. With one owner per case the contact's owner is
      // the other division's rep as often as not.
      invalidateOpportunity(caseId);
      const rec = await getOpportunityById(caseId).catch(() => null);
      ownerId = rec?.ownerId || "";
      if (ownerId) ownerNote = `case owner ${await nameOf(ownerId)}`;
      else if (contactOwner) {
        // ⚠️ THE FALLBACK, AND ONLY WHEN THE CASE HAS NO OWNER AT ALL. A case
        // created before the owner write lands legitimately has none.
        ownerId = contactOwner;
        ownerNote = `case had no owner, using the contact's (${await nameOf(ownerId)})`;
      }
    }
    if (!ownerId)
      return done(`${caseId}${via}: neither the case nor the contact has an owner, so there is no rep to map`);

    // ── 3c · CASE MANAGERS, FOR THAT OWNER ────────────────────────────────
    // ⚠️ NO PIPELINE TEST HERE. Round 149 made applyCaseManagers refuse a
    // non-client pipeline itself, and a second copy of that test would be a
    // second thing to keep in step. Applicant cases therefore get their owner
    // set and nothing more, which is exactly what this round asked for.
    const r = await applyCaseManagers(caseId, ownerId);

    // 🔴 ROUND 151 — `acted` MUST NOT BE TRUE ON A READ-BACK MISMATCH. This
    // line printed `ACTED — +2 manager(s)` while GoHighLevel had stored none of
    // them: `added` is what we ASKED for, and it is non-empty whether or not
    // the write landed. The read-back knew; it just had no way to say so until
    // `mismatch` was added to the result.
    if (r.mismatch)
      return done(
        `🔴 ${caseId}${via}: ${ownerNote} · NOT applied — GoHighLevel accepted the write and the record disagrees. ` +
          `${r.mismatch.missing.length} manager(s) are not following` +
          (r.mismatch.lingering.length
            ? `, ${r.mismatch.lingering.length} removal(s) did not take`
            : "") +
          ". Check whether this record's pipeline is shared with selected users only.",
        false,
        r.steps.join(" · "),
      );

    // 🔴 THE REASON ALWAYS SAYS WHAT HAPPENED. "no action" on a request that
    // DID set an owner would be a lie by omission — so `acted` is true whenever
    // either half wrote, and the sentence names both halves.
    const wrote = setOwner || !r.skipped;
    return done(
      r.skipped
        ? `${caseId}${via}: ${ownerNote} · nothing to do for managers: ${r.why}`
        : `${caseId}${via}: ${ownerNote} · +${r.added.length} −${r.removed.length} manager(s)`,
      wrote,
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
      "managers for the CASE's own owner, and with ?setOwner=1 first copies the " +
      "contact's owner onto the case (for a step that follows Assign to user); " +
      "anything else is 202'd with its top-level key names logged.",
  });
}
