import { NextResponse } from "next/server";
import {
  getContactCustomFields,
  countContactOpportunities,
  updateContactCustomFields,
  getEditableFieldDefs,
  getOpportunityById,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canEditRecord, canSeeRecord } from "@/lib/visibility";
import { isFieldEditable } from "@/lib/editable";
import { versionGuard } from "@/lib/concurrency";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ITEM 3 — CONTACT custom fields for the record panel.
//
// ⚠️ PERMISSION IS BORROWED FROM THE OPPORTUNITY, deliberately. The caller
// names the opportunity it is looking at; we read that record, apply the SAME
// visibility/edit rule the opportunity panel uses, and only then touch the
// contact. Without that, this route would be a way to read or write any contact
// on the account by id, bypassing assignment scoping entirely.

async function gate(
  oppId: string,
  ssoKey: string | null,
  mode: "read" | "write",
): Promise<{ contactId: string } | NextResponse> {
  const rec = await getOpportunityById(oppId);
  if (!rec)
    return NextResponse.json(
      { error: "Record not found.", status: 404 } as ApiError,
      { status: 404 },
    );
  if (ssoConfigured()) {
    if (!ssoKey)
      return NextResponse.json(
        { error: "Sign-in required.", status: 401 } as ApiError,
        { status: 401 },
      );
    const s = decryptSso(ssoKey);
    const allowed =
      mode === "write" ? canEditRecord(rec, s) : canSeeRecord(rec, s);
    if (!allowed)
      return NextResponse.json(
        { error: "Not permitted.", status: 403 } as ApiError,
        { status: 403 },
      );
  }
  if (!rec.contactId)
    return NextResponse.json(
      { error: "This record has no linked contact.", status: 409 } as ApiError,
      { status: 409 },
    );
  return { contactId: rec.contactId };
}

// GET ?opportunityId=… — definitions + values + how many records share them.
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const g = await gate(id, request.headers.get("x-ghl-sso-key"), "read");
    if (g instanceof NextResponse) return g;

    const [defs, read, oppCount] = await Promise.all([
      getEditableFieldDefs("contact"),
      getContactCustomFields(g.contactId),
      countContactOpportunities(g.contactId),
    ]);
    return NextResponse.json(
      { ...read, fieldDefs: defs, opportunityCount: oppCount },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorOut(e, "Could not read the contact's fields.");
  }
}

// PATCH { ssoKey?, expectedVersion?, fields: [{ id, value }] }
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      expectedVersion?: string;
      fields?: { id: string; value: unknown }[];
    };
    const g = await gate(id, body.ssoKey || null, "write");
    if (g instanceof NextResponse) return g;

    const entries = Array.isArray(body.fields) ? body.fields : [];
    if (!entries.length)
      return NextResponse.json(
        { error: "Nothing to save." } as ApiError,
        { status: 400 },
      );

    const defs = await getEditableFieldDefs("contact");
    const defById = new Map(defs.map((d) => [d.id, d]));

    // The read-only blocklist is enforced HERE, not just hidden in the UI.
    // "CG - Compliance Cleared" is a workflow trigger: a recruiter ticking it
    // by hand would fire the compliance automation on an uncleared applicant.
    for (const e of entries) {
      const def = defById.get(e.id);
      if (!def)
        return NextResponse.json(
          { error: "Unknown contact field.", detail: e.id } as ApiError,
          { status: 400 },
        );
      if (!isFieldEditable(def.name))
        return NextResponse.json(
          {
            error: `"${def.name}" is set by a workflow and cannot be edited here.`,
            status: 403,
          } as ApiError,
          { status: 403 },
        );
    }

    // ITEM 3 — SAME VERSION CHECK AS THE OPPORTUNITY PATCH (report 46). A
    // contact reached from two different opportunity panels is exactly the
    // concurrent case this guards: two people on two cases, one shared person.
    const before = await getContactCustomFields(g.contactId);
    const conflict = versionGuard(
      { id: g.contactId, version: before.version },
      body.expectedVersion,
      "contact-fields PATCH",
    );
    if (conflict) return conflict;

    await updateContactCustomFields(g.contactId, entries);
    const after = await getContactCustomFields(g.contactId);
    return NextResponse.json(after, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return errorOut(e, "Could not save the contact's fields.");
  }
}

function errorOut(e: unknown, fallback: string) {
  if (e instanceof SsoError)
    return NextResponse.json({ error: e.message, status: e.status } as ApiError, {
      status: e.status,
    });
  if (e instanceof GhlError)
    return NextResponse.json({ error: e.message, detail: e.detail } as ApiError, {
      status: e.status >= 400 ? e.status : 502,
    });
  return NextResponse.json(
    { error: fallback, detail: String(e) } as ApiError,
    { status: 500 },
  );
}
