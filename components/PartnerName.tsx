"use client";
// ---------------------------------------------------------------------------
// ROUND 185 — A PARTNER FIELD SHOWS THE PARTNER, NOT THEIR CONTACT ID.
//
// `Referring Partner` and `Event Host` are opportunity fields holding a
// partner's CONTACT ID as text (lib/referrals.ts explains why). Wherever a
// pipeline's sections include them, the record panel rendered them as plain
// text boxes, so a rep read "UNteOXSqlspOXjQ6DCK0" and could not tell who
// referred the client — and could type over it and break the referral.
//
// This shows the partner's name, read-only, with where to change it. The
// value is still set where it always was: "Referred by" at the top of a client
// record, or the Referrals screen.
//
// ⚠️ ONE PARTNER LIST PER PAGE LOAD. It is the same `?only=partners` call the
// "Referred by" picker makes, cached here so a panel with two partner fields,
// or a rep clicking through twenty records, costs one request. An id not in the
// cached list is re-asked ONCE PER ID, for a partner created since the page
// loaded — never in a loop.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";

interface Partner {
  id: string;
  org: string;
}

let cached: Promise<Partner[]> | null = null;
/** Ids already re-asked about, so an unknown id costs one refresh, not one per render. */
const refreshedFor = new Set<string>();

function loadPartners(ssoBlob: string | null, fresh = false): Promise<Partner[]> {
  if (!cached || fresh) {
    cached = apiFetch<{ partners?: Partner[] }>("/api/referrals?only=partners", { ssoBlob })
      .then((j) => j.partners || [])
      .catch((e) => {
        cached = null; // a failure is not remembered; the next panel retries
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
  /** The stored contact id. Empty means no partner is set. */
  id: string;
  ssoBlob: string | null;
  /** Where this value is changed, shown beside it. */
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
        // Not in this viewer's partner list: deleted, or in a division they
        // cannot see. Never the raw id — the id is one hover away.
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
