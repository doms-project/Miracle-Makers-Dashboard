"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import type { Caregiver } from "@/lib/types";

const LOCATION_ID =
  process.env.NEXT_PUBLIC_GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X";

const contactUrl = (contactId: string) =>
  `https://app.gohighlevel.com/v2/location/${LOCATION_ID}/contacts/detail/${contactId}`;

type SearchHit = {
  id: string;
  name: string;

  pipelineName?: string;
  stage?: string;

  more?: number;
};

export default function CaregiversSection({
  opportunityId,
  ssoBlob,
  canManage,
  selfRole,
  panelReady,
  onLinksChanged,
}: {
  opportunityId: string;
  ssoBlob: string | null;
  canManage: boolean;

  panelReady?: boolean;

  selfRole?: "caregiver" | "client";

  onLinksChanged?: (links: Caregiver[], otherContactId?: string) => void;
}) {
  const [caregivers, setCaregivers] = useState<Caregiver[] | null>(null);

  const linksChangedRef = useRef(onLinksChanged);
  linksChangedRef.current = onLinksChanged;
  const [loadErr, setLoadErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);

  const [hitsWithheld, setHitsWithheld] = useState(0);

  const [labelsOut, setLabelsOut] = useState(false);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [actionErr, setActionErr] = useState<unknown>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (ssoBlob) h["x-ghl-sso-key"] = ssoBlob;
    return h;
  }, [ssoBlob]);

  const loadSeq = useRef(0);

  const load = useCallback(async () => {

    const seq = ++loadSeq.current;
    const isCurrent = () => seq === loadSeq.current;

    setLoadErr(null);
    try {
      const res = await fetch(
        `/api/opportunities/${opportunityId}/caregivers`,
        { headers: headers(), cache: "no-store" },
      );
      const j = await res.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (!res.ok) throw apiError(res, j);
      setLoadErr(null);
      setCaregivers(j.caregivers || []);

      linksChangedRef.current?.(j.caregivers || []);
    } catch (e) {
      if (!isCurrent()) return;
      setLoadErr(e);

    }
  }, [opportunityId, headers]);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    setSeen(false);
  }, [opportunityId]);

  useEffect(() => {
    if (seen) return;
    if (panelReady === false) return;
    const el = hostRef.current;
    if (!el) return;

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

  useEffect(() => {
    if (!canManage) return;
    if (debounce.current) clearTimeout(debounce.current);
    if (!q.trim()) {
      setHits([]);
      setHitsWithheld(0);
      setLabelsOut(false);
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
        if (res.ok) {
          setHits(j.results || []);
          setHitsWithheld(Number(j.withheld) || 0);
          setLabelsOut(!!j.labelsUnavailable);
        }
      } catch {

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
      linksChangedRef.current?.(j.caregivers || [], hit.id);
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
      linksChangedRef.current?.(j.caregivers || [], c.contactId);
    } catch (e) {
      setActionErr(e);
    } finally {
      setBusy(false);
    }
  };

  const otherRole: "caregiver" | "client" = selfRole
    ? selfRole === "caregiver"
      ? "client"
      : "caregiver"
    : (caregivers?.find((c) => c.role)?.role ?? "caregiver");
  const plural = otherRole === "client" ? "clients" : "caregivers";
  const singular = otherRole === "client" ? "client" : "caregiver";

  return (
    <div className="cgsec" ref={hostRef}>

      <div className="sechead cghead">
        {otherRole === "client" ? "Clients" : "Caregivers"}
        {caregivers?.length ? (
          <span className="cgcount">{caregivers.length}</span>
        ) : null}
      </div>

      {loadErr && caregivers?.length ? (
        <ErrorMessage error={loadErr} className="savemsg err" />
      ) : null}
      {caregivers === null ? (
        <div className="cgmuted">Loading…</div>
      ) : loadErr && !caregivers.length ? (
        <ErrorMessage error={loadErr} className="savemsg err" />
      ) : caregivers.length === 0 ? (
        <div className="cgmuted">No {plural} assigned yet.</div>
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
            placeholder={`Add a ${singular} — type a name…`}
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

                  {otherRole === "caregiver" ? (
                    labelsOut ? (
                      <>
                        No caregiver matches — and only half the search ran.
                        Their <b>Record Type</b> could not be read, so anyone
                        without an applicant case was not looked for.
                      </>
                    ) : (
                      "No caregiver matches."
                    )
                  ) : (
                    <>
                      No clients match
                      {hitsWithheld
                        ? ` that you can see — ${hitsWithheld} match${hitsWithheld === 1 ? "" : "es"} outside your pipeline access.`
                        : "."}
                    </>
                  )}
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

                      {h.pipelineName ? (
                        <span className="cghitmeta">
                          {h.pipelineName}
                          {h.stage ? ` · ${h.stage}` : ""}
                          {h.more ? ` · +${h.more} more case${h.more === 1 ? "" : "s"}` : ""}
                        </span>
                      ) : null}
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
