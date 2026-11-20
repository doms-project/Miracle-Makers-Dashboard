"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/apiFetch";
import type { OpportunityRecord } from "@/lib/types";

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

  fieldId: string;
  onSave: (value: string, label: string) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [partners, setPartners] = useState<Partner[] | null>(null);

  const [withheld, setWithheld] = useState(0);
  const [loadErr, setLoadErr] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement | null>(null);

  const loadSeq = useRef(0);

  const current = String(rec.cf?.[fieldId] ?? "").trim();
  const match = partners?.find((p) => p.id === current);

  const load = useCallback(async () => {
    if (partners) return;

    const seq = ++loadSeq.current;
    const isCurrent = () => seq === loadSeq.current;
    try {

      const j = await apiFetch<{ partners: Partner[]; withheld?: number }>(
        "/api/referrals?only=partners",
        { ssoBlob },
      );
      if (!isCurrent()) return;
      setLoadErr("");
      setPartners(j.partners || []);
      setWithheld(j.withheld || 0);
    } catch (e) {
      if (!isCurrent()) return;

      setLoadErr(e instanceof Error ? e.message : String(e));

      setPartners((p) => p ?? []);
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

            {loadErr && partners?.length ? (
              <div className="refbyempty">Couldn&apos;t refresh — {loadErr}</div>
            ) : null}
            {partners === null ? (
              <div className="refbyempty">Loading partners…</div>
            ) : loadErr && !partners.length ? (
              <div className="refbyempty">Couldn&apos;t load partners — {loadErr}</div>
            ) : !hits.length ? (
              <div className="refbyempty">

                {partners.length
                  ? `No partner matches “${q.trim()}”.`
                  : withheld > 0
                    ? `No referral partner is in scope for you. ${withheld} ${withheld === 1 ? "is" : "are"} tracked on this account, in divisions you do not hold — ask an admin on Admin → Access.`
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
