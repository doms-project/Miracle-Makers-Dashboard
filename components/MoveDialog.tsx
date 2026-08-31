"use client";

import { useEffect, useMemo, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
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
  // `divisions` labels each user with the pipelines they hold. ITEM 1 uses it
  // to FLAG — never to hide — owners without access to the chosen destination.
  // `pipelineIds` is what ITEM 1 checks against — exact, not a division label.
  users: {
    id: string;
    name: string;
    divisions?: string[];
    pipelineIds?: string[];
  }[];
  ssoBlob: string | null;
  onClose: () => void;
  // `transferred` = the owner changed, so the caller can close the panel
  // (the viewer may have just lost access) rather than refresh it in place.
  onMoved: (rec: OpportunityRecord, transferred: boolean) => void;
  // ---- ITEM 3: opened by a DROP on a Master-view category column ----
  // A category column can't decide by itself which pipeline is meant
  // ("Enrollment" is two pipelines), so the drop opens this dialog with the
  // choice already narrowed to the ones that column stands for.
  allowedPipelineIds?: string[];
  // REASSIGN: the point of the column is that nobody owns it yet, so the owner
  // is forced to Unassigned and the control is locked rather than merely
  // defaulted — a stray click that re-assigns it would take the record straight
  // back out of the column it was just dropped into.
  forceUnassigned?: boolean;
  // ITEM 3 STEP 2 — OUT of Reassign, the exact opposite of step 1: an owner is
  // MANDATORY, because the whole point is handing the case to a person. It also
  // turns on a STAGE picker scoped to the chosen destination pipeline, which a
  // transfer normally doesn't get (a transfer always lands in TRANSFERRED IN).
  // Same component, configured by direction.
  requireOwner?: boolean;
  // "You're moving Sandra Gonzalez to Enrollment. Which one?"
  intro?: React.ReactNode;
}) {
  if (requireOwner && forceUnassigned)
    // These are the two directions of the same journey and cannot both hold.
    // Better a loud failure here than a dialog that silently strips an owner
    // on the path whose only purpose is to set one.
    throw new Error(
      "MoveDialog: requireOwner and forceUnassigned are mutually exclusive.",
    );
  // When a drop narrows the choice, the dropdown must not offer the others at
  // all. Filtering the LIST (rather than disabling options) also guarantees the
  // initial value below can never be a pipeline this drop disallows.
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
  // On the claim path the record's CURRENT stage is REASSIGN, which is exactly
  // the one value that must not be submitted — so start empty and make the
  // person choose. Everywhere else the current stage is a sensible default.
  const [toStageId, setToStageId] = useState(requireOwner ? "" : record.stageId);
  // Owner is PREFILLED with the current owner — changing it is what makes this
  // a transfer.
  const [newOwnerId, setNewOwnerId] = useState(
    forceUnassigned ? "" : record.ownerId,
  );
  const [reason, setReason] = useState("");
  const [addSender, setAddSender] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  // ITEM 4 — the contact's other cases, fetched when the dialog opens.
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [conflictsLoading, setConflictsLoading] = useState(true);
  const [conflictsErr, setConflictsErr] = useState<unknown>(null);

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

  // pipelineId -> the case already occupying it for this contact.
  const conflictByPipeline = useMemo(() => {
    const m = new Map<string, Conflict>();
    for (const c of conflicts) if (!m.has(c.pipelineId)) m.set(c.pipelineId, c);
    return m;
  }, [conflicts]);

  const blocked = conflictByPipeline.get(toPipelineId) || null;

  const isTransfer = (newOwnerId || "") !== (record.ownerId || "");
  const rawDestStages = stagesByPipeline[toPipelineId] || [];
  // ⚠️ On the step-2 (claim) path REASSIGN must not be offered AT ALL. Filtering
  // it only inside the transfer branch was not enough: the dialog opens with the
  // owner still empty, so `isTransfer` is false and the plain stage select — the
  // unfiltered one — renders first. Picking a stage before picking an owner then
  // selected REASSIGN and moved the card straight back into the column it was
  // being claimed out of. Filtered once, at the source, so every branch sees it.
  // ITEM 6 — REASSIGN IS NEVER A DESTINATION HERE, on any path.
  //
  // It was filtered only when `requireOwner` was set, which left the SIMPLE
  // MOVE path (owner unchanged) offering it — so a rep could park a record in
  // the queue straight from this dropdown, skipping the owner clear, the
  // follower add, the "Reassign Followers" write and the notification. It would
  // sit unowned, with no followers, and nobody would be told.
  //
  // The only two things that may set it are reassign step 1 (which forces it
  // and has no picker) and the panel showing a record already AT that stage
  // (disabled, never blank).
  const destStages = rawDestStages.filter(
    (s2) => s2.name.trim().toUpperCase() !== "REASSIGN",
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

  // ITEM 1 — WARN, DON'T BLOCK.
  //
  // Only 4 of 25 users are mapped, so hiding unmapped owners would leave most
  // pipelines offering a single choice. And the orphan problem was never that
  // the assignment happened — it was that NOBODY KNEW. A follower can already
  // be anyone regardless of access, and both grant visibility, so blocking here
  // would also make the model incoherent.
  //
  // `divisions` holds DIVISION labels (from the access map), not pipeline
  // names, so the destination is matched on its division label too — that is
  // the same string userDivisions() produces.
  // Matched on the PIPELINE ID the record is going to. A user with no
  // `pipelineIds` array at all means the payload didn't tell us — say nothing
  // rather than accuse someone of missing access we never actually checked.
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
          toPipelineId,
          // Stage is chosen only on the simple path; a transfer always lands in
          // TRANSFERRED IN (the server resolves and enforces it).
          // Step 2 sends its chosen stage even though it IS an owner
          // change; every other transfer lets the server force TRANSFERRED IN.
          toStageId: isTransfer && !requireOwner ? undefined : toStageId,
          newOwnerId: isTransfer ? newOwnerId : undefined,
          reason: reason.trim() || undefined,
          addSenderAsFollower: isTransfer ? addSender : undefined,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok)
        throw apiError(res, j);
      // ITEM 3. This was gated on `j.record`: if the re-read after the move came
      // back empty, onMoved never fired, so the panel was never told to close
      // and kept showing the pre-move record. The move HAS happened by this
      // point — the caller must be told either way, so fall back to the record
      // we already hold rather than silently doing nothing.
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
          {/* Names what was dropped and what still has to be decided. */}
          {intro ? <div className="moveintro">{intro}</div> : null}
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
                Couldn&apos;t check the client&apos;s other cases. The move
                will still be attempted — GoHighLevel will reject it if a case
                already exists in the destination.
                <ErrorMessage error={conflictsErr} className="imeta" />
              </div>
            ) : null}

            <label>Stage</label>
            {isTransfer && requireOwner ? (
              // Step 2 picks the destination stage explicitly. TRANSFERRED IN is
              // right for a hand-off between departments; a case being CLAIMED
              // out of Reassign is going to wherever its new owner will work it.
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

          {/* Warn ONLY when access is actually lost (owner changed). */}
          {isTransfer && !newOwnerId ? (
            // ITEM 4 — an unassigned hand-off is NOT the "you lose access"
            // case. The server keeps the sender as a follower precisely so this
            // doesn't vanish from their board while it waits to be claimed, and
            // the copy has to match what actually happens.
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
            // ITEM 7 — ONE sentence, and it tracks the toggle. This block used
            // to state all three at once: "you lose access to it", a checkbox
            // saying you won't, and a note claiming the lead "does not leave the
            // originating division". The last of those is simply untrue — the
            // record moves pipeline either way; only the sender's VISIBILITY
            // differs — so it is gone rather than reworded.
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

          {/* Allowed, but said out loud — and it updates when the pipeline
              changes, because destName is in the dependency list. */}
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
                // Step 2: all three are required.
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
