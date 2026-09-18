import { NextResponse } from "next/server";
import {
  getOpportunityById,
  getContactCustomFields,
  getEditableFieldDefs,
  listPipelines,
  listContactNotes,
  addOpportunityNote,
  updateOpportunity,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import {
  peerConfigured,
  peerLabel,
  peerFieldDefs,
  peerPipelines,
  peerFindContact,
  peerOpportunityInPipeline,
  peerUpsertContact,
  peerCreateOpportunity,
  peerAddNote,
} from "@/lib/peer";
import {
  translate,
  arrivalIn,
  departureFrom,
  isRefusal,
  trailNote,
  type Parcel,
  type Refusal,
} from "@/lib/transfer";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import { withGrants } from "@/lib/withGrants";
import { emit } from "@/lib/webhooks";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60; // two accounts, up to seven calls, notes included

/**
 * ═════════════════════════════════════════════════════════════════════════
 * 🔴 CROSS-ACCOUNT TRANSFER. RECREATE THERE, CLOSE HERE.
 * ═════════════════════════════════════════════════════════════════════════
 *
 * Nothing is shared between GoHighLevel sub-accounts. A contact in one does not
 * exist in the other, so this is not a move — and calling it one would be the
 * first of several ways to lose somebody's case.
 *
 *   GET   the preflight. Reads both accounts, decides everything, writes
 *         NOTHING. This is what the dialog shows.
 *   POST  the same preflight, then the writes, in an order chosen so that the
 *         unrecoverable failure cannot happen.
 *
 * ═══ 🔴 THE ORDER IS THE SAFETY PROPERTY ═════════════════════════════════
 *
 *   1  peer: contact          a duplicate person is recoverable
 *   2  peer: opportunity      a duplicate case is recoverable
 *   3  peer: notes            best effort — never fails a delivered transfer
 *   4  SELF: close            ← only now, and only if 1 and 2 both confirmed
 *   5  SELF: id + trail note
 *
 * 🔴 THE SOURCE IS NEVER CLOSED BEFORE THE PEER CONFIRMS. A lost record is not
 * recoverable; a duplicated one is. Every ordering that closes first trades an
 * annoyance for a catastrophe.
 *
 * ⚠️ AND EVERY ANSWER SAYS WHAT SURVIVED. Four writes across two accounts
 * cannot be reported as "worked" or "didn't". `steps` is the list of what
 * actually happened, in order, and it is returned on the failure paths too —
 * that is the whole point of it.
 *
 * ═══ ⚠️ ADMIN ONLY, AND THIS IS A JUDGEMENT THE BRIEF DID NOT MAKE ════════
 *
 * Round 124 made DELETE admin-only on the reasoning that a rep who wants a
 * record gone should mark it lost. This writes a person's record into ANOTHER
 * COMPANY'S CRM and closes their case here. It is at least as consequential and
 * a good deal harder to undo from this side, so it takes the same gate — and,
 * like that one, server-side rather than by hiding a button.
 *
 * 🔴 IF THAT IS WRONG, IT IS ONE LINE. Say so and it becomes owner-or-admin
 * like every other edit.
 */

/**
 * ⚠️ A LOCAL ERROR SHAPE, NOT EXTRA KEYS CAST ONTO `ApiError`.
 *
 * `as ApiError` on an object literal with excess properties compiles and lies:
 * the type says those keys are not there and the renderer is written against
 * the type. A partial transfer's answer is mostly in `steps` and the two peer
 * ids — if they are not in the contract, nothing downstream is obliged to keep
 * carrying them, and the first refactor drops the only account of what survived.
 */
interface TransferError extends ApiError {
  /** TRUE when writes landed and the sequence then stopped. Never on a clean refusal. */
  partial?: boolean;
  /** What actually happened, in order, including on the failure paths. */
  steps?: string[];
  peerContactId?: string;
  peerOpportunityId?: string;
  refusals?: Refusal[];
}

interface Preflight {
  peer: string;
  destination?: { pipelineId: string; pipelineName: string; stageId: string; stageName: string };
  closeTo?: { pipelineId: string; stageId: string; label: string };
  parcel?: Parcel;
  /** Already over there — the repeat-transfer answer, decided before any write. */
  existing?: { contactId: string; contactName: string; opportunityId?: string; opportunityName?: string };
  refusals: Refusal[];
}

/** The four things that cannot cross a sub-account boundary, in one place. */
const CANNOT_FOLLOW = [
  "Conversation history — calls, texts and emails stay on this account.",
  "Appointments.",
  "File attachments. This dashboard cannot read them at all, so they have to be copied by hand in GoHighLevel.",
  "The owner and any followers — user accounts are per sub-account, so the case arrives unassigned.",
  "The record's age. The new case is new: days-in-stage and created-date restart over there.",
];

/** Where this side stores the peer's id, when such a field exists. */
const PEER_ID_FIELD = /^(peerrecordid|peeropportunityid|transferredtoid|transferredrecordid)$/;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function preflight(oppId: string): Promise<
  | { status: number; body: ApiError }
  | { record: Awaited<ReturnType<typeof getOpportunityById>>; pre: Preflight }
> {
  if (!peerConfigured())
    return {
      status: 503,
      body: {
        error: `This deployment has no link to ${peerLabel()}.`,
        detail:
          "Transfers need the other account's token configured on the server. Nothing has been changed.",
        refusal: true,
        status: 503,
      } as ApiError,
    };

  const record = await getOpportunityById(oppId);
  if (!record)
    return { status: 404, body: { error: "Record not found.", status: 404 } as ApiError };
  if (!record.contactId)
    return {
      status: 409,
      body: {
        error: "This case has no linked contact.",
        detail: "A transfer recreates the PERSON on the other account first. There is nobody to recreate.",
        refusal: true,
        status: 409,
      } as ApiError,
    };

  // 🔴 EVERY READ BEFORE ANY DECISION, AND ALL OF THEM BEFORE ANY WRITE.
  // Anything knowable in advance must be known in advance: the failure this
  // whole route is shaped around is a contact created over there for a case
  // that then turns out to have nowhere to land.
  const [
    contact,
    selfContactDefs,
    selfOppDefs,
    selfPipes,
    notes,
    peerContactDefs,
    peerOppDefs,
    peerPipes,
  ] = await Promise.all([
    getContactCustomFields(record.contactId),
    getEditableFieldDefs("contact"),
    getEditableFieldDefs("opportunity"),
    listPipelines(),
    listContactNotes(record.contactId).catch(() => []),
    peerFieldDefs("contact"),
    peerFieldDefs("opportunity"),
    peerPipelines(),
  ]);

  const refusals: Refusal[] = [];
  const arrival = arrivalIn(record.pipelineName || "", peerPipes);
  if (isRefusal(arrival)) refusals.push(arrival);
  const departure = departureFrom(selfPipes, record.pipelineId);
  if (isRefusal(departure)) refusals.push(departure);

  // ⚠️ THE REPEAT TRANSFER, ANSWERED IN PLAIN WORDS RATHER THAN AS A 400.
  // `peerUpsertContact` matches on email or phone, so sending the same person
  // twice UPDATES them rather than duplicating — which is right. But
  // GoHighLevel allows one opportunity per contact per pipeline, so the case
  // would be rejected at the second write, after the contact had been touched.
  let existing: Preflight["existing"];
  const found = await peerFindContact({
    email: record.contactEmail,
    phone: record.contactPhone,
  });
  if (found) {
    existing = { contactId: found.id, contactName: found.name };
    if (!isRefusal(arrival)) {
      const held = await peerOpportunityInPipeline(found.id, arrival.pipelineId);
      if (held) {
        existing.opportunityId = held.id;
        existing.opportunityName = held.name;
        refusals.push({
          error: `${found.name || "This person"} already has a case in “${arrival.pipelineName}” on ${peerLabel()}.`,
          detail: `GoHighLevel allows one case per person per pipeline, so this cannot be sent again — their record over there is “${held.name}” (${held.id}). If this case is genuinely different, rename or close the one over there first. Nothing has been changed.`,
        });
      }
    }
  }

  const parcel = translate({
    record,
    contactValues: contact.values,
    contactFirst: contact.firstName || record.first,
    contactLast: contact.lastName || record.last,
    notes: notes.map((n) => `${n.dateAdded ? `${n.dateAdded.slice(0, 10)} · ` : ""}${n.who || "Unknown"}: ${n.txt}`),
    selfContactDefs,
    selfOppDefs,
    peerContactDefs,
    peerOppDefs,
  });

  return {
    record,
    pre: {
      peer: peerLabel(),
      destination: isRefusal(arrival) ? undefined : arrival,
      closeTo: isRefusal(departure) ? undefined : departure,
      parcel,
      existing,
      refusals,
    },
  };
}

function gate(blob: string | null):
  | { userId: string; name: string }
  | NextResponse {
  if (!ssoConfigured()) return { userId: "", name: "the dashboard" };
  if (!blob)
    return NextResponse.json(
      { error: "Sign-in required.", detail: "No SSO session was provided.", status: 401 } as ApiError,
      { status: 401 },
    );
  const s = decryptSso(blob);
  if (!isAdminSession(s.role, s.type))
    return NextResponse.json(
      {
        error: "Only an admin can transfer a record to another company.",
        detail:
          "A transfer writes this person into the other company's account and closes the case here. Ask an admin to do it.",
        refusal: true,
        status: 403,
      } as ApiError,
      { status: 403 },
    );
  return { userId: s.userId, name: s.userName || s.email || "an admin" };
}

async function getHandler(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const who = gate(request.headers.get("x-ghl-sso-key"));
    if (who instanceof NextResponse) return who;

    const out = await preflight(id);
    if ("status" in out) return NextResponse.json(out.body, { status: out.status });
    return NextResponse.json(
      {
        ok: true,
        canTransfer: out.pre.refusals.length === 0,
        cannotFollow: CANNOT_FOLLOW,
        ...out.pre,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return errorOut(e);
  }
}

async function postHandler(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const steps: string[] = [];
  let peerContactId = "";
  let peerOppId = "";
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as { ssoKey?: string; confirm?: boolean };
    const who = gate(body.ssoKey || null);
    if (who instanceof NextResponse) return who;

    const out = await preflight(id);
    if ("status" in out) return NextResponse.json(out.body, { status: out.status });
    const { record, pre } = out;
    if (!record || !pre.parcel || !pre.destination || !pre.closeTo || pre.refusals.length) {
      const first = pre.refusals[0];
      return NextResponse.json(
        {
          error: first?.error || "This case cannot be transferred.",
          detail: first?.detail || "",
          refusals: pre.refusals,
          refusal: true,
          status: 409,
        } as TransferError,
        { status: 409 },
      );
    }

    // ═══ 1 · THE PERSON ═══════════════════════════════════════════════════
    const c = await peerUpsertContact(pre.parcel.contact);
    peerContactId = c.id;
    steps.push(
      c.isNew
        ? `Created the person on ${pre.peer} (${c.id}).`
        : `Updated the person already on ${pre.peer} (${c.id}).`,
    );

    // ═══ 2 · THE CASE ═════════════════════════════════════════════════════
    // 🔴 THE WORST CASE LIVES HERE: a contact over there with no case attached.
    // It cannot be prevented — two accounts, no transaction — so it is caught,
    // named, and the source is left untouched so nothing has been lost.
    try {
      peerOppId = await peerCreateOpportunity({
        pipelineId: pre.destination.pipelineId,
        stageId: pre.destination.stageId,
        contactId: c.id,
        ...pre.parcel.opportunity,
      });
    } catch (e) {
      steps.push(
        `🔴 The case could NOT be created on ${pre.peer}. The person exists there with no case attached.`,
      );
      steps.push("This case here is untouched and still open. Nothing has been lost.");
      return NextResponse.json(
        {
          error: `The person reached ${pre.peer} but their case did not.`,
          detail: `${
            e instanceof GhlError ? await explainGhlError(e) : e instanceof Error ? e.message : String(e)
          } — contact ${c.id} now exists on ${pre.peer} with no case. This record has NOT been closed. Fix the cause and transfer again: the second attempt will update that contact rather than duplicating them.`,
          partial: true,
          peerContactId: c.id,
          steps,
          status: 502,
        } as TransferError,
        { status: 502 },
      );
    }
    steps.push(
      `Created the case on ${pre.peer} at ${pre.destination.pipelineName} · ${pre.destination.stageName} (${peerOppId}).`,
    );

    // ═══ 3 · NOTES ════════════════════════════════════════════════════════
    // ⚠️ BEST EFFORT AND SAID SO. The case is delivered; a note that fails to
    // copy must not make a completed transfer look like a failure — but it must
    // not be silent either, because the notes ARE the history that survives.
    let notesCopied = 0;
    const noteTrouble: string[] = [];
    for (const n of pre.parcel.notes) {
      try {
        await peerAddNote(c.id, n);
        notesCopied++;
      } catch (e) {
        noteTrouble.push(e instanceof Error ? e.message : String(e));
      }
    }
    try {
      await peerAddNote(
        c.id,
        trailNote({
          direction: "in",
          otherLabel: "the sending account",
          otherId: record.id,
          who: who.name,
          carried: pre.parcel.carried.length,
          skipped: pre.parcel.skipped,
        }),
      );
    } catch {
      noteTrouble.push("the provenance note");
    }
    steps.push(
      noteTrouble.length
        ? `Copied ${notesCopied} of ${pre.parcel.notes.length} notes — ${noteTrouble.length} failed.`
        : `Copied ${notesCopied} note${notesCopied === 1 ? "" : "s"}.`,
    );

    // ═══ 4 · CLOSE HERE — ONLY NOW ════════════════════════════════════════
    let closed = false;
    try {
      await updateOpportunity(record.id, {
        pipelineId: pre.closeTo.pipelineId,
        pipelineStageId: pre.closeTo.stageId,
      });
      closed = true;
      steps.push(`Closed this case at ${pre.closeTo.label}.`);
    } catch (e) {
      steps.push(
        `🔴 This case could NOT be closed. It is now open HERE and open on ${pre.peer} — the same case in two companies.`,
      );
      return NextResponse.json(
        {
          error: `Transferred, but this side would not close. The case now exists twice.`,
          detail: `Here: ${record.id} (${record.oppName}) — still in ${record.pipelineName}. On ${pre.peer}: ${peerOppId}. Move this one to ${pre.closeTo.label} by hand, or in GoHighLevel. Reason: ${
            e instanceof GhlError ? await explainGhlError(e) : e instanceof Error ? e.message : String(e)
          }`,
          partial: true,
          peerContactId: c.id,
          peerOpportunityId: peerOppId,
          steps,
          status: 502,
        } as TransferError,
        { status: 502 },
      );
    }

    // ═══ 5 · THE TRAIL, BOTH WAYS ═════════════════════════════════════════
    // ⚠️ THE NOTE IS THE BELT AND THE FIELD IS THE BRACES. A note can always be
    // written; the field only exists if somebody created it in GoHighLevel. So
    // the id is recorded in the note UNCONDITIONALLY, and in the field as well
    // when there is one — rather than the transfer's trail depending on a piece
    // of account setup nobody may have done.
    const oppDefs = await getEditableFieldDefs("opportunity");
    const idField = oppDefs.find((d) => PEER_ID_FIELD.test(norm(d.name)));
    if (idField) {
      try {
        await updateOpportunity(record.id, {
          customFields: [{ id: idField.id, value: peerOppId }],
        });
        steps.push(`Stored their record id in “${idField.name}”.`);
      } catch {
        steps.push(`⚠️ Could not store their record id in “${idField.name}”. It is in the note.`);
      }
    } else {
      steps.push(
        "⚠️ No “Peer Record Id” field on this account, so their id is recorded in the note only.",
      );
    }
    try {
      await addOpportunityNote(
        record.contactId,
        record.id,
        trailNote({
          direction: "out",
          otherLabel: pre.peer,
          otherId: peerOppId,
          who: who.name,
          carried: pre.parcel.carried.length,
          skipped: pre.parcel.skipped,
        }),
        who.userId,
      );
      steps.push("Left a note on this record saying where it went.");
    } catch {
      steps.push("⚠️ Could not write the note on this record. The transfer itself is done.");
    }

    void emit(
      "opportunity.transferred",
      { actor: { userId: who.userId }, opportunityId: record.id, contactId: record.contactId },
      {
        to: pre.peer,
        peerContactId: c.id,
        peerOpportunityId: peerOppId,
        pipeline: pre.destination.pipelineName,
        stage: pre.destination.stageName,
        carried: pre.parcel.carried.length,
        skipped: pre.parcel.skipped.map((s) => s.name),
      },
    );

    return NextResponse.json({
      ok: true,
      closed,
      peer: pre.peer,
      peerContactId: c.id,
      peerOpportunityId: peerOppId,
      destination: pre.destination,
      closedTo: pre.closeTo.label,
      carried: pre.parcel.carried,
      skipped: pre.parcel.skipped,
      notesCopied,
      cannotFollow: CANNOT_FOLLOW,
      steps,
    });
  } catch (e) {
    return errorOut(e, steps, { peerContactId, peerOppId });
  }
}

function errorOut(
  e: unknown,
  steps: string[] = [],
  ids: { peerContactId?: string; peerOppId?: string } = {},
) {
  const extra = {
    ...(steps.length ? { steps } : {}),
    ...(ids.peerContactId ? { peerContactId: ids.peerContactId } : {}),
    ...(ids.peerOppId ? { peerOpportunityId: ids.peerOppId } : {}),
    ...(steps.length ? { partial: true } : {}),
  };
  if (e instanceof SsoError)
    return NextResponse.json({ error: e.message, status: e.status, ...extra } as TransferError, {
      status: e.status,
    });
  if (e instanceof GhlError)
    return NextResponse.json(
      { error: e.message, detail: e.detail, status: e.status, ...extra } as TransferError,
      { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
    );
  return NextResponse.json(
    {
      error: "Unexpected error during the transfer.",
      detail: e instanceof Error ? e.message : String(e),
      ...extra,
    } as TransferError,
    { status: 500 },
  );
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return withGrants(() => getHandler(request, ctx));
}
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  return withGrants(() => postHandler(request, ctx));
}
