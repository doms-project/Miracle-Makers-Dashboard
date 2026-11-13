"use client";
// ---------------------------------------------------------------------------
// ROUND 197 — "Sort [name]" (Enroll / Transfer from New Leads) and
// "Assign [name]" (from Staffing needed lead). ONE component, two modes.
//
// 🔴 IT POSTS mode:"sort" | "assign" TO THE MOVE ROUTE, which sends it down
// sortOpportunity — NOT the transfer path. So the stage chosen here is the
// stage written, and no Transferred From/Date stamp is created: a first sort
// is not a hand-over, and Master must not file it under "Sent out".
//
// ⚠️ THE SERVER DECIDES. Every limit drawn here (locked owner, send-only
// pipelines, required stage) is re-checked by lib/sorting.ts on the server;
// this only stops people from asking for something that will be refused.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import type { OpportunityRecord } from "@/lib/types";
import { divisionLabel } from "@/lib/division";
import { isNewLeadStage, isPickableStage, type TabLabels } from "@/lib/sorting";

interface Conflict {
  pipelineId: string;
  pipelineName: string;
  stage: string;
}

const PRIVATE_PAY_PIPELINE_ID =
  process.env.NEXT_PUBLIC_PRIVATE_PAY_PIPELINE_ID || "BJBWdRim6SOgjoMelVSZ";
const isEnrollTarget = (p: { id: string; name: string }) =>
  /enroll/i.test(p.name) || p.id === PRIVATE_PAY_PIPELINE_ID;
const isTransferTarget = (p: { id: string; name: string }) => /transfer/i.test(p.name);

export default function SortDialog({
  mode,
  target,
  record,
  targets,
  homeIds,
  isAdmin,
  viewerId,
  staffing,
  stagesByPipeline,
  users,
  labels,
  ssoBlob,
  peerLabel,
  onPeerTransfer,
  onClose,
  onDone,
}: {
  mode: "sort" | "assign";
  /** Which Sort-to button was pressed (sort mode only). */
  target?: "enroll" | "transfer";
  record: OpportunityRecord;
  /** Every client pipeline the viewer may send to (names only for no-access ones). */
  targets: { id: string; name: string }[];
  homeIds: string[];
  isAdmin: boolean;
  viewerId: string;
  staffing: "admin" | "any" | "self" | "off";
  stagesByPipeline: Record<string, { id: string; name: string }[]>;
  users: { id: string; name: string; pipelineIds?: string[] }[];
  labels: TabLabels;
  ssoBlob: string | null;
  /** Set when the viewer may use the cross-account transfer on this case. */
  peerLabel?: string | null;
  onPeerTransfer?: () => void;
  onClose: () => void;
  onDone: (rec: OpportunityRecord) => void;
}) {
  const who = record.oppName || `${record.first} ${record.last}`.trim() || "this lead";
  const canUse = (pid: string) => isAdmin || homeIds.includes(pid);
  const myDivision = divisionLabel(record.pipelineName);
  const nameOf = (pid: string) =>
    labels.pipelines[pid] || targets.find((p) => p.id === pid)?.name || "—";

  // ---- the pipeline list, grouped by division, own division first ----
  const groups = useMemo(() => {
    const m = new Map<string, { id: string; name: string }[]>();
    for (const p of targets) {
      const d = divisionLabel(p.name) || p.name;
      m.set(d, [...(m.get(d) || []), p]);
    }
    return [...m.entries()].sort(([a], [b]) =>
      a === myDivision ? -1 : b === myDivision ? 1 : a.localeCompare(b),
    );
  }, [targets, myDivision]);

  // ---- where the pressed button points ----
  const initialPipeline = useMemo(() => {
    if (mode === "assign") return record.pipelineId;
    const pick = target === "transfer" ? isTransferTarget : isEnrollTarget;
    const own = targets.filter((p) => divisionLabel(p.name) === myDivision);
    if (own.some((p) => p.id === record.pipelineId && pick(p))) return record.pipelineId;
    return (
      own.find(pick)?.id ||
      // Private Pay has no Transfer pipeline: point at another division's.
      targets.find((p) => pick(p) && canUse(p.id))?.id ||
      targets.find(pick)?.id ||
      record.pipelineId
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [toPipelineId, setToPipelineId] = useState(initialPipeline);
  const changed = toPipelineId !== record.pipelineId;
  const sendOnly = !canUse(toPipelineId);

  // ---- owner ----
  const ownerLocked = mode === "assign" && staffing === "self";
  const defaultOwner = () => {
    if (mode === "assign") return users.some((u) => u.id === viewerId) ? viewerId : "";
    if (record.ownerId) return record.ownerId;
    return users.some((u) => u.id === viewerId) && canUse(initialPipeline) ? viewerId : "";
  };
  const [ownerId, setOwnerId] = useState<string>(defaultOwner);
  useEffect(() => {
    // A pipeline the viewer can't see can only be sent to with no owner.
    if (sendOnly && !isAdmin) setOwnerId("");
  }, [sendOnly, isAdmin]);
  const lacks = (u: { pipelineIds?: string[] }) =>
    !!u.pipelineIds && !u.pipelineIds.includes(toPipelineId);

  // ---- stage ----
  const stages = (stagesByPipeline[toPipelineId] || []).filter((s) => isPickableStage(s.name));
  const staysAtNewLead = mode === "sort" && !ownerId && changed;
  const [stageId, setStageId] = useState<string>("");
  useEffect(() => setStageId(""), [toPipelineId]);

  // ---- one case per client per pipeline (same check the Move dialog makes) ----
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/opportunities/${record.id}/conflicts`, {
      headers: ssoBlob ? { "x-ghl-sso-key": ssoBlob } : {},
      cache: "no-store",
    })
      .then(async (res) => {
        const j = (await res.json().catch(() => ({}))) as { conflicts?: Conflict[] };
        if (!cancelled && res.ok) setConflicts(j.conflicts || []);
      })
      .catch(() => {
        /* the server refuses a duplicate anyway */
      });
    return () => {
      cancelled = true;
    };
  }, [record.id, ssoBlob]);
  const blocked = conflicts.find((c) => c.pipelineId === toPipelineId && toPipelineId !== record.pipelineId);

  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const needStage = !(staysAtNewLead && !stageId);
  const missing =
    (mode === "assign" && !ownerId) ? "Pick who will own it." :
    (needStage && !stageId && !staysAtNewLead) ? "Choose a stage." :
    null;
  const ownerName = users.find((u) => u.id === ownerId)?.name?.split(" — ")[0] || "";
  const destName = nameOf(toPipelineId);

  const info = (() => {
    if (mode === "assign")
      return ownerId
        ? `${who} stays in ${destName} with ${ownerName || "the new owner"} as owner and leaves ${labels.staffingStage}. The followers added while it waited are removed.`
        : "";
    if (sendOnly && !isAdmin)
      return `You don't have access to ${destName}. ${who} goes there at New lead with no owner, and its team sorts it. After this it leaves your list.`;
    if (!ownerId)
      return changed
        ? `${who} moves to ${destName} at New lead and stays in ${labels.newLeads} until someone takes it.`
        : `${who} stays in ${destName} with no owner.`;
    return changed
      ? `${divisionLabel(destName) === myDivision ? "Same division. " : ""}${who} moves to ${destName} with ${ownerName || "the owner"} as owner and leaves ${labels.newLeads}.`
      : `${who} stays in ${destName} with ${ownerName || "the owner"} as owner and leaves ${labels.newLeads}.`;
  })();
  const warn = mode === "sort" && sendOnly && !isAdmin;

  const primary =
    mode === "assign"
      ? "Assign"
      : sendOnly && !isAdmin
        ? `Send to ${divisionLabel(destName) || destName}`
        : changed
          ? `Move to ${destName}`
          : `Keep in ${destName}`;

  const submit = async () => {
    if (missing || blocked) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/opportunities/${record.id}/move`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ssoBlob ? { "x-ghl-sso-key": ssoBlob } : {}),
        },
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          expectedVersion: record.version,
          mode,
          toPipelineId,
          toStageId: stageId || undefined,
          // Unchanged owner is sent as "keep" (undefined), not re-written.
          newOwnerId: (ownerId || "") === (record.ownerId || "") ? undefined : ownerId,
          reason: reason.trim() || undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw apiError(res, j);
      onDone((j.record as OpportunityRecord) || record);
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const sub =
    mode === "assign"
      ? `${labels.staffingStage}${record.rep ? ` · given up by ${record.rep}` : ""}`
      : `Now in ${nameOf(record.pipelineId)} · New lead${record.contactPhone ? ` · ${record.contactPhone}` : ""}`;

  return (
    <div className="previewmodal" onClick={busy ? undefined : onClose}>
      <div
        className="movebox sortbox"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${mode === "assign" ? "Assign" : "Sort"} ${who}`}
      >
        <div className="previewhead">
          <span className="previewname">
            {mode === "assign" ? "Assign" : "Sort"} {who}
          </span>
          <button className="x" type="button" onClick={onClose} disabled={busy} aria-label="Close">
            ×
          </button>
        </div>
        <div className="movebody">
          <div className="sortsub">{sub}</div>

          <label className="sortlbl">Pipeline</label>
          {mode === "assign" ? (
            <div className="sortfixed">
              <span>{destName}</span>
              <span className="sortmuted">stays here</span>
            </div>
          ) : (
            <div className="sortlist" role="radiogroup" aria-label="Pipeline">
              {groups.map(([div, list]) => (
                <div key={div}>
                  <div className="sortgroup">
                    {div} · {div === myDivision ? "your division" : "other division"}
                  </div>
                  {list.map((p) => {
                    const on = p.id === toPipelineId;
                    const c = conflicts.find((x) => x.pipelineId === p.id && p.id !== record.pipelineId);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        className={`sortopt${on ? " on" : ""}`}
                        disabled={!!c}
                        onClick={() => setToPipelineId(p.id)}
                        title={c ? "This client already has a case in that pipeline" : undefined}
                      >
                        <span>{nameOf(p.id)}</span>
                        <span className="sortmuted">
                          {p.id === record.pipelineId
                            ? "now here"
                            : c
                              ? "already has a case"
                              : canUse(p.id)
                                ? ""
                                : "🔒 you have no access"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          <div className="sortgrid">
            <div>
              <label className="sortlbl">Owner</label>
              {ownerLocked ? (
                <div className="sortfixed">
                  <span>Me · {users.find((u) => u.id === viewerId)?.name?.split(" — ")[0] || "you"}</span>
                </div>
              ) : (
                <select
                  value={ownerId}
                  onChange={(e) => setOwnerId(e.target.value)}
                  disabled={sendOnly && !isAdmin}
                >
                  {mode === "sort" ? <option value="">Unassigned</option> : <option value="">Choose…</option>}
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.id === viewerId ? "Me · " : ""}
                      {u.name}
                      {lacks(u) ? ` (no access to ${destName})` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <label className="sortlbl">Stage</label>
              {staysAtNewLead && (sendOnly || !stages.length) ? (
                <div className="sortfixed">
                  <span>New lead</span>
                  <span className="sortmuted">stays</span>
                </div>
              ) : (
                <select value={stageId} onChange={(e) => setStageId(e.target.value)}>
                  <option value="">{staysAtNewLead ? "Stays at New lead" : "Choose a stage"}</option>
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          {ownerLocked ? <div className="sortnote">You can assign cases to yourself.</div> : null}
          <div className="sortnote">
            {mode === "assign"
              ? `Both are required. ${labels.staffingStage} and New lead aren't offered here.`
              : `Stages come from ${destName}. New lead and ${labels.staffingStage} aren't offered here.`}
          </div>

          {blocked ? (
            <div className="sortwarn">
              This client already has a case in <b>{blocked.pipelineName || destName}</b>. GoHighLevel
              allows one case per client per pipeline.
            </div>
          ) : info ? (
            <div className={warn ? "sortwarn" : "sortinfo"}>{info}</div>
          ) : null}

          <label className="sortlbl">{mode === "assign" ? "Note" : "Reason"}</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={mode === "assign" ? "Taking this one" : "Optional"}
          />
          {err ? <ErrorMessage error={err} className="savemsg err" /> : null}

          <div className="sortfoot">
            {mode === "sort" && peerLabel && onPeerTransfer ? (
              <button type="button" className="sortlink" onClick={onPeerTransfer} disabled={busy}>
                → Transfer to {peerLabel} instead
              </button>
            ) : (
              <span />
            )}
            <span className="sortbtns">
              <button type="button" className="sortbtn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="sortbtn primary"
                onClick={submit}
                disabled={busy || !!missing || !!blocked}
                title={missing || undefined}
              >
                {busy ? "Saving…" : primary}
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** For callers: is this stage name the arrival stage? (re-exported for the page) */
export { isNewLeadStage };
