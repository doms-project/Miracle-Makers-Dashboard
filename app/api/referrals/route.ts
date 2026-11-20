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
  ghlSearchContactsWhereSet,
  ghlSearchContactsAnyOf,
  getClientCaseRows,
  searchContacts,
  updateContactCustomFields,
  setContactOwner,
  getUserMap,
  explainGhlError,
  GhlError,
  type ContactByField,
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
import { checkExistingPerson, createPersonOrConflict } from "@/lib/existingPerson";
import { indexCaseHolders } from "@/lib/peopleSearch";
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

const clean = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const daysSince = (iso: string): number | null => {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
};

const TOUCH_CAP = 60;
const TOUCH_CHUNK = 15;
const TOUCH_CONCURRENCY = 5;
const TOUCH_PAUSE_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
        failed++;
        return;
      }

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

    | "contact-opps"
    | "partner-notes"

    | "touch"

    | "attendee-field";
  contactId?: string;

  touchFor?: unknown[];

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

  owner?: string;

  touchType?: string;
  text?: string;

  partnerId?: string;
  pipelineId?: string;
  monthlyValue?: number;

  eventId?: string;

  profile?: string;
  outcome?: string;

  eventDate?: string;
  venue?: string;
  cost?: number;
}

const optionsOf = (
  defs: { id: string; name: string; options?: string[] }[],
  name: string,
): string[] => defs.find((d) => norm(d.name) === norm(name))?.options || [];

async function eventsPipeline(): Promise<{
  pipe: { id: string; name: string; stages: { id: string; name: string; position?: number }[] } | undefined;

  via: "role" | "name" | "none";
}> {

  const [cfg, all] = await Promise.all([getPipelineConfig(), listPipelines()]);
  const byRole = pipelineWithRole(cfg, "events");
  if (byRole) {
    const hit = all.find((p) => p.id === byRole);

    if (hit) return { pipe: hit, via: "role" };
    return { pipe: undefined, via: "none" };
  }

  const [client, unlisted] = await Promise.all([
    getSelectedPipelines("client"),
    getSelectedPipelines("none"),
  ]);
  const named = [...client, ...unlisted].find((p) => /^events?$/i.test(p.name.trim()));
  return named ? { pipe: named, via: "name" } : { pipe: undefined, via: "none" };
}

async function contactOpps(
  cid: string,
  session: { userId?: string; role?: string; type?: string } | null,
  isAdmin: boolean,
): Promise<NextResponse> {

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

          partnerId: String(r.cf?.[refId] ?? "").trim(),
        })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

async function attendeesByEventField(
  fieldId: string,
  eventIds: string[],
): Promise<{
  rows: ContactByField[];

  via: "exists" | "per-event" | "none";
  asked: number;
}> {
  if (!fieldId) return { rows: [], via: "none", asked: 0 };
  let set: Awaited<ReturnType<typeof ghlSearchContactsWhereSet>>;
  try {
    set = await ghlSearchContactsWhereSet(fieldId);
  } catch {

    set = { rows: [], via: "unsupported", truncated: false };
  }
  if (set.via === "exists" && set.rows.length)
    return { rows: set.rows, via: "exists", asked: 1 };

  if (!eventIds.length) return { rows: [], via: "none", asked: 0 };
  try {
    const fan = await ghlSearchContactsAnyOf(fieldId, eventIds);
    return { rows: fan.rows, via: "per-event", asked: fan.asked };
  } catch {

    return { rows: [], via: "none", asked: 0 };
  }
}

async function refuseExisting(
  args: Parameters<typeof checkExistingPerson>[0],
): Promise<NextResponse | null> {
  const r = await checkExistingPerson(args);
  return r ? NextResponse.json(r, { status: 409 }) : null;
}

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

async function partnerNotes(id: string, F: { recordType: string }): Promise<NextResponse> {
  const read = await getContactCustomFields(id);
  const rt = read.values[F.recordType];
  const rtStr = Array.isArray(rt) ? rt.map(String).join(", ") : String(rt ?? "");

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

      const autoTouch = url.searchParams.get("touch") === "auto";
      const only = url.searchParams.get("only") || "";

      const light = only === "notes" || only === "contacts" || only === "partners";

      const contactDefs = await getEditableFieldDefs("contact");

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

      const idOf = (name: string, fallback: string) =>
        contactDefs.find((d) => norm(d.name) === norm(name))?.id || fallback;
      const oppIdOf = (name: string, fallback: string) =>
        oppDefs.find((d) => norm(d.name) === norm(name))?.id || fallback;

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

      const attendeeEventField = anyOf(contactDefs, ATTENDEE_EVENT_FIELD_NAMES);

      const oppEventField =
        anyOf(oppDefs, OPP_EVENT_FIELD_NAMES) ||
        (oppDefs.some((d) => d.id === OPP_EVENT_FIELD_ID) ? OPP_EVENT_FIELD_ID : "");
      const eventHostField =
        anyOf(oppDefs, EVENT_HOST_FIELD_NAMES) ||
        (oppDefs.some((d) => d.id === EVENT_HOST_FIELD_ID) ? EVENT_HOST_FIELD_ID : "");

      if (only === "contacts") {
        const q = (url.searchParams.get("q") || "").trim();
        if (q.length < 2) return NextResponse.json({ contacts: [] });
        return NextResponse.json(
          { contacts: await searchContacts(q) },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      if (only === "people") {
        const q = (url.searchParams.get("q") || "").trim();
        if (q.length < 2) return NextResponse.json({ people: [] });
        const rtPeople = idOf(PARTNER_FIELDS.recordType.name, PARTNER_FIELDS.recordType.id);
        const [hits, caseRows] = await Promise.all([
          searchContacts(q),
          getClientCaseRows().catch(() => []),
        ]);
        const holders = new Map(
          indexCaseHolders(
            caseRows.map((r) => ({
              contactId: r.contactId,
              contactName: r.contactName,
              first: r.first,
              last: r.last,
              pipelineName: r.pipelineName,
              stage: r.stage,
              status: r.status,
              createdAt: r.createdAt,
            })),
          ).map((h) => [h.contactId, h]),
        );
        return NextResponse.json(
          {
            people: hits.map((h) => {
              const holding = holders.get(h.id);
              return {
                id: h.id,
                name: h.name,
                email: h.email,
                phone: h.phone,
                recordType: h.fields[rtPeople] || "",

                roleKnown: h.fieldsKnown,
                caseLabel: holding
                  ? `${holding.pipelineName}${holding.stage ? ` · ${holding.stage}` : ""}`
                  : "",
              };
            }),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      if (only === "partners") {
        const rt = idOf(PARTNER_FIELDS.recordType.name, PARTNER_FIELDS.recordType.id);
        const catId = idOf(PARTNER_FIELDS.category.name, PARTNER_FIELDS.category.id);
        const divId = idOf(PARTNER_FIELDS.division.name, PARTNER_FIELDS.division.id);

        const [res, pipesForPicker] = await Promise.all([
          ghlSearchContacts(rt, PARTNER_RECORD_TYPE),
          listPipelines(),
        ]);
        const pickerAdmin = !session || isAdminSession(session.role, session.type);

        const pickerDivisions = referralDivisions(
          session?.userId || "",
          new Map(pipesForPicker.map((p) => [p.id, p.name])),
          pickerAdmin,
          optionsOf(await getEditableFieldDefs("contact"), PARTNER_FIELDS.division.name),
        );
        const rows = res.rows
          .map((c) => ({
            id: c.id,

            org: c.company || c.name,
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

            withheld: res.rows.length - rows.length,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      const partnerRes = await ghlSearchContacts(F.recordType, PARTNER_RECORD_TYPE);

      const isAdmin = !session || isAdminSession(session.role, session.type);
      const [users, attendeeRes, allPipes] = await Promise.all([
        getUserMap(),
        ghlSearchContacts(F.recordType, ATTENDEE_RECORD_TYPE),

        listPipelines(),
      ]);
      const pipelineNameById = new Map(allPipes.map((p) => [p.id, p.name]));

      const allPartners: RawPartner[] = partnerRes.rows.map((c) => ({
        id: c.id,

        org: c.company || c.name,
        email: c.email,
        phone: c.phone,
        cat: c.fields[F.category] || "",
        tier: c.fields[F.tier] || "Prospect",
        division: c.fields[F.division] || "",
        owner: users.get(c.assignedTo) || "",
        ownerId: c.assignedTo || "",
        notes: c.fields[F.notes] || "",
        shared: false,
        lastTouch: null,
      }));

      const partnerDivisionOptions = optionsOf(contactDefs, PARTNER_FIELDS.division.name);
      const partnerDivisions = referralDivisions(
        session?.userId || "",
        pipelineNameById,
        isAdmin,
        partnerDivisionOptions,
      );
      const scoped = allPartners.map((p) => {

        const d = (p.division || "").trim();
        const mine = !partnerDivisions || !d || d === ALL_DIVISIONS || partnerDivisions.includes(d);

        const owned = !!p.ownerId && p.ownerId === (session?.userId || "");
        return { p, visible: mine || owned, shared: !mine && owned };
      });
      const partners: RawPartner[] = scoped
        .filter((s) => s.visible)
        .map((s) => ({ ...s.p, shared: s.shared }));

      const partnersWithheld = allPartners.length - partners.length;

      const partnersNoDivision = allPartners.filter((p) => !(p.division || "").trim()).length;

      const live = new Set(partners.map((p) => p.id));

      const want = (autoTouch ? partners.map((p) => p.id) : []).filter((id) =>
        live.has(id),
      );
      const touchTargets = want.slice(0, TOUCH_CAP);
      const { map: touchMap, failed: touchFailed } = await resolveTouches(touchTargets);
      for (const p of partners)
        if (touchMap[p.id] !== undefined) p.lastTouch = touchMap[p.id];

      const refField = oppIdOf("Referring Partner", REFERRING_PARTNER_FIELD);
      const { records, failedPipelines } = await getOltlOpportunities("client");

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

          name: r.oppName || `${r.first} ${r.last}`.trim() || "Untitled case",
          partnerId: String(r.cf?.[refField] ?? "").trim(),
          status: r.status,
          value: r.monetaryValue || 0,
          ago: daysSince(r.createdAt || ""),
          eventId: oppEventField ? String(r.cf?.[oppEventField] ?? "").trim() : "",

          pipelineName: r.pipelineName || "",

          visible: visibleIds.has(r.id),
        }))
        .filter((o) => o.partnerId);

      const danglingCount = danglingReferrals(allReferrals, allPartners);

      const scopedReferrals = partnerDivisions
        ? allReferrals.filter((o) =>
            partnerDivisions.includes(divisionLabel(o.pipelineName)),
          )
        : allReferrals;

      const referralsWithheld = allReferrals.length - scopedReferrals.length;
      const referrals = scopedReferrals;

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

            value: 0,
            ago: daysSince(r.createdAt || ""),
            eventId: "",

            pipelineName: r.pipelineName || "",
            visible: cgVisible.has(r.id),
          }))
          .filter((o) => o.partnerId);
      } catch {
        applicantRefs = [];
      }

      const evDate = oppIdOf(EVENT_FIELDS.date.name, EVENT_FIELDS.date.id);
      const evCost = oppIdOf(EVENT_FIELDS.cost.name, EVENT_FIELDS.cost.id);
      const evVenue = oppIdOf(EVENT_FIELDS.venue.name, EVENT_FIELDS.venue.id);
      const evDiv = oppIdOf(EVENT_FIELDS.division.name, EVENT_FIELDS.division.id);

      const evRecords = evPipe ? await getOpportunitiesInPipeline(evPipe) : [];

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

      const eventsWithheld = allEvents.length - events.length;

      const visibleEventIds = new Set(events.map((e) => e.id));
      const allEventIds = new Set(allEvents.map((e) => e.id));

      const extra = await attendeesByEventField(
        attendeeEventField,
        allEvents.map((e) => e.id),
      );
      const attendeeRowsById = new Map<string, (typeof attendeeRes.rows)[number]>();
      for (const r of attendeeRes.rows) attendeeRowsById.set(r.id, r);

      for (const r of extra.rows) attendeeRowsById.set(r.id, r);
      const attendeeRows = [...attendeeRowsById.values()];

      const allAttendees: RawAttendee[] = attendeeRows.map((c) => ({
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

          !allEventIds.has(a.eventId),
      );

      const attendeesWithheld = allAttendees.length - attendees.length;

      const attendeeSource = extra.via;

      const liveEventIds = new Set(allEvents.map((e) => e.id));
      const danglingAttendees = allAttendees.filter(
        (a) => a.eventId && !liveEventIds.has(a.eventId),
      ).length;

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

          applicantRefs,
          events,
          attendees,

          attendeeSource,

          viewer: { userId: session?.userId || "", isAdmin },
          owners: [...users.entries()].map(([id, name]) => ({ id, name })),
          categoryOptions: optionsOf(contactDefs, PARTNER_FIELDS.category.name),
          tierOptions: optionsOf(contactDefs, PARTNER_FIELDS.tier.name),

          divisionOptions: optionsOf(contactDefs, PARTNER_FIELDS.division.name),

          eventDivisionOptions: optionsOf(oppDefs, EVENT_FIELDS.division.name),
          outcomeOptions: optionsOf(contactDefs, ATTENDEE_FIELDS.outcome.name),

          clientPipelines: clientAllowed
            .map((p) => ({
              id: p.id,
              name: p.name,
              division: divisionLabel(p.name),

              stage: entryStage(p).name,
              stageId: entryStage(p).id,

              stageFellBack: entryStage(p).fellBack,
              stageWhy: entryStage(p).why,
            })),

          meta: {
            eventsPipelineConfigured: !!evPipe,
            eventsPipelineName: evPipe?.name || "",

            clientPipelinesWithheld: clientChoices.length - clientAllowed.length,

            partnersWithheld,

            partnersNoDivision,

            referralsWithheld,

            viewerDivisions: partnerDivisions ? partnerDivisions.length : null,

            viewerReferralDivisions: partnerDivisions,

            referralScopeKind: referralScopeKind(
              session?.userId || "",
              pipelineNameById,
              isAdmin,
              partnerDivisionOptions,
            ),

            eventsWithheld,

            attendeesWithheld,

            danglingAttendees,

            danglingReferrals: danglingCount,

            eventsPipelineVia: evFound.via,

            attendeeEventField,
            oppEventField,
            eventHostField,

            outcomeField: F.outcome,

            referringPartnerField: refField,

            touchAsked: want.length,
            touchResolved: touchTargets.length - touchFailed,
            touchFailed,
            touchCapped: Math.max(0, want.length - touchTargets.length),
            touchCap: TOUCH_CAP,
            partnersTruncated: partnerRes.truncated,
            attendeesTruncated: attendeeRes.truncated,

            hydrated: partnerRes.hydrated + attendeeRes.hydrated,
            unreadable: partnerRes.unreadable + attendeeRes.unreadable,

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

      let session: { userId?: string; role?: string; type?: string } | null = null;
      if (ssoConfigured()) {
        if (!body.ssoKey)
          return NextResponse.json(
            { error: "Sign-in required.", status: 401 } as ApiError,
            { status: 401 },
          );
        session = decryptSso(body.ssoKey);
      }

      const writeIsAdmin = !session || isAdminSession(session.role, session.type);

      const divisionAllowed = async (want: string): Promise<true | string[]> => {
        const d = (want || "").trim();
        if (!d || d === ALL_DIVISIONS || writeIsAdmin) return true;
        const names = new Map((await listPipelines()).map((p) => [p.id, p.name]));

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

        const n = await addContactNote(
          contactId,
          composeTouch(body.touchType || "", text),
          session?.userId || "",
        );
        return NextResponse.json({
          ok: true,
          noteId: n.id,

          dateAdded: n.dateAdded,
          lastTouch: n.dateAdded ? (daysSince(n.dateAdded) ?? 0) : 0,
        });
      }

      if (body.action === "log-referral") {
        const partnerId = (body.partnerId || "").trim();
        const who = `${(body.firstName || "").trim()} ${(body.lastName || "").trim()}`.trim();

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

              detail:
                "Nothing was created. A case filed there would not appear on your board. Ask an admin to grant you that pipeline on Admin → Access" +
                (allowed.length ? ", or file this referral in one of your own." : "."),
              status: 403,
            } as ApiError,
            { status: 403 },
          );

        const dest =
          allowed.find((p) => p.id === picked) ||
          allowed.find(
            (p) => norm(divisionLabel(p.name)) === norm((body.division || "Private Pay").trim()),
          ) ||
          allowed.find((p) => /private\s*pay/i.test(p.name));

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

        const cPhone = clean(body.phone);
        const cEmail = clean(body.email);

        const refExistingId = (body.contactId || "").trim();
        if (!refExistingId) {
          const refClash = await refuseExisting({
            phone: cPhone,
            email: cEmail,

            recordTypeFieldId: (await getEditableFieldDefs("contact")).find(
              (d) => norm(d.name) === norm(PARTNER_FIELDS.recordType.name),
            )?.id,
          });
          if (refClash) return refClash;
        }

        let contact: { id: string };
        if (refExistingId) contact = { id: refExistingId };
        else {
          const made = await createPersonOrConflict({
            firstName: clean(body.firstName),
            lastName: clean(body.lastName),
            name: who,
            ...(cPhone ? { phone: cPhone } : {}),
            ...(cEmail ? { email: cEmail } : {}),
          });
          if (!made.ok) return NextResponse.json(made.conflict, { status: 409 });
          contact = { id: made.id };
        }
        if (!contact.id)
          return NextResponse.json(
            {
              error: "Could not create the client's contact.",
              detail: "GoHighLevel returned no contact id. Nothing else was created.",
              status: 502,
            } as ApiError,
            { status: 502 },
          );

        const oppDefs = await getEditableFieldDefs("opportunity");
        const refId =
          oppDefs.find((d) => norm(d.name) === norm("Referring Partner"))?.id ||
          REFERRING_PARTNER_FIELD;
        const cf: { id: string; value: unknown }[] = [];
        if (partnerId) cf.push({ id: refId, value: partnerId });

        const evField =
          oppDefs.find((d) => OPP_EVENT_FIELD_NAMES.some((n) => norm(d.name) === norm(n)))
            ?.id ||
          (oppDefs.some((d) => d.id === OPP_EVENT_FIELD_ID) ? OPP_EVENT_FIELD_ID : "");
        const evId = (body.eventId || "").trim();
        const evSkipped = !!evId && !evField;
        if (evField && evId) cf.push({ id: evField, value: evId });

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

          eventLinkSkipped: evSkipped,
        });
      }

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

        const evDivWanted = (body.division || "").trim();

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

        const defsV = await getEditableFieldDefs("contact");
        const rtV =
          defsV.find((d) => norm(d.name) === norm(PARTNER_FIELDS.recordType.name))?.id ||
          PARTNER_FIELDS.recordType.id;

        const partnersNow = await ghlSearchContacts(rtV, PARTNER_RECORD_TYPE);
        let venueContactId = "";
        let venueHow: "upserted" | "reused" | "created" = "created";
        try {
          const got = await ensureContact({
            name: venue,
            source: "Event venue",

            nameIdentifies: true,
            excludeIds: [...partnersNow.rows.map((r) => r.id), ...(hostId ? [hostId] : [])],
          });
          venueContactId = got.id;
          venueHow = got.how;
        } catch (e) {

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

          venueContact: venueHow,
          venueReused: venueHow === "reused",
          skipped: missing,
        });
      }

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

        if (!(body.contactId || "").trim() && !firstName && !phone)
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

        put(ATTENDEE_FIELDS.profile.name, ATTENDEE_FIELDS.profile.id, (body.profile || "").trim());
        put(ATTENDEE_FIELDS.outcome.name, ATTENDEE_FIELDS.outcome.id, (body.outcome || "").trim());

        const evDef = defs.find((d) =>
          ATTENDEE_EVENT_FIELD_NAMES.some((n) => norm(d.name) === norm(n)),
        );
        if (evDef && (body.eventId || "").trim())
          cf.push({ id: evDef.id, value: (body.eventId || "").trim() });
        else if (!evDef) missing.push("the field linking an attendee to an event");

        const aEmail = clean(body.email);
        const rtDef =
          defs.find((d) => norm(d.name) === norm(PARTNER_FIELDS.recordType.name)) ||
          defs.find((d) => d.id === PARTNER_FIELDS.recordType.id);
        const rtOption = rtDef
          ? (rtDef.options || []).find((o) => norm(o) === norm(ATTENDEE_RECORD_TYPE)) ||
            (rtDef.options?.length ? "" : ATTENDEE_RECORD_TYPE)
          : "";

        const metExistingId = (body.contactId || "").trim();
        if (!metExistingId) {
          const clash = await refuseExisting({
            phone,
            email: aEmail,
            recordTypeFieldId: rtDef?.id,
            eventFieldId: evDef?.id,
          });
          if (clash) return clash;
        }

        if (evDef && (body.eventId || "").trim()) {

          if (metExistingId) {
            try {
              const cur = await getContactCustomFields(metExistingId);
              const already = String(cur.values?.[evDef.id] ?? "").trim();
              if (already && already !== (body.eventId || "").trim())
                return NextResponse.json(
                  {
                    error:
                      "That person is already recorded at another event, and a " +
                      "contact can only hold one. Adding them here would erase " +
                      "that — so nothing was changed.",
                    detail:
                      `Their Event Attended currently points at ${already}. GoHighLevel ` +
                      "stores it as a single field on the contact, so the same person " +
                      "cannot be recorded at two events until that changes.",
                    status: 409,
                    refusal: true,
                  } as ApiError,
                  { status: 409 },
                );
            } catch {

            }
          }
          const needle = metExistingId ? "" : phone || aEmail;
          if (needle) {
            try {
              const hits = await searchContacts(needle);

              const exact = hits.filter(
                (h) =>
                  (phone && h.phone && norm(h.phone) === norm(phone)) ||
                  (aEmail && h.email && norm(h.email) === norm(aEmail)),
              );
              if (exact.length === 1) {
                const cur = await getContactCustomFields(exact[0].id);
                const already = String(cur.values?.[evDef.id] ?? "").trim();
                if (already && already !== (body.eventId || "").trim()) {

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

                      refusal: true,
                    } as ApiError,
                    { status: 409 },
                  );
                }
              }
            } catch {

            }
          }
        }

        let c: { id: string };
        if (metExistingId) {

          let theirRecordType = "";
          try {
            const cur = await getContactCustomFields(metExistingId);
            if (rtDef) {
              const v = cur.values[rtDef.id];
              theirRecordType = Array.isArray(v) ? v.map(String).join(", ") : String(v ?? "");
            }
          } catch {

            theirRecordType = "(unreadable)";
          }
          const writes = [...cf];
          if (rtDef && rtOption && !theirRecordType.trim())
            writes.push({ id: rtDef.id, value: rtOption });
          if (writes.length) await updateContactCustomFields(metExistingId, writes);
          c = { id: metExistingId };
        } else {

          if (rtDef && rtOption) cf.push({ id: rtDef.id, value: rtOption });
          else if (rtDef) missing.push(`${PARTNER_FIELDS.recordType.name} has no option "${ATTENDEE_RECORD_TYPE}"`);

          const keyed = !!(phone || aEmail);
          if (keyed) {
            const outcome = await createPersonOrConflict({
              firstName,
              lastName: clean(body.lastName),
              ...(phone ? { phone } : {}),
              ...(aEmail ? { email: aEmail } : {}),
              ...(cf.length ? { customFields: cf } : {}),
            });
            if (!outcome.ok)
              return NextResponse.json(outcome.conflict, { status: 409 });
            c = { id: outcome.id };
            if (!c.id)
              return NextResponse.json(
                { error: "GoHighLevel returned no contact id.", status: 502 } as ApiError,
                { status: 502 },
              );
            let noteOk = true;
            if ((body.text || "").trim())
              try {
                await addContactNote(c.id, (body.text || "").trim(), session?.userId || "");
              } catch {
                noteOk = false;
              }
            return NextResponse.json({
              ok: true, contactId: c.id, skipped: missing,
              noteSaved: noteOk, usedExisting: false,
            });
          }
          const made = await ensureContact({

            nameIdentifies: false,
            firstName,
            lastName: clean(body.lastName),
            name: `${firstName} ${clean(body.lastName)}`.trim() || phone,
            ...(phone ? { phone } : {}),
            ...(aEmail ? { email: aEmail } : {}),
            ...(cf.length ? { customFields: cf } : {}),
          });
          c = { id: made.id };
        }
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
        return NextResponse.json({
          ok: true,
          contactId: c.id,
          skipped: missing,
          noteSaved,

          usedExisting: !!metExistingId,
        });
      }

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

        const pDivWanted = (body.division || "").trim();

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

        if (!cf.some((f) => f.id === (defs.find((d) => norm(d.name) === norm(PARTNER_FIELDS.recordType.name))?.id || PARTNER_FIELDS.recordType.id)))
          return NextResponse.json(
            {
              error: `This account has no "${PARTNER_FIELDS.recordType.name}" option for "${PARTNER_RECORD_TYPE}".`,
              detail: `Nothing was created. Add "${PARTNER_RECORD_TYPE}" as an option on the "${PARTNER_FIELDS.recordType.name}" contact field in GoHighLevel, then add the partner — a contact without it would be saved and then never show up here.`,
              status: 409,
            } as ApiError,
            { status: 409 },
          );

        const existingId = (body.contactId || "").trim();
        const rtPartnerId =
          defs.find((d) => norm(d.name) === norm(PARTNER_FIELDS.recordType.name))?.id ||
          PARTNER_FIELDS.recordType.id;
        if (existingId) {

          let theirs = "";
          try {
            const cur = await getContactCustomFields(existingId);
            const v = cur.values[rtPartnerId];
            theirs = (Array.isArray(v) ? v.map(String).join(", ") : String(v ?? "")).trim();
          } catch {

            theirs = "(unreadable)";
          }
          if (theirs && norm(theirs) !== norm(PARTNER_RECORD_TYPE))
            return NextResponse.json(
              {
                error: `${PARTNER_FIELDS.recordType.name} is already "${theirs}" on that contact.`,
                detail:
                  `Making them a ${PARTNER_RECORD_TYPE} would replace it, and ${PARTNER_FIELDS.recordType.name} holds one value — ` +
                  `they would drop out of whichever list "${theirs}" feeds. Nothing was changed. ` +
                  "Change it in GoHighLevel first if that is what you want, or add the organisation as a new partner.",
                status: 409,
                refusal: true,
              } as ApiError,
              { status: 409 },
            );

          const promoteWrites = cf.filter(
            (f) => f.id !== rtPartnerId || !theirs,
          );
          if (promoteWrites.length)
            await updateContactCustomFields(existingId, promoteWrites);
          const promoteOwner = clean(body.owner);
          if (promoteOwner) await setContactOwner(existingId, promoteOwner);
          return NextResponse.json({
            ok: true,
            contactId: existingId,
            promoted: true,
            skipped: missing,
          });
        }

        const pEmail = clean(body.email);
        const pPhone = clean(body.phone);
        const pOwner = clean(body.owner);

        const pClash = await refuseExisting({
          phone: pPhone,
          email: pEmail,
          recordTypeFieldId: rtPartnerId,
        });
        if (pClash) return pClash;

        if (pPhone || pEmail) {

          const madeP = await createPersonOrConflict({
            firstName: clean(body.firstName) || org,
            lastName: clean(body.lastName),
            companyName: org,
            ...(pEmail ? { email: pEmail } : {}),
            ...(pPhone ? { phone: pPhone } : {}),
            ...(pOwner ? { assignedTo: pOwner } : {}),
            ...(cf.length ? { customFields: cf } : {}),
          });
          if (!madeP.ok) return NextResponse.json(madeP.conflict, { status: 409 });
          return NextResponse.json({
            ok: true, contactId: madeP.id, skipped: missing,
          });
        }
        const c = await ensureContact({

          nameIdentifies: true,
          firstName: clean(body.firstName),
          lastName: clean(body.lastName),
          name: org,
          companyName: org,
          ...(pEmail ? { email: pEmail } : {}),
          ...(pPhone ? { phone: pPhone } : {}),

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
