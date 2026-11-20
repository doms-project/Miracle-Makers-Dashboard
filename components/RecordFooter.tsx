"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import { formatEastern } from "@/lib/dates";

export default function RecordFooter({
  opportunityId,
  ssoBlob,
  createdAt,
  updatedAt,
}: {
  opportunityId: string;
  ssoBlob: string | null;

  createdAt?: string;

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

        const j = await apiFetch<{ createdBy?: string }>(
          `/api/opportunities/${encodeURIComponent(opportunityId)}/footer`,
          { ssoBlob, signal: ac.signal },
        );
        if (ac.signal.aborted) return;
        setCreatedBy(String(j?.createdBy || ""));
        setState("done");
      } catch {

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
