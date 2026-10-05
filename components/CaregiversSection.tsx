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

type SearchHit = {
  id: string;
  name: string;
  /**
   * 🔴 ROUND 172 — NO EMAIL AND NO PHONE, ON EITHER SIDE. This carried
   * `email` and the row printed it. A picker needs enough to tell two people
   * apart and nothing more, and the case does that better than an address
   * does. Removed from the TYPE as well as the markup so a future row cannot
   * put it back by reading a field that was still arriving.
   */
  pipelineName?: string;
  stage?: string;
  /** Cases this person holds beyond the one shown. */
  more?: number;
};

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
  // 🔴 ROUND 171 — THE STANDING CONSUMER RULE, CLIENT HALF. The route filters
  // the client list by the viewer's grants, so an empty picker has two causes
  // that look identical: nobody matches, or nobody you may see matches.
  const [hitsWithheld, setHitsWithheld] = useState(0);
  // 🔴 ROUND 172 — TRUE WHEN THE RECORD-TYPE HALF OF THE CAREGIVER SEARCH
  // COULD NOT BE READ. "No caregiver matches" is only true if both halves were
  // asked; saying it when one of them failed is a claim nobody checked.
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

  /** Which load() is current — see the sequence guard inside it. */
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    // 🔴 SEQUENCED — round 111. `headers()` depends on `ssoBlob`, so this is
    // rebuilt and re-fired when the blob lands, and `load` is also called again
    // after every link/unlink. Two in flight, and the loser used to win.
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
    } catch (e) {
      if (!isCurrent()) return;
      setLoadErr(e);
      // ⚠️ The linked caregivers stay. Emptying the list on a failed refresh
      // says "nobody is assigned to this client", which is a different and much
      // more alarming claim than "we could not check just now".
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
      {/* A failed RELOAD is shown above the list it failed to replace, not
          instead of it — the names already on screen are still the last true
          answer. Only a first load with nothing to show takes the whole slot. */}
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
                  {/* 🔴 ROUND 172 — NOBODY MATCHING MEANS NOBODY IS SHOWN.
                      The old picker answered an empty caregiver search with
                      every other match it had, which is a confident answer to
                      a different question and is how a client reached a
                      caregiver slot.
                      ⚠️ AND THE SENTENCE DIFFERS BY SIDE BECAUSE THE REASON
                      DOES: the client list is scoped to your grants (round
                      171) and the caregiver list is not scoped at all (round
                      172), so only one of them can be empty because of you. */}
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
                      {/* 🔴 THE CASE IS WHY THEY ARE IN THIS LIST AT ALL, so it
                          is shown rather than implied. Two people with the same
                          name are told apart by their pipeline and stage, and
                          nothing else here could do it. */}
                      {/* 🔴 THE CASE, AND NOTHING ELSE. It tells two people
                          with one name apart, which is all a picker needs;
                          an address, a number or a compliance flag is detail
                          this control has no business carrying. A caregiver
                          known only by their Record Type has no case to show,
                          and showing nothing is the honest rendering. */}
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
