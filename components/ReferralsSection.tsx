"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiFetch } from "@/lib/apiFetch";
import {
  CADENCE,
  DUE_SOON_DAYS,
  DIVISIONS,
  TIERS,
  OUTCOMES,
  PARTNER_CATEGORIES,
  inDivision,
  enrichPartner,
  eventStats,
  partnerKpis,
  eventKpis,
  partnerEvents,
  danglingReferrals,
  TOUCH_TYPES,
  type Division,
  type EnrichedPartner,
  type RawPartner,
  type RawReferral,
  type RawEvent,
  type RawAttendee,
} from "@/lib/referrals";

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
}

interface Payload {
  partners: RawPartner[];
  referrals: RawReferral[];
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
  outcomeOptions: string[];
  clientPipelines: PipelineChoice[];
  meta: {
    eventHostField: string;
    outcomeField: string;
    eventsPipelineConfigured: boolean;
    eventsPipelineName: string;
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
const divLabel = (d: Division) => (d === "All" ? "All divisions" : d);

function TierBadge({ t }: { t: string }) {
  const cls = t === "Prospect" ? "prospect" : t.toLowerCase();
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

export default function ReferralsSection({
  ssoBlob,
  ssoReady,
  reloadToken,
  onBusy,
}: {
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
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<unknown>(null);

  const [division, setDivision] = useState<Division>("All");
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
  const [sortKey, setSortKey] = useState<keyof EnrichedPartner>("priority");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const [openId, setOpenId] = useState<string | null>(null);
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

  // ── loading ──────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    onBusy(true);
    setErr(null);
    try {
      // touch=auto measures the first batch of partners in the SAME request.
      // A second round trip for it would have shown a complete-looking queue
      // with every partner "never contacted" for as long as it took to arrive.
      const j = await apiFetch<Payload>("/api/referrals?touch=auto", { ssoBlob });
      setData(j);
    } catch (e) {
      setErr(e);
    } finally {
      setLoading(false);
      onBusy(false);
    }
  }, [ssoBlob, onBusy]);

  // Mounted only while the Referrals section is open, so this is also what
  // keeps the section from costing anything for someone who never opens it.
  //
  // ⚠️ AND IT WAITS. Firing before the handshake settles sent a null blob, got
  // a 401, drew the full-page error card, then reloaded when the blob arrived —
  // an error state on every single entry, plus a wasted round trip.
  useEffect(() => {
    if (!ssoReady) return;
    void load();
  }, [reloadToken, load, ssoReady]);

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

  /** Measure the next batch of partners whose last touch is still unknown. */
  const measureMore = useCallback(async () => {
    if (!data) return;
    setMoreBusy(true);
    setMoreNote("");
    try {
      const ids = data.partners.filter((p) => p.lastTouch == null).map((p) => p.id);
      const j = await apiFetch<{
        touch: Record<string, number>;
        meta: { touchResolved: number; touchFailed: number; touchCapped: number };
      }>(`/api/referrals?only=touch&touchFor=${encodeURIComponent(ids.join(","))}`, {
        ssoBlob,
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
  }, [data, ssoBlob]);

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
        const j = await apiFetch<{ version?: string }>(
          `/api/contacts/${encodeURIComponent(a.id)}/fields`,
          {
            method: "PATCH",
            ssoBlob,
            body: JSON.stringify({
              ssoKey: ssoBlob ?? undefined,
              ...(a.version ? { expectedVersion: a.version } : {}),
              fields: [{ id: field, value }],
            }),
          },
        );
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

  // ── the division cut. Everything below reads from here ───────────────────
  const all = useMemo<EnrichedPartner[]>(() => {
    if (!data) return [];
    return data.partners
      .filter((p) => inDivision(p.division, division))
      .map((p) => enrichPartner(p, data.referrals));
  }, [data, division]);

  const kpis = useMemo(() => partnerKpis(all), [all]);

  const events = useMemo(
    () => (data ? data.events.filter((e) => inDivision(e.division, division)) : []),
    [data, division],
  );
  const evKpis = useMemo(
    () => eventKpis(events, data?.attendees || []),
    [events, data],
  );

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

  const cats = useMemo(() => {
    const s = new Set<string>();
    all.forEach((p) => p.cat && s.add(p.cat));
    return [...s].sort();
  }, [all]);

  const dangling = useMemo(
    () => (data ? danglingReferrals(data.referrals, data.partners) : 0),
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
  const caveats: string[] = [];
  if (data) {
    if (kpis.unknown)
      caveats.push(
        `${kpis.unknown} partner${kpis.unknown === 1 ? "'s" : "s'"} last contact has not been measured yet, so ${kpis.unknown === 1 ? "it is" : "they are"} excluded from Overdue, Due this week and the queue.`,
      );
    if (kpis.undatedRefs)
      caveats.push(
        `${kpis.undatedRefs} referral${kpis.undatedRefs === 1 ? " has" : "s have"} no creation date in GoHighLevel, so ${kpis.undatedRefs === 1 ? "it is" : "they are"} counted in lifetime referrals but not in any 90-day figure.`,
      );
    if (dangling)
      caveats.push(
        `${dangling} referral${dangling === 1 ? " points" : "s point"} at a partner that no longer exists, so ${dangling === 1 ? "its" : "their"} revenue is attributed to nobody.`,
      );
    if (data.meta.partnersTruncated)
      caveats.push(
        "GoHighLevel returned more partners than one request can carry — this is the first page only.",
      );
    if (data.meta.unreadable)
      caveats.push(
        `${data.meta.unreadable} contact${data.meta.unreadable === 1 ? "'s" : "s'"} fields could not be read, so ${data.meta.unreadable === 1 ? "it is" : "they are"} missing from this screen entirely.`,
      );
    if (data.meta.failedPipelines.length)
      caveats.push(
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
          <button
            type="button"
            className="rfdiv"
            aria-haspopup="listbox"
            aria-expanded={divOpen}
            onClick={() => setDivOpen((o) => !o)}
            title="Switch division — everything below changes with it"
          >
            <span className="rfdivname">{divLabel(division)}</span>
            <svg className="rfcar" viewBox="0 0 10 6" aria-hidden="true">
              <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
          {divOpen ? (
            <ul className="rfdivpop" role="listbox" aria-label="Division">
              {DIVISIONS.map((d) => (
                <li key={d} role="option" aria-selected={d === division}>
                  <button
                    type="button"
                    className={d === division ? "on" : ""}
                    onClick={() => {
                      setDivision(d);
                      setDivOpen(false);
                    }}
                  >
                    <span>{divLabel(d)}</span>
                    {d === division ? <span className="rftick">✓</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="rfsub">
            Referral sources, the contact cadence they are owed, and what they
            have sent.{" "}
            {division === "All"
              ? "Every division."
              : `${division}, plus every partner marked "All".`}
          </p>
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

        {caveats.length ? (
          <div className="rfcaveat">
            <b>What these numbers do not include</b>
            <ul>
              {caveats.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
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
              <Kpi
                label="Referrals, 90 days"
                value={kpis.refs90}
                desc="from these sources"
              />
              <Kpi label="Clients won" value={kpis.won} desc="lifetime" />
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

            <div className="panel">
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
                      <th onClick={() => sortBy("org")}>Organisation{caret("org")}</th>
                      <th onClick={() => sortBy("cat")}>Category{caret("cat")}</th>
                      <th onClick={() => sortBy("tier")}>Tier{caret("tier")}</th>
                      <th onClick={() => sortBy("owner")}>Owner{caret("owner")}</th>
                      <th className="num" onClick={() => sortBy("priority")}>
                        Last touch{caret("priority")}
                      </th>
                      <th className="num" onClick={() => sortBy("refs90")}>
                        Refs 90d{caret("refs90")}
                      </th>
                      <th className="num" onClick={() => sortBy("won")}>
                        Clients{caret("won")}
                      </th>
                      <th className="num" onClick={() => sortBy("revenue")}>
                        Revenue /mo{caret("revenue")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {!rows.length ? (
                      <tr>
                        <td colSpan={8}>
                          <div className="empty">
                            <b>
                              {all.length
                                ? "No sources match"
                                : "No referral partners yet"}
                            </b>
                            <br />
                            {all.length
                              ? "Clear a filter, or widen the division above."
                              : 'A partner is a contact whose Record Type is "Referral Partner". Add one to start tracking it.'}
                          </div>
                        </td>
                      </tr>
                    ) : (
                      rows.map((p) => (
                        <tr key={p.id} onClick={() => setOpenId(p.id)}>
                          <td>
                            <div className="rforg">{p.org}</div>
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
              Revenue is the monthly recurring value of won opportunities
              attributed to the source. Showing {rows.length} of {all.length} ·
              total {moneyMo(rows.reduce((a, p) => a + p.revenue, 0))}
            </p>
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
                  ? `Partners you own, plus any nobody owns — ${queue.length} of ${all.length} in ${divLabel(division)}.`
                  : `Every partner in ${divLabel(division)} — ${all.length}.`}
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
              <div className="panel">
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
              <div className="panel">
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
                desc={`of ${evKpis.attendees} people met`}
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

            {!data?.meta.eventsPipelineConfigured ? (
              <div className="rfgap">
                <b>No Events pipeline is configured</b>
                <p>
                  Nothing in the stored pipeline config is scoped to clients and
                  named &ldquo;Events&rdquo;, so there is no pipeline to read
                  events from. Add it in Admin → Pipelines with scope{" "}
                  <b>client</b>. The id is deliberately not hardcoded here.
                </p>
              </div>
            ) : !events.length ? (
              <div className="panel">
                <div className="empty">
                  <b>No events in {divLabel(division)}</b>
                  <br />
                  An event is an opportunity in the{" "}
                  {data?.meta.eventsPipelineName || "Events"} pipeline.
                </div>
              </div>
            ) : (
              <div className="panel">
                {events.map((e) => {
                  const st = eventStats(e, data?.attendees || [], data?.referrals || []);
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
                            {[e.venue, e.stage, e.division || "no division"]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </div>
                        <div className="dt">
                          {e.date || "no date"} · {money(e.cost)} cost
                        </div>
                      </div>
                      <div className="rfstats">
                        {[
                          ["Met", String(st.met)],
                          ["Legit leads", String(st.legit)],
                          ["Partner prospects", String(st.partners)],
                          ["Clients", String(st.clients)],
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
                          <div className="l">Revenue /mo</div>
                          <div className="v">
                            {data?.meta.oppEventField ? moneyMo(st.revenue) : "—"}
                          </div>
                        </div>
                      </div>

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
            {data?.attendees.length ? (
              <>
                <h3 className="rfh3">
                  Everyone met at an event
                  <span className="rfn">{data.attendees.length}</span>
                </h3>
                <div className="panel">
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
                        {data.attendees.map((a) => (
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
                  {data.meta.attendeesTruncated
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
                label="Sources"
                value={kpis.totalSources}
                desc={`${kpis.activeSources} referred in 90 days`}
              />
              <Kpi
                label="Revenue attributed"
                value={moneyMo(kpis.revenue)}
                desc="monthly recurring, from won cases"
              />
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
                  All time, across every source in {divLabel(division)}.
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
          referrals={data?.referrals || []}
          events={data?.events || []}
          attendees={data?.attendees || []}
          hostField={data?.meta.eventHostField || ""}
          onClose={() => setOpenId(null)}
          onLog={() => setLogFor(open)}
          onLogReferral={() => setRefFor({ partner: open })}
          onAddEvent={() => setEventForPartner(open)}
        />
      ) : null}

      {eventForPartner ? (
        <AddEventDialog
          ssoBlob={ssoBlob}
          partner={eventForPartner}
          divisions={data?.divisionOptions.length ? data.divisionOptions : [...DIVISIONS]}
          hostFieldPresent={!!data?.meta.eventHostField}
          onClose={() => setEventForPartner(null)}
          onAdded={() => void load()}
        />
      ) : null}

      {refFor ? (
        <LogReferralDialog
          ssoBlob={ssoBlob}
          partner={refFor.partner}
          event={refFor.event}
          pipelines={data?.clientPipelines || []}
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
          onAdded={() => void load()}
        />
      ) : null}

      {addOpen ? (
        <AddPartnerDialog
          ssoBlob={ssoBlob}
          division={division}
          owners={data?.owners || []}
          categories={data?.categoryOptions.length ? data.categoryOptions : [...PARTNER_CATEGORIES]}
          tiers={data?.tierOptions.length ? data.tierOptions : [...TIERS]}
          divisions={data?.divisionOptions.length ? data.divisionOptions : [...DIVISIONS]}
          onClose={() => setAddOpen(false)}
          onAdded={() => void load()}
        />
      ) : null}

      {logFor ? (
        <LogTouchDialog
          ssoBlob={ssoBlob}
          partner={logFor}
          onClose={() => setLogFor(null)}
          onLogged={(days) => {
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
}: {
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
}) {
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
      `/api/referrals?only=notes&contactId=${encodeURIComponent(p.id)}`,
      { ssoBlob },
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
  }, [p.id, ssoBlob]);

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
      <aside className="rfdrawer" role="dialog" aria-modal="true" aria-label={p.org}>
        <div className="rfdhd">
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
          <h2>{p.org}</h2>
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
              <dt>Revenue attributed</dt>
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
              <dl className="rfkv">
                {shownRows.slice(0, 12).map((o) => (
                  <div key={o.id} className="rfkvrow">
                    <dt>{o.ago === null ? "undated" : `${o.ago} days ago`}</dt>
                    <dd
                      className={
                        o.status === "won"
                          ? "rfgreen"
                          : o.status === "lost"
                            ? "rfred"
                            : ""
                      }
                    >
                      {o.status}
                      {o.value ? ` · ${moneyMo(o.value)}` : ""}
                    </dd>
                  </div>
                ))}
              </dl>
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
      <div className="movebox addbox" onClick={(e) => e.stopPropagation()}>
        <div className="previewhead">
          <span className="previewname">Log a touch · {partner.org}</span>
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="movebody">
          <div className="irow">
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
  onClose: () => void;
  onAdded: () => void;
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
  const [org, setOrg] = useState("");
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [cat, setCat] = useState("");
  const [tier, setTier] = useState<string>("Prospect");
  const [div, setDiv] = useState<string>(division);
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
          if (live) setHits(j.contacts || []);
        })
        .catch(() => {
          if (live) setHits([]);
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
      setDone(
        j.skipped?.length
          ? `${picked?.name || org.trim()} ${verb}. Not saved on this account: ${j.skipped.join("; ")}.`
          : `${picked?.name || org.trim()} ${verb}.`,
      );
      onAdded();
      setTimeout(onClose, j.skipped?.length ? 3200 : 1200);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="previewmodal" onClick={onClose}>
      <div className="movebox addbox cgadd" onClick={(e) => e.stopPropagation()}>
        <div className="previewhead">
          <span className="previewname">Add a referral partner</span>
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="movebody">
          <div className="rfmode">
            <label>
              <input
                type="radio"
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
                <div className="rfhits">
                  {searching ? (
                    <div className="rfdhint">Searching…</div>
                  ) : !hits.length ? (
                    <div className="rfdhint">
                      No contact matches “{q.trim()}”. Switch to <b>New
                      organisation</b> if they are not in GoHighLevel yet.
                    </div>
                  ) : (
                    hits.map((h) => (
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
                    ))
                  )}
                </div>
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
          <div className="irow">
            <label htmlFor="rf-first">Contact first name</label>
            <input id="rf-first" value={firstName} onChange={(e) => setFirst(e.target.value)} />
            <label htmlFor="rf-last">Last name</label>
            <input id="rf-last" value={lastName} onChange={(e) => setLast(e.target.value)} />
          </div>
          <div className="irow">
            <label htmlFor="rf-email">Email</label>
            <input
              id="rf-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label htmlFor="rf-phone">Phone</label>
            <input
              id="rf-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="irow">
            <label htmlFor="rf-cat">Category</label>
            <select id="rf-cat" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">Not set</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
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
          <div className="irow">
            <label htmlFor="rf-div">Division</label>
            <select id="rf-div" value={div} onChange={(e) => setDiv(e.target.value)}>
              {divisions.map((d) => (
                <option key={d} value={d}>
                  {d === "All" ? "All — appears under every division" : d}
                </option>
              ))}
            </select>
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
          {/* ⚠️ THE BRIEF'S OWN HINTS, KEPT. Each one answers a question the
              field otherwise invites: why an organisation and not a person, what
              a tier actually does, and what an owner controls. */}
          <div className="rfdhint">
            <b>Tier sets the contact cadence.</b> A is every 14 days, B monthly,
            C quarterly, prospect every 21. <b>Owner</b> is who holds this
            relationship — it drives who sees it and whose queue it lands in.
          </div>
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
            disabled={busy || (mode === "new" ? !org.trim() : !picked)}
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
  onClose: () => void;
  onLogged: () => void;
}) {
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [phone, setPhone] = useState("");
  const [monthly, setMonthly] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState("");

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
      <div className="movebox addbox cgadd" onClick={(e) => e.stopPropagation()}>
        <div className="previewhead">
          <span className="previewname">
            Log a referral · from {partner ? partner.org : event ? event.name : "—"}
          </span>
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="movebody">
          <div className="rflive">
            <b>Pass-through only.</b> The name and phone go straight to
            GoHighLevel and are never written to this dashboard&apos;s database.
            Only the returned record id and the attribution are kept here.
          </div>

          <div className="irow">
            <label htmlFor="rr-first">Client or family name</label>
            <input id="rr-first" value={firstName} onChange={(e) => setFirst(e.target.value)} />
            <label htmlFor="rr-last">Last name</label>
            <input id="rr-last" value={lastName} onChange={(e) => setLast(e.target.value)} />
          </div>
          <div className="irow">
            <label htmlFor="rr-phone">Phone</label>
            <input
              id="rr-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(484) 555-0142"
            />
          </div>

          {/* 🔴 A REP INPUT, NOT A READ-OUT — AND IT IS GIVEN WEIGHT.
              The brief is explicit: the rep types the estimated monthly value at
              referral time, and it must not be presented as a read-only system
              number. It is stored in the native monetaryValue, which is why
              every figure in this view is labelled /mo. */}
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
              A rough figure is fine. It can be corrected when the assessment is
              done.
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
                {dest.stage ? ` at ${dest.stage}` : ""}, attributed to{" "}
                <b>{partner ? partner.org : event ? event.name : "no source"}</b>
                {partner && event ? ` (met at ${event.name})` : ""}.{" "}
                {(partner?.division || event?.division)
                  ? `Defaulted from the ${partner?.division || event?.division} division.`
                  : "No division is set on the source, so the default is Private Pay."}
              </>
            ) : (
              "There is no client pipeline configured to file this in."
            )}
          </div>
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
            disabled={busy || !firstName.trim() || !dest || (!partner && !event)}
          >
            {busy ? "Saving…" : "Log referral"}
          </button>
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
  onAdded: () => void;
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

  const canSave = !!(firstName.trim() || phone.trim()) && !busy;

  const save = async () => {
    setBusy(true);
    setErr(null);
    setDone("");
    try {
      const j = await apiFetch<{ skipped?: string[]; noteSaved: boolean }>("/api/referrals", {
        method: "POST",
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          action: "add-attendee",
          eventId: event.id,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          phone: phone.trim(),
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
      onAdded();
      setTimeout(onClose, j.skipped?.length ? 3200 : 1200);
    } catch (e) {
      setErr(e);
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
            {busy ? "Saving…" : "Add person"}
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
  hostFieldPresent,
  onClose,
  onAdded,
}: {
  ssoBlob: string | null;
  partner: EnrichedPartner;
  divisions: string[];
  /** False → the event is created but nothing records who ran it. Said, not hidden. */
  hostFieldPresent: boolean;
  onClose: () => void;
  onAdded: () => void;
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
      const j = await apiFetch<{ pipelineName: string; skipped?: string[] }>(
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
        `Added to ${j.pipelineName}, run by ${partner.org}.` +
          (j.skipped?.length ? ` Not saved on this account: ${j.skipped.join("; ")}.` : ""),
      );
      onAdded();
      setTimeout(onClose, j.skipped?.length ? 3200 : 1400);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="previewmodal" onClick={onClose}>
      <div className="movebox addbox cgadd" onClick={(e) => e.stopPropagation()}>
        <div className="previewhead">
          <span className="previewname">Add an event · run by {partner.org}</span>
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="movebody">
          <div className="irow">
            <label htmlFor="re-name">Event name</label>
            <input
              id="re-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Delco Senior Expo"
            />
          </div>
          <div className="irow">
            <label htmlFor="re-date">Date</label>
            <input id="re-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
          <div className="rfdhint">
            ⚠️ Event cost is a one-off — a booth is paid once — so it is never
            shown as a monthly figure, unlike referral value.
          </div>
          <div className="irow">
            <label htmlFor="re-venue">Venue</label>
            <input id="re-venue" value={venue} onChange={(e) => setVenue(e.target.value)} />
            <label htmlFor="re-div">Division</label>
            <select id="re-div" value={div} onChange={(e) => setDiv(e.target.value)}>
              <option value="">Not set</option>
              {divisions.map((d) => (
                <option key={d} value={d}>
                  {d === "All" ? "All — appears under every division" : d}
                </option>
              ))}
            </select>
          </div>
          <div className="rfdhint">
            Creates an opportunity in the Events pipeline with <b>{partner.org}</b>{" "}
            recorded as the host, so it appears under &ldquo;Events worked&rdquo;
            on their panel and as &ldquo;Run by&rdquo; on the event card.
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
            disabled={busy || !name.trim()}
          >
            {busy ? "Saving…" : "Add event"}
          </button>
        </div>
      </div>
    </div>
  );
}
