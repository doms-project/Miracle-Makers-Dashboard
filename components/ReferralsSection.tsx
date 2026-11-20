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

  stageFellBack?: boolean;
  stageWhy?: string;
}

export interface Payload {
  partners: RawPartner[];
  referrals: RawReferral[];

  applicantRefs?: RawReferral[];
  events: RawEvent[];
  attendees: RawAttendee[];

  viewer: { userId: string; isAdmin: boolean };
  owners: Owner[];
  categoryOptions: string[];
  tierOptions: string[];
  divisionOptions: string[];

  eventDivisionOptions?: string[];
  outcomeOptions: string[];
  clientPipelines: PipelineChoice[];
  meta: {
    eventHostField: string;
    outcomeField: string;
    eventsPipelineConfigured: boolean;
    eventsPipelineName: string;

    clientPipelinesWithheld?: number;

    partnersWithheld?: number;

    referralsWithheld?: number;

    viewerDivisions?: number | null;

    viewerReferralDivisions?: string[] | null;

    referralScopeKind?: "all" | "derived" | "none" | "explicit" | "unmatched";

    eventsWithheld?: number;

    attendeesWithheld?: number;

    danglingAttendees?: number;

    partnersNoDivision?: number;

    danglingReferrals?: number;

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

const NEVER = Number.MAX_SAFE_INTEGER;

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

const moneyMo = (n: number) => `${money(n)}/mo`;
const CADENCE_WORD: Record<string, string> = {
  A: "biweekly",
  B: "monthly",
  C: "quarterly",
  Prospect: "3-weekly",
};

const SHARED_SCOPE = "shared:owned";

const divLabel = (d: Division, mine?: readonly string[] | null) =>
  d === "All"
    ? mine && mine.length
      ? mine.join(" + ")
      : "All divisions"
    : d === SHARED_SCOPE
      ? "Shared with me"
      : d;

function DivisionTag({
  division,
  shared,
  what = "partner",
}: {
  division: string;
  shared?: boolean;

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

  onOpenRecord?: (id: string) => void;

  canOpenRecord?: (id: string) => boolean;

  cache: Payload | null;

  onCache: (p: Payload) => void;
  ssoBlob: string | null;

  ssoReady: boolean;

  reloadToken: number;
  onBusy: (busy: boolean) => void;
}) {
  const [data, setData] = useState<Payload | null>(cache);

  const pending = useRef<{
    partners: RawPartner[];
    events: RawEvent[];
    attendees: RawAttendee[];
  }>({ partners: [], events: [], attendees: [] });

  const [savedNote, setSavedNote] = useState("");

  const [loading, setLoading] = useState(!cache);
  const [err, setErr] = useState<unknown>(null);

  const [division, setDivision] = useState<Division>(ALL_DIVISIONS);
  const [divOpen, setDivOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("sources");

  const [queueScope, setQueueScope] = useState<"mine" | "all" | null>(null);

  const [tier, setTier] = useState<string>("all");
  const [cat, setCat] = useState<string>("all");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState("");

  const [sortKey, setSortKey] = useState<keyof EnrichedPartner>("lastTouch");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const [openId, setOpenId] = useState<string | null>(null);

  const [notesToken, setNotesToken] = useState(0);

  const partnerDivisions = useMemo(
    () => (data?.divisionOptions.length ? data.divisionOptions : [...DIVISIONS]),
    [data],
  );

  const myDivs = data?.meta.viewerReferralDivisions ?? null;
  const divisionChoices = useMemo(

    () => headingDivisions(myDivs, data?.partners || [], data?.events || []),
    [myDivs, data],
  );

  const anyShared = useMemo(
    () => (data?.partners || []).some((p) => p.shared),
    [data],
  );

  const canSwitchDivision = divisionChoices.length > 1 || anyShared;

  const staticDivLabel =
    divisionChoices.length === 1 ? divisionChoices[0] : "Referral partners";

  const scopeSuffix =
    division === ALL_DIVISIONS
      ? myDivs && myDivs.length
        ? ` · ${myDivs.join(" + ")}`
        : ""
      : division === SHARED_SCOPE
        ? " · shared"
        : ` · ${division}`;

  const isScoped = division !== ALL_DIVISIONS || !!(myDivs && myDivs.length);

  const scopeWords =
    division === ALL_DIVISIONS ? (myDivs || []).join(" + ") : division;

  const divisionsAreLive = !!data && data.divisionOptions.length > 0;

  const eventDivisions = useMemo(
    () =>
      data?.eventDivisionOptions?.length
        ? data.eventDivisionOptions
        : partnerDivisions,
    [data, partnerDivisions],
  );
  const eventDivisionsAreItsOwn = !!data?.eventDivisionOptions?.length;

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

  useEffect(() => {

    if (division === SHARED_SCOPE) {
      if (!anyShared) setDivision(ALL_DIVISIONS);
      return;
    }
    if (division !== ALL_DIVISIONS && !divisionChoices.includes(division))
      setDivision(ALL_DIVISIONS);
  }, [divisionChoices, division, anyShared]);

  const [delEvent, setDelEvent] = useState<RawEvent | null>(null);

  const [delAttendee, setDelAttendee] = useState<RawAttendee | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState<unknown>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [logFor, setLogFor] = useState<EnrichedPartner | null>(null);

  const [refFor, setRefFor] = useState<
    { partner?: Pick<RawPartner, "id" | "org" | "division">; event?: RawEvent } | null
  >(null);
  const [metFor, setMetFor] = useState<RawEvent | null>(null);
  const [eventForPartner, setEventForPartner] = useState<EnrichedPartner | null>(null);

  const [outBusy, setOutBusy] = useState<Record<string, boolean>>({});
  const [outErr, setOutErr] = useState<Record<string, string>>({});
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreNote, setMoreNote] = useState("");

  const divRef = useRef<HTMLDivElement | null>(null);

  const loadSeq = useRef(0);

  const load = useCallback(async () => {

    const seq = ++loadSeq.current;
    const isCurrent = () => seq === loadSeq.current;

    setLoading(true);
    onBusy(true);
    setErr(null);
    try {

      const j = await apiFetch<Payload>("/api/referrals?touch=auto", { ssoBlob });
      if (!isCurrent()) return;

      setErr(null);

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

      setErr(e);
    } finally {
      if (isCurrent()) {
        setLoading(false);
        onBusy(false);
      }
    }
  }, [ssoBlob, onBusy]);

  const loadedKey = useRef(cache ? `${reloadToken}|${ssoBlob ?? ""}` : null);
  useEffect(() => {
    if (!ssoReady) return;
    const key = `${reloadToken}|${ssoBlob ?? ""}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    void load();
  }, [reloadToken, load, ssoReady, ssoBlob]);

  useEffect(() => {
    if (data) onCache(data);
  }, [data, onCache]);

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

  const removeAttendee = useCallback(async () => {
    const a = delAttendee;
    const field = data?.meta.attendeeEventField;
    if (!a || !field) return;
    setDelBusy(true);
    setDelErr(null);
    try {

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

  const divisionRefs = useMemo<RawReferral[]>(() => {
    if (!data) return [];
    if (division === ALL_DIVISIONS || division === SHARED_SCOPE) return data.referrals;
    return data.referrals.filter((o) => divisionLabel(o.pipelineName) === division);
  }, [data, division]);

  const all = useMemo<EnrichedPartner[]>(() => {
    if (!data) return [];
    return data.partners

      .filter((p) =>
        division === SHARED_SCOPE ? p.shared : !p.shared && inDivision(p.division, division),
      )

      .map((p) => enrichPartner(p, divisionRefs, data.applicantRefs || []));
  }, [data, division, divisionRefs]);

  const kpis = useMemo(() => partnerKpis(all), [all]);

  const measureMore = useCallback(async () => {
    if (!data) return;
    setMoreBusy(true);
    setMoreNote("");
    try {

      const ids = all.filter((p) => p.unknownTouch).map((p) => p.id);
      const j = await apiFetch<{
        touch: Record<string, number>;
        meta: { touchResolved: number; touchFailed: number; touchCapped: number };
      }>("/api/referrals", {

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

  const events = useMemo(
    () =>
      !data || division === SHARED_SCOPE
        ? []
        : data.events.filter((e) => inDivision(e.division, division)),
    [data, division],
  );

  const divAttendees = useMemo(() => {
    const list = data?.attendees || [];
    if (division === "All") return list;
    const ids = new Set(events.map((e) => e.id));
    return list.filter((a) => a.eventId && ids.has(a.eventId));
  }, [data, events, division]);

  const unplacedAttendees = useMemo(
    () => (data?.attendees || []).filter((a) => !a.eventId).length,
    [data],
  );

  const orphanAttendees = data?.meta.danglingAttendees ?? 0;

  const shownAttendees = useMemo(() => dedupeByContact(divAttendees), [divAttendees]);

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

    () => data?.meta.danglingReferrals ?? 0,
    [data],
  );

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

  const caveats: string[] = [];

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

    if (division !== "All" && unplacedAttendees)
      caveats.push(
        `${unplacedAttendees} ${unplacedAttendees === 1 ? "person" : "people"} met at an event ${unplacedAttendees === 1 ? "is" : "are"} not counted in ${division}'s event figures, because their record does not say which event they were at.`,
      );

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

        <div className="rfhead" ref={divRef}>
          {!canSwitchDivision ? (

            <span className="rfdiv rfdivstatic">
              <span className="rfdivname">{staticDivLabel}</span>
            </span>
          ) : (
          <>
          <button
            type="button"
            className="rfdiv"

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

              {[ALL_DIVISIONS, ...divisionChoices].map((d) => (

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

            {division === "All"
              ? myDivs && myDivs.length
                ? `${myDivs.join(" + ")}, plus every partner marked "All".`
                : "Every division."
              : `${division}, plus every partner marked "All".`}
          </p>

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

        {tab === "sources" ? (
          <>
            <div className="rfkpis">
              <Kpi
                label="Active sources"
                value={kpis.activeSources}
                desc={`referred in the last 90 days · ${kpis.totalSources} tracked`}
              />

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

                    <tr>
                      <th

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

                      <th className="num"

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

              Revenue is the monthly recurring value of <b>won</b> opportunities
              attributed to a partner — <b>not the agency&apos;s revenue</b>:
              Facebook, website and Google Ads leads have no partner to credit
              and are counted nowhere on this screen. Showing {rows.length} of{" "}
              {all.length} · total{" "}
              {moneyMo(rows.reduce((a, p) => a + p.revenue, 0))}

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

        {tab === "queue" ? (
          <>

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

                  const st = eventStats(e, data?.attendees || [], divisionRefs);
                  const good = st.cpl !== null && st.cpl <= 120;

                  const host = e.host
                    ? data?.partners.find((x) => x.id === e.host)
                    : undefined;
                  const hostVisibleHere = !!host && inDivision(host.division, division);
                  return (
                    <div key={e.id} className="rfev">
                      <div className="hd">
                        <div>
                          <div className="nm">{e.name}</div>

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

                            <div className="rfevnohost">
                              Run by a partner in{" "}
                              {host.division ? `the ${host.division} division` : "another division"}
                            </div>
                          ) : e.host ? (

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

                          <DivisionTag division={e.division} what="event" />
                        </div>
                        <div className="dt">
                          {e.date || "no date"} · {money(e.cost)} cost

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

                      {isScoped ? (
                        <div className="rfdhint">
                          {money(e.cost)} is the event&apos;s <b>whole</b> cost, and{" "}
                          <b>Cost per legit lead</b> uses every attendee.{" "}
                          <b>Clients</b> and <b>Revenue</b> count{" "}
                          {division === SHARED_SCOPE ? "only cases you may see" : `${scopeWords} cases`}{" "}
                          only.
                        </div>
                      ) : null}

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

        {tab === "overview" ? (
          <>
            <div className="rfkpis">
              <Kpi

                label="Sources"
                value={kpis.totalSources}
                desc={`${kpis.activeSources} referred in 90 days`}
              />

              <Kpi
                label={`Revenue from partners${scopeSuffix}`}
                value={moneyMo(kpis.revenue)}
                desc="won, monthly · excludes every non-referred case"
              />

              {kpis.applicants ? (

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

  onOpenRecord?: (id: string) => void;

  canOpenRecord?: (id: string) => boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(opp.value || ""));
  const [status, setStatus] = useState(opp.status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");

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

          method: "PATCH",
          ssoBlob,
          body: JSON.stringify({
            ssoKey: ssoBlob ?? undefined,
            monetaryValue: want,
            status,
          }),
        },
      );

      const got = j.record;
      const gotVal = typeof got?.monetaryValue === "number" ? got.monetaryValue : null;
      const gotStatus = typeof got?.status === "string" ? got.status : null;
      const bad: string[] = [];
      if (gotVal !== null && gotVal !== want)
        bad.push(`value came back as ${moneyMo(gotVal)}, not ${moneyMo(want)}`);
      if (gotStatus !== null && gotStatus !== status)
        bad.push(`status came back as "${gotStatus}", not "${status}"`);
      if (bad.length) {

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

  hostField: string;
  onClose: () => void;
  onLog: () => void;
  onLogReferral: () => void;
  onAddEvent: () => void;

  onChanged: () => void;

  notesToken: number;
}) {

  const drawerRef = useRef<HTMLElement | null>(null);
  const returnFocusTo = useRef<Element | null>(null);
  useEffect(() => {
    returnFocusTo.current = document.activeElement;
    drawerRef.current?.focus();
    return () => {
      const el = returnFocusTo.current as HTMLElement | null;

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

  }, [p.id, ssoBlob, notesToken]);

  const mine = referrals
    .filter((o) => o.partnerId === p.id)
    .sort((a, b) => (a.ago ?? 1e9) - (b.ago ?? 1e9));

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

              <button type="button" className="cgsave" onClick={onLogReferral}>
                Log a referral
              </button>
              <button type="button" className="ighost" onClick={onLog}>
                Log a touch
              </button>

              <button type="button" className="ighost" onClick={onAddEvent}>
                Add an event
              </button>
            </div>

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

          {(() => {
            const ev = partnerEvents(p.id, events, attendees, referrals);

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

  division: Division;
  owners: Owner[];

  categories: string[];
  tiers: string[];
  divisions: string[];

  divisionsAreLive: boolean;
  onClose: () => void;
  onAdded: (saved?: RawPartner) => void;
}) {

  const [mode, setMode] = useState<"new" | "existing">("new");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; email: string; phone: string }[]>([]);
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [searching, setSearching] = useState(false);

  const [searchErr, setSearchErr] = useState("");
  const [org, setOrg] = useState("");
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [cat, setCat] = useState("");
  const [tier, setTier] = useState<string>("Prospect");

  const [div, setDiv] = useState<string>(division === "All" ? "" : division);
  const [owner, setOwner] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState("");

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

          <div className="rfgroup">
            <div className="rfglab">Who they are</div>
          <div className="rfmode">
            <label>

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

                <>
                  {searching ? (
                    <div className="rfdhint">Searching…</div>
                  ) : searchErr ? (
                    <div className="rfdhint rfdbad rfsearchfail">

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

          {mode === "existing" && picked ? null : (
            <>

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

                  {div === "" ? (
                    <option value="">Choose a division…</option>
                  ) : null}
                  {divisions.map((d) => (
                    <option key={d} value={d}>
                      {d === "All" ? "All — appears under every division" : d}
                    </option>
                  ))}
                </select>

                {!div ? (
                  <div className="rfdhint rfdbad">
                    ⚠️ Required. A partner with no division is shown to
                    everybody, whichever division they work in.
                  </div>
                ) : null}

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

            disabled={busy || !div || (mode === "new" ? !org.trim() : !picked)}
          >
            {busy ? "Saving…" : mode === "existing" ? "Mark as partner" : "Add partner"}
          </button>
        </div>
      </div>
    </div>
  );
}

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

  partner?: Pick<RawPartner, "id" | "org" | "division">;

  event?: RawEvent;
  pipelines: PipelineChoice[];

  withheld: number;
  onClose: () => void;
  onLogged: () => void;
}) {
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [phone, setPhone] = useState("");

  const [email, setEmail] = useState("");
  const [monthly, setMonthly] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState("");

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

  const attribute = async () => {
    if (!chosenOpp || !refField || !partner) return;
    setBusy(true);
    setErr(null);
    setDone("");
    try {
      await apiFetch(`/api/opportunities/${encodeURIComponent(chosenOpp)}`, {

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

                <>
                  {searching ? (
                    <div className="rfdhint">Searching…</div>
                  ) : searchErr ? (
                    <div className="rfdhint rfdbad rfsearchfail">

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

          {partner && mode === "existing" ? null : (
          <>

          <div className="rfglab">Who the referral is for</div>

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

            {!phone.trim() && !email.trim() ? (
              <div className="rfdhint rfdbad">
                ⚠️ Add a phone number or an email — we need a way to reach them.
              </div>
            ) : null}

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

          {dest?.stageFellBack ? (
            <div className="rfdhint rfdbad">
              ⚠️ <b>{dest.name}</b> has no stage that reads as a new enquiry —{" "}
              {dest.stageWhy}. It will be filed at <b>{dest.stage}</b>, which
              may say this case came from somewhere it did not. Add or rename a
              first stage in GoHighLevel.
            </div>
          ) : null}

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

export interface PersonHit {
  id: string;
  name: string;
  email: string;
  phone: string;
  recordType: string;

  roleKnown: boolean;
  caseLabel: string;
}

interface ConflictInfo {
  sentence: string;
  detail: string;
  person: PersonHit;
}

function describePerson(h: PersonHit): string {
  const role = h.roleKnown ? h.recordType || "no role" : "role not shown";
  return [role, h.caseLabel].filter(Boolean).join(" · ");
}

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

  const [mode, setMode] = useState<"new" | "existing">("new");
  const [pq, setPq] = useState("");
  const [people, setPeople] = useState<PersonHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<PersonHit | null>(null);

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

  divisionsAreEventsOwn?: boolean;

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

      onAdded(
        j.eventId
          ? {
              id: j.eventId,
              name: name.trim(),

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

                  <option value="">Choose a division…</option>
                  {divisions.map((d) => (
                    <option key={d} value={d}>
                      {d === "All" ? "All — appears under every division" : d}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {!div ? (
              <div className="rfdhint rfdbad">
                ⚠️ Required. An event with no division is shown to everybody,
                whichever division they work in.
              </div>
            ) : null}

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

            disabled={busy || !name.trim() || !venue.trim() || !div}
          >
            {busy ? "Saving…" : "Add event"}
          </button>
        </div>
      </div>
    </div>
  );
}
