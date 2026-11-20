"use client";

import { useEffect, useMemo, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import type { OpportunityRecord } from "@/lib/types";

interface Conflict {
  opportunityId: string;
  name: string;
  pipelineId: string;
  pipelineName: string;
  stage: string;
  status: string;
}

export default function MoveDialog({
  record,
  pipelines: allPipelines,
  stagesByPipeline,
  users,
  ssoBlob,
  onClose,
  onMoved,
  allowedPipelineIds,
  forceUnassigned,
  requireOwner,
  intro,
}: {
  record: OpportunityRecord;
  pipelines: { id: string; name: string }[];
  stagesByPipeline: Record<string, { id: string; name: string }[]>;

  users: {
    id: string;
    name: string;
    divisions?: string[];
    pipelineIds?: string[];
  }[];
  ssoBlob: string | null;
  onClose: () => void;

  onMoved: (rec: OpportunityRecord, transferred: boolean) => void;

  allowedPipelineIds?: string[];

  forceUnassigned?: boolean;

  requireOwner?: boolean;

  intro?: React.ReactNode;
}) {
  if (requireOwner && forceUnassigned)

    throw new Error(
      "MoveDialog: requireOwner and forceUnassigned are mutually exclusive.",
    );

  const pipelines = useMemo(
    () =>
      allowedPipelineIds?.length
        ? allPipelines.filter((p) => allowedPipelineIds.includes(p.id))
        : allPipelines,
    [allPipelines, allowedPipelineIds],
  );
  const [toPipelineId, setToPipelineId] = useState(
    allowedPipelineIds?.length && !allowedPipelineIds.includes(record.pipelineId)
      ? pipelines[0]?.id || record.pipelineId
      : record.pipelineId,
  );

  const [toStageId, setToStageId] = useState(requireOwner ? "" : record.stageId);

  const [newOwnerId, setNewOwnerId] = useState(
    forceUnassigned ? "" : record.ownerId,
  );
  const [reason, setReason] = useState("");
  const [addSender, setAddSender] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [conflictsLoading, setConflictsLoading] = useState(true);
  const [conflictsErr, setConflictsErr] = useState<unknown>(null);

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
        if (!res.ok) throw apiError(res, j);
        if (!cancelled) setConflicts(j.conflicts || []);
      })
      .catch((e) => {
        if (!cancelled)
          setConflictsErr(e);
      })
      .finally(() => {
        if (!cancelled) setConflictsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [record.id, ssoBlob]);

  const conflictByPipeline = useMemo(() => {
    const m = new Map<string, Conflict>();
    for (const c of conflicts) if (!m.has(c.pipelineId)) m.set(c.pipelineId, c);
    return m;
  }, [conflicts]);

  const blocked = conflictByPipeline.get(toPipelineId) || null;

  const isTransfer = (newOwnerId || "") !== (record.ownerId || "");
  const rawDestStages = stagesByPipeline[toPipelineId] || [];

  const destStages = rawDestStages.filter(
    (s2) =>
      s2.name.trim().toUpperCase() !== "REASSIGN" &&

      (s2.name.trim().toUpperCase() !== "NEW LEAD" ||
        (toPipelineId === record.pipelineId && s2.id === record.stageId)),
  );
  const transferredIn = useMemo(
    () =>
      destStages.find((s) => s.name.trim().toUpperCase() === "TRANSFERRED IN"),
    [destStages],
  );
  const destName =
    pipelines.find((p) => p.id === toPipelineId)?.name || "—";
  const ownerName =
    users.find((u) => u.id === newOwnerId)?.name || "Unassigned";

  const lacksAccess = (u: { pipelineIds?: string[] } | undefined) =>
    !!u && !!u.pipelineIds && !u.pipelineIds.includes(toPipelineId);
  const ownerLacksAccess = useMemo(
    () => !!newOwnerId && lacksAccess(users.find((x) => x.id === newOwnerId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [users, newOwnerId, toPipelineId],
  );
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

          expectedVersion: record.version,
          toPipelineId,

          toStageId: isTransfer && !requireOwner ? undefined : toStageId,
          newOwnerId: isTransfer ? newOwnerId : undefined,
          reason: reason.trim() || undefined,
          addSenderAsFollower: isTransfer ? addSender : undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok)
        throw apiError(res, j);

      onMoved((j.record as OpportunityRecord) || record, !!j.transferred);
      onClose();
    } catch (e) {
      setErr(e);
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

          {intro ? <div className="moveintro">{intro}</div> : null}
          <div className="irow" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <label>Pipeline</label>
            <select
              value={toPipelineId}
              onChange={(e) => {
                setToPipelineId(e.target.value);

                const first = (stagesByPipeline[e.target.value] || []).find((st) => {
                  const n = st.name.trim().toUpperCase();
                  return n !== "NEW LEAD" && n !== "REASSIGN";
                });
                setToStageId(first?.id || "");
              }}
            >
              {pipelines.map((p) => {

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
                Couldn&apos;t check the client&apos;s other cases. The move
                will still be attempted — GoHighLevel will reject it if a case
                already exists in the destination.
                <ErrorMessage error={conflictsErr} className="imeta" />
              </div>
            ) : null}

            <label>Stage</label>
            {isTransfer && requireOwner ? (

              <select
                value={toStageId}
                onChange={(e) => setToStageId(e.target.value)}
              >
                <option value="">Choose a stage…</option>
                {destStages.map((s2) => (
                  <option key={s2.id} value={s2.id}>
                    {s2.name}
                  </option>
                ))}
              </select>
            ) : isTransfer ? (
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
            {forceUnassigned ? (
              <div className="v ro">
                Unassigned{" "}
                <span className="readonly-note">
                  the receiving team claims it by taking ownership
                </span>
              </div>
            ) : (
              <select
                value={newOwnerId}
                onChange={(e) => setNewOwnerId(e.target.value)}
              >
                <option value="">Unassigned</option>
                {users.map((u) => {
                  const lacks = lacksAccess(u);
                  return (
                    <option key={u.id} value={u.id}>
                      {u.name}
                      {u.divisions?.length ? ` — ${u.divisions.join(" · ")}` : ""}
                      {lacks ? `  ⚠️ no access to ${destName}` : ""}
                    </option>
                  );
                })}
              </select>
            )}

            <label>Reason</label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={isTransfer ? "Why is this being handed over?" : "Optional"}
            />
          </div>

          {isTransfer && !newOwnerId ? (

            <div className="movewarn">
              <b>This hands the case to a department, not a person.</b> It moves
              to <b>{destName}</b> with <b>no owner</b>, so the receiving team
              can claim it by taking ownership. It leaves this column
              automatically the moment someone does.
              <br />
              <b>You keep sight of it</b> — you stay on it as a follower until
              it&apos;s claimed.
            </div>
          ) : isTransfer ? (

            <div className="movewarn">
              <b>{ownerName}</b> becomes the owner and the case moves to{" "}
              <b>{destName}</b>.{" "}
              {addSender ? (
                <>
                  You&apos;ll <b>stay on it as a follower</b>, so it will keep
                  appearing for you under <b>Shared with me</b>.
                </>
              ) : (
                <>
                  You&apos;ll <b>lose access to it</b>.
                </>
              )}
              {followersCleared > 0 ? (
                <>
                  {" "}
                  {followersCleared} other follower
                  {followersCleared === 1 ? "" : "s"} will be removed.
                </>
              ) : null}
              <label className="movetoggle">
                <input
                  type="checkbox"
                  checked={addSender}
                  onChange={(e) => setAddSender(e.target.checked)}
                />
                Keep me on this lead
              </label>
            </div>
          ) : (
            <div className="imeta">
              Simple move — owner unchanged, so nothing is stamped and no access
              changes.
            </div>
          )}

          {ownerLacksAccess ? (
            <div className="ownerwarn">
              ⚠️ <b>{ownerName}</b> won&apos;t be able to see this case in the
              dashboard until an admin grants them <b>{destName}</b> access in
              the Access tab. The move will still go through.
            </div>
          ) : null}

          {err ? <ErrorMessage error={err} className="savemsg err" /> : null}

          <div className="inav">
            <button type="button" className="ighost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="ibtn"
              disabled={
                busy ||
                unchanged ||
                !!blocked ||

                (!!requireOwner && (!newOwnerId || !toStageId))
              }
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
