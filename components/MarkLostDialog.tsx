"use client";

import { useMemo, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import type { OpportunityRecord, EditableFieldDef } from "@/lib/types";

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

  const lost = useMemo(
    () =>
      (stagesByPipeline[record.pipelineId] || []).find(
        (s) => s.name.trim().toUpperCase() === "LOST",
      ),
    [stagesByPipeline, record.pipelineId],
  );

  const reasonField = useMemo(() => {
    const lost = fieldDefs.filter(
      (d) => /lost\s*reason/i.test(d.name || "") && d.editable,
    );
    if (!lost.length) return null;
    if (lost.length === 1) return lost[0];
    const words = (record.pipelineName || "")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 2);
    const scored = lost
      .map((d) => {
        const n = (d.name || "").toLowerCase();
        return { d, score: words.filter((w) => n.includes(w)).length };
      })
      .sort((a, b) => b.score - a.score);
    return scored[0].score > 0 ? scored[0].d : null;
  }, [fieldDefs, record.pipelineName]);

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
          expectedVersion: record.version,
          stageId: lost.id,
          ...(reasonField && reason.trim()
            ? { customFields: [{ id: reasonField.id, value: reason.trim() }] }
            : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw apiError(res, j);

      if (reason.trim()) {
        try {
          await fetch(`/api/opportunities/${record.id}/notes`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              ssoKey: ssoBlob ?? undefined,
              body: `Marked LOST (sent out). Reason: ${reason.trim()}`,
            }),
          });
        } catch {

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
                    Saved to <b>{reasonField.name}</b> (this pipeline&apos;s Lost
                    Reason field) and added as a note recording who marked it
                    lost and why.
                  </>
                ) : (
                  <>
                    No Lost Reason field could be matched to{" "}
                    <b>{record.pipelineName}</b>, so the reason is saved as a{" "}
                    <b>note</b> only — we won&apos;t write it to another
                    pipeline&apos;s field.
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
