import { NextResponse } from "next/server";
import {
  upsertContact,
  createOpportunity,
  getSelectedPipelines,
  getLocationUserIds,
  listContactOpportunities,
  getFieldDefinitions,
  divisionCustomField,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import { getUserHomePipelines } from "@/lib/pipelineAccess";
import type { ApiError, NewClientPayload } from "@/lib/types";
import { withGrants } from "@/lib/withGrants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Optional extra detail fields, resolved by NAME so no ids are hardcoded.
const DETAIL_FIELDS: { key: keyof NewClientPayload; name: string }[] = [
  { key: "office", name: "Office" },
  { key: "county", name: "County" },
  { key: "referralSource", name: "Referral Source Type" },
];

// ITEM 3 — Add Client. POST creates the contact and its case.
//
// 🔴 THE SERVER IS THE BOUNDARY, not the modal. Two rules are enforced here and
// would hold even if someone POSTed this route directly with curl:
//
//   1. PIPELINE — a rep may only create into one of their OWN home pipelines.
//      An admin may use any selected pipeline.
//   2. OWNER — a rep is FORCED as the owner of what they create; a client-sent
//      `assignedTo` is ignored for them. Only an admin may set someone else.
//
// Rule 2 is not just about permission. Forcing the creator as owner means every
// handover goes through Move, which writes a note and stamps the transfer
// fields. Creation stays clean and the audit trail survives.
async function postHandler(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as NewClientPayload & {
      ssoKey?: string;
    };
    const blob = body.ssoKey || request.headers.get("x-ghl-sso-key");

    const enforce = ssoConfigured();
    let session: { userId: string; role?: string; type?: string } | null = null;
    if (enforce) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      const s = decryptSso(blob);
      session = { userId: s.userId, role: s.role, type: s.type };
    }
    const isAdmin = !session || isAdminSession(session.role, session.type);

    // ---- validate the shape -------------------------------------------------
    const firstName = (body.firstName || "").trim();
    const lastName = (body.lastName || "").trim();
    const email = (body.email || "").trim();
    const phone = (body.phone || "").trim();
    if (!firstName || !lastName)
      return NextResponse.json(
        { error: "First and last name are required.", status: 400 } as ApiError,
        { status: 400 },
      );
    if (!body.pipelineId)
      return NextResponse.json(
        { error: "Pick a pipeline.", status: 400 } as ApiError,
        { status: 400 },
      );

    const pipelines = await getSelectedPipelines();
    const dest = pipelines.find((p) => p.id === body.pipelineId);
    if (!dest)
      return NextResponse.json(
        {
          error: "That pipeline is not available.",
          detail: `${body.pipelineId} is not one of the configured pipelines.`,
          status: 400,
        } as ApiError,
        { status: 400 },
      );

    // ---- RULE 1: pipeline scope --------------------------------------------
    if (session && !isAdmin) {
      const home = getUserHomePipelines(session.userId);
      if (!home.has(dest.id))
        return NextResponse.json(
          {
            error: "Not permitted.",
            detail: `You don't have access to "${dest.name}". You can only create cases in your own division's pipelines.`,
            status: 403,
          } as ApiError,
          { status: 403 },
        );
    }

    // ---- RULE 2: owner ------------------------------------------------------
    let assignedTo = "";
    if (session && !isAdmin) {
      assignedTo = session.userId; // forced; a client-sent value is ignored
    } else if (body.assignedTo) {
      const validUsers = await getLocationUserIds();
      // Same empty-list trap as Move: an unavailable users lookup must not be
      // read as "this user doesn't exist".
      if (validUsers.size && !validUsers.has(body.assignedTo))
        return NextResponse.json(
          {
            error: "That owner is not a user of this location.",
            status: 400,
          } as ApiError,
          { status: 400 },
        );
      assignedTo = body.assignedTo;
    } else if (session) {
      assignedTo = session.userId;
    }

    // ---- stage --------------------------------------------------------------
    let stageId = (body.stageId || "").trim();
    if (stageId && !(dest.stages || []).some((s) => s.id === stageId))
      return NextResponse.json(
        {
          error: "That stage does not belong to the chosen pipeline.",
          status: 400,
        } as ApiError,
        { status: 400 },
      );
    if (!stageId) {
      const uncategorized = (dest.stages || []).find(
        (s) => norm(s.name) === "uncategorized",
      );
      stageId = uncategorized?.id || (dest.stages || [])[0]?.id || "";
    }
    if (!stageId)
      return NextResponse.json(
        { error: `"${dest.name}" has no stages.`, status: 400 } as ApiError,
        { status: 400 },
      );

    // ---- contact: reuse the one they picked, or upsert ----------------------
    // upsertContact dedupes on email/phone at GHL, so the modal's "already
    // exists" prompt is a courtesy — this is correct either way.
    let contactId = (body.contactId || "").trim();
    if (!contactId) {
      const c = await upsertContact({
        firstName,
        lastName,
        name: `${firstName} ${lastName}`.trim(),
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        source: "Dashboard — Add Client",
      });
      contactId = c.id;
    }
    if (!contactId)
      return NextResponse.json(
        {
          error: "Could not create the client contact.",
          detail: "GoHighLevel returned no contact id.",
          status: 502,
        } as ApiError,
        { status: 502 },
      );

    // ---- the duplicate rule, checked BEFORE the write ----------------------
    // GHL allows one opportunity per contact per pipeline. The modal greys these
    // out, but a direct POST has to be caught here too — and a pre-check gives a
    // sentence you can act on instead of OPPORTUNITY_NO_DUPLICATE.
    const existing = await listContactOpportunities(contactId);
    const clash = existing.find((o) => o.pipelineId === dest.id);
    if (clash)
      return NextResponse.json(
        {
          error: "This client already has a case here.",
          detail: `${firstName} ${lastName} already has a case in "${dest.name}"${clash.stage ? ` (${clash.stage})` : ""}. GoHighLevel allows only one case per client per pipeline — open that one, or pick a different pipeline.`,
          status: 409,
        } as ApiError,
        { status: 409 },
      );

    // ---- custom fields: Division from the pipeline, plus any detail fields ---
    const customFields = [...(await divisionCustomField(dest.name))];
    const defs = await getFieldDefinitions();
    for (const { key, name } of DETAIL_FIELDS) {
      const value = String(body[key] ?? "").trim();
      if (!value) continue;
      const def = defs.find((d) => norm(d.name || "") === norm(name));
      if (def) customFields.push({ id: def.id, value });
    }

    // ---- create -------------------------------------------------------------
    // GHL links contact <-> opportunity natively via contactId. No extra call.
    const oppId = await createOpportunity({
      pipelineId: dest.id,
      stageId,
      contactId,
      // Default the case name to the client's name. Free text like "samole lang
      // ni" is exactly what made two different cases look identical earlier.
      name: (body.oppName || "").trim() || `${firstName} ${lastName}`.trim(),
      ...(assignedTo ? { assignedTo } : {}),
      source: "Dashboard — Add Client",
      ...(customFields.length ? { customFields } : {}),
    });

    if (!oppId)
      return NextResponse.json(
        {
          error: "The case was not created.",
          detail:
            "The client contact exists, but GoHighLevel returned no opportunity id. Check the pipeline in GoHighLevel before retrying, so you don't create a second contact.",
          status: 502,
        } as ApiError,
        { status: 502 },
      );

    return NextResponse.json(
      { ok: true, opportunityId: oppId, contactId },
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
        { error: "Could not add the client.", detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Could not add the client.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return withGrants(() => postHandler(request));
}
