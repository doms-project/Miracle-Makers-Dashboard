"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { OpportunityRecord } from "@/lib/types";
import {
  sortStats,
  windowStart,
  type StatsWindow,
  type TabLabels,
} from "@/lib/sorting";
import {
  indexRecord,
  matchesQuery,
  parseQuery,
  suggest,
  nameScore,
  type Suggestion,
} from "@/lib/smartSearch";

const PAGE = 50;
const STALE_DAYS = 2;

type Kind = "newleads" | "staffing";
export type SortAction = "enroll" | "transfer" | "staffing" | "assign";

export type SearchBoxLike = (p: {
  which: "sorting";
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  chips?: { key: string; label: string; onRemove: () => void }[];
  suggestions?: Suggestion[];
  onPick?: (s: Suggestion) => void;
  leadsLabel?: string;
}) => ReactNode;

export type SourceMarkLike = (p: { src: string; small?: boolean }) => ReactNode;

type Show = "all" | "unopened" | "opened" | "unowned" | "owned" | "stale";
type SortBy = "default" | "oldest" | "newest" | "name" | "pipeline" | "source";
type GroupBy = "none" | "pipeline" | "source" | "arrived";

const ts = (v?: string) => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};
const digits = (s: string) => (s || "").replace(/\D/g, "");
const last4 = (p: string) => {
  const d = digits(p);
  return d.length >= 4 ? `…${d.slice(-4)}` : p || "";
};
const NY = "America/New_York";
function when(v?: string): string {
  const t = ts(v);
  if (!t) return "";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0)
    return `today ${new Date(t).toLocaleTimeString("en-US", { timeZone: NY, hour: "numeric", minute: "2-digit" })}`;
  if (days === 1) return "yesterday";
  return new Date(t).toLocaleDateString("en-US", { timeZone: NY, month: "short", day: "numeric" });
}
function waited(v?: string): { text: string; stale: boolean; days: number } {
  const t = ts(v);
  if (!t) return { text: "waiting", stale: false, days: 0 };
  const days = Math.floor((Date.now() - t) / 86_400_000);
  return {
    text: days <= 0 ? "today" : days === 1 ? "1 day" : `${days} days`,
    stale: days >= STALE_DAYS,
    days,
  };
}
function arrivedBucket(v?: string, todayStart = 0): string {
  const t = ts(v);
  if (!t) return "Date unknown";
  if (t >= todayStart) return "Today";
  if (t >= todayStart - 86_400_000) return "Yesterday";
  if (t >= todayStart - 6 * 86_400_000) return "Earlier this week";
  return "Older";
}
const nameOf = (r: OpportunityRecord) =>
  r.oppName || `${r.first} ${r.last}`.trim() || r.contactName || "(no name)";
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function SortingTab({
  kind,
  records,
  allRecords,
  sortedFieldId,
  isAdmin,
  view,
  pipelines,
  labels,
  can,
  onOpen,
  onAction,
  privatePayId,
  SearchBox,
  SourceMark,
}: {
  kind: Kind;
  records: OpportunityRecord[];

  allRecords: OpportunityRecord[];

  sortedFieldId: string | null;
  isAdmin: boolean;
  view: "list" | "board";

  pipelines: { id: string; name: string }[];
  labels: TabLabels;

  can: (r: OpportunityRecord, a: SortAction) => boolean;
  onOpen: (r: OpportunityRecord) => void;
  onAction: (r: OpportunityRecord, a: SortAction) => void;
  privatePayId: string;
  SearchBox: SearchBoxLike;

  SourceMark: SourceMarkLike;
}) {
  const isNew = kind === "newleads";
  const [q, setQ] = useState("");
  const [chip, setChip] = useState<string>("all");
  const [ownerTag, setOwnerTag] = useState<{ id: string; name: string } | null>(null);
  const [sourceTag, setSourceTag] = useState<string | null>(null);
  const [show, setShow] = useState<Show>("all");
  const [sortBy, setSortBy] = useState<SortBy>("default");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [win, setWin] = useState<StatsWindow>("7d");
  const [more, setMore] = useState<Record<string, number>>({});

  const pname = (id: string, fallback = "") =>
    labels.pipelines[id] || pipelines.find((p) => p.id === id)?.name || fallback;
  const pipeOf = (r: OpportunityRecord) => pname(r.pipelineId, r.pipelineName);
  const now = Date.now();
  const todayStart = windowStart("today", now);

  const index = useMemo(() => {
    const m = new Map<string, ReturnType<typeof indexRecord>>();
    for (const r of records)
      m.set(
        r.id,
        indexRecord([nameOf(r), r.contactName, r.src, r.rep, r.office, r.pipelineName, labels.pipelines[r.pipelineId]], r.contactPhone, r.contactEmail),
      );
    return m;
  }, [records, labels.pipelines]);

  const ordered = useMemo(() => {
    const out = [...records];
    if (sortBy === "default") {
      if (isNew)
        out.sort((a, b) => Number(!!b.newLead) - Number(!!a.newLead) || ts(b.createdAt) - ts(a.createdAt));
      else out.sort((a, b) => ts(a.stageChangedAt || a.createdAt) - ts(b.stageChangedAt || b.createdAt));
    } else if (sortBy === "oldest") {
      out.sort((a, b) => ts(isNew ? a.createdAt : a.stageChangedAt || a.createdAt) - ts(isNew ? b.createdAt : b.stageChangedAt || b.createdAt));
    } else if (sortBy === "newest") {
      out.sort((a, b) => ts(isNew ? b.createdAt : b.stageChangedAt || b.createdAt) - ts(isNew ? a.createdAt : a.stageChangedAt || a.createdAt));
    } else if (sortBy === "name") {
      out.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    } else if (sortBy === "pipeline") {
      out.sort((a, b) => pipeOf(a).localeCompare(pipeOf(b)) || ts(b.createdAt) - ts(a.createdAt));
    } else if (sortBy === "source") {
      out.sort((a, b) => (a.src || "~").localeCompare(b.src || "~") || ts(b.createdAt) - ts(a.createdAt));
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, isNew, sortBy, labels.pipelines]);

  const pq = useMemo(() => parseQuery(q), [q]);
  const searched = useMemo(
    () =>
      ordered.filter((r) => {
        if (!matchesQuery(index.get(r.id), pq)) return false;
        if (ownerTag && (ownerTag.id ? r.ownerId !== ownerTag.id : !!r.ownerId)) return false;
        if (sourceTag !== null && (r.src || "") !== sourceTag) return false;
        if (show === "unopened" && !r.newLead) return false;
        if (show === "opened" && r.newLead) return false;
        if (show === "unowned" && r.ownerId) return false;
        if (show === "owned" && !r.ownerId) return false;
        if (show === "stale" && !waited(r.stageChangedAt || r.createdAt).stale) return false;
        return true;
      }),
    [ordered, index, pq, ownerTag, sourceTag, show],
  );

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of searched) m.set(r.pipelineId, (m.get(r.pipelineId) || 0) + 1);
    return m;
  }, [searched]);
  const laneIds = useMemo(() => {
    const ids = pipelines.filter((p) => counts.get(p.id)).map((p) => p.id);
    for (const id of counts.keys()) if (!ids.includes(id)) ids.push(id);
    return ids;
  }, [pipelines, counts]);

  const shown = chip === "all" ? searched : searched.filter((r) => r.pipelineId === chip);
  const filtersOn = !!(q.trim() || ownerTag || sourceTag !== null || show !== "all" || chip !== "all");
  const clearAll = () => {
    setQ("");
    setOwnerTag(null);
    setSourceTag(null);
    setShow("all");
    setChip("all");
  };

  const suggestions = useMemo(() => {
    if (!q.trim()) return [];
    const owners = new Map<string, { id: string; name: string; n: number }>();
    let unassigned = 0;
    const sources = new Map<string, number>();
    const pipes = new Map<string, number>();
    for (const r of records) {
      if (r.ownerId) {
        const o = owners.get(r.ownerId) || { id: r.ownerId, name: r.rep || "Owner", n: 0 };
        o.n++;
        owners.set(r.ownerId, o);
      } else unassigned++;
      if (r.src) sources.set(r.src, (sources.get(r.src) || 0) + 1);
      pipes.set(r.pipelineId, (pipes.get(r.pipelineId) || 0) + 1);
    }
    const base = suggest({
      query: q,
      ownerWord: "Owner",
      owners: [...owners.values()],
      unassigned,
      records: records.map((r) => ({
        id: r.id,
        name: nameOf(r),
        detail: `${pipeOf(r)} · ${r.contactPhone || "no phone"}`,
        ix: index.get(r.id)!,
        activity: ts(r.createdAt),
      })),
      maxRecords: 5,
      maxPeople: 4,
    });
    const extra: Suggestion[] = [];
    if (!pq.phone) {
      for (const [id, n] of pipes) {
        const s = nameScore(pname(id), pq.tokens);
        if (s) extra.push({ kind: "pipeline", value: id, label: pname(id), detail: `Pipeline · ${plural(n, "lead")}`, score: s });
      }
      for (const [name, n] of sources) {
        const s = nameScore(name, pq.tokens);
        if (s) extra.push({ kind: "source", value: name, label: name, detail: `Source · ${plural(n, "lead")}`, score: s });
      }
    }
    const people = base.filter((s) => s.kind !== "record");
    const leads = base.filter((s) => s.kind === "record");
    return [...people, ...extra.sort((a, b) => b.score - a.score).slice(0, 4), ...leads];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, pq, records, index, labels.pipelines]);

  const pick = (s: Suggestion) => {
    if (s.kind === "record") {
      const r = records.find((x) => x.id === s.value);
      if (r) onOpen(r);
      return;
    }
    if (s.kind === "owner") setOwnerTag({ id: s.value, name: s.label.replace(/ \(me\)$/, "") });
    else if (s.kind === "unassigned") setOwnerTag({ id: "", name: "No owner" });
    else if (s.kind === "pipeline") setChip(s.value);
    else if (s.kind === "source") setSourceTag(s.value);
    setQ("");
  };
  const chips = [
    ...(ownerTag ? [{ key: "o", label: ownerTag.name, onRemove: () => setOwnerTag(null) }] : []),
    ...(sourceTag !== null ? [{ key: "s", label: sourceTag || "No source", onRemove: () => setSourceTag(null) }] : []),
  ];

  const stats = useMemo(() => {
    const unopened = records.filter((r) => r.newLead).length;
    const arrivedToday = records.filter((r) => ts(r.createdAt) >= todayStart).length;
    const week = records.filter((r) => ts(r.createdAt) >= now - 7 * 86_400_000).length;
    const stale = records.filter((r) => waited(r.stageChangedAt || r.createdAt).stale).length;
    const oldest = [...records].sort(
      (a, b) => ts(isNew ? a.createdAt : a.stageChangedAt || a.createdAt) - ts(isNew ? b.createdAt : b.stageChangedAt || b.createdAt),
    )[0];

    const src = new Map<string, number>();
    for (const r of records) src.set(r.src || "", (src.get(r.src || "") || 0) + 1);
    const bySource = [...src.entries()].sort((a, b) => b[1] - a[1]);
    return { unopened, arrivedToday, week, stale, oldest, bySource };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, isNew, todayStart]);
  const sorted = useMemo(
    () => (isNew ? sortStats(allRecords, sortedFieldId, windowStart(win, Date.now())) : null),
    [isNew, allRecords, sortedFieldId, win],
  );
  const winLabel: Record<StatsWindow, string> = { today: "today", "7d": "in the last 7 days", "30d": "in the last 30 days", all: "all time" };

  const SortTo = ({ r }: { r: OpportunityRecord }) => {
    if (!isNew)
      return (
        <div className="sortseg one">
          <button
            type="button"
            disabled={!can(r, "assign")}
            onClick={(e) => {
              e.stopPropagation();
              onAction(r, "assign");
            }}
            title={can(r, "assign") ? "Give this case an owner and a stage" : "You can't assign this case"}
          >
            <span aria-hidden="true">✓</span>
            Assign
          </button>
        </div>
      );
    const noTransferHere = r.pipelineId === privatePayId;
    const btn = (a: SortAction, icon: string, label: string, tip: string, soft = false) => (
      <button
        type="button"
        className={soft ? "soft" : undefined}
        disabled={!can(r, a)}
        onClick={(e) => {
          e.stopPropagation();
          onAction(r, a);
        }}
        title={tip}
        aria-label={`${label} — ${nameOf(r)}`}
      >
        <span aria-hidden="true">{icon}</span>
        {label}
      </button>
    );
    const inEnroll = /enroll/i.test(r.pipelineName) || r.pipelineId === privatePayId;
    const inTransfer = /transfer/i.test(r.pipelineName);
    return (
      <div className="sortseg">
        {btn("enroll", "＋", "Enroll", inEnroll ? `Enroll · stays in ${pipeOf(r)}` : "Enroll · moves to its division's Enrollment")}
        {btn(
          "transfer",
          "⇄",
          "Transfer",
          noTransferHere
            ? "Private Pay has no Transfer: opens other divisions"
            : inTransfer
              ? `Transfer · stays in ${pipeOf(r)}`
              : "Transfer · moves to its division's Transfer",
          noTransferHere,
        )}
        {btn("staffing", "👥", "Staffing", `${labels.staffingStage} · no owner, someone else picks it up`)}
      </div>
    );
  };

  const emptyText = filtersOn
    ? "Nothing matches these filters."
    : isNew
      ? "No new leads waiting. New ones appear here as they arrive."
      : `Nothing waiting in ${labels.staffingStage}.`;
  const empty = (
    <div className="sortempty">
      <b>{emptyText}</b>
      {filtersOn ? (
        <button type="button" className="sortclear" onClick={clearAll}>
          Clear filters
        </button>
      ) : null}
    </div>
  );

  const limit = more.list || PAGE;
  const page = shown.slice(0, limit);
  const groups = useMemo(() => {
    if (groupBy === "none" || view !== "list") return [{ key: "", title: "", rows: page }];
    const m = new Map<string, OpportunityRecord[]>();
    for (const r of page) {
      const k =
        groupBy === "pipeline" ? pipeOf(r) : groupBy === "source" ? r.src || "No source" : arrivedBucket(r.createdAt, todayStart);
      const arr = m.get(k) || [];
      arr.push(r);
      m.set(k, arr);
    }
    const order = ["Today", "Yesterday", "Earlier this week", "Older", "Date unknown"];
    const keys = [...m.keys()];
    if (groupBy === "arrived") keys.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return keys.map((k) => ({ key: k, title: k, rows: m.get(k)! }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, groupBy, view, todayStart, labels.pipelines]);

  const Row = ({ r }: { r: OpportunityRecord }) => {
    const w = waited(r.stageChangedAt || r.createdAt);
    return (
      <div className="sortrow" role="row" onClick={() => onOpen(r)}>
        <div className="sortwho" role="cell">
          <div className="sortname">
            {r.newLead ? <i className="sortdot" title="Nobody has opened this lead yet" /> : null}
            <span>{nameOf(r)}</span>
            {r.ownerId ? <span className="sortpill own">{r.rep || "owned"}</span> : null}
            {r.shared ? <span className="sortpill">Shared</span> : null}
          </div>
          <div className="sortmeta">
            {r.contactPhone || "no phone"} · {isNew ? `arrived ${when(r.createdAt)}` : `in ${labels.staffingStage} since ${when(r.stageChangedAt || r.createdAt)}`}
          </div>
        </div>
        <div role="cell">
          <span className="sortpill pipe">{pipeOf(r)}</span>
        </div>
        <div className="sortmeta" role="cell">
          {isNew ? (

            <span className="sortsrc">
              {r.src ? <SourceMark src={r.src} /> : <span className="sortnosrc" title="No source on this lead">—</span>}
            </span>
          ) : (
            <span className={w.stale ? "sortage stale" : "sortage"}>{w.text}</span>
          )}
        </div>
        <div role="cell">
          <SortTo r={r} />
        </div>
      </div>
    );
  };

  const sel = (label: string, value: string, set: (v: string) => void, opts: [string, string][], title: string) => (
    <label className="sortsel" title={title}>
      <span>{label}</span>
      <select value={value} onChange={(e) => set(e.target.value)}>
        {opts.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="sorttab" data-sorttab={kind}>

      <div className="sorthead">
        <div className="sorttitle">
          <h2>{isNew ? labels.newLeads : labels.staffingTab}</h2>
          <p>
            {isNew
              ? "Every new lead lands here first. Choose where each one goes, and it leaves this list."
              : `Cases with no owner, waiting for someone to take them (the ${labels.staffingStage} stage). Longest waiting first.`}
          </p>
        </div>
        <ul className="sortkey" aria-label="What the buttons do">
          {isNew ? (
            <>
              <li><b>＋ Enroll</b> into Enrollment</li>
              <li><b>⇄ Transfer</b> into Transfer</li>
              <li><b>👥 Staffing</b> no owner yet, someone picks it up</li>
              <li><i className="sortdot" /> not opened yet</li>
            </>
          ) : (
            <>
              <li><b>✓ Assign</b> give it an owner and a stage</li>
              <li><span className="sortage stale">{STALE_DAYS}+ days</span> waiting too long</li>
            </>
          )}
        </ul>
      </div>

      <div className="sortstats">
        <div className="sortstat">
          <div className="k">Waiting {isNew ? "to sort" : "for an owner"}</div>
          <div className="v">{records.length}</div>
          <div className="sub">
            {isNew ? `${stats.unopened} not opened yet` : `${stats.stale} waiting ${STALE_DAYS}+ days`}
          </div>
        </div>
        {isNew ? (
          <div className="sortstat">
            <div className="k">Arrived today</div>
            <div className="v">{stats.arrivedToday}</div>
            <div className="sub">{stats.week} in the last 7 days</div>
          </div>
        ) : null}
        {isNew ? (
          <div className="sortstat" data-tile="source">
            <div className="k">By source</div>
            <div className="sortsrcs">
              {stats.bySource.length ? (
                stats.bySource.slice(0, 6).map(([k, n]) => (
                  <button
                    key={k || "none"}
                    type="button"
                    className={`srcpick${sourceTag === k ? " on" : ""}`}
                    onClick={() => setSourceTag(sourceTag === k ? null : k)}
                    title={sourceTag === k ? `Showing ${k || "no source"} only — click to clear` : `Show ${k || "no source"} only (${n})`}
                  >
                    {k ? <SourceMark src={k} /> : <span className="sortnosrc">—</span>}
                    <b>{n}</b>
                  </button>
                ))
              ) : (
                <span className="sub">—</span>
              )}
            </div>
          </div>
        ) : null}
        <div className="sortstat">
          <div className="k">Oldest waiting</div>
          <div className="v">{stats.oldest ? waited(isNew ? stats.oldest.createdAt : stats.oldest.stageChangedAt || stats.oldest.createdAt).text : "—"}</div>
          <div className="sub">{stats.oldest ? nameOf(stats.oldest) : "nothing waiting"}</div>
        </div>
        {isNew && sorted ? (
          <div
            className="sortstat wide"
            data-tile="sorted"
            title="Counts leads that are still on the dashboard. A lead deleted from the dashboard drops out of this count."
          >
            <div className="k sortstatk">
              Sorted
              <select value={win} onChange={(e) => setWin(e.target.value as StatsWindow)} aria-label="Period">
                <option value="today">Today</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="all">All time</option>
              </select>
            </div>
            {sortedFieldId ? (
              <>
                <div className="v">{sorted.total}</div>
                {sorted.total ? (
                  <div className="sortsplit">
                    {[...sorted.byPipeline.entries()]
                      .sort((a, b) => b[1] - a[1])
                      .map(([id, n]) => (
                        <span key={id}>
                          {pname(id, "Other pipeline")} <b>{n}</b>
                        </span>
                      ))}
                    {sorted.staffing ? (
                      <span className="staff">
                        {labels.staffingStage} <b>{sorted.staffing}</b>
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <div className="sub">none {winLabel[win]}</div>
                )}
              </>
            ) : (
              <div className="sub">
                {isAdmin
                  ? "Off. Create the GoHighLevel field “Sorted From New Leads” (Text, Opportunity) to count sorts."
                  : "Not switched on yet. Ask an admin."}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="sorttools">
        <div className="sortsearchwrap">
          <SearchBox
            which="sorting"
            value={q}
            onChange={setQ}
            placeholder={isNew ? "Search name, phone, email, source, owner" : "Search name, phone, email, pipeline"}
            chips={chips}
            suggestions={suggestions}
            onPick={pick}
          />
        </div>
        <div className="sortchips" role="group" aria-label="Pipelines">
          <button type="button" className={`chip${chip === "all" ? " on" : ""}`} onClick={() => setChip("all")}>
            All<span className="n">{searched.length}</span>
          </button>
          {laneIds.map((id) => (
            <button key={id} type="button" className={`chip${chip === id ? " on" : ""}`} onClick={() => setChip(chip === id ? "all" : id)}>
              {pname(id, searched.find((r) => r.pipelineId === id)?.pipelineName)}
              <span className="n">{counts.get(id)}</span>
            </button>
          ))}
        </div>
        <div className="sortsels">
          {sel(
            "Show",
            show,
            (v) => setShow(v as Show),
            isNew
              ? [["all", "All"], ["unopened", "Not opened"], ["opened", "Opened"], ["unowned", "No owner"], ["owned", "Has an owner"]]
              : [["all", "All"], ["stale", `Waiting ${STALE_DAYS}+ days`]],
            "Show only some of them",
          )}
          {sel(
            "Sort",
            sortBy,
            (v) => setSortBy(v as SortBy),
            isNew
              ? [["default", "Newest, unopened first"], ["newest", "Newest first"], ["oldest", "Oldest first"], ["name", "Name A–Z"], ["pipeline", "Pipeline"], ["source", "Source"]]
              : [["default", "Longest waiting"], ["newest", "Newest first"], ["name", "Name A–Z"], ["pipeline", "Pipeline"]],
            "Order",
          )}
          {view === "list"
            ? sel(
                "Group",
                groupBy,
                (v) => setGroupBy(v as GroupBy),
                isNew
                  ? [["none", "None"], ["pipeline", "Pipeline"], ["source", "Source"], ["arrived", "Arrived"]]
                  : [["none", "None"], ["pipeline", "Pipeline"]],
                "Group the list",
              )
            : null}
        </div>
      </div>

      {!shown.length ? (
        empty
      ) : view === "list" ? (
        <div className="sortlistview" role="table">
          <div className="sortrow head" role="row">
            <span role="columnheader">{isNew ? "Lead" : "Case"}</span>
            <span role="columnheader">{isNew ? "Arrived in" : "Pipeline"}</span>
            <span role="columnheader">{isNew ? "Source" : "Waiting"}</span>
            <span role="columnheader">{isNew ? "Sort to" : ""}</span>
          </div>
          {groups.map((g) => (
            <Fragment key={g.key || "all"}>
              {g.title ? (
                <div className="sortgrouphead" role="row">
                  {g.title}
                  <span>{g.rows.length}</span>
                </div>
              ) : null}
              {g.rows.map((r) => (
                <Row key={r.id} r={r} />
              ))}
            </Fragment>
          ))}
          <div className="sortfootline">
            <span>
              Showing {Math.min(limit, shown.length)} of {shown.length}
            </span>
            {shown.length > limit ? (
              <button type="button" className="sortmore" onClick={() => setMore((m) => ({ ...m, list: limit + PAGE }))}>
                Show {Math.min(PAGE, shown.length - limit)} more
              </button>
            ) : null}
          </div>
        </div>
      ) : (

        <div className="sortlanes">
          {laneIds
            .filter((id) => chip === "all" || id === chip)
            .map((id) => {
              const inLane = shown.filter((r) => r.pipelineId === id);
              if (!inLane.length) return null;
              const lim = more[id] || PAGE;
              return (
                <div key={id} className="sortlane" data-lane={id}>
                  <div className="sortlanehead">
                    {pname(id, inLane[0]?.pipelineName || "")}
                    <span>{inLane.length}</span>
                  </div>
                  <div className="sortlanebody">
                    {inLane.slice(0, lim).map((r) => {
                      const w = waited(r.stageChangedAt || r.createdAt);
                      return (
                        <div
                          key={r.id}
                          className="sortcard"
                          onClick={() => onOpen(r)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") onOpen(r);
                          }}
                        >
                          <div className="sortname">
                            {r.newLead ? <i className="sortdot" title="Nobody has opened this lead yet" /> : null}
                            <span>{nameOf(r)}</span>
                            <SourceMark src={r.src} />
                          </div>
                          <div className="sortmeta">
                            {isNew ? (
                              `${last4(r.contactPhone) || "no phone"} · ${when(r.createdAt)}`
                            ) : (
                              <span className={w.stale ? "sortage stale" : "sortage"}>{w.text} waiting</span>
                            )}
                          </div>
                          {r.ownerId && isNew ? <div className="sortmeta">Owner: {r.rep || "owned"}</div> : null}
                          <SortTo r={r} />
                        </div>
                      );
                    })}
                    {inLane.length > lim ? (
                      <button type="button" className="sortmore" onClick={() => setMore((m) => ({ ...m, [id]: lim + PAGE }))}>
                        + {inLane.length - lim} more
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
