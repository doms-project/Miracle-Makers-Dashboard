"use client";

import { useEffect, useMemo, useState } from "react";
import type { OpportunityRecord } from "@/lib/types";

// ITEM 4 — one of the contact's OTHER open cases. GoHighLevel allows only ONE
// opportunity per contact per pipeline, so each of these BLOCKS its pipeline as
// a destination.
interface Conflict {
  opportunityId: string;
  name: string;
  pipelineId: string;
  pipelineName: string;
  stage: string;
  status: string;
}

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
  // ITEM 4 — the contact's other cases, fetched when the dialog opens.
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [conflictsLoading, setConflictsLoading] = useState(true);
  const [conflictsErr, setConflictsErr] = useState<string | null>(null);

  // Fetch the duplicate pre-check. A failure here NEVER blocks the Move: we
  // simply lose the ability to grey out destinations, and the server-side error
  // (explained by explainGhlError) still catches it.
  useEffect(() => {
    let cancelled = false;
    setConflictsLoading(true);
    setConflictsErr(null);
    fetch(`/api/opportunities/${record.id}/conflicts`, {
      headers: ssoBlob ? { "x-ghl-sso-key": ssoBlob } : {},
      cache: "no-store",
    })
      .then(async (res) => {
        const j = (await res.json().catch(() => ({}))) as {
          conflicts?: Conflict[];
          error?: string;
          detail?: string;
        };
        if (!res.ok) throw new Error(j.detail || j.error || `HTTP ${res.status}`);
        if (!cancelled) setConflicts(j.conflicts || []);
      })
      .catch((e) => {
        if (!cancelled)
          setConflictsErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setConflictsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [record.id, ssoBlob]);

  // pipelineId -> the case already occupying it for this contact.
  const conflictByPipeline = useMemo(() => {
    const m = new Map<string, Conflict>();
    for (const c of conflicts) if (!m.has(c.pipelineId)) m.set(c.pipelineId, c);
    return m;
  }, [conflicts]);

  const blocked = conflictByPipeline.get(toPipelineId) || null;

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
      // ITEM 3. This was gated on `j.record`: if the re-read after the move came
      // back empty, onMoved never fired, so the panel was never told to close
      // and kept showing the pre-move record. The move HAS happened by this
      // point — the caller must be told either way, so fall back to the record
      // we already hold rather than silently doing nothing.
      onMoved((j.record as OpportunityRecord) || record, !!j.transferred);
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
              {pipelines.map((p) => {
                // ITEM 4 — a pipeline where this contact already has a case
                // cannot receive this one. Grey it out with the reason rather
                // than letting the rep discover GHL's rule via a 400. The
                // record's CURRENT pipeline is never blocked by itself (the
                // conflicts route already excludes this opportunity).
                const c = conflictByPipeline.get(p.id);
                return (
                  <option key={p.id} value={p.id} disabled={!!c}>
                    {p.name}
                    {c ? " — already has a case for this client" : ""}
                  </option>
                );
              })}
            </select>
            {blocked ? (
              <div className="savemsg err" style={{ marginTop: 6 }}>
                ✗ This client already has a case in{" "}
                <b>{blocked.pipelineName || "that pipeline"}</b>
                {blocked.stage ? ` (${blocked.stage})` : ""}. GoHighLevel allows
                only one case per client per pipeline — move or close that one
                first.
              </div>
            ) : null}
            {conflictsLoading ? (
              <div className="imeta">Checking the client&apos;s other cases…</div>
            ) : null}
            {conflictsErr ? (
              <div className="imeta">
                Couldn&apos;t check the client&apos;s other cases ({conflictsErr}
                ). The move will still be attempted — GoHighLevel will reject it
                if a case already exists in the destination.
              </div>
            ) : null}

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
              disabled={busy || unchanged || !!blocked}
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
