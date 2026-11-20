"use client";

import { useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import type { OpportunityRecord } from "@/lib/types";

export default function ReassignDialog({
  record,
  ownerName,
  ssoBlob,
  onClose,
  onDone,
  stageLabel = "Staffing needed",
}: {
  record: OpportunityRecord;

  ownerName: string;
  ssoBlob: string | null;
  onDone: (rec: OpportunityRecord) => void;
  onClose: () => void;

  stageLabel?: string;
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
          expectedVersion: record.version,

          toPipelineId: record.pipelineId,

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
          <span className="previewname">Send this to {stageLabel}?</span>
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

            <b>{who}</b>
            {ownerName ? (
              <>
                {" "}
                will be <b>unassigned from {ownerName}</b> and moved to
              </>
            ) : (
              <> will be moved to</>
            )}{" "}
            <b>{stageLabel} in {record.pipelineName}</b> with no owner, where
            someone else can pick it up. It will leave your board.
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
              {busy ? "Sending…" : `Send to ${stageLabel}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
