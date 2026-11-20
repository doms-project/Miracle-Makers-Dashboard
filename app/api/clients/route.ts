import { NextResponse } from "next/server";
import {
  entryStage,
  upsertContact,
  createOpportunity,
  getSelectedPipelines,
  getLocationUserIds,
  listContactOpportunities,
  getEditableFieldDefs,
  divisionCustomField,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import { getUserHomePipelines } from "@/lib/pipelineAccess";
import { checkExistingPerson, createPersonOrConflict } from "@/lib/existingPerson";
import type { ApiError, NewClientPayload } from "@/lib/types";
import { withGrants } from "@/lib/withGrants";
import { emit } from "@/lib/webhooks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function coerceDetail(
  def: { dataType?: string; options: string[] },
  value: unknown,
): { value: unknown; rejected: string[] } {
  const t = String(def.dataType || "").toUpperCase();
  const opts = def.options || [];
  const match = (v: string): string | null =>
    opts.find((o) => norm(o) === norm(v)) ?? null;

  if (t === "MULTIPLE_OPTIONS" || t === "CHECKBOX") {
    const list = Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
    const kept: string[] = [];
    const rejected: string[] = [];
    for (const v of list) {
      const m = opts.length ? match(v) : v;
      if (m) kept.push(m);
      else rejected.push(v);
    }
    return { value: kept, rejected };
  }

  const v = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
  if (!v.trim()) return { value: "", rejected: [] };
  if (t === "SINGLE_OPTIONS" && opts.length) {
    const m = match(v);
    return m ? { value: m, rejected: [] } : { value: "", rejected: [v] };
  }
  return { value: v.trim(), rejected: [] };
}

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

    const firstName = (body.firstName || "").trim();
    const lastName = (body.lastName || "").trim();
    const email = (body.email || "").trim();
    const phone = (body.phone || "").trim();
    if (!firstName || !lastName)
      return NextResponse.json(
        { error: "First and last name are required.", status: 400 } as ApiError,
        { status: 400 },
      );

    if (!email && !phone)
      return NextResponse.json(
        {
          error: "Add a phone number or an email — we need a way to reach them.",
          detail: "Nothing was created.",
          status: 400,
        } as ApiError,
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

    let assignedTo = "";
    if (session && !isAdmin) {

      assignedTo = "";
    } else if (body.assignedTo) {
      const validUsers = await getLocationUserIds();

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

      assignedTo = "";
    }

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

      stageId = uncategorized?.id || entryStage(dest).id || "";
    }
    if (!stageId)
      return NextResponse.json(
        { error: `"${dest.name}" has no stages.`, status: 400 } as ApiError,
        { status: 400 },
      );

    let contactId = (body.contactId || "").trim();
    if (!contactId) {

      const contactDefs = await getEditableFieldDefs("contact");
      const clash = await checkExistingPerson({
        phone,
        email,
        recordTypeFieldId: contactDefs.find(
          (d) => d.name.toLowerCase().replace(/[^a-z0-9]/g, "") === "recordtype",
        )?.id,
      });
      if (clash) return NextResponse.json(clash, { status: 409 });

      const made = await createPersonOrConflict({
        firstName,
        lastName,
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        source: "Dashboard — Add Lead",
      });
      if (!made.ok) return NextResponse.json(made.conflict, { status: 409 });
      contactId = made.id;
    }
    if (!contactId)
      return NextResponse.json(
        {
          error: "Could not create the lead's contact.",
          detail: "GoHighLevel returned no contact id.",
          status: 502,
        } as ApiError,
        { status: 502 },
      );

    const existing = await listContactOpportunities(contactId);
    const clash = existing.find((o) => o.pipelineId === dest.id);
    if (clash)
      return NextResponse.json(
        {
          error: "This lead already has a case here.",
          detail: `${firstName} ${lastName} already has a case in "${dest.name}"${clash.stage ? ` (${clash.stage})` : ""}. GoHighLevel allows only one case per person per pipeline — open that one, or pick a different pipeline.`,
          status: 409,
        } as ApiError,
        { status: 409 },
      );

    const customFields = [...(await divisionCustomField(dest.name))];
    const defs = await getEditableFieldDefs();
    const defById = new Map(defs.map((d) => [d.id, d]));
    const rejectedDetails: string[] = [];
    for (const [fieldId, raw] of Object.entries(body.details || {})) {
      const def = defById.get(fieldId);

      if (!def || !def.editable) {
        rejectedDetails.push(fieldId);
        continue;
      }
      const { value, rejected } = coerceDetail(def, raw);
      for (const r of rejected) rejectedDetails.push(`${def.name}: "${r}"`);
      if (Array.isArray(value) ? value.length : String(value).trim())
        customFields.push({ id: def.id, value });
    }
    if (rejectedDetails.length)
      // eslint-disable-next-line no-console
      console.warn(
        `[clients] ignored detail values that are not in their field's option list: ${rejectedDetails.join(", ")}`,
      );

    const oppId = await createOpportunity({
      pipelineId: dest.id,
      stageId,
      contactId,

      name: (body.oppName || "").trim() || `${firstName} ${lastName}`.trim(),
      ...(assignedTo ? { assignedTo } : {}),
      source: "Dashboard — Add Lead",
      ...(customFields.length ? { customFields } : {}),
    });

    if (!oppId)
      return NextResponse.json(
        {
          error: "The case was not created.",
          detail:
            "The lead's contact exists, but GoHighLevel returned no opportunity id. Check the pipeline in GoHighLevel before retrying, so you don't create a second contact.",
          status: 502,
        } as ApiError,
        { status: 502 },
      );

    await emit(
      "opportunity.created",
      {
        actor: { userId: session?.userId || "" },
        opportunityId: oppId,
        contactId,
      },
      {
        pipelineId: dest.id,
        pipelineName: dest.name,
        stageId,
        ownerId: assignedTo,
        name: `${firstName} ${lastName}`.trim(),
        source: "Dashboard — Add Lead",
      },
    );

    return NextResponse.json(

      {
        ok: true,
        opportunityId: oppId,
        contactId,
        rejectedDetails,

        ownerAuthor: assignedTo ? "request" : "workflow",
        ownerId: assignedTo || "",
      },
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
        { error: "Could not add the lead.", detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Could not add the lead.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return withGrants(() => postHandler(request));
}
