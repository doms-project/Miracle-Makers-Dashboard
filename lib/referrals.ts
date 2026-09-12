// ---------------------------------------------------------------------------
// REFERRAL PARTNERS — the vocabulary and the arithmetic.
//
// 🔴 THE ARITHMETIC IS THE PRODUCT. The brief says so, and it is taken from the
// prototype VERBATIM rather than from the brief's prose summary — the two
// disagree in four places and the prototype is the one that runs. Every
// difference is marked ⚠️ PROTOTYPE where it appears.
//
// ⚠️ ISOMORPHIC. The section computes these to render and the route computes
// them to answer; two copies would drift.
// ---------------------------------------------------------------------------

/** Contact custom fields. Ids cross-check the NAME lookup, never replace it. */
export const PARTNER_FIELDS = {
  recordType: { id: "dmZVdhXsk65gRwUxHDpF", name: "Record Type" },
  category: { id: "QvRjlFRKR6ppml2QhUb7", name: "Partner Category" },
  tier: { id: "ywSQS5isNZlHRYMBLyGH", name: "Partner Tier" },
  division: { id: "H35ibbN8foJHjcYXIin5", name: "Partner Division" },
  notes: { id: "7bHU9QP42u5JCuOPZBbs", name: "Partner Notes" },
} as const;

/** Opportunity custom field holding the partner's CONTACT ID, as text. */
export const REFERRING_PARTNER_FIELD = "GE6Wj9WhrUVc2ZGwxqLP";

export const EVENT_FIELDS = {
  date: { id: "mMznBcCnLhHgcDpFlvXT", name: "Event Date" },
  cost: { id: "zLE1pSGVk6nqd9fSSZpT", name: "Event Cost" },
  venue: { id: "YOO9liW003qzzL5mpmpL", name: "Event Venue" },
  division: { id: "hXFg2oV0ERwzXfAqhi11", name: "Event Division" },
} as const;

export const ATTENDEE_FIELDS = {
  outcome: { id: "YKSpbg97jmo4W08q9vcz", name: "Event Outcome" },
  profile: { id: "UmuMBjb9JSMyvdJcFMNJ", name: "Attendee Profile" },
} as const;

export const PARTNER_RECORD_TYPE = "Referral Partner";
export const ATTENDEE_RECORD_TYPE = "Event Attendee";

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE THREE JOINS. THESE ARE THE EXACT NAMES THE ROUTE LOOKS FOR.
//
// You asked which names to create so they match. The FIRST entry in each list
// is canonical — create exactly that and everything below starts working with
// no code change. The rest are tolerated aliases so a near-miss spelling does
// not silently produce an empty Events tab.
//
//   1. Event Attended   CONTACT      ✅ already exists on the account
//   2. Event Source     OPPORTUNITY  ← create: which event produced this client
//   3. Event Host       OPPORTUNITY  ← create: which partner ran this event
//
// ⚠️ EVERY ONE IS **TEXT HOLDING AN ID**, exactly like `Referring Partner`.
// Report 99 (a) settled why, and it pays off three more times here: an
// opportunity's `cf` already rides along on the search this app makes anyway,
// so each join costs ZERO extra calls. An association would cost one request
// per record.
//
// ⚠️ `Event Source` IS YOUR SPELLING AND IT WINS. Report 101 proposed "Source
// Event"; you wrote "Event Source". Yours is canonical — mine is kept below as
// an alias so whichever exists is found, rather than the two of us each being
// half right and the tab rendering nothing.
// ═══════════════════════════════════════════════════════════════════════════

/** Which event this attendee was met at. Holds the event opportunity's id. */
export const ATTENDEE_EVENT_FIELD_NAMES = [
  "Event Attended",
  "Attended Event",
  "Event",
  "Event ID",
] as const;

/** Which event produced this client. Holds the event opportunity's id. */
export const OPP_EVENT_FIELD_NAMES = [
  "Event Source",
  "Source Event",
  "Referring Event",
] as const;

/**
 * Which partner ran this event. Holds the partner CONTACT's id.
 *
 * Powers "Run by [ Riddle Hospital ]" on an event card and the whole "Events
 * worked" section of the partner drawer. Absent → "No organisation linked",
 * which is the brief's own wording for it.
 */
export const EVENT_HOST_FIELD_NAMES = [
  "Event Host",
  "Hosted By",
  "Event Partner",
  "Host",
] as const;

/**
 * A touch's kind.
 *
 * ⚠️ The prototype's mock carries only `Visit` and `Call` (TOUCH_LOG:476) and
 * the brief says "Type and note" without listing values. Fixed list rather than
 * free text, for the same reason the categories are fixed: free text is how one
 * channel ends up counted twice.
 */
export const TOUCH_TYPES = ["Call", "Visit", "Email", "Event", "Other"] as const;

export const TIERS = ["A", "B", "C", "Prospect"] as const;
export type Tier = (typeof TIERS)[number];

/** Days between touches, by tier. */
export const CADENCE: Record<string, number> = { A: 14, B: 30, C: 90, Prospect: 21 };

/**
 * How hard an overdue touch pushes up the queue.
 *
 * 🔴 ⚠️ PROTOTYPE — THE BRIEF OMITS `Prospect`. It lists `{A:3, B:2, C:1}`; the
 * prototype has `{A:3, B:2, C:1, Prospect:2}`. Without the fourth entry a
 * Prospect's priority is `overdueBy * undefined` = NaN, and NaN sorts
 * unpredictably — the queue would put every Prospect in an arbitrary place with
 * nothing on screen to say why. Taken from the prototype.
 */
export const WEIGHT: Record<string, number> = { A: 3, B: 2, C: 1, Prospect: 2 };

/** ⚠️ PROTOTYPE — "due this week" is SEVEN days, not the brief's three. */
export const DUE_SOON_DAYS = 7;

export const OUTCOMES = [
  "Legit lead",
  "Warm interest",
  "Referral partner prospect",
  "Not qualified",
  "Noise",
] as const;
export const LEGIT_LEAD = "Legit lead";

/**
 * 🔴 A FALLBACK ONLY — THE LIVE FIELD IS THE TRUTH.
 *
 * Settled: the dropdown reads `Partner Category`'s own options from
 * GoHighLevel, so there is nothing to reconcile and editing the list in GHL
 * changes the dashboard with no deploy. This array is used ONLY when the field
 * has no options at all, which on a configured account never happens.
 *
 * ⚠️ SO DO NOT "FIX" THIS LIST TO MATCH THE ACCOUNT. It is not meant to match.
 * Three lists existed (16 in the prototype, 17 in the brief, 19 on the live
 * field) precisely because each was somebody's copy of another; a fourth copy
 * kept in sync by hand is the bug, not the cure.
 */
export const PARTNER_CATEGORIES = [
  "Hospital discharge",
  "SNF / rehab",
  "Assisted living",
  "Elder law",
  "Financial advisor",
  "Geriatric care mgmt",
  "Hospice",
  "Physician practice",
  "Disability services org",
  "Charity walk / fundraiser",
  "Community event / expo",
  "Support group",
  "Senior center",
  "Faith / community",
  "Chamber / business network",
  "Former client family",
] as const;

export const DIVISIONS = ["Private Pay", "OLTL", "ODP", "All"] as const;
export type Division = (typeof DIVISIONS)[number];

/**
 * ⚠️ A PARTNER MARKED "All" APPEARS UNDER EVERY DIVISION, not only under "All".
 * Same for an event. "All" is a property of the partner, not a filter value.
 */
export function inDivision(recordDivision: string, viewing: Division): boolean {
  if (viewing === "All") return true;
  const d = (recordDivision || "").trim();
  return !d || d === "All" || d === viewing;
}

export interface RawPartner {
  id: string;
  org: string;
  email: string;
  phone: string;
  cat: string;
  tier: string;
  division: string;
  owner: string;
  /**
   * The owner's USER ID, beside the resolved name.
   *
   * ⚠️ The Touch queue's Mine/All filter compares ids, never names. Two staff
   * called Chris, or a rename in GoHighLevel, would silently change who a
   * worklist belongs to if it matched on the display string.
   */
  ownerId: string;
  notes: string;
  /**
   * Days since the newest note on this contact.
   *
   * 🔴 NULL MEANS UNKNOWN, NOT ZERO — the notes for this partner have not been
   * fetched (Sources loads them for what is on screen only). A partner with no
   * note at all is `Infinity`, which IS overdue: nobody has ever spoken to
   * them, which is the point.
   */
  lastTouch: number | null;
}

export interface RawReferral {
  id: string;
  partnerId: string;
  status: string;
  value: number;
  /**
   * Days since the opportunity was created.
   *
   * 🔴 NULL MEANS UNDATED, NOT TODAY. GoHighLevel's opportunity search does not
   * guarantee a creation timestamp (the same uncertainty `stageChangedAt` was
   * given), and the prototype's `ago` is a plain number — so an absent date
   * would have become 0 and counted as "referred today" in every 90-day figure.
   * Undated referrals are counted in `refs`, excluded from `refs90`, and the
   * excluded number is stated: the round-97 rule.
   */
  ago: number | null;
  eventId?: string;
  /**
   * 🔴 WHOLE NUMBERS, FILTERED DETAIL — AND THIS FLAG IS THE WHOLE MECHANISM.
   *
   * True when `applyAccess` would show this opportunity to the viewer: one they
   * own or FOLLOW (anywhere), or an unassigned one in a pipeline they hold
   * (lib/pipelineAccess.ts:136-145).
   *
   * ⚠️ TAGGED, NOT SPLIT INTO TWO ARRAYS, and that is deliberate. Every
   * aggregate below — refs, won, revenue, winRate, lastRefAgo — reads the whole
   * array and IGNORES this flag, so a partner's win rate is the business's
   * number and identical for everyone. Only the drawer's per-record list, which
   * names individual cases, filters on it. Two arrays would make the next
   * person choose which to aggregate, and eventually they would choose wrong.
   *
   * 🔴 THE SEAM, ACCEPTED KNOWINGLY — DO NOT "FIX" IT BY SCOPING THE TOTALS.
   * Whole totals beside a filtered list make the withheld residual derivable:
   * `revenue − Σ(shown won values)`, and `lastRefAgo` is `min(ago)` over ALL,
   * so a hidden newest referral shows through. At exactly one withheld record
   * the aggregate IS that record. That is arithmetic, not an oversight: the
   * drawer already prints "6 of 12 shown", which announces the residual exists,
   * and what leaks is commercial shape only — no name, no contact detail, no
   * PHI. Making the totals viewer-scoped would give two people different win
   * rates under one label, which is the failure this design exists to avoid.
   */
  visible: boolean;
}

export interface EnrichedPartner extends RawPartner {
  cadence: number;
  /** Positive = days past cadence. Null when lastTouch is unknown. */
  overdueBy: number | null;
  isOverdue: boolean;
  /** Unknown last touch — rendered "—" and excluded from every count. */
  unknownTouch: boolean;
  priority: number;
  refs: number;
  refs90: number;
  /** Referrals with no creation date — excluded from refs90, never silent. */
  undated: number;
  /**
   * How many of this partner's referrals the viewer may see as records.
   *
   * ⚠️ NOT USED BY ANY AGGREGATE. It exists so the drawer can say "6 of 12
   * shown" — the count is the honesty, and the totals stay whole.
   */
  shown: number;
  won: number;
  revenue: number;
  winRate: number;
  lastRefAgo: number | null;
}

/** The prototype's `enrich`, verbatim apart from the unknown-touch handling. */
export function enrichPartner(
  p: RawPartner,
  referrals: RawReferral[],
): EnrichedPartner {
  const mine = referrals.filter((o) => o.partnerId === p.id);
  const won = mine.filter((o) => o.status === "won");
  const dated = mine.filter((o): o is RawReferral & { ago: number } => o.ago != null);
  const recent = dated.filter((o) => o.ago <= 90);
  const lastRef = dated.length ? Math.min(...dated.map((o) => o.ago)) : null;
  const cad = CADENCE[p.tier] ?? CADENCE.C;
  const unknownTouch = p.lastTouch == null;
  const over = unknownTouch ? null : (p.lastTouch as number) - cad;
  const weight = WEIGHT[p.tier] ?? 1;
  return {
    ...p,
    cadence: cad,
    overdueBy: over,
    isOverdue: over != null && over > 0,
    unknownTouch,
    // Unknown sits below everything actionable but above nothing — it is not a
    // claim that the partner is fine, only that we cannot say.
    priority: over == null ? -1e6 : over > 0 ? over * weight : -1000 + over,
    refs: mine.length,
    refs90: recent.length,
    undated: mine.length - dated.length,
    shown: mine.filter((o) => o.visible).length,
    won: won.length,
    revenue: won.reduce((a, o) => a + o.value, 0),
    winRate: mine.length ? Math.round((won.length / mine.length) * 100) : 0,
    lastRefAgo: lastRef,
  };
}

export interface RawAttendee {
  id: string;
  name: string;
  eventId: string;
  outcome: string;
  profile: string;
  /**
   * GoHighLevel's `dateUpdated`, for the outcome dropdown's concurrency check.
   *
   * ⚠️ "" WHEN THE SEARCH DID NOT SEND ONE. The check then cannot run and the
   * write proceeds — the same deliberate choice `OpportunityRecord.version`
   * documents. Refusing every triage because a timestamp is missing would be
   * worse than the last-write-wins behaviour we already have.
   */
  version: string;
}

export interface RawEvent {
  id: string;
  name: string;
  stage: string;
  date: string;
  cost: number;
  venue: string;
  division: string;
  /** Partner contact id from `Event Host`. "" = no organisation linked. */
  host: string;
}

/**
 * The prototype's `eventStats`, verbatim.
 *
 * 🔴 IT RETURNS ZEROS UNTIL AN ATTENDEE CARRIES AN EVENT ID — see
 * ATTENDEE_EVENT_FIELD_NAMES. The arithmetic is correct and the input is
 * missing, which is a different thing from the arithmetic being wrong, and the
 * Events tab must say which it is rather than drawing "0 met · 0 legit" as if
 * nobody came.
 */
export function eventStats(
  ev: RawEvent,
  attendees: RawAttendee[],
  referrals: RawReferral[],
) {
  const cs = attendees.filter((c) => c.eventId === ev.id);
  const legit = cs.filter((c) => c.outcome === LEGIT_LEAD).length;
  const partners = cs.filter((c) => c.outcome === "Referral partner prospect").length;
  const pending = cs.filter((c) => !c.outcome).length;
  const opps = referrals.filter((o) => o.eventId === ev.id);
  const wonOpps = opps.filter((o) => o.status === "won");
  return {
    met: cs.length,
    legit,
    partners,
    pending,
    clients: wonOpps.length,
    revenue: wonOpps.reduce((a, o) => a + o.value, 0),
    // Cost per LEGIT lead — null rather than 0 when none, so the tile can say
    // "—" instead of claiming a free lead.
    cpl: legit ? Math.round(ev.cost / legit) : null,
    contacts: cs,
  };
}

/**
 * The KPIs, from the prototype.
 *
 * ⚠️ PROTOTYPE vs BRIEF — `Active sources`. The prototype's Overview counts
 * EVERY visible partner (`all.length`); the brief defines it as "partners with
 * at least one referral in 90 days". The brief's is the one that means
 * something — a count of rows is already the row count — so BOTH are returned
 * and the tile uses `activeSources`, with `totalSources` beside it.
 */
export function partnerKpis(list: EnrichedPartner[]) {
  const known = list.filter((p) => !p.unknownTouch);
  return {
    totalSources: list.length,
    activeSources: list.filter((p) => p.refs90 > 0).length,
    refs90: list.reduce((a, p) => a + p.refs90, 0),
    won: list.reduce((a, p) => a + p.won, 0),
    revenue: list.reduce((a, p) => a + p.revenue, 0),
    /** Referrals with no creation date, so absent from every 90-day figure. */
    undatedRefs: list.reduce((a, p) => a + p.undated, 0),
    overdue: known.filter((p) => p.isOverdue).length,
    dueSoon: known.filter(
      (p) => !p.isOverdue && (p.overdueBy as number) >= -DUE_SOON_DAYS,
    ).length,
    later: known.filter(
      (p) => !p.isOverdue && (p.overdueBy as number) < -DUE_SOON_DAYS,
    ).length,
    // 🔴 STATED, NEVER SILENTLY DROPPED — the round-97 rule. A partner whose
    // notes have not loaded has an UNKNOWN last touch, and a queue that quietly
    // omits them under-counts exactly the people nobody has spoken to.
    unknown: list.length - known.length,
  };
}

/**
 * The event KPIs — and every one of them survives the attribution hole.
 *
 * ⚠️ NOTE WHAT THE BRIEF ASKED FOR: "Legit leads = Event Outcome = 'Legit lead'"
 * and "Awaiting review = attendees with no Event Outcome set" are counts across
 * ATTENDEES, not per event. So the Overview tiles are computable today even
 * though the per-event breakdown is not.
 */
export function eventKpis(events: RawEvent[], attendees: RawAttendee[]) {
  return {
    events: events.length,
    scheduled: events.filter((e) => /planned/i.test(e.stage || "")).length,
    cost: events.reduce((a, e) => a + e.cost, 0),
    attendees: attendees.length,
    legitLeads: attendees.filter((c) => c.outcome === LEGIT_LEAD).length,
    awaitingReview: attendees.filter((c) => !c.outcome).length,
    partnerProspects: attendees.filter((c) => c.outcome === "Referral partner prospect")
      .length,
  };
}

/**
 * THE DRAWER'S "EVENTS WORKED" — every event this partner ran, aggregated.
 *
 * ⚠️ NEEDS `Event Host`. With no host field the list is empty and the section
 * does not render at all, which is the brief's own rule ("only when there are
 * any") rather than a screen full of zeros.
 */
export function partnerEvents(
  partnerId: string,
  events: RawEvent[],
  attendees: RawAttendee[],
  referrals: RawReferral[],
) {
  const mine = events.filter((e) => e.host && e.host === partnerId);
  const rows = mine.map((e) => ({ event: e, st: eventStats(e, attendees, referrals) }));
  const met = rows.reduce((a, r) => a + r.st.met, 0);
  const legit = rows.reduce((a, r) => a + r.st.legit, 0);
  const clients = rows.reduce((a, r) => a + r.st.clients, 0);
  const cost = mine.reduce((a, e) => a + e.cost, 0);
  const revenue = rows.reduce((a, r) => a + r.st.revenue, 0);
  return {
    rows,
    count: mine.length,
    met,
    legit,
    clients,
    cost,
    revenue,
    // Same null-not-zero rule as the per-event cpl: no legit leads means we
    // cannot divide, not that the leads were free.
    cpl: legit ? Math.round(cost / legit) : null,
  };
}

/** Referrals pointing at a partner that no longer exists. */
export function danglingReferrals(
  referrals: RawReferral[],
  partners: { id: string }[],
): number {
  const live = new Set(partners.map((p) => p.id));
  return referrals.filter((o) => o.partnerId && !live.has(o.partnerId)).length;
}
