import { NextResponse } from "next/server";
import {
  getContactCustomFields,
  countContactOpportunities,
  updateContactCustomFields,
  updateContactNative,
  getEditableFieldDefs,
  getOpportunityById,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canEditRecord, canSeeRecord } from "@/lib/visibility";
import { isFieldEditable } from "@/lib/editable";
import { versionGuard } from "@/lib/concurrency";
import { emailKey, phoneKey, nameKey } from "@/lib/phone";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {

  let wantsPhoneOut = false;
  let wantsEmailOut = false;
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      expectedVersion?: string;
      fields?: { id: string; value: unknown }[];

      name?: { firstName?: string; lastName?: string };

      email?: string;
      phone?: string;
    };
    const g = await gate(id, body.ssoKey || null, "write");
    if (g instanceof NextResponse) return g;

    const entries = Array.isArray(body.fields) ? body.fields : [];
    const wantsName = !!body.name;
    const newFirst = String(body.name?.firstName ?? "").trim();
    const newLast = String(body.name?.lastName ?? "").trim();
    const wantsEmail = typeof body.email === "string";
    const wantsPhone = typeof body.phone === "string";

    wantsEmailOut = wantsEmail;
    wantsPhoneOut = wantsPhone;
    const newEmail = String(body.email ?? "").trim();
    const newPhone = String(body.phone ?? "").trim();

    if (wantsEmail && newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail))
      return NextResponse.json(
        {
          error: `“${newEmail}” is not an email address.`,
          detail:
            "It needs an @ and a dot after it — like name@example.com. Nothing has been changed.",
          refusal: true,
          status: 400,
        } as ApiError,
        { status: 400 },
      );
    if (wantsPhone && newPhone && !phoneKey(newPhone))
      return NextResponse.json(
        {
          error: `“${newPhone}” is too short to be a phone number.`,
          detail:
            "A phone number needs at least ten digits. Nothing has been changed.",
          refusal: true,
          status: 400,
        } as ApiError,
        { status: 400 },
      );

    if (!entries.length && !wantsName && !wantsEmail && !wantsPhone)
      return NextResponse.json(
        { error: "Nothing to save." } as ApiError,
        { status: 400 },
      );

    if (wantsName && !newFirst && !newLast)
      return NextResponse.json(
        {
          error: "A person needs a name.",
          detail:
            "Type at least a first or last name. Nothing has been changed.",
          refusal: true,
          status: 400,
        } as ApiError,
        { status: 400 },
      );

    const defs = await getEditableFieldDefs("contact");
    const defById = new Map(defs.map((d) => [d.id, d]));

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

    const before = await getContactCustomFields(g.contactId);

    if (body.expectedVersion && !before.version) {
      // eslint-disable-next-line no-console
      console.error(
        `[version] contact-fields PATCH on ${g.contactId}: caller sent expectedVersion but the contact read returned NO dateUpdated. The concurrency check could not run — refusing rather than writing blind. Check the /contacts/{id} response shape.`,
      );
      return NextResponse.json(
        {
          error: "Couldn't confirm nobody else changed this person in the meantime. Reopen the record and try again.",
          detail:
            "The contact came back without a dateUpdated timestamp, so the concurrency check could not run.",
          status: 409,
        } as ApiError,
        { status: 409 },
      );
    }

    const conflict = versionGuard(
      { id: g.contactId, version: before.version },
      body.expectedVersion,
      "contact-fields PATCH",
    );
    if (conflict) return conflict;

    if (entries.length) await updateContactCustomFields(g.contactId, entries);
    if (wantsName || wantsEmail || wantsPhone)
      await updateContactNative(g.contactId, {
        ...(wantsName ? { firstName: newFirst, lastName: newLast } : {}),
        ...(wantsEmail ? { email: newEmail } : {}),
        ...(wantsPhone ? { phone: newPhone } : {}),
      });

    const after = await getContactCustomFields(g.contactId);

    const nameStored = !wantsName || nameKey(after.firstName, after.lastName) === nameKey(newFirst, newLast);
    if (wantsName && !nameStored)
      // eslint-disable-next-line no-console
      console.warn(
        `[contact-fields] rename on ${g.contactId}: sent firstName=“${newFirst}” lastName=“${newLast}”, ` +
          `read back firstName=“${after.firstName}” lastName=“${after.lastName}”. Returned as unconfirmed.`,
      );

    const reachMismatch =
      (wantsPhone && phoneKey(after.phone) !== phoneKey(newPhone)) ||
      (wantsEmail && emailKey(after.email) !== emailKey(newEmail));
    if (reachMismatch) {
      const what = wantsPhone && phoneKey(after.phone) !== phoneKey(newPhone)
        ? { label: "phone number", sent: newPhone, got: after.phone }
        : { label: "email address", sent: newEmail, got: after.email };
      return NextResponse.json(
        {
          error: `GoHighLevel accepted the ${what.label} but did not store it.`,
          detail: `Sent “${what.sent || "(blank)"}”, read back “${what.got || "(nothing)"}”. It has been left as it was on screen; change it in GoHighLevel.`,
          status: 502,
        } as ApiError,
        { status: 502 },
      );
    }

    return NextResponse.json(
      {
        ...after,
        ...(wantsName
          ? {
              nameConfirmed: nameStored,

              nameSent: [newFirst, newLast].filter(Boolean).join(" "),
            }
          : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {

    return errorOut(e, "Could not save the contact's fields.", {
      phone: wantsPhoneOut,
      email: wantsEmailOut,
    });
  }
}

function duplicateFieldMessage(
  e: GhlError,
  sent: { phone: boolean; email: boolean },
): string | null {
  const raw = `${e.message} ${e.detail ?? ""}`;
  if (!/duplicated\s+contacts/i.test(raw) && !/DUPLICATED_CONTACT/i.test(raw))
    return null;

  if (sent.phone && sent.email)
    return "That phone number or email address already belongs to another person in GoHighLevel. Nothing was changed.";
  if (sent.phone)
    return "That phone number already belongs to another person in GoHighLevel. Nothing was changed.";
  if (sent.email)
    return "That email address already belongs to another person in GoHighLevel. Nothing was changed.";
  return null;
}

function errorOut(
  e: unknown,
  fallback: string,
  sent?: { phone: boolean; email: boolean },
) {
  if (e instanceof SsoError)
    return NextResponse.json({ error: e.message, status: e.status } as ApiError, {
      status: e.status,
    });
  if (e instanceof GhlError) {
    const dup = sent ? duplicateFieldMessage(e, sent) : null;
    if (dup)
      return NextResponse.json(
        {
          error: dup,

          detail: `GoHighLevel said: “${e.detail || e.message}”.`,
          status: 409,
        } as ApiError,
        { status: 409 },
      );
    return NextResponse.json({ error: e.message, detail: e.detail } as ApiError, {
      status: e.status >= 400 ? e.status : 502,
    });
  }
  return NextResponse.json(
    { error: fallback, detail: String(e) } as ApiError,
    { status: 500 },
  );
}
