"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  OpportunityRecord,
  OpportunitiesResponse,
  ApiError,
  Note,
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

export default function Dashboard() {
  // Phase 3 (Step 0): GHL SSO handshake. `sso` is the decrypted viewer session
  // (or "none" when not embedded / not configured). Filtering is NOT wired yet
  // — this proves the handshake returns a real user before the filter is built.
  const sso = useGhlSession();

  const [data, setData] = useState<OpportunityRecord[]>([]);
  const [pipelineName, setPipelineName] = useState<string>("OLTL Enrollments");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const [stage, setStage] = useState<string>("all");
  const [q, setQ] = useState("");
  const [view, setView] = useState<"list" | "board">("list");
  const [selId, setSelId] = useState<string | null>(null);
  // Ephemeral, in-memory only. Notes are a display-only stub until Phase 2.
  const [notes, setNotes] = useState<Record<string, Note[]>>({});
  const [noteDraft, setNoteDraft] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/opportunities", { cache: "no-store" });
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
    } catch (e) {
      setError({
        error: "Could not reach the dashboard API.",
        detail: e instanceof Error ? e.message : String(e),
      });
      setData([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.filter(
      (r) =>
        (stage === "all" || r.stage === stage) &&
        (needle === "" ||
          `${r.first} ${r.last} ${r.cm} ${r.cg} ${r.rep}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [data, stage, q]);

  const boardVisible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.filter(
      (r) =>
        needle === "" ||
        `${r.first} ${r.last}`.toLowerCase().includes(needle),
    );
  }, [data, q]);

  // Stats.
  const stats = useMemo(() => {
    const blocked = data.filter((r) => r.block !== "None").length;
    const checked = data.filter((r) => r.checked).length;
    const auth = data.filter((r) => r.stage.startsWith("Auth")).length;
    const officeCounts = new Map<string, number>();
    for (const r of data) {
      if (r.office) officeCounts.set(r.office, (officeCounts.get(r.office) || 0) + 1);
    }
    const offices = [...officeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([o, n]) => ({ o, n }));
    return { blocked, checked, auth, offices };
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
              {stats.offices.length ? (
                stats.offices.map((x) => (
                  <span key={x.o}>
                    <b>{x.n}</b> {x.o.split(" ")[0]}
                  </span>
                ))
              ) : (
                <span className="muted">—</span>
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

        <div className="scope admin">
          <span className="tag">All data</span>{" "}
          <b>Showing every record</b> in the {pipelineName} pipeline (
          {data.length}).{" "}
          {sso.status === "ready" ? (
            <>
              Signed in as <b>{sso.session.userName || sso.session.userId}</b>
              {sso.session.role ? ` (role: ${sso.session.role})` : ""}
              {sso.session.activeLocation
                ? ` · location ${sso.session.activeLocation}`
                : ""}
              . Role-based filtering is not applied yet — that is the next step.
            </>
          ) : sso.status === "loading" ? (
            <>Checking the GHL session…</>
          ) : (
            <>No GHL SSO session detected — admin/testing view.</>
          )}
        </div>

        <div className="toolbar">
          <div className="search">
            <IconSearch />
            <input
              placeholder="Search by client, caregiver, case manager…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
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
                  <th>Client</th>
                  <th>Stage</th>
                  <th>Harmony ID</th>
                  <th>Office</th>
                  <th>County</th>
                  <th>Road Blocker</th>
                  <th>Source</th>
                  <th>Sales Rep</th>
                  <th>Case Mgr</th>
                  <th>Checked</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={r.id}
                    className={r.id === selId ? "sel" : ""}
                    onClick={() => setSelId(r.id)}
                  >
                    <td className="strong">{clientName(r) || "—"}</td>
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
                          <div className="cn">{clientName(r) || "—"}</div>
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
              <div className="sechead">Enrollment</div>
              <div className="grid">
                <div className="f">
                  <label>
                    Stage <span className="readonly-note">read-only</span>
                  </label>
                  <div className="v">{selected.stage || "—"}</div>
                </div>
                <div className="f">
                  <label>
                    Road Blocker{" "}
                    <span className="readonly-note">read-only</span>
                  </label>
                  <div className="v">{selected.block}</div>
                </div>
                <div className="f">
                  <label>Harmony ID</label>
                  <div className="v">{selected.harmony || "—"}</div>
                </div>
                <div className="f">
                  <label>County ID</label>
                  <div className="v">{selected.countyId || "—"}</div>
                </div>
                <div className="f">
                  <label>Office</label>
                  <div className="v">{selected.office || "—"}</div>
                </div>
                <div className="f">
                  <label>County</label>
                  <div className="v">{selected.county || "—"}</div>
                </div>
              </div>
              <div className="sechead">People</div>
              <div className="grid">
                <div className="f">
                  <label>Sales Rep (Owner)</label>
                  <div className="v">{selected.rep}</div>
                </div>
                <div className="f">
                  <label>Sales Rep Assistant</label>
                  <div className="v">{selected.asst}</div>
                </div>
                <div className="f">
                  <label>Case Manager</label>
                  <div className="v">{selected.cm}</div>
                </div>
                <div className="f">
                  <label>Onboarding Rep</label>
                  <div className="v">{selected.onb}</div>
                </div>
                <div className="f">
                  <label>Referral Source</label>
                  <div className="v">{selected.ref || "—"}</div>
                </div>
                <div className="f">
                  <label>Caregiver</label>
                  <div className="v">{selected.cg}</div>
                </div>
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
