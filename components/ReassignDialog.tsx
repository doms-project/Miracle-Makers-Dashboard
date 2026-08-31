"use client";

import { useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import type { OpportunityRecord } from "@/lib/types";

// ITEM 3, STEP 1 — INTO Reassign. "This isn't mine."
//
// 🔴 NO PIPELINE PICKER. The record stays in ITS OWN pipeline and moves to that
// pipeline's REASSIGN stage — every pipeline has one. The destination is
// decided at STEP 2, by whoever picks the case up. Offering a pipeline here
// implied a choice that does not exist.
//
// 🔴 IT IS A CONFIRMATION, NOT A FORM, because it CLEARS THE OWNER. An
// accidental drag loses whoever was working the case, and the previous owner is
// not recorded anywhere restorable — there is no undo. So the dialog names the
// person being removed, names the pipeline it stays in, and requires a reason.
//
// ⚠️ Never window.confirm(): in a GHL iframe it returns false with no prompt,
// and the action dies silently. That has already cost a round on this project.
export default function ReassignDialog({
  record,
  ownerName,
  ssoBlob,
  onClose,
  onDone,
}: {
  record: OpportunityRecord;
  /** The CURRENT owner's display name, or "" when the record is unowned. */
  ownerName: string;
  ssoBlob: string | null;
  onDone: (rec: OpportunityRecord) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const who = record.oppName || `${record.first} ${record.last}`.trim();

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
          // ITS OWN pipeline — this is not a move between pipelines.
          toPipelineId: record.pipelineId,
          // "" (not undefined) is what marks this an owner change to NOBODY.
          // The server treats that as a reassign: it clears the owner, adds the
          // master-view holders as followers BEFORE the stage change so the GHL
          // workflow notifies a real list, records the ids it added in
          // "Reassign Followers", and lands the record on REASSIGN.
          newOwnerId: "",
          reason: reason.trim(),
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

  return (
    <div className="previewmodal" onClick={busy ? undefined : onClose}>
      <div
        className="movebox"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
      >
        <div className="previewhead">
          <span className="previewname">Send this to Reassign?</span>
          <button
            className="x"
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="movebody">
          <div className="moveintro">
            {/* ⚠️ With no current owner the unassignment clause is dropped
                entirely — telling someone they are unassigning nobody reads as
                a bug, not as reassurance. */}
            <b>{who}</b>
            {ownerName ? (
              <>
                {" "}
                will be <b>unassigned from {ownerName}</b> and moved to
              </>
            ) : (
              <> will be moved to</>
            )}{" "}
            <b>Reassign in {record.pipelineName}</b>, where another department
            can pick it up. It will leave your board.
          </div>

          <div
            className="irow"
            style={{ flexDirection: "column", alignItems: "stretch" }}
          >
            <label>Reason</label>
            <input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this being handed on?"
            />
          </div>
          <div className="imeta">
            Required — this becomes the note the receiving department reads.
          </div>

          {err ? <ErrorMessage error={err} className="savemsg err" /> : null}

          <div className="inav">
            <button
              type="button"
              className="ighost"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ibtn danger"
              disabled={busy || !reason.trim()}
              onClick={submit}
            >
              {busy ? "Sending…" : "Send to Reassign"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
