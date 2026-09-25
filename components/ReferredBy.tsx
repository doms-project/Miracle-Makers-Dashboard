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
  /**
   * 🔴 HOW MANY PARTNERS THIS VIEWER MAY NOT SEE — round 148.
   *
   * ⚠️ IT ONLY EVER CHANGES A SENTENCE, and that is the point: the list being
   * empty is the same shape whether the account has no partners or this viewer
   * holds no division, and those two need opposite advice. The route has sent
   * this count since task 2 · §4; nothing read it until a sweep looked for
   * consumers of a list that had started being filtered.
   */
  const [withheld, setWithheld] = useState(0);
  const [loadErr, setLoadErr] = useState("");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const box = useRef<HTMLDivElement | null>(null);
  /** Which load() is current — see the sequence guard inside it. */
  const loadSeq = useRef(0);

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
    // 🔴 SEQUENCED — round 111 verification sweep. `if (partners) return` looks
    // like a once-only guard, and it is NOT one while the first load is still in
    // flight: `ssoBlob` going null → blob rebuilds this callback and re-fires the
    // effect with `partners` still null. Two requests, the first without a
    // credential, and the loser used to win — so a 401 could blank a list that
    // had just loaded and print "Couldn't load partners — Sign-in required"
    // under a search box. The reported bug, in a dropdown.
    const seq = ++loadSeq.current;
    const isCurrent = () => seq === loadSeq.current;
    try {
      // 🔴 `withheld` IS READ NOW — round 148. The route has sent it since 143
      // and nothing consumed it, so this picker spent two rounds telling a
      // scoped viewer that no referral partners exist on an account with five.
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
      // 🔴 NAMED, NOT SWALLOWED. Without this the row would read "—" for a
      // record that genuinely has a partner set, which is the same lie as
      // finding 16.
      setLoadErr(e instanceof Error ? e.message : String(e));
      // ⚠️ Resolve the loading sentinel WITHOUT discarding a list that already
      // loaded. `null` means "not asked yet" and the picker would otherwise say
      // "Loading partners…" for ever; a plain `setPartners([])` would throw away
      // names that are still perfectly good.
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
            {/* A failed RELOAD sits above the names it failed to replace. Only
                a failure with nothing loaded takes the whole list's place. */}
            {loadErr && partners?.length ? (
              <div className="refbyempty">Couldn&apos;t refresh — {loadErr}</div>
            ) : null}
            {partners === null ? (
              <div className="refbyempty">Loading partners…</div>
            ) : loadErr && !partners.length ? (
              <div className="refbyempty">Couldn&apos;t load partners — {loadErr}</div>
            ) : !hits.length ? (
              <div className="refbyempty">
                {/* 🔴 ROUND 148 — THREE STATES, BECAUSE THERE ARE THREE.
                    This tested `partners.length` alone, which meant "the
                    account has none" until task 2 · §4 filtered this endpoint
                    by division. After that, zero meant "none IN YOUR SCOPE" —
                    and the sentence still read "No referral partners exist
                    yet. Add one in the Referrals section."

                    ⚠️ THE ADVICE WAS WORSE THAN THE SENTENCE. Following it
                    creates a duplicate of a partner that already exists and
                    that this viewer simply cannot see.

                    🔴 THIRD INSTANCE OF ONE PATTERN — after the dangling count
                    and the Sources empty state. A client-side emptiness test
                    whose meaning the server changed underneath it, and which
                    the client cannot recover on its own: only the COUNT beside
                    the list can tell an absence from a filter. */}
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
