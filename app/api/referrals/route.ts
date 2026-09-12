import { NextResponse } from "next/server";
import {
  getSelectedPipelines,
  getEditableFieldDefs,
  getOltlOpportunities,
  upsertContact,
  createOpportunity,
  latestContactNoteAt,
  listContactNotes,
  addContactNote,
  getContactCustomFields,
  ghlSearchContacts,
  getUserMap,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { mapLimit } from "@/lib/concurrency";
import { divisionLabel } from "@/lib/division";
import { applyAccess } from "@/lib/pipelineAccess";
import { isAdminSession } from "@/lib/visibility";
import { emit } from "@/lib/webhooks";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { withGrants } from "@/lib/withGrants";
import type { ApiError } from "@/lib/types";
import {
  PARTNER_FIELDS,
  PARTNER_RECORD_TYPE,
  ATTENDEE_RECORD_TYPE,
  ATTENDEE_FIELDS,
  EVENT_FIELDS,
  REFERRING_PARTNER_FIELD,
  ATTENDEE_EVENT_FIELD_NAMES,
  OPP_EVENT_FIELD_NAMES,
  EVENT_HOST_FIELD_NAMES,
  type RawPartner,
  type RawReferral,
  type RawEvent,
  type RawAttendee,
} from "@/lib/referrals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Whole days since an ISO timestamp. NULL when there is no usable date. */
const daysSince = (iso: string): number | null => {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
};

/**
 * How many partners' notes one request will fetch, and how fast.
 *
 * ⚠️ ONE GET PER PARTNER — the dominant cost of this whole view (report 99 (c)).
 * GoHighLevel allows 100 REQUESTS PER 10 SECONDS, so this is a budget, not a
 * preference, and an unpaced wave of 150 is how a slow load becomes a 429.
 *
 * 60 in chunks of 15, with a pause between chunks, is ~60 requests spread over
 * ~6 seconds — comfortably inside the budget with headroom for everything else
 * the page is doing. Partners past the cap keep lastTouch = null, which renders
 * "—", is EXCLUDED from every count, and is STATED on screen with a control to
 * measure the next batch.
 */
const TOUCH_CAP = 60;
const TOUCH_CHUNK = 15;
const TOUCH_CONCURRENCY = 5;
const TOUCH_PAUSE_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Days since each contact's newest note. Absent = could not be read. */
async function resolveTouches(
  ids: string[],
): Promise<{ map: Record<string, number>; failed: number }> {
  const map: Record<string, number> = {};
  let failed = 0;
  for (let i = 0; i < ids.length; i += TOUCH_CHUNK) {
    const slice = ids.slice(i, i + TOUCH_CHUNK);
    const got = await mapLimit(slice, TOUCH_CONCURRENCY, (id) =>
      latestContactNoteAt(id),
    );
    slice.forEach((id, j) => {
      const s = got[j];
      if (!s || !s.ok) {
        failed++; // stays absent — unknown, and said so
        return;
      }
      // ⚠️ NO NOTE AT ALL IS OVERDUE, NOT UNKNOWN. Nobody has ever spoken to
      // them, which is the entire point of the queue. Distinct from absent,
      // which means "we did not look".
      map[id] = s.value ? (daysSince(s.value) ?? 0) : Number.MAX_SAFE_INTEGER;
    });
    if (i + TOUCH_CHUNK < ids.length) await sleep(TOUCH_PAUSE_MS);
  }
  return { map, failed };
}

interface Body {
  ssoKey?: string;
  action?: "add-partner" | "log-touch" | "log-referral" | "add-attendee";
  contactId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  org?: string;
  category?: string;
  tier?: string;
  division?: string;
  notes?: string;
  /** add-partner: the contact's owner — who holds this relationship. */
  owner?: string;
  /** log-touch: Call · Visit · Email · Event · Other, plus the note. */
  touchType?: string;
  text?: string;
  /** log-referral */
  partnerId?: string;
  pipelineId?: string;
  monthlyValue?: number;
  /** log-referral · add-attendee — the event this came from, when known. */
  eventId?: string;
  /** add-attendee */
  profile?: string;
  outcome?: string;
}

/**
 * The Events pipeline, from the STORED CONFIG.
 *
 * 🔴 NEVER HARDCODED. `gar3Y1JS9fCUDYbUrEk2` is in the brief as a cross-check,
 * not as a constant — a hardcoded pair is how the caregiver dialog nearly
 * shipped broken, and report 86 recorded what an id change does.
 *
 * ⚠️ It needs `scope:"client"` in MM Pipeline Folders. The pipeline was created
 * by an API script rather than through the Pipelines screen, so it had no entry
 * at all until this round — and with none, this returns undefined and the Events
 * tab says so rather than guessing which pipeline holds the events.
 */
async function eventsPipeline() {
  const client = await getSelectedPipelines("client");
  return client.find((p) => /^events?$/i.test(p.name.trim()));
}

export async function GET(request: Request) {
  return withGrants(async () => {
    try {
      // 🔴 THE RETURN VALUE USED TO BE DISCARDED — `decryptSso(blob);` — so this
      // route verified that a session existed and then had no userId, and could
      // not have filtered by assignment even in principle. Every other
      // client-record path keeps it (see /api/opportunities).
      let session: { userId?: string; role?: string; type?: string } | null = null;
      if (ssoConfigured()) {
        const blob = request.headers.get("x-ghl-sso-key");
        if (!blob)
          return NextResponse.json(
            { error: "Sign-in required.", status: 401 } as ApiError,
            { status: 401 },
          );
        session = decryptSso(blob);
      }
      const url = new URL(request.url);
      // Which partners' notes to resolve a last touch for.
      //   touch=auto      — the first TOUCH_CAP partners, for the first load
      //   touchFor=a,b,c  — an explicit batch, for "measure the next 60"
      // ⚠️ ALWAYS INTERSECTED WITH THE PARTNER LIST. The ids arrive from the
      // browser, and a route that reads notes off any contact id it is handed
      // is a way to read notes off contacts this view has nothing to do with.
      const asked = (url.searchParams.get("touchFor") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const autoTouch = url.searchParams.get("touch") === "auto";
      // `only=touch` skips the opportunity sweep entirely — measuring the next
      // batch of partners must not re-read every client pipeline to do it.
      const only = url.searchParams.get("only") || "";
      const onlyTouch = only === "touch";
      /** Either cheap mode — neither needs opportunity fields or the events pipeline. */
      const light = onlyTouch || only === "notes";

      const contactDefs = await getEditableFieldDefs("contact");
      // ⚠️ NOT FETCHED IN touch-only MODE. Measuring the next batch of partners
      // has nothing to do with opportunity fields or the Events pipeline, and
      // reading them anyway is how a cheap request stops being cheap.
      const [oppDefs, evPipe] = light
        ? ([[], undefined] as [typeof contactDefs, undefined])
        : await Promise.all([
            getEditableFieldDefs("opportunity"),
            eventsPipeline(),
          ]);

      // 🔴 BY NAME, WITH THE BRIEF'S ID AS A CROSS-CHECK — never the id alone.
      // Ids differ per account; names do not. The fallback is what keeps this
      // working on the account the brief was written from.
      const idOf = (name: string, fallback: string) =>
        contactDefs.find((d) => norm(d.name) === norm(name))?.id || fallback;
      const oppIdOf = (name: string, fallback: string) =>
        oppDefs.find((d) => norm(d.name) === norm(name))?.id || fallback;
      /** First field whose name matches any of these. "" when none exists. */
      const anyOf = (
        defs: { id: string; name: string }[],
        names: readonly string[],
      ) => defs.find((d) => names.some((n) => norm(d.name) === norm(n)))?.id || "";

      const F = {
        recordType: idOf(PARTNER_FIELDS.recordType.name, PARTNER_FIELDS.recordType.id),
        category: idOf(PARTNER_FIELDS.category.name, PARTNER_FIELDS.category.id),
        tier: idOf(PARTNER_FIELDS.tier.name, PARTNER_FIELDS.tier.id),
        division: idOf(PARTNER_FIELDS.division.name, PARTNER_FIELDS.division.id),
        notes: idOf(PARTNER_FIELDS.notes.name, PARTNER_FIELDS.notes.id),
        outcome: idOf(ATTENDEE_FIELDS.outcome.name, ATTENDEE_FIELDS.outcome.id),
        profile: idOf(ATTENDEE_FIELDS.profile.name, ATTENDEE_FIELDS.profile.id),
      };

      // 🔴 THE HOLE IN THE DATA MODEL, AND IT IS NOT MINE TO FILL BY GUESSING.
      //
      // The brief gives an attendee four facts (Record Type, Event Outcome,
      // Attendee Profile, and a folder) and NONE of them says WHICH EVENT they
      // attended. The same is true of a client opportunity: `Referring Partner`
      // points at a partner, and nothing points at an event. So "who attended
      // this event, and what came of it" cannot be computed from what exists.
      //
      // Rather than inventing an attribution, this looks for a field by NAME.
      // The moment somebody creates "Event Attended" on the contact (holding the
      // event opportunity's id, exactly as `Referring Partner` holds a contact
      // id), every per-event number below starts working with NO code change.
      // Until then the Events tab says what is missing and shows what it can.
      const attendeeEventField = anyOf(contactDefs, ATTENDEE_EVENT_FIELD_NAMES);
      const oppEventField = anyOf(oppDefs, OPP_EVENT_FIELD_NAMES);
      const eventHostField = anyOf(oppDefs, EVENT_HOST_FIELD_NAMES);

      // 🔴 THE OPTION LISTS COME FROM GOHIGHLEVEL, NOT FROM THIS CODEBASE.
      // Settled in round 101: three copies of the category list existed (16 in
      // the prototype, 17 in the brief, 19 on the live field) because each was
      // somebody's transcription of another. Reading the field's own options
      // removes the reconciliation problem rather than solving it once.
      const optionsOf = (
        defs: { id: string; name: string; options?: string[] }[],
        name: string,
      ) => defs.find((d) => norm(d.name) === norm(name))?.options || [];

      // ── one partner's touch history, for the drawer ────────────────────────
      // ⚠️ TWO PROVEN CALLS AND NOT THE UNVERIFIED ONE. Checking the id against
      // the search would make the drawer fail wherever the search filter fails;
      // reading the contact's own Record Type is the same one request and is a
      // call this app already makes in production.
      if (only === "notes") {
        const id = (url.searchParams.get("contactId") || "").trim();
        if (!id)
          return NextResponse.json(
            { error: "No partner asked for.", status: 400 } as ApiError,
            { status: 400 },
          );
        const read = await getContactCustomFields(id);
        const rt = read.values[F.recordType];
        const rtStr = Array.isArray(rt) ? rt.map(String).join(", ") : String(rt ?? "");
        if (norm(rtStr) !== norm(PARTNER_RECORD_TYPE))
          return NextResponse.json(
            {
              error: "That contact is not a referral partner.",
              detail: `Its ${PARTNER_FIELDS.recordType.name} is "${rtStr || "(not set)"}". Notes are only read here for partners.`,
              status: 403,
            } as ApiError,
            { status: 403 },
          );
        const notes = await listContactNotes(id);
        return NextResponse.json(
          { notes },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      // ── partners, by Record Type ───────────────────────────────────────────
      const partnerRes = await ghlSearchContacts(F.recordType, PARTNER_RECORD_TYPE);

      // ── touch-only: measure a batch and answer, nothing else ───────────────
      if (onlyTouch) {
        const live = new Set(partnerRes.rows.map((r) => r.id));
        const want = (autoTouch ? partnerRes.rows.map((r) => r.id) : asked).filter(
          (id) => live.has(id),
        );
        const targets = want.slice(0, TOUCH_CAP);
        const { map, failed } = await resolveTouches(targets);
        return NextResponse.json(
          {
            touch: map,
            meta: {
              touchAsked: want.length,
              touchResolved: targets.length - failed,
              touchFailed: failed,
              touchCapped: Math.max(0, want.length - targets.length),
              touchCap: TOUCH_CAP,
            },
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      const [users, attendeeRes] = await Promise.all([
        getUserMap(),
        ghlSearchContacts(F.recordType, ATTENDEE_RECORD_TYPE),
      ]);

      const partners: RawPartner[] = partnerRes.rows.map((c) => ({
        id: c.id,
        org: c.name,
        email: c.email,
        phone: c.phone,
        cat: c.fields[F.category] || "",
        tier: c.fields[F.tier] || "Prospect",
        division: c.fields[F.division] || "",
        owner: users.get(c.assignedTo) || "",
        ownerId: c.assignedTo || "",
        notes: c.fields[F.notes] || "",
        lastTouch: null, // resolved below, for the ids asked for
      }));

      // ── last touch, for the partners asked for ─────────────────────────────
      const live = new Set(partners.map((p) => p.id));
      const want = (autoTouch ? partners.map((p) => p.id) : asked).filter((id) =>
        live.has(id),
      );
      const touchTargets = want.slice(0, TOUCH_CAP);
      const { map: touchMap, failed: touchFailed } = await resolveTouches(touchTargets);
      for (const p of partners)
        if (touchMap[p.id] !== undefined) p.lastTouch = touchMap[p.id];

      // ── referrals: every client opportunity carrying a Referring Partner ───
      // ⚠️ ZERO EXTRA CALLS. `cf` already rides along on the search this app
      // makes anyway — which is why the TEXT field beat an association (report
      // 99 (a): an association costs one call per partner).
      const refField = oppIdOf("Referring Partner", REFERRING_PARTNER_FIELD);
      const { records, failedPipelines } = await getOltlOpportunities("client");

      // 🔴 WHOLE TOTALS, FILTERED DRILL-DOWN — settled, and this is the ONE
      // place the boundary is computed.
      //
      // ⚠️ NO PLUMBING NEEDED: this route already runs inside withGrants
      // (below), which installs the store getUserHomePipelines() reads — so
      // applyAccess resolves live per-user pipeline grants here exactly as it
      // does on the board.
      //
      // ⚠️ AND NO SSO MEANS NO FILTER, DELIBERATELY. On a deployment without
      // SSO configured there is no viewer to scope to, so everything is
      // visible — the same posture ssoConfigured() takes everywhere else,
      // rather than hiding every record from a session that cannot exist.
      const isAdmin = !session || isAdminSession(session.role, session.type);
      const visibleIds = new Set(
        applyAccess(records, {
          userId: session?.userId || "",
          isAdmin,
        }).map((r) => r.id),
      );

      const referrals: RawReferral[] = records
        .map((r) => ({
          id: r.id,
          partnerId: String(r.cf?.[refField] ?? "").trim(),
          status: r.status,
          value: r.monetaryValue || 0,
          ago: daysSince(r.createdAt || ""),
          eventId: oppEventField ? String(r.cf?.[oppEventField] ?? "").trim() : "",
          // ⚠️ TAGGED, NEVER FILTERED OUT HERE. Every aggregate reads the whole
          // array; only the drawer's per-record list honours this flag. See
          // RawReferral.visible for why two arrays would have been wrong.
          visible: visibleIds.has(r.id),
        }))
        .filter((o) => o.partnerId);

      // ── events ─────────────────────────────────────────────────────────────
      const evDate = oppIdOf(EVENT_FIELDS.date.name, EVENT_FIELDS.date.id);
      const evCost = oppIdOf(EVENT_FIELDS.cost.name, EVENT_FIELDS.cost.id);
      const evVenue = oppIdOf(EVENT_FIELDS.venue.name, EVENT_FIELDS.venue.id);
      const evDiv = oppIdOf(EVENT_FIELDS.division.name, EVENT_FIELDS.division.id);
      const events: RawEvent[] = evPipe
        ? records
            .filter((r) => r.pipelineId === evPipe.id)
            .map((r) => ({
              id: r.id,
              name: r.oppName || `${r.first} ${r.last}`.trim() || "Untitled event",
              stage: r.stage,
              date: String(r.cf?.[evDate] ?? ""),
              cost: Number(r.cf?.[evCost] ?? 0) || 0,
              venue: String(r.cf?.[evVenue] ?? ""),
              division: String(r.cf?.[evDiv] ?? ""),
              host: eventHostField ? String(r.cf?.[eventHostField] ?? "").trim() : "",
            }))
        : [];

      const attendees: RawAttendee[] = attendeeRes.rows.map((c) => ({
        id: c.id,
        name: c.name,
        eventId: attendeeEventField ? c.fields[attendeeEventField] || "" : "",
        outcome: c.fields[F.outcome] || "",
        profile: c.fields[F.profile] || "",
        version: c.version,
      }));

      return NextResponse.json(
        {
          partners,
          referrals,
          events,
          attendees,
          // ── everything the WRITE forms need, resolved once, server-side ────
          // ⚠️ The dialogs used to carry their own copies of these lists. A
          // dropdown offering a value the account has no option for produces a
          // save that silently drops it, which is how a partner ends up with no
          // category and nobody notices.
          // The Touch queue is a WORKLIST, not a report, so it defaults to the
          // viewer's own partners. Admins default to all — they are the ones
          // who need the whole board.
          viewer: { userId: session?.userId || "", isAdmin },
          owners: [...users.entries()].map(([id, name]) => ({ id, name })),
          categoryOptions: optionsOf(contactDefs, PARTNER_FIELDS.category.name),
          tierOptions: optionsOf(contactDefs, PARTNER_FIELDS.tier.name),
          divisionOptions: optionsOf(contactDefs, PARTNER_FIELDS.division.name),
          outcomeOptions: optionsOf(contactDefs, ATTENDEE_FIELDS.outcome.name),
          // Where "Log a referral" may file a case. 🔴 The Events pipeline is
          // EXCLUDED: an event is not a client, and offering it would let a
          // referral be filed as one.
          clientPipelines: (await getSelectedPipelines("client"))
            .filter((p) => p.id !== evPipe?.id)
            .map((p) => ({
              id: p.id,
              name: p.name,
              division: divisionLabel(p.name),
              stage: p.stages?.[0]?.name || "",
              stageId: p.stages?.[0]?.id || "",
            })),
          // ── what this answer does NOT know, said out loud ──────────────────
          meta: {
            eventsPipelineConfigured: !!evPipe,
            eventsPipelineName: evPipe?.name || "",
            /** "" when no field links an attendee to an event — see above. */
            attendeeEventField,
            oppEventField,
            eventHostField,
            /** The contact field id the outcome dropdown PATCHes. */
            outcomeField: F.outcome,
            // ⚠️ `want`, NOT `asked`. The route-proof run reported
            // "touchAsked: 0, touchResolved: 2" on a touch=auto load, because
            // `asked` is only the EXPLICIT touchFor list and auto fills none of
            // it. A screen reading that pair would have said nothing was asked
            // for and two came back.
            touchAsked: want.length,
            touchResolved: touchTargets.length - touchFailed,
            touchFailed,
            touchCapped: Math.max(0, want.length - touchTargets.length),
            touchCap: TOUCH_CAP,
            partnersTruncated: partnerRes.truncated,
            attendeesTruncated: attendeeRes.truncated,
            /** Per-contact GETs spent because search returned no field values. */
            hydrated: partnerRes.hydrated + attendeeRes.hydrated,
            unreadable: partnerRes.unreadable + attendeeRes.unreadable,
            /** A client pipeline whose fetch failed: its referrals are ABSENT. */
            failedPipelines: failedPipelines || [],
          },
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (e) {
      if (e instanceof SsoError)
        return NextResponse.json({ error: e.message, status: e.status } as ApiError, {
          status: e.status,
        });
      if (e instanceof GhlError)
        return NextResponse.json(
          {
            error: "Could not load referral partners.",
            detail: await explainGhlError(e),
          } as ApiError,
          { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
        );
      return NextResponse.json(
        { error: "Could not load referral partners.", detail: String(e) } as ApiError,
        { status: 500 },
      );
    }
  });
}

export async function POST(request: Request) {
  return withGrants(async () => {
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

      // ── log a touch ────────────────────────────────────────────────────────
      // 🔴 THE COUNTERPART TO THE QUEUE. A queue that tells you who to call and
      // gives you no way to record the call keeps telling you to call them.
      // ⚠️ A CONTACT NOTE, NOT AN OPPORTUNITY NOTE — a partner has no case, and
      // `addOpportunityNote` would file it against an opportunity id that does
      // not exist. See lib/ghl.ts → addContactNote.
      if (body.action === "log-touch") {
        const text = (body.text || "").trim();
        const contactId = (body.contactId || "").trim();
        if (!contactId)
          return NextResponse.json(
            { error: "No partner to log a touch against.", status: 400 } as ApiError,
            { status: 400 },
          );
        if (!text)
          return NextResponse.json(
            { error: "A touch needs a note saying what happened.", status: 400 } as ApiError,
            { status: 400 },
          );
        const n = await addContactNote(contactId, text, session?.userId || "");
        return NextResponse.json({
          ok: true,
          noteId: n.id,
          // The client sets lastTouch from this rather than assuming 0 — if GHL
          // stamped a different time, the queue shows GHL's time, not ours.
          dateAdded: n.dateAdded,
          lastTouch: n.dateAdded ? (daysSince(n.dateAdded) ?? 0) : 0,
        });
      }

      // ── log a referral ─────────────────────────────────────────────────────
      // 🔴 TWO WRITES, NOT THREE — and that is what removes the failure window
      // the brief asked about. `createOpportunity` already accepts
      // `customFields`, so the attribution rides on the SAME request that
      // creates the opportunity. There is no state in which an opportunity
      // exists unattributed, because there is no separate attribution write.
      //
      // ⚠️ NO `assignedTo`. Option (b), settled: the pipeline's notification
      // workflow decides who works it, one place owns that, and it already
      // works. Owning the partner and working the case are different questions.
      if (body.action === "log-referral") {
        const partnerId = (body.partnerId || "").trim();
        const who = `${(body.firstName || "").trim()} ${(body.lastName || "").trim()}`.trim();
        if (!partnerId)
          return NextResponse.json(
            { error: "A referral needs the partner who sent it.", status: 400 } as ApiError,
            { status: 400 },
          );
        if (!who)
          return NextResponse.json(
            { error: "A referral needs the client or family's name.", status: 400 } as ApiError,
            { status: 400 },
          );

        const pipelines = await getSelectedPipelines("client");
        const evPipe = await eventsPipeline();
        const choices = pipelines.filter((p) => p.id !== evPipe?.id);
        // 🔴 RESOLVED, NEVER HARDCODED. The brief says "creates an opportunity
        // in Private Pay"; section 9 forbids hardcoded pipeline ids. So the
        // destination is the one the CALLER picked, and the fallback is matched
        // by divisionLabel() — the same derivation the whole app uses.
        const dest =
          choices.find((p) => p.id === (body.pipelineId || "").trim()) ||
          choices.find(
            (p) => norm(divisionLabel(p.name)) === norm((body.division || "Private Pay").trim()),
          ) ||
          choices.find((p) => /private\s*pay/i.test(p.name));
        // 🔴 TWO DIFFERENT FAILURES, AND ONE MESSAGE WAS LYING ABOUT BOTH.
        //
        // This said "There is no client pipeline to file this referral in" for
        // BOTH cases. The route-proof run hit it with an account that had an
        // OLTL pipeline and no Private Pay one — so the dashboard refused the
        // referral while telling the user there was nowhere to put it, with a
        // perfectly good pipeline sitting right there. Say which it is.
        if (!dest)
          return NextResponse.json(
            choices.length
              ? {
                  error: "Choose where to file this referral.",
                  detail: `Nothing was created. No client pipeline matches ${body.division ? `the partner's division (${body.division})` : "Private Pay"}, so the destination has to be picked: ${choices.map((p) => p.name).join(", ")}.`,
                  status: 409,
                }
              : {
                  error: "There is no client pipeline to file this referral in.",
                  detail:
                    "Nothing was created. Give a pipeline client scope in Admin → Pipelines, then log the referral.",
                  status: 409,
                },
            { status: 409 },
          );
        const stageId = dest.stages?.[0]?.id || "";
        if (!stageId)
          return NextResponse.json(
            {
              error: `"${dest.name}" has no stages.`,
              detail: "Nothing was created. Add a stage in GoHighLevel, then log the referral.",
              status: 409,
            } as ApiError,
            { status: 409 },
          );

        // WRITE 1 — the client's contact.
        const contact = await upsertContact({
          firstName: (body.firstName || "").trim(),
          lastName: (body.lastName || "").trim(),
          name: who,
          ...(body.phone ? { phone: body.phone.trim() } : {}),
          ...(body.email ? { email: body.email.trim() } : {}),
        });
        if (!contact.id)
          return NextResponse.json(
            {
              error: "Could not create the client's contact.",
              detail: "GoHighLevel returned no contact id. Nothing else was created.",
              status: 502,
            } as ApiError,
            { status: 502 },
          );

        // WRITE 2 — the opportunity, WITH the attribution in the same request.
        const oppDefs = await getEditableFieldDefs("opportunity");
        const refId =
          oppDefs.find((d) => norm(d.name) === norm("Referring Partner"))?.id ||
          REFERRING_PARTNER_FIELD;
        const cf: { id: string; value: unknown }[] = [{ id: refId, value: partnerId }];
        // The event that produced this client, when the form was opened from one.
        const evField = oppDefs.find((d) =>
          OPP_EVENT_FIELD_NAMES.some((n) => norm(d.name) === norm(n)),
        )?.id;
        if (evField && (body.eventId || "").trim())
          cf.push({ id: evField, value: (body.eventId || "").trim() });

        // ⚠️ MONTHLY RECURRING, AND IT IS A REP'S INPUT. The brief is explicit:
        // the rep types the estimated monthly value at referral time. Stored in
        // the native monetaryValue, which every figure in this view labels /mo.
        const monthly = Number(body.monthlyValue ?? 0) || 0;
        let oppId = "";
        try {
          oppId = await createOpportunity({
            pipelineId: dest.id,
            stageId,
            contactId: contact.id,
            name: who,
            ...(monthly > 0 ? { monetaryValue: monthly } : {}),
            customFields: cf,
          });
        } catch (e) {
          // 🔴 SAY WHAT SURVIVED — round 94's rule, and the partner's stake in
          // it is the part a generic message would lose.
          const detail = e instanceof GhlError ? await explainGhlError(e) : String(e);
          return NextResponse.json(
            {
              error: "The referral was not recorded.",
              detail: `${detail} — The client's contact WAS created, so nothing is lost and they are not a duplicate. But the referral is not recorded, and this partner will not be credited for it until it is. Check "${dest.name}" in GoHighLevel before retrying, so you don't create a second contact.`,
              survived: "The client's contact was created.",
              status: 502,
            } as ApiError & { survived: string },
            { status: 502 },
          );
        }
        if (!oppId)
          return NextResponse.json(
            {
              error: "The referral was not recorded.",
              detail: `GoHighLevel returned no opportunity id. The client's contact WAS created — they are not a duplicate — but the referral is not recorded and this partner will not be credited for it. Check "${dest.name}" in GoHighLevel before retrying.`,
              survived: "The client's contact was created.",
              status: 502,
            } as ApiError & { survived: string },
            { status: 502 },
          );

        // The note is a third write, and it is DELIBERATELY last and optional:
        // losing "what was said" must never lose the referral itself.
        let noteSaved = true;
        if ((body.text || "").trim())
          try {
            await addContactNote(contact.id, (body.text || "").trim(), session?.userId || "");
          } catch {
            noteSaved = false;
          }

        await emit(
          "opportunity.created",
          { actor: { userId: session?.userId || "" }, opportunityId: oppId, contactId: contact.id },
          { pipelineId: dest.id, pipelineName: dest.name, stageId, name: who, source: "Referral" },
        );
        return NextResponse.json({
          ok: true,
          contactId: contact.id,
          opportunityId: oppId,
          pipelineName: dest.name,
          stageName: dest.stages?.[0]?.name || "",
          monthly,
          noteSaved,
        });
      }

      // ── add someone met at an event ────────────────────────────────────────
      // 🔴 A FIRST NAME OR A PHONE IS REQUIRED, AND THAT IS YOUR CALL, NOT MINE
      // TO SOFTEN. The brief's three fields (profile, outcome, note) would have
      // created a contact with no identifying detail at all: GoHighLevel may
      // refuse it outright, and if it does not, the record is UNDEDUPABLE — the
      // same person met at two events becomes two contacts for ever, and bulk
      // import multiplies that by however many were met.
      if (body.action === "add-attendee") {
        const firstName = (body.firstName || "").trim();
        const phone = (body.phone || "").trim();
        if (!firstName && !phone)
          return NextResponse.json(
            {
              error: "An attendee needs a first name or a phone number.",
              detail:
                "Without one there is no way to recognise this person the next time they are met, and they would be added a second time instead.",
              status: 400,
            } as ApiError,
            { status: 400 },
          );
        const defs = await getEditableFieldDefs("contact");
        const cf: { id: string; value: unknown }[] = [];
        const missing: string[] = [];
        const put = (name: string, fallbackId: string, value: string) => {
          if (!value) return;
          const def =
            defs.find((d) => norm(d.name) === norm(name)) ||
            defs.find((d) => d.id === fallbackId);
          if (!def) {
            missing.push(name);
            return;
          }
          const opts = def.options || [];
          const m = opts.length ? opts.find((o) => norm(o) === norm(value)) : value;
          if (m) cf.push({ id: def.id, value: m });
          else missing.push(`${name} has no option "${value}"`);
        };
        put(PARTNER_FIELDS.recordType.name, PARTNER_FIELDS.recordType.id, ATTENDEE_RECORD_TYPE);
        put(ATTENDEE_FIELDS.profile.name, ATTENDEE_FIELDS.profile.id, (body.profile || "").trim());
        put(ATTENDEE_FIELDS.outcome.name, ATTENDEE_FIELDS.outcome.id, (body.outcome || "").trim());
        // The join. Without the field the attendee is still created — they are
        // simply not attributable to the event, which the Events tab already
        // says out loud rather than implying nobody came.
        const evDef = defs.find((d) =>
          ATTENDEE_EVENT_FIELD_NAMES.some((n) => norm(d.name) === norm(n)),
        );
        if (evDef && (body.eventId || "").trim())
          cf.push({ id: evDef.id, value: (body.eventId || "").trim() });
        else if (!evDef) missing.push("the field linking an attendee to an event");

        const c = await upsertContact({
          firstName,
          lastName: (body.lastName || "").trim(),
          name: `${firstName} ${(body.lastName || "").trim()}`.trim() || phone,
          ...(phone ? { phone } : {}),
          ...(body.email ? { email: body.email.trim() } : {}),
          ...(cf.length ? { customFields: cf } : {}),
        });
        if (!c.id)
          return NextResponse.json(
            { error: "GoHighLevel returned no contact id.", status: 502 } as ApiError,
            { status: 502 },
          );
        let noteSaved = true;
        if ((body.text || "").trim())
          try {
            await addContactNote(c.id, (body.text || "").trim(), session?.userId || "");
          } catch {
            noteSaved = false;
          }
        return NextResponse.json({ ok: true, contactId: c.id, skipped: missing, noteSaved });
      }

      // ── add a partner ──────────────────────────────────────────────────────
      if (body.action === "add-partner") {
        const org = (body.org || "").trim();
        if (!org)
          return NextResponse.json(
            { error: "A partner needs an organisation name.", status: 400 } as ApiError,
            { status: 400 },
          );
        const defs = await getEditableFieldDefs("contact");
        const cf: { id: string; value: unknown }[] = [];
        const missing: string[] = [];
        const put = (name: string, fallbackId: string, value: string) => {
          if (!value) return;
          const def =
            defs.find((d) => norm(d.name) === norm(name)) ||
            defs.find((d) => d.id === fallbackId);
          if (!def) {
            missing.push(name);
            return;
          }
          const opts = def.options || [];
          const m = opts.length ? opts.find((o) => norm(o) === norm(value)) : value;
          if (m) cf.push({ id: def.id, value: m });
          else missing.push(`${name} has no option "${value}"`);
        };
        put(PARTNER_FIELDS.recordType.name, PARTNER_FIELDS.recordType.id, PARTNER_RECORD_TYPE);
        put(PARTNER_FIELDS.category.name, PARTNER_FIELDS.category.id, body.category || "");
        put(PARTNER_FIELDS.tier.name, PARTNER_FIELDS.tier.id, body.tier || "");
        put(PARTNER_FIELDS.division.name, PARTNER_FIELDS.division.id, body.division || "");
        put(PARTNER_FIELDS.notes.name, PARTNER_FIELDS.notes.id, body.notes || "");

        // 🔴 RECORD TYPE IS NOT OPTIONAL. It is the ONLY thing that makes this
        // contact a partner — without it the contact is created and then never
        // appears in this dashboard again, which looks exactly like the add
        // having failed. Refuse before writing rather than after.
        if (!cf.some((f) => f.id === (defs.find((d) => norm(d.name) === norm(PARTNER_FIELDS.recordType.name))?.id || PARTNER_FIELDS.recordType.id)))
          return NextResponse.json(
            {
              error: `This account has no "${PARTNER_FIELDS.recordType.name}" option for "${PARTNER_RECORD_TYPE}".`,
              detail: `Nothing was created. Add "${PARTNER_RECORD_TYPE}" as an option on the "${PARTNER_FIELDS.recordType.name}" contact field in GoHighLevel, then add the partner — a contact without it would be saved and then never show up here.`,
              status: 409,
            } as ApiError,
            { status: 409 },
          );

        // 🔴 A CONTACT AND NOTHING ELSE. A partner is not a case.
        const c = await upsertContact({
          firstName: (body.firstName || "").trim(),
          lastName: (body.lastName || "").trim(),
          name: org,
          ...(body.email ? { email: body.email.trim() } : {}),
          ...(body.phone ? { phone: body.phone.trim() } : {}),
          // 🔴 THE OWNER IS THE POINT OF THE FIELD, per the brief: "who holds
          // this relationship. Drives who sees it and whose queue it lands in."
          ...(body.owner ? { assignedTo: body.owner.trim() } : {}),
          ...(cf.length ? { customFields: cf } : {}),
        });
        if (!c.id)
          return NextResponse.json(
            { error: "GoHighLevel returned no contact id.", status: 502 } as ApiError,
            { status: 502 },
          );
        return NextResponse.json({
          ok: true,
          contactId: c.id,
          // Fields this account does not have. The partner WAS created; saying
          // which values were dropped beats letting them go missing quietly.
          skipped: missing,
        });
      }

      return NextResponse.json(
        { error: "Unknown action.", status: 400 } as ApiError,
        { status: 400 },
      );
    } catch (e) {
      if (e instanceof SsoError)
        return NextResponse.json({ error: e.message, status: e.status } as ApiError, {
          status: e.status,
        });
      if (e instanceof GhlError)
        return NextResponse.json(
          { error: "Could not save.", detail: await explainGhlError(e) } as ApiError,
          { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
        );
      return NextResponse.json(
        { error: "Could not save.", detail: String(e) } as ApiError,
        { status: 500 },
      );
    }
  });
}
