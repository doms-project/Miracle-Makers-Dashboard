import { NextResponse } from "next/server";
import {
  getSelectedPipelines,
  entryStage,
  getPipelineConfig,
  getOpportunitiesInPipeline,
  listPipelines,
  firstStage,
  getEditableFieldDefs,
  getOltlOpportunities,
  upsertContact,
  ensureContact,
  createOpportunity,
  latestContactNoteAt,
  listContactNotes,
  addContactNote,
  getContactCustomFields,
  ghlSearchContacts,
  searchContacts,
  updateContactCustomFields,
  setContactOwner,
  getUserMap,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { mapLimit } from "@/lib/concurrency";
import { divisionLabel } from "@/lib/division";
import {
  applyAccess,
  getUserHomePipelines,
  referralDivisions,
  referralScopeKind,
} from "@/lib/pipelineAccess";
import { isAdminSession } from "@/lib/visibility";
import { emit } from "@/lib/webhooks";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { withGrants } from "@/lib/withGrants";
import { pipelineWithRole } from "@/lib/pipelineConfig";
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
  OPP_EVENT_FIELD_ID,
  EVENT_HOST_FIELD_ID,
  composeTouch,
  parseTouch,
  ALL_DIVISIONS,
  danglingReferrals,
  type RawPartner,
  type RawReferral,
  type RawEvent,
  type RawAttendee,
} from "@/lib/referrals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 TRIM FIRST, THEN TEST. The optional contact fields were written as
//
//     ...(body.email ? { email: body.email.trim() } : {})
//
// which TESTS THE RAW VALUE AND SENDS THE TRIMMED ONE. A field holding only
// spaces is truthy, trims to "", and GoHighLevel answers
//
//     422 POST /contacts/upsert — email must be an email
//
// 🔴 AND THE ORGANISATION CASE MADE THAT THE DEFAULT PATH. "Add partner → New
// organisation" has no reason to carry an email, the comment at the promote
// branch says so out loud ("an organisation with neither"), and a form field
// that has been focused and left is not necessarily empty — one stray space is
// enough. So the most ordinary way to use the feature was the failing one.
//
// `clean` is the whole fix: whitespace-only is ABSENT, not empty. Every optional
// string sent to GoHighLevel goes through it.
// ═══════════════════════════════════════════════════════════════════════════
const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

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
  action?:
    | "add-partner"
    | "log-touch"
    | "log-referral"
    | "add-attendee"
    | "add-event"
    /** ITEM 15 — READS, by POST, so a contact id stays out of the URL. */
    | "contact-opps"
    | "partner-notes"
    /** ROUND 123 — and this one carried up to SIXTY of them. */
    | "touch"
    /** ROUND 124 — an attendee's Event Outcome / Event Attended. */
    | "attendee-field";
  contactId?: string;
  /** The explicit "measure the next 60" batch. Contact ids, intersected server-side. */
  touchFor?: unknown[];
  /** attendee-field — which of the two, and what to write. */
  field?: string;
  value?: unknown;
  expectedVersion?: string;
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
  /** add-event — `org` carries the event name, `partnerId` the host. */
  eventDate?: string;
  venue?: string;
  cost?: number;
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
/**
 * A custom field's picklist options, by field NAME.
 *
 * ⚠️ ROUND 168 — HOISTED TO MODULE SCOPE. It was a local const inside the GET
 * handler, and the POST's division guard needs the same list: a write refused
 * against one allow-list while the heading was built from another would be two
 * answers to one question. One definition, both handlers.
 */
const optionsOf = (
  defs: { id: string; name: string; options?: string[] }[],
  name: string,
): string[] => defs.find((d) => norm(d.name) === norm(name))?.options || [];

async function eventsPipeline(): Promise<{
  pipe: { id: string; name: string; stages: { id: string; name: string; position?: number }[] } | undefined;
  /** How it was found, so the screen can say what to fix. */
  via: "role" | "name" | "none";
}> {
  // 🔴 ROUND 124 · ITEM 2 — BY ID FROM THE CONFIG FIRST, BY NAME ONLY AFTER.
  //
  // This was `/^events?$/i` against the trimmed NAME across the client and
  // "none" pickers, and that is the last string-matched pipeline lookup in the
  // app. It breaks two ways, both silently:
  //
  //   a rename        "Events & Outreach" matches nothing; the tab empties
  //   a scope change  an admin setting it to CAREGIVER — which the Pipelines
  //                   screen offers — removes it from both searches
  //
  // ⚠️ AND THE NAME MATCH IS KEPT, NOT REPLACED. Nobody has set the role yet,
  // so removing the fallback would empty the tab today and keep it empty until
  // an admin happened to visit a settings screen. The role wins when it is set;
  // the name answers until then; and `via` says which, so the tab can tell
  // "nobody has marked it" apart from "nothing is named Events".
  const [cfg, all] = await Promise.all([getPipelineConfig(), listPipelines()]);
  const byRole = pipelineWithRole(cfg, "events");
  if (byRole) {
    const hit = all.find((p) => p.id === byRole);
    // ⚠️ A ROLE POINTING AT A PIPELINE THAT NO LONGER EXISTS IS NOT A MATCH,
    // and it must not fall through to the name search either: silently finding
    // a different pipeline than the one an admin marked is worse than saying
    // nothing was found.
    if (hit) return { pipe: hit, via: "role" };
    return { pipe: undefined, via: "none" };
  }
  // ⚠️ CLIENT **AND** "none" — round 116, item K. Events is scoped `client`
  // today ONLY so this lookup can find it; the moment an admin sets it to
  // "listed by no picker" a client-only search returns undefined.
  const [client, unlisted] = await Promise.all([
    getSelectedPipelines("client"),
    getSelectedPipelines("none"),
  ]);
  const named = [...client, ...unlisted].find((p) => /^events?$/i.test(p.name.trim()));
  return named ? { pipe: named, via: "name" } : { pipe: undefined, via: "none" };
}

/**
 * 🔴 ITEM 15 — ONE IMPLEMENTATION, REACHED BY POST.
 *
 * The cases held by one contact, filtered by what this viewer may see. Lifted
 * out of the GET handler so there is exactly one copy: two copies of an access
 * filter is how one of them ends up missing it.
 *
 * ⚠️ THE ACCESS FILTER IS THE LOAD-BEARING PART. A contact id arrives from the
 * browser, and without `applyAccess` anyone could list opportunities they may
 * not see by typing a name into a picker.
 */
async function contactOpps(
  cid: string,
  session: { userId?: string; role?: string; type?: string } | null,
  isAdmin: boolean,
): Promise<NextResponse> {
  // ⚠️ `.records` — getOltlOpportunities returns the whole payload shape
  // (records plus pipelines, stages, users, defs), not a bare array.
  const { records: all } = await getOltlOpportunities();
  const refId =
    (await getEditableFieldDefs("opportunity")).find(
      (d) => norm(d.name) === norm("Referring Partner"),
    )?.id || REFERRING_PARTNER_FIELD;
  const mine = applyAccess(all, { userId: session?.userId || "", isAdmin });
  return NextResponse.json(
    {
      referringPartnerField: refId,
      opportunities: mine
        .filter((r) => r.contactId === cid)
        .map((r) => ({
          id: r.id,
          name: r.oppName || `${r.first} ${r.last}`.trim() || "Untitled case",
          pipelineName: r.pipelineName,
          stage: r.stage,
          status: r.status,
          /** Already attributed? The picker says so rather than silently overwriting. */
          partnerId: String(r.cf?.[refId] ?? "").trim(),
        })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * 🔴 ROUND 123 — "MEASURE THE NEXT 60", REACHED BY POST.
 *
 * ⚠️ AND THIS IS A CORRECTION OF SOMETHING I REPORTED AS DONE. Round 122 said
 * every contact id was out of every URL and the proof agreed. It was wrong:
 * this call sent up to sixty of them at once in
 * `?only=touch&touchFor=c1,c2,…`, the single largest id exposure on the
 * screen, and the assertion that cleared it could not have seen it — the
 * regex required `${encodeURIComponent(<no brackets>)}` and the argument here
 * is `ids.join(",")`, which contains one. The same shape as `ghlSend<[^>]*>`
 * never matching a generic. The check is fixed in the same commit as the call.
 *
 * ⚠️ THE INTERSECTION WITH THE LIVE PARTNER LIST IS THE SECURITY HALF and it
 * is unchanged: the ids arrive from a browser, and a route that reads notes off
 * any contact id handed to it is a way to read notes off contacts this view has
 * nothing to do with.
 */
async function measureTouches(
  asked: string[],
  F: { recordType: string },
): Promise<NextResponse> {
  const partnerRes = await ghlSearchContacts(F.recordType, PARTNER_RECORD_TYPE);
  const live = new Set(partnerRes.rows.map((r) => r.id));
  const want = asked.filter((id) => live.has(id));
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

/**
 * One partner's touch history. ITEM 15 — reached by POST so the contact id
 * stays out of the URL; the partner check is unchanged.
 */
async function partnerNotes(id: string, F: { recordType: string }): Promise<NextResponse> {
  const read = await getContactCustomFields(id);
  const rt = read.values[F.recordType];
  const rtStr = Array.isArray(rt) ? rt.map(String).join(", ") : String(rt ?? "");
  // ⚠️ A PARTNER CHECK, NOT AN ACCESS ONE, and it stays. Notes are read here
  // only for partners; a contact id from the browser must not become a way to
  // read anyone's notes.
  if (norm(rtStr) !== norm(PARTNER_RECORD_TYPE))
    return NextResponse.json(
      {
        error: "That contact is not a referral partner.",
        detail: `Its ${PARTNER_FIELDS.recordType.name} is "${rtStr || "(not set)"}". Notes are only read here for partners.`,
        status: 403,
        refusal: true,
      } as ApiError,
      { status: 403 },
    );
  const notes = (await listContactNotes(id)).map((n) => {
    const { type, text } = parseTouch(n.txt);
    return { ...n, type, txt: text };
  });
  return NextResponse.json({ notes }, { headers: { "Cache-Control": "no-store" } });
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
      //   touch=auto — the first TOUCH_CAP partners, for the first load
      //
      // 🔴 ROUND 123 — `touchFor=a,b,c` IS GONE FROM HERE. An explicit batch is
      // a POST now (`action: "touch"`), because it carried up to sixty contact
      // ids in a query string. Removed rather than deprecated: leaving the GET
      // form means an id can still reach a log by whichever caller forgot.
      const autoTouch = url.searchParams.get("touch") === "auto";
      const only = url.searchParams.get("only") || "";
      /** Either cheap mode — neither needs opportunity fields or the events pipeline. */
      const light = only === "notes" || only === "contacts" || only === "partners";

      const contactDefs = await getEditableFieldDefs("contact");
      // ⚠️ NOT FETCHED IN touch-only MODE. Measuring the next batch of partners
      // has nothing to do with opportunity fields or the Events pipeline, and
      // reading them anyway is how a cheap request stops being cheap.
      const [oppDefs, evFound] = light
        ? ([[], { pipe: undefined, via: "none" as const }] as [
            typeof contactDefs,
            Awaited<ReturnType<typeof eventsPipeline>>,
          ])
        : await Promise.all([
            getEditableFieldDefs("opportunity"),
            eventsPipeline(),
          ]);
      const evPipe = evFound.pipe;

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
      // ⚠️ NAME FIRST, THE CONFIRMED ID AS A CROSS-CHECK — the same rule every
      // other field on this screen follows. The ids exist now, so a rename in
      // GoHighLevel degrades to the id rather than to nothing.
      const oppEventField =
        anyOf(oppDefs, OPP_EVENT_FIELD_NAMES) ||
        (oppDefs.some((d) => d.id === OPP_EVENT_FIELD_ID) ? OPP_EVENT_FIELD_ID : "");
      const eventHostField =
        anyOf(oppDefs, EVENT_HOST_FIELD_NAMES) ||
        (oppDefs.some((d) => d.id === EVENT_HOST_FIELD_ID) ? EVENT_HOST_FIELD_ID : "");

      // 🔴 THE OPTION LISTS COME FROM GOHIGHLEVEL, NOT FROM THIS CODEBASE.
      // Settled in round 101: three copies of the category list existed (16 in
      // the prototype, 17 in the brief, 19 on the live field) because each was
      // somebody's transcription of another. Reading the field's own options
      // removes the reconciliation problem rather than solving it once.

      // ── free-text contact search, for "+ Add partner → existing contact" ──
      // 🔴 949 CONTACTS ALREADY EXIST. Without this the first thing this
      // feature does is create a second copy of a person who enquired last
      // year, or a caregiver's relative who works at a hospital.
      // ⚠️ `searchContacts` is the PROVEN free-text call (lib/ghl.ts) — NOT the
      // custom-field filter, which is the one unverified request in this
      // feature. A picker that fails because of that would be a bad trade.
      if (only === "contacts") {
        const q = (url.searchParams.get("q") || "").trim();
        if (q.length < 2) return NextResponse.json({ contacts: [] });
        return NextResponse.json(
          { contacts: await searchContacts(q) },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      // ── one contact's opportunities, for "attribute an existing lead" ─────
      // 🔴 NO NEW GoHighLevel CALL. The full-payload branch below already
      // fetches every opportunity this viewer may see; this mode reuses that
      // work and filters by contactId. A per-contact opportunity search would
      // be a request per keystroke-chosen contact against a 100-per-10s budget,
      // to learn something already in memory.
      // 🔴 ITEM 15 — THE GET FORM IS GONE. Its body lives in `contactOpps()`
      // below and is reached by POST, so the contact id never enters a URL.
      // Removed rather than deprecated: leaving it would mean an id can still
      // reach a log by whichever caller forgot to change.

      // ── just the partners, for the "Referred by" picker on a client record ─
      // ⚠️ ONE search call and nothing else: no notes, no opportunity sweep.
      // The client panel needs names to choose from, not a scorecard.
      if (only === "partners") {
        const rt = idOf(PARTNER_FIELDS.recordType.name, PARTNER_FIELDS.recordType.id);
        const catId = idOf(PARTNER_FIELDS.category.name, PARTNER_FIELDS.category.id);
        const divId = idOf(PARTNER_FIELDS.division.name, PARTNER_FIELDS.division.id);
        // 🔴 TASK 2 · SECTION 4 — THE SECOND LIST, AND IT GETS THE SAME TEST.
        //
        // This feeds the "Referred by" picker on a client record. It was the
        // other unfiltered partner list, and two lists disagreeing about who
        // may see whom is a second source of truth — the picker would have
        // offered a partner the Referrals tab withholds, by name.
        //
        // ⚠️ `assignedTo` IS NOW IN THE PROJECTION. Without it the ownership
        // arm below cannot run here, and the two lists would agree on division
        // and differ on ownership — which is the same disagreement, smaller.
        const [res, pipesForPicker] = await Promise.all([
          ghlSearchContacts(rt, PARTNER_RECORD_TYPE),
          listPipelines(),
        ]);
        const pickerAdmin = !session || isAdminSession(session.role, session.type);
        // 🔴 ROUND 161 — the resolver, not `userDivisions`. Same `null = all`
        // convention, so this reads identically; what changed is that an admin
        // can now override the derived answer per user. Absent = derived.
        // ⚠️ ROUND 168 — THE ALLOW-LIST GOES TO THIS PICKER TOO. Two lists
        // disagreeing about who may see whom is a second source of truth, which
        // is the fault round 143 closed on exactly this picker.
        const pickerDivisions = referralDivisions(
          session?.userId || "",
          new Map(pipesForPicker.map((p) => [p.id, p.name])),
          pickerAdmin,
          optionsOf(await getEditableFieldDefs("contact"), PARTNER_FIELDS.division.name),
        );
        const rows = res.rows
          .map((c) => ({
            id: c.id,
            org: c.name,
            cat: c.fields[catId] || "",
            division: c.fields[divId] || "",
            ownerId: c.assignedTo || "",
          }))
          .filter((p) => {
            const d = (p.division || "").trim();
            if (!pickerDivisions || !d || d === ALL_DIVISIONS) return true;
            return pickerDivisions.includes(d) || p.ownerId === (session?.userId || "");
          });
        return NextResponse.json(
          {
            partners: rows,
            truncated: res.truncated,
            /** Same honesty as the full list — a count, never the names. */
            withheld: res.rows.length - rows.length,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      // ── one partner's touch history, for the drawer ────────────────────────
      // ⚠️ TWO PROVEN CALLS AND NOT THE UNVERIFIED ONE. Checking the id against
      // the search would make the drawer fail wherever the search filter fails;
      // reading the contact's own Record Type is the same one request and is a
      // call this app already makes in production.
      // 🔴 ITEM 15 — THE GET FORM IS GONE HERE TOO. Its body is
      // `partnerNotes()` above, reached by POST, so a partner's contact id
      // never enters a URL. This one was missed on the first pass and the proof
      // found it: an id-in-a-URL check has to read what is SENT, not what was
      // intended to be fixed.

      // ── partners, by Record Type ───────────────────────────────────────────
      const partnerRes = await ghlSearchContacts(F.recordType, PARTNER_RECORD_TYPE);

      // ⚠️ HOISTED ABOVE THE PARTNER BLOCK — task 2 · §4 needs it there, and it
      // depends on nothing but `session`. It used to sit beside the referral
      // filter two hundred lines down, which is why the first build of this
      // section failed to compile rather than quietly reading undefined.
      const isAdmin = !session || isAdminSession(session.role, session.type);
      const [users, attendeeRes, allPipes] = await Promise.all([
        getUserMap(),
        ghlSearchContacts(F.recordType, ATTENDEE_RECORD_TYPE),
        // ⚠️ `listPipelines`, NOT `getSelectedPipelines("client")`. A viewer's
        // HOME pipelines are whatever the access map grants them, which need
        // not be client-scoped — a recruiter holds applicant pipelines. Naming
        // only the client ones would read those grants as no division at all.
        // It is memoised (cache.pipelines), so this costs no extra request.
        listPipelines(),
      ]);
      const pipelineNameById = new Map(allPipes.map((p) => [p.id, p.name]));

      const allPartners: RawPartner[] = partnerRes.rows.map((c) => ({
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
        shared: false, // decided by partnerScope below
        lastTouch: null, // resolved below, for the ids asked for
      }));

      // ═══════════════════════════════════════════════════════════════════
      // 🔴 THE STANDING RULE, AND IT IS WRITTEN HERE BECAUSE HERE IS WHERE IT
      // IS BROKEN:
      //
      //   A ROUTE THAT STARTS FILTERING A LIST OWES ITS CONSUMERS A COUNT, IN
      //   THE SAME CHANGE — AND THE SWEEP FOR CONSUMERS IS PART OF THAT CHANGE.
      //
      // Three defects have come from ignoring it, all one shape: a client-side
      // emptiness test that meant "the account has none" before a filter
      // existed and means "you may see none" after it.
      //
      //   danglingReferrals   a withheld partner read as a DELETED one
      //   the Sources table   "No referral partners yet · add one"  on 5
      //   ReferredBy          the same sentence, and following its advice
      //                       creates a duplicate of a partner you cannot see
      //
      // 🔴 THE CLIENT CANNOT RECOVER THE DISTINCTION. It receives only what it
      // may see, so "absent" is all it can observe. Every one of those three is
      // fixable only because a count travels beside the list — and the third
      // stayed broken for two rounds because the count was sent and never read.
      //
      // ⚠️ THE COROLLARY, WHICH IS WHAT MAKES THE RULE CHEAP: count the
      // consumers BEFORE you filter. `/api/referrals` has exactly two
      // (ReferralsSection and ReferredBy), so its sweep is ten minutes. A list
      // with twenty consumers is a round of its own, and knowing that up front
      // is the difference between scheduling it and discovering it.
      // ═══════════════════════════════════════════════════════════════════

      // ═══ TASK 2 · SECTION 4 — PARTNER ROWS GET AN ACCESS TEST ══════════════
      //
      // 🔴 THEY HAD NONE AT ALL. Round 100 found `isMine` only in the touch
      // queue; every viewer received every partner contact on the account —
      // name, email, phone, owner and notes. Partners are CONTACTS, so
      // applyAccess (which takes OpportunityRecord[]) never reached them.
      //
      // ⚠️ AND THE SCOPE IS DIVISION, NOT OWNERSHIP. `visible` on a referral is
      // an ownership flag and round 122 settled that aggregates must not be cut
      // by it. This is a different question — which PROGRAMME's partners you
      // work with — and it has a different answer.
      // 🔴 ROUND 168 — NARROWED TO WHAT A PARTNER CAN ACTUALLY BE LABELLED
      // WITH. `contactDefs` is already read at the top of this handler, so this
      // costs no request. See the banner on referralDivisions.
      const partnerDivisionOptions = optionsOf(contactDefs, PARTNER_FIELDS.division.name);
      const partnerDivisions = referralDivisions(
        session?.userId || "",
        pipelineNameById,
        isAdmin,
        partnerDivisionOptions,
      );
      const scoped = allPartners.map((p) => {
        // Blank and "All" are UNIVERSAL FOR DISPLAY — see inDivision, and the
        // decision recorded there. Blank is counted below rather than hidden.
        const d = (p.division || "").trim();
        const mine = !partnerDivisions || !d || d === ALL_DIVISIONS || partnerDivisions.includes(d);
        // 🔴 THE `shared` HALF, and it is the exact parallel to applyAccess
        // admitting an owned record from ANY pipeline (lib/pipelineAccess.ts:143):
        // a rep who OWNS an ODP partner while holding only Private Pay must
        // still see that partner. Withholding it would hide their own work.
        const owned = !!p.ownerId && p.ownerId === (session?.userId || "");
        return { p, visible: mine || owned, shared: !mine && owned };
      });
      const partners: RawPartner[] = scoped
        .filter((s) => s.visible)
        .map((s) => ({ ...s.p, shared: s.shared }));
      /** Withheld from THIS viewer. A count, never the names. */
      const partnersWithheld = allPartners.length - partners.length;
      /**
       * 🔴 PARTNERS WITH NO DIVISION AT ALL — THE LABELLED LEAK.
       *
       * Blank matches every division, so an uncategorised partner reaches every
       * viewer. That is deliberate: hiding it would mean nobody ever notices it
       * needs a division, and it fights the touch queue's rule that unclaimed
       * relationships surface rather than hide.
       *
       * ⚠️ SO IT IS COUNTED AND SAID, not closed. What closes it is the create
       * dialog now REQUIRING a division, which stops the set growing — this
       * number should shrink to zero and stay there.
       */
      const partnersNoDivision = allPartners.filter((p) => !(p.division || "").trim()).length;

      // ── last touch, for the partners asked for ─────────────────────────────
      const live = new Set(partners.map((p) => p.id));
      // ⚠️ `touch=auto` OR NOTHING. The explicit batch left this route's GET
      // entirely (see measureTouches), so there is no second source of ids here.
      const want = (autoTouch ? partners.map((p) => p.id) : []).filter((id) =>
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
      /**
       * 🔴 TASK 2 · SECTION 1 — THE VIEWER'S OWN PIPELINES, OR `null` FOR AN
       * ADMIN. Read once here and used twice below (the picker list and its
       * withheld count); the POST computes its own, because it is a separate
       * request with its own session.
       *
       * ⚠️ `null` AND AN EMPTY Set ARE DIFFERENT ANSWERS. `null` means "do not
       * filter" (admin, or no SSO); an empty Set means "granted nothing", which
       * is a real state on this account today and must filter everything out.
       * Collapsing them — `home?.size ? … : all` — is a fail-open that looks
       * exactly like the bug being unfixed, which is why it is not written that
       * way.
       */
      const clientHome = isAdmin
        ? null
        : getUserHomePipelines(session?.userId || "");
      const visibleIds = new Set(
        applyAccess(records, {
          userId: session?.userId || "",
          isAdmin,
        }).map((r) => r.id),
      );

      const allReferrals: RawReferral[] = records
        .map((r) => ({
          id: r.id,
          // Same fallback chain the events list uses one block down, so an
          // opportunity with no name still identifies its contact.
          name: r.oppName || `${r.first} ${r.last}`.trim() || "Untitled case",
          partnerId: String(r.cf?.[refField] ?? "").trim(),
          status: r.status,
          value: r.monetaryValue || 0,
          ago: daysSince(r.createdAt || ""),
          eventId: oppEventField ? String(r.cf?.[oppEventField] ?? "").trim() : "",
          // 🔴 TASK 2 · §2 — THE CASE'S OWN DIVISION, DERIVED FROM ITS PIPELINE.
          //
          // `OpportunityRecord.pipelineName` already exists for the division
          // badge (lib/types.ts:57), so this costs nothing. It is the ONE field
          // that lets a case be placed in a division at all — without it the
          // aggregates could only ever be scoped by ownership, which is the
          // thing round 122 refused.
          pipelineName: r.pipelineName || "",
          // ⚠️ TAGGED, NEVER FILTERED OUT HERE. Every aggregate reads the whole
          // array; only the drawer's per-record list honours this flag. See
          // RawReferral.visible for why two arrays would have been wrong.
          visible: visibleIds.has(r.id),
        }))
        .filter((o) => o.partnerId);

      // ═══ 🔴 ROUND 145 — A WITHHELD PARTNER IS NOT A DELETED ONE ═══════════
      //
      // THIS IS A DEFECT ROUND 143 SHIPPED, AND IT IS FIXED HERE BECAUSE ONLY
      // THE SERVER CAN TELL THE TWO APART.
      //
      // `danglingReferrals` counts cases whose partnerId is absent from the
      // partner list, and the screen says "…points at a partner that no longer
      // exists, so their revenue is attributed to nobody." Round 143 began
      // WITHHOLDING partners by division while leaving every case in the array,
      // so for a scoped viewer a partner they merely may not see read as one
      // that had been deleted. Reproduced, not suspected:
      //
      //   admin  (full partner list)  dangling = 0
      //   PP rep (p_oltl withheld)    dangling = 1
      //
      // ⚠️ THE CLIENT CANNOT FIX THIS. It receives only the partners it may
      // see, so "absent" is all it can observe; "absent because deleted" and
      // "absent because withheld" are the same shape there. The count is
      // computed against `allPartners` — the pre-filter list — and sent.
      //
      // 🔴 AND IT WILL MOVE AGAIN IN SECTION 2. Once cases are scoped too, a
      // case and its partner can be withheld independently and this still has
      // to be computed before BOTH filters. A second edit to this line is the
      // price of not shipping a wrong sentence in the meantime.
      //
      // ✅ AND SECTION 2 DID NOT NEED THE SECOND EDIT WE BOTH EXPECTED. The
      // worry was that scoping the CASES too would leave this counting against
      // one filtered list and one whole one. It does not, because the inputs
      // here are `allReferrals` and `allPartners` — both pre-filter, both by
      // name. The ordering makes it correct rather than any care taken at the
      // call site, which is why the names say `all`.
      const danglingCount = danglingReferrals(allReferrals, allPartners);

      // ═══ TASK 2 · §2 — THE CASE ARRAY IS SCOPED BY DIVISION ═══════════════
      //
      // 🔴 THIS IS THE REVERSAL OF ROUND 122, AND ONLY HALF OF IT. Round 122
      // refused to scope the aggregates because the filter on offer was
      // OWNERSHIP: two reps in one division would read different win rates
      // under one label, which is not a narrower truth but a different number
      // wearing the same name.
      //
      // ⚠️ DIVISION IS NOT THAT. "ODP revenue" is a real figure that exists
      // whether or not anybody is looking, and every ODP rep reads the same
      // one. Round 122's rule survives in the form that mattered: AN AGGREGATE
      // MUST NEVER DEPEND ON WHO IS ASKING. It now depends on WHICH PROGRAMME
      // is being asked about, and two people asking about the same programme
      // get the same answer. That is falsifiable — if two viewers ever saw
      // different numbers under the same division label, this is wrong.
      //
      // 🔴 `visible` IS UNTOUCHED AND STAYS A TAG. It is the ownership flag,
      // it still feeds only the drawer's "6 of 12 shown", and nothing here
      // reads it. See RawReferral.visible, whose comment still stands.
      const scopedReferrals = partnerDivisions
        ? allReferrals.filter((o) =>
            partnerDivisions.includes(divisionLabel(o.pipelineName)),
          )
        : allReferrals;
      /** Cases outside this viewer's divisions. A count, never the records. */
      const referralsWithheld = allReferrals.length - scopedReferrals.length;
      const referrals = scopedReferrals;

      // ══ ROUND 122 · ITEM 2 — APPLICANTS, IN THEIR OWN LIST ════════════════
      //
      // 🔴 A SECOND FETCH, NOT A WIDER ONE. `getOltlOpportunities("client")`
      // above feeds every revenue figure; adding applicant pipelines to it
      // would put job applicants into `revenue` through a reducer nobody would
      // think to check. The two lists never meet — see enrichPartner, which
      // takes them as separate parameters for exactly this reason.
      //
      // ⚠️ WHAT IT COSTS: one more paginated read of the applicant pipelines
      // (~187 records today) per Referrals load. Measured against the
      // 100-per-10s budget that is a handful of searches, and it rides the same
      // memoized pipeline list — but it is a real cost and it is why this was
      // deferred twice rather than bolted on.
      //
      // ⚠️ AND IT NEVER FAILS THE PAGE. A partner who sends applicants is a
      // nice-to-know; a Referrals screen that will not load because the
      // applicant payload wobbled is not a trade worth making.
      let applicantRefs: RawReferral[] = [];
      try {
        const { records: cgRecords } = await getOltlOpportunities("caregiver");
        const cgVisible = new Set(
          applyAccess(cgRecords, { userId: session?.userId || "", isAdmin }).map((r) => r.id),
        );
        applicantRefs = cgRecords
          .map((r) => ({
            id: r.id,
            name: r.oppName || `${r.first} ${r.last}`.trim() || "Untitled applicant",
            partnerId: String(r.cf?.[refField] ?? "").trim(),
            status: r.status,
            // ⚠️ ZERO, ALWAYS. An applicant opportunity may carry a
            // monetaryValue in GoHighLevel and it is not revenue. Carrying the
            // real number would leave a live grenade for the next person who
            // sums a list without checking which one it is.
            value: 0,
            ago: daysSince(r.createdAt || ""),
            eventId: "",
            // 🔴 CARRIED, AND DELIBERATELY NOT USED TO SCOPE — task 2 · §2.
            //
            // divisionLabel("OLTL Caregiver Applicants") is "OLTL Caregiver",
            // which is not a `Partner Division` value on any account. Scoping
            // this list the way the client list is scoped would not narrow the
            // applicant columns, it would EMPTY them — for every viewer, in
            // every division, from a change that looks like consistency.
            //
            // ⚠️ AND THE COLUMN EXISTS TO SHOW A CROSS-DIVISION FACT. Round 122
            // item 2 added it so a Private Pay manager can see that their
            // hospital partner also sends caregivers. Scoping it by the
            // viewer's grants would hide exactly that.
            pipelineName: r.pipelineName || "",
            visible: cgVisible.has(r.id),
          }))
          .filter((o) => o.partnerId);
      } catch {
        applicantRefs = [];
      }

      // ── events ─────────────────────────────────────────────────────────────
      const evDate = oppIdOf(EVENT_FIELDS.date.name, EVENT_FIELDS.date.id);
      const evCost = oppIdOf(EVENT_FIELDS.cost.name, EVENT_FIELDS.cost.id);
      const evVenue = oppIdOf(EVENT_FIELDS.venue.name, EVENT_FIELDS.venue.id);
      const evDiv = oppIdOf(EVENT_FIELDS.division.name, EVENT_FIELDS.division.id);
      // 🔴 ROUND 124 · ITEM 2 — READ BY ID, NOT SIFTED OUT OF THE CLIENT BOARD.
      //
      // This filtered `records`, which is `getOltlOpportunities()` — scope
      // "client". So an Events pipeline found under the "none" scope (round
      // 116's whole point) or marked by role and scoped anything else was
      // located and never fetched: the lookup said "configured" and the list
      // came back empty. **That is the empty Events tab**, and it is not a
      // rename. A lookup and a fetch disagreeing about which pipelines exist is
      // worse than either being wrong alone, because the screen looks fine.
      //
      // ⚠️ ONE EXTRA SEARCH, AND ONLY WHEN A PIPELINE WAS FOUND. It is the
      // same paged search the board makes per pipeline, so the shape and the
      // rate-limit cost are both known quantities.
      const evRecords = evPipe ? await getOpportunitiesInPipeline(evPipe) : [];
      // ═══ ROUND 167 — EVENTS GET THE PARTNER RULE ══════════════════════════
      //
      // 🔴 THEY WERE NOT FILTERED AT ALL, AND IT SHOWED ON THE HEADING. An
      // ODP-only viewer read "OLTL" over the Referrals section because
      // `divisionChoices` (components/ReferralsSection.tsx) is built from
      // partners AND events, and only the partners were scoped. Deleting the
      // one OLTL event changed the heading to "Referral partners" — the
      // reproduction that found this.
      //
      // ⚠️ THE SAME RULE AS PARTNERS, DELIBERATELY WORD FOR WORD. Blank and
      // "All" are universal for display (see inDivision); anything else is
      // visible only inside the viewer's referral divisions. Two lists with two
      // rules is a second source of truth, which is the fault round 143 closed
      // on the "Referred by" picker.
      //
      // ⚠️ NO `owned` HALF, AND THAT IS NOT AN OVERSIGHT. A partner can be
      // OWNED by a rep outside its division — that is what `shared` is for —
      // but an event has no owner field. `Event Host` names a PARTNER, not a
      // user, so there is nothing here that could play the same role.
      const allEvents: RawEvent[] = evRecords.map((r) => ({
        id: r.id,
        name: r.oppName || `${r.first} ${r.last}`.trim() || "Untitled event",
        stage: r.stage,
        date: String(r.cf?.[evDate] ?? ""),
        cost: Number(r.cf?.[evCost] ?? 0) || 0,
        venue: String(r.cf?.[evVenue] ?? ""),
        division: String(r.cf?.[evDiv] ?? ""),
        host: eventHostField ? String(r.cf?.[eventHostField] ?? "").trim() : "",
      }));
      const eventVisible = (d: string): boolean => {
        const div = (d || "").trim();
        return !partnerDivisions || !div || div === ALL_DIVISIONS || partnerDivisions.includes(div);
      };
      const events: RawEvent[] = allEvents.filter((e) => eventVisible(e.division));
      /** Withheld from THIS viewer. A count, never the names. */
      const eventsWithheld = allEvents.length - events.length;

      // ═══ ROUND 167 — AN ATTENDEE IS VISIBLE IF ITS EVENT IS ═══════════════
      //
      // ⚠️ AN ATTENDEE HAS NO DIVISION OF ITS OWN. It has an event and the
      // event has one, so the test is derived rather than invented — the same
      // reasoning the client already used for the division switcher.
      //
      // 🔴 AN ATTENDEE WITH NO EVENT STAYS VISIBLE. `Event Attended` can be
      // blank, a blank belongs to no division, and withholding it would hide
      // somebody from everybody — the labelled-leak decision partners already
      // follow for a blank division. It is counted on the client as
      // "unplaced", which is unchanged.
      const visibleEventIds = new Set(events.map((e) => e.id));
      const allEventIds = new Set(allEvents.map((e) => e.id));
      const allAttendees: RawAttendee[] = attendeeRes.rows.map((c) => ({
        id: c.id,
        name: c.name,
        eventId: attendeeEventField ? c.fields[attendeeEventField] || "" : "",
        outcome: c.fields[F.outcome] || "",
        profile: c.fields[F.profile] || "",
        version: c.version,
      }));
      const attendees: RawAttendee[] = allAttendees.filter(
        (a) =>
          !a.eventId ||
          visibleEventIds.has(a.eventId) ||
          // 🔴 A DANGLING POINTER IS NOT A WITHHELD ONE, AND THE FIRST VERSION
          // OF THIS FILTER GOT IT WRONG. "Visible if its event is visible" hid
          // every attendee whose event had been DELETED, because a deleted
          // event is in neither list — so deleting an event erased the only
          // remaining evidence that those people were met at all, which is the
          // exact thing round 124 · item 4 refused to do:
          //
          //   "clearing Event Attended on every one of them is a write that can
          //    half-fail, and it would erase the only remaining evidence that
          //    those people were met at all."
          //
          // round124-proof caught it — "both attendees survive the event's
          // deletion" went red. A record pointing at nothing is a data-quality
          // fact about the account, visible to everyone and counted as
          // `danglingAttendees`; only an event that EXISTS and is out of scope
          // withholds its people.
          !allEventIds.has(a.eventId),
      );
      /** Withheld from THIS viewer. A count, never the names. */
      const attendeesWithheld = allAttendees.length - attendees.length;

      // ═══ ROUND 167 — DANGLING ATTENDEES MOVE SERVER-SIDE ══════════════════
      //
      // 🔴 THIS IS A RELOCATION, NOT A NEW NUMBER, AND ROUND 145 ALREADY DID IT
      // ONCE FOR THE OTHER OBJECT. `orphanAttendees` lived in
      // components/ReferralsSection.tsx and was computed against `data.events`,
      // with a comment explaining the care taken:
      //
      //     "AGAINST data.events, NOT THE DIVISION CUT. An attendee at an OLTL
      //      event is not orphaned merely because you are looking at ODP."
      //
      // That was exactly right while the client held every event. The filter
      // above makes `data.events` mean "events you may see", so the same line
      // would have started reporting a WITHHELD event's attendees as people
      // "recorded at an event that no longer exists" — a withheld thing read as
      // a deleted one, which is round 145's lesson verbatim.
      //
      // ⚠️ AGAINST `allEvents`, BEFORE THE FILTER, so every viewer gets the
      // same number — it is a data-quality fact about the account, not about
      // who is asking. The client-side copy is REMOVED in the same change:
      // leaving both would be two answers to one question.
      const liveEventIds = new Set(allEvents.map((e) => e.id));
      const danglingAttendees = allAttendees.filter(
        (a) => a.eventId && !liveEventIds.has(a.eventId),
      ).length;


      // ═══ TASK 2 · SECTION 1 — THE TWO LISTS, SO THE DIFFERENCE IS SAYABLE ══
      //
      // 🔴 THE COUNT IS THE HONESTY, and it is why this is computed here rather
      // than inline in the payload. An empty picker has TWO causes that look
      // identical on screen:
      //
      //   nothing configured   the account has no client pipeline at all
      //   nothing granted      it has three and this viewer holds none
      //
      // The dialog said "There is no client pipeline CONFIGURED to file this
      // in" for both, which is true of the first and false of the second — the
      // "0 of 2 that meant a filter, not an absence" failure, in a sentence
      // written before this filter existed. Sending the withheld COUNT (never
      // the names) lets the screen say which it is.
      //
      // ⚠️ AND A COUNT IS ITSELF A SMALL DISCLOSURE: it tells a Private Pay rep
      // that pipelines exist they cannot use. Taken deliberately, on the same
      // reasoning as the drawer's "6 of 12 shown" — a number with no name in it
      // is the price of not lying, and silence is the worse trade.
      const clientChoices = (await getSelectedPipelines("client")).filter(
        (p) => p.id !== evPipe?.id,
      );
      const clientAllowed = clientChoices.filter(
        (p) => !clientHome || clientHome.has(p.id),
      );

      return NextResponse.json(
        {
          partners,
          referrals,
          // ITEM 2 — kept apart from `referrals` all the way to the screen.
          applicantRefs,
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
          /**
           * `Partner Division`'s WHOLE picklist, and deliberately not narrowed
           * to the viewer.
           *
           * 🔴 TWO CONSUMERS NEED DIFFERENT THINGS FROM IT. The Access tab
           * offers these as the divisions an admin may grant (round 167 · D12),
           * so it needs all of them; the create dialogs may offer only the
           * viewer's own (C10), so they intersect this with
           * `meta.viewerReferralDivisions` on the client.
           *
           * ⚠️ NARROWING IT HERE WOULD HAVE BROKEN THE ACCESS TAB SILENTLY —
           * an admin would quietly stop being able to grant a division, which
           * is the "a filtered list read as an absence" fault this project has
           * now hit five times. The INTERSECTION is the dialog's business and
           * the REFUSAL is the server's; see `add-event` and `add-partner`.
           */
          divisionOptions: optionsOf(contactDefs, PARTNER_FIELDS.division.name),
          // 🔴 ROUND 128 — THE EVENT'S OWN FIELD, WHICH IS A DIFFERENT FIELD.
          //
          // "Add an event" writes `Event Division` — an OPPORTUNITY field — and
          // was being offered the options of `Partner Division`, a CONTACT
          // field. They are two picklists that happen to hold similar values
          // today; the moment they diverge the dialog offers a value the event
          // field cannot store, and GoHighLevel drops it with a 200.
          //
          // ⚠️ EMPTY WHEN `Event Division` IS NOT A PICKLIST. On this account it
          // may well be plain text, in which case there are no options to read
          // and the dialog says so rather than pretending the partner field's
          // list applies to it.
          eventDivisionOptions: optionsOf(oppDefs, EVENT_FIELDS.division.name),
          outcomeOptions: optionsOf(contactDefs, ATTENDEE_FIELDS.outcome.name),
          // Where "Log a referral" may file a case. 🔴 The Events pipeline is
          // EXCLUDED: an event is not a client, and offering it would let a
          // referral be filed as one.
          //
          // ═══ TASK 2 · SECTION 1 — AND IT IS SCOPED TO THE VIEWER ═══════════
          //
          // 🔴 THIS LIST USED TO GO OUT WHOLE, TO EVERYONE. Two faults, and the
          // second is the one that damages data:
          //
          //   DISCLOSURE      the pipeline names on this account are
          //                   "OLTL Enrollment", "ODP Transfer", "Private Pay
          //                   Clients". A Private Pay rep holding no OLTL grant
          //                   read OLTL in a dropdown.
          //
          //   A RECORD THE    "Log a referral → New enquiry" creates an
          //   CREATOR CANNOT  UNASSIGNED opportunity (this form sends no owner
          //   SEE            — deliberately, the pipeline's workflow decides).
          //                   applyAccess admits an unassigned record ONLY in a
          //                   home pipeline (lib/pipelineAccess.ts:140), so a
          //                   case filed into an ungranted pipeline vanished
          //                   from its creator's board the moment it was made.
          //
          // ⚠️ AND THE SAME FILTER IS ON THE WRITE — see `log-referral` in the
          // POST. Filtering only here would stop the dropdown NAMING OLTL while
          // still accepting an OLTL pipelineId, which is the same fault with a
          // cosmetic patch over it.
          //
          // 🔴 `null` FOR AN ADMIN, A Set FOR EVERYONE ELSE. An empty Set is a
          // real answer — "granted nothing" — and must not read as "unfiltered".
          // That distinction is the whole bug in one line: `!home` is false for
          // an empty Set, so an ungranted viewer correctly gets nothing.
          clientPipelines: clientAllowed
            .map((p) => ({
              id: p.id,
              name: p.name,
              division: divisionLabel(p.name),
              // 🔴 ROUND 126 — BY MEANING, NOT BY POSITION. Round 121 sorted by
              // `position` and the picker still read TRANSFERRED IN live, which
              // ordering cannot explain away: either the field is not sent (the
              // sort is a no-op and the fallback IS the bug) or TRANSFERRED IN
              // genuinely holds position 0. `entryStage` answers "where does a
              // NEW enquiry go", which is the question that was actually being
              // asked, and is right under both.
              stage: entryStage(p).name,
              stageId: entryStage(p).id,
              // ⚠️ AND IT ADMITS A GUESS. When no stage reads as a new enquiry
              // and none is a non-transfer, the picker can say so instead of
              // presenting a fallback as a decision.
              stageFellBack: entryStage(p).fellBack,
              stageWhy: entryStage(p).why,
            })),
          // ── what this answer does NOT know, said out loud ──────────────────
          meta: {
            eventsPipelineConfigured: !!evPipe,
            eventsPipelineName: evPipe?.name || "",
            /**
             * 🔴 TASK 2 · SECTION 1 — HOW MANY CLIENT PIPELINES THIS VIEWER MAY
             * NOT FILE INTO. A COUNT, NEVER THE NAMES — naming them is the
             * disclosure the filter exists to close.
             *
             * ⚠️ IT IS WHAT MAKES THE EMPTY PICKER SAYABLE. `clientPipelines`
             * empty with this at 0 means the account has none configured;
             * empty with this above 0 means the viewer holds no grant. The two
             * need different sentences and one of them names a different
             * person to go and ask.
             */
            clientPipelinesWithheld: clientChoices.length - clientAllowed.length,
            /**
             * 🔴 TASK 2 · SECTION 4 — PARTNERS THIS VIEWER MAY NOT SEE.
             *
             * ⚠️ IT EXISTS FOR THE CASE THAT LOOKS BROKEN: a recruiter granted
             * only an applicant pipeline has the division "OLTL Caregiver"
             * (divisionLabel strips " Applicants" and leaves the rest), which
             * matches no partner — so they get an EMPTY table. Empty because
             * filtered and empty because there is nothing must not look the
             * same. Same shape and same reason as clientPipelinesWithheld.
             */
            partnersWithheld,
            /**
             * Partners carrying no division at all, and therefore visible to
             * everyone. The labelled leak — see the decision at
             * lib/referrals.ts inDivision. Counted account-wide, not per
             * viewer: it is a data-quality number for whoever can fix it.
             */
            partnersNoDivision,
            /**
             * 🔴 TASK 2 · §2 — CASES OUTSIDE THIS VIEWER'S DIVISIONS.
             *
             * ⚠️ THE AGGREGATES ABOVE ARE NOW A DIVISION'S FIGURES, NOT THE
             * ACCOUNT'S, and a viewer has to be able to tell that from an
             * account with no business in it. Same shape and same reason as
             * partnersWithheld and clientPipelinesWithheld.
             */
            referralsWithheld,
            /**
             * 🔴 HOW MANY DIVISIONS THIS VIEWER HOLDS — task 2 · §4.
             *
             * ⚠️ A COUNT, AND IT DECIDES A SENTENCE, NOT A FILTER. Zero means
             * they hold no pipeline at all, which is the case manager's
             * intended state and needs a different explanation from a rep who
             * holds some. `null` for an admin becomes 0 here and never reaches
             * that branch, because nothing is withheld from them to explain.
             *
             * 🔴 NEVER "IS A CASE MANAGER". Nothing knows that, and reading it
             * off an absent grant would infer a role from an absence — the same
             * rule that bans reading one off a `-Sale` name suffix.
             */
            viewerDivisions: partnerDivisions ? partnerDivisions.length : null,
            /**
             * 🔴 ROUND 167 — THE DIVISION NAMES, NOT JUST HOW MANY.
             *
             * `viewerDivisions` above is a COUNT, because the old design only
             * needed to pick a sentence. The heading needs the NAMES: an
             * ODP-only viewer must read "ODP" even with no ODP partners and no
             * ODP events, and a two-division viewer's combined option has to
             * read "ODP + OLTL" rather than "All divisions".
             *
             * 🔴 WHY THE HEADING CANNOT BE DERIVED FROM THE DATA ANY MORE. It
             * was, and that is the bug this round fixes: `divisionChoices` is
             * built from the partners AND the events, the events were never
             * scoped, and an ODP-only viewer read "OLTL" off a single OLTL
             * event. Scoping the events repairs that one case; deriving the
             * heading from ACCESS makes the whole class impossible, including
             * the empty-division case no amount of filtering can fix.
             *
             * ⚠️ NOT A DISCLOSURE. These are the viewer's OWN divisions —
             * derived from grants they hold or set explicitly for them. Round
             * 155's rule is about not naming what somebody may NOT see;
             * `partnersWithheld` and `eventsWithheld` stay counts for exactly
             * that reason.
             *
             * `null` for an admin and for Agency referral access, meaning "all"
             * — the same three-state shape `referralDivisions` returns, carried
             * out intact rather than flattened into a list the client would
             * have to guess about.
             */
            viewerReferralDivisions: partnerDivisions,
            /**
             * 🔴 ROUND 167 — WHY THE LIST IS EMPTY, WHICH IS TWO DIFFERENT
             * ANSWERS SINCE ROUND 162.
             *
             *   "none"      holds no pipeline at all — the case manager's
             *               intended state, and nothing is misconfigured.
             *   "explicit"  holds pipelines, but an admin set their referral
             *               access to an empty division list on purpose.
             *   "derived"   the ordinary case: divisions come from grants.
             *   "all"       admin, or Agency referral access.
             *
             * ⚠️ THE SENTENCE AT ReferralsSection.tsx COULD NOT TELL THE FIRST
             * TWO APART and said "you hold no pipeline" to both. Round 162
             * created the second cause for one number and left the sentence
             * knowing one. The server knows which it is; nothing is inferred.
             */
            referralScopeKind: referralScopeKind(
              session?.userId || "",
              pipelineNameById,
              isAdmin,
              partnerDivisionOptions,
            ),
            /**
             * 🔴 ROUND 167 — EVENTS OUTSIDE THIS VIEWER'S DIVISIONS. A COUNT,
             * NEVER THE NAMES. Same shape and same reason as
             * `partnersWithheld`: empty because filtered and empty because
             * there is nothing must not look the same.
             */
            eventsWithheld,
            /** Attendees whose event is withheld. A count, never the names. */
            attendeesWithheld,
            /**
             * 🔴 ROUND 167 — PEOPLE MET AT AN EVENT THAT NO LONGER EXISTS,
             * COUNTED AGAINST THE FULL EVENT LIST.
             *
             * Moved here from components/ReferralsSection.tsx in this round.
             * It was correct on the client for as long as the client held every
             * event; filtering events would have turned "your division does not
             * include this event" into "this event was deleted". Round 145 made
             * the identical move for `danglingReferrals`, for the identical
             * reason, and the note explaining it is still in that file.
             */
            danglingAttendees,
            /**
             * 🔴 ROUND 145 — COMPUTED AGAINST THE FULL PARTNER LIST, SERVER
             * SIDE, because the client cannot tell a withheld partner from a
             * deleted one. See the note beside danglingCount.
             */
            danglingReferrals: danglingCount,
            // ⚠️ HOW IT WAS FOUND — round 124, item 2. "role" means an admin
            // marked it and a rename cannot break it; "name" means it is still
            // being matched on the string "Events" and one rename away from
            // silence; "none" means nothing answered at all. The tab says a
            // different sentence for each, because each needs a different fix.
            eventsPipelineVia: evFound.via,
            /** "" when no field links an attendee to an event — see above. */
            attendeeEventField,
            oppEventField,
            eventHostField,
            /** The contact field id the outcome dropdown PATCHes. */
            outcomeField: F.outcome,
            /**
             * 🔴 THE OPPORTUNITY FIELD "Log a referral → someone already in
             * GoHighLevel" writes — round 115c, item 4. It is the SAME field
             * ReferredBy sets from the record panel, and attribution is a
             * single PUT of it. Sent so the referrals section can attribute
             * without a second round trip to learn the id.
             */
            referringPartnerField: refField,
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
      // ⚠️ role/type ARE READ NOW — item 15's read action needs to know whether
      // this viewer is an admin, the same question the GET half asks.
      let session: { userId?: string; role?: string; type?: string } | null = null;
      if (ssoConfigured()) {
        if (!body.ssoKey)
          return NextResponse.json(
            { error: "Sign-in required.", status: 401 } as ApiError,
            { status: 401 },
          );
        session = decryptSso(body.ssoKey);
      }

      // ═══ ROUND 167 · C10 — NOBODY CREATES SOMETHING THEY THEN CANNOT SEE ═══
      //
      // 🔴 ROUND 140'S RULE, APPLIED TO THE DIVISION FIELD. That round refused
      // to let a rep file a case into a pipeline they hold no grant on, because
      // the record vanished from its creator's board the moment it was made.
      // An event or a partner stamped with a division outside the creator's
      // referral access does the same thing: it is written, it succeeds, and it
      // is gone from the only screen that would show it.
      //
      // ⚠️ A 403 THAT NAMES THE DIVISION, NEVER A SILENT CORRECTION. Dropping
      // the value would create the record with no division — visible to
      // everyone, which is the labelled leak — and substituting one of their
      // own would file it somewhere they did not choose. Both are worse than
      // refusing, because both look like success.
      //
      // ⚠️ BLANK AND "All" PASS. They are universal for display, so neither can
      // hide a record from its creator. Requiring a division is a different
      // decision, made in the dialogs.
      const writeIsAdmin = !session || isAdminSession(session.role, session.type);
      /**
       * `true` when the division may be written; the viewer's own divisions
       * when it may not, so the refusal can name them.
       *
       * ⚠️ ASYNC AND LAZY, AND IT COSTS NOTHING. `referralDivisions` derives
       * from the pipelines the viewer holds, so it needs their names — the same
       * `listPipelines()` the GET uses, which is memoised (`cache.pipelines`).
       * It is reached only when a non-admin writes a real division, so the
       * common paths pay nothing at all.
       */
      const divisionAllowed = async (want: string): Promise<true | string[]> => {
        const d = (want || "").trim();
        if (!d || d === ALL_DIVISIONS || writeIsAdmin) return true;
        const names = new Map((await listPipelines()).map((p) => [p.id, p.name]));
        // 🔴 ROUND 168 — THE SAME ALLOW-LIST AS THE GET, OR THE HEADING AND
        // THE GUARD WOULD DISAGREE ABOUT WHAT "ODP" MEANS. A viewer offered ODP
        // by one and refused it by the other is the cosmetic-patch failure this
        // file already warns about twice.
        const mine = referralDivisions(
          session?.userId || "",
          names,
          writeIsAdmin,
          optionsOf(await getEditableFieldDefs("contact"), PARTNER_FIELDS.division.name),
        );
        if (!mine || mine.includes(d)) return true;
        return mine;
      };
      const refuseDivision = (want: string, mine: string[], thing: string) =>
        NextResponse.json(
          {
            error: `You cannot file ${thing} under ${String(want).trim()}.`,
            detail: mine.length
              ? `Your referral access covers ${mine.join(", ")}. A record in another division would not appear on your Referrals screen at all — so it is refused rather than created where you cannot see it. Nothing was created. Ask an admin on Admin → Access if that is wrong.`
              : "You hold no referral divisions, so every division is outside your access and a record would be invisible to you once created. Nothing was created. Ask an admin on Admin → Access.",
            refusal: true,
            status: 403,
          } as ApiError,
          { status: 403 },
        );

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
        // 🔴 THE TYPE IS NOW PERSISTED. It used to be collected and dropped —
        // a rep picked "Visit", it rode along in the request body, and nothing
        // read it. A control that discards its input is worse than no control,
        // because the rep believes it was recorded.
        const n = await addContactNote(
          contactId,
          composeTouch(body.touchType || "", text),
          session?.userId || "",
        );
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
        // 🔴 A PARTNER **OR** AN EVENT. Logging a referral from an event card is
        // the whole point of `Event Source`: you met them at the expo and they
        // became a client, and that sentence has no partner in it when nobody
        // hosted the event. Requiring a partner is what left the field with no
        // writer at all.
        if (!partnerId && !(body.eventId || "").trim())
          return NextResponse.json(
            {
              error: "A referral needs a source.",
              detail: "Either the partner who sent it, or the event they were met at.",
              status: 400,
            } as ApiError,
            { status: 400 },
          );
        if (!who)
          return NextResponse.json(
            { error: "A referral needs the client or family's name.", status: 400 } as ApiError,
            { status: 400 },
          );
        // ═══ ROUND 167 — A WAY TO REACH THEM IS REQUIRED ═══════════════════
        //
        // 🔴 THIS ANSWERS THE QUESTION ROUND 166 LEFT OPEN AND PINNED.
        // Round 166 moved three contact writes onto `ensureContact`, which
        // falls back to a name-only create, and deliberately did NOT move this
        // one: whether a CLIENT may exist with no way to contact them is a
        // business question. The answer is no — somebody we will ring or email
        // needs a number or an address, and a lead nobody can follow up is a
        // record that looks workable and is not.
        //
        // ⚠️ SO THIS STAYS ON `upsertContact`, AND NOW BY DECISION RATHER THAN
        // BY DEFAULT. GoHighLevel would refuse it anyway, with "Pass at least
        // one of number, email query parameter" — unreadable to a rep and about
        // an endpoint they never called. Refusing first replaces that with a
        // sentence about the thing that is missing, before any write.
        if (!clean(body.phone) && !clean(body.email))
          return NextResponse.json(
            {
              error: "Add a phone number or an email — we need a way to reach them.",
              detail: "Nothing was created.",
              status: 400,
            } as ApiError,
            { status: 400 },
          );

        const pipelines = await getSelectedPipelines("client");
        const { pipe: evPipe } = await eventsPipeline();
        const choices = pipelines.filter((p) => p.id !== evPipe?.id);

        // ═══ TASK 2 · SECTION 1 — THE WRITE HALF ═══════════════════════════
        //
        // 🔴 THE GET FILTER WITHOUT THIS ONE IS A COSMETIC PATCH. The dropdown
        // would stop NAMING OLTL while this handler still accepted an OLTL
        // pipelineId — the same fault, hidden. So the destination list is
        // scoped here too, from this request's own session.
        //
        // ⚠️ A REFUSAL, NOT A QUIET FALLBACK. If an ungranted pipeline were
        // simply dropped from `choices`, the `||` chain below would file the
        // case SOMEWHERE ELSE and return 200 — a referral silently landing in
        // a pipeline nobody chose, which is worse than the leak. Naming an
        // ungranted pipeline is answered with 403 and the pipeline's name,
        // because the caller is entitled to know why their pick was refused.
        //
        // ⚠️ AND IT NAMES ONLY WHAT THEY ALREADY NAMED. The 403 echoes the
        // pipeline the caller sent; it never lists the others.
        const postHome = isAdminSession(session?.role, session?.type) || !session
          ? null
          : getUserHomePipelines(session?.userId || "");
        const allowed = choices.filter((p) => !postHome || postHome.has(p.id));
        const picked = (body.pipelineId || "").trim();
        const pickedReal = choices.find((p) => p.id === picked);
        if (picked && pickedReal && !allowed.some((p) => p.id === picked))
          return NextResponse.json(
            {
              error: `You do not have access to "${pickedReal.name}".`,
              // ⚠️ "…OR FILE IT IN ONE OF YOUR OWN" IS ADVICE A VIEWER WITH
              // NONE CANNOT TAKE, and the proof caught it: an ungranted rep
              // naming a pipeline got told to use another of theirs when they
              // have none. `allowed.length` is already in hand, so the sentence
              // can stop short rather than send them looking.
              detail:
                "Nothing was created. A case filed there would not appear on your board. Ask an admin to grant you that pipeline on Admin → Access" +
                (allowed.length ? ", or file this referral in one of your own." : "."),
              status: 403,
            } as ApiError,
            { status: 403 },
          );

        // 🔴 RESOLVED, NEVER HARDCODED. The brief says "creates an opportunity
        // in Private Pay"; section 9 forbids hardcoded pipeline ids. So the
        // destination is the one the CALLER picked, and the fallback is matched
        // by divisionLabel() — the same derivation the whole app uses.
        //
        // ⚠️ EVERY ARM READS `allowed`, INCLUDING THE FALLBACKS. A viewer who
        // sends no pipelineId must not be defaulted into a pipeline they hold
        // no grant for — that is the same "record the creator cannot see",
        // arrived at by omission instead of by choice.
        const dest =
          allowed.find((p) => p.id === picked) ||
          allowed.find(
            (p) => norm(divisionLabel(p.name)) === norm((body.division || "Private Pay").trim()),
          ) ||
          allowed.find((p) => /private\s*pay/i.test(p.name));
        // 🔴 TWO DIFFERENT FAILURES, AND ONE MESSAGE WAS LYING ABOUT BOTH.
        //
        // This said "There is no client pipeline to file this referral in" for
        // BOTH cases. The route-proof run hit it with an account that had an
        // OLTL pipeline and no Private Pay one — so the dashboard refused the
        // referral while telling the user there was nowhere to put it, with a
        // perfectly good pipeline sitting right there. Say which it is.
        //
        // ⚠️ AND NOW THERE IS A THIRD: pipelines exist, and this viewer holds
        // none of them. Telling them to "give a pipeline client scope in Admin
        // → Pipelines" would send them to configure something already
        // configured — the same lie the dialog told, in the route.
        if (!dest)
          return NextResponse.json(
            !allowed.length && choices.length
              ? {
                  error: "You do not have access to any pipeline a referral can be filed in.",
                  detail:
                    "Nothing was created. The pipelines exist — you hold no grant for them. Ask an admin to grant you one on Admin → Access.",
                  status: 403,
                }
              : allowed.length
                ? {
                    error: "Choose where to file this referral.",
                    detail: `Nothing was created. No client pipeline matches ${body.division ? `the partner's division (${body.division})` : "Private Pay"}, so the destination has to be picked: ${allowed.map((p) => p.name).join(", ")}.`,
                    status: 409,
                  }
                : {
                    error: "There is no client pipeline to file this referral in.",
                    detail:
                      "Nothing was created. Give a pipeline client scope in Admin → Pipelines, then log the referral.",
                    status: 409,
                  },
            { status: !allowed.length && choices.length ? 403 : 409 },
          );
        // 🔴 ROUND 126 — the same rule that the picker DISPLAYED must be the
        // one the write USES, or the dialog promises one stage and files
        // another. One function, both places.
        const stageId = entryStage(dest).id;
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
        const cPhone = clean(body.phone);
        const cEmail = clean(body.email);
        // ═══════════════════════════════════════════════════════════════════
        // ⚠️ ROUND 166 — DELIBERATELY STILL `upsertContact`, AND THAT IS NOT AN
        // OVERSIGHT.
        //
        // The other three contact writes in this file moved to `ensureContact`,
        // which falls back to a name-only create when there is no phone and no
        // email. This one did not, because the question it raises is a BUSINESS
        // question and not a technical one: may a CLIENT exist with no way to
        // contact them?
        //
        // A venue with no phone number is normal. A partner organisation you
        // have only a name for is normal. A client referral with neither is a
        // lead nobody can follow up, and silently creating it would put a
        // record into the enrolment pipeline that looks workable and is not.
        //
        // 🔴 SO THE BEHAVIOUR IS UNCHANGED ON PURPOSE: with neither key this
        // still fails, and the owner decides whether it should. Round 164's
        // report names it; this comment is here so the next person reading the
        // four call sites does not "finish the job" and answer the question by
        // accident.
        // ═══════════════════════════════════════════════════════════════════
        const contact = await upsertContact({
          firstName: clean(body.firstName),
          lastName: clean(body.lastName),
          name: who,
          ...(cPhone ? { phone: cPhone } : {}),
          ...(cEmail ? { email: cEmail } : {}),
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
        const cf: { id: string; value: unknown }[] = [];
        if (partnerId) cf.push({ id: refId, value: partnerId });
        // The event that produced this client — `Event Source`, written here and
        // nowhere else. Resolved by name with the confirmed id as a cross-check.
        const evField =
          oppDefs.find((d) => OPP_EVENT_FIELD_NAMES.some((n) => norm(d.name) === norm(n)))
            ?.id ||
          (oppDefs.some((d) => d.id === OPP_EVENT_FIELD_ID) ? OPP_EVENT_FIELD_ID : "");
        const evId = (body.eventId || "").trim();
        const evSkipped = !!evId && !evField;
        if (evField && evId) cf.push({ id: evField, value: evId });

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
          stageName: entryStage(dest).name,
          monthly,
          noteSaved,
          // ⚠️ STATED, NEVER SILENT. If the event link could not be written the
          // referral still exists — but this event's Clients and Revenue will
          // not count it, and the rep should know that now rather than wonder
          // later why the card reads zero.
          eventLinkSkipped: evSkipped,
        });
      }

      // ── create an event, hosted by a partner ───────────────────────────────
      // 🔴 THE ONLY WRITER OF `Event Host`. Without it "Run by [ partner ]" can
      // never resolve and the drawer's "Events worked" is permanently empty —
      // the field would exist and nothing would ever set it, which is exactly
      // the state `Event Source` was in.
      if (body.action === "add-event") {
        const name = (body.org || "").trim();
        if (!name)
          return NextResponse.json(
            { error: "An event needs a name.", status: 400 } as ApiError,
            { status: 400 },
          );
        const { pipe: evPipe } = await eventsPipeline();
        if (!evPipe)
          return NextResponse.json(
            {
              error: "There is no Events pipeline configured.",
              detail:
                "Nothing was created. Give a pipeline named \"Events\" client scope in Admin → Pipelines.",
              status: 409,
            } as ApiError,
            { status: 409 },
          );
        // ⚠️ AN EVENT TOO. An Events pipeline has no transfer stage, so this
        // resolves to the same stage `firstStage` did — but a pipeline that
        // grows one must not start filing events into it.
        const stageId = entryStage(evPipe).id;
        if (!stageId)
          return NextResponse.json(
            {
              error: `"${evPipe.name}" has no stages.`,
              detail: "Nothing was created. Add a stage in GoHighLevel, then add the event.",
              status: 409,
            } as ApiError,
            { status: 409 },
          );
        const oppDefs = await getEditableFieldDefs("opportunity");
        const pick = (names: readonly string[], fallbackId: string) =>
          oppDefs.find((d) => names.some((n) => norm(d.name) === norm(n)))?.id ||
          (oppDefs.some((d) => d.id === fallbackId) ? fallbackId : "");
        const cf: { id: string; value: unknown }[] = [];
        const missing: string[] = [];
        const hostField = pick(EVENT_HOST_FIELD_NAMES, EVENT_HOST_FIELD_ID);
        const hostId = (body.partnerId || "").trim();
        if (hostId) {
          if (hostField) cf.push({ id: hostField, value: hostId });
          else missing.push("Event Host");
        }
        const put = (name: string, fallbackId: string, value: string | number) => {
          if (value === "" || value === undefined) return;
          const d =
            oppDefs.find((x) => norm(x.name) === norm(name)) ||
            oppDefs.find((x) => x.id === fallbackId);
          if (!d) {
            missing.push(name);
            return;
          }
          cf.push({ id: d.id, value });
        };
        put(EVENT_FIELDS.date.name, EVENT_FIELDS.date.id, (body.eventDate || "").trim());
        put(EVENT_FIELDS.venue.name, EVENT_FIELDS.venue.id, (body.venue || "").trim());
        // 🔴 ROUND 167 · C10 — REFUSED BEFORE THE FIRST WRITE, not after. The
        // venue contact and the opportunity both come later, so a refusal here
        // really does leave nothing behind.
        const evDivWanted = (body.division || "").trim();
        // 🔴 ROUND 167 — REQUIRED, THE SAME AS A PARTNER AND FOR THE SAME
        // REASON. Blank means "every division" (inDivision), so an event saved
        // without one is shown to every viewer whichever division they work
        // in — and that is precisely the leak that put "OLTL" on an ODP-only
        // viewer's heading. Round 143 closed it for partners at the DIALOG
        // only; this closes it at both ends for events, because a dialog guard
        // alone still accepts a direct API call.
        if (!evDivWanted)
          return NextResponse.json(
            {
              error: "An event needs a division.",
              detail:
                "An event with no division is shown to everybody, whichever division they work in. Nothing was created.",
              status: 400,
            } as ApiError,
            { status: 400 },
          );
        const evDivOk = await divisionAllowed(evDivWanted);
        if (evDivOk !== true) return refuseDivision(evDivWanted, evDivOk, "an event");
        put(EVENT_FIELDS.division.name, EVENT_FIELDS.division.id, evDivWanted);
        if (Number(body.cost) > 0)
          put(EVENT_FIELDS.cost.name, EVENT_FIELDS.cost.id, Number(body.cost));

        // ═══════════════════════════════════════════════════════════════════
        // 🔴 ROUND 124 · ITEM 1 — THE VENUE IS THE CONTACT.
        //
        // GoHighLevel allows ONE opportunity per contact per pipeline. The
        // event's contact was the HOST PARTNER, so a partner could host exactly
        // one event ever: Riddle Hospital's second was refused, and a
        // spreadsheet of past events would have created a handful and silently
        // dropped the rest.
        //
        // ⚠️ THE VENUE IS A REAL PLACE WITH A REAL NAME, which is why this is
        // not the fake contact round 107 refused to invent. "Delco Expo Centre"
        // is a contact record somebody could ring.
        //
        // ⚠️ EVENT HOST IS UNCHANGED AND STAYS THE PARTNER. It was already a
        // custom field; nothing that reads it ("Events worked", "Run by")
        // changes. What changes is which contact the opportunity hangs off.
        //
        // 🔴 AND THE HOST IS NO LONGER REQUIRED. It was required only because
        // GoHighLevel needed a contact and the partner was the only one to
        // hand. An event the agency runs itself now has somewhere to live.
        // ═══════════════════════════════════════════════════════════════════
        const venue = (body.venue || "").trim();
        if (!venue)
          return NextResponse.json(
            {
              error: "An event needs a venue.",
              detail:
                "GoHighLevel attaches every opportunity to a contact, and for an event that is the place it is held. The venue becomes a contact record so a partner can host more than one event.",
              status: 400,
            } as ApiError,
            { status: 400 },
          );

        // 🔴 THE REMAINING COLLISION, CHECKED BEFORE ANYTHING IS WRITTEN. One
        // contact per venue means one EVENT per venue, so a second event at the
        // same place still collides — option (a). It is refused with a message
        // that says what to do, rather than by GoHighLevel's duplicate error.
        //
        // ⚠️ CHECKED ON THE VENUE NAME, NOT ON THE CONTACT. That is the thing
        // somebody actually meant, and it holds even if the contact lookup
        // below picks a different record than last time.
        const existingEvents = await getOpportunitiesInPipeline(evPipe);
        const venueField = oppDefs.find(
          (d) => norm(d.name) === norm(EVENT_FIELDS.venue.name),
        )?.id || EVENT_FIELDS.venue.id;
        const clash = existingEvents.find(
          (r) => norm(String(r.cf?.[venueField] ?? "")) === norm(venue),
        );
        if (clash)
          return NextResponse.json(
            {
              error: `${venue} already hosts an event.`,
              detail: `"${clash.oppName || "an existing event"}" is recorded there, and GoHighLevel allows one opportunity per contact per pipeline. Rename the venue for this one — "${venue} (Spring)" — or record it under a different venue. Nothing was created.`,
              refusal: true,
              status: 409,
            } as ApiError,
            { status: 409 },
          );

        // ── the venue's contact ────────────────────────────────────────────
        // ⚠️ REUSE BEFORE CREATE, so a venue whose only event was deleted does
        // not accumulate a second contact record.
        //
        // 🔴 AND NEVER REUSE A PARTNER. Venue names and partner names overlap
        // constantly — "Riddle Hospital" is both a plausible venue and an
        // actual partner on this account — and attaching the event to the
        // PARTNER's contact is the exact bug this item exists to remove. The
        // partner list is read and excluded rather than hoped about.
        const defsV = await getEditableFieldDefs("contact");
        const rtV =
          defsV.find((d) => norm(d.name) === norm(PARTNER_FIELDS.recordType.name))?.id ||
          PARTNER_FIELDS.recordType.id;
        // 🔴 ROUND 166 — ONE CALL, AND IT NO LONGER USES THE WRONG ENDPOINT.
        //
        // This block used to search, pick a reusable hit, and then fall through
        // to `upsertContact({ name, source })` — which GoHighLevel refuses with
        // 400 "Pass at least one of number, email query parameter", because an
        // upsert needs a deduplication key and a venue has neither. So "Add an
        // event" has failed for EVERY NEW VENUE since round 124 shipped it, and
        // only ever succeeded down the reuse path.
        //
        // `ensureContact` holds the whole decision now (lib/ghl.ts): a key
        // means upsert, no key means search-then-create. The exclusion list is
        // the only venue-specific part, and it stays here because it is data
        // rather than policy.
        const partnersNow = await ghlSearchContacts(rtV, PARTNER_RECORD_TYPE);
        let venueContactId = "";
        let venueHow: "upserted" | "reused" | "created" = "created";
        try {
          const got = await ensureContact({
            name: venue,
            source: "Event venue",
            // ⚠️ NO Record Type. The picklist holds "Referral Partner" and
            // "Event Attendee" and nothing else; writing a third value into a
            // SINGLE_OPTIONS field is unverified against this account, and a
            // venue must not read as either of the two that exist. Leaving it
            // unset keeps the venue out of both searches, which is correct —
            // the app never lists venues.
            //
            // 🔴 AND NEVER REUSE A PARTNER, OR THE HOST. Venue names and
            // partner names overlap constantly — "Riddle Hospital" is both a
            // plausible venue and an actual partner on this account — and
            // attaching the event to the PARTNER's contact is the exact bug
            // round 124 exists to remove.
            // 🔴 A VENUE IS A PLACE, SO ITS NAME IDENTIFIES IT. Two events at
            // "Delco Expo Centre" are two events at one address; without reuse
            // the account grows a contact per event for the same hall.
            nameIdentifies: true,
            excludeIds: [...partnersNow.rows.map((r) => r.id), ...(hostId ? [hostId] : [])],
          });
          venueContactId = got.id;
          venueHow = got.how;
        } catch (e) {
          // 🔴 TRANSLATED, AND IT SAYS NOTHING WAS CREATED. Every other refusal
          // in this handler ends with that sentence; this path reached the
          // screen as a bare "Could not save." plus GoHighLevel's wording about
          // a query parameter, which is why it read as a crash rather than a
          // thing with a cause. Nothing before this point writes — the
          // pipeline, the field defs, the clash check and both searches are all
          // reads — so the claim is true and not a hope.
          const d = e instanceof GhlError ? e : null;
          return NextResponse.json(
            {
              error: `The venue "${venue}" could not be saved as a contact.`,
              detail: `${d?.detail || (e instanceof Error ? e.message : String(e))} Nothing was created.`,
              status: d?.status === 422 || d?.status === 400 ? 400 : 502,
            } as ApiError,
            { status: d?.status === 422 || d?.status === 400 ? 400 : 502 },
          );
        }
        if (!venueContactId)
          return NextResponse.json(
            {
              error: "The venue's contact record could not be created.",
              detail: `GoHighLevel returned no contact id for "${venue}". Nothing was created.`,
              status: 502,
            } as ApiError,
            { status: 502 },
          );

        const oppId = await createOpportunity({
          pipelineId: evPipe.id,
          stageId,
          contactId: venueContactId,
          name,
          ...(Number(body.cost) > 0 ? { monetaryValue: 0 } : {}),
          customFields: cf,
        });
        if (!oppId)
          return NextResponse.json(
            {
              error: "The event was not created.",
              detail: "GoHighLevel returned no opportunity id.",
              status: 502,
            } as ApiError,
            { status: 502 },
          );
        return NextResponse.json({
          ok: true,
          eventId: oppId,
          pipelineName: evPipe.name,
          venueContactId,
          // ⚠️ ROUND 166 — NOW THREE-VALUED, NOT A BOOLEAN. `venueReused` was
          // `!!reuse`, which could only say "an existing contact" or "a new
          // one" — and a new one was the case that never actually worked. The
          // word says which of the three paths ran, so a response that looks
          // successful can be told apart from one that was.
          venueContact: venueHow,
          venueReused: venueHow === "reused",
          skipped: missing,
        });
      }

      // ── add someone met at an event ────────────────────────────────────────
      // 🔴 A FIRST NAME OR A PHONE IS REQUIRED, AND THAT IS YOUR CALL, NOT MINE
      // TO SOFTEN. The brief's three fields (profile, outcome, note) would have
      // created a contact with no identifying detail at all: GoHighLevel may
      // refuse it outright, and if it does not, the record is UNDEDUPABLE — the
      // same person met at two events becomes two contacts for ever, and bulk
      // import multiplies that by however many were met.
      // ═══════════════════════════════════════════════════════════════════
      // 🔴 ROUND 122 · ITEM 15 — A CONTACT ID OUT OF THE URL.
      //
      // ⚠️ AND THE BRIEF'S PREMISE NEEDS ONE CORRECTION: there are no
      // OPPORTUNITY ids in query strings. What was there is a CONTACT id —
      // `/api/referrals?only=contact-opps&contactId=…` — which is the more
      // sensitive of the two, because a contact is a person and an opportunity
      // is a case. Opportunity ids appear in PATHS (`/api/opportunities/{id}`),
      // which is a separate question answered in the report.
      //
      // 🔴 A FRAGMENT CANNOT WORK. `#…` is never transmitted to a server, so it
      // is unusable for a read the server has to perform. A path segment is no
      // better than a query string — both are the URL. A POST body is the only
      // form that keeps the id out of access logs, browser history and any
      // Referer header.
      //
      // ⚠️ THE COST IS THAT A READ IS NOW A POST, which is semantically odd and
      // defeats HTTP caching. This route is `no-store` and `force-dynamic`, so
      // there was no caching to lose — that is the whole of the trade here, and
      // it would not be true of a cacheable endpoint.
      // ═══════════════════════════════════════════════════════════════════
      if (body.action === "contact-opps") {
        const cid = clean(body.contactId);
        if (!cid) return NextResponse.json({ opportunities: [] });
        return contactOpps(cid, session, isAdminSession(session?.role, session?.type) || !session);
      }

      if (body.action === "touch") {
        const ids = (Array.isArray(body.touchFor) ? body.touchFor : [])
          .map((v: unknown) => clean(v))
          .filter(Boolean) as string[];
        if (!ids.length) return NextResponse.json({ touch: {}, meta: { touchAsked: 0,
          touchResolved: 0, touchFailed: 0, touchCapped: 0, touchCap: TOUCH_CAP } });
        const defsT = await getEditableFieldDefs("contact");
        const rtT =
          defsT.find((d) => norm(d.name) === norm(PARTNER_FIELDS.recordType.name))?.id ||
          PARTNER_FIELDS.recordType.id;
        return measureTouches(ids, { recordType: rtT });
      }

      // ═══════════════════════════════════════════════════════════════════
      // 🔴 ROUND 124 — AN ATTENDEE'S OWN FIELDS. **AND THIS IS A LIVE BUG FIX,
      // NOT A NEW FEATURE.**
      //
      // The Event Outcome dropdown wrote to `/api/contacts/{a.id}/fields`, and
      // round 122 justified that with "no new write path — that route already
      // exists". It does. It takes an **OPPORTUNITY id**, not a contact id:
      // `gate()` calls getOpportunityById() and borrows the opportunity's
      // visibility rule before touching its contact. An attendee is a contact
      // with no opportunity, so every one of those writes got
      // `404 Record not found`.
      //
      // ⚠️ SO THE OUTCOME DROPDOWN HAS NEVER WORKED. The path LOOKED right
      // because the URL says "contacts"; nothing in the name says the id is an
      // opportunity's. Found by driving the route in round 124's proof.
      //
      // ⚠️ AND THE FIX IS NOT TO LET THAT ROUTE TAKE A CONTACT ID. Its whole
      // defence is that permission is borrowed from a record the caller can
      // already see; accepting a bare contact id would make it a way to write
      // any contact on the account. An attendee has no opportunity to borrow
      // from, so the check here is the one `partnerNotes` uses: **the contact
      // must actually be an Event Attendee**, verified server-side, and only
      // the two attendee fields can be written.
      // ═══════════════════════════════════════════════════════════════════
      if (body.action === "attendee-field") {
        const cid = clean(body.contactId);
        const which = body.field === "event" ? "event" : "outcome";
        if (!cid)
          return NextResponse.json(
            { error: "No attendee asked for.", status: 400 } as ApiError,
            { status: 400 },
          );
        const defsA = await getEditableFieldDefs("contact");
        const pickA = (names: readonly string[], fallbackId: string) =>
          defsA.find((d) => names.some((n) => norm(d.name) === norm(n)))?.id ||
          (defsA.some((d) => d.id === fallbackId) ? fallbackId : "");
        const rtA =
          defsA.find((d) => norm(d.name) === norm(PARTNER_FIELDS.recordType.name))?.id ||
          PARTNER_FIELDS.recordType.id;
        const target =
          which === "event"
            ? pickA(ATTENDEE_EVENT_FIELD_NAMES, "")
            : defsA.find((d) => norm(d.name) === norm(ATTENDEE_FIELDS.outcome.name))?.id ||
              ATTENDEE_FIELDS.outcome.id;
        if (!target)
          return NextResponse.json(
            {
              error:
                which === "event"
                  ? "There is no Event Attended field on this account."
                  : "There is no Event Outcome field on this account.",
              detail: "Nothing was changed.",
              status: 409,
            } as ApiError,
            { status: 409 },
          );
        const read = await getContactCustomFields(cid);
        const rt = read.values[rtA];
        const rtStr = Array.isArray(rt) ? rt.map(String).join(", ") : String(rt ?? "");
        // ⚠️ A RECORD-TYPE CHECK, NOT AN ACCESS ONE — the same shape and the
        // same reason as partnerNotes: without it, a contact id from a browser
        // is a way to write fields on contacts this screen has nothing to do
        // with.
        if (!new RegExp(ATTENDEE_RECORD_TYPE, "i").test(rtStr))
          return NextResponse.json(
            {
              error: "That contact is not an event attendee.",
              detail: `Its ${PARTNER_FIELDS.recordType.name} is "${rtStr || "(not set)"}". Only an attendee's event fields are writable here.`,
              status: 409,
            } as ApiError,
            { status: 409 },
          );
        const expected = clean(body.expectedVersion);
        if (expected && read.version && expected !== read.version)
          return NextResponse.json(
            {
              error: "Somebody else changed this attendee while you were looking at it.",
              detail: "Nothing was changed. Refresh to see their version, then try again.",
              status: 409,
            } as ApiError,
            { status: 409 },
          );
        await updateContactCustomFields(cid, [
          { id: target, value: typeof body.value === "string" ? body.value : "" },
        ]);
        const after = await getContactCustomFields(cid);
        return NextResponse.json({ ok: true, version: after.version });
      }

      if (body.action === "partner-notes") {
        const id = clean(body.contactId);
        if (!id)
          return NextResponse.json(
            { error: "No partner asked for.", status: 400 } as ApiError,
            { status: 400 },
          );
        const defsN = await getEditableFieldDefs("contact");
        const rtId =
          defsN.find((d) => norm(d.name) === norm(PARTNER_FIELDS.recordType.name))?.id ||
          PARTNER_FIELDS.recordType.id;
        return partnerNotes(id, { recordType: rtId });
      }

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

        const aEmail = clean(body.email);

        // ═══════════════════════════════════════════════════════════════════
        // 🔴 ROUND 122 · ITEM 1 — THE OVERWRITE, WHICH IS THE ACTUAL DATA LOSS.
        //
        // ⚠️ THE MODEL STORES ONE EVENT PER ATTENDEE. `Event Attended` is a
        // single contact field, so a person can be recorded at exactly one
        // event — and `upsertContact` MATCHES ON PHONE OR EMAIL. Meeting the
        // same person at a second expo therefore rewrote their first
        // attendance, silently, with no error and nothing on screen.
        //
        // 🔴 THAT IS WORSE THAN THE TWO DROPDOWNS ROUND 107 NAMED. Two
        // dropdowns are two views of one value; this destroys the value.
        //
        // ⚠️ SO IT IS REFUSED, NOT MERGED. Merging would need a multi-value
        // field this account does not have, and inventing one here — silently,
        // inside a write — is the kind of model change round 122's item 4 is
        // being held for. A refusal loses nothing and says exactly what it
        // found.
        // ═══════════════════════════════════════════════════════════════════
        if (evDef && (body.eventId || "").trim()) {
          const needle = phone || aEmail;
          if (needle) {
            try {
              const hits = await searchContacts(needle);
              // ⚠️ EXACTLY ONE MATCH, OR NOTHING. Two contacts sharing a phone
              // is ambiguous, and guessing which one is about to be overwritten
              // is not better than the overwrite.
              const exact = hits.filter(
                (h) =>
                  (phone && h.phone && norm(h.phone) === norm(phone)) ||
                  (aEmail && h.email && norm(h.email) === norm(aEmail)),
              );
              if (exact.length === 1) {
                const cur = await getContactCustomFields(exact[0].id);
                const already = String(cur.values?.[evDef.id] ?? "").trim();
                if (already && already !== (body.eventId || "").trim()) {
                  // ⚠️ The stored value IS the event's opportunity id — there is
                  // no name on the contact to read, and fetching one to make a
                  // refusal prettier is a request spent on decoration.
                  const evName = already;
                  return NextResponse.json(
                    {
                      error:
                        `${exact[0].name || "This person"} is already recorded at another event, ` +
                        "and a contact can only hold one. Adding them here would erase that — " +
                        "so nothing was changed.",
                      detail:
                        `Their Event Attended currently points at ${evName}. GoHighLevel stores ` +
                        "it as a single field on the contact, so the same person cannot be " +
                        "recorded at two events until that changes. Log this meeting as a touch " +
                        "on the partner instead, or clear their Event Attended in GoHighLevel " +
                        "first if the earlier one was wrong.",
                      status: 409,
                      // A REFUSAL — round 119, item 3. The app declined on
                      // purpose and the message is the instruction.
                      refusal: true,
                    } as ApiError,
                    { status: 409 },
                  );
                }
              }
            } catch {
              // ⚠️ A FAILED LOOK-UP IS NOT A CLEAR RESULT. It must not become a
              // refusal (that would block a legitimate add over a GHL wobble)
              // and it must not become permission either — so the write goes
              // ahead exactly as it did before this guard existed, which is the
              // behaviour we already had rather than a new failure mode.
            }
          }
        }

        // 🔴 ROUND 166 — ensureContact, FOR THE SAME REASON AS THE VENUE. This
        // passed phone and email CONDITIONALLY, so a person met at an event
        // whose card you never got — a name and nothing else — hit the same
        // 400 "Pass at least one of number, email query parameter" as the
        // venue path. Latent rather than certain, which is why it went
        // unnoticed: most attendees have a phone.
        const c = await ensureContact({
          // 🔴 A PERSON'S NAME DOES NOT IDENTIFY THEM, so with no phone and no
          // email this ALWAYS creates. Two people called Nina met at two
          // different events are two different people, and reusing on a
          // first-name match would file the second one's outcome onto the
          // first one's record — a wrong merge, which is worse than a visible
          // duplicate. Venues and partners are the opposite case and say so.
          nameIdentifies: false,
          firstName,
          lastName: clean(body.lastName),
          name: `${firstName} ${clean(body.lastName)}`.trim() || phone,
          ...(phone ? { phone } : {}),
          ...(aEmail ? { email: aEmail } : {}),
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
        // 🔴 ROUND 167 · C10 — same rule, partner side.
        const pDivWanted = (body.division || "").trim();
        // ⚠️ ROUND 167 — AND NOW THE SERVER ENFORCES IT TOO. Round 143 made
        // this required in the dialog (`!div` on the Save button) and left the
        // route accepting a blank, so a direct call could still create the
        // visible-to-everyone partner the requirement exists to stop. Same
        // argument as the client-pipeline filter: "filtering only on the
        // dropdown is the same fault with a cosmetic patch over it".
        if (!pDivWanted)
          return NextResponse.json(
            {
              error: "A partner needs a division.",
              detail:
                "A partner with no division is shown to everybody, whichever division they work in. Nothing was created.",
              status: 400,
            } as ApiError,
            { status: 400 },
          );
        const pDivOk = await divisionAllowed(pDivWanted);
        if (pDivOk !== true) return refuseDivision(pDivWanted, pDivOk, "a partner");
        put(PARTNER_FIELDS.division.name, PARTNER_FIELDS.division.id, pDivWanted);
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

        // 🔴 AN EXISTING CONTACT IS PROMOTED, NOT DUPLICATED.
        // upsertContact dedupes on email/phone, so an organisation with neither
        // — which is most of them — would have been created a second time. When
        // the caller picked somebody, write the partner fields onto THAT record.
        const existingId = (body.contactId || "").trim();
        if (existingId) {
          if (cf.length) await updateContactCustomFields(existingId, cf);
          const promoteOwner = clean(body.owner);
          if (promoteOwner) await setContactOwner(existingId, promoteOwner);
          return NextResponse.json({
            ok: true,
            contactId: existingId,
            promoted: true,
            skipped: missing,
          });
        }

        // 🔴 A CONTACT AND NOTHING ELSE. A partner is not a case.
        const pEmail = clean(body.email);
        const pPhone = clean(body.phone);
        const pOwner = clean(body.owner);
        // 🔴 ROUND 166 — ensureContact. An organisation is exactly the case
        // that has a name and often nothing else: "Main Line Health" with no
        // switchboard number yet is a perfectly ordinary partner to add, and
        // it hit the same refusal as the venue.
        //
        // ⚠️ `name` IS THE ORG, AND IT BECOMES firstName WHEN THERE IS NO KEY.
        // That is deliberate and it is what the live probe showed works —
        // `name` alone is refused by the create endpoint, `firstName` is
        // accepted. The org is not split across firstName/lastName: see the
        // note on createContact.
        const c = await ensureContact({
          // 🔴 AN ORGANISATION'S NAME IDENTIFIES IT. "Main Line Health" is one
          // company however many times it is typed, so an exact match is the
          // same partner. The duplicate check above already refuses an obvious
          // re-add; this stops a second CONTACT for one that slips past it.
          nameIdentifies: true,
          firstName: clean(body.firstName),
          lastName: clean(body.lastName),
          name: org,
          ...(pEmail ? { email: pEmail } : {}),
          ...(pPhone ? { phone: pPhone } : {}),
          // 🔴 THE OWNER IS THE POINT OF THE FIELD, per the brief: "who holds
          // this relationship. Drives who sees it and whose queue it lands in."
          ...(pOwner ? { assignedTo: pOwner } : {}),
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
