"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";

interface Partner {
  id: string;
  org: string;
}

let cached: Promise<Partner[]> | null = null;

const refreshedFor = new Set<string>();

function loadPartners(ssoBlob: string | null, fresh = false): Promise<Partner[]> {
  if (!cached || fresh) {
    cached = apiFetch<{ partners?: Partner[] }>("/api/referrals?only=partners", { ssoBlob })
      .then((j) => j.partners || [])
      .catch((e) => {
        cached = null;
        throw e;
      });
  }
  return cached;
}

type State =
  | { kind: "loading" }
  | { kind: "found"; name: string }
  | { kind: "missing" }
  | { kind: "error" };

export default function PartnerName({
  id,
  ssoBlob,
  hint,
}: {

  id: string;
  ssoBlob: string | null;

  hint: string;
}) {
  const value = String(id || "").trim();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!value) return;
    let live = true;
    setState({ kind: "loading" });
    (async () => {
      try {
        let list = await loadPartners(ssoBlob);
        let p = list.find((x) => x.id === value);
        if (!p && !refreshedFor.has(value)) {
          refreshedFor.add(value);
          list = await loadPartners(ssoBlob, true);
          p = list.find((x) => x.id === value);
        }
        if (!live) return;
        setState(p ? { kind: "found", name: p.org } : { kind: "missing" });
      } catch {
        if (live) setState({ kind: "error" });
      }
    })();
    return () => {
      live = false;
    };
  }, [value, ssoBlob]);

  return (
    <div className="v ro">
      {!value ? (
        "—"
      ) : state.kind === "found" ? (
        <span className="partnername">{state.name}</span>
      ) : state.kind === "loading" ? (
        <span className="muted">…</span>
      ) : state.kind === "missing" ? (

        <span className="muted" title={value}>
          a partner not in your list
        </span>
      ) : (
        <span className="muted" title={value}>
          couldn&apos;t load the partner&apos;s name
        </span>
      )}{" "}
      <span className="readonly-note">{hint}</span>
    </div>
  );
}
