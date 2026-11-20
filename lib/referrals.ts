export const PARTNER_FIELDS = {
  recordType: { id: "dmZVdhXsk65gRwUxHDpF", name: "Record Type" },
  category: { id: "QvRjlFRKR6ppml2QhUb7", name: "Partner Category" },
  tier: { id: "ywSQS5isNZlHRYMBLyGH", name: "Partner Tier" },
  division: { id: "H35ibbN8foJHjcYXIin5", name: "Partner Division" },
  notes: { id: "7bHU9QP42u5JCuOPZBbs", name: "Partner Notes" },
} as const;

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

export const ATTENDEE_EVENT_FIELD_NAMES = [
  "Event Attended",
  "Attended Event",
  "Event",
  "Event ID",
] as const;

export const OPP_EVENT_FIELD_ID = "O87ax86ucnqvbXhJkkep";
export const EVENT_HOST_FIELD_ID = "PCbzK8AbUDYajq9Aja60";

export const OPP_EVENT_FIELD_NAMES = [
  "Event Source",
  "Source Event",
  "Referring Event",
] as const;

export const EVENT_HOST_FIELD_NAMES = [
  "Event Host",
  "Hosted By",
  "Event Partner",
  "Host",
] as const;

export const TOUCH_TYPES = ["Call", "Visit", "Email", "Event", "Other"] as const;

export function composeTouch(type: string, text: string): string {
  const t = (type || "").trim();
  const body = (text || "").trim();
  return t && (TOUCH_TYPES as readonly string[]).includes(t) ? `${t}: ${body}` : body;
}

export function parseTouch(body: string): { type: string; text: string } {
  const m = /^([A-Za-z][A-Za-z ]{0,12}):\s*([\s\S]*)$/.exec(body || "");
  if (m && (TOUCH_TYPES as readonly string[]).includes(m[1].trim()))
    return { type: m[1].trim(), text: m[2] };
  return { type: "", text: body || "" };
}

export const TIERS = ["A", "B", "C", "Prospect"] as const;
export type Tier = (typeof TIERS)[number];

export const CADENCE: Record<string, number> = { A: 14, B: 30, C: 90, Prospect: 21 };

export const WEIGHT: Record<string, number> = { A: 3, B: 2, C: 1, Prospect: 2 };

export const DUE_SOON_DAYS = 7;

export const OUTCOMES = [
  "Legit lead",
  "Warm interest",
  "Referral partner prospect",
  "Not qualified",
  "Noise",
] as const;
export const LEGIT_LEAD = "Legit lead";

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

export type Division = string;

export const ALL_DIVISIONS = "All";

export function inDivision(recordDivision: string, viewing: Division): boolean {
  if (viewing === ALL_DIVISIONS) return true;
  const d = (recordDivision || "").trim();
  return !d || d === "All" || d === viewing;
}

export function headingDivisions(
  viewerDivisions: readonly string[] | null | undefined,
  partners: readonly { division?: string }[],
  events: readonly { division?: string }[],
): string[] {
  const found = new Set<string>(viewerDivisions ?? []);
  for (const p of partners)
    if (p.division && p.division !== ALL_DIVISIONS) found.add(p.division);
  for (const e of events)
    if (e.division && e.division !== ALL_DIVISIONS) found.add(e.division);
  return [...found].sort();
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

  ownerId: string;
  notes: string;

  shared: boolean;

  lastTouch: number | null;
}

export interface RawReferral {
  id: string;

  name: string;
  partnerId: string;
  status: string;
  value: number;

  ago: number | null;

  pipelineName: string;
  eventId?: string;

  visible: boolean;
}

export interface EnrichedPartner extends RawPartner {
  cadence: number;

  overdueBy: number | null;
  isOverdue: boolean;

  unknownTouch: boolean;
  priority: number;
  refs: number;
  refs90: number;

  undated: number;

  shown: number;
  won: number;
  revenue: number;

  applicants: number;

  hired: number;
  winRate: number;
  lastRefAgo: number | null;
}

export function enrichPartner(
  p: RawPartner,
  referrals: RawReferral[],

  applicantRefs: RawReferral[] = [],
): EnrichedPartner {
  const mine = referrals.filter((o) => o.partnerId === p.id);

  const mineCg = applicantRefs.filter((o) => o.partnerId === p.id);
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

    priority: over == null ? -1e6 : over > 0 ? over * weight : -1000 + over,
    refs: mine.length,
    refs90: recent.length,
    undated: mine.length - dated.length,
    shown: mine.filter((o) => o.visible).length,
    won: won.length,
    revenue: won.reduce((a, o) => a + o.value, 0),
    applicants: mineCg.length,

    hired: mineCg.filter((o) => o.status === "won").length,
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

  host: string;
}

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

    cpl: legit ? Math.round(ev.cost / legit) : null,
    contacts: cs,
  };
}

export function partnerKpis(list: EnrichedPartner[]) {
  const known = list.filter((p) => !p.unknownTouch);
  return {
    totalSources: list.length,
    activeSources: list.filter((p) => p.refs90 > 0).length,
    refs90: list.reduce((a, p) => a + p.refs90, 0),
    won: list.reduce((a, p) => a + p.won, 0),
    revenue: list.reduce((a, p) => a + p.revenue, 0),

    applicants: list.reduce((a, p) => a + p.applicants, 0),
    hired: list.reduce((a, p) => a + p.hired, 0),

    undatedRefs: list.reduce((a, p) => a + p.undated, 0),
    overdue: known.filter((p) => p.isOverdue).length,
    dueSoon: known.filter(
      (p) => !p.isOverdue && (p.overdueBy as number) >= -DUE_SOON_DAYS,
    ).length,
    later: known.filter(
      (p) => !p.isOverdue && (p.overdueBy as number) < -DUE_SOON_DAYS,
    ).length,

    unknown: list.length - known.length,
  };
}

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

    cpl: legit ? Math.round(cost / legit) : null,
  };
}

export function danglingReferrals(
  referrals: RawReferral[],
  partners: { id: string }[],
): number {
  const live = new Set(partners.map((p) => p.id));
  return referrals.filter((o) => o.partnerId && !live.has(o.partnerId)).length;
}

export interface WithPendingResult<T> {

  rows: T[];

  stillPending: T[];
}

export function withPending<T extends { id: string }>(
  fromServer: readonly T[],
  pending: readonly T[],
): WithPendingResult<T> {
  const known = new Set(fromServer.map((r) => r.id));
  const stillPending = pending.filter((p) => p.id && !known.has(p.id));
  return { rows: [...stillPending, ...fromServer], stillPending };
}
