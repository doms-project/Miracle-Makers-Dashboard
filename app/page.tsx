"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, failureMessage } from "@/lib/apiFetch";
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
  RelationCounts,
  EditableFieldDef,
} from "@/lib/types";
import { useGhlSession } from "@/lib/useGhlSession";
import ImportWizard from "@/components/ImportWizard";
import CaregiversSection from "@/components/CaregiversSection";
import EmailComposer from "@/components/EmailComposer";
import { groupFieldsForPipeline } from "@/lib/fieldFolders";
import MoveDialog from "@/components/MoveDialog";
import UserPicker from "@/components/UserPicker";
import HybridPicker from "@/components/HybridPicker";
import ConfirmDialog from "@/components/ConfirmDialog";
import { toDateInput, formatGhlDate, hasTime, nameImpliesTime } from "@/lib/dates";
import AddClientDialog from "@/components/AddClientDialog";
import PipelineAccessTab from "@/components/PipelineAccessTab";
import { divisionLabel } from "@/lib/division";

const LOCATION_ID =
  process.env.NEXT_PUBLIC_GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X";

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
// The panel header. The OPPORTUNITY's own name leads — one contact can hold
// several opportunities, and heading them all with the contact name made two
// different records look identical.
const enrollLabel = (r: OpportunityRecord) =>
  `${r.oppName || r.last || r.first || "Record"} — ${
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
const IconKey = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="M10.8 12.2L21 2m-4 4l3 3m-6-6l3 3" />
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

// Multi-select / long-text fields get a full-width row.
const isWideField = (dt: string): boolean =>
  ["MULTIPLE_OPTIONS", "LARGE_TEXT"].includes((dt || "").toUpperCase());

const asStr = (v: unknown): string =>
  Array.isArray(v) ? v.map(String).join(", ") : v == null ? "" : String(v);
const asArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)];
// ITEM 1 — these now go through lib/dates.ts, which handles the epoch-ms shape
// the SEARCH endpoint returns. The old version fed "1787875200000" to
// `new Date(string)`, got Invalid Date, and fell through to `s.slice(0,10)` —
// "1787875200", which <input type="date"> silently rejected.
const asDate = (v: unknown): string => toDateInput(v);

// Display for any DATE value: epoch ms, epoch seconds, bare date or ISO, all
// rendered the same way, in UTC so the day can never shift.
// A time is shown ONLY if the stored value actually carries one. GHL truncates
// DATE fields to the calendar date, so in practice this never fires — it stays
// as a guard so a value written by some other system isn't silently trimmed on
// display. The field's name has no say in it: names promise what the field type
// cannot deliver.
const asDateText = (v: unknown, _def?: { name?: string }): string =>
  formatGhlDate(v, { withTime: hasTime(v) });

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
  const initial = type === "date" ? toDateInput(value) : asStr(value);
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

// ---- Sensitive fields (Task 8) ----
// SSN renders masked by default with click-to-reveal, so it isn't exposed in
// screen-shares. Matched by NAME (never a hardcoded field id), consistent with
// the rest of the field resolution.
//
// ⚠️ This is NOT a security boundary: the value is already in the API payload
// either way, so anyone with devtools can read it. It reduces casual/shoulder
// exposure only. Restricting who receives the value would have to happen
// server-side.
const isSensitiveField = (name: string): boolean =>
  /social\s*security|(^|\W)ssn(\W|$)/i.test(name || "");

// "123-45-2550" -> "•••-••-2550" (keeps the last 4, which is what reps read back).
function maskSsn(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  const digits = s.replace(/\D/g, "");
  if (digits.length < 4) return "•".repeat(s.length);
  return `•••-••-${digits.slice(-4)}`;
}

function MaskedControl({
  value,
  disabled,
  onSave,
}: {
  value: unknown;
  disabled?: boolean;
  onSave: (v: unknown) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const raw = asStr(value);
  if (!revealed) {
    return (
      <div className="v ro masked">
        <span className="maskval">{raw ? maskSsn(raw) : "—"}</span>
        <button
          type="button"
          className="maskbtn"
          onClick={() => setRevealed(true)}
        >
          Show
        </button>
      </div>
    );
  }
  return (
    <div className="maskedwrap">
      <TextControl value={value} disabled={disabled} onSave={onSave} />
      <button
        type="button"
        className="maskbtn"
        onClick={() => setRevealed(false)}
      >
        Hide
      </button>
    </div>
  );
}

// One editable/read-only control chosen by the field's GHL dataType.
// ITEM 4 — the four CUSTOM people-fields get the hybrid picker: GHL users
// listed automatically, plus admin-added names for people without a login.
// Matched by NAME so a rename in GHL is the only thing that needs attention,
// and no field ids are hardcoded.
const PEOPLE_FIELDS = [
  "Onboarding Rep",
  "Case Manager",
  "Sales Rep Assistant",
  "HR / Assigned Team",
];
const PEOPLE_SET = new Set(
  PEOPLE_FIELDS.map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, "")),
);
const isPeopleField = (name: string): boolean =>
  PEOPLE_SET.has((name || "").toLowerCase().replace(/[^a-z0-9]/g, ""));

function FieldControl({
  def,
  value,
  save,
  onSave,
  users,
  isAdmin,
  ssoBlob,
  onOptionAdded,
}: {
  def: EditableFieldDef;
  value: unknown;
  save: SaveState;
  onSave: (v: unknown) => void;
  users: { id: string; name: string; divisions?: string[] }[];
  isAdmin: boolean;
  ssoBlob: string | null;
  onOptionAdded: (fieldId: string, options: string[]) => void;
}) {
  const t = (def.dataType || "").toUpperCase();
  const disabled = save?.status === "saving";
  const sensitive = isSensitiveField(def.name);

  if (!def.editable) {
    // A read-only sensitive field is still masked (reveal shows the value).
    if (sensitive)
      return (
        <MaskedControl value={value} disabled onSave={() => {}} />
      );
    // ITEM 1 — THE reported bug. Transferred Date is read-only, so it rendered
    // through `asStr(value)` and printed the raw epoch `1787875200000`.
    return (
      <div className="v ro">
        {(t === "DATE" ? asDateText(value, def) : asStr(value)) || "—"}{" "}
        <span className="readonly-note">read-only</span>
      </div>
    );
  }

  const isOptionType =
    t === "SINGLE_OPTIONS" || t === "MULTIPLE_OPTIONS" || t === "CHECKBOX";

  let control: ReactNode;
  if (sensitive) {
    // Masked with click-to-reveal, ahead of the dataType branches.
    control = (
      <MaskedControl value={value} disabled={disabled} onSave={onSave} />
    );
  } else if (isPeopleField(def.name) && isOptionType) {
    // ITEM 4 — these four rendered as a plain picklist showing only "TBD",
    // because their GHL option lists are nearly empty while most of the people
    // who belong in them are GHL users. The stored value stays a plain string
    // and the field's dataType is untouched.
    control = (
      <HybridPicker
        fieldId={def.id}
        fieldName={def.name}
        users={users}
        options={def.options}
        value={t === "MULTIPLE_OPTIONS" ? asArr(value) : asStr(value)}
        multi={t === "MULTIPLE_OPTIONS"}
        disabled={disabled}
        isAdmin={isAdmin}
        ssoBlob={ssoBlob}
        onChange={onSave}
        onOptionAdded={onOptionAdded}
      />
    );
  } else if (isOptionType && def.options.length === 0) {
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
    // DATE-ONLY, for every field including the two named "…Date and Time".
    //
    // Proven with a real write: GHL accepts a full ISO timestamp with a 200 and
    // stores only the calendar date ("2026-08-28T14:30:00.000Z" -> "2026-08-28").
    // A datetime editor would therefore let a rep enter an appointment time that
    // vanishes on save — silently, with a success message. Not offering the
    // input is strictly better than offering one that lies.
    control = (
      <>
        <TextControl
          value={value}
          type="date"
          disabled={disabled}
          onSave={onSave}
        />
        {/* The stored value, formatted — so a mis-parse is visible rather than
            showing an empty input that looks like "no value set". */}
        {asDateText(value, def) ? (
          <div className="datehint">{asDateText(value, def)}</div>
        ) : null}
        {/* The field's NAME promises a time this field type cannot hold. Say so
            where it matters, rather than leaving a rep to wonder where the time
            input went. Name-driven: rename the field in GHL to drop "and Time"
            and this disappears by itself. */}
        {nameImpliesTime(def.name) ? (
          <div className="datewarn">
            Date only — GoHighLevel can&apos;t store a time on this field. Record
            the time in a note.
          </div>
        ) : null}
      </>
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
// A signed-in non-admin with no pipeline grants and nothing of their own.
// Deliberately NOT error styling: fail-closed access is working as designed, and
// the person reading this has done nothing wrong. It exists because "no access"
// and "your pipelines are empty" produced an identical blank screen, and the
// first one needs an action from somebody else.
function NoAccessNotice() {
  return (
    <div className="empty noaccess">
      <b>No pipelines assigned yet</b>
      <br />
      You&apos;ll see cases here once an admin gives you access to a pipeline.
      Anything shared with you directly will appear here too.
    </div>
  );
}

function CardBody({
  r,
  following,
  saving,
  relBadge,
}: {
  r: OpportunityRecord;
  following: boolean;
  saving?: "saving" | "error";
  // BUG 2 — "1 caregiver" / "2 clients". Passed in rather than computed here so
  // the card stays a pure renderer and the counts load in one place.
  relBadge?: string;
}) {
  return (
    <>
      <div className="cn">
        {r.oppName || `${r.first} ${r.last}`.trim() || "—"}
        {following ? (
          <span
            className="follow-tag"
            title="You follow this record (you're not the owner)"
          >
            Following
          </span>
        ) : null}
      </div>
      {r.oppName && `${r.first} ${r.last}`.trim() &&
      `${r.first} ${r.last}`.trim() !== r.oppName ? (
        <div className="ccontact" title="Contact">
          {`${r.first} ${r.last}`.trim()}
        </div>
      ) : null}
      {r.cg && r.cg !== "—" ? (
        <div className="ccg" title="Caregiver">
          🧑‍⚕️ {r.cg}
        </div>
      ) : null}
      <div className="cm">
        {r.office || "—"} · {r.rep}
      </div>
      {r.pipelineName ? (
        <div className="cdiv" title={r.pipelineName}>
          {r.pipelineName}
        </div>
      ) : null}
      <div className="cf">
        <BlockPill b={r.block} />
        {r.src ? <span className="pill src">{r.src}</span> : null}
        {relBadge ? (
          <span
            className="pill rellink"
            title="Linked through the caregiver ↔ client association"
          >
            ⇄ {relBadge}
          </span>
        ) : null}
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
  relBadge,
  onOpen,
}: {
  r: OpportunityRecord;
  canDrag: boolean;
  following: boolean;
  saving?: "saving" | "error";
  relBadge?: string;
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
      <CardBody r={r} following={following} saving={saving} relBadge={relBadge} />
    </div>
  );
}

export default function Dashboard() {
  // Phase 3 (Step 0): GHL SSO handshake. `sso` is the decrypted viewer session
  // (or "none" when not embedded / not configured). Filtering is NOT wired yet
  // — this proves the handshake returns a real user before the filter is built.
  const sso = useGhlSession();

  const [data, setData] = useState<OpportunityRecord[]>([]);
  // v1 shipped a single pipeline, so the header read a `pipelineName` state that
  // was seeded from `body.pipeline.name`. Task 2 made the payload multi-pipeline
  // (`pipeline` is now null, `pipelines` is the list), so that setter never fired
  // and every user saw the stale seed "OLTL Enrollments". The label is now
  // DERIVED from what the viewer can actually see — see `headerLabel` below.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  // Phase 2 editing metadata (from the API) + per-field save state.
  const [fieldDefs, setFieldDefs] = useState<EditableFieldDef[]>([]);
  const [pipelineStages, setPipelineStages] = useState<
    { id: string; name: string }[]
  >([]);
  const [users, setUsers] = useState<
    { id: string; name: string; divisions?: string[] }[]
  >([]);
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  // v2 UI — viewer's home pipelines + the division / shared-with-me filter.
  const [homePipelineIds, setHomePipelineIds] = useState<string[]>([]);
  const [scope, setScope] = useState<string>("all"); // "all" | "shared" | <division>
  const [adminPipeline, setAdminPipeline] = useState<string>("all");
  // Multi-pipeline metadata (v2) — drives the Move dialog.
  const [pipelines, setPipelines] = useState<{ id: string; name: string }[]>([]);
  const [stagesByPipeline, setStagesByPipeline] = useState<
    Record<string, { id: string; name: string }[]>
  >({});
  const [moveOpen, setMoveOpen] = useState(false);

  const [stage, setStage] = useState<string>("all");
  const [office, setOffice] = useState<string>("all"); // office filter (client req)
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [groupKey, setGroupKey] = useState<string | null>(null);
  // The Kanban board is the landing view. Safe because the board already renders
  // the no-access empty state (added in report 33 for exactly this reason: it
  // draws one column per HOME pipeline, so an unmapped user would otherwise land
  // on a completely blank screen rather than a merely empty one).
  const [view, setView] = useState<
    "list" | "board" | "resources" | "import" | "access"
  >("board");
  const [selId, setSelId] = useState<string | null>(null);
  // Resources tab (folder-scoped GHL media).
  const [resources, setResources] = useState<
    { name: string; url: string; type: string; size: number }[]
  >([]);
  const [resLoading, setResLoading] = useState(false);
  const [resErr, setResErr] = useState<string | null>(null);
  const [resLoaded, setResLoaded] = useState(false);
  const [resQuery, setResQuery] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    name: string;
    url: string;
    kind: "pdf" | "image";
  } | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  // Persistent notes (stored on the contact, scoped to the opportunity).
  const [notes, setNotes] = useState<Record<string, Note[]>>({});
  const [noteDraft, setNoteDraft] = useState("");
  // ITEM 3 — Add Lead modal.
  const [addOpen, setAddOpen] = useState(false);
  // BUG 2 — caregiver/client link counts, keyed by contactId, for the row and
  // card badges. Loaded AFTER the list, for the records actually on screen:
  // GHL has no bulk relations query, so counts for N records cost N upstream
  // calls, and putting that on the critical path of the primary view for a
  // secondary signal is the wrong trade. A failure here means no badges and
  // nothing else.
  const [relCounts, setRelCounts] = useState<RelationCounts>({});
  // ITEM 4 — the note currently being edited, and its working text.
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  // ITEM 2 — the note pending removal. window.confirm() is never used: this app
  // runs inside a GHL iframe, where a sandboxed frame without `allow-modals`
  // makes confirm() return false with no prompt — the click just dies.
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
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
      if (body.fieldDefs) setFieldDefs(body.fieldDefs);
      if (body.stages) setPipelineStages(body.stages);
      if (body.users) setUsers(body.users);
      if (body.pipelines) setPipelines(body.pipelines);
      if (body.stagesByPipeline) setStagesByPipeline(body.stagesByPipeline);
      if (body.viewer?.homePipelineIds)
        setHomePipelineIds(body.viewer.homePipelineIds);
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

  // Close the email composer / Move dialog whenever the record changes/closes.
  useEffect(() => {
    setEmailOpen(false);
    setMoveOpen(false);
  }, [selId]);

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
      if (!res.ok) throw new Error(failureMessage(res, j));
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

  // Admin upload → the configured Resources folder (server-side; token never in
  // browser).
  const uploadResource = useCallback(
    async (file: File) => {
      setUploadMsg(null);
      if (file.size > 4 * 1024 * 1024) {
        setUploadMsg("✗ File too large — max 4 MB (Vercel serverless limit).");
        return;
      }
      setUploading(true);
      try {
        const headers: Record<string, string> = {};
        if (sso.status === "ready") headers["x-ghl-sso-key"] = sso.blob;
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/resources/upload", {
          method: "POST",
          headers,
          body: fd,
        });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          detail?: string;
        };
        if (!res.ok) throw new Error(failureMessage(res, j));
        setUploadMsg(`✓ Uploaded ${file.name}`);
        setResLoaded(false); // force a fresh list on next tick
        await loadResources();
      } catch (e) {
        setUploadMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setUploading(false);
      }
    },
    [sso, loadResources],
  );

  // Classify a resource for preview vs download by extension/mime.
  const previewKind = useCallback(
    (f: { name: string; type: string }): "pdf" | "image" | null => {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      const mime = (f.type || "").toLowerCase();
      if (ext === "pdf" || mime.includes("pdf")) return "pdf";
      if (
        ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext) ||
        mime.startsWith("image/")
      )
        return "image";
      return null; // office docs & others → download only (signed-URL TTL)
    },
    [],
  );

  const visibleResources = useMemo(() => {
    const t = resQuery.trim().toLowerCase();
    if (!t) return resources;
    return resources.filter((f) => f.name.toLowerCase().includes(t));
  }, [resources, resQuery]);

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
        if (!res.ok) throw new Error(failureMessage(res, j));
        if (!cancelled)
          setNotes((prev) => ({
            ...prev,
            // Keep the WHOLE note. This used to rebuild it as
            // { who, when, txt } — which silently dropped `division`, so the
            // panel's `n.division ? …` badge could never render even when the
            // server had stamped it correctly. It now also carries `id`,
            // `authorId` and `edited`, which the edit affordance needs.
            [selId]: j.notes || [],
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

  // Division / "Shared with me" filter options are built from the FILTERED
  // PAYLOAD — never from the pipeline list — so the dropdown can't name a
  // division the viewer holds nothing in. A shared record's pipeline never
  // becomes a division option (it appears only under "Shared with me").
  // ITEM 1 — the pipeline selector is for ANY viewer holding more than one
  // pipeline, not just admins. Bill has ODP Enrollment + ODP Transfer and his
  // list merged both with no way to see one at a time.
  //
  // This is NOT a permission change: the server already decided what comes back,
  // and these options are built from the viewer's OWN home pipelines. An admin
  // gets the full selected set (they legitimately see everything); a rep gets
  // only theirs, so the control can never name a pipeline they hold nothing in.
  const selectablePipelines = useMemo(() => {
    if (isAdminViewer) return pipelines;
    const home = new Set(homePipelineIds);
    return pipelines.filter((p) => home.has(p.id));
  }, [isAdminViewer, pipelines, homePipelineIds]);

  // Counts come from `data` — the full payload for this viewer — so each option
  // reads "ODP Transfer (83)" and the totals add up to the "All" figure
  // regardless of the other filters.
  const pipelineCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of data) m.set(r.pipelineId, (m.get(r.pipelineId) || 0) + 1);
    return m;
  }, [data]);

  const scopeOptions = useMemo(() => {
    const divisions = new Set<string>();
    let anyShared = false;
    for (const r of data) {
      if (r.shared) anyShared = true;
      else if (r.pipelineName) divisions.add(divisionLabel(r.pipelineName));
    }
    return { divisions: [...divisions].sort(), anyShared };
  }, [data]);

  // Header label, derived from what this viewer can actually see:
  //   admin + a pipeline selected -> that pipeline's name
  //   admin on "All"              -> "All pipelines"
  //   rep with one home pipeline  -> that pipeline's name
  //   rep with several            -> their division label(s) ("ODP")
  //   no home pipelines           -> "Shared with me"
  // A signed-in NON-admin with no pipeline grants at all. This is the intended
  // fail-closed outcome — 21 of 25 users on the account are in it right now —
  // but an empty list under a "Shared with me" heading reads as a fault rather
  // than a state. It is only surfaced when they ALSO have nothing of their own:
  // a rep who owns or follows records has something to look at, and telling them
  // their access is missing would be both noise and untrue of what they can see.
  const noPipelineAccess =
    sso.status === "ready" &&
    !isAdminViewer &&
    homePipelineIds.length === 0 &&
    data.length === 0;

  const headerLabel = useMemo(() => {
    if (adminPipeline !== "all")
      return pipelines.find((p) => p.id === adminPipeline)?.name || "Pipeline";
    if (isAdminViewer) return "All pipelines";
    const home = pipelines.filter((p) => homePipelineIds.includes(p.id));
    if (home.length === 1) return home[0].name;
    if (home.length > 1) {
      const divs = [...new Set(home.map((p) => divisionLabel(p.name)))];
      return divs.join(" · ");
    }
    // No home pipelines. "Shared with me" is right ONLY if something actually
    // has been shared; with nothing at all it names a thing that doesn't exist,
    // so fall back to a label that promises nothing.
    return data.length ? "Shared with me" : "Cases";
  }, [adminPipeline, isAdminViewer, pipelines, homePipelineIds, data.length]);

  // Owner/follower picker label: "Name — DIV". No division mapped renders "—"
  // (a new hire must not be invisible); an unknown id renders "Former user".
  const userLabel = useCallback(
    (uid: string): string => {
      if (!uid) return "Unassigned";
      const u = users.find((x) => x.id === uid);
      if (!u) return "Former user";
      const div = u.divisions?.length ? u.divisions.join(" · ") : "—";
      return `${u.name} — ${div}`;
    },
    [users],
  );

  // Everything EXCEPT the stage filter.
  //
  // The stage chips and their counts read this, not `data`. Reading `data` meant
  // the chips ignored every other filter: with Pipeline set to OLTL Transfer you
  // still saw INITIAL CALL, a PRIVATE PAY stage, because some record somewhere in
  // the payload was in it. The count was technically true and completely
  // misleading. Stage is excluded from this set on purpose — including it would
  // collapse the chip row to the single chip you just clicked.
  const preStage = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.filter(
      (r) =>
        (office === "all" || r.office === office) &&
        (scope === "all" ||
          (scope === "shared"
            ? r.shared
            : !r.shared && divisionLabel(r.pipelineName) === scope)) &&
        // Admin-only pipeline selector (convenience; the server is the boundary).
        (adminPipeline === "all" || r.pipelineId === adminPipeline) &&
        (needle === "" ||
          // Searchable by name, office, stage, and the key people/ids.
          `${r.oppName} ${r.first} ${r.last} ${r.office} ${r.stage} ${r.harmony} ${r.cm} ${r.cg} ${r.rep} ${r.src}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [data, office, q, scope, adminPipeline]);

  const filtered = useMemo(
    () => preStage.filter((r) => stage === "all" || r.stage === stage),
    [preStage, stage],
  );

  // Everything the pipeline/division selection holds, before stage, office and
  // search narrow it — the denominator the count line reports against.
  const scopedTotal = useMemo(
    () =>
      data.filter(
        (r) =>
          (adminPipeline === "all" || r.pipelineId === adminPipeline) &&
          (scope === "all" ||
            (scope === "shared"
              ? r.shared
              : !r.shared && divisionLabel(r.pipelineName) === scope)),
      ).length,
    [data, adminPipeline, scope],
  );

  // Stage chips + office options, derived from the CURRENTLY FILTERED set
  // (everything but stage) rather than the whole payload. A chip for a stage no
  // record in view is in — INITIAL CALL while filtered to OLTL Transfer — is
  // noise at best and reads as a bug.
  const stages = useMemo(() => {
    const present: string[] = [];
    const seen = new Set<string>();
    for (const r of preStage) {
      if (r.stage && !seen.has(r.stage)) {
        seen.add(r.stage);
        present.push(r.stage);
      }
    }
    const ordered = STAGE_ORDER.filter((s) => seen.has(s));
    const extra = present.filter((s) => !STAGE_ORDER.includes(s));
    return [...ordered, ...extra];
  }, [preStage]);

  // Offices, scoped the same way: an office with nothing in it under the current
  // pipeline shouldn't be offered. Excludes the office filter itself so picking
  // one doesn't reduce the list to that one option.
  const offices = useMemo(() => {
    const set = new Set<string>();
    for (const r of data)
      if (
        r.office &&
        (adminPipeline === "all" || r.pipelineId === adminPipeline) &&
        (scope === "all" ||
          (scope === "shared"
            ? r.shared
            : !r.shared && divisionLabel(r.pipelineName) === scope))
      )
        set.add(r.office);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [data, adminPipeline, scope]);

  // A stage selected before the pipeline changed can survive into a pipeline
  // that has no such stage, leaving an empty list with an invisible chip still
  // active. Clear it rather than showing nothing with no explanation.
  useEffect(() => {
    if (stage !== "all" && !stages.includes(stage)) setStage("all");
  }, [stages, stage]);

  // The same trap, one level up: `scope` is no longer shown to admins, and a
  // control you cannot see must not still be filtering. A user promoted to admin
  // mid-session (or any future path that flips the flag) would otherwise be left
  // with an invisible division filter and no way to clear it.
  useEffect(() => {
    if (isAdminViewer && scope !== "all") setScope("all");
  }, [isAdminViewer, scope]);

  // Same rule for the pipeline selector: if the chosen pipeline is no longer one
  // the viewer can select (grants changed, or the selector is now hidden because
  // they hold only one), clear it rather than leaving an invisible filter on.
  useEffect(() => {
    if (
      adminPipeline !== "all" &&
      !selectablePipelines.some((p) => p.id === adminPipeline)
    )
      setAdminPipeline("all");
  }, [selectablePipelines, adminPipeline]);

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

  // Fetch link counts for the contacts currently on screen. Skips any already
  // known, so paging or filtering only ever asks for the new ones.
  useEffect(() => {
    if (sso.status === "loading") return;
    const ids = [
      ...new Set(
        visible
          .map((r) => r.contactId)
          .filter((id) => id && !(id in relCounts)),
      ),
    ].slice(0, 60);
    if (!ids.length) return;
    let cancelled = false;
    (async () => {
      try {
        const j = await apiFetch<{ counts?: RelationCounts }>(
          "/api/relations/counts",
          {
            method: "POST",
            ssoBlob: sso.status === "ready" ? sso.blob : null,
            body: JSON.stringify({
              ssoKey: sso.status === "ready" ? sso.blob : undefined,
              contactIds: ids,
            }),
          },
        );
        if (cancelled) return;
        // Record a zero for every id asked about, not just the ones with links,
        // so a contact with no relations is never re-requested on each render.
        const next: RelationCounts = {};
        for (const id of ids)
          next[id] = j.counts?.[id] ?? { caregivers: 0, clients: 0 };
        setRelCounts((prev) => ({ ...prev, ...next }));
      } catch {
        // Badges are a nicety. Never surface this; never block the list.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, sso, relCounts]);

  // The badge text for one record: "1 caregiver" / "2 clients", or "" when the
  // contact has no links (or its counts haven't arrived yet).
  const relBadge = useCallback(
    (r: OpportunityRecord): string => {
      const c = relCounts[r.contactId];
      if (!c) return "";
      const parts: string[] = [];
      if (c.caregivers)
        parts.push(`${c.caregivers} caregiver${c.caregivers === 1 ? "" : "s"}`);
      if (c.clients)
        parts.push(`${c.clients} client${c.clients === 1 ? "" : "s"}`);
      return parts.join(" · ");
    },
    [relCounts],
  );


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
        <div className="clientcell">
          <span className="clname">
            {r.oppName || clientName(r) || "—"}
            {r.pipelineName ? (
              <span className="divbadge" title={r.pipelineName}>
                {r.pipelineName}
              </span>
            ) : null}
          </span>
          {/* Why is this row visible to me? Unassigned is called out
              separately so "Following" can never stand in for "nobody owns
              this" — the two reach the list by different rules. */}
          {!r.ownerId ? (
            <span
              className="unassigned-tag"
              title="Nobody owns this yet — it's in your division and you can pick it up"
            >
              Unassigned
            </span>
          ) : followsNotOwns(r) ? (
            <span
              className="follow-tag"
              title="You follow this record (you're not the owner)"
            >
              Following
            </span>
          ) : null}
          {/* Provenance — only on records reached via the shared path. */}
          {r.shared ? (
            <span className="provenance">
              {r.ownerId === viewerId
                ? `Your record in ${r.pipelineName || "another pipeline"}`
                : `Shared by ${r.rep || "—"} · ${r.pipelineName || "another pipeline"} · you're a follower`}
            </span>
          ) : null}
          {/* Contact name, only when it differs from the opportunity name —
              otherwise it's the same string twice. */}
          {r.oppName && clientName(r) && clientName(r) !== r.oppName ? (
            <span className="clcontact" title="Contact">
              {clientName(r)}
            </span>
          ) : null}
          {transferredFrom(r) ? (
            <span className="fromtag" title="Transferred from">
              ← from {transferredFrom(r)}
            </span>
          ) : null}
          {r.cg && r.cg !== "—" ? (
            <span className="clcg" title="Caregiver">
              {r.cg}
            </span>
          ) : null}
          {/* BUG 2 — a client with a linked caregiver looked identical to one
              without. The wording follows the DIRECTION: "1 caregiver" on a
              client's record, "2 clients" on a caregiver's. Absent until the
              counts arrive, rather than flashing a zero. */}
          {relBadge(r) ? (
            <span
              className="rellink"
              title="Linked through the caregiver ↔ client association"
            >
              ⇄ {relBadge(r)}
            </span>
          ) : null}
        </div>
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

  // The BOARD shows HOME pipelines only — foreign stages don't belong in your
  // columns, and a shared record's pipeline must never enter the selector. The
  // list still shows everything (with division badges).
  const boardVisible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const home = new Set(homePipelineIds);
    return data.filter(
      (r) =>
        !r.shared &&
        (home.size === 0 || home.has(r.pipelineId)) &&
        (adminPipeline === "all" || r.pipelineId === adminPipeline) &&
        (needle === "" ||
          `${r.oppName} ${r.first} ${r.last}`.toLowerCase().includes(needle)),
    );
  }, [data, q, homePipelineIds, adminPipeline]);

  // Stats (client-requested tiles: total, per office, by source, per rep).
  // Stats read `filtered`, NOT `data`. `data` is every record the server
  // returned across all pipelines; `filtered` is what the admin pipeline
  // selector, scope filter, office filter and search actually narrow. The list
  // below renders `filtered`, so the cards have to agree with it — reading
  // `data` made them look frozen when a filter was applied.
  const stats = useMemo(() => {
    const blocked = filtered.filter((r) => r.block !== "None").length;
    const checked = filtered.filter((r) => r.checked).length;
    const auth = filtered.filter((r) => r.stage.startsWith("Auth")).length;
    const tally = (pick: (r: OpportunityRecord) => string) => {
      const m = new Map<string, number>();
      for (const r of filtered) {
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
  }, [filtered]);

  const selected = useMemo(
    () => data.find((r) => r.id === selId) || null,
    [data, selId],
  );

  // ITEM 5 — the Transferred From stamp, resolved by field NAME (never a
  // hardcoded id) so it can be surfaced as a badge on rows and cards.
  const transferredFromId = useMemo(
    () =>
      fieldDefs.find(
        (d) => (d.name || "").toLowerCase().replace(/[^a-z0-9]/g, "") === "transferredfrom",
      )?.id || "",
    [fieldDefs],
  );
  const transferredFrom = useCallback(
    (r: OpportunityRecord): string => {
      if (!transferredFromId) return "";
      const v = r.cf[transferredFromId];
      return Array.isArray(v) ? String(v[0] ?? "") : v ? String(v) : "";
    },
    [transferredFromId],
  );

  // Folder-driven field sections for the open record's pipeline (Task 4).
  const fieldGroups = useMemo(
    () =>
      selected
        ? groupFieldsForPipeline(fieldDefs, selected.pipelineId)
        : { sections: [], systemInfo: [], orphans: [] },
    [selected, fieldDefs],
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
        throw new Error(failureMessage(res, j));
      const n = j.note;
      setNotes((prev) => ({
        ...prev,
        // Same as the loader: keep the whole note, or the new note loses its
        // division badge and its id (and so cannot be edited until a reload).
        [selId]: [n, ...(prev[selId] || [])],
      }));
      setNoteDraft(""); // clear only on success — never lose typed input
    } catch (e) {
      setNoteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setNoteBusy(false);
    }
  };

  const selNotes = (selId && notes[selId]) || [];
  // Whether the note pending removal is a Move note — it changes what removal
  // actually does, so it changes what the dialog promises.
  const removeIsMove = !!selNotes.find((n) => n.id === removeTarget)?.system;

  // ITEM 4 — an admin just added a name to a field's picklist. Patch the cached
  // definition in place so the new option is immediately selectable, instead of
  // requiring a reload to see the name you just typed.
  const applyNewOption = useCallback((fieldId: string, options: string[]) => {
    setFieldDefs((prev) =>
      prev.map((d) => (d.id === fieldId ? { ...d, options } : d)),
    );
  }, []);

  // ITEM 5 — soft-delete the viewer's OWN note. The note stays, struck through,
  // reading who removed it and when; the original text is not kept.
  const removeNote = async (noteId: string) => {
    if (!selId || editBusy) return;
    setEditBusy(true);
    setEditErr(null);
    try {
      const res = await fetch(
        `/api/opportunities/${selId}/notes/${encodeURIComponent(noteId)}`,
        { method: "DELETE", headers: ssoHeader() },
      );
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        note?: Note;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !j.ok)
        throw new Error(failureMessage(res, j));
      setNotes((prev) => ({
        ...prev,
        [selId]: (prev[selId] || []).map((n) =>
          n.id === noteId
            ? {
                ...n,
                txt: j.note?.txt ?? "Note removed",
                reason: j.note?.reason ?? "Note removed",
                system: j.note?.system ?? n.system,
                removed: true,
              }
            : n,
        ),
      }));
      setEditingNote(null);
      setRemoveTarget(null); // closed only on success; a failure keeps the
                             // dialog open WITH the reason on it
    } catch (e) {
      setEditErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEditBusy(false);
    }
  };

  // ITEM 4 — save an edit to the viewer's OWN note. The affordance is only shown
  // on their own notes; the route re-checks authorship and is the real gate.
  const saveNoteEdit = async (noteId: string) => {
    const v = editDraft.trim();
    if (!v || !selId || editBusy) return;
    setEditBusy(true);
    setEditErr(null);
    try {
      const res = await fetch(
        `/api/opportunities/${selId}/notes/${encodeURIComponent(noteId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...ssoHeader() },
          body: JSON.stringify({
            ssoKey: sso.status === "ready" ? sso.blob : undefined,
            body: v,
          }),
        },
      );
      const j = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        note?: Note;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !j.ok)
        throw new Error(failureMessage(res, j));
      setNotes((prev) => ({
        ...prev,
        [selId]: (prev[selId] || []).map((n) =>
          n.id === noteId
            ? {
                ...n,
                txt: j.note?.txt ?? v,
                // Only the author's half changed; the system half is unchanged
                // and comes back from the server exactly as it was stored.
                reason: j.note?.reason ?? v,
                system: j.note?.system ?? n.system,
                edited: true,
                removed: false,
              }
            : n,
        ),
      }));
      setEditingNote(null);
      setEditDraft("");
    } catch (e) {
      setEditErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEditBusy(false);
    }
  };

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
          throw new Error(failureMessage(res, j));
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

  // Follower add/remove — owner or admin only (Task 5). Uses the dedicated
  // /followers route; updates the record from the recomputed id list.
  const canManageFollowersClient = (r: OpportunityRecord) =>
    isAdminViewer || (!!viewerId && r.ownerId === viewerId);

  const saveFollowers = useCallback(
    async (rec: OpportunityRecord, change: { add?: string[]; remove?: string[] }) => {
      const fk = "followers";
      setSaveState((p) => ({ ...p, [skey(rec.id, fk)]: { status: "saving" } }));
      try {
        const res = await fetch(`/api/opportunities/${rec.id}/followers`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ssoKey: sso.status === "ready" ? sso.blob : undefined,
            ...change,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          followers?: string[];
          error?: string;
          detail?: string;
        };
        if (!res.ok || !j.ok || !Array.isArray(j.followers))
          throw new Error(failureMessage(res, j));
        const ids = j.followers;
        const names = ids.map(
          (uid) => users.find((u) => u.id === uid)?.name || "Former user",
        );
        setData((prev) =>
          prev.map((r) =>
            r.id === rec.id ? { ...r, followerIds: ids, followerNames: names } : r,
          ),
        );
        setSaveState((p) => ({ ...p, [skey(rec.id, fk)]: undefined }));
      } catch (e) {
        setSaveState((p) => ({
          ...p,
          [skey(rec.id, fk)]: {
            status: "error",
            msg: e instanceof Error ? e.message : String(e),
          },
        }));
      }
    },
    [sso, users],
  );

  // Kanban drag: 6px activation so a click still opens the record; keyboard too.
  const [dragId, setDragId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  // Stage ids are only valid within their OWN pipeline. Names repeat across
  // pipelines (TRANSFERRED IN, UNCATEGORIZED, INACTIVE, LOST exist in all five)
  // with DIFFERENT ids, so resolving a stage from the merged union can write a
  // foreign id and GHL rejects it with OPPORTUNITY_STAGE_ID_INVALID. Always
  // scope to the record's own pipeline.
  const stagesFor = useCallback(
    (pipelineId: string): { id: string; name: string }[] =>
      stagesByPipeline[pipelineId] || [],
    [stagesByPipeline],
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
    // Resolve the target stage within the RECORD'S OWN pipeline. Board columns
    // are keyed by stage NAME and names repeat across pipelines, so the merged
    // list would happily hand back another pipeline's id.
    const target = stagesFor(rec.pipelineId).find((s) => s.name === targetStage);
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

  // Board columns = the FULL stage list of the board's pipeline(s) (incl. empty
  // stages) so you
  // can drag into an empty stage. Falls back to data-derived stages pre-load, and
  // appends any stray stage present in data but not in the pipeline list.
  // Columns come from the board's own pipeline(s): the admin-selected pipeline
  // if set, else the viewer's home pipelines. Stage names repeat across
  // pipelines, so we dedupe by name in the pipelines' own order.
  const boardStages = useMemo(() => {
    const ids =
      adminPipeline !== "all"
        ? [adminPipeline]
        : homePipelineIds.length
          ? homePipelineIds
          : pipelines.map((p) => p.id);
    const names: string[] = [];
    const set = new Set<string>();
    for (const pid of ids)
      for (const s of stagesByPipeline[pid] || [])
        if (!set.has(s.name)) {
          set.add(s.name);
          names.push(s.name);
        }
    if (!names.length) {
      if (!pipelineStages.length) return stages;
      for (const s of pipelineStages)
        if (!set.has(s.name)) {
          set.add(s.name);
          names.push(s.name);
        }
    }
    // Keep any stray stage present in the data but not in the stage lists.
    for (const r of boardVisible)
      if (r.stage && !set.has(r.stage)) {
        set.add(r.stage);
        names.push(r.stage);
      }
    return names;
  }, [
    adminPipeline,
    homePipelineIds,
    pipelines,
    stagesByPipeline,
    pipelineStages,
    stages,
    boardVisible,
  ]);

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
  // Render one custom field from its definition (folder-driven path).
  const renderField = (
    rec: OpportunityRecord,
    def: EditableFieldDef,
  ): ReactNode => (
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
        users={users}
        isAdmin={isAdminViewer}
        ssoBlob={sso.status === "ready" ? sso.blob : null}
        onOptionAdded={applyNewOption}
      />
    </div>
  );

  return (
    <div className="app">
      <nav className="rail">
        <div className="logo">M</div>
        <button
          className="active"
          title={`${headerLabel} — this custom view`}
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
              <span className="pipe" /> {headerLabel}
            </h1>
            <small>
              Enrollments across your division · contacts, comms and settings
              stay in GoHighLevel
            </small>
          </div>
          <div className="spacer" />
          <div
            className="viewas"
            title="Signed-in GHL user (from the SSO handshake). What you see is filtered to your division and assignments."
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
          {/* ITEM 3 — Add Lead. Beside the tabs, but deliberately NOT one of
              them: it opens a modal you complete and leave, the same shape as
              Move. A tab would imply somewhere to return to. */}
          <button
            type="button"
            className="addclientbtn"
            onClick={() => setAddOpen(true)}
            title="Create a new lead and their case"
          >
            + Add Lead
          </button>
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
            {isAdminViewer && (
              <button
                className={view === "access" ? "on" : ""}
                onClick={() => setView("access")}
                type="button"
              >
                <IconKey />
                Access
              </button>
            )}
          </div>
        </div>

        {/* opportunity-only controls (hidden on the Resources / Import tabs) */}
        {view !== "resources" && view !== "import" && view !== "access" && (
        <>
        <div className="stats">
          <div className="stat">
            {/* Measured against the CURRENT pipeline/division selection, not
                the whole payload — otherwise this card contradicted the count
                line beside the chips the moment a pipeline was chosen. */}
            <div className="k">
              {filtered.length === scopedTotal ? "In view" : "Showing"}
            </div>
            <div className="v">{filtered.length}</div>
            <div className="sub">
              {filtered.length === scopedTotal
                ? `${headerLabel} · live from GoHighLevel`
                : `of ${scopedTotal} in ${headerLabel} · filters active`}
            </div>
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
                <b>All divisions.</b> Every record in {headerLabel} (
                {data.length}). Signed in as{" "}
                <b>{sso.session.userName || sso.session.userId}</b>
                {sso.session.role ? ` (${sso.session.role})` : ""}.
              </>
            ) : (
              noPipelineAccess ? (
                // The standard rep paragraph describes a view this person does
                // not have — "what you own, what you follow, anything still
                // unassigned" is three promises against an empty list.
                <>
                  <span className="tag">
                    {sso.session.userName || "Your view"}
                  </span>{" "}
                  <b>No pipelines assigned yet.</b> An admin controls which
                  pipelines you can see. Nothing is wrong with your sign-in.
                </>
              ) : (
                <>
                  <span className="tag">
                    {sso.session.userName || "Your view"}
                  </span>{" "}
                  <b>Your records ({data.length}).</b> In {headerLabel} you see
                  what you own, what you follow, and anything still unassigned —
                  unassigned work is there for you to pick up. Records from other
                  divisions appear only when you own or follow them, marked{" "}
                  <i>shared</i>. Office is a view filter, not a permission.
                </>
              )
            )
          ) : (
            <>
              <span className="tag">All data</span>{" "}
              <b>No GHL SSO session detected</b> — admin/testing view. Every
              record in {headerLabel} ({data.length}).
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
          {/* Division / Shared-with-me — REPS ONLY.
              Options come from the viewer's own payload, so no division they
              hold nothing in is ever named.

              An admin does NOT get this. They already have the Pipeline
              selector, which is the same axis at finer resolution, and the two
              were independent ANDs — so "Show: ODP" + "Pipeline: OLTL Transfer"
              was selectable and could satisfy nothing. Two controls that can
              contradict each other are worse than one, and Pipeline is strictly
              more precise. Reps keep it because they have no pipeline selector,
              and their "Shared with me" option expresses something no pipeline
              filter can. */}
          {!isAdminViewer &&
          (scopeOptions.divisions.length > 1 || scopeOptions.anyShared) ? (
            <div className="officefilter">
              <label htmlFor="scopeSel">Show</label>
              <select
                id="scopeSel"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              >
                <option value="all">All</option>
                {scopeOptions.divisions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
                {scopeOptions.anyShared ? (
                  <option value="shared">Shared with me</option>
                ) : null}
              </select>
            </div>
          ) : null}
          {/* Admin-only pipeline selector — convenience; the SERVER decides
              what returns, this only narrows what is already visible. */}
          {/* Shown to anyone holding MORE THAN ONE pipeline. A viewer with a
              single pipeline gets nothing — a selector with one real option
              looks broken and narrows nothing. */}
          {selectablePipelines.length > 1 ? (
            <div className="officefilter">
              <label htmlFor="pipeSel">Pipeline</label>
              <select
                id="pipeSel"
                value={adminPipeline}
                onChange={(e) => setAdminPipeline(e.target.value)}
              >
                <option value="all">All ({data.length})</option>
                {selectablePipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({pipelineCounts.get(p.id) || 0})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
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
            {/* "in pipeline" used to count the WHOLE payload even with a
                pipeline selected — the same contradiction as the filters.
                It now names what it is counting. */}
            {visible.length} shown · {scopedTotal} in {headerLabel}
          </span>
        </div>

        <div className="stages">
          <button
            className={`chip ${stage === "all" ? "on" : ""}`}
            onClick={() => setStage("all")}
            type="button"
          >
            All<span className="n">{preStage.length}</span>
          </button>
          {stages.map((st) => (
            <button
              key={st}
              className={`chip ${stage === st ? "on" : ""}`}
              onClick={() => setStage(st)}
              type="button"
            >
              {st}
              {/* Counted within the current pipeline / office / search, not
                  across the whole payload. */}
              <span className="n">
                {preStage.filter((r) => r.stage === st).length}
              </span>
            </button>
          ))}
        </div>
        </>
        )}

        {/* content: Import tab (admin), Resources tab, else loading / error / list / board */}
        {view === "access" ? (
          isAdminViewer ? (
            <PipelineAccessTab
              ssoBlob={sso.status === "ready" ? sso.blob : null}
            />
          ) : (
            <div className="empty">
              <b>Admins only</b>
              <br />
              Pipeline access is restricted to admin users.
            </div>
          )
        ) : view === "import" ? (
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
            {/* toolbar: search + admin upload */}
            <div className="restoolbar">
              <div className="search">
                <IconSearch />
                <input
                  placeholder="Search resources by name…"
                  value={resQuery}
                  onChange={(e) => setResQuery(e.target.value)}
                />
              </div>
              {isAdminViewer ? (
                <label className={`resupload ${uploading ? "busy" : ""}`}>
                  <input
                    type="file"
                    hidden
                    disabled={uploading}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadResource(f);
                      e.target.value = "";
                    }}
                  />
                  {uploading ? "Uploading…" : "⬆ Upload"}
                </label>
              ) : null}
            </div>
            {uploadMsg ? (
              <div
                className={`resuploadmsg ${uploadMsg.startsWith("✗") ? "err" : "ok"}`}
              >
                {uploadMsg}
              </div>
            ) : null}

            {resLoading ? (
              <div className="statewrap">
                <div className="statecard">
                  <div className="spinner" />
                  <h3>Loading resources…</h3>
                  <p>Fetching documents from the shared Resources folder.</p>
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
                {isAdminViewer
                  ? "Upload a document above, or add files to the Resources folder in GoHighLevel."
                  : "Add documents to the Resources folder in GoHighLevel."}
              </div>
            ) : visibleResources.length === 0 ? (
              <div className="empty">
                <b>No matches</b>
                <br />
                No resource name contains “{resQuery}”.
              </div>
            ) : (
              <div className="resgrid">
                {visibleResources.map((f, i) => {
                  const kind = previewKind(f);
                  const common = (
                    <>
                      <span className="ricon">
                        <IconDoc />
                      </span>
                      <span className="rbody">
                        <span className="rname">{f.name}</span>
                        <span className="rmeta">
                          {f.type || "file"}
                          {f.size ? ` · ${fmtSize(f.size)}` : ""}
                        </span>
                      </span>
                      <span className="ropen">
                        {kind ? "Preview" : "Download ↓"}
                      </span>
                    </>
                  );
                  return kind ? (
                    <button
                      key={`${f.url}-${i}`}
                      type="button"
                      className="rescard"
                      onClick={() =>
                        setPreview({ name: f.name, url: f.url, kind })
                      }
                    >
                      {common}
                    </button>
                  ) : (
                    <a
                      key={`${f.url}-${i}`}
                      className="rescard"
                      href={f.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {common}
                    </a>
                  );
                })}
              </div>
            )}
          </div>
        ) : loading ? (
          <div className="statewrap">
            <div className="statecard">
              <div className="spinner" />
              <h3>Loading opportunities…</h3>
              <p>Fetching live records from GoHighLevel.</p>
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
              noPipelineAccess ? (
                <NoAccessNotice />
              ) : (
                <div className="empty">No records match this filter.</div>
              )
            ) : null}
          </div>
        ) : noPipelineAccess ? (
          // The board draws one column per HOME pipeline, so with none it
          // renders nothing at all — an even blanker screen than the list.
          <NoAccessNotice />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={(e) => setDragId(String(e.active.id))}
            onDragCancel={() => setDragId(null)}
            onDragEnd={onDragEnd}
          >
            {/* The board deliberately excludes SHARED records — it is the
                division's own work queue. That was fine as an opt-in view, but
                it becomes a trap as the LANDING view: someone whose only records
                are shared with them lands on columns with nothing in them and no
                clue that their records exist one tab away. Say so. */}
            {boardVisible.length === 0 && data.length > 0 ? (
              <div className="empty boardhint">
                <b>Nothing in your own pipelines</b>
                <br />
                You have {data.length} record{data.length === 1 ? "" : "s"}{" "}
                shared with you or owned in another division. The board shows
                only your own division&apos;s work —{" "}
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => setView("list")}
                >
                  see them in the list
                </button>
                .
              </div>
            ) : null}
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
                          relBadge={relBadge(r)}
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
                    <CardBody
                      r={r}
                      following={followsNotOwns(r)}
                      relBadge={relBadge(r)}
                    />
                  </div>
                ) : null;
              })()}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {/* Move dialog (Task 6) */}
      {selected && moveOpen ? (
        <MoveDialog
          key={selected.id}
          record={selected}
          pipelines={pipelines}
          stagesByPipeline={stagesByPipeline}
          users={users}
          ssoBlob={sso.status === "ready" ? sso.blob : null}
          onClose={() => setMoveOpen(false)}
          onMoved={(rec, transferred) => {
            // ITEM 4. Owner CHANGED: the viewer may have just lost access, so
            // close the panel and reload. Owner UNCHANGED: refresh in place —
            // the updated record carries the new pipelineId/stageId, and the
            // panel's Stage dropdown reads stagesFor(selected.pipelineId), so
            // it re-scopes to the destination pipeline automatically instead of
            // offering the old pipeline's stages (which would write an invalid
            // stage id).
            setData((prev) => prev.map((r) => (r.id === rec.id ? rec : r)));
            if (transferred) setSelId(null);
            load();
          }}
        />
      ) : null}

      {/* Remove-note confirmation (item 2) — an in-app dialog, never
          window.confirm(), which a sandboxed GHL iframe silently swallows. */}
      {removeTarget ? (
        <ConfirmDialog
          title={
            removeIsMove ? "Remove your reason?" : "Remove this note?"
          }
          body={
            removeIsMove ? (
              <>
                Only <b>your reason</b> is removed. The move record —{" "}
                <b>which pipeline it came from and who owns it now</b> — stays on
                the case, so the receiving rep can still see how it got there.
                This can&apos;t be undone.
              </>
            ) : (
              <>
                It will stay on the record struck through, marked{" "}
                <b>&ldquo;removed by you&rdquo;</b>, and the text won&apos;t be
                shown. This can&apos;t be undone.
              </>
            )
          }
          confirmLabel={removeIsMove ? "Remove reason" : "Remove note"}
          danger
          busy={editBusy}
          error={editErr}
          onConfirm={() => removeNote(removeTarget)}
          onCancel={() => {
            setRemoveTarget(null);
            setEditErr(null);
          }}
        />
      ) : null}

      {/* Add Lead (item 3) */}
      {addOpen ? (
        <AddClientDialog
          pipelines={pipelines}
          stagesByPipeline={stagesByPipeline}
          users={users}
          fieldDefs={fieldDefs}
          viewerId={viewerId || ""}
          viewerName={
            (sso.status === "ready" ? sso.session.userName : "") ||
            (viewerId ? userLabel(viewerId).split(" — ")[0] : "") ||
            "you"
          }
          isAdmin={isAdminViewer}
          homePipelineIds={homePipelineIds}
          ssoBlob={sso.status === "ready" ? sso.blob : null}
          onClose={() => setAddOpen(false)}
          onCreated={(oppId) => {
            // Refresh, then OPEN the new record so they can fill in the rest.
            load().then(() => {
              if (oppId) setSelId(oppId);
            });
          }}
        />
      ) : null}

      {/* email composer (Task 5) */}
      {selected && emailOpen ? (
        <EmailComposer
          key={selected.id}
          opportunityId={selected.id}
          ssoBlob={sso.status === "ready" ? sso.blob : null}
          context={{
            clientFirst: selected.first,
            clientLast: selected.last,
            office: selected.office,
            stage: selected.stage,
          }}
          onClose={() => setEmailOpen(false)}
        />
      ) : null}

      {/* resource preview modal (PDF / image) */}
      {preview ? (
        <div className="previewmodal" onClick={() => setPreview(null)}>
          <div
            className="previewbox"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="previewhead">
              <span className="previewname">{preview.name}</span>
              <a
                className="previewopen"
                href={preview.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open in new tab ↗
              </a>
              <button
                className="x"
                type="button"
                onClick={() => setPreview(null)}
                aria-label="Close preview"
              >
                ×
              </button>
            </div>
            <div className="previewbody">
              {preview.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={preview.url} alt={preview.name} />
              ) : (
                <iframe title={preview.name} src={preview.url} />
              )}
            </div>
          </div>
        </div>
      ) : null}

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
                  {/* Contact is secondary here; shown only when it isn't
                      already the header, so the two are never confused. */}
                  {clientName(selected) &&
                  clientName(selected) !== selected.oppName
                    ? `${clientName(selected)} · `
                    : ""}
                  {selected.office || "—"} · {selected.stage || "—"}
                  {selected.pipelineName ? (
                    <span className="divbadge" title={selected.pipelineName}>
                      {selected.pipelineName}
                    </span>
                  ) : null}
                </div>
                {selected.shared ? (
                  <div className="provenance">
                    {selected.ownerId === viewerId
                      ? `Your record in ${selected.pipelineName || "another pipeline"}`
                      : `Shared by ${userLabel(selected.ownerId)} · ${selected.pipelineName || "another pipeline"} · you're a follower`}
                  </div>
                ) : null}
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

              {canEdit(selected) ? (
                <div className="panelactions">
                  <button
                    type="button"
                    className="emailbtn"
                    onClick={() => setEmailOpen(true)}
                  >
                    ✉ Send Email
                  </button>
                  <button
                    type="button"
                    className="movebtn"
                    onClick={() => setMoveOpen(true)}
                  >
                    ⇄ Move this case
                  </button>
                </div>
              ) : null}

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
                            stagesFor(selected.pipelineId).find(
                              (s) => s.id === e.target.value,
                            )?.name || r.stage,
                        }),
                      )
                    }
                  >
                    {/* This record's OWN pipeline only — never the merged union,
                        or we'd offer a foreign stage id (400 STAGE_ID_INVALID). */}
                    {stagesFor(selected.pipelineId).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  {saveMsgFor(selected.id, "stage")}
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

              {/* 2 — Assignment */}
              <div className="sechead">Assignment</div>
              {/* If the users lookup failed, the owner dropdown and follower
                  picker are empty. Say so rather than showing empty lists. */}
              {users.length === 0 ? (
                <div className="savemsg err" style={{ marginBottom: 10 }}>
                  ✗ Couldn&apos;t load the user list, so reassigning and adding
                  followers are unavailable right now. Reload; if it persists the
                  API token may be missing the users permission.
                </div>
              ) : null}
              <div className="grid">
                <div className="f">
                  <label>Sales Rep (Owner)</label>
                  {/* ITEM 2 — was a native <select> rendering
                      "Jhune Manalaysay - Onboarding — —" on one unstyleable
                      line. UserPicker puts the name on its own line with the
                      division as a muted chip, and adds a filter (25 users).
                      Owner still lists EVERYONE — a rep must be able to
                      reassign to a colleague. */}
                  <UserPicker
                    users={users}
                    value={selected.ownerId}
                    disabled={savingFk(selected.id, "owner")}
                    onChange={(id) =>
                      saveField(
                        selected,
                        "owner",
                        { assignedTo: id || null },
                        (r) => ({
                          ...r,
                          ownerId: id,
                          rep: users.find((u) => u.id === id)?.name || "—",
                        }),
                      )
                    }
                  />
                  {saveMsgFor(selected.id, "owner")}
                </div>
                <div className="f wide">
                  <label>
                    Followers (Co-reps)
                    {viewerId &&
                    selected.ownerId !== viewerId &&
                    selected.followerIds.includes(viewerId) ? (
                      <span className="readonly-note">you follow this</span>
                    ) : null}
                  </label>
                  {canManageFollowersClient(selected) ? (
                    <div className="followedit">
                      <div className="folchips">
                        {selected.followerIds.length ? (
                          selected.followerIds.map((fid) => (
                            <span className="folchip" key={fid}>
                              {users.find((u) => u.id === fid)?.name ||
                                "Former user"}
                              <button
                                type="button"
                                className="folx"
                                disabled={savingFk(selected.id, "followers")}
                                onClick={() =>
                                  saveFollowers(selected, { remove: [fid] })
                                }
                                aria-label="Remove follower"
                              >
                                ×
                              </button>
                            </span>
                          ))
                        ) : (
                          <span className="muted">No followers</span>
                        )}
                      </div>
                      {/* ITEM 2 — same treatment. This one is an ACTION rather
                          than a value, so the trigger keeps its fixed label. */}
                      <UserPicker
                        users={users.filter(
                          (u) =>
                            u.id !== selected.ownerId &&
                            !selected.followerIds.includes(u.id),
                        )}
                        value=""
                        allowUnassigned={false}
                        triggerLabel="+ Add follower…"
                        emptyLabel="Everyone is already the owner or a follower."
                        disabled={savingFk(selected.id, "followers")}
                        onChange={(id) => {
                          if (id) saveFollowers(selected, { add: [id] });
                        }}
                      />
                      {saveMsgFor(selected.id, "followers")}
                    </div>
                  ) : (
                    <div className="v ro">
                      {selected.followerNames.length
                        ? selected.followerNames.join(", ")
                        : "—"}{" "}
                      <span className="readonly-note">owner/admin manage</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Folder-driven field sections (Task 4) — rendered from the
                  folders mapped to this record's pipeline, in configured order. */}
              {fieldGroups.sections.map((g) => (
                <Fragment key={g.key}>
                  <div className="sechead">{g.label}</div>
                  <div className="grid">
                    {g.fields.map((def) => renderField(selected, def))}
                  </div>
                </Fragment>
              ))}

              {/* Caregivers (many-to-many association) */}
              {/* BUG 1 — the heading is rendered INSIDE the section now, because
                  it depends on the resolved direction: "Caregivers" on a
                  client's record, "Clients" on a caregiver's. It was a fixed
                  string here, which is how a caregiver's clients ended up
                  labelled as caregivers. */}
              <CaregiversSection
                key={selected.id}
                opportunityId={selected.id}
                ssoBlob={sso.status === "ready" ? sso.blob : null}
                canManage={canEdit(selected)}
              />

              {/* System info — external ids / derived / automation (collapsed).
                  Airtable Record ID is editable here; compliance/derived are
                  read-only via the blocklist. */}
              {fieldGroups.systemInfo.length ? (
                <details className="sysinfo">
                  <summary>System info</summary>
                  <div className="grid">
                    {fieldGroups.systemInfo.map((def) => renderField(selected, def))}
                  </div>
                </details>
              ) : null}

              {/* Any field not in a mapped folder — never hidden. */}
              {fieldGroups.orphans.length ? (
                <details className="sysinfo">
                  <summary>Other fields</summary>
                  <div className="grid">
                    {fieldGroups.orphans.map((def) => renderField(selected, def))}
                  </div>
                </details>
              ) : null}
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
                  selNotes.map((n, i) => {
                    // ITEM 4 — the author may edit their OWN note. Not admins:
                    // on a transferred case these notes are the receiving rep's
                    // account of what happened.
                    const mine = !!viewerId && n.authorId === viewerId;
                    const editing = editingNote === n.id && !!n.id;

                    // A REMOVED MANUAL note is a tombstone, not a note. There is
                    // nothing left to show, so the note's whole layout — card,
                    // author/date header, edited badge, actions — is clutter
                    // around a single sentence. One muted line instead, sitting
                    // where the note was so the timeline still reads in order.
                    //
                    // It is kept rather than dropped because a hard delete
                    // leaves no sign anything existed: the record simply has
                    // less in it than yesterday and nobody can tell.
                    //
                    // Move notes are NOT tombstoned — their system half is still
                    // real content, and only the reason was withdrawn.
                    if (n.removed && !n.system)
                      return (
                        <div className="notegone" key={n.id || i}>
                          {n.reason || n.txt}
                        </div>
                      );

                    return (
                      <div className="note" key={n.id || i}>
                        <div className="nh">
                          <b>{n.who}</b>
                          {/* ITEM 6 — division AT WRITE TIME, stamped into the
                              note when it was created, never looked up now. */}
                          {n.division ? (
                            <span className="ndiv"> ({n.division})</span>
                          ) : null}{" "}
                          {/* The original timestamp, kept across edits. */}
                          · {n.when}
                          {n.edited && !n.removed ? (
                            <span
                              className="nedited"
                              title="This note was edited after it was written. The original text is not kept."
                            >
                              edited
                            </span>
                          ) : null}
                          {/* No "removed" badge: on a Move note the muted line
                              below already says it, and a manual removed note
                              never reaches this header at all. */}
                          {/* Author only, and never on an already-removed
                              note — there is nothing left to edit or remove. */}
                          {mine && n.id && !editing && !n.removed ? (
                            <>
                              <button
                                type="button"
                                className="noteedit"
                                onClick={() => {
                                  setEditingNote(n.id);
                                  // ITEM 2 — the form opens on the author's OWN
                                  // words only. For a manual note that is the
                                  // whole text; for a Move note the system
                                  // sentence is shown above it, greyed.
                                  setEditDraft(n.reason ?? n.txt);
                                  setEditErr(null);
                                }}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="noteedit noteremove"
                                disabled={editBusy}
                                onClick={() => {
                                  setEditErr(null);
                                  setRemoveTarget(n.id);
                                }}
                              >
                                Remove
                              </button>
                            </>
                          ) : null}
                        </div>
                        {editing ? (
                          <div className="noteeditbox">
                            {n.system ? (
                              <div className="notesysro">
                                {n.system}
                                <span className="readonly-note">
                                  system record — can&apos;t be changed
                                </span>
                              </div>
                            ) : null}
                            <textarea
                              value={editDraft}
                              disabled={editBusy}
                              onChange={(e) => setEditDraft(e.target.value)}
                              rows={3}
                            />
                            <div className="noteeditacts">
                              <button
                                type="button"
                                className="ighost"
                                disabled={editBusy}
                                onClick={() => {
                                  setEditingNote(null);
                                  setEditErr(null);
                                }}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                className="ibtn"
                                disabled={editBusy || !editDraft.trim()}
                                onClick={() => saveNoteEdit(n.id)}
                              >
                                {editBusy ? "Saving…" : "Save"}
                              </button>
                            </div>
                            <div className="imeta">
                              {n.system
                                ? "You're editing your reason. The move record above stays as written."
                                : "Editing replaces the text — the original isn't kept."}
                            </div>
                            {editErr ? (
                              <div className="savemsg err">✗ {editErr}</div>
                            ) : null}
                          </div>
                        ) : (
                          <p>
                            {/* ITEM 2 — the SYSTEM half of a Move note. It is
                                never struck through and never editable: it is
                                how the receiving rep learns the case moved. */}
                            {n.system ? (
                              <span className="notesys">{n.system}</span>
                            ) : null}
                            {n.system && !n.removed && (n.reason || n.txt)
                              ? " "
                              : ""}
                            {/* The withdrawn reason on a Move note drops to its
                                own muted line under the system record, in the
                                same style as a manual tombstone — not struck
                                through, because it is the record of the removal
                                rather than the text that was removed. */}
                            {n.removed ? (
                              <span className="notegone">{n.reason}</span>
                            ) : (
                              <span>{n.system ? n.reason : n.txt}</span>
                            )}
                          </p>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="note">
                    <p className="muted">No notes yet.</p>
                  </div>
                )}
              </div>
              {/* ITEM 1, SECOND CAUSE. `editErr` used to be rendered ONLY inside
                  the edit box, i.e. only when `editing` was true. Removing a
                  note never sets `editingNote`, so a failed DELETE — a 403, a
                  500, a dropped connection — set the error and then had NOWHERE
                  to appear. Every failure looked exactly like "clicking Remove
                  does nothing". Errors from a removal now surface here, outside
                  the edit box. */}
              {editErr && editingNote === null ? (
                <div className="savemsg err" style={{ marginTop: 6 }}>
                  ✗ {editErr}
                </div>
              ) : null}
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
            {/* ADMINS ONLY — the whole footer, not just the link.
                This deep-links into the native OPPORTUNITIES module, which reps
                are having turned off: the link would land on a 404 or an
                access-denied page. The hint beside it is no better — "Full
                record, comms & files live in GoHighLevel" sends a rep somewhere
                they can't go, so hiding the link and keeping the sentence would
                just move the dead end one step further away.
                Admins keep both: they need native for settings, pipelines and
                everything the dashboard doesn't cover. */}
            {isAdminViewer ? (
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
            ) : null}
          </>
        ) : null}
      </aside>
    </div>
  );
}
