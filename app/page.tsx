"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  closestCorners,
  type DragEndEvent,
} from "@dnd-kit/core";
import type {
  OpportunityRecord,
  OpportunitiesResponse,
  ApiError,
  Note,
  EditableFieldDef,
} from "@/lib/types";
import { useGhlSession } from "@/lib/useGhlSession";
import ImportWizard from "@/components/ImportWizard";

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
const IconDoc = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M9 13h6M9 17h6" />
  </svg>
);
const IconUpload = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M17 8l-5-5-5 5M12 3v12" />
  </svg>
);
const fmtSize = (bytes: number): string => {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
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

const normName = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");
// Multi-select / long-text fields get a full-width row.
const isWideField = (dt: string): boolean =>
  ["MULTIPLE_OPTIONS", "LARGE_TEXT"].includes((dt || "").toUpperCase());

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

// ---- Sort / group dimensions (dynamic + permission-aware) ----
type DimKind =
  | "single"
  | "multi"
  | "text"
  | "date"
  | "number"
  | "stage"
  | "owner";
interface Dim {
  key: string; // "native:stage" | "native:owner" | "cf:<fieldId>" | column key
  label: string;
  kind: DimKind;
  sortable: boolean;
  groupable: boolean;
}

// A record's value for a dimension, as a display string (used for grouping and
// string sorts). Native + custom-field + existing-column keys all resolve here.
function recordStr(r: OpportunityRecord, key: string): string {
  if (key.startsWith("cf:")) return asStr(r.cf[key.slice(3)]);
  switch (key) {
    case "native:stage":
    case "stage":
      return r.stage;
    case "native:owner":
    case "rep":
      return r.rep;
    case "client":
      return `${r.first} ${r.last}`.trim();
    case "harmony":
      return r.harmony;
    case "office":
      return r.office;
    case "county":
      return r.county;
    case "block":
      return r.block;
    case "src":
      return r.src;
    case "cm":
      return r.cm;
    case "checked":
      return r.checked ? "Checked" : "";
    default:
      return "";
  }
}

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

  const isOptionType =
    t === "SINGLE_OPTIONS" || t === "MULTIPLE_OPTIONS" || t === "CHECKBOX";

  let control: ReactNode;
  if (isOptionType && def.options.length === 0) {
    control = (
      <div className="v ro">
        {asStr(value) || "—"}{" "}
        <span className="readonly-note">no options in GHL</span>
      </div>
    );
  } else if (t === "SINGLE_OPTIONS") {
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

// ---- Board (Kanban) drag-and-drop ----
function BoardColumn({
  stage,
  count,
  children,
}: {
  stage: string;
  count: number;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${stage}` });
  return (
    <div ref={setNodeRef} className={`col${isOver ? " dropover" : ""}`}>
      <div className="colhead">
        <span>{stage}</span>
        <span className="pill">{count}</span>
      </div>
      <div className="colbody">{children}</div>
    </div>
  );
}

// Presentational card content (used by both the in-column card and the overlay).
function CardBody({
  r,
  following,
  saving,
}: {
  r: OpportunityRecord;
  following: boolean;
  saving?: "saving" | "error";
}) {
  return (
    <>
      <div className="cn">
        {`${r.first} ${r.last}`.trim() || "—"}
        {following ? (
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
        {r.src ? <span className="pill src">{r.src}</span> : null}
      </div>
      {saving === "saving" ? (
        <div className="savemsg">Saving…</div>
      ) : saving === "error" ? (
        <div className="savemsg err">✗ didn&apos;t save — reverted</div>
      ) : null}
    </>
  );
}

function BoardCard({
  r,
  canDrag,
  following,
  saving,
  onOpen,
}: {
  r: OpportunityRecord;
  canDrag: boolean;
  following: boolean;
  saving?: "saving" | "error";
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: r.id,
    disabled: !canDrag,
  });
  // No transform here — the DragOverlay renders the moving copy (unclipped by the
  // column's overflow). The source card just dims to a placeholder while dragging.
  return (
    <div
      ref={setNodeRef}
      className={`card${canDrag ? " draggable" : " nodrag"}${
        isDragging ? " ghost" : ""
      }`}
      onClick={onOpen}
      {...(canDrag ? listeners : {})}
      {...attributes}
    >
      <CardBody r={r} following={following} saving={saving} />
    </div>
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
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [groupKey, setGroupKey] = useState<string | null>(null);
  const [view, setView] = useState<
    "list" | "board" | "resources" | "import"
  >("list");
  const [selId, setSelId] = useState<string | null>(null);
  // Resources tab (folder-scoped GHL media).
  const [resources, setResources] = useState<
    { name: string; url: string; type: string; size: number }[]
  >([]);
  const [resLoading, setResLoading] = useState(false);
  const [resErr, setResErr] = useState<string | null>(null);
  const [resLoaded, setResLoaded] = useState(false);
  // Persistent notes (stored on the contact, scoped to the opportunity).
  const [notes, setNotes] = useState<Record<string, Note[]>>({});
  const [noteDraft, setNoteDraft] = useState("");
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesErr, setNotesErr] = useState<string | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteErr, setNoteErr] = useState<string | null>(null);

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

  // Fetch the folder-scoped resources fresh (signed URLs are TTL'd).
  const loadResources = useCallback(async () => {
    setResLoading(true);
    setResErr(null);
    try {
      const headers: Record<string, string> = {};
      if (sso.status === "ready") headers["x-ghl-sso-key"] = sso.blob;
      const res = await fetch("/api/resources", { headers, cache: "no-store" });
      const j = (await res.json().catch(() => ({}))) as {
        resources?: { name: string; url: string; type: string; size: number }[];
        error?: string;
        detail?: string;
      };
      if (!res.ok) throw new Error(j.detail || j.error || `HTTP ${res.status}`);
      setResources(j.resources || []);
      setResLoaded(true);
    } catch (e) {
      setResErr(e instanceof Error ? e.message : String(e));
    } finally {
      setResLoading(false);
    }
  }, [sso]);

  // Load the Resources tab once, when first opened.
  useEffect(() => {
    if (view === "resources" && !resLoaded && sso.status !== "loading")
      loadResources();
  }, [view, resLoaded, sso.status, loadResources]);

  // Load this opportunity's notes when the panel opens (server re-checks access).
  useEffect(() => {
    if (!selId || sso.status === "loading") return;
    let cancelled = false;
    setNotesLoading(true);
    setNotesErr(null);
    setNoteErr(null);
    const headers: Record<string, string> = {};
    if (sso.status === "ready") headers["x-ghl-sso-key"] = sso.blob;
    fetch(`/api/opportunities/${selId}/notes`, { headers, cache: "no-store" })
      .then(async (res) => {
        const j = (await res.json().catch(() => ({}))) as {
          notes?: Note[];
          error?: string;
          detail?: string;
        };
        if (!res.ok) throw new Error(j.detail || j.error || `HTTP ${res.status}`);
        if (!cancelled)
          setNotes((prev) => ({
            ...prev,
            [selId]: (j.notes || []).map((n) => ({
              who: n.who,
              when: n.when,
              txt: n.txt,
            })),
          }));
      })
      .catch((e) => {
        if (!cancelled) setNotesErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setNotesLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId, sso.status]);

  // Admin (or the open no-SSO setup view) sees everything; a restricted signed-in
  // user sees only their assigned records. ROLE-ONLY, mirroring the server rule
  // (GHL `type` is account context, not permission).
  const isAdminViewer =
    sso.status === "none" ||
    (sso.status === "ready" && sso.session.role === "admin");

  // Current viewer's user id (when signed in) — used to show why a record is
  // visible: "Following" when the viewer is a follower but not the owner.
  const viewerId = sso.status === "ready" ? sso.session.userId : null;
  const followsNotOwns = (r: OpportunityRecord) =>
    !!viewerId && r.ownerId !== viewerId && r.followerIds.includes(viewerId);
  // Same permission rule as the edit panel / save route: admins edit all; others
  // only records they own or follow. Used to gate Kanban dragging client-side
  // (the save route's 403 is the server-side backstop).
  const canEdit = (r: OpportunityRecord) =>
    isAdminViewer ||
    (!!viewerId &&
      (r.ownerId === viewerId || r.followerIds.includes(viewerId)));

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

  const stageIndex = useCallback(
    (name: string) => {
      const i = stages.indexOf(name);
      return i === -1 ? 999 : i;
    },
    [stages],
  );

  // All sort/group dimensions, derived from the field definitions + natives.
  // Owner is offered only to admins (for a rep it's a constant, degenerate dim).
  const dimensions = useMemo<Dim[]>(() => {
    const out: Dim[] = [
      { key: "native:stage", label: "Stage", kind: "stage", sortable: true, groupable: true },
    ];
    if (isAdminViewer)
      out.push({ key: "native:owner", label: "Sales Rep (Owner)", kind: "owner", sortable: true, groupable: true });
    for (const def of fieldDefs) {
      const t = (def.dataType || "").toUpperCase();
      let kind: DimKind = "text";
      let groupable = false;
      if (t === "SINGLE_OPTIONS") {
        kind = "single";
        groupable = true;
      } else if (t === "MULTIPLE_OPTIONS") {
        kind = "multi";
        groupable = true;
      } else if (t === "DATE") {
        kind = "date";
      } else if (t === "MONETORY" || t === "NUMERICAL" || t === "NUMBER") {
        kind = "number";
      }
      out.push({ key: `cf:${def.id}`, label: def.name, kind, sortable: true, groupable });
    }
    return out;
  }, [fieldDefs, isAdminViewer]);

  const dimByKey = useMemo(
    () => new Map(dimensions.map((d) => [d.key, d])),
    [dimensions],
  );

  // Only offer a dimension when it produces meaningful variation across the
  // records THIS viewer can see (data = the server-filtered set). Constant
  // fields (e.g. Owner for a rep) are hidden; all-unique fields aren't groupable.
  const distinctCount = useCallback(
    (key: string) => {
      const s = new Set<string>();
      for (const r of data) s.add(recordStr(r, key) || "—");
      return s.size;
    },
    [data],
  );
  const sortDims = useMemo(
    () => dimensions.filter((d) => d.sortable && distinctCount(d.key) >= 2),
    [dimensions, distinctCount],
  );
  const groupDims = useMemo(
    () =>
      dimensions.filter((d) => {
        if (!d.groupable) return false;
        const n = distinctCount(d.key);
        return n >= 2 && n < data.length; // not constant, not all-unique
      }),
    [dimensions, distinctCount, data.length],
  );

  const cmpBy = useCallback(
    (a: OpportunityRecord, b: OpportunityRecord, key: string): number => {
      if (key === "native:stage" || key === "stage")
        return stageIndex(a.stage) - stageIndex(b.stage);
      if (key === "checked") return (a.checked ? 1 : 0) - (b.checked ? 1 : 0);
      const kind = dimByKey.get(key)?.kind;
      if (kind === "date")
        return (
          (Date.parse(recordStr(a, key)) || 0) -
          (Date.parse(recordStr(b, key)) || 0)
        );
      if (kind === "number")
        return (
          (parseFloat(recordStr(a, key)) || 0) -
          (parseFloat(recordStr(b, key)) || 0)
        );
      return recordStr(a, key).localeCompare(recordStr(b, key));
    },
    [dimByKey, stageIndex],
  );

  // Filtered + sorted list.
  const visible = useMemo(() => {
    if (!sortKey) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => dir * cmpBy(a, b, sortKey));
  }, [filtered, sortKey, sortDir, cmpBy]);

  // Group the (already sorted) list by the chosen dimension.
  const grouped = useMemo(() => {
    if (!groupKey) return null;
    const m = new Map<string, OpportunityRecord[]>();
    for (const r of visible) {
      const v = recordStr(r, groupKey) || "—";
      const arr = m.get(v);
      if (arr) arr.push(r);
      else m.set(v, [r]);
    }
    const g = [...m.entries()].map(([value, rows]) => ({ value, rows }));
    if (groupKey === "native:stage" || groupKey === "stage")
      g.sort((a, b) => stageIndex(a.value) - stageIndex(b.value));
    else g.sort((a, b) => b.rows.length - a.rows.length || a.value.localeCompare(b.value));
    return g;
  }, [visible, groupKey, stageIndex]);

  const groupLabel = groupKey ? dimByKey.get(groupKey)?.label || "" : "";

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const renderRow = (r: OpportunityRecord) => (
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
      <td className={r.harmony ? "" : "muted"}>{r.harmony || "—"}</td>
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
  );

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

  const ssoHeader = (): Record<string, string> =>
    sso.status === "ready" ? { "x-ghl-sso-key": sso.blob } : {};

  const addNote = async () => {
    const v = noteDraft.trim();
    if (!v || !selId || noteBusy) return;
    setNoteBusy(true);
    setNoteErr(null);
    try {
      const res = await fetch(`/api/opportunities/${selId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ssoKey: sso.status === "ready" ? sso.blob : undefined,
          body: v,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        note?: Note;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !j.ok || !j.note)
        throw new Error(j.detail || j.error || `HTTP ${res.status}`);
      const n = j.note;
      setNotes((prev) => ({
        ...prev,
        [selId]: [{ who: n.who, when: n.when, txt: n.txt }, ...(prev[selId] || [])],
      }));
      setNoteDraft(""); // clear only on success — never lose typed input
    } catch (e) {
      setNoteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setNoteBusy(false);
    }
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

  // Kanban drag: 6px activation so a click still opens the record; keyboard too.
  const [dragId, setDragId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const { active, over } = e;
    if (!over) return;
    const overId = String(over.id);
    if (!overId.startsWith("col:")) return;
    const targetStage = overId.slice(4);
    const rec = data.find((x) => x.id === active.id);
    if (!rec || rec.stage === targetStage || !canEdit(rec)) return;
    const target = pipelineStages.find((s) => s.name === targetStage);
    if (!target) return;
    // Reuse the proven save path: optimistic move + PATCH (pipelineStageId) +
    // revert-on-error. Save by stage ID, never name.
    saveField(
      rec,
      "stage",
      { stageId: target.id },
      (r) => ({ ...r, stage: targetStage, stageId: target.id }),
    );
  };

  // Board columns = the FULL OLTL pipeline (every stage, incl. empty ones) so you
  // can drag into an empty stage. Falls back to data-derived stages pre-load, and
  // appends any stray stage present in data but not in the pipeline list.
  const boardStages = useMemo(() => {
    if (!pipelineStages.length) return stages;
    const names = pipelineStages.map((s) => s.name);
    const set = new Set(names);
    for (const r of data)
      if (r.stage && !set.has(r.stage)) {
        set.add(r.stage);
        names.push(r.stage);
      }
    return names;
  }, [pipelineStages, data, stages]);

  const saveMsgFor = (id: string, fk: string): ReactNode => {
    const s = saveState[skey(id, fk)];
    if (s?.status === "saving") return <div className="savemsg">Saving…</div>;
    if (s?.status === "error")
      return <div className="savemsg err">✗ {s.msg || "Save failed"}</div>;
    return null;
  };
  const savingFk = (id: string, fk: string) =>
    saveState[skey(id, fk)]?.status === "saving";

  // Look up a field definition by (fuzzy) name, and render its editor cell.
  const fieldByName = (name: string) =>
    fieldDefs.find((d) => normName(d.name) === normName(name));

  // Render a set of custom fields by name (skips any not present here).
  const renderCFs = (rec: OpportunityRecord, names: string[]): ReactNode =>
    names.map((name) => {
      const def = fieldByName(name);
      if (!def) return null;
      return (
        <div
          className={`f${isWideField(def.dataType) ? " wide" : ""}`}
          key={`${rec.id}:${def.id}`}
        >
          <label>{def.name}</label>
          <FieldControl
            def={def}
            value={rec.cf[def.id]}
            save={saveState[skey(rec.id, def.id)]}
            onSave={(val) => saveCustomField(rec, def, val)}
          />
        </div>
      );
    });

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
            <button
              className={view === "resources" ? "on" : ""}
              onClick={() => setView("resources")}
              type="button"
            >
              <IconDoc />
              Resources
            </button>
            {isAdminViewer && (
              <button
                className={view === "import" ? "on" : ""}
                onClick={() => setView("import")}
                type="button"
              >
                <IconUpload />
                Import
              </button>
            )}
          </div>
        </div>

        {/* opportunity-only controls (hidden on the Resources / Import tabs) */}
        {view !== "resources" && view !== "import" && (
        <>
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
          <div className="officefilter">
            <label htmlFor="sortSel">Sort</label>
            <select
              id="sortSel"
              value={sortKey ?? ""}
              onChange={(e) => setSortKey(e.target.value || null)}
            >
              <option value="">Default order</option>
              {sortDims.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="dirbtn"
              title={sortDir === "asc" ? "Ascending" : "Descending"}
              disabled={!sortKey}
              onClick={() =>
                setSortDir((dd) => (dd === "asc" ? "desc" : "asc"))
              }
            >
              {sortDir === "asc" ? "▲" : "▼"}
            </button>
          </div>
          <div className="officefilter">
            <label htmlFor="groupSel">Group</label>
            <select
              id="groupSel"
              value={groupKey ?? ""}
              onChange={(e) => setGroupKey(e.target.value || null)}
            >
              <option value="">No grouping</option>
              {groupDims.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.label}
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
        </>
        )}

        {/* content: Import tab (admin), Resources tab, else loading / error / list / board */}
        {view === "import" ? (
          isAdminViewer ? (
            <ImportWizard ssoBlob={sso.status === "ready" ? sso.blob : null} />
          ) : (
            <div className="empty">
              <b>Admins only</b>
              <br />
              The bulk import tool is restricted to admin users.
            </div>
          )
        ) : view === "resources" ? (
          <div className="scroll reswrap">
            {resLoading ? (
              <div className="statewrap">
                <div className="statecard">
                  <div className="spinner" />
                  <h3>Loading resources…</h3>
                  <p>Fetching documents from the OLTL Resources folder.</p>
                </div>
              </div>
            ) : resErr ? (
              <div className="statewrap">
                <div className="statecard">
                  <h3>
                    <span className="errdot">●</span> Couldn&apos;t load resources
                  </h3>
                  <p>{resErr}</p>
                  <button
                    className="retry"
                    onClick={loadResources}
                    type="button"
                  >
                    Try again
                  </button>
                </div>
              </div>
            ) : resources.length === 0 ? (
              <div className="empty">
                <b>No resources yet</b>
                <br />
                Add documents to the OLTL Resources folder in GoHighLevel.
              </div>
            ) : (
              <div className="resgrid">
                {resources.map((f, i) => (
                  <a
                    key={`${f.url}-${i}`}
                    className="rescard"
                    href={f.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <span className="ricon">
                      <IconDoc />
                    </span>
                    <span className="rbody">
                      <span className="rname">{f.name}</span>
                      <span className="rmeta">
                        {(f.type || "file")}
                        {f.size ? ` · ${fmtSize(f.size)}` : ""}
                      </span>
                    </span>
                    <span className="ropen">Open ↗</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        ) : loading ? (
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
                {grouped
                  ? grouped.map((g) => (
                      <Fragment key={g.value}>
                        <tr className="grouprow">
                          <td colSpan={COLUMNS.length}>
                            <span className="glabel">{groupLabel}</span>
                            <span className="gvalue">{g.value}</span>
                            <span className="gcount">{g.rows.length}</span>
                          </td>
                        </tr>
                        {g.rows.map((r) => renderRow(r))}
                      </Fragment>
                    ))
                  : visible.map((r) => renderRow(r))}
              </tbody>
            </table>
            {visible.length === 0 ? (
              <div className="empty">No records match this filter.</div>
            ) : null}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={(e) => setDragId(String(e.active.id))}
            onDragCancel={() => setDragId(null)}
            onDragEnd={onDragEnd}
          >
            <div className="board">
              {boardStages.map((st) => {
                const inCol = boardVisible.filter((r) => r.stage === st);
                return (
                  <BoardColumn key={st} stage={st} count={inCol.length}>
                    {inCol.length ? (
                      inCol.map((r) => (
                        <BoardCard
                          key={r.id}
                          r={r}
                          canDrag={canEdit(r)}
                          following={followsNotOwns(r)}
                          saving={saveState[skey(r.id, "stage")]?.status}
                          onOpen={() => setSelId(r.id)}
                        />
                      ))
                    ) : (
                      <div
                        className="empty"
                        style={{ padding: "18px 4px", fontSize: 11 }}
                      >
                        Empty
                      </div>
                    )}
                  </BoardColumn>
                );
              })}
            </div>
            <DragOverlay dropAnimation={null}>
              {(() => {
                const r = dragId
                  ? data.find((x) => x.id === dragId)
                  : null;
                return r ? (
                  <div className="card dragging" style={{ width: 242 }}>
                    <CardBody r={r} following={followsNotOwns(r)} />
                  </div>
                ) : null;
              })()}
            </DragOverlay>
          </DndContext>
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

              {/* 1 — Status & Workflow (most-used, top) */}
              <div className="sechead">Status &amp; Workflow</div>
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
                {renderCFs(selected, ["Road Blocker"])}
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
                {renderCFs(selected, [
                  "Checked This Week",
                  "Appeal",
                  "Waiting",
                ])}
              </div>

              {/* 2 — Assignment */}
              <div className="sechead">Assignment</div>
              <div className="grid">
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
                {renderCFs(selected, [
                  "Case Manager",
                  "Sales Rep Assistant",
                  "Onboarding Rep",
                  "HR / Assigned Team",
                ])}
              </div>

              {/* 3 — Location */}
              <div className="sechead">Location</div>
              <div className="grid">
                {renderCFs(selected, ["Office", "County"])}
              </div>

              {/* 4 — Enrollment Details */}
              <div className="sechead">Enrollment Details</div>
              <div className="grid">
                {renderCFs(selected, [
                  "Division",
                  "Type",
                  "Referral Source Type",
                  "Caregiver Name",
                ])}
              </div>

              {/* 5 — System info (read-only, collapsed) */}
              <details className="sysinfo">
                <summary>System info · read-only</summary>
                <div className="grid">
                  {renderCFs(selected, [
                    "Harmony ID",
                    "County ID",
                    "Airtable Record ID",
                    "APP - Compliance Cleared",
                  ])}
                </div>
              </details>
              <div className="sechead">Notes</div>
              <div>
                {notesLoading ? (
                  <div className="note">
                    <p className="muted">Loading notes…</p>
                  </div>
                ) : notesErr ? (
                  <div className="note">
                    <p className="savemsg err">✗ {notesErr}</p>
                  </div>
                ) : selNotes.length ? (
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
                    <p className="muted">No notes yet.</p>
                  </div>
                )}
              </div>
              <div className="addnote">
                <input
                  placeholder="Add a note…"
                  value={noteDraft}
                  disabled={noteBusy}
                  onChange={(e) => setNoteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addNote();
                  }}
                />
                <button onClick={addNote} type="button" disabled={noteBusy}>
                  {noteBusy ? "Adding…" : "Add"}
                </button>
              </div>
              {noteErr ? (
                <div className="savemsg err" style={{ marginTop: 6 }}>
                  ✗ {noteErr}
                </div>
              ) : null}
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
