"use client";

import { useMemo, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import type { OpportunityRecord, EditableFieldDef } from "@/lib/types";

// ITEM 3 — SENT OUT.
//
// This is deliberately NOT the Move dialog. Dropping on SENT OUT changes no
// pipeline and no owner: it sets the STAGE to LOST on the record where it
// already is. Routing that through Move would mean showing a pipeline selector
// for a thing that isn't a move, and the server's move path stamps
// Transferred From / Transferred Date and writes a transfer note — none of
// which is true of a rejection.
//
// ⬜ "SENT OUT" is being treated as REJECTED, per the brief. If it turns out to
// mean something else, this dialog and the column's predicate are the only two
// places that change.
export default function MarkLostDialog({
  record,
  stagesByPipeline,
  fieldDefs,
  ssoBlob,
  onClose,
  onDone,
}: {
  record: OpportunityRecord;
  stagesByPipeline: Record<string, { id: string; name: string }[]>;
  fieldDefs: EditableFieldDef[];
  ssoBlob: string | null;
  onClose: () => void;
  onDone: (rec: OpportunityRecord) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  // The LOST stage of THIS record's own pipeline. Resolved live from the stage
  // list, never a hardcoded id — and if the pipeline hasn't got one we say so
  // instead of guessing at a stage and writing the wrong one.
  const lost = useMemo(
    () =>
      (stagesByPipeline[record.pipelineId] || []).find(
        (s) => s.name.trim().toUpperCase() === "LOST",
      ),
    [stagesByPipeline, record.pipelineId],
  );

  // A "Lost Reason" custom field if the account has one, matched BY NAME on the
  // live definitions. When it doesn't exist the reason still isn't dropped — it
  // goes on the record as a note, which is where the rest of the case history
  // already lives.
  const reasonField = useMemo(
    () =>
      fieldDefs.find(
        (d) => /lost\s*reason/i.test(d.name || "") && d.editable,
      ) || null,
    [fieldDefs],
  );

  const submit = async () => {
    if (!lost) return;
    setBusy(true);
    setErr(null);
    try {
      const headers = {
        "Content-Type": "application/json",
        ...(ssoBlob ? { "x-ghl-sso-key": ssoBlob } : {}),
      };
      const res = await fetch(`/api/opportunities/${record.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          stageId: lost.id,
          ...(reasonField && reason.trim()
            ? { customFields: [{ id: reasonField.id, value: reason.trim() }] }
            : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw apiError(res, j);

      // The note is written AFTER the stage change lands, and its failure is not
      // allowed to report the whole action as failed — the record IS lost at
      // this point, and saying otherwise would be worse than a missing note.
      if (reason.trim()) {
        try {
          await fetch(`/api/opportunities/${record.id}/notes`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              ssoKey: ssoBlob ?? undefined,
              body: `Marked LOST. Reason: ${reason.trim()}`,
            }),
          });
        } catch {
          /* the stage change is the action; the note is the record of it */
        }
      }
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
          <span className="previewname">Mark as lost</span>
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
            You&apos;re marking{" "}
            <b>{record.oppName || `${record.first} ${record.last}`.trim()}</b> as{" "}
            <b>Sent out</b> — rejected and no longer worked.
          </div>

          {!lost ? (
            <div className="savemsg err">
              ✗ <b>{record.pipelineName}</b> has no <b>LOST</b> stage, so there is
              nowhere to put this. Add one in GoHighLevel, or tell us which stage
              &ldquo;sent out&rdquo; should mean — we won&apos;t guess at a stage
              and write the wrong one.
            </div>
          ) : (
            <>
              <div
                className="irow"
                style={{ flexDirection: "column", alignItems: "stretch" }}
              >
                <label>Stage</label>
                <div className="v ro">
                  {lost.name}{" "}
                  <span className="readonly-note">
                    stays in {record.pipelineName} — the pipeline and owner
                    don&apos;t change
                  </span>
                </div>
                <label>Lost reason</label>
                <input
                  autoFocus
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why was this rejected?"
                />
              </div>
              <div className="imeta">
                {reasonField ? (
                  <>
                    Saved to the <b>{reasonField.name}</b> field and added as a
                    note.
                  </>
                ) : (
                  <>
                    This account has no <b>Lost Reason</b> field, so the reason is
                    added as a <b>note</b> on the record.
                  </>
                )}
              </div>
            </>
          )}

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
              disabled={busy || !lost || !reason.trim()}
              onClick={submit}
            >
              {busy ? "Saving…" : "Mark as lost"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
