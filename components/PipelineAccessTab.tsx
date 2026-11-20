"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import { divisionLabel } from "@/lib/division";
import { caseManagerColumns, caseManagerPreview } from "@/lib/caseManagerLabels";
import { isAdminRole } from "@/lib/adminRole";

type User = { id: string; name: string; email: string; role: string };
type Pipeline = {
  id: string;
  name: string;
  inDashboard: boolean;

  notLoadedWhy?: string;
};
type Folder = { id: string; name: string };
type Grants = Record<string, string[]>;

export default function PipelineAccessTab({
  ssoBlob,
}: {
  ssoBlob: string | null;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);

  const [partnerDivisionOptions, setPartnerDivisionOptions] = useState<string[]>([]);
  const [grants, setGrants] = useState<Grants>({});

  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderGrants, setFolderGrants] = useState<Grants>({});

  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [publicFolderId, setPublicFolderId] = useState("");

  const [masterUsers, setMasterUsers] = useState<string[]>([]);

  const [staffing, setStaffing] = useState<Record<string, "self" | "any">>({});
  const [peerTransfer, setPeerTransfer] = useState<string[]>([]);
  const [peerLabel, setPeerLabel] = useState<string>("");

  const [caseManagers, setCaseManagers] = useState<Grants>({});

  const [referralAccess, setReferralAccess] = useState<
    Record<string, { mode: "agency" } | { mode: "divisions"; divisions: string[] }>
  >({});

  const [cmView, setCmView] = useState<"manager" | "rep">("manager");

  const [cmAdding, setCmAdding] = useState<string | null>(null);
  const [cmQ, setCmQ] = useState("");

  const [cmPending, setCmPending] = useState<string | null>(null);
  const [usingEnvFallback, setUsingEnvFallback] = useState(false);
  const [loadErr, setLoadErr] = useState<unknown>(null);

  const loadSeq = useRef(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [q, setQ] = useState("");

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (ssoBlob) h["x-ghl-sso-key"] = ssoBlob;
    return h;
  }, [ssoBlob]);

  const load = useCallback(async () => {

    const seq = ++loadSeq.current;
    const isCurrent = () => seq === loadSeq.current;

    setLoading(true);
    setLoadErr(null);
    try {
      const res = await fetch("/api/admin/pipeline-access", {
        headers: headers(),
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (!res.ok) throw apiError(res, j);
      setLoadErr(null);
      setUsers(j.users || []);
      setPipelines(j.pipelines || []);
      setPartnerDivisionOptions(j.divisionOptions || []);
      setGrants(j.grants || {});
      setFolders(j.folders || []);
      setFoldersError(j.foldersError || null);
      setFolderGrants(j.folderGrants || {});
      setMasterUsers(j.masterUsers || []);
      setCaseManagers(j.caseManagers || {});
      setReferralAccess(j.referralAccess || {});
      setStaffing(j.staffing || {});
      setPeerTransfer(j.peerTransfer || []);
      setPeerLabel(j.peer?.configured ? j.peer.label || "the other company" : "");
      setPublicFolderId(j.publicFolderId || "");
      setUsingEnvFallback(!!j.usingEnvFallback);
      setDirty(false);
    } catch (e) {
      if (!isCurrent()) return;
      setLoadErr(e);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    load();
  }, [load]);

  const isAdmin = (u: User) => isAdminRole(u.role);

  const toggleIn = (
    setter: React.Dispatch<React.SetStateAction<Grants>>,
    userId: string,
    id: string,
  ) => {
    setter((prev) => {
      const cur = new Set(prev[userId] || []);
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
      const next = { ...prev };
      if (cur.size) next[userId] = [...cur];
      else delete next[userId];
      return next;
    });
    setDirty(true);
    setSaveMsg(null);
  };

  const toggle = (userId: string, pipelineId: string) =>
    toggleIn(setGrants, userId, pipelineId);
  const toggleFolder = (userId: string, folderId: string) =>
    toggleIn(setFolderGrants, userId, folderId);

  const toggleMaster = (userId: string) => {
    setMasterUsers((prev) =>
      prev.includes(userId)
        ? prev.filter((x) => x !== userId)
        : [...prev, userId],
    );
    setDirty(true);
    setSaveMsg(null);
  };

  const setStaffingFor = (userId: string, level: "off" | "self" | "any") => {
    setStaffing((prev) => {
      const next = { ...prev };
      if (level === "off") delete next[userId];
      else next[userId] = level;
      return next;
    });
    setDirty(true);
    setSaveMsg(null);
  };
  const togglePeer = (userId: string) => {
    setPeerTransfer((prev) =>
      prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId],
    );
    setDirty(true);
    setSaveMsg(null);
  };

  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch("/api/admin/pipeline-access", {
        method: "PUT",
        headers: headers(),

        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          grants,
          folderGrants,
          masterUsers,
          caseManagers,
          referralAccess,
          staffing,
          peerTransfer,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok)
        throw apiError(res, j);
      setGrants(j.grants || {});
      setFolderGrants(j.folderGrants || {});
      setMasterUsers(j.masterUsers || []);
      setCaseManagers(j.caseManagers || {});
      setReferralAccess(j.referralAccess || {});
      setStaffing(j.staffing || {});
      setPeerTransfer(j.peerTransfer || []);
      setUsingEnvFallback(false);
      setDirty(false);
      setSaveMsg("✓ Saved to GoHighLevel.");
    } catch (e) {
      setSaveMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const cmByManager = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [rep, mgrs] of Object.entries(caseManagers))
      for (const m of mgrs) (out[m] ||= []).push(rep);
    return out;
  }, [caseManagers]);

  const userById = useMemo(
    () => new Map(users.map((u) => [u.id, u])),
    [users],
  );

  const nameOf = (id: string) =>
    userById.get(id)?.name || `Former user (${id})`;

  const cmManagerCount = Object.keys(cmByManager).length;

  const referralDivisionChoices = useMemo(() => {
    if (partnerDivisionOptions?.length) return [...partnerDivisionOptions].sort();
    return [...new Set(pipelines.map((p) => divisionLabel(p.name)).filter(Boolean))].sort();
  }, [partnerDivisionOptions, pipelines]);
  const referralChoicesAreLive = !!partnerDivisionOptions?.length;
  const cmRepCount = Object.keys(caseManagers).length;

  const linkCaseManager = (repId: string, managerId: string, on: boolean) => {
    if (!repId || !managerId) return;
    setCaseManagers((prev) => {
      const next = { ...prev };
      const have = new Set(next[repId] || []);
      if (on) have.add(managerId);
      else have.delete(managerId);

      if (have.size) next[repId] = [...have];
      else delete next[repId];
      return next;
    });
    setCmPending(null);
    setDirty(true);
    setSaveMsg(null);
  };

  const visibleUsers = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return users;
    return users.filter(
      (u) =>
        u.name.toLowerCase().includes(t) || u.email.toLowerCase().includes(t),
    );
  }, [users, q]);

  const unmapped = users.filter(
    (u) => !isAdmin(u) && !(grants[u.id]?.length),
  ).length;

  if (loading && !users.length)
    return (
      <div className="statewrap">
        <div className="statecard">
          <div className="spinner" />
          <h3>Loading pipeline access…</h3>
          <p>Fetching users and pipelines from GoHighLevel.</p>
        </div>
      </div>
    );

  if (loadErr && !users.length)
    return (
      <div className="statewrap">
        <div className="statecard">
          <h3>
            <span className="errdot">●</span> Couldn&apos;t load pipeline access
          </h3>
          <ErrorMessage error={loadErr} className="errbody" />
          <button className="retry" onClick={load} type="button">
            Try again
          </button>
        </div>
      </div>
    );

  return (
    <div className="scroll pawrap">
      {loadErr ? (
        <div className="loadwarn">
          <div>
            <b>Couldn&apos;t refresh pipeline access.</b> The grid below is from
            the last load that worked — do not save over it until this clears.{" "}
            <button type="button" className="linkbtn" onClick={load}>
              Try again
            </button>
          </div>
          <ErrorMessage error={loadErr} className="errbody" />
        </div>
      ) : null}

      <div className="panote">
        <b>This controls the dashboard only.</b> GoHighLevel has its own{" "}
        <b>Pipeline Permissions</b> that gate the native Opportunities screen and{" "}
        <b>who can be made owner</b> of a record. They are a separate system with
        no API — grant them by hand in GoHighLevel → Opportunities → the key icon
        on each pipeline. Ticking a box here does <b>not</b> grant those.
      </div>

      {usingEnvFallback ? (
        <div className="pawarn">
          Nothing is saved yet, so the <code>PIPELINE_ACCESS_MAP</code> environment
          variable is currently in force. Saving here takes over from it.
        </div>
      ) : null}

      <div className="patoolbar">
        <div className="search">
          <input
            placeholder="Filter users by name or email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="pacount">
          {users.length} users · {pipelines.length} pipelines ·{" "}
          <b className={unmapped ? "bad" : ""}>{unmapped} with no access</b>
        </div>
        <button
          type="button"
          className="ibtn"
          disabled={!dirty || saving}
          onClick={save}
        >
          {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
      </div>
      {saveMsg ? (
        <div className={`savemsg ${saveMsg.startsWith("✗") ? "err" : ""}`}>
          {saveMsg}
        </div>
      ) : null}

      <div className="pagridwrap">
        <table className="pagrid">
          <thead>
            <tr>
              <th className="pauser">User</th>
              {pipelines.map((p) => (
                <th key={p.id} title={p.id}>
                  {p.name}

                  {!p.inDashboard ? (
                    <span
                      className="panotloaded"
                      title={
                        p.notLoadedWhy
                          ? `${p.notLoadedWhy} Set it on the Pipelines screen.`
                          : "Nothing fetches this pipeline, so a grant here has no effect. Set its scope on the Pipelines screen."
                      }
                    >
                      not loaded
                    </span>
                  ) : null}
                </th>
              ))}

              <th
                className="pamasterhead"
                title="Master view: the same records this person can already see, laid out one column per pipeline. It never widens access."
              >
                Master view
              </th>
              <th
                className="pamasterhead"
                title="Staffing needed lead tab: Off hides it. Take for myself lets them assign waiting cases to themselves. Assign to anyone lets them hand cases to colleagues. Only cases in pipelines ticked on this row."
              >
                Staffing needed
              </th>
              {peerLabel ? (
                <th
                  className="pamasterhead"
                  title={`Transfer to ${peerLabel}: their own cases, or unowned cases in pipelines ticked on this row. Never a case they only follow.`}
                >
                  Transfer to {peerLabel}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {visibleUsers.map((u) => {
              const admin = isAdmin(u);
              const none = !admin && !(grants[u.id]?.length);
              return (
                <tr key={u.id} className={none ? "panone" : ""}>
                  <td className="pauser">
                    <div className="paname">
                      {u.name}
                      {admin ? (
                        <span
                          className="paadmin"
                          title="Admins see every pipeline regardless of this grid — ticking boxes for them has no effect."
                        >
                          admin · sees all
                        </span>
                      ) : null}
                      {none ? (
                        <span className="panoaccess">no access</span>
                      ) : null}
                    </div>
                    <div className="pamail">{u.email || "—"}</div>
                  </td>
                  {pipelines.map((p) => (
                    <td key={p.id} className="pacell">
                      <input
                        type="checkbox"
                        checked={!!grants[u.id]?.includes(p.id)}
                        disabled={admin}
                        onChange={() => toggle(u.id, p.id)}
                        aria-label={`${u.name} — ${p.name}`}
                      />
                    </td>
                  ))}
                  <td className="pacell pamastercell">
                    <input
                      type="checkbox"
                      checked={admin || masterUsers.includes(u.id)}
                      disabled={admin}
                      onChange={() => toggleMaster(u.id)}
                      aria-label={`${u.name} — Master view`}
                    />
                  </td>
                  <td className="pacell pamastercell">
                    {admin ? (
                      <span className="paadmin" title="Admins work Staffing needed by role">
                        included with admin
                      </span>
                    ) : (
                      <select
                        value={staffing[u.id] || "off"}
                        onChange={(e) =>
                          setStaffingFor(u.id, e.target.value as "off" | "self" | "any")
                        }
                        aria-label={`${u.name} — Staffing needed`}
                        style={{ fontSize: 12 }}
                      >
                        <option value="off">Off</option>
                        <option value="self">Take for myself</option>
                        <option value="any">Assign to anyone</option>
                      </select>
                    )}
                  </td>
                  {peerLabel ? (
                    <td className="pacell pamastercell">
                      {admin ? (
                        <span className="paadmin">included with admin</span>
                      ) : grants[u.id]?.length ? (
                        <input
                          type="checkbox"
                          checked={peerTransfer.includes(u.id)}
                          onChange={() => togglePeer(u.id)}
                          aria-label={`${u.name} — Transfer to ${peerLabel}`}
                        />
                      ) : (
                        <span className="muted" title="Give them a pipeline first">—</span>
                      )}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="pah2">Resource folders</h3>
      <div className="panote">
        <b>Folders are their own scope.</b> They are not derived from pipeline
        access — a compliance folder can belong to case managers who hold no
        pipeline at all. Admins see every folder.
        <br />
        <b>This is organisation, not security.</b> A GoHighLevel media URL is
        reachable by anyone who has it, so this decides what people{" "}
        <b>see listed here</b>, not what they could open with a link.{" "}
        <b>Client-specific documents belong on the client&apos;s record</b>, where
        they inherit its permissions — not in a shared folder.
      </div>

      {foldersError ? (
        <div className="pawarn">
          <b>Couldn&apos;t read the media folders</b> — this is a failed request,
          not an empty account, so don&apos;t take it as &ldquo;there are no
          folders&rdquo;.
          <ErrorMessage error={foldersError} />
          <button className="retry" onClick={load} type="button">
            Try again
          </button>
        </div>
      ) : folders.length === 0 ? (
        <div className="pawarn">
          No media folders were returned for this location. Create one on the
          Resources tab, then grant it here.
        </div>
      ) : (
        <div className="pagridwrap">
          <table className="pagrid">
            <thead>
              <tr>
                <th className="pauser">User</th>
                {folders.map((f) => (
                  <th key={f.id} title={f.id}>
                    {f.name}

                    {publicFolderId && f.id === publicFolderId ? (
                      <span
                        className="papublic"
                        title="Marked as visible to everyone (RESOURCES_PUBLIC_FOLDER_ID). Ticks here are redundant."
                      >
                        everyone
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((u) => {
                const admin = isAdmin(u);
                return (
                  <tr key={u.id}>
                    <td className="pauser">
                      <div className="paname">
                        {u.name}
                        {admin ? (
                          <span className="paadmin">admin · sees all</span>
                        ) : null}
                      </div>
                      <div className="pamail">{u.email || "—"}</div>
                    </td>
                    {folders.map((f) => {
                      const everyone =
                        !!publicFolderId && f.id === publicFolderId;
                      return (
                        <td key={f.id} className="pacell">
                          <input
                            type="checkbox"
                            checked={
                              admin ||
                              everyone ||
                              !!folderGrants[u.id]?.includes(f.id)
                            }
                            disabled={admin || everyone}
                            onChange={() => toggleFolder(u.id, f.id)}
                            aria-label={`${u.name} — ${f.name}`}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="cmhead">
        <span className="cmtitle">Case managers</span>

        <span className="cmcounts">
          <button
            type="button"
            className={`cmcount${cmView === "manager" ? " on" : ""}`}
            aria-pressed={cmView === "manager"}
            onClick={() => { setCmView("manager"); setCmAdding(null); }}
            title="List each manager and the reps they support"
          >
            <b>{cmManagerCount}</b> manager{cmManagerCount === 1 ? "" : "s"}
          </button>
          <span className="cmdot">·</span>
          <button
            type="button"
            className={`cmcount${cmView === "rep" ? " on" : ""}`}
            aria-pressed={cmView === "rep"}
            onClick={() => { setCmView("rep"); setCmAdding(null); }}
            title="List each rep and the managers who follow their cases"
          >
            <b>{cmRepCount}</b> rep{cmRepCount === 1 ? "" : "s"}
          </button>
        </span>
      </div>
      <div className="imeta cmintro">
        A case manager follows every case owned by a rep they support — in any
        pipeline, with no grant needed. Applied whenever an owner is set.
      </div>

      <div className="cmcolhead">
        <span className="cmcolwho">{caseManagerColumns(cmView).who}</span>
        <span className="cmcolwhat">{caseManagerColumns(cmView).what}</span>
      </div>

      <div className="cmlist">
        {(() => {
          const real = cmView === "manager" ? Object.keys(cmByManager) : Object.keys(caseManagers);

          return cmPending && !real.includes(cmPending) ? [...real, cmPending] : real;
        })().sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map((rowId) => {
          const chips = cmView === "manager" ? cmByManager[rowId] : caseManagers[rowId];

          const sorted = [...(chips || [])].sort((a, b) =>
            nameOf(a).localeCompare(nameOf(b)),
          );
          const repName = cmView === "manager" ? sorted[0] : rowId;
          const mgrName = cmView === "manager" ? rowId : sorted[0];
          const preview = sorted.length
            ? caseManagerPreview(nameOf(repName), nameOf(mgrName))
            : "";
          return (
            <div className="cmrow" key={rowId}>
              <span className="cmwho">{nameOf(rowId)}</span>
              <span className="cmchips">
                {[...(chips || [])]
                  .sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
                  .map((otherId) => (
                    <span className="cmchip" key={otherId}>
                      {nameOf(otherId)}
                      <button
                        type="button"
                        className="cmx"

                        onClick={() =>
                          cmView === "manager"
                            ? linkCaseManager(otherId, rowId, false)
                            : linkCaseManager(rowId, otherId, false)
                        }
                        aria-label={`Remove ${nameOf(otherId)} from ${nameOf(rowId)}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                <button
                  type="button"
                  className="cmadd"
                  onClick={() => { setCmAdding(cmAdding === rowId ? null : rowId); setCmQ(""); }}
                >
                  {cmView === "manager" ? "+ rep" : "+ manager"}
                </button>
              </span>
              {preview ? (
                <span className="cmpreview">
                  {preview}
                  {sorted.length > 1 ? (
                    <span className="cmpreviewmore">
                      {" "}

                      (and {sorted.length - 1} more)
                    </span>
                  ) : null}
                </span>
              ) : null}
              {cmAdding === rowId ? (
                <CasePicker
                  users={users}
                  exclude={new Set([rowId, ...(chips || [])])}
                  q={cmQ}
                  setQ={setCmQ}
                  onPick={(id) => {
                    if (cmView === "manager") linkCaseManager(id, rowId, true);
                    else linkCaseManager(rowId, id, true);
                    setCmAdding(null);
                  }}
                  onClose={() => { setCmAdding(null); setCmPending(null); }}
                />
              ) : null}
            </div>
          );
        })}

        <div className="cmrow cmnew">
          <span className="cmwho cmmuted">
            {cmView === "manager" ? "Another manager" : "Another rep"}
          </span>
          <span className="cmchips">
            <button
              type="button"
              className="cmadd"
              onClick={() => { setCmAdding(cmAdding === "__new" ? null : "__new"); setCmQ(""); }}
            >
              {cmView === "manager" ? "+ manager" : "+ rep"}
            </button>
          </span>
          {cmAdding === "__new" ? (
            <CasePicker
              users={users}
              exclude={new Set(cmView === "manager" ? Object.keys(cmByManager) : Object.keys(caseManagers))}
              q={cmQ}
              setQ={setCmQ}

              onPick={(id) => { setCmPending(id); setCmAdding(id); setCmQ(""); }}
              onClose={() => setCmAdding(null)}
            />
          ) : null}
        </div>
      </div>

      <div className="rfalist">
        <div className="cmhead">
          <b>Referral access</b>{" "}
          <span className="ihint">
            Which divisions&apos; referrals each person sees. <b>Derived</b> is the
            default and is right for most people — a grant on OLTL Enrollment
            already means OLTL referrals. Change it only to override that.
          </span>
        </div>
        {users.map((u) => {
          const entry = referralAccess[u.id];
          const mode = !entry ? "derived" : entry.mode;
          const picked = entry && entry.mode === "divisions" ? entry.divisions : [];
          const setMode = (m: "derived" | "divisions" | "agency") => {
            setDirty(true);
            setReferralAccess((prev) => {
              const next = { ...prev };

              if (m === "derived") delete next[u.id];
              else if (m === "agency") next[u.id] = { mode: "agency" };
              else next[u.id] = { mode: "divisions", divisions: picked };
              return next;
            });
          };
          const toggleDiv = (d: string) => {
            setDirty(true);
            setReferralAccess((prev) => {
              const cur = prev[u.id];
              const list = cur && cur.mode === "divisions" ? cur.divisions : [];
              const has = list.includes(d);
              return {
                ...prev,

                [u.id]: { mode: "divisions", divisions: has ? list.filter((x) => x !== d) : [...list, d] },
              };
            });
          };
          return (
            <div className="rfarow" key={u.id}>
              <span className="rfawho">{u.name}</span>
              <span className="rfmodes">
                {(["derived", "divisions", "agency"] as const).map((m) => (
                  <label key={m} className={`rfalevel${mode === m ? " on" : ""}`}>
                    <input
                      type="radio"
                      name={`rfa-${u.id}`}
                      checked={mode === m}
                      onChange={() => setMode(m)}
                    />
                    {m === "derived" ? "Derived" : m === "agency" ? "Agency — all" : "Divisions"}
                  </label>
                ))}
              </span>
              {mode === "divisions" ? (
                <span className="rfachips">

                  {[
                    ...referralDivisionChoices,
                    ...picked.filter((d) => !referralDivisionChoices.includes(d)),
                  ].map((d) => {
                    const orphan = !referralDivisionChoices.includes(d);
                    return (
                      <label
                        key={d}
                        className={`rfachip${picked.includes(d) ? " on" : ""}${orphan ? " orphan" : ""}`}

                        title={
                          orphan
                            ? referralChoicesAreLive
                              ? "This is no longer an option on the Partner Division field in GoHighLevel. The grant still stands; untick it here to remove it."
                              : "Partner Division could not be read, so this list is derived from pipeline names and no pipeline carries this division any more."
                            : undefined
                        }
                      >
                        <input type="checkbox" checked={picked.includes(d)} onChange={() => toggleDiv(d)} />
                        {d}
                        {orphan ? (referralChoicesAreLive ? " — not an option" : " — no pipeline") : ""}
                      </label>
                    );
                  })}

                  {!referralChoicesAreLive ? (
                    <span className="ihint">
                      ⚠️ These are derived from pipeline names. No{" "}
                      <b>Partner Division</b> options could be read, so some of
                      them may match no partner and grant nothing.
                    </span>
                  ) : null}

                  {picked.length === 0 ? (
                    <span className="ihint">— none selected: sees no referrals</span>
                  ) : null}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="imeta">
        Stored in GoHighLevel as the <code>MM Pipeline Access</code> custom value.
        Users, pipelines and folders are read live — new staff, new pipelines and
        new folders appear here automatically.
      </div>
    </div>
  );
}

function CasePicker({
  users,
  exclude,
  q,
  setQ,
  onPick,
  onClose,
}: {
  users: User[];
  exclude: Set<string>;
  q: string;
  setQ: (v: string) => void;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const t = q.trim().toLowerCase();
  const hits = users
    .filter((u) => !exclude.has(u.id))
    .filter((u) => !t || u.name.toLowerCase().includes(t) || u.email.toLowerCase().includes(t))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (

    <div className="cmpick" data-esc-local>
      <input
        className="cgsearch"
        autoFocus
        value={q}
        placeholder="Search everyone…"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onClose(); }
          if (e.key === "Enter" && hits[0]) { e.preventDefault(); onPick(hits[0].id); }
        }}
        aria-label="Search users"
      />
      <div className="cmpicklist">
        {hits.length ? (
          hits.map((u) => (
            <button type="button" className="cmpickrow" key={u.id} onClick={() => onPick(u.id)}>
              <span className="cmpickname">{u.name}</span>
              <span className="cmpickmail">{u.email}</span>
            </button>
          ))
        ) : (

          <div className="cmpicknone">
            {t ? `Nobody matches “${q.trim()}”.` : "Everyone is already on this row."}
          </div>
        )}
      </div>
      <button type="button" className="ighost cmpickclose" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}
