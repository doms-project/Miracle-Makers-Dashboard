"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import type { Caregiver } from "@/lib/types";

const LOCATION_ID =
  process.env.NEXT_PUBLIC_GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X";
// DELIBERATELY NOT hidden from reps, unlike the panel's "Open in GoHighLevel"
// link. That one targets /opportunities/ — the module reps are having switched
// off. This targets /contacts/detail/, which is a SEPARATE GoHighLevel module
// with its own permission, and a rep who has lost Opportunities may well keep
// Contacts. Hiding it on the assumption they lost both would remove a working
// link and leave the caregiver name unopenable for no reason.
//
// If reps also lose Contacts, this needs the same treatment — that is an account
// setting, not something the code can determine.
const contactUrl = (contactId: string) =>
  `https://app.gohighlevel.com/v2/location/${LOCATION_ID}/contacts/detail/${contactId}`;

type SearchHit = { id: string; name: string; email: string };

// Task 4 — view + manage the caregivers associated with an enrollment's client
// contact. Add is a searchable typeahead (caregiver contacts only); remove
// unlinks the relation. All writes go through the visibility-gated API.
// BUG 1 — the association is DIRECTIONAL, and this section used to ignore that.
// It listed "whichever contact isn't me" and always called them caregivers, so
// opening a CAREGIVER's record showed their CLIENTS under a "Caregivers"
// heading. Every label here now follows the resolved role.
export default function CaregiversSection({
  opportunityId,
  ssoBlob,
  canManage,
  selfRole,
  panelReady,
}: {
  opportunityId: string;
  ssoBlob: string | null;
  canManage: boolean;
  // ITEM 1 — true once the panel ABOVE this section has finished loading and
  // laid out. Visibility alone is not a usable trigger: at mount the contact
  // sections do not exist yet, so this section sits high in a short panel and
  // is genuinely on screen — the observer fired immediately and the lazy-load
  // did nothing. Measured, not assumed: the caregivers call still went out at
  // +90ms with the observer in place. So visibility is only consulted once the
  // panel is its real height.
  panelReady?: boolean;
  // ITEM 2 — THIS record's own role, decided by the caller from which payload
  // the record came out of. See the note on `otherRole` below for why it had to
  // be passed in rather than inferred here.
  selfRole?: "caregiver" | "client";
}) {
  const [caregivers, setCaregivers] = useState<Caregiver[] | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [actionErr, setActionErr] = useState<unknown>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (ssoBlob) h["x-ghl-sso-key"] = ssoBlob;
    return h;
  }, [ssoBlob]);

  const load = useCallback(async () => {
    setLoadErr(null);
    try {
      const res = await fetch(
        `/api/opportunities/${opportunityId}/caregivers`,
        { headers: headers(), cache: "no-store" },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(res, j);
      setCaregivers(j.caregivers || []);
    } catch (e) {
      setLoadErr(e);
      setCaregivers([]);
    }
  }, [opportunityId, headers]);

  // ITEM 1 — LAZY. This section sits at the BOTTOM of a 58-field panel, below
  // fourteen day-dropdowns, and most opens never scroll to it — yet it fired a
  // GoHighLevel /associations/relations call the instant the panel mounted,
  // alongside notes and the contact fields. Three requests at once against a
  // 100-per-10s budget is how the 429 arrived, and it arrived HERE because this
  // is simply the call that lost the race.
  //
  // Nothing is fetched until the section is actually scrolled into view. An
  // open that never reaches it costs zero GHL calls.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    setSeen(false);
  }, [opportunityId]);

  useEffect(() => {
    if (seen) return;
    if (panelReady === false) return; // panel still growing — measuring now is meaningless
    const el = hostRef.current;
    if (!el) return;
    // No IntersectionObserver (old webview, jsdom) → fall back to eager, which
    // is exactly the old behaviour. Degrade to slower, never to broken.
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      // A little early, so the list is usually there by the time it is read.
      { root: null, rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, opportunityId, panelReady]);

  useEffect(() => {
    setCaregivers(null);
    setQ("");
    setHits([]);
    setActionErr(null);
    if (!seen) return;
    load();
  }, [load, seen]);

  // Debounced typeahead search.
  useEffect(() => {
    if (!canManage) return;
    if (debounce.current) clearTimeout(debounce.current);
    if (!q.trim()) {
      setHits([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/api/opportunities/${opportunityId}/caregivers/search?q=${encodeURIComponent(
            q.trim(),
          )}`,
          { headers: headers(), cache: "no-store" },
        );
        const j = await res.json().catch(() => ({}));
        if (res.ok) setHits(j.results || []);
      } catch {
        /* ignore transient search errors */
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [q, canManage, opportunityId, headers]);

  const alreadyLinked = new Set((caregivers || []).map((c) => c.contactId));

  const add = async (hit: SearchHit) => {
    setActionErr(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/opportunities/${opportunityId}/caregivers`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ ssoKey: ssoBlob ?? undefined, caregiverContactId: hit.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(res, j);
      setCaregivers(j.caregivers || []);
      setQ("");
      setHits([]);
      setOpen(false);
    } catch (e) {
      setActionErr(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: Caregiver) => {
    setActionErr(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/opportunities/${opportunityId}/caregivers`, {
        method: "DELETE",
        headers: headers(),
        body: JSON.stringify({ ssoKey: ssoBlob ?? undefined, relationId: c.relationId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(res, j);
      setCaregivers(j.caregivers || []);
    } catch (e) {
      setActionErr(e);
    } finally {
      setBusy(false);
    }
  };

  // What the OTHER side of these relations is, from the server's direction
  // resolution. Falls back to "caregiver" only when there is nothing to go on
  // (an empty list), which is the common case on a client record.
  // 🔴 REPORT 29'S FIX WAS ONLY EVER HALF-WORKING, and this is why.
  //
  // It read the direction out of the RELATIONS LIST — fine on a record with at
  // least one link, but on an applicant with no linked clients the list is
  // empty, the `?? "caregiver"` default won, and a caregiver's own record was
  // headed "Caregivers". Exactly the bug 29 set out to fix, still happening on
  // the records most likely to hit it: brand-new applicants, who have no
  // relations yet.
  //
  // The record's OWN role is known for certain from which payload it came out
  // of, so it is passed in and WINS. The list is kept only as a fallback for a
  // caller that doesn't supply it — direction is a fact about this record, not
  // something to infer from data that may not exist.
  const otherRole: "caregiver" | "client" = selfRole
    ? selfRole === "caregiver"
      ? "client"
      : "caregiver"
    : (caregivers?.find((c) => c.role)?.role ?? "caregiver");
  const plural = otherRole === "client" ? "clients" : "caregivers";
  const singular = otherRole === "client" ? "client" : "caregiver";

  return (
    <div className="cgsec" ref={hostRef}>
      {/* Direction decides the heading: this record is in the caregiver slot ->
          the other side is a CLIENT, and vice versa. */}
      <div className="sechead cghead">
        {otherRole === "client" ? "Clients" : "Caregivers"}
        {caregivers?.length ? (
          <span className="cgcount">{caregivers.length}</span>
        ) : null}
      </div>
      {caregivers === null ? (
        <div className="cgmuted">Loading…</div>
      ) : loadErr ? (
        <ErrorMessage error={loadErr} className="savemsg err" />
      ) : caregivers.length === 0 ? (
        <div className="cgmuted">No caregivers assigned yet.</div>
      ) : (
        <ul className="cglist">
          {caregivers.map((c) => (
            <li key={c.relationId || c.contactId} className="cgitem">
              <a
                href={contactUrl(c.contactId)}
                target="_blank"
                rel="noopener noreferrer"
                className="cgname"
              >
                {c.name} ↗
              </a>
              {canManage ? (
                <button
                  type="button"
                  className="cgremove"
                  disabled={busy}
                  onClick={() => remove(c)}
                  aria-label={`Remove ${c.name}`}
                  title={`Remove ${singular}`}
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <div className="cgadd">
          <input
            className="cgsearch"
            placeholder="Add a caregiver — type a name…"
            value={q}
            disabled={busy}
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
          />
          {open && q.trim() ? (
            <div className="cgresults">
              {searching ? (
                <div className="cgmuted" style={{ padding: "8px 10px" }}>
                  Searching…
                </div>
              ) : hits.length === 0 ? (
                <div className="cgmuted" style={{ padding: "8px 10px" }}>
                  No caregiver contacts match.
                </div>
              ) : (
                hits.map((h) => {
                  const linked = alreadyLinked.has(h.id);
                  return (
                    <button
                      key={h.id}
                      type="button"
                      className="cghit"
                      disabled={busy || linked}
                      onClick={() => add(h)}
                    >
                      <span className="cghitname">{h.name}</span>
                      {h.email ? <span className="cghitmeta">{h.email}</span> : null}
                      {linked ? <span className="cghitmeta">· already added</span> : null}
                    </button>
                  );
                })
              )}
            </div>
          ) : null}
          {actionErr ? <ErrorMessage error={actionErr} className="savemsg err" /> : null}
        </div>
      ) : null}
    </div>
  );
}
