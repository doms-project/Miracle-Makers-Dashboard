"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  OpportunityRecord,
  OpportunitiesResponse,
  ApiError,
  Note,
  EditableFieldDef,
} from "@/lib/types";
import { useGhlSession } from "@/lib/useGhlSession";

const LOCATION_ID = "YVPhIAECw9q1M9Jw6A8L";

// Preferred stage order for chips + board columns. Any stage present in the
// live data but not listed here is appended after these, in first-seen order.
const STAGE_ORDER = [
  "New Lead",
  "IEB",
  "AAA Appointment Set",
  "CAO",
  "MCO",
  "Authorization Requested",
  "Auth Received in HH",
  "Authorization Received",
];

const clientName = (r: OpportunityRecord) => `${r.first} ${r.last}`.trim();
const enrollLabel = (r: OpportunityRecord) =>
  `${r.last || r.first || "Record"} — ${
    r.harmony ? r.harmony.replace("HRM-", "#") : "new"
  }`;

// Sortable columns (client-requested: sort by name, stage, office, …).
type SortKey =
  | "client"
  | "stage"
  | "harmony"
  | "office"
  | "county"
  | "block"
  | "src"
  | "rep"
  | "cm"
  | "checked";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "client", label: "Client" },
  { key: "stage", label: "Stage" },
  { key: "harmony", label: "Harmony ID" },
  { key: "office", label: "Office" },
  { key: "county", label: "County" },
  { key: "block", label: "Road Blocker" },
  { key: "src", label: "Source" },
  { key: "rep", label: "Sales Rep" },
  { key: "cm", label: "Case Mgr" },
  { key: "checked", label: "Checked" },
];

// ---- small inline icons (ported from the design) ----
const IconGrid = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M9 4v16" />
  </svg>
);
const IconList = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);
const IconBoard = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <rect x="3" y="4" width="5" height="16" rx="1" />
    <rect x="10" y="4" width="5" height="10" rx="1" />
    <rect x="17" y="4" width="4" height="13" rx="1" />
  </svg>
);
const IconSearch = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4-4" />
  </svg>
);
const IconExternal = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <path d="M15 3h6v6M10 14L21 3" />
  </svg>
);

const BlockPill = ({ b }: { b: string }) => (
  <span className={`pill ${b === "None" ? "none" : "blk"}`}>{b}</span>
);

// ---- Phase 2 field editors ----
type SaveState = { status: "saving" | "error"; msg?: string } | undefined;

const asStr = (v: unknown): string =>
  Array.isArray(v) ? v.map(String).join(", ") : v == null ? "" : String(v);
const asArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)];
const asDate = (v: unknown): string => {
  const s = asStr(v);
  if (!s) return "";
  const d = new Date(s);
  return isNaN(d.getTime()) ? s.slice(0, 10) : d.toISOString().slice(0, 10);
};

// Save-on-blur text / number / date input (local state so typing is smooth).
function TextControl({
  value,
  multiline,
  type,
  disabled,
  onSave,
}: {
  value: unknown;
  multiline?: boolean;
  type?: "text" | "number" | "date";
  disabled?: boolean;
  onSave: (v: string | number) => void;
}) {
  const initial = type === "date" ? asDate(value) : asStr(value);
  const [v, setV] = useState(initial);
  const commit = () => {
    if (v !== initial) onSave(type === "number" ? Number(v) : v);
  };
  if (multiline) {
    return (
      <textarea
        className="v edit"
        rows={3}
        value={v}
        disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
      />
    );
  }
  return (
    <input
      className="v edit"
      type={type || "text"}
      value={v}
      disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

// One editable/read-only control chosen by the field's GHL dataType.
function FieldControl({
  def,
  value,
  save,
  onSave,
}: {
  def: EditableFieldDef;
  value: unknown;
  save: SaveState;
  onSave: (v: unknown) => void;
}) {
  const t = (def.dataType || "").toUpperCase();
  const disabled = save?.status === "saving";

  if (!def.editable) {
    return (
      <div className="v ro">
        {asStr(value) || "—"}{" "}
        <span className="readonly-note">read-only</span>
      </div>
    );
  }

  let control: ReactNode;
  if (t === "SINGLE_OPTIONS") {
    control = (
      <select
        className="v edit"
        value={asStr(value)}
        disabled={disabled}
        onChange={(e) => onSave(e.target.value)}
      >
        <option value="">—</option>
        {def.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (t === "MULTIPLE_OPTIONS" || t === "CHECKBOX") {
    const cur = asArr(value);
    control = (
      <div className="multi">
        {def.options.map((o) => {
          const on = cur.includes(o);
          return (
            <label key={o} className={`chipbox ${on ? "on" : ""}`}>
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                onChange={() =>
                  onSave(on ? cur.filter((x) => x !== o) : [...cur, o])
                }
              />
              {o}
            </label>
          );
        })}
      </div>
    );
  } else if (t === "DATE") {
    control = (
      <TextControl
        value={value}
        type="date"
        disabled={disabled}
        onSave={onSave}
      />
    );
  } else if (t === "MONETORY" || t === "NUMERICAL" || t === "NUMBER") {
    control = (
      <TextControl
        value={value}
        type="number"
        disabled={disabled}
        onSave={onSave}
      />
    );
  } else {
    control = (
      <TextControl
        value={value}
        multiline={t === "LARGE_TEXT"}
        disabled={disabled}
        onSave={onSave}
      />
    );
  }

  return (
    <>
      {control}
      {save?.status === "saving" ? (
        <div className="savemsg">Saving…</div>
      ) : save?.status === "error" ? (
        <div className="savemsg err">✗ {save.msg || "Save failed"}</div>
      ) : null}
    </>
  );
}

export default function Dashboard() {
  // Phase 3 (Step 0): GHL SSO handshake. `sso` is the decrypted viewer session
  // (or "none" when not embedded / not configured). Filtering is NOT wired yet
  // — this proves the handshake returns a real user before the filter is built.
  const sso = useGhlSession();

  const [data, setData] = useState<OpportunityRecord[]>([]);
  const [pipelineName, setPipelineName] = useState<string>("OLTL Enrollments");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  // Phase 2 editing metadata (from the API) + per-field save state.
  const [fieldDefs, setFieldDefs] = useState<EditableFieldDef[]>([]);
  const [pipelineStages, setPipelineStages] = useState<
    { id: string; name: string }[]
  >([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});

  const [stage, setStage] = useState<string>("all");
  const [office, setOffice] = useState<string>("all"); // office filter (client req)
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [view, setView] = useState<"list" | "board">("list");
  const [selId, setSelId] = useState<string | null>(null);
  // Ephemeral, in-memory only. Notes are a display-only stub until Phase 2.
  const [notes, setNotes] = useState<Record<string, Note[]>>({});
  const [noteDraft, setNoteDraft] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // When the SSO session is ready, POST the still-encrypted blob so the
      // SERVER re-derives identity and filters. The browser never sends a
      // userId/role of its own. When not embedded, fall back to GET (the server
      // serves the open view only if SSO isn't configured, else 401).
      const res =
        sso.status === "ready"
          ? await fetch("/api/opportunities", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ssoKey: sso.blob }),
              cache: "no-store",
            })
          : await fetch("/api/opportunities", { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiError | null;
        setError(
          body ?? {
            error: `Request failed with status ${res.status}.`,
          },
        );
        setData([]);
        return;
      }
      const body = (await res.json()) as OpportunitiesResponse;
      setData(body.records || []);
      if (body.pipeline?.name) setPipelineName(body.pipeline.name);
      if (body.fieldDefs) setFieldDefs(body.fieldDefs);
      if (body.stages) setPipelineStages(body.stages);
      if (body.users) setUsers(body.users);
    } catch (e) {
      setError({
        error: "Could not reach the dashboard API.",
        detail: e instanceof Error ? e.message : String(e),
      });
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [sso]);

  // Fetch once the SSO handshake has settled (ready or none), so the blob is
  // available to send. Re-runs if the session changes.
  useEffect(() => {
    if (sso.status === "loading") return;
    load();
  }, [sso.status, load]);

  // Escape closes the record panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Stage list derived from data, preferred order first.
  const stages = useMemo(() => {
    const present: string[] = [];
    const seen = new Set<string>();
    for (const r of data) {
      if (r.stage && !seen.has(r.stage)) {
        seen.add(r.stage);
        present.push(r.stage);
      }
    }
    const ordered = STAGE_ORDER.filter((s) => seen.has(s));
    const extra = present.filter((s) => !STAGE_ORDER.includes(s));
    return [...ordered, ...extra];
  }, [data]);

  // Offices present in the data, for the office filter control.
  const offices = useMemo(() => {
    const set = new Set<string>();
    for (const r of data) if (r.office) set.add(r.office);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [data]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.filter(
      (r) =>
        (stage === "all" || r.stage === stage) &&
        (office === "all" || r.office === office) &&
        (needle === "" ||
          // Searchable by name, office, stage, and the key people/ids.
          `${r.first} ${r.last} ${r.office} ${r.stage} ${r.harmony} ${r.cm} ${r.cg} ${r.rep} ${r.src}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [data, stage, office, q]);

  // Sorted view for the list (client-requested: sortable by name/stage/office…).
  const visible = useMemo(() => {
    if (!sortKey) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    const stageIndex = (s: string) => {
      const i = stages.indexOf(s);
      return i === -1 ? 999 : i;
    };
    const cmp = (a: OpportunityRecord, b: OpportunityRecord): number => {
      if (sortKey === "client")
        return clientName(a).localeCompare(clientName(b));
      if (sortKey === "stage") return stageIndex(a.stage) - stageIndex(b.stage);
      if (sortKey === "checked")
        return (a.checked ? 1 : 0) - (b.checked ? 1 : 0);
      return String(a[sortKey] ?? "").localeCompare(String(b[sortKey] ?? ""));
    };
    return [...filtered].sort((a, b) => dir * cmp(a, b));
  }, [filtered, sortKey, sortDir, stages]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const boardVisible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.filter(
      (r) =>
        needle === "" ||
        `${r.first} ${r.last}`.toLowerCase().includes(needle),
    );
  }, [data, q]);

  // Stats (client-requested tiles: total, per office, by source, per rep).
  const stats = useMemo(() => {
    const blocked = data.filter((r) => r.block !== "None").length;
    const checked = data.filter((r) => r.checked).length;
    const auth = data.filter((r) => r.stage.startsWith("Auth")).length;
    const tally = (pick: (r: OpportunityRecord) => string) => {
      const m = new Map<string, number>();
      for (const r of data) {
        const k = pick(r);
        if (k) m.set(k, (m.get(k) || 0) + 1);
      }
      return [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => ({ k, n }));
    };
    const officeStats = tally((r) => r.office).slice(0, 4);
    const sourceStats = tally((r) => r.src).slice(0, 4);
    const repStats = tally((r) => (r.rep && r.rep !== "—" ? r.rep : ""));
    const assigned = repStats.reduce((s, x) => s + x.n, 0);
    return {
      blocked,
      checked,
      auth,
      officeStats,
      sourceStats,
      repStats: repStats.slice(0, 4),
      repCount: repStats.length,
      assigned,
    };
  }, [data]);

  const selected = useMemo(
    () => data.find((r) => r.id === selId) || null,
    [data, selId],
  );

  const addNote = () => {
    const v = noteDraft.trim();
    if (!v || !selId) return;
    setNotes((prev) => ({
      ...prev,
      [selId]: [{ who: "You", when: "just now", txt: v }, ...(prev[selId] || [])],
    }));
    setNoteDraft("");
  };

  const selNotes = (selId && notes[selId]) || [];

  // ---- Phase 2 save: optimistic update, revert on failure ----
  const skey = (id: string, fk: string) => `${id}:${fk}`;
  const saveField = useCallback(
    async (
      rec: OpportunityRecord,
      fk: string,
      patch: Record<string, unknown>,
      optimistic: (r: OpportunityRecord) => OpportunityRecord,
    ) => {
      setSaveState((p) => ({ ...p, [skey(rec.id, fk)]: { status: "saving" } }));
      setData((prev) => prev.map((r) => (r.id === rec.id ? optimistic(r) : r)));
      try {
        const res = await fetch(`/api/opportunities/${rec.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ssoKey: sso.status === "ready" ? sso.blob : undefined,
            ...patch,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          record?: OpportunityRecord;
          error?: string;
          detail?: string;
        };
        if (!res.ok || !j.ok || !j.record)
          throw new Error(j.detail || j.error || `HTTP ${res.status}`);
        // Reflect the server's canonical record (esp. array-wrapped values).
        setData((prev) => prev.map((r) => (r.id === rec.id ? j.record! : r)));
        setSaveState((p) => ({ ...p, [skey(rec.id, fk)]: undefined }));
      } catch (e) {
        // Revert to the pre-edit record; never show a false "saved".
        setData((prev) => prev.map((r) => (r.id === rec.id ? rec : r)));
        setSaveState((p) => ({
          ...p,
          [skey(rec.id, fk)]: {
            status: "error",
            msg: e instanceof Error ? e.message : String(e),
          },
        }));
      }
    },
    [sso],
  );

  const saveCustomField = (rec: OpportunityRecord, def: EditableFieldDef, value: unknown) =>
    saveField(
      rec,
      def.id,
      { customFields: [{ id: def.id, value }] },
      (r) => ({ ...r, cf: { ...r.cf, [def.id]: value } }),
    );

  const saveMsgFor = (id: string, fk: string): ReactNode => {
    const s = saveState[skey(id, fk)];
    if (s?.status === "saving") return <div className="savemsg">Saving…</div>;
    if (s?.status === "error")
      return <div className="savemsg err">✗ {s.msg || "Save failed"}</div>;
    return null;
  };
  const savingFk = (id: string, fk: string) =>
    saveState[skey(id, fk)]?.status === "saving";

  // Admin/agency (or the open no-SSO setup view) see everything; a restricted
  // signed-in user sees only their assigned records. Mirrors the server rule.
  const isAdminViewer =
    sso.status === "none" ||
    (sso.status === "ready" &&
      (sso.session.role === "admin" || sso.session.type === "agency"));

  // Current viewer's user id (when signed in) — used to show why a record is
  // visible: "Following" when the viewer is a follower but not the owner.
  const viewerId = sso.status === "ready" ? sso.session.userId : null;
  const followsNotOwns = (r: OpportunityRecord) =>
    !!viewerId && r.ownerId !== viewerId && r.followerIds.includes(viewerId);

  return (
    <div className="app">
      <nav className="rail">
        <div className="logo">M</div>
        <button
          className="active"
          title="OLTL Enrollments — this custom view"
          type="button"
        >
          <IconGrid />
        </button>
        <div
          className="railnote"
          title="Embedded inside GoHighLevel. Contacts, comms and settings stay in native GHL."
        >
          GHL
        </div>
      </nav>

      <div className="main">
        <div className="topbar">
          <div className="title">
            <h1>
              <span className="pipe" /> {pipelineName}
            </h1>
            <small>
              One custom view embedded in GoHighLevel · native GHL for
              everything else
            </small>
          </div>
          <div className="spacer" />
          <div
            className="viewas"
            title="Signed-in GHL user (from the SSO handshake). Role-based filtering is the next step."
          >
            <label>Signed in</label>
            {sso.status === "loading" ? (
              <span>Checking session…</span>
            ) : sso.status === "ready" ? (
              <span>
                {sso.session.userName || sso.session.userId}
                {sso.session.role ? ` · ${sso.session.role}` : ""}
              </span>
            ) : (
              <span title={sso.reason}>No SSO session</span>
            )}
          </div>
          <div className="seg">
            <button
              className={view === "list" ? "on" : ""}
              onClick={() => setView("list")}
              type="button"
            >
              <IconList />
              List
            </button>
            <button
              className={view === "board" ? "on" : ""}
              onClick={() => setView("board")}
              type="button"
            >
              <IconBoard />
              Board
            </button>
          </div>
        </div>

        {/* stats */}
        <div className="stats">
          <div className="stat">
            <div className="k">In pipeline</div>
            <div className="v">{data.length}</div>
            <div className="sub">live from GoHighLevel</div>
          </div>
          <div className="stat gold">
            <div className="k">By office</div>
            <div className="mini" style={{ marginTop: 9 }}>
              {stats.officeStats.length ? (
                stats.officeStats.map((x) => (
                  <span key={x.k}>
                    <b>{x.n}</b> {x.k.split(" ")[0]}
                  </span>
                ))
              ) : (
                <span className="muted">—</span>
              )}
            </div>
          </div>
          <div className="stat">
            <div className="k">By source</div>
            <div className="mini" style={{ marginTop: 9 }}>
              {stats.sourceStats.length ? (
                stats.sourceStats.map((x) => (
                  <span key={x.k}>
                    <b>{x.n}</b> {x.k}
                  </span>
                ))
              ) : (
                <span className="muted">—</span>
              )}
            </div>
          </div>
          <div className="stat gold">
            <div className="k">By rep (assigned)</div>
            <div className="mini" style={{ marginTop: 9 }}>
              {stats.repStats.length ? (
                stats.repStats.map((x) => (
                  <span key={x.k}>
                    <b>{x.n}</b> {x.k.split(" ")[0]}
                  </span>
                ))
              ) : (
                <span className="muted">none assigned</span>
              )}
            </div>
          </div>
          <div className="stat blk">
            <div className="k">Road-blocked</div>
            <div className="v">{stats.blocked}</div>
            <div className="sub">need attention</div>
          </div>
          <div className="stat ok">
            <div className="k">Checked this week</div>
            <div className="v">{stats.checked}</div>
            <div className="sub">{stats.auth} at authorization</div>
          </div>
        </div>

        <div className={`scope ${isAdminViewer ? "admin" : "rep"}`}>
          {sso.status === "loading" ? (
            <>
              <span className="tag">…</span> Checking the GHL session…
            </>
          ) : sso.status === "ready" ? (
            isAdminViewer ? (
              <>
                <span className="tag">Admin</span>{" "}
                <b>All offices.</b> Every record in the {pipelineName} pipeline (
                {data.length}). Signed in as{" "}
                <b>{sso.session.userName || sso.session.userId}</b>
                {sso.session.role ? ` (${sso.session.role})` : ""}.
              </>
            ) : (
              <>
                <span className="tag">
                  {sso.session.userName || "Your view"}
                </span>{" "}
                <b>Your assigned records ({data.length}).</b> You see only
                opportunities you own or follow. Office is a view filter, not a
                permission — it doesn&apos;t change what you can see.
              </>
            )
          ) : (
            <>
              <span className="tag">All data</span>{" "}
              <b>No GHL SSO session detected</b> — admin/testing view. Every
              record in the {pipelineName} pipeline ({data.length}).
            </>
          )}
        </div>

        <div className="toolbar">
          <div className="search">
            <IconSearch />
            <input
              placeholder="Search by client, office, stage, caregiver, case manager…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="officefilter">
            <label htmlFor="officeSel">Office</label>
            <select
              id="officeSel"
              value={office}
              onChange={(e) => setOffice(e.target.value)}
            >
              <option value="all">All offices</option>
              {offices.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          <span className="count">
            {visible.length} shown · {data.length} in pipeline
          </span>
        </div>

        <div className="stages">
          <button
            className={`chip ${stage === "all" ? "on" : ""}`}
            onClick={() => setStage("all")}
            type="button"
          >
            All<span className="n">{data.length}</span>
          </button>
          {stages.map((st) => (
            <button
              key={st}
              className={`chip ${stage === st ? "on" : ""}`}
              onClick={() => setStage(st)}
              type="button"
            >
              {st}
              <span className="n">
                {data.filter((r) => r.stage === st).length}
              </span>
            </button>
          ))}
        </div>

        {/* content: loading / error / list / board */}
        {loading ? (
          <div className="statewrap">
            <div className="statecard">
              <div className="spinner" />
              <h3>Loading opportunities…</h3>
              <p>Fetching live OLTL records from GoHighLevel.</p>
            </div>
          </div>
        ) : error ? (
          <div className="statewrap">
            <div className="statecard">
              <h3>
                <span className="errdot">●</span> Couldn&apos;t load
                opportunities
              </h3>
              <p>{error.error}</p>
              {error.detail ? (
                <div className="detail">{error.detail}</div>
              ) : null}
              <button className="retry" onClick={load} type="button">
                Try again
              </button>
            </div>
          </div>
        ) : view === "list" ? (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      className={`sortable ${sortKey === c.key ? "sorted" : ""}`}
                      onClick={() => toggleSort(c.key)}
                      title={`Sort by ${c.label}`}
                    >
                      {c.label}
                      <span className="sortcaret">
                        {sortKey === c.key
                          ? sortDir === "asc"
                            ? "▲"
                            : "▼"
                          : "↕"}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={r.id}
                    className={r.id === selId ? "sel" : ""}
                    onClick={() => setSelId(r.id)}
                  >
                    <td className="strong">
                      {clientName(r) || "—"}
                      {followsNotOwns(r) ? (
                        <span
                          className="follow-tag"
                          title="You follow this record (you're not the owner)"
                        >
                          Following
                        </span>
                      ) : null}
                    </td>
                    <td>
                      {r.stage ? (
                        <span className="pill stage">{r.stage}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className={r.harmony ? "" : "muted"}>
                      {r.harmony || "—"}
                    </td>
                    <td>
                      {r.office ? (
                        <span className="pill office">{r.office}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{r.county || <span className="muted">—</span>}</td>
                    <td>
                      <BlockPill b={r.block} />
                    </td>
                    <td>
                      {r.src ? (
                        <span className="pill src">{r.src}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{r.rep}</td>
                    <td>{r.cm}</td>
                    <td>
                      {r.checked ? (
                        <span className="tick">✓</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length === 0 ? (
              <div className="empty">No records match this filter.</div>
            ) : null}
          </div>
        ) : (
          <div className="board">
            {stages.map((st) => {
              const inCol = boardVisible.filter((r) => r.stage === st);
              return (
                <div className="col" key={st}>
                  <div className="colhead">
                    <span>{st}</span>
                    <span className="pill">{inCol.length}</span>
                  </div>
                  <div className="colbody">
                    {inCol.length ? (
                      inCol.map((r) => (
                        <div
                          className="card"
                          key={r.id}
                          onClick={() => setSelId(r.id)}
                        >
                          <div className="cn">
                            {clientName(r) || "—"}
                            {followsNotOwns(r) ? (
                              <span
                                className="follow-tag"
                                title="You follow this record (you're not the owner)"
                              >
                                Following
                              </span>
                            ) : null}
                          </div>
                          <div className="cm">
                            {r.office || "—"} · {r.rep}
                          </div>
                          <div className="cf">
                            <BlockPill b={r.block} />
                            {r.src ? (
                              <span className="pill src">{r.src}</span>
                            ) : null}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div
                        className="empty"
                        style={{ padding: "18px 4px", fontSize: 11 }}
                      >
                        Empty
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* record panel */}
      <div
        className={`scrim ${selected ? "on" : ""}`}
        onClick={() => setSelId(null)}
      />
      <aside
        className={`panel ${selected ? "on" : ""}`}
        aria-label="Record detail"
      >
        {selected ? (
          <>
            <div className="phead">
              <div style={{ flex: 1 }}>
                <h2>{enrollLabel(selected)}</h2>
                <div className="sub">
                  {clientName(selected) || "—"} · {selected.office || "—"} ·{" "}
                  {selected.stage || "—"}
                </div>
              </div>
              <button
                className="x"
                onClick={() => setSelId(null)}
                type="button"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="pbody">
              <div className="editbanner">
                Edits save to GoHighLevel instantly. External IDs and the
                compliance field are read-only.
              </div>

              <div className="sechead">Record</div>
              <div className="grid">
                <div className="f">
                  <label>Stage</label>
                  <select
                    className="v edit"
                    value={selected.stageId}
                    disabled={savingFk(selected.id, "stage")}
                    onChange={(e) =>
                      saveField(
                        selected,
                        "stage",
                        { stageId: e.target.value },
                        (r) => ({
                          ...r,
                          stageId: e.target.value,
                          stage:
                            pipelineStages.find((s) => s.id === e.target.value)
                              ?.name || r.stage,
                        }),
                      )
                    }
                  >
                    {pipelineStages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  {saveMsgFor(selected.id, "stage")}
                </div>
                <div className="f">
                  <label>Sales Rep (Owner)</label>
                  <select
                    className="v edit"
                    value={selected.ownerId}
                    disabled={savingFk(selected.id, "owner")}
                    onChange={(e) =>
                      saveField(
                        selected,
                        "owner",
                        { assignedTo: e.target.value || null },
                        (r) => ({
                          ...r,
                          ownerId: e.target.value,
                          rep:
                            users.find((u) => u.id === e.target.value)?.name ||
                            "—",
                        }),
                      )
                    }
                  >
                    <option value="">Unassigned</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                  {saveMsgFor(selected.id, "owner")}
                </div>
                <div className="f">
                  <label>
                    Followers (Co-reps)
                    {viewerId &&
                    selected.ownerId !== viewerId &&
                    selected.followerIds.includes(viewerId) ? (
                      <span className="readonly-note">you follow this</span>
                    ) : null}
                  </label>
                  <div className="v ro">
                    {selected.followerNames.length
                      ? selected.followerNames.join(", ")
                      : "—"}{" "}
                    <span className="readonly-note">native GHL</span>
                  </div>
                </div>
                <div className="f">
                  <label>Status</label>
                  <select
                    className="v edit"
                    value={selected.status || "open"}
                    disabled={savingFk(selected.id, "status")}
                    onChange={(e) =>
                      saveField(
                        selected,
                        "status",
                        { status: e.target.value },
                        (r) => ({ ...r, status: e.target.value }),
                      )
                    }
                  >
                    {["open", "won", "lost", "abandoned"].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  {saveMsgFor(selected.id, "status")}
                </div>
              </div>

              <div className="sechead">Fields</div>
              <div className="grid">
                {fieldDefs.map((def) => (
                  <div className="f" key={`${selected.id}:${def.id}`}>
                    <label>{def.name}</label>
                    <FieldControl
                      def={def}
                      value={selected.cf[def.id]}
                      save={saveState[skey(selected.id, def.id)]}
                      onSave={(val) => saveCustomField(selected, def, val)}
                    />
                  </div>
                ))}
                {fieldDefs.length === 0 ? (
                  <div className="f">
                    <div className="v ro">No editable fields loaded.</div>
                  </div>
                ) : null}
              </div>
              <div className="sechead">Notes — display-only stub (Phase 2)</div>
              <div>
                {selNotes.length ? (
                  selNotes.map((n, i) => (
                    <div className="note" key={i}>
                      <div className="nh">
                        <b>{n.who}</b> · {n.when}
                      </div>
                      <p>{n.txt}</p>
                    </div>
                  ))
                ) : (
                  <div className="note">
                    <p className="muted">
                      No notes yet. Notes aren&apos;t saved back to GoHighLevel
                      yet — that arrives in Phase 2. Anything added here is
                      temporary and clears on refresh.
                    </p>
                  </div>
                )}
              </div>
              <div className="addnote">
                <input
                  placeholder="Add a note… (temporary — not saved yet)"
                  value={noteDraft}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addNote();
                  }}
                />
                <button onClick={addNote} type="button">
                  Add
                </button>
              </div>
            </div>
            <div className="panelfoot">
              <span className="hint">
                Full record, comms &amp; files live in GoHighLevel
              </span>
              <a
                className="openghl"
                href={`https://app.gohighlevel.com/v2/location/${LOCATION_ID}/opportunities/list?opp=${selected.id}`}
                target="_blank"
                rel="noopener noreferrer"
                title="Deep-links to the native GHL opportunity record"
              >
                <IconExternal />
                Open in GoHighLevel
              </a>
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}
