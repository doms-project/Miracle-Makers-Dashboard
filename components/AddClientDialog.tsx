"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import UserPicker, { type PickableUser } from "./UserPicker";
import { divisionLabel } from "@/lib/division";
import type { ContactMatch, EditableFieldDef } from "@/lib/types";

const norm = (s: string): string => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const DETAIL_FIELDS = ["Office", "County", "Referral Source Type"];

function DetailField({
  def,
  value,
  onChange,
}: {
  def: EditableFieldDef;
  value: string | string[];
  onChange: (v: string | string[]) => void;
}) {
  const t = (def.dataType || "").toUpperCase();
  const cur = Array.isArray(value) ? value : value ? [value] : [];

  if ((t === "MULTIPLE_OPTIONS" || t === "CHECKBOX") && def.options.length)
    return (
      <div className="multi">
        {def.options.map((o) => {
          const on = cur.includes(o);
          return (
            <label key={o} className={`chipbox ${on ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={on}
                onChange={() =>
                  onChange(on ? cur.filter((x) => x !== o) : [...cur, o])
                }
              />
              {o}
            </label>
          );
        })}
      </div>
    );

  if (t === "SINGLE_OPTIONS" && def.options.length)
    return (
      <select
        value={Array.isArray(value) ? value[0] || "" : value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {def.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );

  return (
    <>
      <input
        value={Array.isArray(value) ? value.join(", ") : value}
        onChange={(e) => onChange(e.target.value)}
      />
      {t.includes("OPTIONS") ? (
        <div className="imeta">
          No options came back from GoHighLevel for this field — anything typed
          here may not match its picklist.
        </div>
      ) : null}
    </>
  );
}

export default function AddClientDialog({
  pipelines,
  stagesByPipeline,
  users,
  fieldDefs,
  viewerId,
  viewerName,
  isAdmin,
  homePipelineIds,
  ssoBlob,
  onClose,
  onCreated,
}: {
  pipelines: { id: string; name: string }[];
  stagesByPipeline: Record<string, { id: string; name: string }[]>;
  users: PickableUser[];
  fieldDefs: EditableFieldDef[];
  viewerId: string;
  viewerName: string;
  isAdmin: boolean;
  homePipelineIds: string[];
  ssoBlob: string | null;
  onClose: () => void;
  onCreated: (opportunityId: string) => void;
}) {

  const allowed = useMemo(() => {
    if (isAdmin) return pipelines;
    const home = new Set(homePipelineIds);
    const mine = pipelines.filter((p) => home.has(p.id));
    return mine.length ? mine : pipelines;
  }, [isAdmin, pipelines, homePipelineIds]);

  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [pipelineId, setPipelineId] = useState(allowed[0]?.id || "");
  const [stageId, setStageId] = useState("");
  const [ownerId, setOwnerId] = useState(isAdmin ? viewerId : viewerId);
  const [oppName, setOppName] = useState("");
  const [oppNameTouched, setOppNameTouched] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const [details, setDetails] = useState<Record<string, string | string[]>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const [matches, setMatches] = useState<ContactMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [chosen, setChosen] = useState<ContactMatch | null>(null);

  const [dismissed, setDismissed] = useState(false);

  const detailDefs = useMemo(
    () =>
      DETAIL_FIELDS.map((n) =>
        fieldDefs.find((d) => norm(d.name) === norm(n)),
      ).filter(Boolean) as EditableFieldDef[],
    [fieldDefs],
  );

  const destStages = stagesByPipeline[pipelineId] || [];
  const destName = allowed.find((p) => p.id === pipelineId)?.name || "";
  const division = divisionLabel(destName);

  useEffect(() => {
    const uncat = destStages.find(
      (s) => s.name.trim().toLowerCase().replace(/[^a-z0-9]/g, "") === "uncategorized",
    );
    setStageId(uncat?.id || destStages[0]?.id || "");
  }, [pipelineId]); // eslint-disable-line react-hooks/exhaustive-deps

  const defaultOppName = `${first} ${last}`.trim();
  useEffect(() => {
    if (!oppNameTouched) setOppName(defaultOppName);
  }, [defaultOppName, oppNameTouched]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchSeq = useRef(0);
  useEffect(() => {
    if (chosen || dismissed) return;
    const q = (phone || email || defaultOppName).trim();
    if (q.length < 3) {
      setMatches([]);
      return;
    }
    if (timer.current) clearTimeout(timer.current);

    const seq = ++searchSeq.current;
    const isCurrent = () => seq === searchSeq.current;
    timer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(
          `/api/clients/search?q=${encodeURIComponent(q)}`,
          { headers: ssoBlob ? { "x-ghl-sso-key": ssoBlob } : {}, cache: "no-store" },
        );
        const j = (await res.json().catch(() => ({}))) as {
          matches?: ContactMatch[];
        };
        if (!isCurrent()) return;
        setMatches(res.ok ? j.matches || [] : []);
      } catch {
        if (isCurrent()) setMatches([]);
      } finally {
        if (isCurrent()) setSearching(false);
      }
    }, 400);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [phone, email, defaultOppName, chosen, dismissed, ssoBlob]);

  const blockedPipelines = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of chosen?.pipelines || [])
      m.set(p.pipelineId, `${p.pipelineName}${p.stage ? ` (${p.stage})` : ""}`);
    return m;
  }, [chosen]);
  const blocked = blockedPipelines.get(pipelineId) || null;

  const reachable = !!phone.trim() || !!email.trim();
  const canSubmit =
    !!first.trim() && !!last.trim() && reachable && !!pipelineId && !!stageId && !blocked;

  const [assign, setAssign] = useState<{
    oppId: string;
    state: "waiting" | "assigned" | "nobody";
    name?: string;
  } | null>(null);

  const watchOwner = async (oppId: string) => {
    const waits = [2000, 3000, 5000, 10000, 10000];
    for (let i = 0; i <= waits.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, waits[i - 1]));
      try {
        const res = await fetch(
          `/api/opportunities/${encodeURIComponent(oppId)}/owner`,
          { headers: ssoBlob ? { "x-ghl-sso-key": ssoBlob } : {}, cache: "no-store" },
        );
        const j = (await res.json().catch(() => ({}))) as {
          ownerId?: string;
          ownerName?: string;
        };
        if (res.ok && j.ownerId) {
          setAssign({
            oppId,
            state: "assigned",

            name: j.ownerName || "Someone (their name could not be looked up)",
          });
          return;
        }
      } catch {

      }
    }
    setAssign({ oppId, state: "nobody" });
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ssoBlob ? { "x-ghl-sso-key": ssoBlob } : {}),
        },
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          firstName: first.trim(),
          lastName: last.trim(),
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          pipelineId,
          stageId,

          assignedTo: isAdmin ? ownerId || undefined : undefined,
          oppName: oppName.trim() || undefined,
          contactId: chosen?.id,

          details: Object.fromEntries(
            Object.entries(details).filter(([, v]) =>
              Array.isArray(v) ? v.length : String(v).trim(),
            ),
          ),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        opportunityId?: string;
        ownerAuthor?: "workflow" | "request";
        error?: string;
        detail?: string;
      };
      if (!res.ok || !j.ok)
        throw apiError(res, j);
      const oppId = j.opportunityId || "";
      onCreated(oppId);

      if (oppId && j.ownerAuthor === "workflow") {
        setAssign({ oppId, state: "waiting" });
        void watchOwner(oppId);
        return;
      }
      onClose();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="previewmodal" onClick={onClose}>
      <div className="movebox addbox" onClick={(e) => e.stopPropagation()}>
        <div className="previewhead">
          <span className="previewname">Add a new lead</span>
          <button className="x" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="movebody">
          <div className="imeta" style={{ marginTop: 0 }}>

            Creates the lead and their case. Who it is assigned to is decided by
            the pipeline&apos;s workflow in GoHighLevel
            {isAdmin ? ", unless you pick an owner below" : ""} — this screen
            will show you the result.
          </div>

          <div className="addsec">Lead</div>
          <div className="addgrid">
            <div className="f">
              <label>First name *</label>
              <input value={first} onChange={(e) => setFirst(e.target.value)} />
            </div>
            <div className="f">
              <label>Last name *</label>
              <input value={last} onChange={(e) => setLast(e.target.value)} />
            </div>
            <div className="f">
              <label>Phone</label>
              <input
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setDismissed(false);
                }}
              />
            </div>
            <div className="f">
              <label>Email</label>
              <input
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setDismissed(false);
                }}
              />
            </div>
          </div>

          {!reachable ? (
            <div className="rfdhint rfdbad">
              ⚠️ Add a phone number or an email — we need a way to reach them.
              A lead with neither cannot be followed up, and GoHighLevel will
              not store a contact without one.
            </div>
          ) : null}

          {searching && !chosen ? (
            <div className="imeta">Checking for an existing lead…</div>
          ) : null}
          {!chosen && !dismissed && matches.length ? (
            <div className="dupbox">
              <b>{matches[0].name}</b> already exists
              {matches[0].email ? ` (${matches[0].email})` : ""}
              {matches.length > 1 ? `, and ${matches.length - 1} more match` : ""}.
              <div className="dupacts">
                <button
                  type="button"
                  className="ighost"
                  onClick={() => {
                    const m = matches[0];
                    setChosen(m);
                    const parts = m.name.split(/\s+/);
                    if (!first.trim()) setFirst(parts.shift() || "");
                    if (!last.trim()) setLast(parts.join(" "));
                  }}
                >
                  Use this contact
                </button>
                <button
                  type="button"
                  className="ighost"
                  onClick={() => setDismissed(true)}
                >
                  Create a new one
                </button>
              </div>
            </div>
          ) : null}
          {chosen ? (
            <div className="dupbox on">
              Using the existing contact <b>{chosen.name}</b>.
              {chosen.pipelines.length ? (
                <>
                  {" "}
                  They already have a case in{" "}
                  {chosen.pipelines.map((p) => p.pipelineName).join(", ")} — those
                  pipelines are unavailable.
                </>
              ) : null}
              <div className="dupacts">
                <button
                  type="button"
                  className="ighost"
                  onClick={() => {
                    setChosen(null);
                    setDismissed(true);
                  }}
                >
                  Use a new contact instead
                </button>
              </div>
            </div>
          ) : null}

          <div className="addsec">Case</div>
          <div className="irow" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <label>Pipeline *</label>
            {allowed.length === 1 ? (

              <div className="v ro">
                {allowed[0].name}{" "}
                <span className="readonly-note">your division</span>
              </div>
            ) : (
              <select
                value={pipelineId}
                onChange={(e) => setPipelineId(e.target.value)}
              >
                {allowed.map((p) => {
                  const b = blockedPipelines.get(p.id);
                  return (
                    <option key={p.id} value={p.id} disabled={!!b}>
                      {p.name}
                      {b ? " — already has a case for this lead" : ""}
                    </option>
                  );
                })}
              </select>
            )}
            {blocked ? (
              <div className="savemsg err" style={{ marginTop: 6 }}>
                ✗ {chosen?.name || "This lead"} already has a case in{" "}
                <b>{blocked}</b>. Pick a different pipeline, or open the existing
                case.
              </div>
            ) : null}

            <label>Stage</label>
            <select value={stageId} onChange={(e) => setStageId(e.target.value)}>
              {destStages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>

            <label>Owner</label>
            {isAdmin ? (
              <UserPicker
                users={users}
                value={ownerId}
                onChange={setOwnerId}
                placeholder="Unassigned"
              />
            ) : (
              <>
                <div className="v ro">
                  You ({viewerName || "you"})
                  <span className="readonly-note">owner</span>
                </div>
                <div className="imeta" style={{ marginTop: 4 }}>
                  To hand this to someone else, use Move once it&apos;s created.
                </div>
              </>
            )}

            <label>Division</label>
            <div className="v ro">
              {division || "—"}{" "}
              <span className="readonly-note">set from the pipeline</span>
            </div>

            <label>Case name</label>
            <input
              value={oppName}
              onChange={(e) => {
                setOppName(e.target.value);
                setOppNameTouched(true);
              }}
              placeholder={defaultOppName || "The lead's name"}
            />
          </div>

          <button
            type="button"
            className="addmore"
            onClick={() => setMoreOpen((v) => !v)}
          >
            {moreOpen ? "▾" : "▸"} Add more details
          </button>
          {moreOpen ? (
            <div className="addgrid">
              {detailDefs.length ? (
                detailDefs.map((d) => (
                  <div
                    className={`f${(d.dataType || "").toUpperCase() === "MULTIPLE_OPTIONS" ? " wide" : ""}`}
                    key={d.id}
                  >
                    <label>{d.name}</label>
                    <DetailField
                      def={d}
                      value={details[d.id] ?? ((d.dataType || "").toUpperCase() === "MULTIPLE_OPTIONS" ? [] : "")}
                      onChange={(v) =>
                        setDetails((prev) => ({ ...prev, [d.id]: v }))
                      }
                    />
                  </div>
                ))
              ) : (
                <div className="f wide">
                  <div className="imeta">
                    Office, County and Referral Source Type couldn&apos;t be
                    loaded from GoHighLevel. Add them on the record after it is
                    created.
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {err ? <ErrorMessage error={err} className="savemsg err" /> : null}

          {assign ? (
            assign.state === "waiting" ? (
              <div className="savemsg ok">
                <b>Created.</b> Assigning…
              </div>
            ) : assign.state === "assigned" ? (
              <div className="savemsg ok">
                <b>Created.</b> Assigned to <b>{assign.name}</b>.
              </div>
            ) : (

              <div className="savemsg warn">
                <b>Created, but nobody is assigned yet.</b> The workflow did not
                name an owner within 30 seconds. Assign it on the record — an
                unassigned case sits in nobody&apos;s queue.
              </div>
            )
          ) : null}

          <div className="inav">
            <button
              type="button"
              className="ighost"
              onClick={onClose}
              disabled={busy || assign?.state === "waiting"}
            >
              {assign ? "Close" : "Cancel"}
            </button>
            {assign ? null : (
              <button
                type="button"
                className="ibtn"
                disabled={busy || !canSubmit}
                onClick={submit}
              >
                {busy ? "Adding…" : "Add Lead"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
