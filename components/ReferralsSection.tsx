"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiFetch } from "@/lib/apiFetch";
import {
  CADENCE,
  DUE_SOON_DAYS,
  DIVISIONS,
  TIERS,
  PARTNER_CATEGORIES,
  inDivision,
  enrichPartner,
  eventStats,
  partnerKpis,
  eventKpis,
  danglingReferrals,
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

interface Payload {
  partners: RawPartner[];
  referrals: RawReferral[];
  events: RawEvent[];
  attendees: RawAttendee[];
  meta: {
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
  reloadToken,
  onBusy,
}: {
  ssoBlob: string | null;
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

  const [tier, setTier] = useState<string>("all");
  const [cat, setCat] = useState<string>("all");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<keyof EnrichedPartner>("priority");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const [openId, setOpenId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [logFor, setLogFor] = useState<EnrichedPartner | null>(null);
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
  useEffect(() => {
    void load();
  }, [reloadToken, load]);

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

  const queue = useMemo(
    () => [...all].sort((a, b) => b.priority - a.priority),
    [all],
  );
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
                    <tr>
                      <th onClick={() => sortBy("org")}>Organisation{caret("org")}</th>
                      <th onClick={() => sortBy("tier")}>Tier{caret("tier")}</th>
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
                        Revenue{caret("revenue")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {!rows.length ? (
                      <tr>
                        <td colSpan={6}>
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
                            <div className="rfsub2">
                              {[p.cat, p.owner || "unassigned"]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          </td>
                          <td>
                            <TierBadge t={p.tier} />
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
              Revenue is lifetime won opportunity value attributed to the source.
              Showing {rows.length} of {all.length} · total{" "}
              {money(rows.reduce((a, p) => a + p.revenue, 0))}
            </p>
          </>
        ) : null}

        {/* ── TOUCH QUEUE ───────────────────────────────────────────────── */}
        {tab === "queue" ? (
          <>
            <div className="rfkpis">
              <Kpi
                label="Overdue"
                value={overdue.length}
                desc="past cadence"
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
                  return (
                    <div key={e.id} className="rfev">
                      <div className="hd">
                        <div>
                          <div className="nm">{e.name}</div>
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
                          <div className="l">Revenue</div>
                          <div className="v">
                            {data?.meta.oppEventField ? money(st.revenue) : "—"}
                          </div>
                        </div>
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
              <Kpi label="Revenue attributed" value={money(kpis.revenue)} desc="lifetime won" />
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
                <p className="rfcap">Lifetime won value.</p>
                <Bars
                  rows={[...all]
                    .sort((a, b) => b.revenue - a.revenue)
                    .slice(0, 8)
                    .map((p) => ({ k: p.org, v: p.revenue }))
                    .filter((r) => r.v > 0)}
                  fmt={money}
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
                        {money(p.revenue)} lifetime · owner{" "}
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
          onClose={() => setOpenId(null)}
          onLog={() => setLogFor(open)}
        />
      ) : null}

      {addOpen ? (
        <AddPartnerDialog
          ssoBlob={ssoBlob}
          division={division}
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
  onClose,
  onLog,
}: {
  p: EnrichedPartner;
  ssoBlob: string | null;
  referrals: RawReferral[];
  onClose: () => void;
  onLog: () => void;
}) {
  const [notes, setNotes] = useState<
    { id: string; when: string; who: string; txt: string }[] | null
  >(null);
  const [noteErr, setNoteErr] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    setNotes(null);
    setNoteErr(null);
    apiFetch<{ notes: { id: string; when: string; who: string; txt: string }[] }>(
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
              <dd>{money(p.revenue)}</dd>
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
              <button type="button" className="ibtn" onClick={onLog}>
                Log a touch
              </button>
            </div>
            <div className="rfdhint">
              A touch is outreach you did. A referral is business they sent. Only
              the second one moves the revenue column — and a referral is
              recorded by setting <b>Referring Partner</b> on the client&apos;s
              opportunity, not here.
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
                    <div className="d">{n.when}</div>
                    <div className="t">{n.who}</div>
                    <div className="n">{n.txt}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rfdsec">
            <h4>Attributed opportunities</h4>
            {!mine.length ? (
              <div className="rfdhint">Nothing attributed yet.</div>
            ) : (
              <dl className="rfkv">
                {mine.slice(0, 12).map((o) => (
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
                      {o.value ? ` · ${money(o.value)}` : ""}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
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
  onClose,
  onAdded,
}: {
  ssoBlob: string | null;
  /** Pre-filled from the heading, because that is the division you are in. */
  division: Division;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [org, setOrg] = useState("");
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [cat, setCat] = useState("");
  const [tier, setTier] = useState<string>("Prospect");
  const [div, setDiv] = useState<string>(division);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState("");

  const save = async () => {
    setBusy(true);
    setErr(null);
    setDone("");
    try {
      const j = await apiFetch<{ contactId: string; skipped?: string[] }>(
        "/api/referrals",
        {
          method: "POST",
          body: JSON.stringify({
            ssoKey: ssoBlob ?? undefined,
            action: "add-partner",
            org: org.trim(),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: email.trim(),
            phone: phone.trim(),
            category: cat,
            tier,
            division: div,
            notes: notes.trim(),
          }),
        },
      );
      setDone(
        j.skipped?.length
          ? `Partner added. Not saved on this account: ${j.skipped.join("; ")}.`
          : "Partner added.",
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
            The organisation is the partner. A named person is optional — it goes
            on the same contact, so the row still reads as the organisation.
          </div>
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
              {PARTNER_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label htmlFor="rf-tier">Tier</label>
            <select id="rf-tier" value={tier} onChange={(e) => setTier(e.target.value)}>
              {TIERS.map((t) => (
                <option key={t} value={t}>
                  {t} · every {CADENCE[t]} days
                </option>
              ))}
            </select>
          </div>
          <div className="irow">
            <label htmlFor="rf-div">Division</label>
            <select id="rf-div" value={div} onChange={(e) => setDiv(e.target.value)}>
              {DIVISIONS.map((d) => (
                <option key={d} value={d}>
                  {d === "All" ? "All — appears under every division" : d}
                </option>
              ))}
            </select>
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
            disabled={busy || !org.trim()}
          >
            {busy ? "Saving…" : "Add partner"}
          </button>
        </div>
      </div>
    </div>
  );
}
