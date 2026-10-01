"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { formatEastern } from "@/lib/dates";

// ═══════════════════════════════════════════════════════════════════════════
// ROUND 168 — THE RECORD FOOTER.
//
// 🔴 CREATED AND LAST UPDATED COME FROM THE BOARD PAYLOAD; "CREATED BY" DOES
// NOT, AND CANNOT. `internalSource` is only on GoHighLevel's single-record
// endpoint — probed live — so this component renders the two it already has
// IMMEDIATELY and fills the third when the fetch lands.
//
// ⚠️ THAT ORDER IS THE POINT. Waiting for the fetch to show anything would make
// a panel that opens instantly today open with a blank footer and then fill in,
// for a field nobody is waiting on. Two values are free; one costs a request.
//
// 🔴 ONE REQUEST PER PANEL OPEN, AND IT IS ABORTED IF THE PANEL CLOSES OR THE
// RECORD CHANGES. Clicking down a list of forty cards must not leave forty
// requests in flight — round 152's relation-count storm produced 13,851
// timeouts in two minutes doing exactly that, on an account whose budget is
// 100 requests per 10 seconds.
// ═══════════════════════════════════════════════════════════════════════════

export default function RecordFooter({
  opportunityId,
  ssoBlob,
  createdAt,
  updatedAt,
}: {
  opportunityId: string;
  ssoBlob: string | null;
  /** From the board payload — rendered with no fetch. "" when GHL sent none. */
  createdAt?: string;
  /** GoHighLevel's `updatedAt`, carried as `version` for the write check. */
  updatedAt?: string;
}) {
  const [createdBy, setCreatedBy] = useState<string>("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "failed">("idle");
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!opportunityId) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setCreatedBy("");
    setState("loading");
    void (async () => {
      try {
        // ⚠️ `apiFetch` RETURNS THE PARSED BODY AND THROWS ON A NON-2xx —
        // it is not `fetch`. Treating it as a Response is how a 403 would have
        // read as a successful empty footer.
        const j = await apiFetch<{ createdBy?: string }>(
          `/api/opportunities/${encodeURIComponent(opportunityId)}/footer`,
          { ssoBlob, signal: ac.signal },
        );
        if (ac.signal.aborted) return;
        setCreatedBy(String(j?.createdBy || ""));
        setState("done");
      } catch {
        // ⚠️ AN ABORT IS NOT A FAILURE. It is the panel closing, which is the
        // normal case when somebody clicks through a list.
        if (!ac.signal.aborted) setState("failed");
      }
    })();
    return () => ac.abort();
  }, [opportunityId, ssoBlob]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(opportunityId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // ⚠️ SAYS NOTHING RATHER THAN LYING. The clipboard is blocked in some
      // embedded contexts, and this app runs inside a GoHighLevel iframe. A
      // "Copied" that did not copy is worse than a button that did nothing
      // visible — the id is on screen and selectable either way.
    }
  };

  const created = formatEastern(createdAt);
  const updated = formatEastern(updatedAt);

  return (
    <div className="recfoot">
      {created ? (
        <div className="recfootrow">
          <span className="recfootk">Created on</span>
          <span className="recfootv">{created}</span>
        </div>
      ) : null}
      {/* 🔴 NOTHING AT ALL WHEN GOHIGHLEVEL SENT NO internalSource. Not
          "Unknown", which is a claim about the record, and not a guess from its
          owner or its age. An absent row is the honest answer.
          ⚠️ AND NOTHING WHILE IT IS IN FLIGHT EITHER — a row that appears a
          moment later is better than one that says "…" and then changes. */}
      {state === "done" && createdBy ? (
        <div className="recfootrow">
          <span className="recfootk">Created by</span>
          <span className="recfootv">{createdBy}</span>
        </div>
      ) : null}
      {updated ? (
        <div className="recfootrow">
          <span className="recfootk">Last updated</span>
          <span className="recfootv">{updated}</span>
        </div>
      ) : null}
      <div className="recfootrow">
        <span className="recfootk">Record ID</span>
        <span className="recfootv recfootid">
          <code>{opportunityId}</code>
          <button type="button" className="recfootcopy" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      </div>
      {/* ⚠️ ONE LABEL FOR THE WHOLE BLOCK, not "(EDT)" on every row — the zone
          is already on each timestamp, and this says why it is that zone rather
          than the reader's own. */}
      <div className="recfoothint">
        Times are Eastern, matching GoHighLevel.
      </div>
      {state === "failed" ? (
        <div className="recfoothint recfootbad">
          ⚠️ &ldquo;Created by&rdquo; could not be read. The rest of this footer
          comes from the record list and is unaffected.
        </div>
      ) : null}
    </div>
  );
}
