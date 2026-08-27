"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type User = { id: string; name: string; email: string; role: string };
type Pipeline = { id: string; name: string; inDashboard: boolean };
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
  const [usingEnvFallback, setUsingEnvFallback] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
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
      if (!res.ok) throw new Error(j.detail || j.error || `HTTP ${res.status}`);
      setUsers(j.users || []);
      setPipelines(j.pipelines || []);
      setGrants(j.grants || {});
      setUsingEnvFallback(!!j.usingEnvFallback);
      setDirty(false);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    load();
  }, [load]);

  const isAdmin = (u: User) => u.role === "admin";

  const toggle = (userId: string, pipelineId: string) => {
    setGrants((prev) => {
      const cur = new Set(prev[userId] || []);
      if (cur.has(pipelineId)) cur.delete(pipelineId);
      else cur.add(pipelineId);
      const next = { ...prev };
      if (cur.size) next[userId] = [...cur];
      else delete next[userId];
      return next;
    });
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
        body: JSON.stringify({ ssoKey: ssoBlob ?? undefined, grants }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok)
        throw new Error(j.detail || j.error || `HTTP ${res.status}`);
      setGrants(j.grants || {});
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
          <p>{loadErr}</p>
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="imeta">
        Stored in GoHighLevel as the <code>MM Pipeline Access</code> custom value.
        Users and pipelines are read live — new staff and new pipelines appear
        here automatically.
      </div>
    </div>
  );
}
