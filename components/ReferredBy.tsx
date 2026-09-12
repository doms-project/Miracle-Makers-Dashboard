"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import type { OpportunityRecord } from "@/lib/types";

// ---------------------------------------------------------------------------
// REFERRED BY — attribution set AFTER the fact.
//
// 🔴 THE CASE THIS EXISTS FOR: someone fills in the website form, and mentions
// on the call that Riddle Hospital sent them. Round 103's "Log a referral"
// captures attribution at the moment of the call; nothing captured it
// afterwards, so the most common route by which a referral is learned about
// could not be recorded at all — and the partner never got credit.
//
// ⚠️ IT SETS ONE OPPORTUNITY FIELD, `Referring Partner`, holding the partner's
// CONTACT ID as text — the same shape the referral dashboard reads. No new
// field, no new join.
// ---------------------------------------------------------------------------

interface Partner {
  id: string;
  org: string;
  cat: string;
  division: string;
}

export default function ReferredBy({
  rec,
  ssoBlob,
  fieldId,
  onSave,
}: {
  rec: OpportunityRecord;
  ssoBlob: string | null;
  /** "" when this account has no Referring Partner field — then nothing renders. */
  fieldId: string;
  onSave: (value: string, label: string) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [partners, setPartners] = useState<Partner[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement | null>(null);

  const current = String(rec.cf?.[fieldId] ?? "").trim();
  const match = partners?.find((p) => p.id === current);

  /**
   * ⚠️ LAZY, AND ONCE. The partner list is one contact search; loading it for
   * every record panel that opens would spend that call on the overwhelming
   * majority of records nobody is going to attribute. It loads when the picker
   * is opened, or when a record already HAS a partner id that needs a name.
   */
  const load = useCallback(async () => {
    if (partners) return;
    try {
      const j = await apiFetch<{ partners: Partner[] }>(
        "/api/referrals?only=partners",
        { ssoBlob },
      );
      setPartners(j.partners || []);
    } catch (e) {
      // 🔴 NAMED, NOT SWALLOWED. Without this the row would read "—" for a
      // record that genuinely has a partner set, which is the same lie as
      // finding 16.
      setLoadErr(e instanceof Error ? e.message : String(e));
      setPartners([]);
    }
  }, [partners, ssoBlob]);

  useEffect(() => {
    if (current) void load();
  }, [current, load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!fieldId) return null;

  const commit = async (id: string, label: string) => {
    setBusy(true);
    setErr("");
    setOpen(false);
    try {
      await onSave(id, label);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const needle = q.trim().toLowerCase();
  const hits = (partners || []).filter(
    (p) => !needle || p.org.toLowerCase().includes(needle) || p.cat.toLowerCase().includes(needle),
  );

  return (
    <div className="refby" ref={box}>
      <div className="refbyhd">
        <span className="refbylbl">Referred by</span>
        <div className="refbyval">
          {busy ? (
            <span className="refbymuted">Saving…</span>
          ) : current && match ? (
            <span className="refbyname">{match.org}</span>
          ) : current && partners && !match ? (
            // ⚠️ A partner id that resolves to nobody: deleted, or past the
            // page cap. Say which is unknown rather than rendering "—", which
            // would read as "no referral" for a record that HAS one.
            <span className="refbymuted" title={current}>
              a partner no longer in the list
            </span>
          ) : current ? (
            <span className="refbymuted">…</span>
          ) : (
            <span className="refbymuted">Not set</span>
          )}
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              setOpen((o) => !o);
              void load();
            }}
          >
            {current ? "change" : "set"}
          </button>
        </div>
      </div>

      {open ? (
        <div className="refbypop">
          <input
            type="search"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search referral partners…"
          />
          <div className="refbylist">
            {partners === null ? (
              <div className="refbyempty">Loading partners…</div>
            ) : loadErr ? (
              <div className="refbyempty">Couldn&apos;t load partners — {loadErr}</div>
            ) : !hits.length ? (
              <div className="refbyempty">
                {partners.length
                  ? `No partner matches “${q.trim()}”.`
                  : "No referral partners exist yet. Add one in the Referrals section."}
              </div>
            ) : (
              hits.slice(0, 40).map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={p.id === current ? "refbyopt on" : "refbyopt"}
                  onClick={() => void commit(p.id, p.org)}
                >
                  <span className="n">{p.org}</span>
                  <span className="m">
                    {[p.cat, p.division].filter(Boolean).join(" · ")}
                  </span>
                </button>
              ))
            )}
          </div>
          {current ? (
            <button
              type="button"
              className="refbyclear"
              onClick={() => void commit("", "")}
            >
              Clear the attribution
            </button>
          ) : null}
        </div>
      ) : null}
      {err ? <div className="refbyerr">Not saved — {err}</div> : null}
    </div>
  );
}
