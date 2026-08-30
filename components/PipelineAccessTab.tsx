"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";

type User = { id: string; name: string; email: string; role: string };
type Pipeline = { id: string; name: string; inDashboard: boolean };
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
  const [publicFolderId, setPublicFolderId] = useState("");
  // ITEM 4 — Master view. One more column in the SAME custom value, as agreed:
  // it is a grant, not a role, and it never widens what a person can see.
  const [masterUsers, setMasterUsers] = useState<string[]>([]);
  const [usingEnvFallback, setUsingEnvFallback] = useState(false);
  const [loadErr, setLoadErr] = useState<unknown>(null);
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
    setLoading(true);
    setLoadErr(null);
    try {
      const res = await fetch("/api/admin/pipeline-access", {
        headers: headers(),
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(res, j);
      setUsers(j.users || []);
      setPipelines(j.pipelines || []);
      setGrants(j.grants || {});
      setFolders(j.folders || []);
      setFolderGrants(j.folderGrants || {});
      setMasterUsers(j.masterUsers || []);
      setPublicFolderId(j.publicFolderId || "");
      setUsingEnvFallback(!!j.usingEnvFallback);
      setDirty(false);
    } catch (e) {
      setLoadErr(e);
    } finally {
      setLoading(false);
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
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok)
        throw apiError(res, j);
      setGrants(j.grants || {});
      setFolderGrants(j.folderGrants || {});
      setMasterUsers(j.masterUsers || []);
      setUsingEnvFallback(false);
      setDirty(false);
      setSaveMsg("✓ Saved to GoHighLevel.");
    } catch (e) {
      setSaveMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
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

  if (loading)
    return (
      <div className="statewrap">
        <div className="statecard">
          <div className="spinner" />
          <h3>Loading pipeline access…</h3>
          <p>Fetching users and pipelines from GoHighLevel.</p>
        </div>
      </div>
    );

  if (loadErr)
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
                  {/* Not in PIPELINE_IDS: the dashboard doesn't load it, so a
                      tick here has no effect until it's added. */}
                  {!p.inDashboard ? (
                    <span
                      className="panotloaded"
                      title="The dashboard doesn't load this pipeline yet — add it to PIPELINE_IDS for grants to take effect."
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

      {folders.length === 0 ? (
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

      <div className="imeta">
        Stored in GoHighLevel as the <code>MM Pipeline Access</code> custom value.
        Users, pipelines and folders are read live — new staff, new pipelines and
        new folders appear here automatically.
      </div>
    </div>
  );
}
