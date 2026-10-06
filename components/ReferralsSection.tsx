"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import ConfirmDialog from "./ConfirmDialog";
import { apiFetch, ApiError } from "@/lib/apiFetch";
import {
  CADENCE,
  DUE_SOON_DAYS,
  DIVISIONS,
  ALL_DIVISIONS,
  TIERS,
  OUTCOMES,
  PARTNER_CATEGORIES,
  inDivision,
  headingDivisions,
  enrichPartner,
  eventStats,
  partnerKpis,
  eventKpis,
  partnerEvents,
  TOUCH_TYPES,
  type Division,
  type EnrichedPartner,
  withPending,
  type RawPartner,
  type RawReferral,
  type RawEvent,
  type RawAttendee,
} from "@/lib/referrals";
import { divisionLabel } from "@/lib/division";

// ---------------------------------------------------------------------------
// REFERRAL PARTNERS — Sources · Touch queue · Events · Overview.
//
// 🔴 THE ARITHMETIC LIVES IN lib/referrals.ts, NOT HERE. It came from the
// prototype verbatim and the route computes from the same module, so the
// numbers on screen and the numbers in an answer cannot drift apart.
//
// ⚠️ EVERY NUMBER THAT IS NOT KNOWN SAYS SO. Three different kinds of "we do
// not know" run through this screen and none of them is allowed to render as a
// zero: a partner whose notes have not been measured (unknown last touch), a
// referral with no creation date (undated), and an event whose attendees cannot
// be attributed because no field links them. The round-97 rule, three times.
// ---------------------------------------------------------------------------

type Tab = "sources" | "queue" | "events" | "overview";

interface Owner {
  id: string;
  name: string;
}
interface PipelineChoice {
  id: string;
  name: string;
  division: string;
  stage: string;
  stageId: string;
  /**
   * 🔴 ROUND 126 — TRUE WHEN THE ENTRY STAGE IS A GUESS, so the dialog can say
   * so. The whole reason this bug survived round 121 is that a fallback looks
   * exactly like a decision from the outside: filing into TRANSFERRED IN
   * because nothing better was found reads identically to filing there on
   * purpose. A guess that admits it can be corrected; one that does not, is not
   * even noticed.
   */
  stageFellBack?: boolean;
  stageWhy?: string;
}

/**
 * ⚠️ EXPORTED FOR THE PAGE'S CACHE ONLY — analysis 104 · 13. The page holds one
 * of these between visits and hands it straight back; it never reads a field of
 * it, so this stays the section's shape rather than becoming a shared contract.
 */
export interface Payload {
  partners: RawPartner[];
  referrals: RawReferral[];
  /** ITEM 2 — applicant opportunities attributed to a partner. NEVER summed
      with revenue; see enrichPartner and the note on EnrichedPartner.applicants. */
  applicantRefs?: RawReferral[];
  events: RawEvent[];
  attendees: RawAttendee[];
  // 🔴 EVERY OPTION LIST COMES FROM GOHIGHLEVEL. The dialogs used to hold their
  // own copies; a dropdown offering a value the account has no option for
  // produces a save that silently drops it.
  viewer: { userId: string; isAdmin: boolean };
  owners: Owner[];
  categoryOptions: string[];
  tierOptions: string[];
  divisionOptions: string[];
  /** ROUND 128 — `Event Division`'s OWN options. Empty when it is not a picklist. */
  eventDivisionOptions?: string[];
  outcomeOptions: string[];
  clientPipelines: PipelineChoice[];
  meta: {
    eventHostField: string;
    outcomeField: string;
    eventsPipelineConfigured: boolean;
    eventsPipelineName: string;
    /**
     * 🔴 CLIENT PIPELINES THIS VIEWER MAY NOT FILE INTO — a count, never names.
     *
     * ⚠️ IT IS WHAT TELLS A FILTER FROM AN ABSENCE. `clientPipelines` empty and
     * this 0 means the account has none configured; empty and this above 0
     * means the viewer holds no grant. The two need different sentences, and
     * only one of them sends the reader to an admin.
     *
     * Optional so an older payload reads as 0 rather than undefined-in-a-test.
     */
    clientPipelinesWithheld?: number;
    /** Partners withheld from THIS viewer by division — task 2 · §4. */
    partnersWithheld?: number;
    /** Cases withheld from THIS viewer by division — task 2 · §2. */
    referralsWithheld?: number;
    /**
     * How many divisions this viewer holds. 0 = no pipeline at all, which
     * needs a different sentence from "some, but not that one". null = admin.
     */
    viewerDivisions?: number | null;
    /**
     * 🔴 ROUND 167 — THE VIEWER'S OWN DIVISION NAMES. `null` = all (admin or an
     * Agency grant), `[]` = none. The heading and the combined option's label
     * both come from this rather than from the records, because a division that
     * holds nothing yet is still the division you are looking at.
     */
    viewerReferralDivisions?: string[] | null;
    /** Why that list is what it is — see lib/pipelineAccess.referralScopeKind. */
    referralScopeKind?: "all" | "derived" | "none" | "explicit" | "unmatched";
    /** Events withheld from THIS viewer by division. A count, never names. */
    eventsWithheld?: number;
    /** Attendees whose event is withheld. A count, never names. */
    attendeesWithheld?: number;
    /**
     * 🔴 People recorded at an event that no longer exists — computed
     * SERVER-SIDE against the full event list, round 167. Never recomputed
     * here: once events are access-filtered the client cannot tell a deleted
     * event from a withheld one, exactly as round 145 found for partners.
     */
    danglingAttendees?: number;
    /** Partners with no division at all, so visible to everyone. Account-wide. */
    partnersNoDivision?: number;
    /**
     * 🔴 Cases whose partner was DELETED — computed server-side against the
     * full partner list, round 145. Never recomputed here: the client sees
     * only the partners it may see, so it cannot tell deleted from withheld.
     */
    danglingReferrals?: number;
    /** "role" = marked on the Pipelines screen · "name" = still matched on the string. */
    eventsPipelineVia?: "role" | "name" | "none";
    attendeeEventField: string;
    oppEventField: string;
    touchAsked: number;
    touchResolved: number;
    touchFailed: number;
    touchCapped: number;
    touchCap: number;
    partnersTruncated: boolean;
    attendeesTruncated: boolean;
    hydrated: number;
    unreadable: number;
    failedPipelines: { id: string; name: string; error: string }[];
  };
}

/** A partner nobody has ever left a note on. Overdue, not unknown. */
const NEVER = Number.MAX_SAFE_INTEGER;

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * 🔴 MONTHLY RECURRING, AND IT HAS TO SAY SO.
 *
 * `monetaryValue` on this account is a monthly figure — the rep types it at
 * referral time. So a partner's "revenue" is the monthly recurring revenue from
 * the cases they sent, NOT a lifetime total. Round 100's footnote said
 * "lifetime won opportunity value", which was a plain misstatement of the unit:
 * the same number labelled two different ways is how a forecast goes wrong by
 * a factor of twelve.
 *
 * ⚠️ Event COST is a one-off — a booth is paid once — so it is never /mo, and
 * neither is cost per lead. Only opportunity value carries the suffix.
 */
const moneyMo = (n: number) => `${money(n)}/mo`;
const CADENCE_WORD: Record<string, string> = {
  A: "biweekly",
  B: "monthly",
  C: "quarterly",
  Prospect: "3-weekly",
};
/**
 * 🔴 TASK 2 · §4 — THE SWITCHER'S SECOND NON-DIVISION VALUE.
 *
 * `ALL_DIVISIONS` was already one: a menu value that is not a division and is
 * never expected in the data. This is the other — "partners I own whose
 * division I do not hold" — and it mirrors the Clients board's `scope ===
 * "shared"` (app/page.tsx:2585) exactly.
 *
 * ⚠️ A SENTINEL THAT CANNOT COLLIDE WITH A REAL DIVISION. "Shared" is a
 * plausible thing for somebody to type into a picklist; the space and the
 * colon are not.
 */
const SHARED_SCOPE = "shared:owned";
/**
 * The name of a scope, as a reader should see it.
 *
 * ═══ ROUND 167 · B7 — "ALL" MUST NOT MEAN DIFFERENT THINGS TO DIFFERENT
 * PEOPLE ═══
 *
 * 🔴 IT READ "All divisions" FOR EVERYBODY. A viewer holding ODP and OLTL on a
 * five-division account read "All divisions" over two divisions' worth of
 * data — true in the sense that nothing was filtered on top, and false in
 * every sense the reader cares about. It is the same fault round 155 found in
 * `meta.pipelines` and the same one the single-division heading already avoids
 * by refusing to say "All" at all.
 *
 * ⚠️ `mine` IS THE VIEWER'S OWN DIVISIONS — `null` for an admin or an Agency
 * grant, meaning genuinely everything, which is the ONE case where "All
 * divisions" is the truth. A partial viewer gets their divisions named, so the
 * label and the numbers under it describe the same set.
 */
const divLabel = (d: Division, mine?: readonly string[] | null) =>
  d === "All"
    ? mine && mine.length
      ? mine.join(" + ")
      : "All divisions"
    : d === SHARED_SCOPE
      ? "Shared with me"
      : d;

/**
 * ═══ ROUND 167 · B8 — WHY YOU CAN SEE THIS ONE ════════════════════════════
 *
 * 🔴 A SOURCES ROW SAID NOTHING ABOUT DIVISION AT ALL. Org, category, tier,
 * owner, touch, refs, won, revenue — and no hint of which programme the partner
 * belongs to or why it reached this viewer. The one partner whose presence
 * needs explaining, an OLTL partner owned by an ODP rep, was the one explaining
 * itself least: `shared` has been in the payload since round 143 and was used
 * only to decide whether a switcher appeared.
 *
 * ⚠️ FOUR ANSWERS, AND THE DIFFERENCES MATTER TO DIFFERENT PEOPLE:
 *
 *   "Yours · OLTL"      you own it; its division is not one you hold. Reading
 *                       just "OLTL" here would look like a leak.
 *   "All divisions"     the record says so — a property, not a view.
 *   "No division ·      the labelled leak. Everyone sees it, nobody has said
 *    visible to         which programme it belongs to, and whoever can fix it
 *    everyone"          needs to be able to spot it on the row.
 *   "ODP"               the ordinary case.
 */
function DivisionTag({
  division,
  shared,
  what = "partner",
}: {
  division: string;
  shared?: boolean;
  /** "partner" or "event" — an event has no owner, so it has no "Yours". */
  what?: "partner" | "event";
}) {
  const d = (division || "").trim();
  if (shared)
    return (
      <span className="rfdivtag rfdivtag-mine" title="You own this partner, and its division is not one you hold">
        Yours · {d || "no division"}
      </span>
    );
  if (!d)
    return (
      <span
        className="rfdivtag rfdivtag-none"
        title={`This ${what} has no division, so it is shown to every viewer whichever division they work in`}
      >
        No division · visible to everyone
      </span>
    );
  if (d === ALL_DIVISIONS)
    return (
      <span
        className="rfdivtag rfdivtag-all"
        title={`This ${what} is marked "All", so it is shown to every viewer`}
      >
        All divisions · visible to everyone
      </span>
    );
  return <span className="rfdivtag">{d}</span>;
}

function TierBadge({ t }: { t: string }) {  const cls = t === "Prospect" ? "prospect" : t.toLowerCase();
  return <span className={`rfbadge ${cls}`}>{t || "—"}</span>;
}

function Kpi({
  label,
  value,
  desc,
  warn,
}: {
  label: string;
  value: string | number;
  desc: string;
  warn?: boolean;
}) {
  return (
    <div className="rfkpi">
      <div className="l">{label}</div>
      <div className={warn ? "v warn" : "v"}>{value}</div>
      <div className="d">{desc}</div>
    </div>
  );
}

/**
 * 🔴 ONE ROW PER CONTACT — round 122, item 1.
 *
 * `Event Attended` is a SINGLE contact field, so a person is recorded at one
 * event and cannot legitimately appear twice with different ones. What could
 * appear twice is the same contact reached through two lists, and that is a
 * rendering duplicate, not a data one.
 *
 * ⚠️ FIRST WINS, AND ORDER IS PRESERVED. Sorting or preferring "the one with an
 * outcome" would make the list reorder itself as somebody triages it.
 */
function dedupeByContact<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (!r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

export default function ReferralsSection({
  ssoBlob,
  ssoReady,
  reloadToken,
  onBusy,
  onOpenRecord,
  canOpenRecord,
  cache,
  onCache,
}: {
  /**
   * 🔴 ITEM 3 — OPEN AN ATTRIBUTED CASE'S RECORD. 118 deferred this believing
   * the panel's open path had to be lifted through the section switch. It does
   * not: the panel renders ABOVE that switch, so setting the id is enough.
   */
  onOpenRecord?: (id: string) => void;
  /** ⚠️ Whether THAT id is in the caller's loaded payload — see AttributedRow. */
  canOpenRecord?: (id: string) => boolean;
  /**
   * 🔴 ANALYSIS 104 · 13 — THE LAST PAYLOAD, HELD ABOVE THE SECTION SWITCH.
   *
   * This component is rendered conditionally, so leaving Referrals UNMOUNTS it
   * and coming back remounts it empty. `touch=auto` then re-measures from
   * scratch: Clients -> Referrals -> Clients -> Referrals was two full loads
   * and up to 120 contact-note reads, which is also the fastest way to trip the
   * rate limit. Caregivers solved this at the page level with `cgLoaded`;
   * Referrals had nothing.
   *
   * ⚠️ HELD BY THE PAGE, NOT FETCHED BY IT. The page never calls the route —
   * so someone who never opens Referrals still pays nothing, which is the
   * property the conditional render was for. Only a section that HAS loaded
   * leaves anything behind.
   *
   * ⚠️ THE PAYLOAD ONLY. Division, tab and sort deliberately reset: they are
   * where you were looking, not what was loaded, and restoring a filter
   * somebody set four screens ago is its own kind of surprise.
   */
  cache: Payload | null;
  /**
   * Called with the payload whenever it changes, so the page's copy is never
   * older than the screen.
   *
   * 🔴 EVERY CHANGE, NOT EVERY LOAD. Half the writes on this screen update
   * `data` optimistically and never refetch — a logged touch, an attendee
   * outcome. Mirroring only the successful loads would have made leaving and
   * returning UNDO them on screen while they stood in GoHighLevel, which is a
   * worse failure than the reload this replaces.
   *
   * ⚠️ MUST BE STABLE. It is a dependency of the mirror effect; an inline
   * arrow would re-run it on every render of the page.
   */
  onCache: (p: Payload) => void;
  ssoBlob: string | null;
  /**
   * 🔴 THE HANDSHAKE HAS SETTLED — a blob to send, or none ever coming.
   * NOT "the session has been decrypted": that is a separate round trip this
   * screen does not need, and waiting for it is what report 81 §3.1 measured.
   */
  ssoReady: boolean;
  /** Bumped by the toolbar's Refresh. One refresh button, every section. */
  reloadToken: number;
  onBusy: (busy: boolean) => void;
}) {
  const [data, setData] = useState<Payload | null>(cache);
  /**
   * 🔴 ROUND 175 · ITEM 3 — ROWS SAVED HERE THAT GOHIGHLEVEL'S SEARCH HAS NOT
   * CAUGHT UP ON. A ref rather than state: it is read inside `load`, and as
   * state it would make `load` a new function on every change and re-fire the
   * effect that calls it.
   */
  const pending = useRef<{
    partners: RawPartner[];
    events: RawEvent[];
    attendees: RawAttendee[];
  }>({ partners: [], events: [], attendees: [] });
  /** "Saved: {name}" — shown until the next save or a reload replaces it. */
  const [savedNote, setSavedNote] = useState("");
  // ⚠️ NOT `true` WHEN SEEDED. A remount with a payload in hand is not loading,
  // and saying it is puts the toolbar's Refresh into a spin nothing will end.
  const [loading, setLoading] = useState(!cache);
  const [err, setErr] = useState<unknown>(null);

  const [division, setDivision] = useState<Division>(ALL_DIVISIONS);
  const [divOpen, setDivOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("sources");
  /**
   * 🔴 THE TOUCH QUEUE IS A WORKLIST, NOT A REPORT.
   *
   * Ranking every partner on the account and handing the result to everyone
   * makes "Overdue: 47" a number about work the viewer cannot do. Default to
   * theirs; admins get everything, because the whole board is their job.
   *
   * ⚠️ null means "follow the viewer" — once they choose, the choice sticks for
   * the session rather than being overwritten on the next payload.
   */
  const [queueScope, setQueueScope] = useState<"mine" | "all" | null>(null);

  const [tier, setTier] = useState<string>("all");
  const [cat, setCat] = useState<string>("all");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState("");
  /**
   * 🔴 ANALYSIS 104 · 6 — "lastTouch", NOT "priority". The header reading
   * *Last touch* sorted by `priority` — days overdue WEIGHTED BY TIER — so an
   * A-tier partner touched 8 days ago outranked a C-tier touched 60, under a
   * column that named neither tier nor weighting.
   *
   * ⚠️ AND THE DEFAULT HAD TO MOVE WITH IT. Leaving it on `priority` would
   * have left the table arriving in an order no column claims and no caret
   * marks — the same fault one layer down. The Touch queue is the
   * priority-ordered view and says so; this table is the register.
   */
  const [sortKey, setSortKey] = useState<keyof EnrichedPartner>("lastTouch");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const [openId, setOpenId] = useState<string | null>(null);
  /** Analysis 104 · 5 — bumped after a logged touch so the open drawer re-reads. */
  const [notesToken, setNotesToken] = useState(0);
  /**
   * 🔴 ROUND 128 — THE DIVISIONS COME FROM THE FIELD.
   *
   * The switcher was `DIVISIONS`, a four-value list in code. On an ODP-only
   * deployment it offered Private Pay and OLTL, which cannot exist there: pick
   * one and the screen empties with nothing to explain it. The screen was right
   * and the list was lying to it.
   *
   * ⚠️ `divisionOptions` HAS BEEN IN THE PAYLOAD SINCE ROUND 103 — read live
   * from `Partner Division` — and both dialogs already used it. The switcher
   * was the one consumer still reading the hardcoded copy.
   *
   * ⚠️ "All" IS APPENDED, NOT EXPECTED IN THE DATA. It is the switcher's own
   * value and it is not an option on the field; a record marked "All" means
   * something different (it appears under every division) and that is the
   * field's business, not the menu's.
   */
  const partnerDivisions = useMemo(
    () => (data?.divisionOptions.length ? data.divisionOptions : [...DIVISIONS]),
    [data],
  );
  /**
   * 🔴 TASK 2 · SECTION 3 — THE SWITCHER READS THE RECORDS, NOT THE FIELD.
   *
   * This was `Partner Division`'s own option set. That is the right source for
   * a CREATE FORM — which must offer every value the field can legitimately
   * store, including one no record uses yet — and the wrong source for a
   * FILTER, which should never offer something that matches nothing.
   *
   * ⚠️ IT MIRRORS THE CLIENTS BOARD, app/page.tsx:2424-2432, which builds its
   * scope options from the records the viewer can see and nothing else. The
   * shape is deliberately the same; the FIELD is not, and that is the point:
   * Clients derives a division from the case's pipeline name, this screen
   * reads one stored on the contact. Copying `divisionLabel(pipelineName)`
   * here would build the option list in one vocabulary and filter in another —
   * "OLTL Caregiver Applicants" reduces to "OLTL Caregiver", which is not a
   * Partner Division value at all.
   *
   * 🔴 AND IT NARROWS BECAUSE THE DATA NARROWS. There is no grants logic here
   * and there must not be: section 4 filters the partners server-side, so this
   * list becomes viewer-correct as a consequence. That is exactly how the
   * Clients switcher stays honest.
   *
   * ⚠️ "All" IS EXCLUDED FROM THE OPTIONS AND STILL HONOURED IN THE DATA. A
   * partner marked "All" appears under every division (inDivision) — that is
   * the record saying something, not a menu entry.
   */
  /**
   * The viewer's OWN referral divisions. `null` means all — an admin, or an
   * explicit Agency grant. `[]` means none.
   *
   * ⚠️ NOT THE SAME QUESTION AS `divisionChoices`. This is what they are
   * ENTITLED to; that is what they can switch between, which also includes a
   * division only the data knows about. Round 167 keeps them separate because
   * conflating them is what made the heading read somebody else's division.
   */
  const myDivs = data?.meta.viewerReferralDivisions ?? null;
  const divisionChoices = useMemo(
    // 🔴 ROUND 167 — THE DERIVATION MOVED TO lib/referrals.ts SO IT CAN BE
    // PROVEN. It was inline here and a revert of it came back green, because
    // the proof was asserting the server field it reads rather than this. See
    // the banner on headingDivisions.
    () => headingDivisions(myDivs, data?.partners || [], data?.events || []),
    [myDivs, data],
  );
  /**
   * 🔴 THE `anyShared` HALF — app/page.tsx:2426, same idea. A partner you OWN
   * whose division you do not hold; the parallel to applyAccess admitting an
   * owned record from any pipeline. Before section 4 filtered anything this
   * was always false, which is why it arrives with that section rather than
   * with the switcher.
   */
  const anyShared = useMemo(
    () => (data?.partners || []).some((p) => p.shared),
    [data],
  );
  /**
   * 🔴 BELOW TWO DIVISIONS THERE IS NOTHING TO SWITCH, SO THERE IS NO SWITCH —
   * app/page.tsx:5823-5824, copied including the `anyShared` half.
   *
   * ⚠️ AND IT ANSWERS "ALL MUST NOT LIE" BY REMOVING THE THING THAT WOULD LIE.
   * A viewer who can see exactly one division read "All divisions" over a
   * screen showing one — true in the sense that nothing was filtered, and
   * false in every sense the reader cares about. With no control there is no
   * label to be wrong, and the heading names what is actually there.
   */
  const canSwitchDivision = divisionChoices.length > 1 || anyShared;
  /**
   * The heading when there is nothing to switch. Never "All divisions".
   *
   * ⚠️ ROUND 167 — `divisionChoices` NOW INCLUDES THE VIEWER'S OWN DIVISIONS,
   * so an ODP-only viewer reads "ODP" even on a day when no ODP partner and no
   * ODP event exists. Before this round the same viewer read "OLTL", off one
   * unscoped OLTL event, and "Referral partners" the moment it was deleted.
   */
  const staticDivLabel =
    divisionChoices.length === 1 ? divisionChoices[0] : "Referral partners";
  /**
   * 🔴 TASK 2 · §2 — THE SUFFIX EVERY SCOPED NUMBER CARRIES.
   *
   * A tile reading £40k for a rep and £180k for an admin under one label is the
   * "0 of 2 meant a filter, not an absence" fault in a new place: both numbers
   * are right and the label is what makes one of them a lie.
   *
   * ⚠️ EMPTY UNDER "All divisions", deliberately. A caveat on every number in
   * every state is wallpaper, and wallpaper is not read — the same reasoning
   * that moved round 130's note rather than duplicating it.
   */
  /**
   * ═══ ROUND 167 · B7 — AND "All" NOW CARRIES A LABEL TOO, FOR A PARTIAL
   * VIEWER ═══
   *
   * 🔴 THE "EMPTY UNDER All divisions" RULE ABOVE WAS RIGHT FOR THE READER IT
   * IMAGINED — an admin, for whom "All" really is the account. For a viewer
   * holding two of five divisions, "All" was the account's NAME over their
   * TWO divisions' numbers, with nothing beside it. That is the one shape this
   * suffix exists to prevent, reached through the one case it exempted.
   *
   * ⚠️ STILL EMPTY FOR AN ADMIN OR AN AGENCY GRANT (`myDivs === null`), which
   * keeps the anti-wallpaper reasoning where it applies: there the label would
   * repeat "everything" on every number on the screen.
   */
  const scopeSuffix =
    division === ALL_DIVISIONS
      ? myDivs && myDivs.length
        ? ` · ${myDivs.join(" + ")}`
        : ""
      : division === SHARED_SCOPE
        ? " · shared"
        : ` · ${division}`;
  /**
   * True when a number on screen counts less than the account.
   *
   * ⚠️ ROUND 167 — "All" IS NOW SCOPED TOO WHEN THE VIEWER IS. A partial
   * viewer under the combined option is reading less than the account, which is
   * exactly what this flag means, and it was answering `false` for them.
   */
  const isScoped = division !== ALL_DIVISIONS || !!(myDivs && myDivs.length);
  /**
   * The scope's name INSIDE A SENTENCE — "ODP cases only", "ODP + OLTL cases
   * only".
   *
   * 🔴 ONE DERIVATION, THREE READERS, AND THAT IS THE POINT. Widening
   * `isScoped` above made two existing sentences interpolate `${division}`
   * while the control reads "All", so both would have said "All cases only" to
   * a partial viewer — a sentence that is wrong in the opposite direction from
   * the bug it was fixing. Patching the two templates separately is how they
   * come to disagree; naming the scope once is how they cannot.
   */
  const scopeWords =
    division === ALL_DIVISIONS ? (myDivs || []).join(" + ") : division;
  /**
   * 🔴 ROUND 130 — THE FALLBACK IS FIRING, AND SILENTLY IS THE PROBLEM.
   *
   * `divisionOptions` is `Partner Division`'s options, matched BY NAME. If the
   * field is named anything else on this account — or is not a picklist — the
   * list arrives empty, the hardcoded four are shown, and the screen looks
   * exactly as it did before round 128. That is the same shape as `firstStage`
   * in round 126: a fallback that reproduces the bug hides its own failure.
   *
   * ⚠️ SO IT SAYS SO. Whichever cause it is — a renamed field, a plain-text
   * field, or a field that genuinely holds all four values — the person looking
   * at the switcher can tell which list they are being offered.
   */
  /**
   * 🔴 ROUND 130'S WARNING NOW BELONGS TO THE CREATE DIALOGS, NOT THE SWITCHER.
   *
   * It said "these are the app's built-in divisions, no Partner Division
   * options could be read" and rendered inside the switcher menu — correct when
   * the switcher read that field. Task 2 · §3 moved the switcher onto the
   * records, so leaving the note there would describe the SOURCE OF A DIFFERENT
   * CONTROL: round 130's own complaint ("nothing said which you were looking
   * at"), re-created by the fix that was supposed to help.
   *
   * ⚠️ DELETING IT WAS THE OTHER OPTION AND IT IS WORSE. The fallback still
   * happens — `partnerDivisions` above still drops to the hardcoded four — and
   * round 130 exists because that fallback is silent. Moving it is the only
   * choice that keeps both true.
   */
  const divisionsAreLive = !!data && data.divisionOptions.length > 0;
  /**
   * 🔴 THE EVENT DIALOG GETS `Event Division`'s OWN OPTIONS. It was handed
   * `Partner Division`'s — a CONTACT field's picklist offered for an
   * OPPORTUNITY field's value. They hold similar values today; the moment they
   * diverge the dialog offers something the event field cannot store, and
   * GoHighLevel drops it with a 200.
   *
   * ⚠️ FALLS BACK TO THE PARTNER LIST when `Event Division` is not a picklist
   * at all, because that is better than an empty dropdown — and the dialog says
   * which it is showing rather than leaving it ambiguous.
   */
  const eventDivisions = useMemo(
    () =>
      data?.eventDivisionOptions?.length
        ? data.eventDivisionOptions
        : partnerDivisions,
    [data, partnerDivisions],
  );
  const eventDivisionsAreItsOwn = !!data?.eventDivisionOptions?.length;
  /**
   * ═══ ROUND 167 · C10 — A DIALOG OFFERS ONLY WHAT THE VIEWER COULD THEN SEE ══
   *
   * 🔴 ROUND 140'S RULE, ONE FIELD ALONG. That round stopped "Log a referral"
   * offering a pipeline the viewer holds no grant on, because the case vanished
   * from its creator's board the moment it was filed. A partner or an event
   * stamped with a division outside the creator's referral access does exactly
   * the same thing — written, successful, and gone from the only screen that
   * would show it.
   *
   * ⚠️ THE INTERSECTION IS HERE AND THE REFUSAL IS ON THE SERVER, and both are
   * needed. Narrowing only the dropdown would stop it NAMING OLTL while the
   * route still accepted an OLTL division — "the same fault with a cosmetic
   * patch over it", as the client-pipeline filter already says of itself.
   *
   * ⚠️ `null` MEANS ALL — an admin or an Agency grant — and gets the whole list
   * untouched. An EMPTY array means none, and correctly yields an empty picker:
   * the dialogs then refuse to save and say why, rather than offering a value
   * that would be refused.
   */
  const mineOf = useCallback(
    (list: string[]) => (myDivs ? list.filter((d) => myDivs.includes(d)) : list),
    [myDivs],
  );
  const partnerDivisionsMine = useMemo(
    () => mineOf(partnerDivisions),
    [mineOf, partnerDivisions],
  );
  const eventDivisionsMine = useMemo(
    () => mineOf(eventDivisions),
    [mineOf, eventDivisions],
  );
  /**
   * ⚠️ A CHOICE THAT IS NO LONGER OFFERED IS CLAMPED BACK TO ALL. The list is
   * live now, so it can change under a session — an admin removing a division,
   * or a payload arriving from a different account. Leaving `division` pointing
   * at a value nobody lists is the empty-screen-with-no-explanation this round
   * is about, arrived at from the other direction.
   */
  useEffect(() => {
    // ⚠️ SHARED_SCOPE IS NOT A DIVISION, so it is not clamped against the
    // division list — it is clamped against whether anything IS shared, which
    // is the same rule for a different menu entry.
    if (division === SHARED_SCOPE) {
      if (!anyShared) setDivision(ALL_DIVISIONS);
      return;
    }
    if (division !== ALL_DIVISIONS && !divisionChoices.includes(division))
      setDivision(ALL_DIVISIONS);
  }, [divisionChoices, division, anyShared]);

  /** Round 124 · item 4 — the event awaiting a confirmed delete. */
  const [delEvent, setDelEvent] = useState<RawEvent | null>(null);
  /** Round 124 — the attendee awaiting removal FROM AN EVENT (never a contact delete). */
  const [delAttendee, setDelAttendee] = useState<RawAttendee | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState<unknown>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [logFor, setLogFor] = useState<EnrichedPartner | null>(null);
  /** Either a partner, an event, or both — see LogReferralDialog. */
  const [refFor, setRefFor] = useState<
    { partner?: Pick<RawPartner, "id" | "org" | "division">; event?: RawEvent } | null
  >(null);
  const [metFor, setMetFor] = useState<RawEvent | null>(null);
  const [eventForPartner, setEventForPartner] = useState<EnrichedPartner | null>(null);
  /**
   * 🔴 THE OUTCOME DROPDOWN'S FAILURE STATE, PER ATTENDEE.
   *
   * A `<select>` that writes on change shows the new value the instant you pick
   * it, whether or not the write landed. So each row carries its own busy flag
   * and its own error, and on failure the value is PUT BACK — never left on
   * screen claiming something GoHighLevel does not have.
   */
  const [outBusy, setOutBusy] = useState<Record<string, boolean>>({});
  const [outErr, setOutErr] = useState<Record<string, string>>({});
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreNote, setMoreNote] = useState("");

  const divRef = useRef<HTMLDivElement | null>(null);
  /** Which load() is the current one — see the sequence guard inside it. */
  const loadSeq = useRef(0);

  // ── loading ──────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    // 🔴 SEQUENCED. `reloadToken` bumps after every write, and the blob can
    // change under a load in flight — so two are routinely running at once and
    // whichever FINISHES last used to win. That is how an error from an early
    // attempt lands beside a list the later one loaded successfully.
    const seq = ++loadSeq.current;
    const isCurrent = () => seq === loadSeq.current;

    setLoading(true);
    onBusy(true);
    setErr(null);
    try {
      // touch=auto measures the first batch of partners in the SAME request.
      // A second round trip for it would have shown a complete-looking queue
      // with every partner "never contacted" for as long as it took to arrive.
      const j = await apiFetch<Payload>("/api/referrals?touch=auto", { ssoBlob });
      if (!isCurrent()) return;
      // A success says so explicitly. Clearing on entry is not enough when an
      // older attempt can still reject after this one resolved.
      setErr(null);
      // 🔴 ROUND 175 · ITEM 3 — RE-MERGE WHAT WAS JUST SAVED. GoHighLevel's
      // search lags a new contact by up to a minute (round 173), so this
      // payload legitimately does not contain the partner, event or attendee
      // saved ten seconds ago. Without the merge the reload would wipe it off
      // the screen again, which reads as the save being undone.
      const mp = withPending(j.partners, pending.current.partners);
      const me = withPending(j.events, pending.current.events);
      const ma = withPending(j.attendees, pending.current.attendees);
      pending.current = {
        partners: mp.stillPending,
        events: me.stillPending,
        attendees: ma.stillPending,
      };
      setData({ ...j, partners: mp.rows, events: me.rows, attendees: ma.rows });
    } catch (e) {
      if (!isCurrent()) return;
      // ⚠️ `data` is untouched, so a failed reload keeps the section on screen.
      // The render already draws `err` inline when there is data and only
      // full-screen when there is none — see the two sites below.
      setErr(e);
    } finally {
      if (isCurrent()) {
        setLoading(false);
        onBusy(false);
      }
    }
  }, [ssoBlob, onBusy]);

  // Mounted only while the Referrals section is open, so this is also what
  // keeps the section from costing anything for someone who never opens it.
  //
  // ⚠️ AND IT WAITS. Firing before the handshake settles sent a null blob, got
  // a 401, drew the full-page error card, then reloaded when the blob arrived —
  // an error state on every single entry, plus a wasted round trip.
  //
  // 🔴 ANALYSIS 104 · 13 — AND IT DOES NOT RE-READ WHAT WE ARRIVED HOLDING.
  //
  // ⚠️ A KEY, NOT A ONE-SHOT SKIP FLAG, AND THE FIRST VERSION WAS THE FLAG.
  // A `seeded` ref that clears itself on first use is consumed by StrictMode's
  // discarded first effect pass in dev, so the real pass loaded anyway — the
  // proof caught it (`before=2 after=3`). Recording WHAT WE HAVE ALREADY
  // LOADED FOR is idempotent: run the effect any number of times and it fetches
  // once.
  //
  // ⚠️ THE BLOB IS IN THE KEY DELIBERATELY. A re-issued session must still
  // re-read — that is report 111's stale-401 fix, and a cache is not a reason
  // to keep answering from an expired one. `reloadToken` is there for the
  // toolbar's Refresh, which must always be a real read.
  const loadedKey = useRef(cache ? `${reloadToken}|${ssoBlob ?? ""}` : null);
  useEffect(() => {
    if (!ssoReady) return;
    const key = `${reloadToken}|${ssoBlob ?? ""}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    void load();
  }, [reloadToken, load, ssoReady, ssoBlob]);

  // 🔴 ANALYSIS 104 · 13 — THE MIRROR. One effect on `data` rather than a call
  // beside each of the setData sites: the optimistic ones are exactly the
  // writes somebody would forget to add, and a cache that is right for loads
  // and wrong for edits is worse than none.
  useEffect(() => {
    if (data) onCache(data);
  }, [data, onCache]);

  // Close the division listbox on Escape or a click outside it.
  useEffect(() => {
    if (!divOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDivOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (divRef.current && !divRef.current.contains(e.target as Node))
        setDivOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [divOpen]);


  /**
   * Set one attendee's outcome. One PATCH, and it reverts itself if it fails.
   *
   * ⚠️ NO NEW WRITE PATH. /api/contacts/[id]/fields already exists, already
   * re-derives the session server-side, and already carries `versionGuard` — so
   * two people triaging the same event get a 409 instead of one silently
   * overwriting the other. `updateContactCustomFields` sends ONLY the changed
   * field (a partial customFields array UPDATES rather than replaces — verified
   * live), so there is no read-modify-write that could blank a neighbouring
   * field.
   *
   * Cost: 2 calls per change (the version read, then the write). Thirty
   * attendees triaged is 60 requests against a budget of 100 per 10 seconds,
   * spread over however many minutes a person takes — the rate limit is not the
   * risk here. The silent failure was.
   */
  /**
   * 🔴 ROUND 124 · ITEM 4 — DELETE AN EVENT.
   *
   * ⚠️ AN EVENT IS AN OPPORTUNITY, so this is the same route item 3 added and
   * the same admin gate enforces it. No second delete path, and therefore no
   * second place for the permission check to be missing from.
   *
   * ⚠️ THE ATTENDEES ARE NOT TOUCHED, AND THAT IS A DECISION, NOT AN OMISSION.
   * They are contacts; their `Event Attended` now points at a record that no
   * longer exists. Clearing it would mean a write to every one of them, which
   * can half-fail and leaves no way to tell which half — and it would ERASE the
   * only remaining evidence that those people were met at an event at all. A
   * dangling pointer is recoverable information; a blanked field is not. So
   * they are left, and COUNTED, in the caveat box — exactly what already
   * happens to a referral whose partner was deleted.
   */
  const deleteEvent = useCallback(async () => {
    const ev = delEvent;
    if (!ev) return;
    setDelBusy(true);
    setDelErr(null);
    try {
      await apiFetch(`/api/opportunities/${encodeURIComponent(ev.id)}`, {
        method: "DELETE",
        ssoBlob,
        body: JSON.stringify({ ssoKey: ssoBlob ?? undefined }),
      });
      setData((d) => (d ? { ...d, events: d.events.filter((e) => e.id !== ev.id) } : d));
      setDelEvent(null);
    } catch (e) {
      setDelErr(e);
    } finally {
      setDelBusy(false);
    }
  }, [delEvent, ssoBlob]);

  /**
   * 🔴 ROUND 124 — TAKE SOMEBODY OFF AN EVENT, WITHOUT DELETING THEM.
   *
   * A duplicate or a wrong name stayed on the event's numbers for ever —
   * counted in "met" and dragging cost-per-legit-lead with it — because a row
   * could be triaged and never removed.
   *
   * ⚠️ THIS CLEARS ONE FIELD. `Event Attended` goes empty and they stop
   * counting here; the contact keeps its name, its outcome, its notes and its
   * history. It is the same PATCH the outcome dropdown already uses, so there
   * is no new write path and the version guard still applies.
   */
  const removeAttendee = useCallback(async () => {
    const a = delAttendee;
    const field = data?.meta.attendeeEventField;
    if (!a || !field) return;
    setDelBusy(true);
    setDelErr(null);
    try {
      // 🔴 ROUND 124 — `/api/referrals`, NOT `/api/contacts/{id}/fields`.
      // That route's `[id]` is an OPPORTUNITY id and an attendee has no
      // opportunity, so it answered 404 for every attendee write. See the
      // `attendee-field` action.
      await apiFetch("/api/referrals", {
        method: "POST",
        ssoBlob,
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          action: "attendee-field",
          contactId: a.id,
          field: "event",
          value: "",
          ...(a.version ? { expectedVersion: a.version } : {}),
        }),
      });
      // ⚠️ REMOVED FROM THE EVENT, NOT FROM THE PAYLOAD. They are still an
      // attendee contact with no event, which is a state the caveat box already
      // names — dropping the row entirely would hide that they exist.
      setData((d) =>
        d
          ? { ...d, attendees: d.attendees.map((x) => (x.id === a.id ? { ...x, eventId: "" } : x)) }
          : d,
      );
      setDelAttendee(null);
    } catch (e) {
      setDelErr(e);
    } finally {
      setDelBusy(false);
    }
  }, [delAttendee, data, ssoBlob]);

  const setOutcome = useCallback(
    async (a: RawAttendee, value: string) => {
      const field = data?.meta.outcomeField;
      if (!field) return;
      const before = a.outcome;
      setOutBusy((m) => ({ ...m, [a.id]: true }));
      setOutErr((m) => ({ ...m, [a.id]: "" }));
      // Optimistic, because a dropdown that does not move when you move it
      // feels broken — but every path below either keeps it or puts it back.
      setData((d) =>
        d
          ? {
              ...d,
              attendees: d.attendees.map((x) =>
                x.id === a.id ? { ...x, outcome: value } : x,
              ),
            }
          : d,
      );
      try {
        // 🔴 ROUND 124 — THIS WAS 404-ing ON EVERY CHANGE, and the URL is why:
        // `/api/contacts/{id}/fields` takes an OPPORTUNITY id and borrows that
        // record's permission. An attendee is a contact with no opportunity, so
        // the gate could never find one. Round 122 waved this through as "no new
        // write path — that route already exists"; it does, and it was never
        // this route's job. The proof found it by driving the handler.
        const j = await apiFetch<{ version?: string }>("/api/referrals", {
          method: "POST",
          ssoBlob,
          body: JSON.stringify({
            ssoKey: ssoBlob ?? undefined,
            action: "attendee-field",
            contactId: a.id,
            field: "outcome",
            value,
            ...(a.version ? { expectedVersion: a.version } : {}),
          }),
        });
        // Carry the new version forward, or the NEXT change on this row would
        // send a stale one and 409 against itself.
        setData((d) =>
          d
            ? {
                ...d,
                attendees: d.attendees.map((x) =>
                  x.id === a.id ? { ...x, version: j.version || "" } : x,
                ),
              }
            : d,
        );
      } catch (e) {
        // 🔴 REVERT, AND NAME WHICH ONE. An error banner at the top of a list of
        // thirty says something failed and not which person it was.
        setData((d) =>
          d
            ? {
                ...d,
                attendees: d.attendees.map((x) =>
                  x.id === a.id ? { ...x, outcome: before } : x,
                ),
              }
            : d,
        );
        setOutErr((m) => ({
          ...m,
          [a.id]: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        setOutBusy((m) => ({ ...m, [a.id]: false }));
      }
    },
    [data?.meta.outcomeField, ssoBlob],
  );

  /**
   * ═══ TASK 2 · §2 — THE CASE ARRAY, CUT TO THE DIVISION ON SCREEN ═════════
   *
   * The server has already scoped this to the viewer's granted divisions; this
   * is the second cut, by the control they just used. Two layers, exactly like
   * the partners: the server decides what may be seen, the switcher decides
   * what is being looked at.
   *
   * 🔴 WITHOUT THIS THE HEADING WOULD LIE. Its title attribute promises
   * "everything below changes with it", and a partner who sent cases into two
   * divisions would show both divisions' revenue under one division's heading.
   *
   * ⚠️ UNDER "Shared with me" IT IS NOT CUT. Those partners are ones you own
   * OUTSIDE your divisions, so the server has already withheld most of their
   * cases; cutting again by a value that is not a division would zero
   * everything. What survives is what you are entitled to, which is the honest
   * answer — and it is often nothing, which the note under the table says.
   */
  const divisionRefs = useMemo<RawReferral[]>(() => {
    if (!data) return [];
    if (division === ALL_DIVISIONS || division === SHARED_SCOPE) return data.referrals;
    return data.referrals.filter((o) => divisionLabel(o.pipelineName) === division);
  }, [data, division]);

  // ── the division cut. Everything below reads from here ───────────────────
  const all = useMemo<EnrichedPartner[]>(() => {
    if (!data) return [];
    return data.partners
      // ⚠️ SHARED_SCOPE SHORT-CIRCUITS inDivision. "Shared with me" is not a
      // division and inDivision would fall through to `d === viewing`, which
      // no partner's field can ever equal — an option that silently matches
      // nothing, which is what this round removed from the other end.
      .filter((p) =>
        division === SHARED_SCOPE ? p.shared : !p.shared && inDivision(p.division, division),
      )
      // ITEM 2 — the two lists stay two lists right up to the row.
      // 🔴 `divisionRefs`, NOT `data.referrals` — task 2 · §2. The applicant
      // list is deliberately NOT cut: see its note where the tile renders.
      .map((p) => enrichPartner(p, divisionRefs, data.applicantRefs || []));
  }, [data, division, divisionRefs]);

  const kpis = useMemo(() => partnerKpis(all), [all]);

  /** Measure the next batch of partners whose last touch is still unknown. */
  const measureMore = useCallback(async () => {
    if (!data) return;
    setMoreBusy(true);
    setMoreNote("");
    try {
      // 🔴 ROUND 123 · ITEM 20, THE HALF THAT IS A BUG RATHER THAN A LABEL.
      // This read `data.partners` — every division — while the button beside it
      // says `Measure the next ${kpis.unknown}`, which counts the SELECTED
      // division. In ODP with 12 unmeasured there and 200 account-wide, it
      // offered "Measure the next 12", measured 60 partners that could all be
      // PP, and the ODP figure did not move. Press it again and it still says
      // 12. A button that reports progress against a number it is not working
      // on is worse than no button.
      //
      // ⚠️ `all` IS THE DIVISION CUT, and `unknownTouch` is `lastTouch == null`
      // — the same test, not a similar one (lib/referrals.ts:369). Under "All
      // divisions" `all` is every partner, so this is exactly the old
      // behaviour there, which is the correct behaviour there.
      const ids = all.filter((p) => p.unknownTouch).map((p) => p.id);
      const j = await apiFetch<{
        touch: Record<string, number>;
        meta: { touchResolved: number; touchFailed: number; touchCapped: number };
      }>("/api/referrals", {
        // 🔴 ROUND 123 — A POST, AND NOT FOR TIDINESS. This was
        // `?only=touch&touchFor=c1,c2,…`: up to sixty contact ids in one query
        // string, in the access log, the browser history and any Referer. It is
        // the largest id exposure this screen had, and round 122 reported it
        // gone because the check that cleared it could not match this shape.
        method: "POST",
        ssoBlob,
        body: JSON.stringify({ ssoKey: ssoBlob ?? undefined, action: "touch", touchFor: ids }),
      });
      setData((d) =>
        d
          ? {
              ...d,
              partners: d.partners.map((p) =>
                j.touch[p.id] !== undefined ? { ...p, lastTouch: j.touch[p.id] } : p,
              ),
            }
          : d,
      );
      setMoreNote(
        `Measured ${j.meta.touchResolved}.` +
          (j.meta.touchFailed ? ` ${j.meta.touchFailed} could not be read.` : "") +
          (j.meta.touchCapped ? ` ${j.meta.touchCapped} still to go.` : ""),
      );
    } catch (e) {
      setMoreNote(e instanceof Error ? e.message : String(e));
    } finally {
      setMoreBusy(false);
    }
  }, [all, data, ssoBlob]);

  // ⚠️ AN EVENT IS NEVER "SHARED". Shared is a property of a PARTNER you own
  // outside your divisions; events carry no owner on this screen, so under that
  // scope the events list is empty rather than unfiltered. Falling through to
  // inDivision would show EVERY event beside a partner list of one, which reads
  // as the filter having failed.
  const events = useMemo(
    () =>
      !data || division === SHARED_SCOPE
        ? []
        : data.events.filter((e) => inDivision(e.division, division)),
    [data, division],
  );
  /**
   * 🔴 ANALYSIS 104 · 3 — THE DIVISION SWITCH NOW REACHES THE ATTENDEES.
   *
   * `eventKpis(events, data.attendees)` took a division-filtered event list and
   * an ACCOUNT-WIDE attendee list, so viewing ODP showed ODP's events beside a
   * `Legit leads` and `Awaiting review` count drawn from every attendee on the
   * account. Two of the four Events KPIs ignored the control directly above
   * them — the heading's whole promise is that everything below changes with
   * it.
   *
   * ⚠️ AN ATTENDEE HAS NO DIVISION OF ITS OWN. It has an event, and the event
   * has one — so the filter is derived rather than invented: keep the attendees
   * whose `eventId` is in this division's event set.
   *
   * ⚠️ AND THE ONES WITH NO EVENT ARE STATED, NOT QUIETLY DROPPED. `Event
   * Attended` can be blank, and a blank cannot be placed in any division. Under
   * "All" they are counted, as they always were; under a division they cannot
   * be, and the caveat box says how many and why — the same rule the undated
   * referrals follow.
   */
  const divAttendees = useMemo(() => {
    const list = data?.attendees || [];
    if (division === "All") return list;
    const ids = new Set(events.map((e) => e.id));
    return list.filter((a) => a.eventId && ids.has(a.eventId));
  }, [data, events, division]);
  /** Met, but their record does not say at which event. Unplaceable by division. */
  const unplacedAttendees = useMemo(
    () => (data?.attendees || []).filter((a) => !a.eventId).length,
    [data],
  );
  /**
   * 🔴 ROUND 124 · ITEM 4 — MET AT AN EVENT THAT NO LONGER EXISTS.
   *
   * Deleting an event does not touch its attendees, deliberately: clearing
   * `Event Attended` on every one of them is a write that can half-fail, and it
   * would erase the only remaining evidence that those people were met at all.
   * So the pointer is left dangling — and DANGLING IS ONLY ACCEPTABLE IF IT IS
   * COUNTED. This is the same treatment a referral gets when its partner is
   * deleted, and for the same reason.
   *
   * ═══ ROUND 167 — COMPUTED SERVER-SIDE NOW, AND THIS IS WHY ════════════════
   *
   * 🔴 IT USED TO BE COUNTED HERE, against `data.events`, with a note saying
   * "AGAINST data.events, NOT THE DIVISION CUT — an attendee at an OLTL event
   * is not orphaned merely because you are looking at ODP." That was exactly
   * right while the client held EVERY event.
   *
   * ⚠️ ROUND 167 SCOPES EVENTS BY ACCESS, so `data.events` now means "events
   * you may see". The same line would have reported a WITHHELD event's
   * attendees as people "recorded at an event that no longer exists" — a
   * withheld thing read as a deleted one, which is round 145's lesson word for
   * word. Round 145 moved `danglingReferrals` server-side for the identical
   * reason; this is its twin, applied two rounds and one object later.
   *
   * ⚠️ AND THE OLD COPY IS GONE RATHER THAN KEPT AS A FALLBACK. Two answers to
   * one question is how they come to disagree.
   */
  const orphanAttendees = data?.meta.danglingAttendees ?? 0;

  /**
   * ⚠️ ONE ROW PER PERSON — round 122's dedupe, hoisted so the BADGE and the
   * KPIs read it too. The list was deduped and the two counts beside it were
   * not, so a person met at two events made "13 people met" sit over a list of
   * 12. `a.id` is the contact id; two rows were always two views of one record,
   * and `Legit leads` counted that record twice.
   */
  const shownAttendees = useMemo(() => dedupeByContact(divAttendees), [divAttendees]);
  // 🔴 THE DEDUPED LIST, because the tile says "people met" and a person is a
  // person once. Every figure eventKpis returns about attendees is a count of
  // PEOPLE, not of rows.
  const evKpis = useMemo(() => eventKpis(events, shownAttendees), [events, shownAttendees]);

  const rows = useMemo(() => {
    let list = all;
    if (tier !== "all") list = list.filter((p) => p.tier === tier);
    if (cat !== "all") list = list.filter((p) => p.cat === cat);
    if (overdueOnly) list = list.filter((p) => p.isOverdue);
    const q = search.trim().toLowerCase();
    if (q)
      list = list.filter(
        (p) =>
          p.org.toLowerCase().includes(q) ||
          p.cat.toLowerCase().includes(q) ||
          p.owner.toLowerCase().includes(q),
      );
    return [...list].sort((a, b) => {
      // 🔴 ANALYSIS 104 · 6 — UNKNOWN IS NOT A VALUE, AND THE GENERIC
      // COMPARATOR BELOW WOULD MAKE IT ONE. `Number(null ?? 0)` is 0, which
      // reads as "contacted today" and floats every unmeasured partner to the
      // top of an ascending sort — the same `Number(null) === 0` trap that made
      // every request sleep in round 118. Unmeasured sorts LAST in both
      // directions, because "we have not looked" is not a recency.
      //
      // ⚠️ `NEVER` IS Number.MAX_SAFE_INTEGER and is left alone: never
      // contacted genuinely IS the longest ago, and sorting it there is right.
      if (sortKey === "lastTouch") {
        if (a.unknownTouch !== b.unknownTouch) return a.unknownTouch ? 1 : -1;
        if (a.unknownTouch) return 0;
        return ((a.lastTouch as number) - (b.lastTouch as number)) * sortDir;
      }
      const x = a[sortKey];
      const y = b[sortKey];
      if (typeof x === "string" && typeof y === "string")
        return x.localeCompare(y) * sortDir;
      return (Number(x ?? 0) - Number(y ?? 0)) * sortDir;
    });
  }, [all, tier, cat, overdueOnly, search, sortKey, sortDir]);

  const scope: "mine" | "all" = queueScope ?? (data?.viewer.isAdmin ? "all" : "mine");
  /**
   * ⚠️ "Mine" INCLUDES PARTNERS NOBODY OWNS, and that mirrors the opportunity
   * rule deliberately: applyAccess shows an UNASSIGNED case in a pipeline you
   * hold, because unclaimed work is everyone's. A queue that hid unowned
   * partners would quietly bury exactly the relationships nobody has picked up.
   */
  const isMine = useCallback(
    (p: EnrichedPartner) => !p.ownerId || p.ownerId === (data?.viewer.userId || ""),
    [data?.viewer.userId],
  );
  const queue = useMemo(() => {
    const base = scope === "mine" ? all.filter(isMine) : all;
    return [...base].sort((a, b) => b.priority - a.priority);
  }, [all, scope, isMine]);
  const overdue = queue.filter((p) => p.isOverdue);
  const dueSoon = queue.filter(
    (p) => !p.unknownTouch && !p.isOverdue && (p.overdueBy as number) >= -DUE_SOON_DAYS,
  );
  const later = queue.filter(
    (p) => !p.unknownTouch && !p.isOverdue && (p.overdueBy as number) < -DUE_SOON_DAYS,
  );

  /**
   * 🔴 WHICH FILTER IS HIDING THEM — BY NAME.
   *
   * "Showing 0 of 2 · Clear a filter, or widen the division above" is a guess
   * dressed as an explanation. It reads like a filter the user set even when
   * none is, so a rep seeing it concludes they have no partners — the exact
   * silent-and-plausible failure this project keeps hunting.
   *
   * ⚠️ AND IF NOTHING IS ACTIVE, THAT IS A FAULT, NOT A FILTER. `rows` derives
   * from `all` through these four tests and nothing else, so
   * `all.length > 0 && rows.length === 0 && no active filter` is impossible by
   * construction — which is precisely why it must be reported loudly rather
   * than rendered as an ordinary empty state.
   */
  const activeFilters = useMemo(
    () =>
      [
        tier !== "all" ? (tier === "Prospect" ? "Prospect only" : `Tier ${tier}`) : "",
        cat !== "all" ? `Category “${cat}”` : "",
        overdueOnly ? "Overdue only" : "",
        search.trim() ? `Search “${search.trim()}”` : "",
      ].filter(Boolean),
    [tier, cat, overdueOnly, search],
  );
  const clearFilters = useCallback(() => {
    setTier("all");
    setCat("all");
    setOverdueOnly(false);
    setSearch("");
  }, []);

  const cats = useMemo(() => {
    const s = new Set<string>();
    all.forEach((p) => p.cat && s.add(p.cat));
    return [...s].sort();
  }, [all]);

  const dangling = useMemo(
    // 🔴 ROUND 145 — FROM THE SERVER, NOT COMPUTED HERE.
    //
    // This was `danglingReferrals(data.referrals, data.partners)`, and round
    // 143 made `data.partners` the FILTERED list — so a partner this viewer
    // may not see became indistinguishable from one that had been deleted, and
    // the caveat below said their revenue was "attributed to nobody".
    //
    // ⚠️ THE CLIENT CANNOT MAKE THAT DISTINCTION and must not try: it only ever
    // receives the partners it may see. The server computes it against the
    // pre-filter list. `danglingReferrals` is still exported and still used —
    // by the route.
    () => data?.meta.danglingReferrals ?? 0,
    [data],
  );

  // 🔴 THE TAB LIST IS DIVISION-AWARE, AND THAT IS THE POINT OF DERIVING IT.
  // ODP is to gain Authorization and Capacity tabs. They are NOT built this
  // round — both need stage-transition timestamps that nothing currently
  // records — but adding them here is a data change rather than a rewrite of
  // the switch below, and `tab` falling back when it is not in the list is what
  // stops a division change leaving you on a tab that no longer exists.
  const tabs = useMemo((): { k: Tab; label: string; n?: number }[] => {
    return [
      { k: "sources", label: "Sources", n: all.length },
      { k: "queue", label: "Touch queue", n: overdue.length + dueSoon.length },
      { k: "events", label: "Events", n: events.length },
      { k: "overview", label: "Overview" },
    ];
  }, [all.length, overdue.length, dueSoon.length, events.length]);

  useEffect(() => {
    if (!tabs.some((t) => t.k === tab)) setTab(tabs[0].k);
  }, [tabs, tab]);

  const open = openId ? all.find((p) => p.id === openId) || null : null;

  const touchLabel = (p: EnrichedPartner) =>
    p.unknownTouch ? "—" : p.lastTouch === NEVER ? "never" : `${p.lastTouch}d`;

  const sortBy = (k: keyof EnrichedPartner) => {
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setSortDir(k === "org" || k === "tier" ? 1 : -1);
    }
  };

  const caret = (k: keyof EnrichedPartner) =>
    sortKey === k ? <span className="rfar">{sortDir === 1 ? "▲" : "▼"}</span> : null;

  // ── what this screen does not know ───────────────────────────────────────
  //
  // 🔴 ROUND 123 · ITEM 20 — TWO SCOPES IN ONE BOX, AND IT IS A CORRECTNESS
  // PROBLEM, NOT A WORDING ONE. The box is headed "what THESE numbers do not
  // include", and every number on this screen is division-scoped. Three of its
  // lines were not: with ODP selected it could say "8 contacts' fields could
  // not be read" when seven of the eight are PP, sending somebody to look for
  // eight missing rows in a view that never had them.
  //
  // ⚠️ AND THE ANSWER IS NOT "FILTER THEM BY DIVISION". I checked what each
  // one would have to read to do that, and in three cases the division IS the
  // missing thing:
  //   dangling      the partner is deleted, so its division went with it
  //   unreadable    division is a custom field, and the field read is what failed
  //   truncated     the page boundary is hit before any division exists
  //   failedPipes   the pipeline was never read at all
  // A division-filtered count of those would be an invented number, which is
  // worse than an account-wide one. So they stay account-wide and SAY SO —
  // under their own heading, once, rather than five hedges in five sentences.
  const caveats: string[] = [];
  /** The same, for facts that cannot be cut by division. Kept apart, not tagged. */
  const wideCaveats: string[] = [];
  if (data) {
    if (kpis.unknown)
      caveats.push(
        `${kpis.unknown} partner${kpis.unknown === 1 ? "'s" : "s'"} last contact has not been measured yet, so ${kpis.unknown === 1 ? "it is" : "they are"} excluded from Overdue, Due this week and the queue.`,
      );
    if (kpis.undatedRefs)
      caveats.push(
        `${kpis.undatedRefs} referral${kpis.undatedRefs === 1 ? " has" : "s have"} no creation date in GoHighLevel, so ${kpis.undatedRefs === 1 ? "it is" : "they are"} counted in lifetime referrals but not in any 90-day figure.`,
      );
    // ⚠️ ANALYSIS 104 · 3 — THE STATED BUCKET. Under "All" these are counted,
    // so there is nothing to say; under a division they cannot be placed and
    // dropping them silently is what the undated-referral line exists to
    // prevent.
    if (division !== "All" && unplacedAttendees)
      caveats.push(
        `${unplacedAttendees} ${unplacedAttendees === 1 ? "person" : "people"} met at an event ${unplacedAttendees === 1 ? "is" : "are"} not counted in ${division}'s event figures, because their record does not say which event they were at.`,
      );
    // ⚠️ ROUND 124 · ITEM 4 — ACCOUNT-WIDE BY NECESSITY, like the dangling
    // referral beside it: the event is gone, so its division went with it.
    if (orphanAttendees)
      wideCaveats.push(
        `${orphanAttendees} ${orphanAttendees === 1 ? "person is" : "people are"} recorded at an event that no longer exists, so ${orphanAttendees === 1 ? "they are" : "they are"} not counted against any event. Their contact record is intact — clear or re-set Event Attended in GoHighLevel to place ${orphanAttendees === 1 ? "them" : "them"} again.`,
      );
    if (dangling)
      wideCaveats.push(
        `${dangling} referral${dangling === 1 ? " points" : "s point"} at a partner that no longer exists, so ${dangling === 1 ? "its" : "their"} revenue is attributed to nobody.`,
      );
    if (data.meta.partnersTruncated)
      wideCaveats.push(
        "GoHighLevel returned more partners than one request can carry — this is the first page only.",
      );
    if (data.meta.unreadable)
      wideCaveats.push(
        `${data.meta.unreadable} contact${data.meta.unreadable === 1 ? "'s" : "s'"} fields could not be read, so ${data.meta.unreadable === 1 ? "it is" : "they are"} missing from this screen entirely.`,
      );
    if (data.meta.failedPipelines.length)
      wideCaveats.push(
        `${data.meta.failedPipelines.map((p) => p.name).join(", ")} could not be read, so any referral in ${data.meta.failedPipelines.length === 1 ? "it is" : "them is"} missing from every count here.`,
      );
  }

  if (!ssoReady && !data)
    return (
      <div className="statewrap">
        <div className="statecard">
          <div className="spinner" />
          <h3>Checking your session…</h3>
        </div>
      </div>
    );

  if (loading && !data)
    return (
      <div className="statewrap">
        <div className="statecard">
          <div className="spinner" />
          <h3>Loading referral partners…</h3>
          <p>
            Measuring when each partner was last contacted. That is one read per
            partner, paced to stay inside GoHighLevel&apos;s rate limit.
          </p>
        </div>
      </div>
    );

  if (err && !data)
    return (
      <div className="statewrap">
        <div className="statecard">
          <h3>
            <span className="errdot">●</span> Couldn&apos;t load referral partners
          </h3>
          <ErrorMessage error={err} className="errmsg" />
          <button type="button" className="ibtn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    );

  return (
    <div className="scroll adminscroll">
      <div className="rfwrap">
        {/* ── the heading IS the division control ──────────────────────────
            🔴 NOT A <select> BESIDE A TITLE. A select says "a setting on this
            screen"; this says "this screen is about ODP, and it could be about
            something else". It is a button that looks like the heading, with a
            listbox under it — so it reads as a heading and behaves as a
            control, which is exactly what was asked for. */}
        <div className="rfhead" ref={divRef}>
          {!canSwitchDivision ? (
            /* 🔴 TASK 2 · §3 — A HEADING, NOT A CONTROL. See canSwitchDivision:
               with one division (or none) there is nothing to choose, and a
               control offering one option looks broken while its "All divisions"
               label describes a filter that is doing nothing. */
            <span className="rfdiv rfdivstatic">
              <span className="rfdivname">{staticDivLabel}</span>
            </span>
          ) : (
          <>
          <button
            type="button"
            className="rfdiv"
            // 🔴 ANALYSIS 104 · 18 — THE ARIA WAS WRONG ON THE BRIEF'S
            // CENTREPIECE.
            //
            // `aria-haspopup="listbox"` with `aria-expanded` describes a
            // COMBOBOX, and a combobox owes its listbox an `aria-controls` and
            // an active option. This has neither, so a screen reader announced
            // a control that expands into something it could not then find.
            //
            // ⚠️ THE HONEST FIX IS THE SMALLER PATTERN. This is a button that
            // opens a menu of choices — `aria-haspopup="true"` plus
            // `aria-controls`, with the popup a `menu` and its items
            // `menuitemradio`, which is exactly what "pick one of three, the
            // current one is marked" means. Claiming combobox and then building
            // a menu is how the attributes ended up on the wrong elements.
            aria-haspopup="true"
            aria-expanded={divOpen}
            aria-controls="rf-division-menu"
            onClick={() => setDivOpen((o) => !o)}
            title="Switch division — everything below changes with it"
          >
            <span className="rfdivname">{divLabel(division, myDivs)}</span>
            <svg className="rfcar" viewBox="0 0 10 6" aria-hidden="true">
              <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
          {divOpen ? (
            <ul
              className="rfdivpop"
              role="menu"
              id="rf-division-menu"
              aria-label="Division"
            >
              {/* ⚠️ "All" IS THE MENU'S OWN ENTRY. It was the last element of
                  the old divisionChoices array; the new one is derived from the
                  records and "All" is not a value any record's field should
                  hold as a filter target, so the menu adds it here. */}
              {[ALL_DIVISIONS, ...divisionChoices].map((d) => (
                // ⚠️ `role` GOES ON THE FOCUSABLE ELEMENT, NOT ITS WRAPPER.
                // `role="option"` sat on the <li> while the <button> inside it
                // was the thing you could reach — so the element a keyboard
                // lands on had no role at all and the element with the role
                // could not be reached. That is item 18 in one line.
                <li key={d}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={d === division}
                    className={d === division ? "on" : ""}
                    onClick={() => {
                      setDivision(d);
                      setDivOpen(false);
                    }}
                  >
                    <span>{divLabel(d, myDivs)}</span>
                    {d === division ? <span className="rftick">✓</span> : null}
                  </button>
                </li>
              ))}
              {/* 🔴 ROUND 130'S NOTE HAS MOVED — see divisionsAreLive. It
                  described `Partner Division`'s option set, which this menu no
                  longer reads; it now sits in the two dialogs that still do. */}
              {/* 🔴 TASK 2 · §4 — A PARTNER YOU OWN, OUTSIDE YOUR DIVISIONS.
                  The parallel to the Clients board's "Shared with me"
                  (app/page.tsx:5838-5840): applyAccess admits an owned record
                  from ANY pipeline, and this admits an owned partner from any
                  division. Offered only when one exists, because an option that
                  can never match is the thing this round removed. */}
              {anyShared ? (
                <li>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={division === SHARED_SCOPE}
                    className={division === SHARED_SCOPE ? "on" : ""}
                    onClick={() => {
                      setDivision(SHARED_SCOPE);
                      setDivOpen(false);
                    }}
                  >
                    <span>{divLabel(SHARED_SCOPE, myDivs)}</span>
                    {division === SHARED_SCOPE ? <span className="rftick">✓</span> : null}
                  </button>
                </li>
              ) : null}
            </ul>
          ) : null}
          </>
          )}
          <p className="rfsub">
            Referral sources, the contact cadence they are owed, and what they
            have sent.{" "}
            {/* 🔴 ROUND 168 — IT SAID "Every division." TO EVERYONE, because it
                branched on the CONTROL's value, which is literally "All" for an
                admin and a one-division rep alike. Bill read "Every division."
                over three divisions he does not hold. Same root as round 167's
                B7 and the same fix: `myDivs` is null only for an admin or an
                Agency grant, which is the one case the sentence is true. */}
            {division === "All"
              ? myDivs && myDivs.length
                ? `${myDivs.join(" + ")}, plus every partner marked "All".`
                : "Every division."
              : `${division}, plus every partner marked "All".`}
          </p>
          {/* 🔴 ROUND 175 · ITEM 3 — THE CONFIRMATION LIVES ON THE LIST, not
              only in a dialog that has already closed. Jack's report was that
              the save looked like it had failed; a banner beside the list is
              what answers that, and it names the thing so there is no doubt
              which save it refers to. */}
          {savedNote ? (
            <p className="rfsaved">
              {savedNote}
              <span className="rfsavedwhy">
                {" "}
                — on the list now. GoHighLevel&rsquo;s search takes about a
                minute to catch up, so it may not appear in search until then.
              </span>
              <button type="button" className="rfsavedx" onClick={() => setSavedNote("")}>
                ×
              </button>
            </p>
          ) : null}
        </div>

        {/* ── tabs ──────────────────────────────────────────────────────── */}
        <div className="rftabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.k}
              role="tab"
              type="button"
              aria-selected={tab === t.k}
              className={tab === t.k ? "rftab on" : "rftab"}
              onClick={() => setTab(t.k)}
            >
              {t.label}
              {t.n === undefined ? null : <span className="n">{t.n}</span>}
            </button>
          ))}
        </div>

        {caveats.length || wideCaveats.length ? (
          <div className="rfcaveat">
            {/* 🔴 ROUND 123 · ITEM 20. Under "All divisions" there is no
                narrower scope for the second heading to contrast with, so the
                two lists are one list and the heading stays as it was. A
                sub-heading reading "across every division, not just All
                divisions" would be noise dressed as precision. */}
            {division === "All" || !caveats.length || !wideCaveats.length ? (
              <>
                <b>
                  {division === "All" || !wideCaveats.length
                    ? "What these numbers do not include"
                    : "What this screen does not include, across every division"}
                </b>
                <ul>
                  {[...caveats, ...wideCaveats].map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <b>What these {division} numbers do not include</b>
                <ul>
                  {caveats.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
                <b className="rfcavsub">
                  And across every division, not just {division}
                </b>
                <ul>
                  {wideCaveats.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </>
            )}
            {kpis.unknown ? (
              <div className="rfcavacts">
                <button
                  type="button"
                  className="ibtn"
                  onClick={() => void measureMore()}
                  disabled={moreBusy}
                >
                  {moreBusy
                    ? "Measuring…"
                    : `Measure the next ${Math.min(kpis.unknown, data?.meta.touchCap ?? 60)}`}
                </button>
                {moreNote ? <span className="rfcavnote">{moreNote}</span> : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {err ? <ErrorMessage error={err} className="errmsg" /> : null}

        {/* ── SOURCES ───────────────────────────────────────────────────── */}
        {tab === "sources" ? (
          <>
            <div className="rfkpis">
              <Kpi
                label="Active sources"
                value={kpis.activeSources}
                desc={`referred in the last 90 days · ${kpis.totalSources} tracked`}
              />
              {/* 🔴 TASK 2 · §2 — THE SCOPE IS IN THE LABEL, not only in the
                  switcher. Under ODP these count ODP cases, and a number that
                  counts less than the account must say so where it is read. */}
              <Kpi
                label={`Referrals, 90 days${scopeSuffix}`}
                value={kpis.refs90}
                desc="from these sources"
              />
              <Kpi
                label={`Clients won${scopeSuffix}`}
                value={kpis.won}
                desc="lifetime"
              />
              <Kpi
                label="Touches overdue"
                value={kpis.overdue}
                desc={
                  kpis.unknown
                    ? `past tier cadence · ${kpis.unknown} not measured`
                    : "past tier cadence"
                }
                warn={kpis.overdue > 0}
              />
            </div>

            <div className="rffilters">
              <button
                type="button"
                className={tier === "all" ? "chip on" : "chip"}
                onClick={() => setTier("all")}
              >
                All tiers
              </button>
              {TIERS.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={tier === t ? "chip on" : "chip"}
                  onClick={() => setTier(t)}
                >
                  {t === "Prospect" ? "Prospect" : `Tier ${t}`}
                </button>
              ))}
              <button
                type="button"
                className={overdueOnly ? "chip on" : "chip"}
                onClick={() => setOverdueOnly((v) => !v)}
              >
                Overdue only
              </button>
              <select value={cat} onChange={(e) => setCat(e.target.value)}>
                <option value="all">All categories</option>
                {cats.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <span className="rfgrow">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search organisation, category or owner"
                />
              </span>
              <button
                type="button"
                className="addclientbtn"
                onClick={() => setAddOpen(true)}
              >
                + Add partner
              </button>
            </div>

            <div className="rfpanel">
              <div className="rftw">
                <table className="rftable">
                  <thead>
                    {/* 🔴 EIGHT COLUMNS, DELIBERATELY — AND NOT THE PROTOTYPE'S
                        SIX. The prototype squashes Category and Owner into a
                        subtitle under the organisation name; §6 of the brief
                        names that as a fault and says why. "Prototype wins" is
                        for resolving silence, not for overriding a screen you
                        have looked at and judged. Owner especially has to be a
                        column: it is the answer to "who gets credit for this
                        partner's business", which is the whole of question (a).
                    */}
                    <tr>
                      <th
                        // 🔴 ANALYSIS 104 · 19 — A <th onClick> IS MOUSE-ONLY.
                        // Tab never lands on it and Enter never reaches it, so
                        // sorting this table was unavailable without a pointer.
                        // ⚠️ `aria-sort` IS THE OTHER HALF: without it a screen
                        // reader can operate the control and cannot hear what it
                        // did.
                        tabIndex={0}
                        role="columnheader"
                        aria-sort={
                          sortKey === "org"
                            ? sortDir === 1
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                        onClick={() => sortBy("org")}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          sortBy("org");
                        }}
                      >Organisation{caret("org")}</th>
                      <th
                        // 🔴 ANALYSIS 104 · 19 — A <th onClick> IS MOUSE-ONLY.
                        // Tab never lands on it and Enter never reaches it, so
                        // sorting this table was unavailable without a pointer.
                        // ⚠️ `aria-sort` IS THE OTHER HALF: without it a screen
                        // reader can operate the control and cannot hear what it
                        // did.
                        tabIndex={0}
                        role="columnheader"
                        aria-sort={
                          sortKey === "cat"
                            ? sortDir === 1
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                        onClick={() => sortBy("cat")}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          sortBy("cat");
                        }}
                      >Category{caret("cat")}</th>
                      <th
                        // 🔴 ANALYSIS 104 · 19 — A <th onClick> IS MOUSE-ONLY.
                        // Tab never lands on it and Enter never reaches it, so
                        // sorting this table was unavailable without a pointer.
                        // ⚠️ `aria-sort` IS THE OTHER HALF: without it a screen
                        // reader can operate the control and cannot hear what it
                        // did.
                        tabIndex={0}
                        role="columnheader"
                        aria-sort={
                          sortKey === "tier"
                            ? sortDir === 1
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                        onClick={() => sortBy("tier")}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          sortBy("tier");
                        }}
                      >Tier{caret("tier")}</th>
                      <th
                        // 🔴 ANALYSIS 104 · 19 — A <th onClick> IS MOUSE-ONLY.
                        // Tab never lands on it and Enter never reaches it, so
                        // sorting this table was unavailable without a pointer.
                        // ⚠️ `aria-sort` IS THE OTHER HALF: without it a screen
                        // reader can operate the control and cannot hear what it
                        // did.
                        tabIndex={0}
                        role="columnheader"
                        aria-sort={
                          sortKey === "owner"
                            ? sortDir === 1
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                        onClick={() => sortBy("owner")}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          sortBy("owner");
                        }}
                      >Owner{caret("owner")}</th>
                      <th className="num"
                        // 🔴 ANALYSIS 104 · 19 — A <th onClick> IS MOUSE-ONLY.
                        // Tab never lands on it and Enter never reaches it, so
                        // sorting this table was unavailable without a pointer.
                        // ⚠️ `aria-sort` IS THE OTHER HALF: without it a screen
                        // reader can operate the control and cannot hear what it
                        // did.
                        tabIndex={0}
                        role="columnheader"
                        aria-sort={
                          sortKey === "lastTouch"
                            ? sortDir === 1
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                        onClick={() => sortBy("lastTouch")}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          sortBy("lastTouch");
                        }}
                      >
                        Last touch{caret("lastTouch")}
                      </th>
                      <th className="num"
                        // 🔴 ANALYSIS 104 · 19 — A <th onClick> IS MOUSE-ONLY.
                        // Tab never lands on it and Enter never reaches it, so
                        // sorting this table was unavailable without a pointer.
                        // ⚠️ `aria-sort` IS THE OTHER HALF: without it a screen
                        // reader can operate the control and cannot hear what it
                        // did.
                        tabIndex={0}
                        role="columnheader"
                        aria-sort={
                          sortKey === "refs90"
                            ? sortDir === 1
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                        onClick={() => sortBy("refs90")}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          sortBy("refs90");
                        }}
                      >
                        Refs 90d{caret("refs90")}
                      </th>
                      <th className="num"
                        // 🔴 ANALYSIS 104 · 19 — A <th onClick> IS MOUSE-ONLY.
                        // Tab never lands on it and Enter never reaches it, so
                        // sorting this table was unavailable without a pointer.
                        // ⚠️ `aria-sort` IS THE OTHER HALF: without it a screen
                        // reader can operate the control and cannot hear what it
                        // did.
                        tabIndex={0}
                        role="columnheader"
                        aria-sort={
                          sortKey === "won"
                            ? sortDir === 1
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                        onClick={() => sortBy("won")}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          sortBy("won");
                        }}
                      >
                        Clients{caret("won")}
                      </th>
                      <th className="num"
                        // 🔴 ANALYSIS 104 · 19 — A <th onClick> IS MOUSE-ONLY.
                        // Tab never lands on it and Enter never reaches it, so
                        // sorting this table was unavailable without a pointer.
                        // ⚠️ `aria-sort` IS THE OTHER HALF: without it a screen
                        // reader can operate the control and cannot hear what it
                        // did.
                        tabIndex={0}
                        role="columnheader"
                        aria-sort={
                          sortKey === "revenue"
                            ? sortDir === 1
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                        onClick={() => sortBy("revenue")}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          sortBy("revenue");
                        }}
                      >
                        Revenue /mo{caret("revenue")}
                      </th>
                      {/* 🔴 ROUND 122 · ITEM 2 — ITS OWN COLUMN, AFTER REVENUE
                          AND NOT INSIDE IT. A nursing school or a jobs board
                          sends people who want WORK; they are referrals in the
                          ordinary sense and they are not clients. Two hires and
                          $5,500/mo do not add, so they never share a cell, a
                          sum or a sort key. */}
                      <th className="num"
                        // 🔴 ANALYSIS 104 · 19 — A <th onClick> IS MOUSE-ONLY.
                        // Tab never lands on it and Enter never reaches it, so
                        // sorting this table was unavailable without a pointer.
                        // ⚠️ `aria-sort` IS THE OTHER HALF: without it a screen
                        // reader can operate the control and cannot hear what it
                        // did.
                        tabIndex={0}
                        role="columnheader"
                        aria-sort={
                          sortKey === "applicants"
                            ? sortDir === 1
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                        onClick={() => sortBy("applicants")}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          sortBy("applicants");
                        }}
                      >
                        Applicants{caret("applicants")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {!rows.length ? (
                      <tr>
                        <td colSpan={9}>
                          <div className="empty">
                            {!all.length ? (
                              <>
                                {/* 🔴 TASK 2 · §4 — THREE EMPTY STATES, NOT TWO.
                                    This tested `data.partners.length` to tell
                                    "the account has none" from "none in this
                                    division". After §4 the client only ever
                                    RECEIVES what it may see, so zero partners
                                    stopped meaning "the account has none" — and
                                    a viewer holding no pipeline read "No
                                    referral partners yet · add one to start
                                    tracking" directly above "2 partners are not
                                    shown". The screen contradicted itself.

                                    🔴 EXACTLY THE DANGLING DEFECT'S TWIN: a
                                    client-side test that lost its meaning the
                                    moment the server began filtering, and one
                                    the client cannot restore on its own. The
                                    withheld COUNT is what distinguishes them,
                                    which is why it is sent. */}
                                <b>
                                  {(data?.meta.partnersWithheld ?? 0) > 0
                                    ? "No referral partners you can see"
                                    : data?.partners.length
                                      ? `No referral partners in ${divLabel(division, myDivs)}`
                                      : "No referral partners yet"}
                                </b>
                                <br />
                                {(data?.meta.partnersWithheld ?? 0) > 0
                                  ? `${data?.meta.partnersWithheld} ${data?.meta.partnersWithheld === 1 ? "partner is" : "partners are"} tracked on this account and none is in scope for you — see the note below the table.`
                                  : data?.partners.length
                                    ? `${data.partners.length} partner${data.partners.length === 1 ? " is" : "s are"} tracked, but none is in this division. Switch the heading above to All divisions.`
                                    : 'A partner is a contact whose Record Type is "Referral Partner". Add one to start tracking it.'}
                              </>
                            ) : activeFilters.length ? (
                              <>
                                <b>
                                  {all.length} partner
                                  {all.length === 1 ? " is" : "s are"} hidden by{" "}
                                  {activeFilters.length === 1 ? "a filter" : "filters"}
                                </b>
                                <br />
                                {activeFilters.join(" · ")}
                                <br />
                                <button
                                  type="button"
                                  className="ibtn"
                                  style={{ marginTop: 9 }}
                                  onClick={clearFilters}
                                >
                                  Clear {activeFilters.length === 1 ? "it" : "them"}
                                </button>
                              </>
                            ) : (
                              // 🔴 IMPOSSIBLE BY CONSTRUCTION — so say so, loudly,
                              // rather than blaming a filter the user did not set.
                              <>
                                <b>
                                  Something is wrong — {all.length} partner
                                  {all.length === 1 ? "" : "s"} loaded and none
                                  rendered
                                </b>
                                <br />
                                No filter is active, so this is a fault rather
                                than a filter. Press Refresh; if it persists,
                                report it — the partners were fetched, so nothing
                                is lost.
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ) : (
                      rows.map((p) => (
                        <tr
                          key={p.id}
                          // ⚠️ SAME FAULT, ON THE ROW. The whole row opens the
                          // drawer on click and nothing could reach it from the
                          // keyboard. `role="button"` is the honest description
                          // — it is not a link and it goes nowhere.
                          tabIndex={0}
                          role="button"
                          aria-label={`Open ${p.org}`}
                          onClick={() => setOpenId(p.id)}
                          onKeyDown={(e) => {
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            setOpenId(p.id);
                          }}
                        >
                          <td>
                            <div className="rforg">{p.org}</div>
                            {/* 🔴 ROUND 167 · B8 — ON EVERY ROW, not only the
                                odd ones. A label that appears sometimes is read
                                as a warning; one that is always there is read
                                as a fact, and "ODP" beside an ODP partner is
                                what makes "Yours · OLTL" beside the next one
                                mean something. */}
                            <DivisionTag division={p.division} shared={p.shared} />
                            {p.email || p.phone ? (
                              <div className="rfsub2">
                                {[p.email, p.phone].filter(Boolean).join(" · ")}
                              </div>
                            ) : null}
                          </td>
                          <td className="rfsub2">{p.cat || "—"}</td>
                          <td>
                            <TierBadge t={p.tier} />
                          </td>
                          <td className={p.owner ? "" : "rfunk"}>
                            {p.owner || "unassigned"}
                          </td>
                          <td className="num">
                            {p.unknownTouch ? (
                              <span
                                className="rfunk"
                                title="Not measured yet — excluded from every count"
                              >
                                —
                              </span>
                            ) : p.isOverdue ? (
                              <span className="rflate">
                                {touchLabel(p)}
                                {p.lastTouch === NEVER
                                  ? ""
                                  : ` · ${p.overdueBy} over`}
                              </span>
                            ) : (
                              <span className="rfok">{touchLabel(p)}</span>
                            )}
                          </td>
                          <td className="num">{p.refs90}</td>
                          <td className="num">{p.won}</td>
                          <td className="num rfmoney">{money(p.revenue)}</td>
                          {/* ⚠️ "—" WHEN NONE, NOT "0". A partner who has never
                              sent an applicant has not sent zero of them; the
                              dash says the column does not apply to them, which
                              is true of most partners. */}
                          <td className="num">
                            {p.applicants ? (
                              <>
                                {p.applicants}
                                {p.hired ? (
                                  <span className="rfsub2"> · {p.hired} hired</span>
                                ) : null}
                              </>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>

                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="rffoot">
              {/* 🔴 THE UNIT WAS WRONG, NOT JUST VAGUE. This said "lifetime won
                  opportunity value". `monetaryValue` is what the rep types as
                  the estimated MONTHLY value, so the column is monthly
                  recurring revenue — the same number described two ways is how
                  a forecast ends up wrong by a factor of twelve. */}
              Revenue is the monthly recurring value of <b>won</b> opportunities
              attributed to a partner — <b>not the agency&apos;s revenue</b>:
              Facebook, website and Google Ads leads have no partner to credit
              and are counted nowhere on this screen. Showing {rows.length} of{" "}
              {all.length} · total{" "}
              {moneyMo(rows.reduce((a, p) => a + p.revenue, 0))}
              {/* 🔴 TASK 2 · §2 — AND THE TOTAL NAMES ITS SCOPE. It is a sum of
                  sums over the division-cut case list, so under ODP it is ODP's
                  figure; the same number without the suffix would read as the
                  account's. */}
              {scopeSuffix}
              {activeFilters.length ? (
                <>
                  {" · filtered by "}
                  {activeFilters.join(" · ")}{" "}
                  <button type="button" className="linkbtn" onClick={clearFilters}>
                    clear
                  </button>
                </>
              ) : null}
            </p>
            {/* ═══ TASK 2 · §4 — THE TWO COUNTS ═══════════════════════════════
                🔴 EMPTY BECAUSE FILTERED AND EMPTY BECAUSE THERE IS NOTHING
                MUST NOT LOOK THE SAME. The case that makes this necessary is a
                recruiter granted only an applicant pipeline: divisionLabel
                turns "OLTL Caregiver Applicants" into "OLTL Caregiver", which
                matches no partner, so they get a blank table and no switcher.
                Without this line that is indistinguishable from an account with
                no partners — the same fault section 1 fixed one screen over. */}
            {/* 🔴 TASK 2 · §2 — ONE LINE FOR THE THREE COLUMNS, not a suffix on
                each. "Referrals · ODP / Won · ODP / Revenue · ODP" is four
                lies' worth of noise for one fact. */}
            {isScoped ? (
              <p className="rffoot">
                <b>Referrals</b>, <b>Won</b> and <b>Revenue</b> count{" "}
                {division === SHARED_SCOPE
                  ? "only the cases you are entitled to see — these partners work in divisions you do not hold, so most of their business is not counted here"
                  : `${scopeWords} cases only`}
                .
              </p>
            ) : null}
            {(data?.meta.partnersWithheld ?? 0) > 0 ? (
              <p className="rffoot rfwithheld">
                {/* 🔴 TASK 2 · §4 — TWO SENTENCES, BECAUSE TWO STATES.
                    "They belong to divisions you do not hold" is accurate to
                    somebody holding SOME pipelines and describes a
                    misconfiguration to somebody holding NONE — and a case
                    manager holds none by design. Third time this shape has come
                    up in this task: the pipeline picker saying "configured", the
                    403 offering advice a viewer with none cannot take, and this.

                    🔴 THE CONDITION IS "HOLDS NO PIPELINE", NEVER "IS A CASE
                    MANAGER". Nothing in this system knows who is a case manager,
                    and reading it off an absent grant would be a role inferred
                    from an absence — the same rule as the `-Sale` name suffix. */}
                {/* ═══ ROUND 167 · B9 — THREE SENTENCES, BECAUSE ROUND 162
                    MADE A FOURTH STATE AND THIS KNEW TWO ═══════════════════
                    🔴 IT BRANCHED ON `viewerDivisions === 0` AND SAID "you hold
                    no pipeline". Round 162 gave that number a SECOND cause: an
                    admin can now set somebody's referral access to an explicit
                    empty division list, and that somebody may hold several
                    pipelines. Told "you hold no pipeline" they would go and
                    check their grants, find them, and conclude the screen is
                    broken — advice that sends the reader to the wrong place is
                    the fault this whole sentence exists to avoid, which it then
                    committed itself.
                    ⚠️ THE SERVER SAYS WHICH IT IS (`referralScopeKind`).
                    Nothing here infers it from the count, and nothing infers a
                    ROLE from either — see the note above. */}
                <b>
                  {data?.meta.partnersWithheld}{" "}
                  {data?.meta.partnersWithheld === 1 ? "partner is" : "partners are"} not shown
                </b>{" "}
                {data?.meta.referralScopeKind === "explicit" ? (
                  <>
                    — your referral access is set to no divisions, so no partner
                    is in scope for you. That is a deliberate setting rather
                    than a missing grant: ask an admin to change it on{" "}
                    <b>Admin → Access</b> if it is wrong.
                  </>
                ) : data?.meta.referralScopeKind === "unmatched" ? (
                  /* 🔴 ROUND 168 — THE FOURTH SENTENCE. A recruiter holding only
                     applicant pipelines holds SOMETHING, so "you hold no
                     pipeline" would send them to check a grant they have. And
                     their pipelines genuinely have no referral partners: the
                     divisions those names imply are not Partner Division
                     values. Both halves are said, because knowing it is not a
                     mistake is the useful part. */
                  <>
                    — the pipelines you hold are applicant pipelines, which have
                    no referral partners of their own. That is not a
                    misconfiguration; referral partners belong to the client
                    programmes. Ask an admin on <b>Admin → Access</b> if you
                    should see one of those too.
                  </>
                ) : data?.meta.referralScopeKind === "none" ||
                  (data?.meta.viewerDivisions ?? 0) === 0 ? (
                  <>
                    — you hold no pipeline, so no partner is in scope for you.
                    Case managers see cases through the people they support
                    rather than through a division.
                  </>
                ) : (
                  <>
                    — they belong to divisions you do not hold. You see the
                    divisions your pipelines are in, plus any partner assigned to
                    you. Ask an admin on <b>Admin → Access</b> if that is wrong.
                  </>
                )}
              </p>
            ) : null}
            {/* ⚠️ THE LABELLED LEAK, AND IT IS ACCOUNT-WIDE, NOT PER VIEWER. A
                partner with no division is shown to everyone — deliberately,
                because hiding it means nobody ever notices it needs one. The
                create dialog now requires a division, so this set cannot grow:
                the number should fall to zero and stay there. */}
            {(data?.meta.partnersNoDivision ?? 0) > 0 ? (
              <p className="rffoot">
                ⚠️ <b>{data?.meta.partnersNoDivision}</b>{" "}
                {data?.meta.partnersNoDivision === 1 ? "partner has" : "partners have"} no
                division set, so {data?.meta.partnersNoDivision === 1 ? "it is" : "they are"}{" "}
                visible to everyone whichever division they work in. Set{" "}
                <b>Partner Division</b> on {data?.meta.partnersNoDivision === 1 ? "it" : "them"}{" "}
                to scope {data?.meta.partnersNoDivision === 1 ? "it" : "them"}.
              </p>
            ) : null}
          </>
        ) : null}

        {/* ── TOUCH QUEUE ───────────────────────────────────────────────── */}
        {tab === "queue" ? (
          <>
            {/* ⚠️ THE SCOPE IS A CONTROL, NOT A SILENT DEFAULT. A worklist that
                quietly shows a subset is the same problem as one that shows
                everything — you cannot tell which you are looking at. */}
            <div className="rfscope">
              <div className="seg">
                <button
                  type="button"
                  className={scope === "mine" ? "on" : ""}
                  onClick={() => setQueueScope("mine")}
                >
                  Mine
                </button>
                <button
                  type="button"
                  className={scope === "all" ? "on" : ""}
                  onClick={() => setQueueScope("all")}
                >
                  All
                </button>
              </div>
              <span className="rfscopenote">
                {scope === "mine"
                  ? `Partners you own, plus any nobody owns — ${queue.length} of ${all.length} in ${divLabel(division, myDivs)}.`
                  : `Every partner in ${divLabel(division, myDivs)} — ${all.length}.`}
              </span>
            </div>

            <div className="rfkpis">
              {/* Each tile names the set it counts. Round 100's tiles did not,
                  and a count whose scope is implied is a count you cannot
                  check. */}
              <Kpi
                label="Overdue"
                value={overdue.length}
                desc={scope === "mine" ? "past cadence · yours" : "past cadence · everyone's"}
                warn={overdue.length > 0}
              />
              <Kpi
                label="Due this week"
                value={dueSoon.length}
                desc={`within ${DUE_SOON_DAYS} days`}
              />
              <Kpi label="Scheduled" value={later.length} desc="further out" />
            </div>

            {!overdue.length && !dueSoon.length ? (
              <div className="rfpanel">
                <div className="empty">
                  <b>
                    {kpis.unknown && !all.some((p) => !p.unknownTouch)
                      ? "Nothing measured yet"
                      : "Queue is clear"}
                  </b>
                  <br />
                  {kpis.unknown && !all.some((p) => !p.unknownTouch)
                    ? "No partner's last contact has been read yet, so there is nothing to rank. Measure them above."
                    : `Nothing is due in the next ${DUE_SOON_DAYS} days. Raise a tier if a relationship deserves more contact.`}
                </div>
              </div>
            ) : (
              <div className="rfpanel">
                {[...overdue, ...dueSoon].map((p) => (
                  <div key={p.id} className={p.isOverdue ? "rfq od" : "rfq soon"}>
                    <div className="rfbar" />
                    <div className="rfqb">
                      <div className="t">{p.org}</div>
                      <div className="m">
                        {p.lastTouch === NEVER ? (
                          <span className="r">never contacted</span>
                        ) : p.isOverdue ? (
                          <span className="r">{p.overdueBy} days overdue</span>
                        ) : (
                          `due in ${Math.abs(p.overdueBy as number)} days`
                        )}
                        {` · ${CADENCE_WORD[p.tier] || "quarterly"} cadence · ${p.owner || "unassigned"}`}
                      </div>
                    </div>
                    <div className="rfacts">
                      <button
                        type="button"
                        className="ibtn"
                        onClick={() => setLogFor(p)}
                      >
                        Log touch
                      </button>
                      <button
                        type="button"
                        className="ighost"
                        onClick={() => setOpenId(p.id)}
                      >
                        Open
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <p className="rffoot">
              Ordered by days overdue weighted by tier, so an A-tier source three
              days late outranks a C-tier source a month late. A partner with no
              note at all ranks first: nobody has ever spoken to them.
            </p>
          </>
        ) : null}

        {/* ── EVENTS ────────────────────────────────────────────────────── */}
        {tab === "events" ? (
          <>
            <div className="rfkpis">
              <Kpi label="Events" value={evKpis.events} desc={money(evKpis.cost) + " spent"} />
              <Kpi label="Scheduled" value={evKpis.scheduled} desc="at the Planned stage" />
              <Kpi
                label="Legit leads"
                value={evKpis.legitLeads}
                desc={`of ${evKpis.attendees} ${evKpis.attendees === 1 ? "person" : "people"} met`}
              />
              <Kpi
                label="Awaiting review"
                value={evKpis.awaitingReview}
                desc="no outcome set"
                warn={evKpis.awaitingReview > 0}
              />
            </div>

            {/* 🔴 THE ATTRIBUTION HOLE, SAID ON SCREEN RATHER THAN DRAWN AS
                ZEROS. "0 met · 0 legit" under every event is a claim that
                nobody came. The truth is that nothing in GoHighLevel says who
                came to which event. */}
            {!data?.meta.attendeeEventField ? (
              <div className="rfgap">
                <b>Per-event attendance cannot be calculated yet</b>
                <p>
                  An attendee carries Record Type, Event Outcome and Attendee
                  Profile — and no field naming the event they attended. So the
                  totals above are right and the per-event breakdown below cannot
                  be: there is nothing to attribute a person to an event with.
                </p>
                <p>
                  Create ONE contact custom field called <b>Event Attended</b> in
                  the &ldquo;Event Attendance&rdquo; folder, holding the event
                  opportunity&apos;s id — the same shape{" "}
                  <b>Referring Partner</b> already uses — and every figure below
                  starts working with no code change.
                </p>
              </div>
            ) : null}

            {/* 🔴 ROUND 124 · ITEM 2 — THREE STATES, AND SILENCE WAS THE FAULT
                WHATEVER THE CAUSE. One sentence covered "no pipeline", "no
                events" and "none in this division", and it named the division
                in all three — so a rename of the Events pipeline read as "no
                events in ODP" and sent somebody looking at the division
                switcher for a problem on the Pipelines screen. Same fault as
                the Recruiting empty state in 121b, and the same fix: never let
                an empty state guess its own cause. */}
            {!data?.meta.eventsPipelineConfigured ? (
              <div className="rfgap">
                <b>No pipeline named Events was found</b>
                <p>
                  Nothing is being read, so this tab is empty for a reason that
                  has nothing to do with your division or your access.{" "}
                  <b>Check its name on the Pipelines screen</b> — this lookup
                  matches the name &ldquo;Events&rdquo; exactly, so
                  &ldquo;Events &amp; Outreach&rdquo; does not match it.
                </p>
                <p>
                  ⚠️ Better: mark the pipeline as <b>the Events pipeline</b>{" "}
                  under Role on the Pipelines screen. That records its id, so a
                  rename cannot break this again — and it works whatever scope
                  the pipeline has.
                </p>
              </div>
            ) : !data?.events.length ? (
              <div className="rfpanel">
                <div className="empty">
                  <b>No events yet</b>
                  <br />
                  <b>{data?.meta.eventsPipelineName || "Events"}</b> was found
                  and holds no records. An event is an opportunity in it — add
                  one from a partner&apos;s panel.
                </div>
              </div>
            ) : !events.length ? (
              <div className="rfpanel">
                <div className="empty">
                  {/* 🔴 ROUND 148 — "Shared with me" IS NOT A DIVISION.
                      Task 2 · §3 made the events list EMPTY under that scope on
                      purpose: an event has no owner on this screen, so none can
                      be shared, and falling through to inDivision would have
                      shown every event beside a partner list of one. But the
                      sentence below still said "none of them in this division"
                      — advice that happened to be right for a reason that was
                      wrong. */}
                  <b>
                    {division === SHARED_SCOPE
                      ? "Events are not shared"
                      : `No events in ${divLabel(division, myDivs)}`}
                  </b>
                  <br />
                  {division === SHARED_SCOPE ? (
                    <>
                      <b>Shared with me</b> lists partners you own outside your
                      divisions. An event belongs to a division rather than to a
                      person, so none appears here — switch the heading above to
                      see them.
                    </>
                  ) : (
                    <>
                      {data.events.length} event
                      {data.events.length === 1 ? " exists" : "s exist"} in{" "}
                      <b>{data?.meta.eventsPipelineName || "Events"}</b>, none of
                      them in this division. Switch the heading above.
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="rfpanel">
                {events.map((e) => {
                  // 🔴 `divisionRefs` — task 2 · §2. Clients and Revenue are the
                  // division's; Met, Legit and the cost are the event's. The
                  // card says so below rather than leaving the reader to
                  // assume one scope for six numbers.
                  const st = eventStats(e, data?.attendees || [], divisionRefs);
                  const good = st.cpl !== null && st.cpl <= 120;
                  // 🔴 LOOK IN THE FULL LIST, NOT THE DIVISION-FILTERED ONE.
                  // `all` is cut to the division on screen, so an OLTL event
                  // hosted by a Private Pay partner resolved to undefined and
                  // the card stated "No organisation linked" — which is a lie,
                  // not an absence. The host EXISTS; this view had filtered it
                  // out of the array being searched.
                  const host = e.host
                    ? data?.partners.find((x) => x.id === e.host)
                    : undefined;
                  const hostVisibleHere = !!host && inDivision(host.division, division);
                  return (
                    <div key={e.id} className="rfev">
                      <div className="hd">
                        <div>
                          <div className="nm">{e.name}</div>
                          {/* ⚠️ "No organisation linked" IS THE BRIEF'S OWN
                              WORDING, and it is also the honest one when the
                              host field does not exist at all: a button naming
                              a partner we cannot know would be an invention. */}
                          {host && hostVisibleHere ? (
                            <div className="rfevhost">
                              Run by{" "}
                              <button
                                type="button"
                                className="rfhostbtn"
                                onClick={() => setOpenId(host.id)}
                              >
                                {host.org}
                              </button>
                            </div>
                          ) : host ? (
                            // ⚠️ SAY WHAT IS TRUE. Round 106's rule again: the
                            // host is real and this view is the reason it is
                            // not shown, so name the reason instead of implying
                            // nothing exists. Not a link — opening it would
                            // jump to a partner the current division excludes.
                            <div className="rfevnohost">
                              Run by a partner in{" "}
                              {host.division ? `the ${host.division} division` : "another division"}
                            </div>
                          ) : e.host ? (
                            // A host id that resolves to no partner at all: the
                            // contact was deleted, or it is past the page cap.
                            <div className="rfevnohost">
                              Run by a partner that is no longer in the list
                            </div>
                          ) : (
                            <div className="rfevnohost">
                              {data?.meta.eventHostField
                                ? "No organisation linked"
                                : "No organisation linked — no Event Host field on this account"}
                            </div>
                          )}
                          <div className="rfevsub">
                            {[e.venue, e.stage].filter(Boolean).join(" · ")}
                          </div>
                          {/* 🔴 ROUND 167 · B8 — AN EVENT GETS THE SAME WORDING
                              AS A PARTNER. It read a bare "no division", which
                              names the gap and not its consequence: a blank or
                              "All" event is shown to EVERY viewer, and that is
                              exactly how one OLTL event put "OLTL" on an
                              ODP-only viewer's heading. */}
                          <DivisionTag division={e.division} what="event" />
                        </div>
                        <div className="dt">
                          {e.date || "no date"} · {money(e.cost)} cost
                          {/* 🔴 ROUND 124 · ITEM 4 — ADMIN ONLY, AND THE APP'S
                              OWN CONFIRM. An event is a thing somebody typed,
                              so a test one or a mistyped cost had nowhere to
                              go. Same route and same server-side admin gate as
                              a client case. */}
                          {data?.viewer.isAdmin ? (
                            <div className="rfevdel">
                              <button
                                type="button"
                                className="pfdangerbtn"
                                onClick={() => {
                                  setDelErr(null);
                                  setDelEvent(e);
                                }}
                                title="Removes this event. The people met stay in GoHighLevel."
                              >
                                Delete event
                              </button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="rfstats">
                        {[
                          ["Met", String(st.met)],
                          ["Legit leads", String(st.legit)],
                          ["Partner prospects", String(st.partners)],
                          [`Clients${scopeSuffix}`, String(st.clients)],
                        ].map(([l, v]) => (
                          <div className="rfstat" key={l}>
                            <div className="l">{l}</div>
                            <div className="v">
                              {data?.meta.attendeeEventField ? v : "—"}
                            </div>
                          </div>
                        ))}
                        <div className="rfstat">
                          <div className="l">Cost per legit lead</div>
                          <div
                            className={
                              st.cpl === null ? "v" : good ? "v good" : "v bad"
                            }
                          >
                            {st.cpl === null ? "—" : money(st.cpl)}
                          </div>
                        </div>
                        <div className="rfstat">
                          <div className="l">Revenue /mo{scopeSuffix}</div>
                          <div className="v">
                            {data?.meta.oppEventField ? moneyMo(st.revenue) : "—"}
                          </div>
                        </div>
                      </div>
                      {/* 🔴 TASK 2 · §2 — THE WHOLE COST AGAINST THE SCOPED
                          RETURN, SAID ON THE CARD. An event's cost belongs to
                          the event, not to a division: splitting it pro-rata
                          would invent an allocation nobody decided, and hiding
                          cross-division events would hide the ones most worth
                          looking at. So the cost stays whole and the card says
                          which of its six numbers are not.

                          ⚠️ Cost per legit lead is cost ÷ ATTENDEES and moves
                          for nobody — attendees carry no division and no
                          `visible` flag. It is named here because a reader
                          seeing "Clients" and "Revenue" shrink would otherwise
                          assume it shrank too. */}
                      {isScoped ? (
                        <div className="rfdhint">
                          {money(e.cost)} is the event&apos;s <b>whole</b> cost, and{" "}
                          <b>Cost per legit lead</b> uses every attendee.{" "}
                          <b>Clients</b> and <b>Revenue</b> count{" "}
                          {division === SHARED_SCOPE ? "only cases you may see" : `${scopeWords} cases`}{" "}
                          only.
                        </div>
                      ) : null}

                      {/* 🔴 PEOPLE MET · SET AN OUTCOME. The dropdown writes
                          immediately — no save button, because a rep triaging
                          thirty people should not press save thirty times. */}
                      <div className="rfmet">
                        <div className="rfmethd">
                          <span className="rfmetlbl">People met · set an outcome</span>
                          <button
                            type="button"
                            className="ighost"
                            onClick={() => setMetFor(e)}
                          >
                            Add person met
                          </button>
                          {/* 🔴 THE ONLY WRITER OF `Event Source`. Without this
                              the field exists and nothing ever sets it, so an
                              event's Clients and Revenue stay at "—" for ever.
                              This is the sentence the field records: you met
                              them at the expo, and they became a client. */}
                          <button
                            type="button"
                            className="ighost"
                            onClick={() => setRefFor({ partner: host, event: e })}
                          >
                            Log a referral from this event
                          </button>
                        </div>
                        {!data?.meta.attendeeEventField ? (
                          <div className="rfdhint">
                            Nobody can be attributed to this event until an{" "}
                            <b>Event Attended</b> field exists on the contact —
                            see above. Anyone added here is still created; they
                            just cannot be counted against this event yet.
                          </div>
                        ) : !st.contacts.length ? (
                          <div className="rfdhint">
                            No one recorded for this event yet.
                          </div>
                        ) : (
                          st.contacts.map((c) => (
                            <div className="rfoc" key={c.id}>
                              <div className="n">
                                <span className="rfocname">{c.name}</span>
                                {c.profile ? (
                                  <div className="pf">{c.profile}</div>
                                ) : null}
                                {outErr[c.id] ? (
                                  // ⚠️ ON THE ROW, NAMING THE PERSON. A banner
                                  // at the top of thirty rows says something
                                  // failed and not which one.
                                  <div className="rfocerr">
                                    Not saved for {c.name} — {outErr[c.id]}
                                  </div>
                                ) : null}
                              </div>
                              <select
                                value={c.outcome}
                                disabled={!!outBusy[c.id]}
                                onChange={(ev) => void setOutcome(c, ev.target.value)}
                              >
                                <option value="">Not set</option>
                                {(data?.outcomeOptions.length
                                  ? data.outcomeOptions
                                  : [...OUTCOMES]
                                ).map((o) => (
                                  <option key={o} value={o}>
                                    {o}
                                  </option>
                                ))}
                              </select>
                              {/* 🔴 ROUND 124 — TAKE A ROW OFF THE EVENT.
                                  Somebody added in error — a duplicate, a wrong
                                  name — stayed on this event's numbers for
                                  ever, counted in "met" and dragging cost per
                                  legit lead with them. There was no way to
                                  remove one.
                                  ⚠️ NOT A CONTACT DELETE, and the title says
                                  so: it clears Event Attended and nothing
                                  else. */}
                              <button
                                type="button"
                                className="rfocx"
                                disabled={!!outBusy[c.id]}
                                onClick={() => {
                                  setDelErr(null);
                                  setDelAttendee(c);
                                }}
                                title="Removes them from this event. The contact stays in GoHighLevel."
                                aria-label={`Remove ${c.name} from this event`}
                              >
                                ×
                              </button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Attendees ARE listable — they just cannot be placed at an event. */}
            {/* 🔴 ANALYSIS 104 · 3 — DIVISION-SCOPED, like the KPIs above it.
                Leaving this panel account-wide while the numbers moved would
                have created the contradiction it was being fixed for: "12
                people met" over a list of 300. */}
            {divAttendees.length ? (
              <>
                <h3 className="rfh3">
                  Everyone met at an event
                  <span className="rfn">{shownAttendees.length}</span>
                </h3>
                <div className="rfpanel">
                  <div className="rftw">
                    <table className="rftable">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Profile</th>
                          <th>Outcome</th>
                        </tr>
                      </thead>
                      <tbody>
                        {/* 🔴 ROUND 122 · ITEM 1 — ONE ROW PER CONTACT.
                            `a.id` IS THE CONTACT ID, and the outcome is a
                            contact field — so two rows for one person were two
                            views of ONE value, each with its own dropdown. The
                            optimistic update already matched on `x.id === a.id`
                            and moved both, which is the shape of the bug: the
                            code knew they were one record and the screen did
                            not.
                            ⚠️ DEDUPE, NOT HIDE. Nothing is lost — a duplicate
                            row carried no information the first did not. And
                            React was being handed the same `key` twice, which
                            is its own quiet fault. */}
                        {shownAttendees.map((a) => (
                          <tr key={a.id}>
                            <td>{a.name}</td>
                            <td className="rfsub2">{a.profile || "—"}</td>
                            <td>
                              {a.outcome ? (
                                <span
                                  className={
                                    a.outcome === "Legit lead"
                                      ? "rfout good"
                                      : "rfout"
                                  }
                                >
                                  {a.outcome}
                                </span>
                              ) : (
                                <span className="rfout pending">Not set</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <p className="rffoot">
                  Outcomes are set on the contact in GoHighLevel. Cost per legit
                  lead divides event cost by legitimate leads only, which is why
                  it needs the event link above to mean anything per event.
                  {data?.meta.attendeesTruncated
                    ? " More attendees exist than one request can carry — this is the first page."
                    : ""}
                </p>
              </>
            ) : null}
          </>
        ) : null}

        {/* ── OVERVIEW ──────────────────────────────────────────────────── */}
        {tab === "overview" ? (
          <>
            <div className="rfkpis">
              <Kpi
                /* ⚠️ NO SCOPE SUFFIX HERE, ON PURPOSE. This counts PARTNERS,
                   which the switcher has already cut; labelling it "· ODP"
                   would imply their CASES were scoped too, which is a
                   different claim and one this tile does not make. */
                label="Sources"
                value={kpis.totalSources}
                desc={`${kpis.activeSources} referred in 90 days`}
              />
              {/* 🔴 "REVENUE" ALONE IS A FALSE HEADLINE — round 112, item 8.
                  Only a REFERRED case can carry a value: a Facebook, website or
                  Google Ads lead has no partner to credit and no route in this
                  app to set one, so its revenue is structurally absent from this
                  number. Labelled "Revenue attributed" beside four other
                  business-wide tiles, it reads as the agency's figure and is
                  wrong by a large multiple. The label now names its own scope,
                  and the description says what is missing rather than only what
                  is counted. */}
              <Kpi
                label={`Revenue from partners${scopeSuffix}`}
                value={moneyMo(kpis.revenue)}
                desc="won, monthly · excludes every non-referred case"
              />
              {/* 🔴 ROUND 122 · ITEM 2 — A SEPARATE TILE, RENDERED ONLY WHEN
                  THERE IS SOMETHING TO SAY. A permanent "0 applicants" beside
                  revenue would imply the two belong to one scoreboard, which is
                  the exact confusion the separate count exists to prevent. */}
              {kpis.applicants ? (
                /* 🔴 TASK 2 · §2 — DELIBERATELY UNSCOPED, AND IT SAYS SO.
                   Every figure beside this one counts the division on screen;
                   this one counts the account. Two reasons, and the second is
                   the one that matters:

                   divisionLabel("OLTL Caregiver Applicants") is "OLTL
                   Caregiver", which is not a `Partner Division` value on any
                   account — so scoping this list would not narrow the column,
                   it would EMPTY it, for every viewer in every division.

                   ⚠️ AND THE COLUMN EXISTS TO SHOW A CROSS-DIVISION FACT.
                   Round 122 item 2 added it so a Private Pay manager can see
                   that their hospital partner also sends caregivers. Scoping it
                   would hide precisely that. An unscoped number beside scoped
                   ones has to say it is deliberate, or it reads as the one that
                   was forgotten. */
                <Kpi
                  label="Applicants from partners"
                  value={`${kpis.applicants}`}
                  desc={`${kpis.hired} hired · people, not revenue — never added to the figure beside this${
                    isScoped ? " · counted account-wide, not by division" : ""
                  }`}
                />
              ) : null}
              <Kpi
                label="Touches overdue"
                value={kpis.overdue}
                desc={kpis.unknown ? `${kpis.unknown} not measured` : "past tier cadence"}
                warn={kpis.overdue > 0}
              />
              <Kpi
                label="Events awaiting review"
                value={evKpis.awaitingReview}
                desc="attendees with no outcome"
                warn={evKpis.awaitingReview > 0}
              />
            </div>

            <div className="rfgrid2">
              <div className="rfbox">
                <h3>Referrals by category</h3>
                <p className="rfcap">
                  All time, across every source in {divLabel(division, myDivs)}.
                </p>
                <Bars
                  rows={byCategory(all)}
                  fmt={(v) => String(v)}
                  emptyText="No referrals attributed yet."
                />
              </div>
              <div className="rfbox">
                <h3>Top sources by revenue</h3>
                <p className="rfcap">Monthly recurring value of won cases.</p>
                <Bars
                  rows={[...all]
                    .sort((a, b) => b.revenue - a.revenue)
                    .slice(0, 8)
                    .map((p) => ({ k: p.org, v: p.revenue }))
                    .filter((r) => r.v > 0)}
                  fmt={moneyMo}
                  emptyText="No won revenue attributed yet."
                />
              </div>
            </div>

            <div className="rfquiet">
              <h3>Gone quiet</h3>
              <p className="rfcap">
                Sources that have produced before and sent nothing in 90 days.
                Usually one phone call away from producing again.
              </p>
              {(() => {
                const quiet = all
                  .filter((p) => p.won > 0 && p.lastRefAgo !== null && p.lastRefAgo >= 90)
                  .sort((a, b) => (b.lastRefAgo as number) - (a.lastRefAgo as number));
                if (!quiet.length)
                  return (
                    <div className="rfqnone">
                      Nothing has lapsed. Every producing source has referred
                      within 90 days.
                    </div>
                  );
                return quiet.map((p) => (
                  <div key={p.id} className="rfqi">
                    <div>
                      <div className="nm">{p.org}</div>
                      <div className="dd">
                        {p.won} client{p.won === 1 ? "" : "s"} won ·{" "}
                        {moneyMo(p.revenue)} · owner{" "}
                        {p.owner || "unassigned"}
                      </div>
                    </div>
                    <div className="rfqr">
                      <div className="d">{p.lastRefAgo}d</div>
                      <div className="dd">since last referral</div>
                    </div>
                  </div>
                ));
              })()}
            </div>
          </>
        ) : null}
      </div>

      {open ? (
        <PartnerDrawer
          p={open}
          ssoBlob={ssoBlob}
          // 🔴 `divisionRefs` — task 2 · §2. The drawer's attributed-case list
          // and its "Events worked" block must agree with the row that opened
          // it; the whole array would make the drawer contradict the table two
          // pixels away.
          referrals={divisionRefs}
          events={data?.events || []}
          attendees={data?.attendees || []}
          hostField={data?.meta.eventHostField || ""}
          onClose={() => setOpenId(null)}
          onLog={() => setLogFor(open)}
          onLogReferral={() => setRefFor({ partner: open })}
          onAddEvent={() => setEventForPartner(open)}
          onChanged={() => void load()}
          onOpenRecord={onOpenRecord}
          canOpenRecord={canOpenRecord}
          notesToken={notesToken}
        />
      ) : null}

      {eventForPartner ? (
        <AddEventDialog
          ssoBlob={ssoBlob}
          partner={eventForPartner}
          divisions={eventDivisionsMine}
          divisionsAreEventsOwn={eventDivisionsAreItsOwn}
          hostFieldPresent={!!data?.meta.eventHostField}
          onClose={() => setEventForPartner(null)}
          onAdded={(saved) => {
            if (saved) {
              pending.current = {
                ...pending.current,
                events: [saved, ...pending.current.events.filter((e) => e.id !== saved.id)],
              };
              setSavedNote(`Saved: ${saved.name}`);
              setData((d) => (d ? { ...d, events: withPending(d.events, [saved]).rows } : d));
            }
            void load();
          }}
        />
      ) : null}

      {refFor ? (
        <LogReferralDialog
          ssoBlob={ssoBlob}
          partner={refFor.partner}
          event={refFor.event}
          pipelines={data?.clientPipelines || []}
          withheld={data?.meta.clientPipelinesWithheld || 0}
          onClose={() => setRefFor(null)}
          onLogged={() => void load()}
        />
      ) : null}

      {metFor ? (
        <AddAttendeeDialog
          ssoBlob={ssoBlob}
          event={metFor}
          outcomes={data?.outcomeOptions.length ? data.outcomeOptions : [...OUTCOMES]}
          linkable={!!data?.meta.attendeeEventField}
          onClose={() => setMetFor(null)}
          onAdded={(saved) => {
            if (saved) {
              pending.current = {
                ...pending.current,
                attendees: [saved, ...pending.current.attendees.filter((a) => a.id !== saved.id)],
              };
              setSavedNote(`Saved: ${saved.name}`);
              setData((d) =>
                d ? { ...d, attendees: withPending(d.attendees, [saved]).rows } : d,
              );
            }
            void load();
          }}
        />
      ) : null}

      {addOpen ? (
        <AddPartnerDialog
          ssoBlob={ssoBlob}
          division={division}
          owners={data?.owners || []}
          categories={data?.categoryOptions.length ? data.categoryOptions : [...PARTNER_CATEGORIES]}
          tiers={data?.tierOptions.length ? data.tierOptions : [...TIERS]}
          divisions={partnerDivisionsMine}
          divisionsAreLive={divisionsAreLive}
          onClose={() => setAddOpen(false)}
          /* 🔴 ROUND 175 · ITEM 3 — HOLD THE ROW, THEN RELOAD. The reload is
             still worth making (it brings the touch counts and anything else
             that changed), and `withPending` is what stops it wiping the row
             the save just produced. */
          onAdded={(saved) => {
            if (saved) {
              pending.current = {
                ...pending.current,
                partners: [saved, ...pending.current.partners.filter((p) => p.id !== saved.id)],
              };
              setSavedNote(`Saved: ${saved.org}`);
              setData((d) =>
                d ? { ...d, partners: withPending(d.partners, [saved]).rows } : d,
              );
            }
            void load();
          }}
        />
      ) : null}

      {/* 🔴 ROUND 124 · ITEM 4 — THE APP'S OWN CONFIRM, NAMING THE EVENT AND
          SAYING WHAT GOES WITH IT. */}
      {delEvent ? (
        <ConfirmDialog
          title="Delete this event?"
          danger
          body={
            <>
              <p style={{ margin: "0 0 10px" }}>
                Removes <b>{delEvent.name}</b>
                {delEvent.date ? ` (${delEvent.date})` : ""} from the events
                list, along with its cost and its venue.
              </p>
              <p style={{ margin: "0 0 10px" }}>
                {/* 🔴 SAY WHAT DOES **NOT** GO. Everybody assumes a delete
                    cascades; this one deliberately does not. */}
                The people met there are contacts and are <b>not</b> deleted.
                Their record still says they attended this event, which will
                then point at nothing — they are counted in the caveat box above
                rather than quietly dropped.
              </p>
              <p className="fnote">
                Any referral credited to this event keeps its partner. This
                cannot be undone.
              </p>
            </>
          }
          confirmLabel="Delete event"
          busy={delBusy}
          error={delErr}
          onConfirm={() => void deleteEvent()}
          onCancel={() => {
            setDelEvent(null);
            setDelErr(null);
          }}
        />
      ) : null}

      {/* 🔴 ROUND 124 — REMOVE SOMEBODY FROM AN EVENT. */}
      {delAttendee ? (
        <ConfirmDialog
          title="Remove them from this event?"
          danger
          body={
            <>
              <p style={{ margin: "0 0 10px" }}>
                <b>{delAttendee.name}</b> stops counting towards this
                event&apos;s numbers — people met, legit leads, and cost per
                legit lead.
              </p>
              <p className="fnote">
                Removes them from this event. The contact stays in GoHighLevel
                with their name, their outcome and their history; only the event
                they are linked to is cleared.
              </p>
            </>
          }
          confirmLabel="Remove from event"
          busy={delBusy}
          error={delErr}
          onConfirm={() => void removeAttendee()}
          onCancel={() => {
            setDelAttendee(null);
            setDelErr(null);
          }}
        />
      ) : null}

      {logFor ? (
        <LogTouchDialog
          ssoBlob={ssoBlob}
          partner={logFor}
          onClose={() => setLogFor(null)}
          onLogged={(days) => {
            // 🔴 ANALYSIS 104 · 5 — AND THE DRAWER'S NOTE LIST RE-READS.
            setNotesToken((t) => t + 1);
            setData((d) =>
              d
                ? {
                    ...d,
                    partners: d.partners.map((p) =>
                      p.id === logFor.id ? { ...p, lastTouch: days } : p,
                    ),
                  }
                : d,
            );
          }}
        />
      ) : null}
    </div>
  );
}

function byCategory(list: EnrichedPartner[]): { k: string; v: number }[] {
  const m = new Map<string, number>();
  list.forEach((p) => m.set(p.cat || "Uncategorised", (m.get(p.cat || "Uncategorised") || 0) + p.refs));
  return [...m.entries()]
    .map(([k, v]) => ({ k, v }))
    .filter((r) => r.v > 0)
    .sort((a, b) => b.v - a.v);
}

function Bars({
  rows,
  fmt,
  emptyText,
}: {
  rows: { k: string; v: number }[];
  fmt: (v: number) => string;
  emptyText: string;
}) {
  if (!rows.length) return <div className="rfqnone">{emptyText}</div>;
  const max = rows[0].v || 1;
  return (
    <div className="rfbars">
      {rows.map((r) => (
        <div className="rfbrow" key={r.k}>
          <div className="lb" title={r.k}>
            {r.k}
          </div>
          <div className="tr">
            <div className="fl" style={{ width: `${Math.round((r.v / max) * 100)}%` }} />
          </div>
          <div className="vl">{fmt(r.v)}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE PARTNER DRAWER
// ---------------------------------------------------------------------------

/**
 * ONE ATTRIBUTED CASE — named, and correctable in place. Round 112, items 2-4.
 *
 * 🔴 ITEM 4 · NAMED. The list read "3 days ago · won · $5,500/mo" four times
 * over. A rep could not tell which client was which, and the two controls below
 * make that intolerable: nobody edits an unnamed row confidently.
 *
 * 🔴 ITEM 2 · THE VALUE IS CORRECTABLE. "Log a referral" writes monetaryValue
 * once and its own modal promises "it can be corrected when the assessment is
 * done" — a promise nothing in the app kept.
 *
 * 🔴 ITEM 3 · STATUS BESIDE IT, AND IT IS THE SAME CONTROL THE RECORD PANEL
 * ALREADY HAS, writing through the same route. A rep finishing a case sets both
 * without leaving the partner, which is the pair that starts producing revenue
 * data at all — the column reads near-zero until cases are marked won.
 *
 * ⚠️ NATIVE, NOT A CUSTOM FIELD. `monetaryValue` and `status` sit beside name
 * and pipelineId, so the record panel's saveField path does NOT apply; this
 * uses PUT /api/opportunities/{id}, which already accepts both and re-reads the
 * record uncached after writing.
 *
 * 🔴 AND THE READ-BACK IS COMPARED, NOT ASSUMED. Round 103: `monetaryValue` was
 * missing from createOpportunity and a spread hid its absence from TypeScript,
 * so the value was silently dropped. A write that "succeeds" while changing
 * nothing is the exact failure this feature would repeat, so what comes back is
 * checked against what was sent and a mismatch is stated on the row.
 */
function AttributedRow({
  opp,
  ssoBlob,
  onSaved,
  onOpenRecord,
  canOpenRecord,
}: {
  opp: RawReferral;
  ssoBlob: string | null;
  onSaved: () => void;
  /** ITEM 3 — open this opportunity's record panel. */
  onOpenRecord?: (id: string) => void;
  /** True when the record is in this tab's loaded payload; see the row. */
  canOpenRecord?: (id: string) => boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(opp.value || ""));
  const [status, setStatus] = useState(opp.status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

  // The row re-renders from fresh payload data after a save; keep the controls
  // in step with it rather than holding a stale draft.
  useEffect(() => {
    setVal(String(opp.value || ""));
    setStatus(opp.status);
  }, [opp.value, opp.status]);

  const dirty = Number(val || 0) !== (opp.value || 0) || status !== opp.status;

  const save = async () => {
    const want = Number(val || 0);
    if (!Number.isFinite(want) || want < 0) {
      setErr("Enter a monthly figure in dollars, or 0.");
      return;
    }
    setBusy(true);
    setErr("");
    setNote("");
    try {
      const j = await apiFetch<{ record?: { monetaryValue?: number; status?: string } }>(
        `/api/opportunities/${encodeURIComponent(opp.id)}`,
        {
          // 🔴 PATCH — round 121, item 2. `/api/opportunities/[id]` exports
          // PATCH and nothing else, so a PUT is answered by Next.js itself with
          // a 405 and an empty body, before any handler runs. This row's value
          // and status edits have been dead since 112.
          method: "PATCH",
          ssoBlob,
          body: JSON.stringify({
            ssoKey: ssoBlob ?? undefined,
            monetaryValue: want,
            status,
          }),
        },
      );
      // 🔴 COMPARE THE READ-BACK. See the round-103 note above.
      const got = j.record;
      const gotVal = typeof got?.monetaryValue === "number" ? got.monetaryValue : null;
      const gotStatus = typeof got?.status === "string" ? got.status : null;
      const bad: string[] = [];
      if (gotVal !== null && gotVal !== want)
        bad.push(`value came back as ${moneyMo(gotVal)}, not ${moneyMo(want)}`);
      if (gotStatus !== null && gotStatus !== status)
        bad.push(`status came back as "${gotStatus}", not "${status}"`);
      if (bad.length) {
        // Revert the controls to what GoHighLevel actually holds — showing the
        // typed value over a record that did not take it is the lie itself.
        setErr(
          `GoHighLevel accepted the request but did not store it: ${bad.join("; ")}. ` +
            `Nothing here is reliable until that is understood — do not retype it.`,
        );
        if (gotVal !== null) setVal(String(gotVal || ""));
        if (gotStatus !== null) setStatus(gotStatus);
        return;
      }
      setNote("Saved.");
      setEditing(false);
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rfopp">
      <div className="rfoppmain">
        {/* 🔴 ROUND 120 · ITEM 3 — OPEN THE RECORD. Deferred in 118 because the
            panel's open path looked like it needed lifting through the section
            switch; it does not. The panel renders ABOVE the view switch
            (app/page.tsx:7039), so setting the id opens it over whatever
            section is showing. Two props, no restructuring.

            ⚠️ A BUTTON ONLY WHEN THE RECORD IS ACTUALLY LOADED. A referral can
            point at an opportunity this viewer's payload does not contain —
            another division, or a pipeline they do not hold — and a click that
            opens nothing is worse than a name that was never clickable. */}
        {onOpenRecord && canOpenRecord?.(opp.id) ? (
          <button
            type="button"
            className="rfoppname rfoppopen"
            title={`${opp.name} — open the record`}
            onClick={() => onOpenRecord(opp.id)}
          >
            {opp.name}
          </button>
        ) : (
          <span className="rfoppname" title={opp.name}>
            {opp.name}
          </span>
        )}
        <span className="rfoppago">
          {opp.ago === null ? "undated" : `${opp.ago}d ago`}
        </span>
        {editing ? null : (
          <span
            className={
              opp.status === "won"
                ? "rfoppstat rfgreen"
                : opp.status === "lost" || opp.status === "abandoned"
                  ? "rfoppstat rfred"
                  : "rfoppstat"
            }
          >
            {opp.status}
            {opp.value ? ` · ${moneyMo(opp.value)}` : ""}
          </span>
        )}
        <button
          type="button"
          className="linkbtn"
          onClick={() => {
            setEditing((v) => !v);
            setErr("");
            setNote("");
          }}
        >
          {editing ? "cancel" : "edit"}
        </button>
      </div>

      {editing ? (
        <div className="rfoppedit">
          <label>
            Monthly value
            <input
              type="number"
              min="0"
              step="100"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              placeholder="0"
            />
          </label>
          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {["open", "won", "lost", "abandoned"].map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ibtn"
            disabled={busy || !dirty}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {/* ⚠️ REVENUE ONLY COUNTS `won`, and that is not guessable from the
              control. Measured on the live account: 596 open, 2 won. The
              revenue column reads near-zero until cases are marked, so the
              person who can change that should be told what marking does. */}
          <div className="rfdhint">
            ⚠️ The revenue figures on this screen count <b>won</b> cases only.
            An open case contributes its value to nothing until it is marked.
          </div>
        </div>
      ) : null}

      {err ? <div className="rfdhint rfdbad">{err}</div> : null}
      {note ? <div className="rfdhint rfgreen">{note}</div> : null}
    </div>
  );
}

function PartnerDrawer({
  p,
  ssoBlob,
  referrals,
  events,
  attendees,
  hostField,
  onClose,
  onLog,
  onLogReferral,
  onAddEvent,
  onChanged,
  onOpenRecord,
  canOpenRecord,
  notesToken,
}: {
  onOpenRecord?: (id: string) => void;
  canOpenRecord?: (id: string) => boolean;
  p: EnrichedPartner;
  ssoBlob: string | null;
  referrals: RawReferral[];
  events: RawEvent[];
  attendees: RawAttendee[];
  /** "" when no Event Host field exists — "Events worked" then cannot exist. */
  hostField: string;
  onClose: () => void;
  onLog: () => void;
  onLogReferral: () => void;
  onAddEvent: () => void;
  /** A row edited its case — re-read so every figure above it agrees. */
  onChanged: () => void;
  /**
   * 🔴 ANALYSIS 104 · 5 — BUMPED WHEN A TOUCH IS LOGGED FROM IN HERE.
   *
   * The notes are fetched once, keyed on `p.id`. Logging a touch updated
   * `partners[].lastTouch` and nothing else, so **Cadence moved and Touch
   * history did not**: the note you had just written was missing from the list
   * directly under the button that wrote it, until a full reload.
   *
   * ⚠️ A TOKEN, NOT A LOCAL PREPEND. Inserting the new note optimistically
   * would show my idea of what was written rather than what GoHighLevel
   * actually stored — and the note list is the one place on this screen that
   * has to be the record, not a reconstruction of it.
   */
  notesToken: number;
}) {
  /**
   * 🔴 FOCUS IN, AND BACK OUT AGAIN — analysis 104 · 17 and 19.
   *
   * ⚠️ RETURNING IT IS THE HALF PEOPLE FORGET. Moving focus into a dialog and
   * dropping it at the document root on close is worse than never moving it:
   * a keyboard user is returned to the top of the page and has to walk the
   * whole table again to get back to the row they opened.
   */
  const drawerRef = useRef<HTMLElement | null>(null);
  const returnFocusTo = useRef<Element | null>(null);
  useEffect(() => {
    returnFocusTo.current = document.activeElement;
    drawerRef.current?.focus();
    return () => {
      const el = returnFocusTo.current as HTMLElement | null;
      // ⚠️ ONLY IF IT IS STILL THERE. The row that opened this can have been
      // re-rendered away by a save, and focusing a detached node silently does
      // nothing — so fall back rather than leave focus nowhere.
      if (el && document.contains(el) && typeof el.focus === "function") el.focus();
    };
  }, []);

  const [notes, setNotes] = useState<
    { id: string; when: string; who: string; txt: string; type?: string }[] | null
  >(null);
  const [noteErr, setNoteErr] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    setNotes(null);
    setNoteErr(null);
    apiFetch<{
      notes: { id: string; when: string; who: string; txt: string; type?: string }[];
    }>(
      // 🔴 ROUND 122 · ITEM 15 — the partner's contact id travels in the body,
      // not the URL. Same fault as the contact-opps read; this one was missed
      // on the first pass and the proof caught it.
      "/api/referrals",
      {
        method: "POST",
        ssoBlob,
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          action: "partner-notes",
          contactId: p.id,
        }),
      },
    )
      .then((j) => {
        if (live) setNotes(j.notes);
      })
      .catch((e) => {
        if (live) setNoteErr(e);
      });
    return () => {
      live = false;
    };
    // ⚠️ `notesToken` IS A DEPENDENCY, NOT A TRIGGER SIDE-DOOR. It changes
    // only when a touch has been logged for this partner, so the refetch is
    // one request per write rather than a poll.
  }, [p.id, ssoBlob, notesToken]);

  const mine = referrals
    .filter((o) => o.partnerId === p.id)
    .sort((a, b) => (a.ago ?? 1e9) - (b.ago ?? 1e9));
  /**
   * 🔴 THE ONLY FILTERED THING ON THIS SCREEN. Every figure above is the
   * business's number; this list names individual cases, so it honours
   * applyAccess. See RawReferral.visible.
   */
  const shownRows = mine.filter((o) => o.visible);
  const withheld = mine.length - shownRows.length;

  return (
    <>
      <div className="scrim on" onClick={onClose} />
      <aside
        className="rfdrawer"
        role="dialog"
        aria-modal="true"
        aria-label={p.org}
        ref={drawerRef}
        // 🔴 ANALYSIS 104 · 17 — ESCAPE CLOSES IT, AND FOCUS GOES IN.
        //
        // ⚠️ `aria-modal="true"` WAS ALREADY A PROMISE THIS DID NOT KEEP. It
        // tells assistive tech that everything behind is inert — and focus
        // stayed outside, Escape did nothing, and Tab walked straight back into
        // the table underneath. An aria attribute that describes behaviour the
        // component does not have is worse than none: it makes the screen
        // reader lie on the component's behalf.
        //
        // ⚠️ THE HANDLER IS ON THE ELEMENT, NOT ON `window`. A global key
        // listener would also close this drawer while somebody is typing
        // Escape out of the division listbox above it.
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          onClose();
        }}
      >
        <div className="rfdhd">
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
          <h2>{p.org}</h2>
          {/* 🔴 ROUND 167 · B8 — THE PANEL SAYS IT TOO. Somebody who opened a
              partner from a search has not necessarily seen the Sources row it
              came from, and "why can I see this" is most pressing on the screen
              where its whole history is. */}
          <DivisionTag division={p.division} shared={p.shared} />
          <div className="rfdmeta">
            {[p.cat, p.owner ? `owned by ${p.owner}` : "unassigned"]
              .filter(Boolean)
              .join(" · ")}{" "}
            <TierBadge t={p.tier} />
          </div>
          {p.email || p.phone ? (
            <div className="rfdmeta">{[p.email, p.phone].filter(Boolean).join(" · ")}</div>
          ) : null}
        </div>
        <div className="rfdbd">
          {/* 🔴 KEPT VERBATIM FROM THE PROTOTYPE, AND IT GOES FIRST.
              It states where PHI lives, and this dashboard's whole design rests
              on it: nothing here is a copy of a care record. It is also true of
              the code — the partner's name, email and phone on this panel came
              from GoHighLevel on this request and are not stored anywhere by
              this application. */}
          <div className="rfdsec">
            <div className="rflive">
              <b>Contact details load live from GoHighLevel.</b> Names, phone
              numbers and care notes are never written to this
              application&apos;s database. This panel is where that boundary
              sits.
            </div>
          </div>

          <div className="rfdsec">
            <h4>Performance</h4>
            <dl className="rfkv">
              <dt>Referrals, lifetime</dt>
              <dd>
                {p.refs}
                {p.undated ? ` (${p.undated} undated)` : ""}
              </dd>
              <dt>Referrals, last 90 days</dt>
              <dd>{p.refs90}</dd>
              <dt>Clients won</dt>
              <dd>{p.won}</dd>
              <dt>Win rate</dt>
              <dd>{p.refs ? `${p.winRate}%` : "—"}</dd>
              <dt>Revenue from this partner</dt>
              <dd>{moneyMo(p.revenue)}</dd>
              <dt>Last referral</dt>
              <dd>{p.lastRefAgo === null ? "never" : `${p.lastRefAgo} days ago`}</dd>
            </dl>
          </div>

          <div className="rfdsec">
            <h4>Contact cadence</h4>
            <dl className="rfkv">
              <dt>Tier cadence</dt>
              <dd>every {p.cadence} days</dd>
              <dt>Last touch</dt>
              <dd>
                {p.unknownTouch
                  ? "not measured"
                  : p.lastTouch === NEVER
                    ? "never"
                    : `${p.lastTouch} days ago`}
              </dd>
              <dt>Status</dt>
              <dd className={p.unknownTouch ? "" : p.isOverdue ? "rfred" : "rfgreen"}>
                {p.unknownTouch
                  ? "unknown — excluded from the queue"
                  : p.lastTouch === NEVER
                    ? "never contacted"
                    : p.isOverdue
                      ? `${p.overdueBy} days overdue`
                      : `due in ${Math.abs(p.overdueBy as number)} days`}
              </dd>
            </dl>
            <div className="rfdacts">
              {/* 🔴 "Log a referral" FIRST — it is the one that moves revenue.
                  Round 100 had only "Log a touch", which made the drawer a
                  place to record effort and never result. */}
              <button type="button" className="cgsave" onClick={onLogReferral}>
                Log a referral
              </button>
              <button type="button" className="ighost" onClick={onLog}>
                Log a touch
              </button>
              {/* 🔴 THE ONLY WRITER OF `Event Host`. Same problem as Event
                  Source: the field exists and nothing sets it, so "Run by
                  [ partner ]" can never resolve and "Events worked" is
                  permanently empty. An event belongs to whoever ran it, so it
                  is created from their panel. */}
              <button type="button" className="ighost" onClick={onAddEvent}>
                Add an event
              </button>
            </div>
            {/* ⚠️ THE SENTENCE STAYS, WORD FOR WORD. It is the distinction the
                whole screen turns on, and with two buttons side by side it is
                now doing real work rather than explaining an absence. */}
            <div className="rfdhint">
              A touch is outreach you did. A referral is business they sent. Only
              the second one moves the revenue column.
            </div>
          </div>

          <div className="rfdsec">
            <h4>Touch history</h4>
            {noteErr ? (
              <ErrorMessage error={noteErr} className="errmsg" />
            ) : notes === null ? (
              <div className="rfdhint">Reading notes…</div>
            ) : !notes.length ? (
              <div className="rfdhint">
                No notes yet. Logging a touch starts the cadence clock.
              </div>
            ) : (
              <div className="rftl">
                {notes.map((n) => (
                  <div className="rftli" key={n.id}>
                    {/* d · type · note — the prototype's timeline, now that the
                        type is actually stored rather than discarded. */}
                    <div className="d">{n.when}</div>
                    <div className="t">
                      {n.type ? `${n.type} · ` : ""}
                      {n.who}
                    </div>
                    <div className="n">{n.txt}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ⚠️ ONLY WHEN THERE ARE ANY — the brief's own rule. With no
              `Event Host` field on the account there can be none, so the
              section does not render at all rather than showing six zeros. */}
          {(() => {
            const ev = partnerEvents(p.id, events, attendees, referrals);
            // ⚠️ NOTHING, RATHER THAN SIX ZEROS — the brief's "only when there
            // are any". But say WHY when the reason is structural: an admin
            // wondering where this section went deserves better than silence.
            if (!ev.count)
              return hostField ? null : (
                <div className="rfdsec">
                  <h4>Events worked</h4>
                  <div className="rfdhint">
                    Not available: no <b>Event Host</b> field exists on the
                    opportunity, so nothing records which partner ran an event.
                  </div>
                </div>
              );
            const cplGood = ev.cpl !== null && ev.cpl <= 120;
            return (
              <div className="rfdsec">
                <h4>Events worked</h4>
                <dl className="rfkv">
                  <dt>Events attended</dt>
                  <dd>{ev.count}</dd>
                  <dt>People met</dt>
                  <dd>{ev.met}</dd>
                  <dt>Legitimate leads</dt>
                  <dd>{ev.legit}</dd>
                  <dt>Clients won</dt>
                  <dd>{ev.clients}</dd>
                  <dt>Spent on these events</dt>
                  <dd>{money(ev.cost)}</dd>
                  <dt>Cost per legit lead</dt>
                  <dd className={ev.cpl === null ? "" : cplGood ? "rfgreen" : "rfred"}>
                    {ev.cpl === null ? "—" : money(ev.cpl)}
                  </dd>
                </dl>
                <div className="rftl" style={{ marginTop: 13 }}>
                  {ev.rows.map(({ event, st }) => (
                    <div className="rftli" key={event.id}>
                      <div className="d">{event.date || "no date"}</div>
                      <div className="t">{event.name}</div>
                      <div className="n">
                        {st.met} met · {st.legit} legit · {st.clients} client
                        {st.clients === 1 ? "" : "s"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          <div className="rfdsec">
            <h4>Attributed opportunities</h4>
            {!mine.length ? (
              <div className="rfdhint">Nothing attributed yet.</div>
            ) : !shownRows.length ? (
              <div className="rfdhint">
                None of {mine.length === 1 ? "this referral" : `these ${mine.length} referrals`}{" "}
                is one you own or follow, and{" "}
                {mine.length === 1 ? "it is" : "none is"} unclaimed in a pipeline
                you hold — so there is nothing here to list. The figures above
                still count {mine.length === 1 ? "it" : "all of them"}.
              </div>
            ) : (
              <div className="rfopps">
                {shownRows.slice(0, 12).map((o) => (
                  <AttributedRow
                    key={o.id}
                    opp={o}
                    ssoBlob={ssoBlob}
                    onSaved={onChanged}
                    onOpenRecord={onOpenRecord}
                    canOpenRecord={canOpenRecord}
                  />
                ))}
              </div>
            )}
            {/* 🔴 THE SENTENCE, AND IT DESCRIBES WHAT IS SHOWN — NOT WHAT IS
                WITHHELD.
                "the rest are in another division" was false: applyAccess never
                looks at division (lib/pipelineAccess.ts:132-147).
                "the rest are not assigned to you" was also wrong, twice over —
                a record you FOLLOW is shown, so "assigned" is the wrong test;
                and an UNASSIGNED case in a pipeline you hold is shown too, so
                any sentence about the withheld set implies the complement
                "these ones are yours", which is false for exactly those.
                Describing the INCLUDED set positively cannot imply anything
                false about either side, and it is the predicate the filter
                actually implements. */}
            {withheld > 0 ? (
              <div className="rfwithheld">
                {shownRows.length} of {mine.length} shown — the cases you own or
                follow, plus unclaimed cases in your own pipelines.{" "}
                <b>The figures above count all {mine.length}.</b>
              </div>
            ) : null}
          </div>

          {p.notes ? (
            <div className="rfdsec">
              <h4>Partner notes</h4>
              <div className="rfdnote">{p.notes}</div>
            </div>
          ) : null}
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// LOG A TOUCH
// ---------------------------------------------------------------------------
function LogTouchDialog({
  ssoBlob,
  partner,
  onClose,
  onLogged,
}: {
  ssoBlob: string | null;
  partner: EnrichedPartner;
  onClose: () => void;
  onLogged: (days: number) => void;
}) {
  const [text, setText] = useState("");
  const [touchType, setTouchType] = useState<string>(TOUCH_TYPES[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState("");

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const j = await apiFetch<{ lastTouch: number }>("/api/referrals", {
        method: "POST",
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          action: "log-touch",
          contactId: partner.id,
          touchType,
          text: text.trim(),
        }),
      });
      onLogged(j.lastTouch ?? 0);
      setDone("Touch logged.");
      setTimeout(onClose, 900);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="previewmodal" onClick={onClose}>
      <div className="movebox addbox rfmodal" onClick={(e) => e.stopPropagation()}>
        <div className="previewhead">
          <span className="previewname">Log a touch · {partner.org}</span>
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="movebody">
          {/* 🔴 ROUND 117 · ITEM 1 — the same shape as "Log a referral".
              ⚠️ ONE SHORT FIELD AND NO PARTNER FOR IT. Rather than invent a
              field to fill the second cell, it carries what the first one
              MEANS — which is the "not enough detail" fault, answered where the
              question is asked rather than in a paragraph underneath. */}
          <div className="rfgroup">
            <div className="rfglab">The touch</div>
            <div className="rfdhint">
              <b>A touch is contact with a person, in either direction</b> — a
              call, a visit, an email they answered. A voicemail counts; a
              newsletter they were on a list for does not.
            </div>
            <div className="irow2">
              <div>
                <label htmlFor="rf-ttype">Type</label>
                <select
                  id="rf-ttype"
                  value={touchType}
                  onChange={(e) => setTouchType(e.target.value)}
                >
                  {TOUCH_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rfpaircell">
                🔴 <b>Logging this restarts the cadence clock.</b> The partner
                drops out of the due queue and comes back when their tier&apos;s
                interval is up.
              </div>
            </div>
            <div className="irow">
              <label htmlFor="rf-touch">What happened</label>
              <textarea
                id="rf-touch"
                rows={4}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Called the discharge planner. Two families to follow up next week."
              />
            </div>
            <div className="rfdhint">
              ⚠️ <b>Write what the next person needs</b>, not that you called.
              &ldquo;Left a message&rdquo; and &ldquo;Two families to follow up
              Tuesday&rdquo; both clear the clock; only one is worth reading in
              six weeks.
            </div>
          </div>
          <div className="rfdhint">
            Written as a note on the partner&apos;s contact in GoHighLevel, which
            is the same thing the cadence clock reads. Nothing is stored in this
            application.
          </div>
          {err ? <ErrorMessage error={err} className="savemsg err" /> : null}
          {done ? <div className="savemsg ok">{done}</div> : null}
        </div>
        <div className="moveacts">
          <button type="button" className="ighost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="cgsave"
            onClick={() => void save()}
            disabled={busy || !text.trim()}
          >
            {busy ? "Saving…" : "Log touch"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ADD A PARTNER
//
// 🔴 REPORT 99 (d). With no contact carrying Record Type = "Referral Partner",
// every tab renders zero and nothing in the view can change that — an admin
// would have to leave for GoHighLevel and set five fields by hand.
//
// ⚠️ IT WRITES ONLY THE CONTACT. A partner is not a case.
// ---------------------------------------------------------------------------
function AddPartnerDialog({
  ssoBlob,
  division,
  owners,
  categories,
  tiers,
  divisions,
  divisionsAreLive,
  onClose,
  onAdded,
}: {
  ssoBlob: string | null;
  /** Pre-filled from the heading, because that is the division you are in. */
  division: Division;
  owners: Owner[];
  /** 🔴 THE LIVE FIELD'S OWN OPTIONS. See lib/referrals.ts PARTNER_CATEGORIES. */
  categories: string[];
  tiers: string[];
  divisions: string[];
  /**
   * 🔴 ROUND 130'S WARNING, MOVED HERE FROM THE SWITCHER — task 2 · §3.
   *
   * False means `Partner Division`'s options could not be read and `divisions`
   * above is this app's hardcoded fallback. That fallback reproduces the
   * pre-round-128 behaviour exactly, so without a note it hides its own
   * failure — and this dialog is now the place it can actually mislead, since
   * it is what writes the value.
   */
  divisionsAreLive: boolean;
  onClose: () => void;
  onAdded: (saved?: RawPartner) => void;
}) {
  /**
   * 🔴 949 CONTACTS ALREADY EXIST, so "new organisation" cannot be the only
   * option. A partner is often already in the system — someone who enquired
   * once, a caregiver's relative who works at a hospital — and creating them
   * again is the first thing this feature would otherwise do.
   */
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; email: string; phone: string }[]>([]);
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [searching, setSearching] = useState(false);
  /**
   * 🔴 A FAILED SEARCH IS NOT AN EMPTY ONE. The catch below did
   * `setHits([])`, so a 500, a 401 or a dropped connection all rendered
   * "No contact matches" — telling the user to create a duplicate because the
   * search broke. Three states, three sentences: searching, no matches, failed.
   */
  const [searchErr, setSearchErr] = useState("");
  const [org, setOrg] = useState("");
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [cat, setCat] = useState("");
  const [tier, setTier] = useState<string>("Prospect");
  /**
   * 🔴 ANALYSIS 104 · 21 — "All divisions" IS A VIEW, NOT A PROPERTY.
   *
   * This seeded from the heading. Standing in ODP that is right: you are in
   * ODP, so the partner is ODP. But when the heading reads **All divisions**
   * it describes what you are LOOKING AT, and storing it turns a view into the
   * value `"All"` — which `inDivision()` makes mean *appears under every
   * division, for ever*.
   *
   * ⚠️ A UI DEFAULT MAKING A DATA DECISION WITH ACCOUNT-WIDE REACH. It now
   * opens UNSET in that one case and the choice has to be made; every real
   * division still seeds as before, because there it is a fact and not a guess.
   */
  const [div, setDiv] = useState<string>(division === "All" ? "" : division);
  const [owner, setOwner] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState("");

  // Debounced, and only from two characters — a keystroke-per-request picker on
  // a 100-per-10-seconds budget is the same hazard as an unpaced loop.
  useEffect(() => {
    if (mode !== "existing" || q.trim().length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      apiFetch<{ contacts: typeof hits }>(
        `/api/referrals?only=contacts&q=${encodeURIComponent(q.trim())}`,
        { ssoBlob },
      )
        .then((j) => {
          if (!live) return;
          setSearchErr("");
          setHits(j.contacts || []);
        })
        .catch((e) => {
          if (!live) return;
          setHits([]);
          setSearchErr(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, mode, ssoBlob]);

  const save = async () => {
    setBusy(true);
    setErr(null);
    setDone("");
    try {
      const j = await apiFetch<{ contactId: string; skipped?: string[]; promoted?: boolean }>(
        "/api/referrals",
        {
          method: "POST",
          body: JSON.stringify({
            ssoKey: ssoBlob ?? undefined,
            action: "add-partner",
            ...(mode === "existing" && picked ? { contactId: picked.id } : {}),
            org: mode === "existing" && picked ? picked.name : org.trim(),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: email.trim(),
            phone: phone.trim(),
            category: cat,
            tier,
            division: div,
            owner,
            notes: notes.trim(),
          }),
        },
      );
      const verb = j.promoted ? "marked as a referral partner" : "added";
      const name = picked?.name || org.trim();
      setDone(
        j.skipped?.length
          ? `Saved: ${name} — ${verb}. Not saved on this account: ${j.skipped.join("; ")}.`
          : `Saved: ${name}`,
      );
      // 🔴 ROUND 175 · ITEM 3 — THE SAVED ROW GOES UP, not just a "reload now".
      // GoHighLevel's search cannot see this contact for up to a minute, so the
      // list has to be told what was saved rather than asked.
      onAdded(
        j.contactId
          ? {
              id: j.contactId,
              org: name,
              email: email.trim(),
              phone: phone.trim(),
              cat,
              tier: tier || "Prospect",
              division: div,
              owner: "",
              ownerId: owner || "",
              notes: notes.trim(),
              shared: false,
              lastTouch: null,
            }
          : undefined,
      );
      setTimeout(onClose, j.skipped?.length ? 3200 : 1200);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="previewmodal" onClick={onClose}>
      <div className="movebox addbox cgadd rfmodal" onClick={(e) => e.stopPropagation()}>
        <div className="previewhead">
          <span className="previewname">Add a referral partner</span>
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="movebody">
          {/* 🔴 ROUND 117 · ITEM 1 — THREE GROUPS, NOT ELEVEN STACKED ROWS.
              Who they are · How we work them · Notes. The headings are what
              let somebody scan for the part they are changing instead of
              reading the whole form from the top. */}
          <div className="rfgroup">
            <div className="rfglab">Who they are</div>
          <div className="rfmode">
            <label>
              {/* ⚠️ `name` MAKES THEM A GROUP. Without it these are two
                  independent radios that merely look like a pair: arrow keys do
                  not move between them and assistive tech announces two
                  unrelated controls. React's `checked` kept them visually in
                  step, which is exactly why it went unnoticed. */}
              <input
                type="radio"
                name="rfpartnermode"
                checked={mode === "new"}
                onChange={() => {
                  setMode("new");
                  setPicked(null);
                }}
              />
              New organisation
            </label>
            <label>
              <input
                type="radio"
                name="rfpartnermode"
                checked={mode === "existing"}
                onChange={() => setMode("existing")}
              />
              Pick an existing contact
            </label>
          </div>

          {mode === "existing" ? (
            <>
              <div className="irow">
                <label htmlFor="rf-find">Find a contact</label>
                <input
                  id="rf-find"
                  type="search"
                  value={picked ? picked.name : q}
                  onChange={(e) => {
                    setPicked(null);
                    setQ(e.target.value);
                  }}
                  placeholder="Riddle, Chamber, a person's name…"
                />
              </div>
              {picked ? (
                <div className="rfpicked">
                  <b>{picked.name}</b> will be marked as a referral partner. Their
                  existing record is kept — nothing is duplicated.
                  <button type="button" className="linkbtn" onClick={() => setPicked(null)}>
                    change
                  </button>
                </div>
              ) : q.trim().length >= 2 ? (
                /* 🔴 ROUND 125 — THE SAME FAULT, A SECOND TIME, AND THE BRIEF
                   ONLY SAW ONE OF THEM. Identical structure to the Log a
                   referral picker: three one-line states inside `.rfhits`,
                   which is `overflow-y:auto`, with `.rfmodal .rfdhint`'s
                   margin-top:-8px pulling the first of them above the scroll
                   box and getting its top line cut off. Same restructure —
                   `.rfhits` wraps hits and nothing else. */
                <>
                  {searching ? (
                    <div className="rfdhint">Searching…</div>
                  ) : searchErr ? (
                    <div className="rfdhint rfdbad rfsearchfail">
                      {/* ⚠️ The trailing full stop is stripped — apiFetch's
                          message already ends in one. */}
                      The contact search failed — {searchErr.replace(/\.\s*$/, "")}. This is
                      not the same as nobody matching, so do <b>not</b> add them
                      as a new organisation until it works: you would create a
                      duplicate.
                    </div>
                  ) : !hits.length ? (
                    <div className="rfdhint">
                      No contact matches “{q.trim()}”. Switch to <b>New
                      organisation</b> if they are not in GoHighLevel yet.
                    </div>
                  ) : (
                    <div className="rfhits">
                      {hits.map((h) => (
                        <button
                          type="button"
                          className="rfhit"
                          key={h.id}
                          onClick={() => setPicked({ id: h.id, name: h.name })}
                        >
                          <span className="n">{h.name}</span>
                          <span className="m">
                            {[h.email, h.phone].filter(Boolean).join(" · ") || "no email or phone"}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="rfdhint">
                  Type at least two characters. ⚠️ This searches every contact,
                  not only partners — the point is to catch someone who is
                  already in GoHighLevel under another hat.
                </div>
              )}
            </>
          ) : null}

          {mode === "new" ? (
          <>
          <div className="irow">
            <label htmlFor="rf-org">Organisation</label>
            <input
              id="rf-org"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              placeholder="Riddle Hospital"
            />
          </div>
          <div className="rfdhint">
            The organisation, not the individual. Individuals move jobs; the
            relationship usually stays. A named contact is optional and goes on
            the same record, so the row still reads as the organisation.
          </div>
          </>
          ) : null}
          {/* 🔴 NOT ASKED FOR WHEN PROMOTING — round 113, item H.
              A promote adds a ROLE to a contact that already exists; the picker
              just found them BY these very details. Asking again was neither
              pointless nor destructive but something worse than both: the
              promote branch (app/api/referrals/route.ts:1038-1048) reads only
              the partner custom fields and the owner, so anything typed here
              was SILENTLY DISCARDED — the screen collected four values and
              threw them away without saying so.
              ⚠️ And it cannot blank the record either, for the same reason.
              Correcting a contact's details is the record panel's job.
              They are rendered only when a NEW organisation is being created,
              which is the one case where they have somewhere to go. */}
          {mode === "existing" && picked ? null : (
            <>
              {/* 🔴 ROUND 117 · ITEM 1 — PAIRED, NOT STACKED. These were already
                  two-per-`.irow`, but `.movebody .irow input{width:100%}` gives
                  every control its own line, so four fields became eight rows of
                  one line's worth of content each. `.irow2` is the grid 115c
                  built for exactly this. */}
              <div className="irow2">
                <div>
                  <label htmlFor="rf-first">Contact first name</label>
                  <input id="rf-first" value={firstName} onChange={(e) => setFirst(e.target.value)} />
                </div>
                <div>
                  <label htmlFor="rf-last">Last name</label>
                  <input id="rf-last" value={lastName} onChange={(e) => setLast(e.target.value)} />
                </div>
              </div>
              <div className="irow2">
                <div>
                  <label htmlFor="rf-email">Email</label>
                  <input
                    id="rf-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="rf-phone">Phone</label>
                  <input
                    id="rf-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
              </div>
              <div className="rfdhint">
                ⚠️ <b>A named contact is optional.</b> The row reads as the
                organisation either way — this is who to ask for when you call,
                and it can be filled in later from the record.
              </div>
            </>
          )}
          </div>
          <div className="rfgroup">
            <div className="rfglab">How we work them</div>
            {/* ⚠️ THE BRIEF'S OWN HINTS, KEPT — and moved ABOVE the fields they
                describe. A tier explained underneath is explained after it has
                already been guessed. */}
            <div className="rfdhint">
              <b>Tier sets the contact cadence</b> — A every 14 days, B monthly,
              C quarterly, prospect every 21 — and that is the only thing it
              does. <b>Owner</b> is who holds the relationship: it decides whose
              due queue this lands in and who sees it.
            </div>
            <div className="irow2">
              <div>
                <label htmlFor="rf-cat">Category</label>
                <select id="rf-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
                  <option value="">Not set</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="rf-tier">Tier</label>
                <select id="rf-tier" value={tier} onChange={(e) => setTier(e.target.value)}>
                  {tiers.map((t) => (
                    <option key={t} value={t}>
                      {t}
                      {CADENCE[t] ? ` · every ${CADENCE[t]} days` : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="rfdhint">
              <b>Category can be left Not set.</b> It groups partners on the
              sources table and nothing depends on it — set it later from the
              record when the relationship has a shape.
            </div>
            <div className="irow2">
              <div>
                <label htmlFor="rf-div">Division</label>
                <select id="rf-div" value={div} onChange={(e) => setDiv(e.target.value)}>
                  {/* ⚠️ THE UNSET OPTION EXISTS ONLY WHEN IT IS THE STATE WE ARE
                      IN. Offering "Choose one…" permanently would invite an
                      unset division on a partner added from inside ODP, where
                      the answer is known. */}
                  {div === "" ? (
                    <option value="">Choose a division…</option>
                  ) : null}
                  {divisions.map((d) => (
                    <option key={d} value={d}>
                      {d === "All" ? "All — appears under every division" : d}
                    </option>
                  ))}
                </select>
                {/* 🔴 TASK 2 · §4 — WHY IT IS NOW REQUIRED. A partner saved with
                    no division is visible to EVERY viewer, because blank means
                    "every division" (inDivision). That was the leak, and the
                    count of it is on the Sources table. Requiring it here is
                    what stops the set growing; the count then shrinks to zero
                    on its own instead of being a permanent label. */}
                {!div ? (
                  <div className="rfdhint rfdbad">
                    ⚠️ Required. A partner with no division is shown to
                    everybody, whichever division they work in.
                  </div>
                ) : null}
                {/* 🔴 ROUND 130'S NOTE, MOVED FROM THE SWITCHER. This dialog is
                    what WRITES the value, so a fallback list misleads here in a
                    way it no longer can on a switcher fed by the records. */}
                {!divisionsAreLive ? (
                  <div className="rfdhint">
                    ⚠️ These are this app&apos;s built-in divisions. No{" "}
                    <b>Partner Division</b> options could be read from this
                    account — check the field exists, is named exactly{" "}
                    <b>Partner Division</b>, and is a dropdown.
                  </div>
                ) : null}
              </div>
              <div>
                <label htmlFor="rf-owner">Owner</label>
                <select
                  id="rf-owner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                >
                  <option value="">Unassigned</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          <div className="rfgroup">
            <div className="rfglab">Notes</div>
            <div className="irow">
              <label htmlFor="rf-notes">Notes</label>
              <textarea
                id="rf-notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Two discharge planners. Prefers a Tuesday call."
              />
            </div>
          </div>
          <div className="rfdhint">
            ⚠️ A category or tier this GoHighLevel account has no option for is
            skipped rather than invented, and the reply says which. The partner
            is still created.
          </div>
          {err ? <ErrorMessage error={err} className="savemsg err" /> : null}
          {done ? <div className="savemsg ok">{done}</div> : null}
        </div>
        <div className="moveacts">
          <button type="button" className="ighost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="cgsave"
            onClick={() => void save()}
            // 🔴 `!div` IS NEW — task 2 · §4. Both modes send `division: div`,
            // and the guard checked only the name, so a partner added from the
            // "All divisions" view (where `div` deliberately seeds EMPTY, so a
            // view is not stored as a property) saved with no division at all —
            // and blank means visible to everyone. This is the end that closes;
            // the count on the Sources table is the end that labels.
            disabled={busy || !div || (mode === "new" ? !org.trim() : !picked)}
          >
            {busy ? "Saving…" : mode === "existing" ? "Mark as partner" : "Add partner"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LOG A REFERRAL — 🔴 THIS ONE CREATES AN OPPORTUNITY.
//
// TWO WRITES, not three: `createOpportunity` accepts `customFields`, so the
// attribution is in the SAME request that creates the case. There is no state
// in which an opportunity exists unattributed.
//
// ⚠️ PASS-THROUGH ONLY. The name and phone go straight to GoHighLevel and are
// never written to this dashboard's database. Only the returned record id and
// the attribution are kept here — the same boundary the drawer states.
// ---------------------------------------------------------------------------
function LogReferralDialog({
  ssoBlob,
  partner,
  event,
  pipelines,
  withheld,
  onClose,
  onLogged,
}: {
  ssoBlob: string | null;
  /**
   * 🔴 OPTIONAL — AND THAT IS WHAT GAVE `Event Source` A WRITER.
   * Opened from an event with no host there is no partner in the sentence at
   * all: you met them at the expo, and the expo is the source. Requiring a
   * partner is precisely why the field could never be written.
   */
  partner?: Pick<RawPartner, "id" | "org" | "division">;
  /** Set when the referral came from an event card. */
  event?: RawEvent;
  pipelines: PipelineChoice[];
  /**
   * 🔴 HOW MANY CLIENT PIPELINES THIS VIEWER MAY NOT FILE INTO — task 2 · §1.
   *
   * ⚠️ IT ONLY EVER CHANGES A SENTENCE. Nothing about the form's behaviour
   * reads it; an empty `pipelines` already disables the save. What it decides
   * is WHICH empty state is on screen, and that decision sends the reader to
   * two different places.
   */
  withheld: number;
  onClose: () => void;
  onLogged: () => void;
}) {
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [phone, setPhone] = useState("");
  /**
   * 🔴 ROUND 167 — THE FIELD DID NOT EXIST, AND THE ROUTE HAS ALWAYS ACCEPTED
   * IT. `log-referral` reads `body.email` and this dialog never sent one, so
   * the only way to make a referral reachable was a phone number. With a phone
   * or an email now REQUIRED, offering only one of the two keys the route
   * accepts would force a number out of somebody who has an address — a
   * requirement met by inventing data, which is the opposite of the point.
   */
  const [email, setEmail] = useState("");
  const [monthly, setMonthly] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState("");

  /**
   * 🔴 THE COMMON CASE HAD NO PATH — round 115c, item 4.
   *
   * Someone fills the website form, and on the call mentions Riddle Hospital
   * sent them. "Log a referral" only ever CREATED a contact and an opportunity,
   * so the only way to credit the partner was to leave the drawer, find the
   * client and set "Referred by" on their record panel — which is the same
   * write, from the other direction.
   *
   * ⚠️ AND IT MUST NOT DUPLICATE. Round 107 built promote-not-duplicate on
   * "+ Add partner" for exactly this reason; this reuses the same contact
   * search and writes nothing but the attribution.
   */
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; email: string; phone: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState("");
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [opps, setOpps] = useState<
    | {
        id: string; name: string; pipelineName: string; stage: string;
        status: string; partnerId: string;
      }[]
    | null
  >(null);
  const [oppsErr, setOppsErr] = useState("");
  const [refField, setRefField] = useState("");
  const [chosenOpp, setChosenOpp] = useState("");

  // Contact search — debounced, two characters, exactly as "+ Add partner".
  useEffect(() => {
    if (mode !== "existing" || picked || q.trim().length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      apiFetch<{ contacts: typeof hits }>(
        `/api/referrals?only=contacts&q=${encodeURIComponent(q.trim())}`,
        { ssoBlob },
      )
        .then((j) => {
          if (!live) return;
          setSearchErr("");
          setHits(j.contacts || []);
        })
        .catch((e) => {
          if (!live) return;
          setHits([]);
          setSearchErr(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (live) setSearching(false);
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, mode, picked, ssoBlob]);

  // Their opportunities, once one is chosen.
  useEffect(() => {
    if (!picked) {
      setOpps(null);
      setChosenOpp("");
      return;
    }
    let live = true;
    setOpps(null);
    setOppsErr("");
    apiFetch<{
        opportunities?: {
          id: string;
          name: string;
          pipelineName: string;
          stage: string;
          status: string;
          partnerId: string;
        }[];
        referringPartnerField?: string;
      }>("/api/referrals", {
        // 🔴 ROUND 122 · ITEM 15 — THE CONTACT ID TRAVELS IN THE BODY.
        // It was `?only=contact-opps&contactId=…`, which puts a person's id in
        // the server's access log, the browser's history and any Referer
        // header. This is health care; a URL is the wrong place for it.
        method: "POST",
        ssoBlob,
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          action: "contact-opps",
          contactId: picked.id,
        }),
      })
      .then((j) => {
        if (!live) return;
        // 🔴 THIS LINE WAS LOST when item 15 rewrote the call, and the proof
        // caught it: without the field id `attribute()` returns early and the
        // button stays disabled forever. The whole feature depended on one
        // assignment inside a promise chain I retyped.
        setRefField(j.referringPartnerField || "");
        setOpps(j.opportunities || []);
        if ((j.opportunities || []).length === 1)
          setChosenOpp(j.opportunities![0].id);
      })
      .catch((e) => {
        if (!live) return;
        setOpps([]);
        setOppsErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [picked, ssoBlob]);

  /**
   * Attribute an EXISTING opportunity. One PATCH of Referring Partner — the
   * same write ReferredBy makes from the record panel (app/page.tsx, `onSave` →
   * saveField → PATCH /api/opportunities/{id}).
   *
   * ⚠️ THIS COMMENT SAID "PUT" AND SO DID THE CODE, until round 121. The route
   * exports PATCH only, so the write it described 405'd.
   * Nothing is created.
   */
  const attribute = async () => {
    if (!chosenOpp || !refField || !partner) return;
    setBusy(true);
    setErr(null);
    setDone("");
    try {
      await apiFetch(`/api/opportunities/${encodeURIComponent(chosenOpp)}`, {
        // 🔴 PATCH, for the same reason — and this is the one 115c "proved".
        // The proof asserted "EXACTLY ONE write · a PUT to an opportunity" and
        // passed, against a fake that answered any method. It proved the
        // harness. The record panel's own `saveField` has always sent PATCH;
        // re-implementing the call instead of reusing it is what changed the
        // method.
        method: "PATCH",
        ssoBlob,
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          customFields: [{ id: refField, value: partner.id }],
        }),
      });
      const o = (opps || []).find((x) => x.id === chosenOpp);
      setDone(
        `${o?.name || "That case"} is now attributed to ${partner.org}. ` +
          `Nothing was created — only the referral credit was set.`,
      );
      onLogged();
      setTimeout(onClose, 1800);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  // 🔴 THE DESTINATION IS RESOLVED, NOT HARDCODED, AND IT IS SHOWN BEFORE IT IS
  // COMMITTED. The brief says "creates an opportunity in Private Pay"; §9
  // forbids hardcoded pipeline ids. So the default is matched from the
  // PARTNER'S OWN DIVISION — an ODP partner's referral defaulting into Private
  // Pay is either deliberate or a mis-file, and nothing on screen would say
  // which — falling back to Private Pay by name when there is no match.
  const suggested = useMemo(() => {
    const div = partner?.division || event?.division || "";
    const byDivision = pipelines.find(
      (p) => p.division.toLowerCase() === div.toLowerCase(),
    );
    return (
      byDivision || pipelines.find((p) => /private\s*pay/i.test(p.name)) || pipelines[0]
    );
  }, [pipelines, partner?.division, event?.division]);
  const [pipelineId, setPipelineId] = useState(suggested?.id || "");
  const dest = pipelines.find((p) => p.id === pipelineId) || suggested;

  const save = async () => {
    setBusy(true);
    setErr(null);
    setDone("");
    try {
      const j = await apiFetch<{
        pipelineName: string;
        stageName: string;
        noteSaved: boolean;
        eventLinkSkipped?: boolean;
      }>(
        "/api/referrals",
        {
          method: "POST",
          body: JSON.stringify({
            ssoKey: ssoBlob ?? undefined,
            action: "log-referral",
            partnerId: partner?.id || "",
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phone: phone.trim(),
            email: email.trim(),
            monthlyValue: Number(monthly) || 0,
            pipelineId,
            division: partner?.division || event?.division || "",
            ...(event ? { eventId: event.id } : {}),
            text: text.trim(),
          }),
        },
      );
      const to = partner ? partner.org : event ? event.name : "no source";
      setDone(
        `Filed in ${j.pipelineName}${j.stageName ? ` · ${j.stageName}` : ""}, attributed to ${to}.` +
          (j.eventLinkSkipped
            ? " ⚠️ The event link was NOT saved — no Event Source field on this account, so this event's Clients will not count it."
            : "") +
          (j.noteSaved === false ? " The note could not be saved — add it on the record." : ""),
      );
      onLogged();
      setTimeout(onClose, 1800);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="previewmodal" onClick={onClose}>
      <div className="movebox addbox cgadd rfmodal" onClick={(e) => e.stopPropagation()}>
        <div className="previewhead">
          <span className="previewname">
            Log a referral · from {partner ? partner.org : event ? event.name : "—"}
          </span>
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="movebody">
          {/* ⚠️ TRUE OF THE CREATE PATH ONLY. Attributing an existing case sends
              no name and no phone — there is nothing to pass through — so this
              note would be describing a write that is not happening. */}
          {partner && mode === "existing" ? (
            <div className="rflive">
              <b>Nothing is created.</b> This sets the referral credit on a case
              that already exists — one field, on one opportunity. No contact and
              no opportunity is added.
            </div>
          ) : (
            <div className="rflive">
              <b>Pass-through only.</b> The name and phone go straight to
              GoHighLevel and are never written to this dashboard&apos;s
              database. Only the returned record id and the attribution are kept
              here.
            </div>
          )}

          {/* 🔴 TWO PATHS — round 115c, item 4. Only `partner` can attribute an
              existing case: an EVENT credits through Event Source, which is a
              different field and a different write, so the choice is not
              offered there rather than offered and then refused. */}
          {partner ? (
            <div className="rfmode">
              <label>
                <input
                  type="radio"
                  name="rrmode"
                  checked={mode === "new"}
                  onChange={() => {
                    setMode("new");
                    setPicked(null);
                  }}
                />
                New enquiry
              </label>
              <label>
                <input
                  type="radio"
                  name="rrmode"
                  checked={mode === "existing"}
                  onChange={() => setMode("existing")}
                />
                Someone already in GoHighLevel
              </label>
            </div>
          ) : null}

          {partner && mode === "existing" ? (
            <>
              <div className="irow">
                <label htmlFor="rr-find">Find the contact</label>
                <input
                  id="rr-find"
                  type="search"
                  value={picked ? picked.name : q}
                  onChange={(e) => {
                    setPicked(null);
                    setQ(e.target.value);
                  }}
                  placeholder="Their name…"
                />
              </div>

              {picked ? (
                <>
                  <div className="rfpicked">
                    <b>{picked.name}</b> — pick which of their cases{" "}
                    {partner.org} referred.
                    <button
                      type="button"
                      className="linkbtn"
                      onClick={() => setPicked(null)}
                    >
                      change
                    </button>
                  </div>
                  {opps === null ? (
                    <div className="rfdhint">Loading their cases…</div>
                  ) : oppsErr ? (
                    <div className="rfdhint rfdbad">
                      Could not read their cases — {oppsErr.replace(/\.\s*$/, "")}. Nothing has been
                      changed.
                    </div>
                  ) : !opps.length ? (
                    <div className="rfdhint">
                      {picked.name} has no case you can see. If they are a brand
                      new enquiry, switch to <b>New enquiry</b> above — that
                      creates one.
                    </div>
                  ) : (
                    <div className="rfhits">
                      {opps.map((o) => (
                        <button
                          type="button"
                          key={o.id}
                          className={`rfhit${chosenOpp === o.id ? " on" : ""}`}
                          onClick={() => setChosenOpp(o.id)}
                        >
                          <span className="n">{o.name}</span>
                          <span className="m">
                            {[o.pipelineName, o.stage, o.status]
                              .filter(Boolean)
                              .join(" · ")}
                            {/* ⚠️ ALREADY CREDITED — SAID, NOT SILENTLY
                                OVERWRITTEN. Attribution is one field; choosing
                                this replaces whoever holds it now. */}
                            {o.partnerId
                              ? o.partnerId === partner.id
                                ? ` · already credited to ${partner.org}`
                                : " · ⚠️ already credited to another partner — this replaces it"
                              : ""}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : q.trim().length >= 2 ? (
                /* 🔴 ROUND 125 — THE THREE NON-LIST STATES ARE OUT OF `.rfhits`.
                   //
                   MEASURED, not guessed: the failure message rendered at y=532
                   inside a container whose content box starts at y=540. It was
                   EIGHT PIXELS ABOVE ITS OWN SCROLL BOX, and an `overflow-y:auto`
                   element cannot paint above its content box — so the top of the
                   first line was cut off, which is exactly what the screen showed.
                   //
                   The -8px came from `.rfmodal .rfdhint{margin:-8px 0 14px}`,
                   which exists to tuck a hint up under the field it explains.
                   That is right for a hint after an `.irow` and wrong for the
                   first child of a scrolling box.
                   //
                   ⚠️ AND THE REAL FIX IS STRUCTURAL, NOT A MARGIN OVERRIDE.
                   `.rfhits` is a SCROLLING LIST OF HITS. Searching…, the failure
                   and "no matches" are not hits — they are one line each, they
                   must never scroll, and they must never be clipped. Putting them
                   outside it means no future margin can clip them either. */
                <>
                  {searching ? (
                    <div className="rfdhint">Searching…</div>
                  ) : searchErr ? (
                    <div className="rfdhint rfdbad rfsearchfail">
                      {/* ⚠️ THE TRAILING FULL STOP IS STRIPPED. apiFetch's
                          message already ends in one ("…then reload."), and this
                          sentence added another: "…then reload.. Do not switch". */}
                      The contact search failed — {searchErr.replace(/\.\s*$/, "")}. Do{" "}
                      <b>not</b> switch to New enquiry to get past it: that would
                      create a duplicate of someone who already exists.
                    </div>
                  ) : !hits.length ? (
                    <div className="rfdhint">
                      No contact matches “{q.trim()}”.
                    </div>
                  ) : (
                    <div className="rfhits">
                      {hits.map((h) => (
                        <button
                          type="button"
                          className="rfhit"
                          key={h.id}
                          onClick={() => setPicked({ id: h.id, name: h.name })}
                        >
                          <span className="n">{h.name}</span>
                          <span className="m">
                            {[h.email, h.phone].filter(Boolean).join(" · ") ||
                              "no email or phone"}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="rfdhint">
                  Type at least two characters. Nothing is created on this path
                  — the only change is who the case is credited to.
                </div>
              )}
            </>
          ) : null}

          {/* ⚠️ THE CREATE FIELDS BELONG TO THE CREATE PATH. Asking for a name
              and a phone while attributing an existing case would be collecting
              values with nowhere to go — the mistake round 113 item H fixed on
              "+ Add partner". */}
          {partner && mode === "existing" ? null : (
          <>
          {/* 🔴 ROUND 117 · ITEM 1 — the same headings the other three now
              carry. `.rfglab` separates itself, so a form whose blocks are
              conditional gains grouping without being re-nested. */}
          <div className="rfglab">Who the referral is for</div>
          {/* Two short fields, one line. See `.irow2`. */}
          <div className="irow2">
            <div>
              <label htmlFor="rr-first">Client or family name</label>
              <input id="rr-first" value={firstName} onChange={(e) => setFirst(e.target.value)} />
            </div>
            <div>
              <label htmlFor="rr-last">Last name</label>
              <input id="rr-last" value={lastName} onChange={(e) => setLast(e.target.value)} />
            </div>
          </div>
          <div className="irow2">
            <div>
              <label htmlFor="rr-phone">Phone</label>
              <input
                id="rr-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(484) 555-0142"
              />
            </div>
            <div>
              <label htmlFor="rr-email">Email</label>
              <input
                id="rr-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="family@example.com"
              />
            </div>
            {/* 🔴 ROUND 167 — WHY, NOT JUST "REQUIRED". A referral nobody can
                ring or email is a record that looks workable and is not, and
                it sits in the pipeline being counted. Round 166 found that
                GoHighLevel refuses the contact anyway — "Pass at least one of
                number, email query parameter", about an endpoint the rep never
                called — and left the decision open; this is the decision. */}
            {!phone.trim() && !email.trim() ? (
              <div className="rfdhint rfdbad">
                ⚠️ Add a phone number or an email — we need a way to reach them.
              </div>
            ) : null}
            {/* 🔴 A REP INPUT, NOT A READ-OUT — AND IT IS GIVEN WEIGHT.
                The brief is explicit: the rep types the estimated monthly value
                at referral time, and it must not be presented as a read-only
                system number. It is stored in the native monetaryValue, which is
                why every figure in this view is labelled /mo. */}
            <div className="rfvalue">
              <label htmlFor="rr-value">Estimated monthly value</label>
              <div className="rfvaluebox">
                <span className="rfvaluecur">$</span>
                <input
                  id="rr-value"
                  type="number"
                  min={0}
                  step={100}
                  value={monthly}
                  onChange={(e) => setMonthly(e.target.value)}
                  placeholder="6000"
                />
                <span className="rfvaluemo">/mo</span>
              </div>
              <div className="rfdhint">
                A rough figure is fine. It can be corrected when the assessment
                is done.
              </div>
            </div>
          </div>

          <div className="irow">
            <label htmlFor="rr-note">What was said</label>
            <textarea
              id="rr-note"
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Discharge planner called. Mother post-fall, needs 20h a week starting next Monday."
            />
          </div>

          <div className="rfglab">Where it goes</div>
          <div className="irow">
            <label htmlFor="rr-pipe">File in</label>
            <select
              id="rr-pipe"
              value={pipelineId}
              onChange={(e) => setPipelineId(e.target.value)}
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.stage ? ` · ${p.stage}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="rfdhint">
            {dest ? (
              <>
                Creates an opportunity in <b>{dest.name}</b>
                {dest.stage ? (
                  <>
                    {" "}
                    at <b>{dest.stage}</b>
                  </>
                ) : (
                  ""
                )}
                , attributed to{" "}
                <b>{partner ? partner.org : event ? event.name : "no source"}</b>
                {partner && event ? ` (met at ${event.name})` : ""}.{" "}
                {(partner?.division || event?.division)
                  ? `Defaulted from the ${partner?.division || event?.division} division.`
                  : "No division is set on the source, so the default is Private Pay."}
              </>
            ) : withheld > 0 ? (
              /* 🔴 TASK 2 · §1 — THE SENTENCE THAT WAS FALSE. This read "There
                 is no client pipeline CONFIGURED to file this in" for both
                 empty states. On an account with three client pipelines and a
                 viewer holding no grant, every word of it was wrong, and it
                 sent them to look for a configuration problem that did not
                 exist — the "0 of 2 that meant a filter, not an absence"
                 failure, written before the filter it now describes.

                 ⚠️ IT NAMES A COUNT AND NOT THE PIPELINES. Naming them is the
                 disclosure this whole section closes. */
              <>
                You do not have access to any pipeline a referral can be filed
                in. {withheld === 1 ? "One exists" : `${withheld} exist`} on this
                account — ask an admin to grant you one on{" "}
                <b>Admin → Access</b>.
              </>
            ) : (
              "There is no client pipeline configured to file this in."
            )}
          </div>
          {/* 🔴 ROUND 126 — A GUESSED STAGE SAYS SO. `entryStage` falls back only
              when no stage reads as a new enquiry AND every stage reads as a
              transfer; that is rare, and it is precisely the case where filing
              a new referral asserts it came from another agency. */}
          {dest?.stageFellBack ? (
            <div className="rfdhint rfdbad">
              ⚠️ <b>{dest.name}</b> has no stage that reads as a new enquiry —{" "}
              {dest.stageWhy}. It will be filed at <b>{dest.stage}</b>, which
              may say this case came from somewhere it did not. Add or rename a
              first stage in GoHighLevel.
            </div>
          ) : null}
          {/* ⚠️ WHO WORKS IT IS NOT ASKED, AND THAT IS THE ANSWER TO (a).
              Option (b): the pipeline's notification workflow decides. One place
              owns that decision and it already works, so this form sends no
              owner at all. Credit for the business is a different question, and
              it is already answered by the partner's own Owner column. */}
          <div className="rfdhint">
            Who works the case is decided by the pipeline&apos;s notification
            workflow in GoHighLevel, not here.{" "}
            {partner ? `${partner.org} is` : "The source is"} credited either
            way.
          </div>
          {event && !partner ? (
            <div className="rfdhint">
              ⚠️ This event has no host partner, so the referral is attributed to
              the <b>event</b> alone. Nobody&apos;s partner scorecard changes —
              the event&apos;s Clients and Revenue do.
            </div>
          ) : null}

          </>
          )}

          {err ? <ErrorMessage error={err} className="savemsg err" /> : null}
          {done ? <div className="savemsg ok">{done}</div> : null}
        </div>
        <div className="moveacts">
          <button type="button" className="ighost" onClick={onClose}>
            Cancel
          </button>
          {/* 🔴 THE ACTION NAMES ITSELF. Attributing is not logging: nothing is
              created, so a button reading "Log referral" would describe the
              other path. */}
          {partner && mode === "existing" ? (
            <button
              type="button"
              className="cgsave"
              onClick={() => void attribute()}
              disabled={busy || !chosenOpp || !refField}
            >
              {busy ? "Attributing…" : "Credit this case"}
            </button>
          ) : (
            <button
              type="button"
              className="cgsave"
              onClick={() => void save()}
              // 🔴 ROUND 167 — A WAY TO REACH THEM IS REQUIRED. The route
              // refuses it too, with the same sentence; this end is what stops
              // a rep filling in the whole form to be told no at the bottom.
              disabled={
                busy ||
                !firstName.trim() ||
                (!phone.trim() && !email.trim()) ||
                !dest ||
                (!partner && !event)
              }
            >
              {busy ? "Saving…" : "Log referral"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ADD SOMEONE YOU MET
//
// 🔴 A FIRST NAME OR A PHONE IS REQUIRED. The brief's three fields (profile,
// outcome, note) would have created a contact with no identifying detail:
// GoHighLevel may refuse it, and if it does not, the record is UNDEDUPABLE —
// the same person met at two events becomes two contacts for ever.
//
// ⚠️ BULK IMPORT IS THE REAL ANSWER for an expo where 34 people were met. This
// form is for the one you remember afterwards, and it says so.
// ---------------------------------------------------------------------------
// ═══════════════════════════════════════════════════════════════════════════
// ROUND 171 · ITEM 4 — THE SHARED PIECES OF "this person already exists".
//
// 🔴 ONE RENDERING OF THE SERVER'S SENTENCE, NOT ONE PER DIALOG. The wording
// is the owner's and it is composed server-side (lib/peopleSearch.ts) so that
// every path says the same thing; re-wording it here per dialog is how five
// forms end up with five answers to one question.
// ═══════════════════════════════════════════════════════════════════════════
export interface PersonHit {
  id: string;
  name: string;
  email: string;
  phone: string;
  recordType: string;
  /** 🔴 FALSE MEANS "NOT SHOWN", NOT "NONE". See ContactHit.fieldsKnown. */
  roleKnown: boolean;
  caseLabel: string;
}

interface ConflictInfo {
  sentence: string;
  detail: string;
  person: PersonHit;
}

/** What to print under a name: their role and their case, or why we can't. */
function describePerson(h: PersonHit): string {
  const role = h.roleKnown ? h.recordType || "no role" : "role not shown";
  return [role, h.caseLabel].filter(Boolean).join(" · ");
}

/**
 * Pull the 409 the server sends when a "new" person already exists.
 *
 * ⚠️ READ OFF THE BODY, NOT OFF THE MESSAGE. ApiError joins error and detail
 * into one string for display; the structured `existing` object is what the
 * "Record them" button needs, and parsing it back out of prose would be a
 * second encoding of the same fact.
 */
function conflictOf(e: unknown): ConflictInfo | null {
  if (!(e instanceof ApiError) || e.status !== 409 || !e.body) return null;
  try {
    const j = JSON.parse(e.body) as {
      error?: string;
      detail?: string;
      existing?: {
        id?: string;
        name?: string;
        recordType?: string;
        caseLabel?: string;
      };
    };
    if (!j.existing?.id) return null;
    return {
      sentence: j.error || "",
      detail: j.detail || "",
      person: {
        id: j.existing.id,
        name: j.existing.name || "",
        email: "",
        phone: "",
        recordType: j.existing.recordType || "",
        // The server READ their Record Type on this path, so an empty string
        // here is a measured absence rather than an unseen one.
        roleKnown: true,
        caseLabel: j.existing.caseLabel || "",
      },
    };
  } catch {
    return null;
  }
}

function ConflictNotice({
  info,
  onUse,
}: {
  info: ConflictInfo;
  onUse: (id: string, person: PersonHit) => void;
}) {
  return (
    <div className="pmconflict">
      <b>{info.sentence}</b>
      {info.detail ? <div className="pmmeta">{info.detail}</div> : null}
      <div className="pmconflictacts">
        <button
          type="button"
          className="cgsave"
          onClick={() => onUse(info.person.id, info.person)}
        >
          Record {info.person.name || "them"}
        </button>
        <span className="pmmeta">
          …or change the number above and add a different person.
        </span>
      </div>
    </div>
  );
}

function AddAttendeeDialog({
  ssoBlob,
  event,
  outcomes,
  linkable,
  onClose,
  onAdded,
}: {
  ssoBlob: string | null;
  event: RawEvent;
  outcomes: string[];
  /** False when no Event Attended field exists — they cannot be attributed. */
  linkable: boolean;
  onClose: () => void;
  onAdded: (saved?: RawAttendee) => void;
}) {
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [phone, setPhone] = useState("");
  const [profile, setProfile] = useState("");
  const [outcome, setOutcome] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState("");
  // ═══ 🔴 ROUND 171 · ITEM 4 — TWO MODES, LIKE "Log a referral" ════════════
  //
  // A "new person" form that silently merged onto whoever shared the phone
  // number is how an existing caregiver got renamed and relabelled by a
  // dialog that only ever said "Add person". The modes make the choice
  // explicit, and the conflict below makes it explicit even when the user
  // did not know there was one.
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [pq, setPq] = useState("");
  const [people, setPeople] = useState<PersonHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<PersonHit | null>(null);
  /** The server's "this number belongs to…" answer. Nothing was written. */
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);

  useEffect(() => {
    if (mode !== "existing") return;
    const q = pq.trim();
    if (q.length < 2) {
      setPeople([]);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const j = await apiFetch<{ people?: PersonHit[] }>(
          `/api/referrals?only=people&q=${encodeURIComponent(q)}`,
          { ssoBlob },
        );
        if (live) setPeople(j.people || []);
      } catch {
        /* a transient search failure must not take the dialog down */
      } finally {
        if (live) setSearching(false);
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [pq, mode, ssoBlob]);

  const canSave =
    (mode === "existing" ? !!picked : !!(firstName.trim() || phone.trim())) && !busy;

  const save = async (useId?: string) => {
    setBusy(true);
    setErr(null);
    setConflict(null);
    setDone("");
    const existingId = useId ?? (mode === "existing" ? picked?.id : "");
    try {
      const j = await apiFetch<{ skipped?: string[]; noteSaved: boolean; contactId?: string }>("/api/referrals", {
        method: "POST",
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          action: "add-attendee",
          eventId: event.id,
          // 🔴 ON THE EXISTING PATH NO NAME, PHONE OR EMAIL IS SENT AT ALL.
          // Not "sent and ignored by the server" — not sent. A field that
          // travels is a field some future handler can decide to use.
          ...(existingId
            ? { contactId: existingId }
            : {
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                phone: phone.trim(),
              }),
          profile: profile.trim(),
          outcome,
          text: text.trim(),
        }),
      });
      setDone(
        j.skipped?.length
          ? `Added. Not saved on this account: ${j.skipped.join("; ")}.`
          : "Added.",
      );
      // 🔴 ROUND 175 · ITEM 3 — the attendee list is a CONTACT search too, so
      // it lags the same way. Hand the row up rather than only asking for a
      // reload that cannot yet see it.
      onAdded(
        j.contactId
          ? {
              id: j.contactId,
              name: existingId
                ? picked?.name || "Recorded person"
                : `${firstName.trim()} ${lastName.trim()}`.trim() || phone.trim(),
              eventId: event.id,
              outcome,
              profile: profile.trim(),
              version: "",
            }
          : undefined,
      );
      setTimeout(onClose, j.skipped?.length ? 3200 : 1200);
    } catch (e) {
      const c = conflictOf(e);
      if (c) setConflict(c);
      else setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="previewmodal" onClick={onClose}>
      <div className="movebox addbox cgadd" onClick={(e) => e.stopPropagation()}>
        <div className="previewhead">
          <span className="previewname">Add someone you met · {event.name}</span>
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="movebody">
          <div className="rfdhint">
            <b>Bulk import is the real answer here.</b> For an expo where thirty
            people were met, import the list. This form is for the one you
            remember afterwards.
          </div>

          {/* ═══ 🔴 ROUND 171 · ITEM 4 — WHICH PERSON IS THIS? ═══════════════
              Somebody met at an expo is very often already on the account: a
              caregiver who came to recruit, a partner's staffer, a family
              member of a current client. Recording them as "new" is what
              renamed and relabelled them. */}
          <div className="pmmodes" role="group" aria-label="Who are you adding?">
            <button
              type="button"
              className={`pmmode${mode === "new" ? " on" : ""}`}
              aria-pressed={mode === "new"}
              onClick={() => { setMode("new"); setConflict(null); }}
            >
              New person
            </button>
            <button
              type="button"
              className={`pmmode${mode === "existing" ? " on" : ""}`}
              aria-pressed={mode === "existing"}
              onClick={() => { setMode("existing"); setConflict(null); }}
            >
              Someone already in GoHighLevel
            </button>
          </div>

          {mode === "existing" ? (
            <>
              <div className="irow">
                <label htmlFor="ra-find">Find them</label>
                <input
                  id="ra-find"
                  value={pq}
                  onChange={(e) => { setPq(e.target.value); setPicked(null); }}
                  placeholder="Name, phone or email…"
                />
              </div>
              {picked ? (
                <div className="pmpicked">
                  <b>{picked.name}</b>
                  <span className="pmmeta">{describePerson(picked)}</span>
                  <button type="button" className="ighost" onClick={() => setPicked(null)}>
                    Change
                  </button>
                </div>
              ) : searching ? (
                <div className="rfdhint">Searching…</div>
              ) : pq.trim().length >= 2 && !people.length ? (
                <div className="rfdhint">
                  Nobody matches. GoHighLevel&rsquo;s search takes about a
                  minute to show a contact created moments ago, so a brand-new
                  one may not be findable yet.
                </div>
              ) : people.length ? (
                <div className="pmhits">
                  {people.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      className="pmhit"
                      onClick={() => setPicked(h)}
                    >
                      <span className="pmhitname">{h.name}</span>
                      <span className="pmmeta">{describePerson(h)}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="rfdhint">
                Their name, phone, email and <b>Record Type</b> are left exactly
                as they are. Only the event, who they were and the outcome are
                written.
              </div>
            </>
          ) : (
            <>
              {/* 🔴 THE IDENTITY REQUIREMENT, AND WHY IT IS NOT OPTIONAL. */}
              <div className="irow">
                <label htmlFor="ra-first">First name</label>
                <input id="ra-first" value={firstName} onChange={(e) => setFirst(e.target.value)} />
                <label htmlFor="ra-last">Last name</label>
                <input id="ra-last" value={lastName} onChange={(e) => setLast(e.target.value)} />
              </div>
              <div className="irow">
                <label htmlFor="ra-phone">Phone</label>
                <input
                  id="ra-phone"
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              <div className="rfdhint">
                A first name <b>or</b> a phone number is required. Without one there
                is no way to recognise this person the next time they are met, and
                they would be added a second time instead.
              </div>
              {/* 🔴 GoHighLevel KEEPS ONLY THE FIRST WORD AS THE FIRST NAME —
                  round 170, measured. Said before the save, not after. */}
              <div className="rfdhint">
                GoHighLevel keeps only the first word as the first name, so
                &ldquo;Mary Ann&rdquo; is stored as &ldquo;Mary&rdquo; with
                &ldquo;Ann&rdquo; moved to the last name.
              </div>
            </>
          )}

          {conflict ? <ConflictNotice info={conflict} onUse={(id, p) => { setMode("existing"); setPicked(p); setConflict(null); void save(id); }} /> : null}

          <div className="irow">
            <label htmlFor="ra-prof">Who they were</label>
            <input
              id="ra-prof"
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              placeholder="Adult daughter, mother in Springfield"
            />
          </div>
          <div className="irow">
            <label htmlFor="ra-out">Outcome</label>
            <select id="ra-out" value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="">Not set</option>
              {outcomes.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          <div className="rfdhint">
            This is the countable field. Set it now while you remember, or the
            event can never be scored.
          </div>

          <div className="irow">
            <label htmlFor="ra-note">Note</label>
            <textarea
              id="ra-note"
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"MET:\nSITUATION:\nNEXT STEP:"}
            />
          </div>

          {!linkable ? (
            <div className="rfdhint">
              ⚠️ They will be created, but <b>not linked to this event</b>: no{" "}
              <b>Event Attended</b> field exists on the contact yet, so nothing
              can record which event they were met at.
            </div>
          ) : null}

          {err ? <ErrorMessage error={err} className="savemsg err" /> : null}
          {done ? <div className="savemsg ok">{done}</div> : null}
        </div>
        <div className="moveacts">
          <button type="button" className="ighost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="cgsave"
            onClick={() => void save()}
            disabled={!canSave}
          >
            {busy ? "Saving…" : mode === "existing" ? "Record them" : "Add person"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ADD AN EVENT — 🔴 THE ONLY WRITER OF `Event Host`.
//
// Created from a partner's panel because that is what the field records: which
// organisation ran this event. Without a writer the field exists, nothing sets
// it, "Run by [ partner ]" never resolves, and the drawer's "Events worked"
// section is permanently empty — the same dead end `Event Source` was in.
//
// ⚠️ THE HOST IS ALSO THE CONTACT. GoHighLevel attaches every opportunity to a
// contact, and for an event the honest answer is the organisation running it —
// so no placeholder contact is invented.
// ---------------------------------------------------------------------------
function AddEventDialog({
  ssoBlob,
  partner,
  divisions,
  divisionsAreEventsOwn,
  hostFieldPresent,
  onClose,
  onAdded,
}: {
  ssoBlob: string | null;
  partner: EnrichedPartner;
  divisions: string[];
  /**
   * 🔴 ROUND 128 — true when these are `Event Division`'s OWN options.
   *
   * False means that field is not a picklist on this account, so the list shown
   * is `Partner Division`'s — a reasonable stand-in and NOT the same field. The
   * dialog says which, because "these values may not be the ones this field
   * accepts" is exactly the kind of thing that is invisible until a value
   * silently fails to save.
   */
  divisionsAreEventsOwn?: boolean;
  /** False → the event is created but nothing records who ran it. Said, not hidden. */
  hostFieldPresent: boolean;
  onClose: () => void;
  onAdded: (saved?: RawEvent) => void;
}) {
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [venue, setVenue] = useState("");
  const [cost, setCost] = useState("");
  const [div, setDiv] = useState(partner.division || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState("");

  const save = async () => {
    setBusy(true);
    setErr(null);
    setDone("");
    try {
      const j = await apiFetch<{ pipelineName: string; skipped?: string[]; eventId?: string }>(
        "/api/referrals",
        {
          method: "POST",
          body: JSON.stringify({
            ssoKey: ssoBlob ?? undefined,
            action: "add-event",
            org: name.trim(),
            partnerId: partner.id,
            eventDate: date,
            venue: venue.trim(),
            cost: Number(cost) || 0,
            division: div,
          }),
        },
      );
      setDone(
        `Saved: ${name.trim()} — added to ${j.pipelineName}, run by ${partner.org}.` +
          (j.skipped?.length ? ` Not saved on this account: ${j.skipped.join("; ")}.` : ""),
      );
      // 🔴 ROUND 175 · ITEM 3 — the Events tab is an OPPORTUNITY search, which
      // lags a brand-new opportunity the same way the contact search lags a new
      // contact. Hand the row up.
      onAdded(
        j.eventId
          ? {
              id: j.eventId,
              name: name.trim(),
              // ⚠️ THE ENTRY STAGE IS NOT GUESSED HERE. The row carries "" and
              // the reload fills it in; inventing a stage name would put a word
              // on screen that no pipeline necessarily has.
              stage: "",
              date,
              cost: Number(cost) || 0,
              venue: venue.trim(),
              division: div,
              host: partner.id,
            }
          : undefined,
      );
      setTimeout(onClose, j.skipped?.length ? 3200 : 1400);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="previewmodal" onClick={onClose}>
      <div className="movebox addbox cgadd rfmodal" onClick={(e) => e.stopPropagation()}>
        <div className="previewhead">
          <span className="previewname">Add an event · run by {partner.org}</span>
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="movebody">
          {/* 🔴 ROUND 117 · ITEM 1 — two groups, short fields paired, and the
              cost hint moved ABOVE the field it explains. */}
          <div className="rfgroup">
            <div className="rfglab">The event</div>
            <div className="irow">
              <label htmlFor="re-name">Event name</label>
              <input
                id="re-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Delco Senior Expo"
              />
            </div>
            <div className="irow2">
              <div>
                {/* 🔴 ROUND 124 · ITEM 1 — THE VENUE IS NOW THE CONTACT, so it
                    is required rather than decorative. It was already asked
                    for; what changed is what it does. */}
                <label htmlFor="re-venue">Venue *</label>
                <input
                  id="re-venue"
                  value={venue}
                  onChange={(e) => setVenue(e.target.value)}
                  placeholder="Delco Expo Centre"
                />
              </div>
              <div>
                <label htmlFor="re-date">Date</label>
                <input id="re-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            </div>
          </div>
          <div className="rfgroup">
            <div className="rfglab">What it cost, and whose it is</div>
            {/* 🔴 WHAT THE COST IS FOR. It is not bookkeeping — it is the
                numerator of cost per legitimate lead, which is the only number
                that says whether an expo was worth going to. A blank cost does
                not make an event look cheap; it makes it uncountable. */}
            <div className="rfdhint">
              <b>Cost drives cost per legitimate lead</b> — the whole spend
              divided by the referrals this event actually produced. Include the
              booth, the travel and the materials; a round figure is fine, and it
              can be corrected later. ⚠️ Leaving it empty does not read as free,
              it drops the event out of that calculation entirely.
            </div>
            <div className="irow2">
              <div>
                <label htmlFor="re-cost">Cost</label>
                <input
                  id="re-cost"
                  type="number"
                  min={0}
                  step={50}
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  placeholder="450"
                />
              </div>
              <div>
                <label htmlFor="re-div">Division *</label>
                <select id="re-div" value={div} onChange={(e) => setDiv(e.target.value)}>
                  {/* 🔴 ROUND 167 — "Not set" IS GONE. It used to be the
                      default, and an event saved with no division is shown to
                      EVERY viewer (inDivision), which is how one OLTL event put
                      "OLTL" on an ODP-only viewer's heading. Round 143 made the
                      same field required on a partner for the same reason; the
                      event dialog was simply never brought into line. */}
                  <option value="">Choose a division…</option>
                  {divisions.map((d) => (
                    <option key={d} value={d}>
                      {d === "All" ? "All — appears under every division" : d}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {/* 🔴 ROUND 167 — REQUIRED, AND THE HINT SAYS WHAT HAPPENS WITHOUT
                IT rather than only that it is needed. Same wording as the
                partner dialog's, because it is the same consequence. */}
            {!div ? (
              <div className="rfdhint rfdbad">
                ⚠️ Required. An event with no division is shown to everybody,
                whichever division they work in.
              </div>
            ) : null}
            {/* ⚠️ ROUND 167 · C10 — AN EMPTY LIST IS ITS OWN SENTENCE. A viewer
                whose referral access covers no division gets no options, and a
                picker that is simply empty reads as a broken dropdown. */}
            {!divisions.length ? (
              <div className="rfdhint rfdbad">
                ⚠️ Your referral access covers no divisions, so there is nothing
                you could file this event under and still see it. Ask an admin on{" "}
                <b>Admin → Access</b>.
              </div>
            ) : null}
            {divisionsAreEventsOwn === false ? (
              <div className="rfdhint">
                ⚠️ <b>Event Division</b> is not a dropdown on this account, so
                these are <b>Partner Division</b>&apos;s values. They are the
                right shape, but they are a different field&apos;s list — if one
                of them does not stick, that is why.
              </div>
            ) : null}
            <div className="rfdhint">
              ⚠️ Event cost is a <b>one-off</b> — a booth is paid once — so it is
              never shown as a monthly figure, unlike referral value.
            </div>
          </div>
          {/* 🔴 ROUND 124 · ITEM 1 — SAY WHAT THE VENUE NOW DOES, because it
              creates a contact record and somebody should not discover that
              afterwards. */}
          <div className="rfdhint">
            Creates an opportunity in the Events pipeline attached to{" "}
            <b>{venue.trim() || "the venue"}</b> as a contact, with{" "}
            <b>{partner.org}</b> recorded as the host — so it appears under
            &ldquo;Events worked&rdquo; on their panel and as &ldquo;Run
            by&rdquo; on the event card.
          </div>
          <div className="rfdhint">
            ⚠️ <b>The venue is the contact, not the partner.</b> GoHighLevel
            allows one opportunity per contact per pipeline, so attaching events
            to the partner meant a partner could host exactly one event ever.
            The venue becomes a contact record — a real place with a real name —
            and {partner.org} can host as many as they like.
          </div>
          <div className="rfdhint">
            ⚠️ One event per venue, though: a second event at the same venue is
            refused, and the fix is to name it distinctly —{" "}
            <b>{(venue.trim() || "Delco Expo Centre") + " (Spring)"}</b>.
          </div>
          {!hostFieldPresent ? (
            <div className="rfdhint">
              ⚠️ There is no <b>Event Host</b> field on this account, so the event
              will be created but <b>nothing will record who ran it</b> — it will
              not appear under this partner&apos;s Events worked.
            </div>
          ) : null}
          {err ? <ErrorMessage error={err} className="savemsg err" /> : null}
          {done ? <div className="savemsg ok">{done}</div> : null}
        </div>
        <div className="moveacts">
          <button type="button" className="ighost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="cgsave"
            onClick={() => void save()}
            // 🔴 ROUND 167 — `!div` ADDED, matching the partner dialog's Save
            // guard exactly (round 143). The server refuses it too; this end is
            // what stops somebody reaching the refusal by accident.
            disabled={busy || !name.trim() || !venue.trim() || !div}
          >
            {busy ? "Saving…" : "Add event"}
          </button>
        </div>
      </div>
    </div>
  );
}
