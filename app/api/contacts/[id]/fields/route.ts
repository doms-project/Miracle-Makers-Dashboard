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
import { emailKey, phoneKey } from "@/lib/phone";
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
      // 🔴 ROUND 131 — the person's NATIVE name. A separate key, never an entry
      // in `fields`: `fields` is validated against the custom-field definitions
      // and a native name has no definition to validate against.
      name?: { firstName?: string; lastName?: string };
      /**
       * 🔴 ROUND 134 — HOW TO REACH THEM. Native, like the name, and for the
       * same reason a separate key: `fields` is validated against the
       * custom-field definitions and these have none.
       *
       * ⚠️ `undefined` MEANS "LEAVE ALONE" AND `""` MEANS "CLEAR". They are not
       * the same thing and must not be collapsed: a panel that sends both boxes
       * on every save would wipe the email whenever somebody corrected a phone
       * number.
       */
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
    const newEmail = String(body.email ?? "").trim();
    const newPhone = String(body.phone ?? "").trim();

    // ═══ 🔴 ROUND 134 · VALIDATE ENOUGH TO BE USEFUL, NOT ENOUGH TO BE
    //                   ANNOYING ═══════════════════════════════════════════
    //
    // GoHighLevel rejects a malformed email with a 400 whose wording is its
    // own; catching it here and saying so in a sentence is the difference
    // between "fix the address" and a raw refusal the rep has to interpret.
    //
    // ⚠️ AND BOTH RULES ARE DELIBERATELY LOOSE.
    //   · the email test is shape-only — something, an @, something, a dot,
    //     something. It does not know which domains exist, does not object to
    //     "+" tags, and does not enforce a TLD list that goes stale.
    //   · the phone test is `phoneKey`'s OWN threshold, reused rather than
    //     invented: fewer than ten digits is "too short to be a phone number",
    //     which is already this codebase's definition. Ten or more goes
    //     through — an international number with an extension is not this
    //     code's business to refuse.
    //
    // ⚠️ CLEARING IS ALLOWED. "" is a correction — somebody typed the wrong
    // number — and refusing it would leave a wrong number on the record,
    // which is worse than none. A person with neither is then refused by the
    // TRANSFER, where the consequence actually lives.
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
    // ⚠️ REFUSED BEFORE ANY READ. A blank name is not a clearable field like the
    // rest of them — it is the only thing that identifies the person on every
    // list, every board and every record they hold.
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

    // 🔴 FAILS CLOSED HERE, unlike the opportunity path — on purpose.
    //
    // `isStale()` treats a MISSING stored version as "go ahead", which is right
    // for opportunities: GoHighLevel does not always send one, and refusing
    // every write over an absent field would be worse than the last-write-wins
    // behaviour that came before it.
    //
    // Contacts are different: `dateUpdated` is VERIFIED ALWAYS PRESENT on this
    // account. So an empty version here does not mean "GHL didn't send one", it
    // means the response shape has changed under us — and quietly proceeding
    // would be the silent no-op this check exists to prevent. If the caller
    // asked for the check, and we cannot perform it, say so instead of pretending.
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

    // ═══ 🔴 THE READ-BACK. THE NATIVE PATH'S ONLY HONEST PROOF ═══════════════
    //
    // GoHighLevel answers 200 to a PUT carrying keys it does not recognise, so
    // "the write succeeded" says nothing about whether anything was STORED.
    // Custom fields are checked against their definitions before the write and
    // there is no equivalent for a native one — the check has to happen after.
    //
    // ⚠️ AND IT MUST FAIL THE REQUEST, not log a warning. The panel reverts on a
    // non-ok response; a 200 with the old name in it would leave the new
    // spelling on screen over the old one in GoHighLevel, which is worse than
    // not offering the rename at all.
    if (wantsName && (after.firstName !== newFirst || after.lastName !== newLast))
      return NextResponse.json(
        {
          error: "GoHighLevel accepted the rename but did not store it.",
          detail: `Sent “${[newFirst, newLast].filter(Boolean).join(" ")}”, read back “${
            [after.firstName, after.lastName].filter(Boolean).join(" ") || "(nothing)"
          }”. The name has been left as it was on screen; change it in GoHighLevel.`,
          status: 502,
        } as ApiError,
        { status: 502 },
      );

    // ═══ 🔴 ROUND 134 · AND THE READ-BACK MUST COMPARE MEANING, NOT TEXT ═════
    //
    // GOHIGHLEVEL NORMALISES BOTH OF THESE. Send "610-555-0101" and it stores
    // "+16105550101"; send "Mary@Example.com" and it stores it lower-cased. A
    // strict string comparison would then FAIL a save that worked perfectly —
    // the panel would revert a correct number and tell the rep to go and fix it
    // in GoHighLevel, where they would find it already correct.
    //
    // 🔴 THAT IS A WORSE BUG THAN THE ONE THE READ-BACK EXISTS TO CATCH,
    // because it fires on the happy path rather than the broken one.
    //
    // ⚠️ `phoneKey` AND `emailKey`, NOT A COMPARISON WRITTEN HERE. They are
    // lib/phone.ts's own answer to "is this the same number / the same
    // address", already used by the duplicate check, and that file says in so
    // many words that a second copy is a second rule that can drift.
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
