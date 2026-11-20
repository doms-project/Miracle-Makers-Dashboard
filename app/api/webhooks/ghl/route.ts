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
    console.warn("[webhook:in] rejected — signature/secret did not verify.");
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {

  }
  const body = (parsed ?? {}) as Record<string, unknown>;

  const type = String(body.type ?? "");

  const payloadLocation = String(
    (body.location as { id?: unknown } | undefined)?.id ?? body.locationId ?? "",
  );
  const wantLocation = (process.env.GHL_LOCATION_ID || "").trim();

  const done = (reason: string, acted = false, detail?: unknown) => {
    // eslint-disable-next-line no-console
    console.log(`[webhook:in] ${acted ? "ACTED" : "no action"} — ${reason}`, detail ?? "");
    return NextResponse.json({ ok: true, acted, reason }, { status: 202 });
  };

  if (wantLocation && payloadLocation && payloadLocation !== wantLocation)
    return done(`payload is for location ${payloadLocation}, this deployment is ${wantLocation}`);

  if (type === "OpportunityStageUpdate")
    return done(
      "OpportunityStageUpdate — recognised, and stage history is not recorded yet. " +
        "Nothing writes transitions; lastStageChangeAt is a single value, not a log.",
    );

  const setOwner = new URL(request.url).searchParams.get("setOwner") === "1";

  const contactId = String(body.contact_id ?? body.contactId ?? "").trim();
  const oppId = String(body.id ?? "").trim();
  const pipelineId = String(body.pipeline_id ?? body.pipelineId ?? "").trim();

  // eslint-disable-next-line no-console
  console.log(
    `[webhook:in] shape — keys: ${Object.keys(body).join(",")} · ` +
      `setOwner=${setOwner} · has id=${!!oppId} · has pipeline_id=${!!pipelineId}`,
  );
  if (!contactId) {

    const keys = Object.keys(body);
    return done(
      `no contact_id. ${keys.length} top-level key(s), none standard`,
      false,
      keys.slice(0, 12).map((k) => JSON.stringify(k)).join(", "),
    );
  }
  if (!oppId && !pipelineId)
    return done(`contact ${contactId} but neither an id nor a pipeline_id to find a case with`);

  return withGrants(async () => {
    let contactOwner = "";
    try {

      contactOwner = (await getContactCustomFields(contactId)).assignedTo;
    } catch (e) {
      return done(
        `could not read contact ${contactId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    let idIsOpp = false;
    if (oppId) {

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

    if (!resolved.ok) return done(`cannot identify the case — ${resolved.why}`);
    const caseId = resolved.id;
    const via = resolved.how === "payload-id" ? "" : ` (found by newest in pipeline)`;

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

        return done(
          `setOwner refused: ${await explainGhlError(e)} The case ${caseId} is unchanged.`,
        );
      }

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

      invalidateOpportunity(caseId);
      const rec = await getOpportunityById(caseId).catch(() => null);
      ownerId = rec?.ownerId || "";
      if (ownerId) ownerNote = `case owner ${await nameOf(ownerId)}`;
      else if (contactOwner) {

        ownerId = contactOwner;
        ownerNote = `case had no owner, using the contact's (${await nameOf(ownerId)})`;
      }
    }
    if (!ownerId)
      return done(`${caseId}${via}: neither the case nor the contact has an owner, so there is no rep to map`);

    const r = await applyCaseManagers(caseId, ownerId);

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
