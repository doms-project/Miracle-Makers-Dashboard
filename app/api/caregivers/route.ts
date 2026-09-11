import { NextResponse } from "next/server";
import {
  upsertContact,
  createOpportunity,
  getSelectedPipelines,
  listContactOpportunities,
  getEditableFieldDefs,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { withGrants } from "@/lib/withGrants";
import { emit } from "@/lib/webhooks";
import type { ApiError } from "@/lib/types";
import {
  CG_DIVISIONS,
  CG_WORK_STATES,
  pipelineForDivision,
  type CgDivision,
} from "@/lib/caregiverIntake";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// 🔴 A CAREGIVER, NOT A CLIENT — AND THAT IS THE WHOLE POINT OF THIS ROUTE
// EXISTING SEPARATELY.
//
// `/api/clients` creates a CLIENT opportunity in a CLIENT pipeline and stamps
// Division from the pipeline name. app/page.tsx:4168 has warned since round A3
// that a renamed button pointing at that route would file an applicant as a
// client — "a button that does the wrong thing is worse than no button". So the
// applicant path is its own route, its own pipeline set (scope: "caregiver"
// from the stored config) and its own field set.
//
// ⚠️ EIGHT FIELDS, NOT 58. A recruiter completes compliance and availability as
// the applicant progresses; 58 fields at the moment of entry is a form nobody
// finishes.
interface Body {
  ssoKey?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  source?: string;
  division?: string;
  workState?: string;
  /** Only honoured when the division maps to more than one pipeline. */
  pipelineId?: string;
}

/** A field def by NAME, normalised — ids differ per account, names do not. */
function defByName(
  defs: { id: string; name: string; options: string[]; editable: boolean }[],
  name: string,
) {
  return defs.find((d) => norm(d.name) === norm(name));
}

async function postHandler(request: Request) {
  try {
    const body = (await request.json()) as Body;

    let session: { userId?: string } | null = null;
    if (ssoConfigured()) {
      if (!body.ssoKey)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      session = decryptSso(body.ssoKey);
    }

    const firstName = (body.firstName || "").trim();
    const lastName = (body.lastName || "").trim();
    const email = (body.email || "").trim();
    const phone = (body.phone || "").trim();
    if (!firstName && !lastName)
      return NextResponse.json(
        { error: "An applicant needs a name.", status: 400 } as ApiError,
        { status: 400 },
      );
    if (!email && !phone)
      return NextResponse.json(
        {
          error: "An applicant needs an email or a phone number.",
          detail: "Without one there is no way to contact them and no way to dedupe them.",
          status: 400,
        } as ApiError,
        { status: 400 },
      );

    const division = (body.division || "").trim().toUpperCase() as CgDivision;
    if (!(CG_DIVISIONS as readonly string[]).includes(division))
      return NextResponse.json(
        { error: "Choose a division.", status: 400 } as ApiError,
        { status: 400 },
      );

    // ── the contact, always ────────────────────────────────────────────────
    // 🔴 Record Type = Caregiver. This is what keeps an applicant out of every
    // client view that filters on it.
    const defs = await getEditableFieldDefs("contact");
    const contactFields: { id: string; value: unknown }[] = [];
    const push = (fieldName: string, value: string) => {
      if (!value) return;
      const def = defByName(defs, fieldName);
      if (!def) return; // absent on this account — skip rather than fail the add
      const opts = def.options || [];
      const match = opts.length ? opts.find((o) => norm(o) === norm(value)) : value;
      if (match) contactFields.push({ id: def.id, value: match });
    };
    push("Record Type", "Caregiver");
    push("CG - Division", division);
    if (body.workState && CG_WORK_STATES.includes(body.workState.trim().toUpperCase()))
      push("CG - Work State", body.workState.trim().toUpperCase());

    const contact = await upsertContact({
      firstName,
      lastName,
      name: `${firstName} ${lastName}`.trim(),
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      source: (body.source || "").trim() || undefined,
      ...(contactFields.length ? { customFields: contactFields } : {}),
    });
    if (!contact.id)
      return NextResponse.json(
        {
          error: "Could not create the applicant's contact.",
          detail: "GoHighLevel returned no contact id. Nothing else was created.",
          status: 502,
        } as ApiError,
        { status: 502 },
      );

    // ── REJECTED: contact only, no opportunity ─────────────────────────────
    // 🔴 Deliberate, and a success rather than a refusal. Someone who applied
    // and was turned away still has to exist, so a second application can be
    // recognised as one. There is simply no pipeline they belong in.
    if (division === "REJECTED")
      return NextResponse.json({
        ok: true,
        contactId: contact.id,
        opportunityId: "",
        survived: "The applicant's contact was created.",
        note: "Rejected applicants are recorded as a contact only — there is no pipeline for them.",
      });

    // ── the pipeline, DRIVEN BY THE DIVISION ───────────────────────────────
    const pipelines = await getSelectedPipelines("caregiver");
    const choice = pipelineForDivision(
      division,
      pipelines.map((p) => ({ id: p.id, name: p.name })),
    );

    // 🔴 OLTL_CHC HAS NO PIPELINE. The caregiver form's DEFAULT branch routes
    // there and nothing receives it. Said plainly rather than silently filed
    // somewhere convenient — putting them in PP or ODP would be inventing a
    // routing decision that nobody has made.
    if (!choice.pipelines.length)
      return NextResponse.json(
        {
          error: `There is no pipeline for ${division}.`,
          detail: `The applicant's contact WAS created, so nothing is lost and they are not a duplicate. ${choice.why}`,
          survived: "The applicant's contact was created.",
          status: 409,
        } as ApiError & { survived: string },
        { status: 409 },
      );

    const dest =
      choice.pipelines.length === 1
        ? choice.pipelines[0]
        : choice.pipelines.find((p) => p.id === body.pipelineId) || choice.pipelines[0];
    const full = pipelines.find((p) => p.id === dest.id);
    const stageId = full?.stages?.[0]?.id || "";
    if (!stageId)
      return NextResponse.json(
        {
          error: `"${dest.name}" has no stages.`,
          detail: "The applicant's contact was created. Add a stage in GoHighLevel, then add the application.",
          survived: "The applicant's contact was created.",
          status: 409,
        } as ApiError & { survived: string },
        { status: 409 },
      );

    // GHL allows one opportunity per contact per pipeline. Caught here so the
    // message names the person rather than returning OPPORTUNITY_NO_DUPLICATE.
    const existing = await listContactOpportunities(contact.id);
    const clash = existing.find((o) => o.pipelineId === dest.id);
    if (clash)
      return NextResponse.json(
        {
          error: "This applicant already has an application here.",
          detail: `${firstName} ${lastName} is already in "${dest.name}"${clash.stage ? ` (${clash.stage})` : ""}. Applying twice to the same job is one application.`,
          survived: "The applicant's contact was updated.",
          status: 409,
        } as ApiError & { survived: string },
        { status: 409 },
      );

    const oppId = await createOpportunity({
      pipelineId: dest.id,
      stageId,
      contactId: contact.id,
      name: `${firstName} ${lastName}`.trim(),
      source: (body.source || "").trim() || undefined,
    });
    if (!oppId)
      return NextResponse.json(
        {
          error: "The application was not created.",
          detail:
            "The applicant's contact exists, but GoHighLevel returned no opportunity id. Check the pipeline in GoHighLevel before retrying, so you don't create a second contact.",
          survived: "The applicant's contact was created.",
          status: 502,
        } as ApiError & { survived: string },
        { status: 502 },
      );

    await emit(
      "opportunity.created",
      { actor: { userId: session?.userId || "" }, opportunityId: oppId, contactId: contact.id },
      {
        pipelineId: dest.id,
        pipelineName: dest.name,
        stageId,
        name: `${firstName} ${lastName}`.trim(),
        source: (body.source || "").trim() || "",
      },
    );

    return NextResponse.json(
      { ok: true, contactId: contact.id, opportunityId: oppId, pipelineName: dest.name },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json({ error: e.message, status: e.status } as ApiError, {
        status: e.status,
      });
    if (e instanceof GhlError)
      return NextResponse.json(
        { error: "Could not add the applicant.", detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Could not add the applicant.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return withGrants(() => postHandler(request));
}
