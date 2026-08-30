"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { failureMessage } from "@/lib/apiFetch";
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
}: {
  opportunityId: string;
  ssoBlob: string | null;
  canManage: boolean;
}) {
  const [caregivers, setCaregivers] = useState<Caregiver[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
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
      if (!res.ok) throw new Error(failureMessage(res, j));
      setCaregivers(j.caregivers || []);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
      setCaregivers([]);
    }
  }, [opportunityId, headers]);

  useEffect(() => {
    setCaregivers(null);
    setQ("");
    setHits([]);
    setActionErr(null);
    load();
  }, [load]);

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
      if (!res.ok) throw new Error(failureMessage(res, j));
      setCaregivers(j.caregivers || []);
      setQ("");
      setHits([]);
      setOpen(false);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
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
      if (!res.ok) throw new Error(failureMessage(res, j));
      setCaregivers(j.caregivers || []);
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // What the OTHER side of these relations is, from the server's direction
  // resolution. Falls back to "caregiver" only when there is nothing to go on
  // (an empty list), which is the common case on a client record.
  const otherRole: "caregiver" | "client" =
    caregivers?.find((c) => c.role)?.role ?? "caregiver";
  const plural = otherRole === "client" ? "clients" : "caregivers";
  const singular = otherRole === "client" ? "client" : "caregiver";

  return (
    <div className="cgsec">
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
        <div className="savemsg err">✗ {loadErr}</div>
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
          {actionErr ? <div className="savemsg err">✗ {actionErr}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
