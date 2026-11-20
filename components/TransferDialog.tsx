"use client";

import { useCallback, useEffect, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import type { OpportunityRecord } from "@/lib/types";

interface Skipped {
  model: "contact" | "opportunity";
  name: string;
  why: string;
  detail?: string;
}
interface Pre {
  ok?: boolean;
  canTransfer?: boolean;
  peer?: string;
  destination?: { pipelineName: string; stageName: string };
  closeTo?: { label: string };
  parcel?: { carried: { name: string }[]; skipped: Skipped[]; notes: string[] };
  existing?: { contactName: string; opportunityId?: string };
  refusals?: { error: string; detail: string }[];
  cannotFollow?: string[];
}
interface Done {
  ok?: boolean;
  peer?: string;
  peerOpportunityId?: string;
  destination?: { pipelineName: string; stageName: string };
  closedTo?: string;
  carried?: { name: string }[];
  skipped?: Skipped[];
  notesCopied?: number;
  steps?: string[];
}

export default function TransferDialog({
  record,
  ssoBlob,
  peerLabel,
  onClose,
  onTransferred,
}: {
  record: OpportunityRecord;
  ssoBlob: string | null;
  peerLabel: string;
  onClose: () => void;
  onTransferred: () => void;
}) {
  const [pre, setPre] = useState<Pre | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);

  useEffect(() => {
    let cancelled = false;
    const h: Record<string, string> = {};
    if (ssoBlob) h["x-ghl-sso-key"] = ssoBlob;
    fetch(`/api/opportunities/${encodeURIComponent(record.id)}/transfer`, {
      headers: h,
      cache: "no-store",
    })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setErr(j);
        else setPre(j as Pre);
      })
      .catch((e) => !cancelled && setErr(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [record.id, ssoBlob]);

  const send = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/opportunities/${encodeURIComponent(record.id)}/transfer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ssoKey: ssoBlob ?? undefined, confirm: true }),
        },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j);

        if (j?.steps) setDone(j as Done);
        return;
      }
      setDone(j as Done);
      onTransferred();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  }, [record.id, ssoBlob, onTransferred]);

  const skipped = done?.skipped ?? pre?.parcel?.skipped ?? [];
  const carried = done?.carried ?? pre?.parcel?.carried ?? [];

  return (
    <div className="previewmodal" onClick={onClose}>
      <div className="movebox" onClick={(e) => e.stopPropagation()}>
        <div className="previewhead">
          <span className="previewname">
            Transfer {record.oppName || `${record.first} ${record.last}`.trim()} to{" "}
            {peerLabel}
          </span>
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="movebody">
          {loading ? (
            <div className="tfnote">Reading both accounts…</div>
          ) : null}

          {err ? <ErrorMessage error={err} /> : null}

          {done?.steps?.length ? (
            <>
              <div className={done.ok ? "tfok" : "tfbad"}>
                {done.ok
                  ? `Sent to ${done.peer}.`
                  : "The transfer stopped partway. This is what happened:"}
              </div>
              <ol className="tfsteps">
                {done.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </>
          ) : null}

          {pre && !done ? (
            <>
              {pre.refusals?.length ? (
                pre.refusals.map((r, i) => (
                  <div className="tfrefuse" key={i}>
                    <b>{r.error}</b>
                    <div>{r.detail}</div>
                  </div>
                ))
              ) : (
                <div className="tfroute">
                  <div>
                    <span className="tflabel">Lands in</span>
                    <b>
                      {pre.destination?.pipelineName} · {pre.destination?.stageName}
                    </b>
                  </div>

                  <div className="hint">
                    Never at the stage it left — {peerLabel} has not verified the
                    work behind it, so it arrives in their tray.
                  </div>
                  <div>
                    <span className="tflabel">Closes here at</span>
                    <b>{pre.closeTo?.label}</b>
                    <span className="hint"> — not deleted. The record is the evidence of the work done on it.</span>
                  </div>
                </div>
              )}

              {pre.existing && !pre.refusals?.length ? (
                <div className="tfnote">
                  <b>{pre.existing.contactName}</b> is already a contact on{" "}
                  {peerLabel}. They will be updated rather than duplicated.
                </div>
              ) : null}
            </>
          ) : null}

          {pre && (!pre.refusals?.length || done) ? (
            <>

              {!carried.length ? (
                <div className="tfnote">
                  <b>No custom fields {done ? "carried" : "will carry"}.</b> Every
                  answer on this record is in a field {peerLabel} does not have —
                  which is usually correct rather than a fault. The person, the
                  case name, its value and the notes still go.
                </div>
              ) : null}
              <div className="tfcount">
                <b>{carried.length}</b> field{carried.length === 1 ? "" : "s"}{" "}
                {done ? "carried" : "will carry"}
                {pre.parcel?.notes.length ? (
                  <>
                    {" · "}
                    <b>{done?.notesCopied ?? pre.parcel.notes.length}</b> note
                    {(done?.notesCopied ?? pre.parcel.notes.length) === 1 ? "" : "s"}
                  </>
                ) : null}
                {skipped.length ? (
                  <>
                    {" · "}
                    <b>{skipped.length}</b> skipped
                  </>
                ) : null}
              </div>

              {skipped.length ? (
                <details className="tfskip">
                  <summary>
                    {skipped.length} field{skipped.length === 1 ? "" : "s"} not
                    carried — every one named
                  </summary>
                  <ul>
                    {skipped.map((s) => (
                      <li key={`${s.model}:${s.name}`}>
                        <b>{s.name}</b>{" "}
                        <span className="tfwhy">{s.why}</span>
                        {s.detail ? <div className="hint">{s.detail}</div> : null}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

              <div className="tfcannot">
                <b>What cannot follow, whatever happens:</b>
                <ul>
                  {(pre.cannotFollow || []).map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </div>
            </>
          ) : null}
        </div>

        <div className="moveacts">
          {done ? (
            <button type="button" className="cgsave" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button type="button" className="ighost" onClick={onClose} disabled={busy}>
                Cancel
              </button>

              {!loading && pre && !pre.canTransfer ? (
                <span className="tfwhynot">{pre.refusals?.[0]?.error}</span>
              ) : null}
              <button
                type="button"
                className="cgsave"
                onClick={() => void send()}
                disabled={busy || loading || !pre?.canTransfer}
                title={
                  pre?.canTransfer
                    ? `Creates this person and case on ${peerLabel}, then closes this one`
                    : pre?.refusals?.[0]?.detail || "Nothing can be sent yet"
                }
              >
                {busy ? "Sending…" : `Send to ${peerLabel}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
