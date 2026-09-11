"use client";

import { useMemo, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import {
  CG_DIVISIONS,
  CG_DIVISION_LABELS,
  CG_WORK_STATES,
  CG_WORK_STATE_LABELS,
  pipelineForDivision,
  type CgDivision,
} from "@/lib/caregiverIntake";

// The same fixed vocabulary the import wizard writes. Free text is how one
// channel ends up counted twice.
const SOURCE_OPTIONS = [
  "Indeed",
  "Facebook",
  "Google Ads",
  "Website",
  "Referral",
  "Other",
];

/**
 * 🔴 NOT AddClientDialog UNDER A DIFFERENT NAME.
 *
 * app/page.tsx:4168 has warned since round A3 that pointing a renamed button at
 * the client dialog would file an applicant as a client, "in a pipeline they may
 * not even be able to see" — and that a button doing the wrong thing is worse
 * than no button. This is the separate piece of work that comment was holding
 * the button for: its own route, its own pipeline set, its own field set.
 *
 * ⚠️ EIGHT FIELDS. A recruiter completes compliance and availability as the
 * applicant progresses — 58 fields at the moment of entry is a form nobody
 * finishes.
 */
export default function AddCaregiverDialog({
  ssoBlob,
  pipelines,
  onClose,
  onAdded,
}: {
  ssoBlob: string | null;
  /** Caregiver pipelines only — scope:"caregiver" from the stored config. */
  pipelines: { id: string; name: string }[];
  onClose: () => void;
  onAdded: () => void;
}) {
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [source, setSource] = useState("");
  const [division, setDivision] = useState<CgDivision | "">("");
  const [workState, setWorkState] = useState("");
  const [pipelineId, setPipelineId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState("");

  // 🔴 DIVISION DRIVES THE PIPELINE, and the destination is shown before it is
  // committed. Asking both would invite a contradiction the record cannot
  // resolve: an applicant marked PRIVATE_PAY sitting in ODP DSP Applicant is
  // either a mis-tick or a deliberate exception, and nothing says which.
  const routing = useMemo(
    () => (division ? pipelineForDivision(division, pipelines) : null),
    [division, pipelines],
  );

  const canSave =
    !!(firstName.trim() || lastName.trim()) &&
    !!(email.trim() || phone.trim()) &&
    !!division &&
    // OLTL_CHC with no pipeline is blocked; REJECTED is deliberately allowed,
    // because a rejected applicant still has to exist as a contact.
    (division === "REJECTED" || !!routing?.pipelines.length) &&
    !busy;

  const save = async () => {
    setBusy(true);
    setErr(null);
    setDone("");
    try {
      const res = await fetch("/api/caregivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          source,
          division,
          workState,
          pipelineId,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(res, j);
      setDone(
        j.opportunityId
          ? `Added to ${j.pipelineName}.`
          : "Recorded as a contact. No application was created.",
      );
      onAdded();
      setTimeout(onClose, 1400);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    // ⚠️ THE SAME MODAL CHROME AS AddClientDialog — .previewmodal / .movebox /
    // .previewhead / .movebody. Two dialogs with different frames would read as
    // two apps; this is one app with two kinds of record.
    <div className="previewmodal" onClick={onClose}>
      <div
        className="movebox addbox cgadd"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add an applicant"
      >
        <div className="previewhead">
          <span className="previewname">Add an applicant</span>
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="movebody">
          <div className="irow">
            <label htmlFor="cg-first">First name</label>
            <input id="cg-first" autoFocus value={firstName} onChange={(e) => setFirst(e.target.value)} />
            <label htmlFor="cg-last">Last name</label>
            <input id="cg-last" value={lastName} onChange={(e) => setLast(e.target.value)} />
          </div>

          <div className="irow">
            <label htmlFor="cg-email">Email</label>
            <input id="cg-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <label htmlFor="cg-phone">Phone</label>
            <input id="cg-phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="ihint">
            One of email or phone is required — without either there is no way to
            contact them and no way to tell a second application from a new person.
          </div>

          <div className="irow">
            <label htmlFor="cg-src">Source</label>
            <select id="cg-src" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Where did they come from?</option>
              {SOURCE_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <label htmlFor="cg-ws">Work state</label>
            <select id="cg-ws" value={workState} onChange={(e) => setWorkState(e.target.value)}>
              <option value="">—</option>
              {CG_WORK_STATES.map((w) => (
                <option key={w} value={w}>
                  {CG_WORK_STATE_LABELS[w]}
                </option>
              ))}
            </select>
          </div>

          <div className="irow">
            <label htmlFor="cg-div">Division</label>
            <select
              id="cg-div"
              value={division}
              onChange={(e) => {
                setDivision(e.target.value as CgDivision);
                setPipelineId("");
              }}
            >
              <option value="">Choose a division…</option>
              {CG_DIVISIONS.map((d) => (
                <option key={d} value={d}>
                  {CG_DIVISION_LABELS[d]}
                </option>
              ))}
            </select>
          </div>

          {/* 🔴 THE CONSEQUENCE, BEFORE IT IS COMMITTED. The division is the
              only thing asked; where it lands is shown, not asked again. */}
          {routing ? (
            routing.contactOnly ? (
              <div className="cgroute contactonly">
                <b>Contact only — no application.</b> {routing.why}
              </div>
            ) : routing.pipelines.length === 1 ? (
              <div className="cgroute">
                Lands in <b>{routing.pipelines[0].name}</b>, at its first stage.
              </div>
            ) : routing.pipelines.length > 1 ? (
              <div className="cgroute">
                <b>{routing.pipelines.length} pipelines match this division.</b> Pick one:
                <select
                  value={pipelineId || routing.pipelines[0].id}
                  onChange={(e) => setPipelineId(e.target.value)}
                >
                  {routing.pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              // 🔴 OLTL_CHC. Said plainly rather than filed somewhere plausible
              // — putting them in PP or ODP would invent a routing decision
              // nobody has made.
              <div className="cgroute none">
                <b>No pipeline exists for {CG_DIVISION_LABELS[division as CgDivision]}.</b>{" "}
                {routing.why}
                <div className="cgroute-alt">
                  The divisions that do have one:{" "}
                  {CG_DIVISIONS.filter(
                    (d) =>
                      d !== "REJECTED" &&
                      pipelineForDivision(d, pipelines).pipelines.length,
                  )
                    .map((d) => CG_DIVISION_LABELS[d])
                    .join(" · ") || "none"}
                </div>
              </div>
            )
          ) : null}

          {err ? <ErrorMessage error={err} className="savemsg err" /> : null}
          {done ? <div className="savemsg ok">{done}</div> : null}
        </div>

        <div className="moveacts">
          <button type="button" className="ighost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="cgsave" onClick={save} disabled={!canSave}>
            {busy ? "Adding…" : "Add applicant"}
          </button>
        </div>
      </div>
    </div>
  );
}
