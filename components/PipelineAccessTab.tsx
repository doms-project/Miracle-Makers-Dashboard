"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import { divisionLabel } from "@/lib/division";

type User = { id: string; name: string; email: string; role: string };
type Pipeline = {
  id: string;
  name: string;
  inDashboard: boolean;
  /** 🔴 ROUND 127 — WHY it is not loaded, so the badge names a fixable cause. */
  notLoadedWhy?: string;
};
type Folder = { id: string; name: string };
type Grants = Record<string, string[]>;

// Admin-only Pipeline Access grid. EVERYTHING here is fetched live: users and
// pipelines from GHL, grants from the "MM Pipeline Access" location custom
// value. Adding a sixth division = create the pipeline in GHL and tick a box —
// no code change, no redeploy.
export default function PipelineAccessTab({
  ssoBlob,
}: {
  ssoBlob: string | null;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [grants, setGrants] = useState<Grants>({});
  // ITEM 6b — folders are their OWN scope, not derived from pipelines: a
  // compliance folder can belong to case managers who hold no pipeline at all.
  // Same custom value, same save, a separate grid.
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderGrants, setFolderGrants] = useState<Grants>({});
  // Set when the folder READ failed. "No folders" and "we couldn't ask" are
  // different states and must never render the same sentence.
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [publicFolderId, setPublicFolderId] = useState("");
  // ITEM 4 — Master view. One more column in the SAME custom value, as agreed:
  // it is a grant, not a role, and it never widens what a person can see.
  const [masterUsers, setMasterUsers] = useState<string[]>([]);
  // ═══ TASK 1 — CASE MANAGERS ═══════════════════════════════════════════
  // repId -> managerId[]. The SAME custom value, a fourth key, one more
  // section — not a new tab. Rendered entirely from the live user list; only
  // ids are stored, so a renamed user needs nothing here.
  const [caseManagers, setCaseManagers] = useState<Grants>({});
  /**
   * 🔴 ROUND 161 — the per-user referral override. THREE states, and the absent
   * key is one of them: no entry means DERIVED, which is the default and is
   * right for most people. See AccessGrantsV2.referralAccess.
   */
  const [referralAccess, setReferralAccess] = useState<
    Record<string, { mode: "agency" } | { mode: "divisions"; divisions: string[] }>
  >({});
  /** Which way round the list reads. Both counts in the header flip it. */
  const [cmView, setCmView] = useState<"manager" | "rep">("manager");
  /** The row whose "add" picker is open — a rep id, or a manager id in manager-first. */
  const [cmAdding, setCmAdding] = useState<string | null>(null);
  const [cmQ, setCmQ] = useState("");
  /**
   * A row that has been STARTED but holds nothing yet. It exists only in this
   * state, never in the map: a half-made row — a manager with no reps — is not
   * something the store can represent, and writing one would invent a state
   * `applyCaseManagers` has no meaning for.
   */
  const [cmPending, setCmPending] = useState<string | null>(null);
  const [usingEnvFallback, setUsingEnvFallback] = useState(false);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  /** Which load() is current — see the sequence guard inside it. */
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
    // 🔴 SEQUENCED — round 111. `load` depends on `headers()`, which depends on
    // `ssoBlob`, and the effect below depends on `load`. So the moment the blob
    // arrives this fires a SECOND time with a first still in flight, and until
    // now whichever FINISHED last won. The first one is the unauthenticated
    // request, its 401 is "Sign-in required", and if it lands second it draws a
    // sign-in error over a grid that loaded correctly.
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
      setGrants(j.grants || {});
      setFolders(j.folders || []);
      setFoldersError(j.foldersError || null);
      setFolderGrants(j.folderGrants || {});
      setMasterUsers(j.masterUsers || []);
      setCaseManagers(j.caseManagers || {});
      setReferralAccess(j.referralAccess || {});
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

  const isAdmin = (u: User) => u.role === "admin";

  // One toggle for both grids — pipelines and folders are the same shape
  // (userId -> id[]) and differ only in which map they live in.
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

  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch("/api/admin/pipeline-access", {
        method: "PUT",
        headers: headers(),
        // All three go in one PUT. The server MERGES rather than replaces, so
        // sending them together is not what protects the other maps — but one
        // save for one "Save changes" button is what the admin expects.
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          grants,
          folderGrants,
          masterUsers,
          caseManagers,
          referralAccess,
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
      setUsingEnvFallback(false);
      setDirty(false);
      setSaveMsg("✓ Saved to GoHighLevel.");
    } catch (e) {
      setSaveMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  // ═══ TASK 1 — THE TWO WAYS TO READ ONE MAP ════════════════════════════
  //
  // The store is rep → managers. Manager-first is its inverse, computed here
  // rather than stored: two copies of one relationship is two things to keep in
  // step, and the whole point of the flip is that it is the SAME data.
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
  // ⚠️ AN ID WITH NO USER IS STILL SHOWN. A manager who left the account would
  // otherwise vanish from the screen while still following every one of their
  // reps' cases — invisible, and unremovable from here.
  //
  // 🔴 ROUND 151 — BUT NOT AS A BARE ID, WHICH IS WHAT IT WAS. A row reading
  // `0IcvXMDmxEToQTM7VZ9w` where every other row has a person's name reads as a
  // fault rather than as information, and this account has two stale entries
  // that hit it today.
  //
  // ⚠️ THE ID STAYS, DELIBERATELY, AND IT IS THE ONE PLACE IN THE SWEEP THAT
  // KEEPS ONE. "Former user" alone would make two departed managers render as
  // two identical rows, and an admin could not tell which was which to remove
  // the right one. The word is what the id was missing: it says why there is no
  // name instead of leaving a token that looks broken.
  const nameOf = (id: string) =>
    userById.get(id)?.name || `Former user (${id})`;

  const cmManagerCount = Object.keys(cmByManager).length;

  /**
   * ⚠️ DERIVED FROM THE PIPELINES ALREADY LOADED, not a hardcoded list. The
   * same `divisionLabel` every other division decision uses, so a new pipeline
   * brings its division with it and nothing has to be edited here.
   */
  const referralDivisionChoices = useMemo(
    () => [...new Set(pipelines.map((p) => divisionLabel(p.name)).filter(Boolean))].sort(),
    [pipelines],
  );
  const cmRepCount = Object.keys(caseManagers).length;

  /**
   * 🔴 ONE WRITE, WHICHEVER END IT IS MADE FROM. Removing Carla from Ern's row
   * and removing Ern from Carla's row are the same mutation of the same map,
   * so both go through here and there is no second code path to disagree.
   */
  const linkCaseManager = (repId: string, managerId: string, on: boolean) => {
    if (!repId || !managerId) return;
    setCaseManagers((prev) => {
      const next = { ...prev };
      const have = new Set(next[repId] || []);
      if (on) have.add(managerId);
      else have.delete(managerId);
      // ⚠️ THE LAST ONE REMOVED DELETES THE KEY, which is what makes the row
      // disappear — "a user stops being a manager when the last rep is
      // removed". `applyCaseManagers` still tidies up, because its test is its
      // own stored record rather than this map.
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

  // A non-admin with zero ticks browses nothing. That is correct (fail-closed)
  // but looks broken to them, so make it countable at a glance.
  const unmapped = users.filter(
    (u) => !isAdmin(u) && !(grants[u.id]?.length),
  ).length;

  // ⚠️ ONLY WITH NOTHING TO SHOW. Round 111 split every error wall but left the
  // SPINNERS alone here, so pressing Save (which reloads) replaced the whole
  // grant grid with "Loading pipeline access…" — the same wall-instead-of-strip
  // mistake in the loading state. Found by scripts/loader-sweep.mjs, which is
  // the entire reason that script is committed rather than remembered.
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

  // ⚠️ Only when there is nothing to show. With a grid already loaded, a failed
  // RELOAD used to replace it with a full-screen card — the same wall-instead-of
  // -strip mistake as the client board, one screen over.
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
      {/* The single most important thing an admin needs to know here. */}
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
                  {/* 🔴 ROUND 127 — THE BADGE NAMED THE WRONG FIX. It said to
                      add the pipeline to PIPELINE_IDS, an environment variable
                      nobody using this screen can change — and it was reading
                      that env list rather than the stored config, so three
                      pipelines an admin had already configured were flagged as
                      absent. The cause is now derived from the same place the
                      Pipelines screen writes, and the tooltip says which
                      dropdown fixes it. */}
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
              {/* ITEM 4 — Master view, deliberately in THIS grid and not a tab
                  of its own. It is granted alongside pipelines because it is
                  read the same way, and because an admin deciding who sees
                  everything at once should be looking at who sees what. */}
              <th
                className="pamasterhead"
                title="Master view: the same records this person can already see, laid out one column per pipeline. It never widens access."
              >
                Master view
              </th>
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ---- ITEM 6b: folder access ---- */}
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
                    {/* The MARKED public folder — a flag, never a magic name.
                        Matching on a name would change what the whole company
                        can see the moment somebody renames a folder in GHL. */}
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

      {/* ═══ TASK 1 — CASE MANAGERS ═══════════════════════════════════════
          A SECOND SECTION, below the grid. Not a new tab: it is the same custom
          value, saved by the same button, and an admin thinking about who sees
          what is already here.

          🔴 NO ROLE LABELS, NO WARNINGS, NO "sees nothing" FLAGS. The system
          cannot know who is a rep — `-Sale` and `Case Manager` in a display
          name are conventions, not data — so it must not draw an absence as a
          problem. The pipeline grid above counts unmapped users; this one
          deliberately does not. */}
      <div className="cmhead">
        <span className="cmtitle">Case managers</span>
        {/* 🔴 BOTH COUNTS ARE CONTROLS, and they must not look like the numbers
            in the grid's own count line. A number that filters and a number
            that is just a number reading the same is the fault this styling
            exists to avoid — so they are buttons, with a pressed state. */}
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

      <div className="cmlist">
        {(() => {
          const real = cmView === "manager" ? Object.keys(cmByManager) : Object.keys(caseManagers);
          // The started-but-empty row sits with the others so it reads as a row,
          // not as a dialog. It vanishes the moment it gets its first chip —
          // at which point it is a real row — or when the picker is closed.
          return cmPending && !real.includes(cmPending) ? [...real, cmPending] : real;
        })().sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map((rowId) => {
          const chips = cmView === "manager" ? cmByManager[rowId] : caseManagers[rowId];
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
                        // 🔴 THE SAME WRITE FROM EITHER END. In manager-first the
                        // row IS the manager and the chip is the rep; in
                        // rep-first it is the other way round. One call, the
                        // arguments swapped.
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

        {/* 🔴 THE ONLY WAY A ROW IS BORN — no "add manager" button. Somebody
            becomes a manager by having a rep assigned to them, and stops being
            one when the last is removed. A button that made an empty manager
            would create a state the map cannot hold. */}
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
              // ⚠️ PICKING HERE OPENS THE SECOND PICKER RATHER THAN SAVING. A
              // row needs both halves to exist at all, so a half-made row is
              // never written.
              onPick={(id) => { setCmPending(id); setCmAdding(id); setCmQ(""); }}
              onClose={() => setCmAdding(null)}
            />
          ) : null}
        </div>
      </div>

      {/* ═══ ROUND 161 — REFERRAL ACCESS, A LAYER ON TOP OF DERIVED ═══════════
          🔴 THREE STATES, AND "Derived" IS A REAL ONE RATHER THAN THE ABSENCE
          OF A SETTING. Without it an admin could only say "this person is
          unmanaged" — which falls straight back to their pipeline grants — and
          never "this person sees no referrals at all". */}
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
              // 🔴 "Derived" DELETES THE KEY. That is what makes it a state
              // rather than a default: absent is read as derived everywhere.
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
                // ⚠️ AN EMPTY LIST IS KEPT, NOT DELETED. Unticking the last
                // division means "sees no referrals" — an instruction. The
                // server preserves it too; `norm` would not, which is why that
                // key has its own normaliser.
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
                  {/* 🔴 STORED DIVISIONS THAT NO LONGER HAVE A PIPELINE ARE STILL
                      SHOWN. The choices come from the live pipelines, so a
                      division that was granted and whose pipeline was later
                      renamed or removed falls out of that list — while staying
                      in the stored map, because the save sends this state
                      object rather than re-deriving it from what rendered.
                      The GRANT is therefore safe; what was not safe was the
                      SCREEN: no chip, and no "none selected" hint either, so
                      the row read as "Divisions, nothing ticked" for somebody
                      who really was seeing ODP referrals. An absence rendered
                      as an answer, one more time.
                      ⚠️ Shown as a chip so it is visible AND removable — an
                      orphan an admin can see but not untick would be worse. */}
                  {[
                    ...referralDivisionChoices,
                    ...picked.filter((d) => !referralDivisionChoices.includes(d)),
                  ].map((d) => {
                    const orphan = !referralDivisionChoices.includes(d);
                    return (
                      <label
                        key={d}
                        className={`rfachip${picked.includes(d) ? " on" : ""}${orphan ? " orphan" : ""}`}
                        title={orphan ? "No pipeline on this account has this division any more." : undefined}
                      >
                        <input type="checkbox" checked={picked.includes(d)} onChange={() => toggleDiv(d)} />
                        {d}{orphan ? " — no pipeline" : ""}
                      </label>
                    );
                  })}
                  {/* 🔴 SAYS SO RATHER THAN LOOKING UNSET. An empty selection is
                      a decision, and a row that renders as blank chips is the
                      "absence that looks like an answer" this project keeps
                      finding. */}
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

/**
 * 🔴 TASK 1 — THE USER PICKER FOR A CASE-MANAGER ROW.
 *
 * ⚠️ ALL USERS, ALWAYS, WITH NO ROLE FILTER. The system cannot know who is a
 * rep and who is a manager — `-Sale` and `Case Manager` in a display name are
 * conventions, not data, and inferring from them would be the hardcoded-facts
 * mistake in a new place. Anyone can be picked for either end; the map is the
 * only thing that says who is which.
 *
 * ⚠️ `exclude` IS ABOUT DUPLICATES, NOT ROLES — the row's own subject and the
 * people already on it, so the list never offers something that would do
 * nothing.
 */
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
    // `data-esc-local` — round 131's marker. The record panel's document-level
    // Escape handler is not on this screen, but the convention is cheap and the
    // next person to add one will not have to rediscover it.
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
          // ⚠️ "Nobody left" and "nobody matched" are different states and must
          // not share a sentence — the same rule the folder read follows above.
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
