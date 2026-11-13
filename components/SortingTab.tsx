"use client";
// ---------------------------------------------------------------------------
// ROUND 197 — the two sorting tabs.
//
//   "newleads"  every case at NEW LEAD the viewer is sent (theirs, plus
//               unowned ones in pipelines they hold; admins: all). Each one
//               gets Enroll · Transfer · Staffing.
//   "staffing"  every UNOWNED case at REASSIGN the viewer is sent. Oldest
//               waiting first. Each one gets Assign.
//
// 🔴 IT FILTERS NOTHING FOR PERMISSION. The server already decided which
// records this viewer receives (applyAccess + the Staffing gate). This view
// only lays them out; the buttons it draws are re-checked server-side.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import type { OpportunityRecord } from "@/lib/types";
import type { TabLabels } from "@/lib/sorting";

const PAGE = 50;
const STALE_DAYS = 2;

type Kind = "newleads" | "staffing";
export type SortAction = "enroll" | "transfer" | "staffing" | "assign";

const ts = (v?: string) => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
};
const digits = (s: string) => (s || "").replace(/\D/g, "");
const last4 = (p: string) => {
  const d = digits(p);
  return d.length >= 4 ? `…${d.slice(-4)}` : p || "";
};
function when(v?: string): string {
  const t = ts(v);
  if (!t) return "";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0)
    return `today ${new Date(t).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })}`;
  if (days === 1) return "yesterday";
  return new Date(t).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
}
function waited(v?: string): { text: string; stale: boolean } {
  const t = ts(v);
  if (!t) return { text: "waiting", stale: false };
  const days = Math.floor((Date.now() - t) / 86_400_000);
  return {
    text: days <= 0 ? "today" : days === 1 ? "1 day waiting" : `${days} days waiting`,
    stale: days >= STALE_DAYS,
  };
}
const nameOf = (r: OpportunityRecord) =>
  r.oppName || `${r.first} ${r.last}`.trim() || r.contactName || "(no name)";

export default function SortingTab({
  kind,
  records,
  view,
  pipelines,
  labels,
  can,
  onOpen,
  onAction,
  privatePayId,
}: {
  kind: Kind;
  records: OpportunityRecord[];
  view: "list" | "board";
  /** Lane / chip order: the viewer's pipelines, then any shared ones. */
  pipelines: { id: string; name: string }[];
  labels: TabLabels;
  /** Which buttons this viewer may use on this record (mirrors the server). */
  can: (r: OpportunityRecord, a: SortAction) => boolean;
  onOpen: (r: OpportunityRecord) => void;
  onAction: (r: OpportunityRecord, a: SortAction) => void;
  privatePayId: string;
}) {
  const [q, setQ] = useState("");
  const [chip, setChip] = useState<string>("all");
  const [more, setMore] = useState<Record<string, number>>({});

  const pname = (id: string, fallback = "") =>
    labels.pipelines[id] || pipelines.find((p) => p.id === id)?.name || fallback;

  // ---- order: unopened first then newest (new leads); oldest first (queue) ----
  const ordered = useMemo(() => {
    const out = [...records];
    if (kind === "newleads")
      out.sort((a, b) =>
        Number(!!b.newLead) - Number(!!a.newLead) || ts(b.createdAt) - ts(a.createdAt),
      );
    else out.sort((a, b) => ts(a.stageChangedAt || a.createdAt) - ts(b.stageChangedAt || b.createdAt));
    return out;
  }, [records, kind]);

  const searched = useMemo(() => {
    const raw = q.trim().toLowerCase();
    if (!raw) return ordered;
    const words = raw.split(/\s+/).filter(Boolean);
    const qd = digits(raw);
    const phoneish = /^[\d\s()+.\-]+$/.test(raw) && qd.length >= 4;
    return ordered.filter((r) => {
      if (phoneish) return digits(r.contactPhone).endsWith(qd) || digits(r.contactPhone).includes(qd);
      const hay = `${nameOf(r)} ${r.contactName} ${r.contactEmail} ${r.office} ${r.src} ${r.rep}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [ordered, q]);

  // ---- lanes: pipelines with records, in the viewer's pipeline order ----
  const lanes = useMemo(() => {
    const ids = new Set(searched.map((r) => r.pipelineId));
    const ordered = pipelines.filter((p) => ids.has(p.id)).map((p) => p.id);
    for (const r of searched) if (!ordered.includes(r.pipelineId)) ordered.push(r.pipelineId);
    // The queue keeps an empty lane visible so "nothing waiting" is said, not implied.
    if (kind === "staffing") for (const p of pipelines) if (!ordered.includes(p.id)) ordered.push(p.id);
    return ordered;
  }, [searched, pipelines, kind]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of searched) m.set(r.pipelineId, (m.get(r.pipelineId) || 0) + 1);
    return m;
  }, [searched]);

  const shown = chip === "all" ? searched : searched.filter((r) => r.pipelineId === chip);

  const SortTo = ({ r }: { r: OpportunityRecord }) => {
    if (kind === "staffing")
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
        {btn("enroll", "＋", "Enroll", inEnroll ? `Enroll · stays in ${pname(r.pipelineId, r.pipelineName)}` : "Enroll · moves to its division's Enrollment")}
        {btn(
          "transfer",
          "⇄",
          "Transfer",
          noTransferHere
            ? "Private Pay has no Transfer: opens other divisions"
            : inTransfer
              ? `Transfer · stays in ${pname(r.pipelineId, r.pipelineName)}`
              : "Transfer · moves to its division's Transfer",
          noTransferHere,
        )}
        {btn("staffing", "👥", "Staffing", `${labels.staffingStage} · no owner, someone else picks it up`)}
      </div>
    );
  };

  const empty = (
    <div className="sortempty">
      {q.trim()
        ? "Nothing matches that search."
        : kind === "newleads"
          ? "No new leads waiting. New ones appear here as they arrive."
          : `Nothing waiting in ${labels.staffingStage}.`}
    </div>
  );

  return (
    <div className="sorttab" data-sorttab={kind}>
      <div className="sorthead">
        <div>
          <b>{kind === "newleads" ? labels.newLeads : labels.staffingTab}</b>
          <span className="sortmuted">
            {kind === "newleads"
              ? " · sort each lead into its pipeline"
              : " · no owner, waiting to be assigned (Reassign stage)"}
          </span>
        </div>
        {kind === "newleads" ? (
          <div className="sortkey" aria-hidden="true">
            <span>＋ Enroll</span>
            <span>⇄ Transfer</span>
            <span>👥 Staffing</span>
            <span><i className="sortdot" /> not opened</span>
          </div>
        ) : null}
      </div>
      <div className="sorttools">
        <input
          className="sortsearch"
          data-search="sorting"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, phone, email"
          aria-label="Search"
        />
        <button type="button" className={`chip${chip === "all" ? " on" : ""}`} onClick={() => setChip("all")}>
          All<span className="n">{searched.length}</span>
        </button>
        {lanes
          .filter((id) => counts.get(id))
          .map((id) => (
            <button
              key={id}
              type="button"
              className={`chip${chip === id ? " on" : ""}`}
              onClick={() => setChip(chip === id ? "all" : id)}
            >
              {pname(id, searched.find((r) => r.pipelineId === id)?.pipelineName)}
              <span className="n">{counts.get(id)}</span>
            </button>
          ))}
      </div>

      {view === "list" ? (
        !shown.length ? (
          empty
        ) : (
          <div className="sortlistview" role="table">
            <div className="sortrow head" role="row">
              <span>Lead</span>
              <span>{kind === "newleads" ? "Arrived in" : "Pipeline"}</span>
              <span>{kind === "newleads" ? "Source" : "Waiting"}</span>
              <span>{kind === "newleads" ? "Sort to" : ""}</span>
            </div>
            {shown.slice(0, more.list || PAGE).map((r) => {
              const w = waited(r.stageChangedAt || r.createdAt);
              return (
                <div key={r.id} className="sortrow" role="row" onClick={() => onOpen(r)}>
                  <div className="sortwho">
                    <div className="sortname">
                      {r.newLead ? <i className="sortdot" title="Nobody has opened this lead yet" /> : null}
                      <span>{nameOf(r)}</span>
                      {r.ownerId ? <span className="sortpill">{r.rep || "owned"}</span> : null}
                      {r.shared ? <span className="sortpill">Shared</span> : null}
                    </div>
                    <div className="sortmeta">
                      {r.contactPhone || "no phone"} · {when(r.createdAt)}
                    </div>
                  </div>
                  <div>
                    <span className="sortpill">{pname(r.pipelineId, r.pipelineName)}</span>
                  </div>
                  <div className="sortmeta">
                    {kind === "newleads" ? r.src || "—" : <span className={w.stale ? "sortage stale" : "sortage"}>{w.text}</span>}
                  </div>
                  <SortTo r={r} />
                </div>
              );
            })}
            {shown.length > (more.list || PAGE) ? (
              <button type="button" className="sortmore" onClick={() => setMore((m) => ({ ...m, list: (m.list || PAGE) + PAGE }))}>
                Show more ({shown.length - (more.list || PAGE)} left)
              </button>
            ) : null}
          </div>
        )
      ) : !shown.length && kind === "newleads" ? (
        empty
      ) : (
        <div className="sortlanes">
          {lanes
            .filter((id) => chip === "all" || id === chip)
            .map((id) => {
              const inLane = shown.filter((r) => r.pipelineId === id);
              const lim = more[id] || PAGE;
              return (
                <div key={id} className={`sortlane${inLane.length ? "" : " empty"}`} data-lane={id}>
                  <div className="sortlanehead">
                    {pname(id, inLane[0]?.pipelineName || "")}
                    <span>{inLane.length}</span>
                  </div>
                  {!inLane.length ? <div className="sortmuted sortlaneempty">nothing waiting</div> : null}
                  {inLane.slice(0, lim).map((r) => {
                    const w = waited(r.stageChangedAt || r.createdAt);
                    return (
                      <div key={r.id} className="sortcard" onClick={() => onOpen(r)} role="button" tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter") onOpen(r); }}>
                        <div className="sortname">
                          <span>{nameOf(r)}</span>
                          {r.newLead ? <i className="sortdot" title="Nobody has opened this lead yet" /> : null}
                        </div>
                        <div className="sortmeta">
                          {kind === "newleads"
                            ? `${last4(r.contactPhone)} · ${r.src || "—"} · ${when(r.createdAt)}`
                            : <span className={w.stale ? "sortage stale" : "sortage"}>{w.text}</span>}
                          {r.ownerId && kind === "newleads" ? ` · ${r.rep || "owned"}` : ""}
                        </div>
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
              );
            })}
        </div>
      )}
    </div>
  );
}
