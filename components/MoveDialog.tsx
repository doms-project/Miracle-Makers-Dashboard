"use client";

import { useMemo, useState } from "react";
import type { OpportunityRecord } from "@/lib/types";

// Task 6 — the Move action. One control; the system classifies:
//   owner UNCHANGED -> simple move (pipeline + stage). No warning, no stamps.
//   owner CHANGED   -> transfer: stage locks to TRANSFERRED IN, followers are
//                      cleared, Transferred From/Date stamped, note written,
//                      and the current owner loses access (Option B).
export default function MoveDialog({
  record,
  pipelines,
  stagesByPipeline,
  users,
  ssoBlob,
  onClose,
  onMoved,
}: {
  record: OpportunityRecord;
  pipelines: { id: string; name: string }[];
  stagesByPipeline: Record<string, { id: string; name: string }[]>;
  users: { id: string; name: string }[];
  ssoBlob: string | null;
  onClose: () => void;
  // `transferred` = the owner changed, so the caller can close the panel
  // (the viewer may have just lost access) rather than refresh it in place.
  onMoved: (rec: OpportunityRecord, transferred: boolean) => void;
}) {
  const [toPipelineId, setToPipelineId] = useState(record.pipelineId);
  const [toStageId, setToStageId] = useState(record.stageId);
  // Owner is PREFILLED with the current owner — changing it is what makes this
  // a transfer.
  const [newOwnerId, setNewOwnerId] = useState(record.ownerId);
  const [reason, setReason] = useState("");
  const [addSender, setAddSender] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isTransfer = (newOwnerId || "") !== (record.ownerId || "");
  const destStages = stagesByPipeline[toPipelineId] || [];
  const transferredIn = useMemo(
    () =>
      destStages.find((s) => s.name.trim().toUpperCase() === "TRANSFERRED IN"),
    [destStages],
  );
  const destName =
    pipelines.find((p) => p.id === toPipelineId)?.name || "—";
  const ownerName =
    users.find((u) => u.id === newOwnerId)?.name || "Unassigned";
  const followersCleared = record.followerIds.filter(
    (f) => f !== newOwnerId,
  ).length;

  const submit = async () => {
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
          toPipelineId,
          // Stage is chosen only on the simple path; a transfer always lands in
          // TRANSFERRED IN (the server resolves and enforces it).
          toStageId: isTransfer ? undefined : toStageId,
          newOwnerId: isTransfer ? newOwnerId : undefined,
          reason: reason.trim() || undefined,
          addSenderAsFollower: isTransfer ? addSender : undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok)
        throw new Error(j.detail || j.error || `HTTP ${res.status}`);
      if (j.record) onMoved(j.record as OpportunityRecord, !!j.transferred);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unchanged =
    toPipelineId === record.pipelineId &&
    (isTransfer || toStageId === record.stageId) &&
    !isTransfer;

  return (
    <div className="previewmodal" onClick={onClose}>
      <div className="movebox" onClick={(e) => e.stopPropagation()}>
        <div className="previewhead">
          <span className="previewname">Move this case</span>
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="movebody">
          <div className="irow" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <label>Pipeline</label>
            <select
              value={toPipelineId}
              onChange={(e) => {
                setToPipelineId(e.target.value);
                const first = (stagesByPipeline[e.target.value] || [])[0];
                setToStageId(first?.id || "");
              }}
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>

            <label>Stage</label>
            {isTransfer ? (
              <div className="v ro">
                {transferredIn?.name || "TRANSFERRED IN"}{" "}
                <span className="readonly-note">set automatically on transfer</span>
              </div>
            ) : (
              <select
                value={toStageId}
                onChange={(e) => setToStageId(e.target.value)}
              >
                {destStages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}

            <label>Owner</label>
            <select
              value={newOwnerId}
              onChange={(e) => setNewOwnerId(e.target.value)}
            >
              <option value="">Unassigned</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>

            <label>Reason</label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={isTransfer ? "Why is this being handed over?" : "Optional"}
            />
          </div>

          {/* Warn ONLY when access is actually lost (owner changed). */}
          {isTransfer ? (
            <div className="movewarn">
              <b>This is a transfer.</b> Owner becomes <b>{ownerName}</b>, the case
              moves to <b>{destName} · TRANSFERRED IN</b>, and{" "}
              <b>you lose access to it</b>.
              {followersCleared > 0 ? (
                <>
                  {" "}
                  {followersCleared} follower(s) will be removed so it leaves the
                  originating division.
                </>
              ) : null}
              <label className="movetoggle">
                <input
                  type="checkbox"
                  checked={addSender}
                  onChange={(e) => setAddSender(e.target.checked)}
                />
                Keep me on this lead — I&apos;ll still see it after the transfer
              </label>
              {addSender ? (
                <div className="movetoggle-note">
                  The previous owner stays a follower, so this lead does{" "}
                  <b>not</b> leave the originating division — it keeps appearing
                  for them as shared until removed.
                </div>
              ) : null}
            </div>
          ) : (
            <div className="imeta">
              Simple move — owner unchanged, so nothing is stamped and no access
              changes.
            </div>
          )}

          {err ? <div className="savemsg err">✗ {err}</div> : null}

          <div className="inav">
            <button type="button" className="ighost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="ibtn"
              disabled={busy || unchanged}
              onClick={submit}
            >
              {busy ? "Moving…" : isTransfer ? "Transfer case" : "Move"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
