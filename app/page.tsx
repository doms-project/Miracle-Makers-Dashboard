"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "@/components/ErrorMessage";
import { apiFetch, apiError } from "@/lib/apiFetch";
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
import { groupFieldsForPipeline, groupContactFields, fieldLabel } from "@/lib/fieldFolders";
import MoveDialog from "@/components/MoveDialog";
import ReassignDialog from "@/components/ReassignDialog";
import UserPicker from "@/components/UserPicker";
import HybridPicker from "@/components/HybridPicker";
import ConfirmDialog from "@/components/ConfirmDialog";
import { toDateInput, formatGhlDate, hasTime, nameImpliesTime } from "@/lib/dates";
import AddClientDialog from "@/components/AddClientDialog";
import PipelineAccessTab from "@/components/PipelineAccessTab";
import PipelineAdmin from "@/components/PipelineAdmin";
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

// ITEM 6c — one Resources section per folder the viewer may see.
type ResFile = { id: string; name: string; url: string; type: string; size: number };
type ResSection = {
  id: string;
  name: string;
  isPublic?: boolean;
  failed?: boolean;
  files: ResFile[];
};

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

// ITEM A2 — CAREGIVER COLUMNS. Deliberately NOT the client set: Harmony ID,
// Office, County, Road Blocker and Case Manager are client concepts and would be
// blank on every applicant row. Every column below is backed by a field that is
// native to the opportunity (or already carried for the Master view), so none of
// them can come back empty for structural reasons.
//
// ⬜ SOURCE IS NOT HERE ON PURPOSE. `src` is an opportunity custom field, so it
// exists on an applicant record, but whether recruiting actually fills it is
// unverified. A column that is empty on every row is worse than no column — add
// it once it is confirmed to carry data.
type CgSortKey = "applicant" | "stage" | "days" | "recruiter" | "pipeline";
const CG_COLUMNS: { key: CgSortKey; label: string }[] = [
  { key: "applicant", label: "Applicant" },
  { key: "stage", label: "Stage" },
  { key: "days", label: "Days in stage" },
  { key: "recruiter", label: "Recruiter" },
  { key: "pipeline", label: "Pipeline" },
];

// A caregiver record's value for one column, as a display string. Kept separate
// from the client `recordStr` rather than folded into it: the two column sets
// share only `stage`, and a shared accessor would invite a client key leaking
// into an applicant sort menu.
function cgStr(r: OpportunityRecord, key: string): string {
  switch (key) {
    case "applicant":
      return (r.oppName || `${r.first} ${r.last}`.trim() || "").trim();
    case "stage":
      return r.stage;
    case "recruiter":
      return r.rep || "Unassigned";
    case "pipeline":
      return r.pipelineName;
    default:
      return "";
  }
}

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
// ITEM 4 — Master: several columns seen at once, so a wider grid than the board.
const IconMaster = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <rect x="3" y="4" width="18" height="16" rx="1" />
    <path d="M9 4v16M15 4v16M3 9h18" />
  </svg>
);
const IconPeople = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const IconRefresh = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
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
// ---- SOURCE ICON ----
//
// Reads the NATIVE opportunity `source` (rec.src — `rec.src = opp.source`), which
// is already in the list payload and already feeds the "By source" tile. So this
// is a RENDER change with no new GoHighLevel call.
//
// ⚠️ FREE TEXT, matched case-insensitively and trimmed: a workflow writing
// "facebook" or " Indeed " must still resolve. Matching is on a normalised key.
//
// ⚠️ NO PLACEHOLDER for an unknown or empty source. 243 of 261 records are blank
// today (the Airtable import carried no source, and nothing can backfill it), so
// a fallback glyph would put a meaningless mark on almost every card and say
// nothing. This marks the channels that DO set it — not every lead.
//
// ⚠️ OFFICIAL BRAND MARKS, IN THEIR OWN COLOURS, AS INLINE SVG.
// Inline because a card must not make a network request per row and a hosted
// logo that 404s leaves a broken image on every record; inline also scales with
// no retina variant. The colours are the brands' own — recolouring or
// monochroming them reads as a mistake and destroys the recognition that is the
// whole point. Nothing here is distorted, cropped or restyled: each mark keeps
// its own proportions inside the 24-unit box and is scaled as a whole.
// `title` still names the source, because a logo nobody recognises is worse
// than a word.
const SOURCE_ICONS: {
  match: (k: string) => boolean;
  label: string;
  art: React.ReactNode;
}[] = [
  {
    match: (k) => k.includes("facebook") || k.includes("meta") || k.includes("fb"),
    label: "Facebook",
    // The blue "f" roundel. Meta blue #1877F2 with the f knocked out in white.
    art: (
      <>
        <path
          fill="#1877F2"
          d="M24 12c0-6.627-5.373-12-12-12S0 5.373 0 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078V12h3.047V9.356c0-3.007 1.792-4.669 4.533-4.669 1.313 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874V12h3.328l-.532 3.469h-2.796v8.385C19.612 22.954 24 17.99 24 12z"
        />
        <path
          fill="#fff"
          d="M16.671 15.469 17.203 12h-3.328V9.749c0-.949.465-1.874 1.956-1.874h1.513V4.922s-1.373-.235-2.686-.235c-2.741 0-4.533 1.662-4.533 4.669V12H7.078v3.469h3.047v8.385a12.14 12.14 0 0 0 3.75 0v-8.385h2.796z"
        />
      </>
    ),
  },
  {
    match: (k) => k.includes("google") || k.includes("adwords") || k.includes("gads"),
    label: "Google Ads",
    // The Google Ads mark: two rounded bars meeting at the top with the green
    // circle at the foot of the left one. Drawn as round-capped strokes so the
    // capsule ends stay true at any size.
    art: (
      <g strokeWidth="6.1" strokeLinecap="round" fill="none">
        <path stroke="#FBBC04" d="M12 4.4 5.6 15.5" />
        <path stroke="#4285F4" d="M12 4.4l6.4 11.1" />
        <circle cx="5.6" cy="17.6" r="3.4" fill="#34A853" stroke="none" />
      </g>
    ),
  },
  {
    match: (k) => k.includes("indeed"),
    label: "Indeed",
    // Indeed blue #2164F3 with the white "i" — the square-icon form of the
    // mark. The wordmark is unreadable at this size; the "i" and its dot are
    // the part people recognise.
    art: (
      <>
        <rect width="24" height="24" rx="5" fill="#2164F3" />
        <circle cx="12" cy="6.9" r="2.3" fill="#fff" />
        <rect x="9.7" y="10.4" width="4.6" height="9.2" rx="2.3" fill="#fff" />
      </>
    ),
  },
  {
    match: (k) =>
      k.includes("website") || k.includes("web") || k.includes("site") || k.includes("organic"),
    label: "Website",
    // Not a brand — a neutral globe in the UI's own ink, so it never competes
    // with the three real logos beside it.
    art: (
      <path
        fill="currentColor"
        d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2c1.2 0 2.6 1.9 3.1 5H8.9C9.4 6.9 10.8 5 12 5zM5.1 11h2.7c-.1 1.3-.1 2.7 0 4H5.1a7 7 0 0 1 0-4zm0 6h2.9c.4 1.6 1 2.9 1.7 3.7A7 7 0 0 1 5.1 17zm4.9 0h4c-.5 2.8-1.8 4.5-2 4.5s-1.5-1.7-2-4.5zm-.2-2a24 24 0 0 1 0-4h4.4a24 24 0 0 1 0 4zm6.2 2h2.9a7 7 0 0 1-4.6 3.7c.7-.8 1.3-2.1 1.7-3.7zm.3-2c.1-1.3.1-2.7 0-4h2.7a7 7 0 0 1 0 4zm1.6-6h-2.4c-.3-1.2-.8-2.3-1.3-3.1A7 7 0 0 1 17.9 9zM9.5 5.9C9 6.7 8.5 7.8 8.2 9H5.8a7 7 0 0 1 3.7-3.1z"
      />
    ),
  },
];

// `source` is FREE TEXT in GHL — whatever a form, a workflow or an import put
// there. "Facebook", "facebook" and " Facebook " are one channel, so every
// comparison (icon match, tile tally, filter) goes through this one key.
function srcKey(src: string): string {
  return (src || "").trim().toLowerCase();
}

function sourceIcon(src: string): { label: string; art: React.ReactNode } | null {
  const k = srcKey(src);
  if (!k) return null;
  return SOURCE_ICONS.find((x) => x.match(k)) || null;
}

/**
 * The source mark, or nothing. `title` carries the RAW source text.
 *
 * `small` is for the "By source" stat tile only, whose line is 10.5px — a 20px
 * logo there would dwarf its own count. Everywhere a record is named (kanban
 * card, list row) it renders at the full 20px.
 */
const SourceMark = ({ src, small }: { src: string; small?: boolean }) => {
  const hit = sourceIcon(src);
  if (!hit) return null;
  return (
    <span
      className={small ? "srcmark sm" : "srcmark"}
      title={`Source: ${src.trim()}`}
      aria-label={`Source: ${src.trim()}`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {hit.art}
      </svg>
    </span>
  );
};

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
// `err` holds the ERROR OBJECT, not a stringified message: per-field saves are
// exactly where the raw GHL 400 ("stageId must be one of the following values:
// c4fa7d37-…") was reaching reps, and <ErrorMessage> needs the object to map it.
type SaveState =
  | { status: "saving" | "error"; err?: unknown }
  | undefined;

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
          {/* ITEM 2 — the helper text is GONE because the FIELDS WERE RENAMED:
                  "AAA/MCO In Person Date and Time" -> "AAA/MCO In Person Date".
                  The name no longer promises a time, so explaining its absence
                  only drew attention to it.

                  ⚠️ RESOLUTION IS BY NAME and picks the new names up with no
                  code change. The GHL KEYS are unchanged on rename
                  (opportunity.aaa_in_person_date_and_time) — do not "tidy" them
                  to match, and do not resolve by key.

                  🔴 DO NOT RETRY STORING A TIME HERE. GoHighLevel cannot do it:
                  "Contact Custom fields do not support the Date Time structure"
                  — stated across three of their support articles and open on
                  their feature board for 2-3 years. The client has decided date
                  alone is enough; there are NO companion time fields. */}
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
        <ErrorMessage error={save.err ?? "Save failed"} />
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
        {/* END of the line, not the start: the name has to begin at the left
            edge so a column of cards can be scanned by name alone. */}
        <SourceMark src={r.src} />
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
      // The badge counts are fetched for the rows a person can actually SEE.
      // This attribute is what the IntersectionObserver keys on — see
      // `onScreenIds`. It is the only hook needed; nothing else about the card
      // changes.
      data-cid={r.contactId || undefined}
      className={`card${canDrag ? " draggable" : " nodrag"}${
        isDragging ? " ghost" : ""
      }`}
      onClick={onOpen}
      // ⚠️ BOTH are conditional. `attributes` was spread unconditionally, and
      // dnd-kit's disabled state includes aria-disabled="true" — so a card the
      // viewer may not DRAG was announced, and treated by tooling, as a disabled
      // control even though clicking it still opens the record. That is wrong on
      // the client board for any record a rep can't edit, and it is wrong for
      // every caregiver card, none of which drag.
      {...(canDrag ? listeners : {})}
      {...(canDrag ? attributes : {})}
    >
      <CardBody r={r} following={following} saving={saving} relBadge={relBadge} />
    </div>
  );
}

// ITEM 6c — one file card. Lifted out of the Resources tab unchanged so the
// per-folder sections and the legacy single-folder grid render identically
// rather than drifting into two near-copies.
function ResCard({
  f,
  kind,
  onPreview,
  onDelete,
}: {
  f: ResFile;
  kind: "pdf" | "image" | null;
  onPreview: () => void;
  // ITEM 11 — admin only, and only when GHL gave us an id to delete by.
  onDelete?: () => void;
}) {
  const inner = (
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
      <span className="ropen">{kind ? "Preview" : "Download ↓"}</span>
    </>
  );
  const card = kind ? (
    <button type="button" className="rescard" onClick={onPreview}>
      {inner}
    </button>
  ) : (
    <a
      className="rescard"
      href={f.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {inner}
    </a>
  );
  if (!onDelete) return card;
  return (
    <div className="rescardwrap">
      {card}
      <button
        type="button"
        className="resfiledel"
        title={`Delete ${f.name}`}
        aria-label={`Delete ${f.name}`}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onDelete();
        }}
      >
        ×
      </button>
    </div>
  );
}

// ---- ITEM 2: the Master view's CATEGORY columns ----
//
// The columns stopped being pipelines and became the client's own five words.
// Each is a PREDICATE over the records the viewer can already see — nothing is
// created in GoHighLevel and no record is duplicated.
//
// Everything is derived LIVE from the pipeline's own name and the record's own
// stage/owner. No pipeline ids are hardcoded, so a sixth pipeline called
// "XYZ Enrollment" lands in ENROLLMENT the day it is created, with no redeploy.
type MasterCatId =
  | "new"
  | "enrollment"
  | "transfer"
  | "reassign"
  | "sentout"
  | "other";

// REASSIGN is now a REAL STAGE, resolved BY NAME on each pipeline — exactly as
// TRANSFERRED IN already is. The ids exist on all five pipelines but are never
// written down here: a name match keeps working if a pipeline is rebuilt.
//
// This REPLACES the previous rule ("in a pipeline, still unassigned"). The two
// are not the same: a record can be unassigned without having been reassigned,
// and that record now stays in its pipeline column instead of being swept into
// Reassign.
export const REASSIGN_STAGE = "REASSIGN";
// One predicate, used everywhere REASSIGN has to be recognised or hidden, so
// the name is matched in exactly one place.
const isReassignStage = (name: string) =>
  (name || "").trim().toUpperCase() === REASSIGN_STAGE;
const isReassignRec = (r: OpportunityRecord) => isReassignStage(r.stage);
// ITEM 2 — SENT OUT. LOST exists on all five pipelines; matched BY NAME, as
// REASSIGN is. ⬜ PROVISIONAL: "rejected / referred out, no longer worked". If
// it turns out to mean "reassigned and claimed", this predicate is the only
// thing that changes.
export const LOST_STAGE_NAME = "LOST";
const isLostStage = (name: string) =>
  (name || "").trim().toUpperCase() === LOST_STAGE_NAME;

// ITEM 1 — SENT OUT means SUCCESSFULLY HANDED OVER, not rejected.
//
// 🔴 This REVERSES the previous definition. v42 mapped it to stage = LOST on
// the working assumption that it meant "rejected"; the client has since said it
// means the opposite — "sent out to a different department… already taken care
// of". Bill's handoff record was showing rejected leads instead of transferred
// ones, which is worse than showing nothing.
//
//   REASSIGN  at REASSIGN, no owner        — given up, not yet handed to anyone
//   SENT OUT  was reassigned, NOW OWNED    — handed over
//
// Identified by the Transferred From stamp plus an owner. VERIFIED: that stamp
// is written on the transfer path, and a reassign IS a transfer (an owner
// change to nobody), so a reassigned record carries it.
// `transferredFrom` is resolved inside the component (it needs the live field
// definitions to find the field's id), so it is passed IN rather than looked up
// here — the classifier stays a pure function of the record plus that one fact.
// ITEM #10 — WHICH ROUTE PUT THIS CARD HERE.
//
// A reassign hand-off and an ordinary transfer both land in Sent out, and until
// the reassign path started writing its own tag they were indistinguishable:
// same destination tag, same note shape.
//
// PRESENCE ONLY, never the value. `divisionLabel` collapses "OLTL Enrollment"
// and "OLTL Transfer" to one division, so a within-division reassign writes
// `reassigned-from-oltl` beside `transferred-to-oltl` and the tag's "from" half
// says nothing. Reading only whether ANY such tag exists makes that harmless.
//
// The SOURCE comes from the "Transferred From" field instead. One job each:
// the tag answers "which route", the field answers "from where", and there is
// no duplicated fact to drift apart.
//
// ⚠️ Tags are CONTACT-scoped. A contact reassigned once and transferred later
// carries the tag for good, so a subsequent plain transfer of that same contact
// will read as a reassign. Accepted — the existing `transferred-to-` tag has
// the same limit — and the tooltip says so rather than hiding it.
const REASSIGN_TAG_PREFIX = "reassigned-from-";
const wasReassigned = (r: OpportunityRecord): boolean =>
  r.tags.some((t) => t.toLowerCase().startsWith(REASSIGN_TAG_PREFIX));

const isSentOutRec = (r: OpportunityRecord, hasTransferStamp: boolean) =>
  hasTransferStamp && !!r.ownerId && !isReassignStage(r.stage);
const isNewLeadRec = (r: OpportunityRecord) =>
  (r.stage || "").trim().toUpperCase() === "NEW LEAD" && !r.ownerId;
// ITEM 1 — PRIVATE PAY IS AN ENROLLMENT.
//
// Matched by pipeline ID, deliberately, and it is the only one that is. Its
// name will never contain "Enrollment", so a name rule can't reach it, and
// special-casing the string "Private Pay" would break the day somebody renames
// the pipeline. A self-funded client is still being ENROLLED — same work, only
// the funding differs.
//
// ⚠️ This changes which COLUMN the card sits in, and nothing else. The card's
// badge still prints r.pipelineName, so a Private Pay case in the Enrollment
// column still reads "Private Pay Clients" — which is the entire reason the
// badge names the pipeline instead of the division.
const PRIVATE_PAY_PIPELINE_ID =
  process.env.NEXT_PUBLIC_PRIVATE_PAY_PIPELINE_ID || "BJBWdRim6SOgjoMelVSZ";
const isEnrollmentPipe = (name: string) => /enroll/i.test(name);
// ITEM 2 — ONE predicate, deliberately, because the previous round fixed the
// CLASSIFICATION and left the DROP TARGET behind: an owned Private Pay case
// showed in Enrollment but couldn't be dropped there, since pipelinesFor()
// filtered on the name alone. Both callers now share this, so they can't drift
// apart again.
const isEnrollmentPipeline = (p: { id: string; name: string }) =>
  isEnrollmentPipe(p.name) || p.id === PRIVATE_PAY_PIPELINE_ID;
const isTransferPipe = (name: string) => /transfer/i.test(name);

// ORDER IS THE DEFINITION — first match wins, every record lands in exactly one
// column. REASSIGN outranks the pipeline-name columns: a reassigned ODP
// Enrollment case is waiting to be CLAIMED, which is what the viewer needs to
// know, not which pipeline it happens to sit in.
//
// ⬜ SENT OUT is NOT BUILT — it is undefined, and guessing at it (the previous
// round guessed "stage = LOST") produces a column nobody can trust. The list
// below is data, so adding it later is one entry plus one predicate.
function masterCategory(
  r: OpportunityRecord,
  hasTransferStamp: boolean,
): MasterCatId {
  // REASSIGN outranks SENT OUT: a record still AT that stage has been given up
  // but not yet handed to anyone, so it is not sent out yet.
  if (isReassignRec(r)) return "reassign";
  if (isNewLeadRec(r)) return "new";
  // SENT OUT outranks the pipeline-name columns: a handed-over ODP case is
  // Sent out, not Enrollment.
  if (isSentOutRec(r, hasTransferStamp)) return "sentout";
  if (isEnrollmentPipeline({ id: r.pipelineId, name: r.pipelineName }))
    return "enrollment";
  // Private Pay never reaches TRANSFER, and that is correct: a transfer is a
  // client arriving with existing state funding, and a self-funded client has
  // no authorization to transfer.
  if (isTransferPipe(r.pipelineName)) return "transfer";
  // After the Private Pay fix this should be EMPTY in normal operation.
  // Anything landing here is now a genuine signal, not the six healthy Private
  // Pay cases that used to make people ignore the column.
  return "other";
}

const MASTER_COLUMNS: {
  id: MasterCatId;
  label: string;
  hint: string;
  droppable: boolean;
}[] = [
  {
    id: "new",
    label: "New lead",
    hint: "At NEW LEAD with nobody on it — not picked up yet.",
    // Dropping INTO New lead would mean un-working a lead, which has no
    // meaning. Refused at the drop rather than opened and then rejected.
    droppable: false,
  },
  {
    id: "enrollment",
    label: "Enrollment",
    hint: "In an Enrollment pipeline.",
    droppable: true,
  },
  {
    id: "transfer",
    label: "Transfer",
    hint: "In a Transfer pipeline.",
    droppable: true,
  },
  {
    id: "reassign",
    label: "Reassign",
    hint: "At the REASSIGN stage with no owner — waiting for a department to claim it. Claiming it (an owner plus a real stage) takes it out of this column.",
    droppable: true,
  },
  {
    id: "sentout",
    label: "Sent out",
    hint: "Was reassigned and now has an owner — handed over and being worked by the receiving department.",
    // NOT a drop target. A record arrives here by being handed over OUT of
    // Reassign (step 2), never by being dragged in.
    droppable: false,
  },
];

// Days since the record last changed stage. Returns null when GoHighLevel sent
// no timestamp — the caller renders nothing rather than "0 days".
function daysInStage(r: OpportunityRecord): number | null {
  if (!r.stageChangedAt) return null;
  const t = Date.parse(r.stageChangedAt);
  if (!Number.isFinite(t)) return null;
  const d = Math.floor((Date.now() - t) / 86_400_000);
  return d >= 0 ? d : null;
}

// ITEM 4 — a Master-view card. Deliberately NOT a BoardCard:
//
//   * it carries the CURRENT STAGE AS TEXT, because the column no longer says
//     it. On the board the column IS the stage; here the column is the pipeline,
//     so without this line a card gives no idea where in the process it sits.
//   * it does NOT commit a drag. Dragging is enabled (item 3) but a drop OPENS
//     THE MOVE DIALOG — it never moves the card. A column here is a CATEGORY,
//     so a drop can't decide by itself which pipeline is meant, and nothing has
//     happened until the dialog is submitted.
function MasterCard({
  r,
  following,
  relBadge,
  canDrag,
  onOpen,
  from,
}: {
  r: OpportunityRecord;
  following: boolean;
  relBadge?: string;
  canDrag: boolean;
  onOpen: () => void;
  // ITEM #10 — the "Transferred From" value, resolved by the parent. This
  // component is module-level and the field's ID can only be looked up against
  // the live field definitions, which live in Dashboard's state — so the FACT
  // is passed in rather than re-derived here.
  from?: string;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `m:${r.id}`,
    disabled: !canDrag,
  });
  const age = daysInStage(r);
  return (
    <div
      ref={setNodeRef}
      className={`card mcard${canDrag ? " draggable" : " nodrag"}${
        isDragging ? " ghost" : ""
      }`}
      onClick={onOpen}
      {...(canDrag ? listeners : {})}
      {...attributes}
    >
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
      <div className="cm">{r.rep || "Unassigned"}</div>
      <div className="mstage" title="Current stage">
        {r.stage || "—"}
        {/* ⬜ Days-in-stage. Rendered ONLY when GoHighLevel actually sent a
            timestamp — "0 days" on a record whose history we don't have would
            be a confident lie, and this view exists to surface exactly the
            opposite: the lead that has been sitting for three weeks. */}
        {age != null ? (
          <span
            className={`mage${age >= 14 ? " stale" : ""}`}
            title="Days since this record last changed stage"
          >
            {age}d
          </span>
        ) : null}
      </div>
      {/* ITEM #10 — HOW THIS CARD GOT HERE. A reassign hand-off and an ordinary
          transfer both end up in Sent out and the card said nothing about which
          — the two are different events and the receiving team reads them
          differently ("nobody wanted it" vs "it was given to us").
          The WORD comes from the contact's reassign tag (presence only); the
          SOURCE comes from the Transferred From field. Rendered on any card
          carrying the stamp, not just Sent out ones, because the same question
          applies wherever a transferred record shows up. */}
      {from ? (
        <div
          className={`mfrom${wasReassigned(r) ? " reassigned" : ""}`}
          title={
            wasReassigned(r)
              ? `Reassigned from ${from} — given up by that division, then claimed here. Route read from the contact's reassign tag; tags are contact-scoped, so a contact reassigned once keeps the tag.`
              : `Transferred from ${from} — handed straight to a new owner.`
          }
        >
          ← {wasReassigned(r) ? "Reassigned" : "Transferred"} from {from}
        </div>
      ) : null}
      <div className="cf">
        {/* 🔴 THE PIPELINE, NOT THE DIVISION. This showed divisionLabel() — "ODP"
            — which was enough when the column WAS the pipeline. With category
            columns it isn't: a card in ENROLLMENT could be OLTL Enrollment or
            ODP Enrollment and the column can't say which. r.pipelineName already
            carries the full name. */}
        {r.pipelineName ? (
          <span className="pill pipepill" title={r.pipelineName}>
            {r.pipelineName}
          </span>
        ) : null}
        {r.shared ? (
          <span className="pill" title="Shared with you from another division">
            Shared
          </span>
        ) : null}
        {relBadge ? (
          <span
            className="pill rellink"
            title="Linked through the caregiver ↔ client association"
          >
            ⇄ {relBadge}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// A category column that accepts a drop. `disabled` columns (New lead) still
// render as a column but never highlight and never report themselves as a
// target.
function MasterColumn({
  cat,
  count,
  droppable,
  children,
}: {
  cat: MasterCatId;
  count: number;
  droppable: boolean;
  children: ReactNode;
}) {
  // Registered as a drop target even when it can't RECEIVE one.
  //
  // `disabled: !droppable` was wrong: dnd-kit then leaves the column out of the
  // collision set entirely, so a drop on New lead resolved to `over === null`
  // and the handler returned at its "dropped on nothing" guard — the card
  // snapped back correctly but in complete silence, and a refusal that says
  // nothing is indistinguishable from a broken drag. It accepts the drop event
  // and the handler refuses it out loud; only the highlight is withheld, so it
  // never LOOKS like a valid target.
  const { setNodeRef, isOver } = useDroppable({ id: `mcol:${cat}` });
  const def = MASTER_COLUMNS.find((c) => c.id === cat);
  return (
    <div
      ref={setNodeRef}
      className={`col mcol${isOver && droppable ? " dropover" : ""}`}
    >
      <div className="colhead" title={def?.hint}>
        <span>{def?.label ?? cat}</span>
        {/* The client asked to see "how many were transferred, how many are
            in…" — so the count is part of the header, not a hover. */}
        <span className="pill">{count}</span>
      </div>
      <div className="colbody">{children}</div>
    </div>
  );
}

// Beyond this many, an unfiled group renders collapsed — a pipeline with 40
// unmapped fields rendered open pushes the rest of the panel off the screen.
// The count is in the heading either way, so nothing is hidden by surprise.
const ORPHAN_OPEN_MAX = 8;

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
  // The admin's stored folder map, fetched WITH the field defs.
  //
  // 🔴 UNDEFINED MEANS "NOT LOADED YET", NOT "EMPTY". groupFieldsForPipeline
  // falls back to the code map while this is undefined, so the panel renders
  // correctly on first paint instead of flashing "not configured" for a frame.
  const [pipelineFolders, setPipelineFolders] = useState<
    Record<string, string[]> | undefined
  >(undefined);
  const [folderNames, setFolderNames] = useState<Record<string, string>>({});
  // Sections the rep pulled in with "+ Add a section". Deliberately NOT
  // persisted — see the note in the control.
  const [shownSections, setShownSections] = useState<Set<string>>(new Set());
  const [addSecOpen, setAddSecOpen] = useState(false);
  // ITEM 3 — CONTACT fields for the open record. Held BESIDE the opportunity
  // values, never merged into `rec.cf`: merging would make an opportunity write
  // and a contact write indistinguishable at the call site, and they go to
  // different endpoints with different scope.
  const [cFields, setCFields] = useState<{
    defs: EditableFieldDef[];
    values: Record<string, unknown>;
    version: string;
    opportunityCount: number;
  } | null>(null);
  const [cLoading, setCLoading] = useState(false);
  const [cErr, setCErr] = useState<unknown>(null);
  const [cSave, setCSave] = useState<Record<string, SaveState>>({});
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
  // ITEM — SOURCE FILTER. The "By source" tile counts records by the NATIVE
  // opportunity `source`; clicking one narrows the list/board/chips to it.
  // Held as a normalised key (trimmed, lower-cased) because `source` is free
  // text in GHL: "Facebook" and "facebook" are one channel, not two.
  const [srcF, setSrcF] = useState<string>("all");
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [groupKey, setGroupKey] = useState<string | null>(null);
  // The Kanban board is the landing view. Safe because the board already renders
  // the no-access empty state (added in report 33 for exactly this reason: it
  // draws one column per HOME pipeline, so an unmapped user would otherwise land
  // on a completely blank screen rather than a merely empty one).
  const [view, setView] = useState<
    | "list"
    | "board"
    | "master"
    | "resources"
    | "import"
    | "access"
    | "pipelines"
    | "caregivers"
  >("board");
  const [selId, setSelId] = useState<string | null>(null);
  const [masterFocus, setMasterFocus] = useState<{
    kind: "pipeline" | "owner" | "source" | "status" | "blocked" | "shared" | "stalled";
    value?: string;
  } | null>(null);
  const [cgFocus, setCgFocus] = useState<{
    kind: "stage" | "recruiter" | "source" | "stalled";
    value?: string;
  } | null>(null);
  // ITEM 4 — the Master view GRANT, decided server-side (admins always).
  const [canSeeMaster, setCanSeeMaster] = useState(false);
  // Pipelines whose fetch failed on the last load. Their records are missing —
  // said out loud, because an absent pipeline looks exactly like an empty one.
  const [failedPipelines, setFailedPipelines] = useState<
    { id: string; name: string; error: string }[]
  >([]);

  // ---- ITEM 13: CAREGIVERS ----
  //
  // Held in its OWN state, loaded from its OWN request (?scope=caregiver), and
  // never merged into `data`. That separation is the requirement, and keeping it
  // structural rather than a filter is what guarantees it: the client list, the
  // client kanban and the master view all read `data`, so a caregiver applicant
  // cannot appear in them — there is no filter to forget.
  const [cgData, setCgData] = useState<OpportunityRecord[]>([]);
  const [cgPipelines, setCgPipelines] = useState<{ id: string; name: string }[]>([]);
  const [cgStagesByPipeline, setCgStagesByPipeline] = useState<
    Record<string, { id: string; name: string }[]>
  >({});
  const [cgHomeIds, setCgHomeIds] = useState<string[]>([]);
  const [cgLoading, setCgLoading] = useState(false);
  const [cgErr, setCgErr] = useState<ApiError | null>(null);
  const [cgLoaded, setCgLoaded] = useState(false);
  // "We have already tried once." Cleared by the Refresh button, which is the
  // one place a retry is a person's decision rather than a loop.
  const cgTried = useRef(false);
  const [cgPipeline, setCgPipeline] = useState<string>("all");
  const [cgQuery, setCgQuery] = useState("");
  // ITEM A2/A3 — the caregiver section gets the same controls the client
  // section has, minus the ones that are client concepts (office, county).
  const [cgView, setCgView] = useState<"list" | "board" | "resources">("board");
  const [cgStage, setCgStage] = useState<string | null>(null);
  const [cgSortKey, setCgSortKey] = useState<string | null>(null);
  const [cgSortDir, setCgSortDir] = useState<"asc" | "desc">("asc");
  const [cgGroupKey, setCgGroupKey] = useState<string | null>(null);
  // ITEM 3 — a card dropped on a Master category column, held while its dialog
  // is open.
  //
  // 🔴 THIS IS THE OPPOSITE OF THE KANBAN BOARD. On the board a drop commits
  // immediately with optimistic UI. Here NOTHING has happened on a drop: the
  // record is not touched, `data` is not mutated, and the card stays in the
  // column it came from. Cancel, Escape or clicking away leaves it exactly
  // where it was, because it never left. Only a SUCCESSFUL move re-renders it
  // elsewhere — and a FAILED one leaves it put, with the error in the dialog.
  //
  // A card that visually moves and then silently doesn't is how records stop
  // being findable, which is worse than having no drag at all.
  const [masterDrop, setMasterDrop] = useState<{
    record: OpportunityRecord;
    cat: MasterCatId;
  } | null>(null);
  // Why a drop was refused (New lead), shown briefly instead of nothing.
  const [dropRefused, setDropRefused] = useState<string | null>(null);
  // 🔴 WHICH RECORD A DRAG LAST TRIED TO SAVE.
  //
  // A failed drag save reverted the card and said NOTHING: `saveMsgFor` is only
  // rendered inside the record panel, and `dropRefused` belongs to the Master
  // board. So on either kanban a save could fail and all you saw was the card
  // going back where it came from — which is indistinguishable from "the drop
  // didn't take" and is precisely why the caregiver snap-back stayed invisible
  // for three rounds of diagnosis.
  //
  // Reuses the existing saveState plumbing rather than adding a second error
  // channel: the error is already recorded under skey(id,"stage"); all that was
  // missing was somewhere on the board to show it.
  const [dragSaveId, setDragSaveId] = useState<string | null>(null);
  // Resources tab (folder-scoped GHL media).
  const [resources, setResources] = useState<ResFile[]>([]);
  // ITEM 6c — one section per folder this viewer may see. `resources` above is
  // the LEGACY single-folder payload, still served when no folder grants exist,
  // so this deploy cannot empty the tab for someone who had files yesterday.
  const [resSections, setResSections] = useState<ResSection[]>([]);
  const [canManageFolders, setCanManageFolders] = useState(false);
  const [uploadFolder, setUploadFolder] = useState<string>("");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderErr, setFolderErr] = useState<unknown>(null);
  // The folder pending deletion, with the file count the SERVER counted. A
  // client-side count could be stale, and this call is irreversible.
  const [delFolder, setDelFolder] = useState<{
    id: string;
    name: string;
    fileCount: number;
  } | null>(null);
  // ITEM 11 — the file pending deletion. Confirmed by NAME, in an in-app
  // dialog; a native confirm() returns false silently inside the GHL iframe.
  const [delFile, setDelFile] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [resLoading, setResLoading] = useState(false);
  const [resErr, setResErr] = useState<unknown>(null);
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
  const [editErr, setEditErr] = useState<unknown>(null);
  // ITEM 2 — the note pending removal. window.confirm() is never used: this app
  // runs inside a GHL iframe, where a sandboxed frame without `allow-modals`
  // makes confirm() return false with no prompt — the click just dies.
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesErr, setNotesErr] = useState<unknown>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteErr, setNoteErr] = useState<unknown>(null);

  // The live session, readable from a stable callback. Written on every render
  // so nothing captures a stale one.
  const ssoRef = useRef(sso);
  ssoRef.current = sso;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // When the SSO session is ready, POST the still-encrypted blob so the
      // SERVER re-derives identity and filters. The browser never sends a
      // userId/role of its own. When not embedded, fall back to GET (the server
      // serves the open view only if SSO isn't configured, else 401).
      const s = ssoRef.current;
      const res =
        s.status === "ready"
          ? await fetch("/api/opportunities", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ssoKey: s.blob }),
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
      if (body.pipelineFolders) setPipelineFolders(body.pipelineFolders);
      setFolderNames(body.folderNames || {});
      if (body.stages) setPipelineStages(body.stages);
      if (body.users) setUsers(body.users);
      if (body.pipelines) setPipelines(body.pipelines);
      if (body.stagesByPipeline) setStagesByPipeline(body.stagesByPipeline);
      if (body.viewer?.homePipelineIds)
        setHomePipelineIds(body.viewer.homePipelineIds);
      setCanSeeMaster(!!body.viewer?.canSeeMaster);
      setFailedPipelines(body.failedPipelines || []);
    } catch (e) {
      setError({
        error: "Could not reach the dashboard API.",
        detail: e instanceof Error ? e.message : String(e),
      });
      setData([]);
    } finally {
      setLoading(false);
    }
    // ⚠️ `ssoRef`, not `sso`, so this callback's IDENTITY never changes.
    //
    // It read `sso` from the closure and therefore listed it as a dependency —
    // which meant every new `sso` OBJECT rebuilt `load`, and the effect below
    // depends on `load`, so a full 261-record list fetch re-fired on an
    // identity change even when `status` was unchanged. The status check in the
    // body cannot prevent that: the dependency has already fired.
    //
    // The ref is written on every render (below), so `load` always reads the
    // CURRENT session — nothing is captured stale — while staying one stable
    // function for the lifetime of the component.
  }, []);

  // Fetch once the SSO handshake has settled (ready or none), so the blob is
  // available to send. Re-runs when the STATUS changes — a real session
  // transition — and not merely when the object is replaced.
  useEffect(() => {
    if (sso.status === "loading") return;
    load();
  }, [sso.status, load]);

  // 🔴 REFRESH-ON-FOCUS IS GONE. It caused 429s.
  //
  // It was added so a viewer would see other people's changes without polling,
  // and the reasoning was sound in isolation. In practice every tab switch
  // re-ran the whole payload — five pipelines plus the reads behind them —
  // against GoHighLevel's 100-requests-per-10-seconds limit. Alt-tabbing
  // between this dashboard and GHL a few times was enough to trip it, and a 429
  // BREAKS THE PAGE, whereas slightly stale data does not. The trade was the
  // wrong way round.
  //
  // What re-fetches now, and nothing else:
  //   1. the initial load (the effect above);
  //   2. a user ACTION that changed something — and per ITEM 4 those prefer the
  //      WRITE RESPONSE over re-reading at all;
  //   3. the Refresh button, which is one request per press rather than one per
  //      alt-tab, and leaves the choice with the person looking at the screen.
  //
  // ⚠️ Do not re-add a focus or interval listener here without solving the rate
  // limit first. This is the second time the cost of automatic refreshing has
  // been underestimated on this project.

  // ITEM 13 — the caregiver payload. Same route, same access filter, same
  // version stamping; only the pipeline family differs. Loaded lazily the first
  // time the section is opened, and refreshed by the same Refresh button —
  // never on focus (see the note above the initial-load effect).
  const loadCaregivers = useCallback(async () => {
    setCgLoading(true);
    setCgErr(null);
    try {
      const res =
        sso.status === "ready"
          ? await fetch("/api/opportunities?scope=caregiver", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ssoKey: sso.blob }),
              cache: "no-store",
            })
          : await fetch("/api/opportunities?scope=caregiver", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as
        | OpportunitiesResponse
        | ApiError;
      if (!res.ok) {
        setCgErr(body as ApiError);
        setCgData([]);
        return;
      }
      const b = body as OpportunitiesResponse;
      setCgData(b.records || []);
      setCgPipelines(b.pipelines || []);
      setCgStagesByPipeline(b.stagesByPipeline || {});
      setCgHomeIds(b.viewer?.homePipelineIds || []);
      setCgLoaded(true);
    } catch (e) {
      setCgErr({
        error: "Could not reach the dashboard API.",
        detail: e instanceof Error ? e.message : String(e),
      });
      setCgData([]);
    } finally {
      setCgLoading(false);
      // 🔴 ATTEMPTED, not SUCCEEDED. `cgLoaded` is only set on success — it
      // means "we have data" and several places read it that way — so a FAILED
      // load left this effect armed, and any dependency change re-fired it.
      // That is the repeated ?scope=caregiver call in the measured loads: not a
      // retry anyone asked for, just an effect that never stopped being ready.
      //
      // A ref rather than state: it must not itself cause a render, and the
      // effect below reads it at fire time, not as a dependency.
      cgTried.current = true;
    }
  }, [sso]);

  useEffect(() => {
    if (view === "caregivers" && !cgLoaded && !cgTried.current && sso.status !== "loading")
      loadCaregivers();
  }, [view, cgLoaded, sso.status, loadCaregivers]);

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
        resources?: ResFile[];
        sections?: ResSection[];
        canManageFolders?: boolean;
        error?: string;
        detail?: string;
      };
      if (!res.ok) throw apiError(res, j);
      setResources(j.resources || []);
      const secs = j.sections || [];
      setResSections(secs);
      setCanManageFolders(!!j.canManageFolders);
      // Keep the upload target if it still exists, otherwise fall back to the
      // first folder. Leaving a stale id selected would send the upload to a
      // folder that is gone and fail on the server's folder check.
      setUploadFolder((cur) =>
        cur && secs.some((s) => s.id === cur) ? cur : (secs[0]?.id ?? ""),
      );
      setResLoaded(true);
    } catch (e) {
      setResErr(e);
    } finally {
      setResLoading(false);
    }
  }, [sso]);

  // Load the Resources tab once, when first opened — from EITHER section.
  // ITEM 3 — this used to test `view === "resources"` alone, which is the client
  // section's route to it. Reached from the Caregivers section `view` is
  // "caregivers" and `cgView` is "resources", so the fetch never fired and the
  // pane rendered its empty state over data that had simply never been asked
  // for. Still ONE request, still once: `resLoaded` is shared, so opening it
  // from one section and then the other does not re-fetch.
  const resourcesOpen =
    view === "resources" || (view === "caregivers" && cgView === "resources");
  useEffect(() => {
    if (resourcesOpen && !resLoaded && sso.status !== "loading")
      loadResources();
  }, [resourcesOpen, resLoaded, sso.status, loadResources]);

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
        // ITEM 6c — the chosen folder rides with the upload. Empty means the
        // legacy env folder, which is what a location with no folder grants
        // still uses.
        if (uploadFolder) fd.append("folderId", uploadFolder);
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
        if (!res.ok) throw apiError(res, j);
        const where = resSections.find((s) => s.id === uploadFolder)?.name;
        setUploadMsg(
          `✓ Uploaded ${file.name}${where ? ` to ${where}` : ""}`,
        );
        setResLoaded(false); // force a fresh list on next tick
        await loadResources();
      } catch (e) {
        setUploadMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setUploading(false);
      }
    },
    [sso, loadResources, uploadFolder, resSections],
  );

  // ITEM 6a — create a folder (admin; the server re-checks, that gate is the
  // real boundary).
  //
  // ⚠️ GHL AUTO-RENAMES ON COLLISION: ask for "OLTL" when one exists and you get
  // "OLTL (1)" with a 200 and no warning. The route reports the name GHL
  // actually assigned, and we say so — otherwise the admin goes looking for a
  // folder under the name they typed and doesn't find it.
  const createFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setFolderBusy(true);
    setFolderErr(null);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (sso.status === "ready") headers["x-ghl-sso-key"] = sso.blob;
      const res = await fetch("/api/resources/folders", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ssoKey: sso.status === "ready" ? sso.blob : undefined,
          name,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        folder?: { id: string; name: string; renamed?: boolean; requested?: string };
        error?: string;
        detail?: string;
      };
      if (!res.ok) throw apiError(res, j);
      setUploadMsg(
        j.folder?.renamed
          ? `✓ Created “${j.folder.name}” — GoHighLevel renamed it (a folder called “${j.folder.requested}” already exists).`
          : `✓ Created “${j.folder?.name ?? name}”.`,
      );
      setNewFolderOpen(false);
      setNewFolderName("");
      setResLoaded(false);
      await loadResources();
    } catch (e) {
      setFolderErr(e);
    } finally {
      setFolderBusy(false);
    }
  }, [newFolderName, sso, loadResources]);

  // ITEM 6a — deletion is TWO calls on purpose. The first (no `confirm`) deletes
  // nothing and returns the file count the server just counted; only then do we
  // ask, naming that number. A count sent up from the browser could be stale,
  // and this removes the folder's CONTENTS irreversibly.
  const askDeleteFolder = useCallback(
    async (id: string, name: string) => {
      setFolderErr(null);
      try {
        const headers: Record<string, string> = {};
        if (sso.status === "ready") headers["x-ghl-sso-key"] = sso.blob;
        const res = await fetch(
          `/api/resources/folders?id=${encodeURIComponent(id)}`,
          { method: "DELETE", headers },
        );
        const j = (await res.json().catch(() => ({}))) as {
          fileCount?: number;
          error?: string;
          detail?: string;
        };
        if (!res.ok) throw apiError(res, j);
        setDelFolder({ id, name, fileCount: j.fileCount ?? 0 });
      } catch (e) {
        setFolderErr(e);
        setUploadMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [sso],
  );

  const deleteFile = useCallback(async () => {
    if (!delFile) return;
    setFolderBusy(true);
    setFolderErr(null);
    try {
      const headers: Record<string, string> = {};
      if (sso.status === "ready") headers["x-ghl-sso-key"] = sso.blob;
      const res = await fetch(
        `/api/resources/files?id=${encodeURIComponent(delFile.id)}`,
        { method: "DELETE", headers },
      );
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      };
      if (!res.ok) throw apiError(res, j);
      setUploadMsg(`✓ Deleted ${delFile.name}.`);
      setDelFile(null);
      // Refresh the list IN PLACE so the row disappears without leaving the tab.
      setResLoaded(false);
      await loadResources();
    } catch (e) {
      setFolderErr(e);
    } finally {
      setFolderBusy(false);
    }
  }, [delFile, sso, loadResources]);

  const deleteFolder = useCallback(async () => {
    if (!delFolder) return;
    setFolderBusy(true);
    setFolderErr(null);
    try {
      const headers: Record<string, string> = {};
      if (sso.status === "ready") headers["x-ghl-sso-key"] = sso.blob;
      const res = await fetch(
        `/api/resources/folders?id=${encodeURIComponent(delFolder.id)}&confirm=1`,
        { method: "DELETE", headers },
      );
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      };
      if (!res.ok) throw apiError(res, j);
      setUploadMsg(
        `✓ Deleted “${delFolder.name}” and ${delFolder.fileCount} file${
          delFolder.fileCount === 1 ? "" : "s"
        }.`,
      );
      setDelFolder(null);
      setResLoaded(false);
      await loadResources();
    } catch (e) {
      setFolderErr(e);
    } finally {
      setFolderBusy(false);
    }
  }, [delFolder, sso, loadResources]);

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

  // The same search across the folder sections. Sections are KEPT when empty
  // rather than dropped, so a search that matches nothing in a folder still
  // shows the folder — otherwise a folder appears to vanish while you type.
  const visibleSections = useMemo(() => {
    const t = resQuery.trim().toLowerCase();
    if (!t) return resSections;
    return resSections.map((s) => ({
      ...s,
      files: s.files.filter((f) => f.name.toLowerCase().includes(t)),
    }));
  }, [resSections, resQuery]);

  const sectionFileCount = useMemo(
    () => resSections.reduce((n, s) => n + s.files.length, 0),
    [resSections],
  );

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
        if (!res.ok) throw apiError(res, j);
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
        if (!cancelled) setNotesErr(e);
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

  // The title + strapline for whatever is actually on screen. The board's own
  // label is computed below as `headerLabel` and used only where a board is.
  const screenHeader = useMemo((): { title: string; sub: string } => {
    switch (view) {
      case "pipelines":
        return {
          title: "Pipelines",
          sub: "Create a pipeline and choose which field sections its records show",
        };
      case "import":
        return {
          title: "Import",
          sub: "Bulk-create records from a spreadsheet",
        };
      case "access":
        return {
          title: "Access",
          sub: "Who may see which pipeline",
        };
      case "resources":
        return { title: "Resources", sub: "Shared documents and folders" };
      case "caregivers":
        return {
          title: "Caregiver applicants",
          sub: "Applicants across the recruiting pipelines",
        };
      default:
        return {
          title: headerLabel,
          sub: "Enrollments across your division · contacts, comms and settings stay in GoHighLevel",
        };
    }
  }, [view, headerLabel]);


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
  const preSrc = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.filter(
      (r) =>
        // 🔴 ITEM 5a — REASSIGN IS A MASTER-VIEW QUEUE, NOT PIPELINE WORK.
        //
        // The board columns (boardStages) and the stage chips (stages) already
        // drop REASSIGN, but this set — which feeds the LIST rows, the count
        // line and the stat cards — did NOT, so with the default "All" chip a
        // reassigned record showed as an ordinary list row a rep could open and
        // treat as their work. Master reads `data` directly and is unaffected.
        !isReassignRec(r) &&
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

  // The source filter sits BETWEEN preSrc and preStage on purpose. The "By
  // source" tile has to keep listing every channel while one is selected —
  // otherwise clicking a source collapses the tile to the one you just clicked
  // and there is no way back to the others. Same reasoning as `offices`, which
  // excludes the office filter from its own option list.
  const preStage = useMemo(
    () =>
      srcF === "all"
        ? preSrc
        : preSrc.filter((r) => srcKey(r.src) === srcF),
    [preSrc, srcF],
  );

  // ⚠️ THE STAGE FILTER IS A LIST CONTROL, AND ONLY THE LIST'S.
  //
  // The kanban already draws one column per stage, so filtering it to one stage
  // would leave a single column and six empty ones — a worse view than the
  // unfiltered board. The chips are therefore HIDDEN on the kanban (see the
  // chip row's render condition).
  //
  // 🔴 AND THE SELECTION MUST STOP APPLYING WHILE THEY ARE HIDDEN. `filtered`
  // feeds the STAT TILES, which render above the kanban too — so a stage
  // chosen on the list used to leave the board showing all 209 cards under a
  // tile reading 53. A control you cannot see must not still be filtering: the
  // same rule already written into the `scope` guard below.
  //
  // The selection SURVIVES the trip. Switching back to the list restores it
  // with the chip visibly active — losing a filter on a view toggle would be
  // its own small betrayal.
  const stageActive = view !== "board";
  const filtered = useMemo(
    () =>
      preStage.filter(
        (r) => !stageActive || stage === "all" || r.stage === stage,
      ),
    [preStage, stage, stageActive],
  );

  // Everything `filtered` has EXCEPT the source filter — the set the "By
  // source" tile tallies, so its counts stay complete while one is selected.
  const srcBase = useMemo(
    () => preSrc.filter((r) => stage === "all" || r.stage === stage),
    [preSrc, stage],
  );

  // Everything the pipeline/division selection holds, before stage, office and
  // search narrow it — the denominator the count line reports against.
  const scopedTotal = useMemo(
    () =>
      data.filter(
        (r) =>
          // ITEM 5a — reassigned records are not part of the pipeline total the
          // list reports against; they live only in Master.
          !isReassignRec(r) &&
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
      // ITEM 9 — a SHARED record is not part of this division's stage picture.
      // A case transferred AWAY and still followed sits at TRANSFERRED IN in
      // the DESTINATION pipeline, so outgoing and incoming work collapsed into
      // one chip and the count meant nothing.
      //
      // Excluded from the chips rather than given a chip of their own: the
      // "Show" control above already has a "Shared with me" option, so a chip
      // would be a second control for the same thing. "All" still counts
      // everything, and choosing Show → Shared with me still lists them.
      if (r.shared) continue;
      if (r.stage && !seen.has(r.stage)) {
        seen.add(r.stage);
        present.push(r.stage);
      }
    }
    const ordered = STAGE_ORDER.filter((s) => seen.has(s));
    const extra = present.filter((s) => !STAGE_ORDER.includes(s));
    // ITEM 5a — REASSIGN is not a pipeline stage people work in; it is a
    // holding state visible only in the Master view. A chip here would let
    // anyone filter to it from the ordinary list and treat it as normal work.
    return [...ordered, ...extra].filter((n) => !isReassignStage(n));
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

  // Same trap for the source filter: a source picked under one pipeline can
  // survive into a pipeline that has none of it, leaving an empty list with the
  // reason hidden in a stat tile. `srcBase` is the tile's own set, so this asks
  // exactly "is the selected source still on offer?".
  useEffect(() => {
    if (srcF !== "all" && !srcBase.some((r) => srcKey(r.src) === srcF))
      setSrcF("all");
  }, [srcBase, srcF]);

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

  // ═══════════════════════════════════════════════════════════════════════
  // WHICH CONTACTS ARE ACTUALLY ON SCREEN.
  //
  // 🔴 THIS IS THE WHOLE FIX, AND IT CHANGES ONLY THE QUESTION.
  //
  // The counts effect below used to ask about `visible` — the entire filtered
  // list. 209 records is 209 upstream GoHighLevel calls (relations are exposed
  // per record; there is no bulk query), issued in waves of six with each wave
  // awaited, so the wall clock is ceil(209/6) x per-call latency. Measured:
  // 15.5s on a good day, 43.4s on a bad one, for badges.
  //
  // Parallelising cannot fix that. 209 calls against a 100-per-10-seconds
  // budget is 21 seconds MINIMUM however they are arranged, and at six
  // concurrent it was already issuing ~273 per 10s — which is very likely why
  // the per-call latency was high in the first place.
  //
  // A screen holds about twenty rows. Asking about twenty instead of 209 is one
  // pass, inside budget, in about two seconds. Scrolling brings the next rows
  // in and they are fetched the same way.
  //
  // ⚠️ EVERYTHING ELSE IS UNCHANGED: the wave batching, the `relCounts`
  // pagination (still in the dependency array, still deliberate), the recorded
  // zero so a contact with no links is never re-requested, standing down while
  // a panel is open, and never surfacing a failure.
  //
  // rootMargin pre-loads a screen's worth above and below, so a slow scroll
  // does not chase the badges down the page.
  // ═══════════════════════════════════════════════════════════════════════
  const [onScreenIds, setOnScreenIds] = useState<string[]>([]);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      // No observer (very old browser, or a test environment): fall back to the
      // old behaviour rather than showing no badges at all. Slow beats blank.
      setOnScreenIds(
        [...new Set(visible.map((r) => r.contactId).filter(Boolean))],
      );
      return;
    }
    const seen = new Set<string>();
    let raf = 0;
    const io = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = (e.target as HTMLElement).dataset.cid;
          // ⚠️ ADD ONLY, never remove. A row scrolled back off screen has
          // already been counted; forgetting it would re-request it the next
          // time it scrolls past, which is the opposite of the point.
          if (id && !seen.has(id)) {
            seen.add(id);
            changed = true;
          }
        }
        if (!changed) return;
        // Coalesce a burst of intersections into ONE state write. Without this
        // a fast scroll sets state once per row and re-runs the counts effect
        // for each — a different way of making the same mistake.
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => setOnScreenIds([...seen]));
      },
      { rootMargin: "300px 0px" },
    );
    for (const el of document.querySelectorAll<HTMLElement>("[data-cid]"))
      io.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
    // Re-attached when the rendered set changes — a filter, a sort, a reload
    // all replace the elements this is watching. `view` is included because the
    // list and the board are different elements for the same data, and `data`
    // because the board's own set is derived further down the file and cannot
    // be referenced here.
  }, [visible, data, view]);

  // Fetch link counts for the contacts currently on screen. Skips any already
  // known, so paging or filtering only ever asks for the new ones.
  useEffect(() => {
    if (sso.status === "loading") return;
    // ITEM 1 — STAND DOWN WHILE A RECORD IS OPEN. This batch asks about up to 60
    // contacts at concurrency 6, off the SAME 100-per-10s GoHighLevel budget the
    // open panel is trying to use for notes, relations and contact fields. The
    // badges it feeds are a nicety on rows nobody is looking at while a panel
    // covers them; the panel's own requests are what the person is waiting for.
    //
    // Not cancelled mid-flight — deliberately: an in-flight batch has already
    // spent its budget, and aborting would waste it and re-request the same ids
    // on close. It simply does not START a new one until the panel closes.
    if (selId) return;
    // 🔴 THE ONE LINE THAT CHANGED: `onScreenIds`, not `visible`. Everything
    // below — the batch, the pagination through relCounts, the recorded zero —
    // is exactly as it was.
    const ids = [
      ...new Set(onScreenIds.filter((id) => id && !(id in relCounts))),
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
  }, [onScreenIds, sso, relCounts, selId]);

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

  // ITEM A2 — one applicant row. Days in stage renders NOTHING when GoHighLevel
  // sent no stage date, rather than "0 days" — a confident claim about a record
  // whose history we don't have. Same rule the Master card already follows.
  const renderCgRow = (r: OpportunityRecord) => {
    const age = daysInStage(r);
    return (
      <tr
        key={r.id}
        className={r.id === selId ? "sel" : ""}
        onClick={() => setSelId(r.id)}
      >
        <td className="strong">
          <div className="clientcell">
            <span className="clname">
              {/* The caregiver list has no Source COLUMN (five columns, Source
                  dropped) — so on this side the mark is the only place the
                  channel shows at all, and applicants are the records most
                  likely to carry one. Same component as the client row and the
                  kanban card: one mapping, one place to change it. */}
              {cgStr(r, "applicant") || "—"}
              <SourceMark src={r.src} />
            </span>
          </div>
        </td>
        <td>{r.stage || "—"}</td>
        <td>{age == null ? "—" : `${age} day${age === 1 ? "" : "s"}`}</td>
        <td>{r.rep || <span className="muted">Unassigned</span>}</td>
        <td>{r.pipelineName || "—"}</td>
      </tr>
    );
  };

  const renderRow = (r: OpportunityRecord) => (
    <tr
      key={r.id}
      data-cid={r.contactId || undefined}
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
            {/* End of the line — see CardBody. */}
            <SourceMark src={r.src} />
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
            <span
              className={`fromtag${wasReassigned(r) ? " reassigned" : ""}`}
              title={
                wasReassigned(r)
                  ? `Reassigned from ${transferredFrom(r)} — given up by that division and claimed here. (Route read from the contact's reassign tag; tags are contact-scoped, so a contact reassigned once keeps it.)`
                  : `Transferred from ${transferredFrom(r)} — handed directly to a new owner.`
              }
            >
              ← {wasReassigned(r) ? "Reassigned" : "Transferred"} from{" "}
              {transferredFrom(r)}
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
        // ITEM 5a — same rule as preStage: a REASSIGN record has no column on
        // the ordinary kanban, so it must not count toward boardVisible either,
        // or the "nothing in your own pipelines" hint miscounts.
        !isReassignRec(r) &&
        !r.shared &&
        (home.size === 0 || home.has(r.pipelineId)) &&
        (adminPipeline === "all" || r.pipelineId === adminPipeline) &&
        // 🔴 OFFICE WAS MISSING HERE. The Office select renders above the
        // kanban and did nothing to it: 209 cards before, 209 after, while the
        // stat tiles above them dropped to 18. A control that visibly changes
        // the numbers and not the records is worse than one that does nothing.
        //
        // Office belongs on the board in a way STAGE does not: the columns
        // already ARE the stages, but nothing on the board expresses which
        // office a record belongs to.
        (office === "all" || r.office === office) &&
        // The "By source" tile is rendered above the KANBAN as well as the
        // list, so a source picked there has to narrow the columns too —
        // otherwise the control looks dead on half the screens it appears on.
        (srcF === "all" || srcKey(r.src) === srcF) &&
        (needle === "" ||
          `${r.oppName} ${r.first} ${r.last}`.toLowerCase().includes(needle)),
    );
  }, [data, q, homePipelineIds, adminPipeline, office, srcF]);

  // ---- ITEM 4: MASTER VIEW ----
  //
  // A VIEW, not a sixth pipeline. Nothing is created in GoHighLevel and no
  // record is duplicated: these are the SAME records the list and board already
  // show, laid out one column per pipeline instead of one column per stage.
  //
  // Because it re-arranges what the server already returned, granting it can
  // never widen access — the payload was filtered before it reached the browser.
  //
  // ITEM 2 — columns are the client's five CATEGORIES, not the pipelines.
  // Records SHARED with the viewer are included — unlike the board — because a
  // cross-division case is precisely what this view exists to make visible.
  //
  // "other" is a SIXTH column that renders only when it has something in it. It
  // is a deliberate addition to the five: a record with an owner in a pipeline
  // named neither "…Enrollment" nor "…Transfer" matches no category, and the
  // alternative to showing it here is dropping it off the board silently. A
  // visible bucket you can ask about beats a record nobody can find.
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
  // ═══════════════════════════════════════════════════════════════════════
  // MASTER + CAREGIVER STATS
  //
  // 🔴 ZERO EXTRA CALLS. Every field these read is already on the record — 34
  // of them, in memory, fetched once. Each tile is a reduce over an array that
  // is already there.
  //
  // 🔴 STALLED EXCLUDES RECORDS WITH NO stageChangedAt, AND SAYS SO.
  // daysInStage() returns null when GoHighLevel sent no timestamp, and the UI
  // has always rendered nothing rather than "0 days" — a confident claim about
  // a record whose history we do not know. A tile that silently drops those is
  // the same failure class as everything else found this week, so the count of
  // undateable records is printed BESIDE the number: "142 stalled · 8 no date".
  // ═══════════════════════════════════════════════════════════════════════
  const STALL_DAYS = 14;

  // One piece of state for every master tile. A tile is either lit or it is
  // not, and clicking the lit one clears it — the same contract as the board's
  // source tile, so the two behave alike.
  type MasterFocus =
    | { kind: "pipeline" | "owner" | "source" | "status"; value: string }
    | { kind: "blocked" | "shared" | "stalled" }
    | null;


  const tallyBy = (
    rows: OpportunityRecord[],
    pick: (r: OpportunityRecord) => string,
  ): { k: string; n: number }[] => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = (pick(r) || "").trim();
      if (!k) continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()]
      .map(([k, n]) => ({ k, n }))
      .sort((a, b) => b.n - a.n || a.k.localeCompare(b.k));
  };

  const stallOf = (rows: OpportunityRecord[]) => {
    let stalled = 0;
    let noDate = 0;
    for (const r of rows) {
      const d = daysInStage(r);
      if (d == null) noDate++;
      else if (d >= STALL_DAYS) stalled++;
    }
    return { stalled, noDate };
  };

  const masterColumns = useMemo(() => {
    const needle = q.trim().toLowerCase();
    // ⚠️ THE TILES FILTER THE BOARD. A number you cannot act on is trivia —
    // clicking "unassigned" or "stalled" is the point of counting them.
    const focused = (r: OpportunityRecord) => {
      const f = masterFocus;
      if (!f) return true;
      switch (f.kind) {
        case "pipeline":
          return r.pipelineName === f.value;
        case "owner":
          return f.value === "" ? !r.ownerId : r.rep === f.value;
        case "source":
          return (r.src || "").trim() === f.value;
        case "status":
          return (r.status || "").trim() === f.value;
        case "blocked":
          return r.block !== "None" && !!r.block;
        case "shared":
          return r.shared;
        case "stalled": {
          const d = daysInStage(r);
          return d != null && d >= STALL_DAYS;
        }
        default:
          return true;
      }
    };
    const match = (r: OpportunityRecord) =>
      (office === "all" || r.office === office) &&
      focused(r) &&
      (needle === "" ||
        `${r.oppName} ${r.first} ${r.last}`.toLowerCase().includes(needle));
    const byCat = new Map<MasterCatId, OpportunityRecord[]>();
    for (const r of data) {
      if (!match(r)) continue;
      const c = masterCategory(r, !!transferredFrom(r));
      const bucket = byCat.get(c);
      if (bucket) bucket.push(r);
      else byCat.set(c, [r]);
    }
    const cols = MASTER_COLUMNS.map((c) => ({
      ...c,
      records: byCat.get(c.id) || [],
    }));
    const other = byCat.get("other") || [];
    if (other.length)
      cols.push({
        id: "other",
        label: "Uncategorised",
        hint: "Owned, but in a pipeline whose name is neither Enrollment nor Transfer — so it matches none of the five categories. Shown so it can't go missing.",
        droppable: false,
        records: other,
      });
    return cols;
  }, [data, q, office, transferredFrom, masterFocus]);

  // Computed over everything the viewer can access, NOT over the focused set —
  // otherwise clicking a tile would rewrite the numbers you clicked.
  // Lit-or-not, and clicking the lit one clears it — the same contract as the
  // board's source tile.
  const mFocus = (kind: string, value?: string) =>
    !!masterFocus && masterFocus.kind === kind && masterFocus.value === value;
  const setMFocus = (kind: string, value?: string) =>
    setMasterFocus((f) =>
      f && f.kind === kind && f.value === value
        ? null
        : ({ kind, value } as typeof f),
    );
  const focusLabel = (f: NonNullable<typeof masterFocus>) =>
    f.kind === "owner" && f.value === ""
      ? "unassigned"
      : f.kind === "stalled"
        ? `${STALL_DAYS}+ days in stage`
        : f.kind === "shared"
          ? "shared with you"
          : f.kind === "blocked"
            ? "road-blocked"
            : `${f.kind}: ${f.value}`;

  const masterStats = useMemo(() => {
    const rows = data;
    return {
      total: rows.length,
      // 🔴 SPLIT, NOT COLLAPSED. divisionLabel() strips the suffix and merges
      // "OLTL Enrollment" with "OLTL Transfer" — different work, different
      // owners. The master view exists to show WHERE WORK SITS, so it counts
      // the pipeline itself and never the division.
      byPipeline: tallyBy(rows, (r) => r.pipelineName),
      // 🔴 ASSIGNED ONLY. Counting r.rep across everything put the
      // unassigned records in TWICE — once in the "unassigned" row and again
      // under whatever placeholder the owner resolver returns for no owner
      // ("—"), so the column summed to more than the total and two rows
      // described the same records.
      byOwner: tallyBy(rows.filter((r) => r.ownerId), (r) => r.rep),
      unassigned: rows.filter((r) => !r.ownerId).length,
      bySource: tallyBy(rows, (r) => r.src),
      byStatus: tallyBy(rows, (r) => r.status),
      blocked: rows.filter((r) => r.block && r.block !== "None").length,
      // 🔴 NOBODY COUNTS THESE TODAY, and they are the ones most likely to be
      // missed: surfaced through a NON-home pipeline, so they are on nobody's
      // board by default.
      shared: rows.filter((r) => r.shared).length,
      ...stallOf(rows),
      byOffice: tallyBy(rows, (r) => r.office),
      byCounty: tallyBy(rows, (r) => r.county),
      followerNoOwner: rows.filter((r) => !r.ownerId && r.followerIds.length > 0).length,
      checked: rows.filter((r) => r.checked).length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // ITEM 13 — the caregiver board. One column per stage of the selected
  // caregiver pipeline. Deliberately NOT the client board's stage union: the two
  // caregiver pipelines have completely different stage names (PP has seven,
  // ODP DSP has ten) and merging them would produce a column list that describes
  // neither.
  const cgVisiblePipelines = useMemo(() => {
    const home = new Set(cgHomeIds);
    return isAdminViewer || !home.size
      ? cgPipelines
      : cgPipelines.filter((p) => home.has(p.id));
  }, [cgPipelines, cgHomeIds, isAdminViewer]);

  const cgActivePipeline = useMemo(
    () =>
      cgPipeline !== "all"
        ? cgPipeline
        : cgVisiblePipelines[0]?.id || "",
    [cgPipeline, cgVisiblePipelines],
  );

  const cgStages = useMemo(
    () => (cgStagesByPipeline[cgActivePipeline] || []).map((st) => st.name),
    [cgStagesByPipeline, cgActivePipeline],
  );

  // Everything EXCEPT the stage filter — the stage chips count against this, so
  // a chip shows how many it would reveal rather than how many are showing now.
  // Same rule as the client chips (report 42), for the same reason.
  const cgPreStage = useMemo(() => {
    const needle = cgQuery.trim().toLowerCase();
    return cgData.filter(
      (r) =>
        r.pipelineId === cgActivePipeline &&
        (needle === "" ||
          // Stage is searchable here as well as the name: with no office or
          // county to filter on, it is the only other thing worth typing.
          `${r.oppName} ${r.first} ${r.last} ${r.stage}`
            .toLowerCase()
            .includes(needle)),
    );
  }, [cgData, cgActivePipeline, cgQuery]);

  const cgVisible = useMemo(
    () => (cgStage ? cgPreStage.filter((r) => r.stage === cgStage) : cgPreStage),
    [cgPreStage, cgStage],
  );

  // ⚠️ APPLIED AFTER cgVisible, so cgStats keeps counting the unfocused set —
  // otherwise clicking a tile would rewrite the number you clicked.
  const cgFocused = useMemo(() => {
    if (!cgFocus) return cgVisible;
    return cgVisible.filter((r) => {
      switch (cgFocus.kind) {
        case "stage":
          return r.stage === cgFocus.value;
        case "recruiter":
          return cgFocus.value === "" ? !r.ownerId : r.rep === cgFocus.value;
        case "source":
          return (r.src || "").trim() === cgFocus.value;
        case "stalled": {
          const d = daysInStage(r);
          return d != null && d >= STALL_DAYS;
        }
        default:
          return true;
      }
    });
  }, [cgVisible, cgFocus]);

  // Sorted copy. `days` sorts NUMERICALLY and pushes unknowns last in both
  // directions — a record whose stage date GoHighLevel never sent is not "0
  // days", and letting it sort as 0 would put it top of an "oldest first" list.
  const cgSorted = useMemo(() => {
    if (!cgSortKey) return cgFocused;
    const dir = cgSortDir === "asc" ? 1 : -1;
    return [...cgFocused].sort((a, b) => {
      if (cgSortKey === "days") {
        const x = daysInStage(a);
        const y = daysInStage(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (x - y) * dir;
      }
      return cgStr(a, cgSortKey).localeCompare(cgStr(b, cgSortKey)) * dir;
    });
  }, [cgFocused, cgSortKey, cgSortDir]);

  const cgGrouped = useMemo(() => {
    if (!cgGroupKey) return null;
    const m = new Map<string, OpportunityRecord[]>();
    for (const r of cgSorted) {
      const v = cgStr(r, cgGroupKey) || "—";
      const arr = m.get(v);
      if (arr) arr.push(r);
      else m.set(v, [r]);
    }
    return [...m.entries()]
      .map(([value, rows]) => ({ value, rows }))
      .sort((x, y) => y.rows.length - x.rows.length || x.value.localeCompare(y.value));
  }, [cgSorted, cgGroupKey]);

  // ITEM 1 — THE TWO CAREGIVER STATS, and only two.
  //
  // Deliberately NOT "total applicants" (the toolbar already prints it) and NOT
  // a per-stage count (the chips already carry them) — a stats row that repeats
  // what is six inches away is furniture. And not "by recruiter": that is a
  // GROUPING, and the Group control does it better than one number can.
  //
  // Both are measured against `cgVisible` — what is actually on screen after
  // pipeline, search and stage chip — so the cards can never contradict the list
  // below them. Same rule the client "In view" card follows.
  const cgStats = useMemo(() => {
    const unassigned = cgVisible.filter((r) => !r.ownerId).length;
    // Oldest FIRST, so [0] is the one that needs attention. Records with no
    // stage timestamp are excluded rather than treated as 0 days — the probe
    // confirms every record on this account has one, so an absence means
    // something is wrong, not that the applicant arrived today.
    const aged = cgVisible
      .map((r) => ({ r, d: daysInStage(r) }))
      .filter((x): x is { r: OpportunityRecord; d: number } => x.d != null)
      .sort((a, b) => b.d - a.d);
    return {
      unassigned,
      oldest: aged[0] || null,
      dated: aged.length,
      // Same treatment as the master view, different fields.
      total: cgVisible.length,
      byStage: tallyBy(cgVisible, (r) => r.stage),
      // ⚠️ EVERY APPLICANT IS UNASSIGNED TODAY, so this reads as one row with
      // the whole count. That is the truth and it is worth seeing.
      byRecruiter: tallyBy(cgVisible.filter((r) => r.ownerId), (r) => r.rep),
      bySource: tallyBy(cgVisible, (r) => r.src),
      ...stallOf(cgVisible),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cgVisible]);

  const cgF = (kind: string, value?: string) =>
    !!cgFocus && cgFocus.kind === kind && cgFocus.value === value;
  const setCgF = (kind: string, value?: string) =>
    setCgFocus((f) =>
      f && f.kind === kind && f.value === value ? null : ({ kind, value } as typeof f),
    );

  const cgToggleSort = (key: string) => {
    if (cgSortKey === key) setCgSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setCgSortKey(key);
      setCgSortDir("asc");
    }
  };

  // A stage the chip filter is pinned to can stop existing when the pipeline
  // changes. Clear it rather than showing an empty board with a chip lit.
  useEffect(() => {
    if (cgStage && !cgStages.includes(cgStage)) setCgStage(null);
  }, [cgStages, cgStage]);

  // ITEM 3 — the pipelines a drop on each category may choose between. Derived
  // from the live pipeline NAMES, never hardcoded ids.
  const pipelinesFor = useCallback(
    (cat: MasterCatId): string[] => {
      if (cat === "enrollment")
        return selectablePipelines.filter(isEnrollmentPipeline).map((p) => p.id);
      if (cat === "transfer")
        return selectablePipelines
          .filter((p) => isTransferPipe(p.name))
          .map((p) => p.id);
      // ITEM 3 STEP 1 — REASSIGN HAS NO PIPELINE CHOICE. The record stays in
      // its OWN pipeline and moves to that pipeline's REASSIGN stage; every
      // pipeline has one. Bill is saying "this isn't mine", not choosing a
      // destination — that decision happens at step 2. Returning every
      // selectable pipeline here implied a choice that does not exist.
      return [];
    },
    [selectablePipelines],
  );

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
    // By source reads `srcBase`, not `filtered`: see the comment on srcBase.
    // Grouped on the normalised key so a channel is counted ONCE — "Indeed"
    // and "indeed" arriving from two different workflows are one number, not
    // two half-numbers. The label shown is the first spelling seen.
    const srcMap = new Map<string, { k: string; n: number }>();
    for (const r of srcBase) {
      const key = srcKey(r.src);
      if (!key) continue;
      const hit = srcMap.get(key);
      if (hit) hit.n += 1;
      else srcMap.set(key, { k: r.src.trim(), n: 1 });
    }
    const sourceStats = [...srcMap.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .map(([key, v]) => ({ key, k: v.k, n: v.n }))
      .slice(0, 4);
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
  }, [filtered, srcBase]);

  // ITEM 13 — the panel opens over EITHER family. The two lists are kept
  // separate everywhere else, but a record panel is a record panel: looking in
  // both is what lets an applicant card open without duplicating the panel.
  // Client records are searched first, so a caregiver payload can never shadow
  // one.
  const selected = useMemo(
    () => data.find((r) => r.id === selId) || cgData.find((r) => r.id === selId) || null,
    [data, cgData, selId],
  );

  // ITEM 2 — COLLAPSIBLE PANEL SECTIONS, remembered PER USER.
  //
  // The applicant panel is 58 fields in one scroll, fourteen of them day
  // dropdowns rendering 48 options each, with Notes a long way below all of it.
  //
  // ⚠️ The state is keyed by SECTION, never by record — keying it per record
  // would re-collapse everything on every applicant, which is worse than not
  // remembering at all. It lives in localStorage so it survives a reload, and
  // it is per browser, i.e. per user.
  //
  // ⚠️ GENERAL, not caregiver-specific: the client panel has twelve
  // opportunity folders and gains a contact section the day Client Care Needs
  // lands. Any section can opt in by asking `collapsed(key, default)`.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("mm.openSections");
      if (raw) setOpenSections(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      // A browser with storage blocked just gets the defaults every time.
    }
  }, []);
  const toggleSection = useCallback((key: string, openNow: boolean) => {
    setOpenSections((prev) => {
      const next = { ...prev, [key]: !openNow };
      try {
        window.localStorage.setItem("mm.openSections", JSON.stringify(next));
      } catch {
        /* not fatal — the toggle still works for this session */
      }
      return next;
    });
  }, []);
  // `defaultOpen` decides only what happens before the user has an opinion.
  const isSectionOpen = useCallback(
    (key: string, defaultOpen: boolean) =>
      key in openSections ? openSections[key] : defaultOpen,
    [openSections],
  );

  // ITEM 3 — the contact sections for the OPEN record, by its own kind. A
  // caregiver record gets the three caregiver folders; a client record gets the
  // client-side ones (Client Care Needs, once its folder is added to the table).
  const contactGroups = useMemo(
    () =>
      cFields
        ? groupContactFields(
            cFields.defs,
            cgData.some((r) => r.id === selId) ? "caregiver" : "client",
            // Values are passed so the CLIENT branch can apply its
            // has-a-value rule. The caregiver branch ignores them and renders
            // every field — see the comment on that branch, and do not
            // reconcile the two.
            cFields.values,
          )
        : [],
    [cFields, cgData, selId],
  );

  // Client contact fields a rep has chosen to reveal from "+ Add a field",
  // this session. Keyed by field id, cleared when the panel changes record so
  // one lead's revealed questions never carry onto the next.
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());
  // Which section's "+ Add a field" list is open ("" = none). One at a time:
  // two open lists in a narrow panel overlap each other. Named `addFieldOpen`
  // rather than `addOpen` — that one is the Add Lead modal.
  const [addFieldOpen, setAddFieldOpen] = useState<string>("");
  useEffect(() => {
    setRevealedFields(new Set());
    setAddFieldOpen("");
  }, [selId]);

  // Closing without choosing changes nothing — that is the whole contract of
  // this control, so both ways out (click away, Escape) are wired.
  useEffect(() => {
    if (!addFieldOpen) return;
    const away = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.(".addfield")) setAddFieldOpen("");
    };
    const esc = (e: KeyboardEvent) => {
      // Stop it reaching the panel's own Escape handler, or dismissing the
      // list would close the whole record behind it.
      if (e.key === "Escape") {
        e.stopPropagation();
        setAddFieldOpen("");
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [addFieldOpen]);

  // ITEM 3 — load the open record's CONTACT fields. One request per record,
  // keyed off `selected.id`; cleared first so a stale person's answers can never
  // appear under a new name for a frame.
  useEffect(() => {
    if (!selected?.contactId) {
      setCFields(null);
      setCErr(null);
      return;
    }
    let cancelled = false;
    setCFields(null);
    setCErr(null);
    setCLoading(true);
    const h: Record<string, string> = {};
    if (sso.status === "ready") h["x-ghl-sso-key"] = sso.blob;
    // ITEM 1 — STAGGERED behind notes rather than fired alongside it. Two
    // requests leaving together can both hit GoHighLevel's rate limit and both
    // fail, and the report-47 retry is ONE attempt with backoff — it rescues a
    // straggler, not a collision. A short gap costs nothing a person can see
    // (the section renders its own loading line) and takes the panel's opening
    // burst from three simultaneous calls down to one, then one.
    const timer = setTimeout(() => {
      if (cancelled) return;
      fetch(`/api/contacts/${encodeURIComponent(selected.id)}/fields`, {
        headers: h,
        cache: "no-store",
      })
        .then(async (res) => {
          const j = await res.json().catch(() => ({}));
          if (cancelled) return;
          if (!res.ok) {
            setCErr(j);
            return;
          }
          setCFields({
            defs: j.fieldDefs || [],
            values: j.values || {},
            version: j.version || "",
            opportunityCount: j.opportunityCount || 0,
          });
        })
        .catch((e) => {
          if (!cancelled) setCErr(e);
        })
        .finally(() => {
          if (!cancelled) setCLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selected?.id, selected?.contactId, sso]);

  // Save ONE contact field. Sends the version we read with, so a contact edited
  // from another opportunity's panel in the meantime is refused, not clobbered.
  const saveContactField = useCallback(
    async (def: EditableFieldDef, value: unknown) => {
      if (!selected) return;
      setCSave((p) => ({ ...p, [def.id]: { status: "saving" } }));
      try {
        const res = await fetch(
          `/api/contacts/${encodeURIComponent(selected.id)}/fields`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ssoKey: sso.status === "ready" ? sso.blob : undefined,
              expectedVersion: cFields?.version,
              fields: [{ id: def.id, value }],
            }),
          },
        );
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setCSave((p) => ({ ...p, [def.id]: { status: "error", err: j } }));
          return;
        }
        setCFields((prev) =>
          prev
            ? { ...prev, values: j.values || prev.values, version: j.version || prev.version }
            : prev,
        );
        // Success clears the row — same convention as the opportunity saves.
        setCSave((p) => ({ ...p, [def.id]: undefined }));
      } catch (e) {
        setCSave((p) => ({ ...p, [def.id]: { status: "error", err: e } }));
      }
    },
    [selected, sso, cFields?.version],
  );

  // ITEM 5 — the Transferred From stamp, resolved by field NAME (never a
  // hardcoded id) so it can be surfaced as a badge on rows and cards.


  // Folder-driven field sections for the open record's pipeline (Task 4).
  // A section pulled in on one record must not follow you to the next.
  useEffect(() => {
    setShownSections(new Set());
    setAddSecOpen(false);
  }, [selId]);

  const fieldGroups = useMemo(
    () =>
      selected
        ? groupFieldsForPipeline(fieldDefs, selected.pipelineId, pipelineFolders, {
            values: selected.cf || {},
            folderNames,
          })
        : {
            sections: [],
            systemInfo: [],
            orphans: [],
            orphanGroups: [],
            available: [],
            unconfigured: false,
          },
    // ⚠️ pipelineFolders BELONGS IN THESE DEPS. Without it the panel keeps
    // rendering the map it had at mount — an admin's change would not show
    // until the selected record changed.
    [selected, fieldDefs, pipelineFolders, folderNames],
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
        throw apiError(res, j);
      const n = j.note;
      setNotes((prev) => ({
        ...prev,
        // Same as the loader: keep the whole note, or the new note loses its
        // division badge and its id (and so cannot be edited until a reload).
        [selId]: [n, ...(prev[selId] || [])],
      }));
      setNoteDraft(""); // clear only on success — never lose typed input
    } catch (e) {
      setNoteErr(e);
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
        throw apiError(res, j);
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
      setEditErr(e);
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
        throw apiError(res, j);
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
      setEditErr(e);
    } finally {
      setEditBusy(false);
    }
  };

  // ---- Phase 2 save: optimistic update, revert on failure ----
  const skey = (id: string, fk: string) => `${id}:${fk}`;
  // 🔴 IS THE FIELD BEING CHANGED STILL WHAT THIS CLIENT HAD?
  //
  // Compares only the field(s) this write touches (from `patch`) between the
  // client's PRE-edit record (`was`) and the server's CURRENT record (`now`).
  // TRUE means the 409 was spurious — updatedAt moved for some other reason
  // (a background workflow, the search-index lag, another field) and a silent
  // retry is safe. FALSE means someone changed THIS field: a real conflict the
  // user must see. An unrecognised patch shape returns FALSE — surface it
  // rather than risk a blind overwrite (report 46).
  const stableCf = (v: unknown) => JSON.stringify(v ?? null);
  const fieldUnchangedOnServer = (
    patch: Record<string, unknown>,
    was: OpportunityRecord,
    now: OpportunityRecord,
  ): boolean => {
    if ("stageId" in patch) return (was.stageId || "") === (now.stageId || "");
    if ("status" in patch) return (was.status || "") === (now.status || "");
    // The panel sends the owner as `assignedTo`; the record holds it as ownerId.
    if ("assignedTo" in patch) return (was.ownerId || "") === (now.ownerId || "");
    if ("monetaryValue" in patch)
      return (was.monetaryValue || 0) === (now.monetaryValue || 0);
    if (Array.isArray(patch.customFields))
      return (patch.customFields as { id: string }[]).every(
        (cf) => stableCf(was.cf[cf.id]) === stableCf(now.cf[cf.id]),
      );
    return false;
  };

  const saveField = useCallback(
    async (
      rec: OpportunityRecord,
      fk: string,
      patch: Record<string, unknown>,
      optimistic: (r: OpportunityRecord) => OpportunityRecord,
    ) => {
      setSaveState((p) => ({ ...p, [skey(rec.id, fk)]: { status: "saving" } }));
      // 🔴 BOTH LISTS. This only ever touched `data` — the CLIENT list — so an
      // edit to a CAREGIVER record mapped over a list that does not contain it
      // and silently did nothing: no optimistic update, no server record
      // written back, no revert on failure. The panel kept showing the old
      // value until a manual Refresh, on every field, not just stage.
      //
      // Applying to both is safe by construction: the two lists never hold the
      // same id (different pipeline families, different requests), so exactly
      // one map can ever match.
      const applyBoth = (fn: (r: OpportunityRecord) => OpportunityRecord) => {
        setData((prev) => prev.map((r) => (r.id === rec.id ? fn(r) : r)));
        setCgData((prev) => prev.map((r) => (r.id === rec.id ? fn(r) : r)));
      };
      applyBoth(optimistic);

      // One PATCH attempt at a given expected version. Kept as a closure so a
      // spurious 409 can be retried with a fresh version without duplicating
      // the request shape.
      const attempt = async (expectedVersion: string | undefined) => {
        const res = await fetch(`/api/opportunities/${rec.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ssoKey: sso.status === "ready" ? sso.blob : undefined,
            expectedVersion,
            ...patch,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          record?: OpportunityRecord;
          error?: string;
          detail?: string;
        };
        return { res, j };
      };

      try {
        // ITEM 5 — the version this client last READ. `rec` is the record as it
        // was when the edit started; the optimistic update changed local state
        // only.
        let { res, j } = await attempt(rec.version);

        // 🔴 SPURIOUS-409 RETRY (report 68 item). The held version can be stale
        // through no fault of a competing edit: GoHighLevel's search index (the
        // list load) lags the direct GET this route does, so a first drag 409s
        // even though nobody touched the field. The version guard must stay
        // meaningful (report 46), so we do NOT retry blindly — we retry ONLY
        // when the FIELD we are changing is still what this client had. If that
        // field moved, it is a real conflict and must surface.
        if (res.status === 409 && j.record && fieldUnchangedOnServer(patch, rec, j.record)) {
          // The 409 body carries the fresh server record — retry ONCE with its
          // version, silently. No banner: the card just moves.
          ({ res, j } = await attempt(j.record.version));
        }

        if (!res.ok || !j.ok || !j.record) throw apiError(res, j);
        // Reflect the server's canonical record (esp. array-wrapped values) —
        // this also keeps the held version fresh for the next edit.
        applyBoth(() => j.record!);
        setSaveState((p) => ({ ...p, [skey(rec.id, fk)]: undefined }));
      } catch (e) {
        // Revert to the pre-edit record; never show a false "saved".
        applyBoth(() => rec);
        setSaveState((p) => ({
          ...p,
          [skey(rec.id, fk)]: {
            status: "error",
            err: e,
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
            expectedVersion: rec.version, // ITEM 5
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
          throw apiError(res, j);
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
            err: e,
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
  // ITEM 2 — FALLS BACK TO THE CAREGIVER MAP. `stagesByPipeline` is filled by
  // load() from /api/opportunities, which returns the CLIENT pipelines. Caregiver
  // stages arrive from loadCaregivers() into their own state. So on an applicant
  // record this lookup missed and returned [], and the panel's Stage dropdown
  // rendered EMPTY — no options at all, on a record whose stage is the main
  // thing a recruiter changes.
  //
  // The two maps stay separate (that separation is ITEM 13's whole point); this
  // only reads both. Still scoped to the record's OWN pipeline, so the
  // OPPORTUNITY_STAGE_ID_INVALID trap the original comment describes is
  // untouched: no union, no cross-pipeline stage id.
  const stagesFor = useCallback(
    (pipelineId: string): { id: string; name: string }[] =>
      stagesByPipeline[pipelineId] || cgStagesByPipeline[pipelineId] || [],
    [stagesByPipeline, cgStagesByPipeline],
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
    setDragSaveId(rec.id);
    // Reuse the proven save path: optimistic move + PATCH (pipelineStageId) +
    // revert-on-error. Save by stage ID, never name.
    saveField(
      rec,
      "stage",
      { stageId: target.id },
      (r) => ({ ...r, stage: targetStage, stageId: target.id }),
    );
  };

  // Caregiver board drag — the same shape as onDragEnd above, against cgData.
  //
  // ⚠️ Kept SEPARATE rather than making onDragEnd search both lists. The two
  // boards resolve their stages from different maps and their records from
  // different payloads; one handler serving both would have to guess which,
  // and guessing wrong writes a stage id from the wrong pipeline — the exact
  // OPPORTUNITY_STAGE_ID_INVALID trap the client handler already warns about.
  const onCgDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const { active, over } = e;
    if (!over) return;
    const overId = String(over.id);
    if (!overId.startsWith("col:")) return;
    const targetStage = overId.slice(4);
    const rec = cgData.find((x) => x.id === active.id);
    if (!rec || rec.stage === targetStage || !canEdit(rec)) return;
    // Resolved from the RECORD'S OWN pipeline, via stagesFor — which now falls
    // back to cgStagesByPipeline (report 59), so an applicant's stages resolve
    // even though the client map has never heard of its pipeline.
    const target = stagesFor(rec.pipelineId).find((st) => st.name === targetStage);
    if (!target) return;
    setDragSaveId(rec.id);
    saveField(
      rec,
      "stage",
      { stageId: target.id },
      (r) => ({ ...r, stage: targetStage, stageId: target.id }),
    );
  };

  // ITEM 3 — a drop on a MASTER category column.
  //
  // Note what this does NOT do: it does not call saveField, does not touch
  // `data`, and does not move the card. It only records what was dropped and
  // opens a dialog. Every exit path from here that isn't a successful submit
  // leaves the board exactly as it was.
  const onMasterDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const { active, over } = e;
    if (!over) return; // dropped on nothing — the card stays put
    const overId = String(over.id);
    if (!overId.startsWith("mcol:")) return;
    const cat = overId.slice(5) as MasterCatId;
    const rec = data.find((x) => `m:${x.id}` === String(active.id));
    if (!rec) return;
    if (masterCategory(rec, !!transferredFrom(rec)) === cat) return; // already there
    if (!canEdit(rec)) {
      setDropRefused("You can only move records you own or follow.");
      return;
    }
    const def = MASTER_COLUMNS.find((c) => c.id === cat);
    if (!def?.droppable) {
      setDropRefused(
        cat === "new"
          ? "A lead can't be dropped back into New lead — that would mean un-working it."
          : "That column can't receive a card.",
      );
      return;
    }
    // For a real MOVE we need somewhere to move it to. Say so up front rather
    // than opening a dialog with an empty pipeline dropdown.
    if (cat !== "reassign" && pipelinesFor(cat).length === 0) {
      setDropRefused(
        `You have no ${def.label} pipeline available, so there's nowhere to move this to.`,
      );
      return;
    }
    setDropRefused(null);
    setMasterDrop({ record: rec, cat });
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
    // ITEM 5a — no REASSIGN column on the ordinary board. Removing the column
    // also removes it as a DROP TARGET, which is the point: dragging a card
    // there from a pipeline view would put it in the holding state without the
    // followers, the note or the stamps, bypassing the whole flow.
    return names.filter((n) => !isReassignStage(n));
  }, [
    adminPipeline,
    homePipelineIds,
    pipelines,
    stagesByPipeline,
    pipelineStages,
    stages,
    boardVisible,
  ]);

  // The banner a kanban shows when the last drag's save failed. Names the record
  // and carries the REAL error, so a revert can never again look like nothing
  // happened.
  const dragSaveErr = (): ReactNode => {
    if (!dragSaveId) return null;
    const st = saveState[skey(dragSaveId, "stage")];
    if (st?.status !== "error") return null;
    const rec =
      data.find((r) => r.id === dragSaveId) ||
      cgData.find((r) => r.id === dragSaveId);
    return (
      <div className="mnote refused">
        ✗ <b>{rec?.oppName || "That card"}</b> could not be moved — it has been
        put back. <ErrorMessage error={st.err ?? "Save failed"} />
      </div>
    );
  };

  const saveMsgFor = (id: string, fk: string): ReactNode => {
    const s = saveState[skey(id, fk)];
    if (s?.status === "saving") return <div className="savemsg">Saving…</div>;
    if (s?.status === "error")
      return <ErrorMessage error={s.err ?? "Save failed"} />;
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

  // ITEM 3 — RESOURCES IS ONE SYSTEM, REACHABLE FROM EITHER SECTION.
  //
  // Defined ONCE and rendered from both the client branch and the caregiver
  // branch. Deliberately NOT a second file browser and NOT a caregiver-specific
  // folder list: same component, same request, same per-folder grants. A
  // recruiter sees "Caregiver Documents" because it is GRANTED TO THEM — never
  // because they arrived from the Caregivers section. Arriving from there
  // changes nothing about what is listed.
  //
  // Extracted rather than copied: two copies of ~270 lines of JSX would drift
  // apart the first time either was touched.
  const resourcesPane = (
          <div className="scroll reswrap">
            {/* toolbar: search + folder picker + admin upload / new folder */}
            <div className="restoolbar">
              <div className="search">
                <IconSearch />
                <input
                  placeholder="Search resources by name…"
                  value={resQuery}
                  onChange={(e) => setResQuery(e.target.value)}
                />
              </div>
              {/* ITEM 6c — UPLOAD ASKS WHICH FOLDER. With several folders on
                  screen, an "Upload" button alone can only guess, and a document
                  filed into a folder the uploader wasn't looking at is worse
                  than a refused upload. Shown once there is a real choice; with
                  one folder there is nothing to ask. */}
              {canManageFolders && resSections.length > 1 ? (
                <div className="officefilter">
                  <label htmlFor="upFolder">Upload to</label>
                  <select
                    id="upFolder"
                    value={uploadFolder}
                    onChange={(e) => setUploadFolder(e.target.value)}
                    disabled={uploading}
                  >
                    {resSections.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {canManageFolders ? (
                <button
                  type="button"
                  className="ighost resnewfolder"
                  onClick={() => {
                    setNewFolderOpen(true);
                    setNewFolderName("");
                    setFolderErr(null);
                  }}
                >
                  + New folder
                </button>
              ) : null}
              {/* ITEM B — ORGANISATION, NOT SECURITY. Said on screen because an
                  admin who sees per-folder access grants will otherwise assume
                  they protect the file. They do not: a GoHighLevel media URL is
                  reachable by ANYONE holding it, so a grant scopes what people
                  see LISTED here, not what they can open. Anything that must
                  not be readable by an outsider does not belong in the media
                  library at all. */}
              {isAdminViewer ? (
                <span
                  className="reswarn"
                  title="A GoHighLevel media link works for anyone who has it, signed in or not. Folder access controls what is listed here, not who can open a file."
                >
                  Folder access controls what is <b>listed</b> here — a
                  GoHighLevel file link still opens for anyone who has it.
                </span>
              ) : null}
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
                  <ErrorMessage error={resErr} className="errbody" />
                  <button
                    className="retry"
                    onClick={loadResources}
                    type="button"
                  >
                    Try again
                  </button>
                </div>
              </div>
            ) : resSections.length === 0 && resources.length === 0 ? (
              // ITEM 6c — NO GRANTS gets the SAME empty-state pattern as no
              // pipeline access: this is fail-closed working correctly, and the
              // person reading it has done nothing wrong. Admins see every
              // folder, so for them an empty tab genuinely means no folders.
              <div className="empty noaccess">
                <b>
                  {canManageFolders
                    ? "No resource folders yet"
                    : "No folders shared with you yet"}
                </b>
                <br />
                {canManageFolders
                  ? "Create a folder above, then grant it to people in the Access tab."
                  : "You'll see documents here once an admin gives you access to a folder."}
              </div>
            ) : resSections.length === 0 ? (
              // Legacy single-folder path — still served when the location has
              // no folder grants and RESOURCES_FOLDER_ID is set, so nobody who
              // had files yesterday loses them to this deploy.
              visibleResources.length === 0 ? (
                <div className="empty">
                  <b>No matches</b>
                  <br />
                  No resource name contains “{resQuery}”.
                </div>
              ) : (
                <div className="resgrid">
                  {visibleResources.map((f, i) => (
                    <ResCard
                      key={`${f.url}-${i}`}
                      f={f}
                      kind={previewKind(f)}
                      onPreview={() => {
                        const kind = previewKind(f);
                        if (kind) setPreview({ name: f.name, url: f.url, kind });
                      }}
                      onDelete={
                        canManageFolders && f.id
                          ? () => {
                              setDelFile({ id: f.id, name: f.name });
                              setFolderErr(null);
                            }
                          : undefined
                      }
                    />
                  ))}
                </div>
              )
            ) : (
              // ITEM 6c — SECTIONS PER FOLDER, not a selector. A selector shows
              // one folder at a time and hides the fact that the others exist;
              // sections make the whole shared set readable in one scroll, which
              // is what people are actually doing on this tab.
              <>
                {resQuery.trim() && sectionFileCount > 0 &&
                visibleSections.every((s) => s.files.length === 0) ? (
                  <div className="empty">
                    <b>No matches</b>
                    <br />
                    No resource name contains “{resQuery}”.
                  </div>
                ) : null}
                {visibleSections.map((s) => (
                  <section className="ressection" key={s.id}>
                    <div className="ressechead">
                      <h3>{s.name}</h3>
                      {s.isPublic ? (
                        <span
                          className="respill"
                          title="Marked visible to everyone in the location."
                        >
                          everyone
                        </span>
                      ) : null}
                      <span className="rescount">
                        {s.files.length} file{s.files.length === 1 ? "" : "s"}
                      </span>
                      {canManageFolders ? (
                        <button
                          type="button"
                          className="resdel"
                          onClick={() => askDeleteFolder(s.id, s.name)}
                          title="Delete this folder and everything in it"
                        >
                          Delete folder
                        </button>
                      ) : null}
                    </div>
                    {s.failed ? (
                      <div className="empty">
                        Couldn&apos;t read this folder&apos;s files. The other
                        folders above are unaffected.
                      </div>
                    ) : s.files.length === 0 ? (
                      <div className="empty">
                        {resQuery.trim() ? "No matches here." : "Empty."}
                      </div>
                    ) : (
                      <div className="resgrid">
                        {s.files.map((f, i) => (
                          <ResCard
                            key={`${f.url}-${i}`}
                            f={f}
                            kind={previewKind(f)}
                            onPreview={() => {
                              const kind = previewKind(f);
                              if (kind)
                                setPreview({ name: f.name, url: f.url, kind });
                            }}
                            onDelete={
                              canManageFolders && f.id
                                ? () => {
                                    setDelFile({ id: f.id, name: f.name });
                                    setFolderErr(null);
                                  }
                                : undefined
                            }
                          />
                        ))}
                      </div>
                    )}
                  </section>
                ))}
                {/* 🔴 ORGANISATION, NOT SECURITY — said here, where people
                    upload, rather than only in the admin tab. */}
                <div className="imeta">
                  These folders decide what is <b>listed</b> here. A GoHighLevel
                  media link works for anyone who has it, so{" "}
                  <b>client-specific documents belong on the client&apos;s
                  record</b>, not in a shared folder.
                </div>
              </>
            )}
          </div>
  );

  // ITEM 15 — WHERE THE RAIL SAYS YOU ARE. The rail used to answer exactly one
  // question ("Clients or Caregivers?"), so "not caregivers" was a good enough
  // test for Clients. Now that Import and Access live there too, that same test
  // would light Clients up while you are standing in Access. The answer is
  // derived once, here, and every rail button reads it.
  const railWhere:
    | "clients"
    | "caregivers"
    | "master"
    | "import"
    | "access"
    | "pipelines" =
    view === "caregivers" ||
    view === "import" ||
    view === "access" ||
    view === "pipelines" ||
    // ITEM 3 — Master is a CROSS-PIPELINE LENS, not another way of looking at
    // one pipeline's records, and it is the only entry in that row with its own
    // Access-tab grant. That makes it a place you go, like Caregivers — so it
    // belongs on the rail, not beside List / Board.
    view === "master"
      ? view
      : "clients";

  return (
    <div className="app">
      <nav className="rail">
        <div className="logo">M</div>
        {/* ITEM 13 — the rail is now a SECTION switch, not a single badge.
            Caregiver recruitment is different work from client enrolment: a
            different pipeline family, a different set of people, and nothing
            that should ever mix. Making that the top-level split is what makes
            the separation obvious to the person using it, not just true in the
            data. */}
        <button
          className={railWhere === "clients" ? "railsec active" : "railsec"}
          title="Client enrolments"
          type="button"
          onClick={() => setView("board")}
        >
          <IconGrid />
          <span>Clients</span>
        </button>
        <button
          className={railWhere === "caregivers" ? "railsec active" : "railsec"}
          title="Caregiver and DSP applicants"
          type="button"
          onClick={() => setView("caregivers")}
        >
          <IconPeople />
          <span>Caregivers</span>
        </button>
        {/* ITEM 3 — gated on the SAME server-decided grant the tab used
            (`canSeeMaster`, re-derived on every payload), so someone without
            master access simply has no rail entry. Hiding it is convenience,
            not the boundary: the view only re-arranges records the server has
            already decided to send. */}
        {canSeeMaster && (
          <button
            className={railWhere === "master" ? "railsec active" : "railsec"}
            title="Every pipeline you can access, side by side"
            type="button"
            onClick={() => setView("master")}
          >
            <IconMaster />
            <span>Master</span>
          </button>
        )}
        {/* ITEM 15 — ADMIN ACTIONS. Import and Access used to sit in the top
            segmented control beside List / Board / Master / Resources, which
            said they were ways of LOOKING at records. They are not: one WRITES
            new records into GoHighLevel, the other decides who may see a
            pipeline at all. Neither is a lens on the list, and neither belongs
            to the Clients section it was filed under. They move to the rail —
            below the sections and separated from them — because the rail is
            already where this app answers "where am I", and an admin action is
            somewhere you go rather than a view you switch to.

            Hiding them from non-admins is still convenience, NOT the boundary:
            /api/import, /api/import/meta and /api/admin/pipeline-access each
            re-derive the role from the SSO blob server-side (isAdminSession)
            and answer 403 otherwise. This move does not touch that. */}
        {isAdminViewer && (
          <>
            <div className="raildiv" aria-hidden="true" />
            <div className="raillabel">Admin</div>
            <button
              className={railWhere === "import" ? "railsec active" : "railsec"}
              title="Bulk import records from a spreadsheet"
              type="button"
              onClick={() => setView("import")}
            >
              <IconUpload />
              <span>Import</span>
            </button>
            <button
              className={railWhere === "access" ? "railsec active" : "railsec"}
              title="Who may see which pipeline"
              type="button"
              onClick={() => setView("access")}
            >
              <IconKey />
              <span>Access</span>
            </button>
            {/* Same argument as the two above: creating a pipeline is somewhere
                you go, not a lens on the list. /api/admin/pipelines re-derives
                the role from the SSO blob server-side and answers 403 — this
                button being hidden is convenience, not the boundary. */}
            <button
              className={railWhere === "pipelines" ? "railsec active" : "railsec"}
              title="Create a pipeline and choose the fields its records show"
              type="button"
              onClick={() => setView("pipelines")}
            >
              <IconBoard />
              <span>Pipelines</span>
            </button>
          </>
        )}
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
            {/* 🔴 THE HEADER HAS TO MATCH THE SCREEN. Both lines were the
                CLIENT BOARD's — an admin on Pipelines was told "test —
                Enrollments across your division", which describes neither the
                screen they are on nor anything they can do there. Each admin
                screen names itself and says what it is for; the board keeps the
                header it had. */}
            <h1>
              <span className="pipe" /> {screenHeader.title}
            </h1>
            <small>{screenHeader.sub}</small>
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
          {/* ITEM A3 — HIDDEN IN CAREGIVERS. AddClientDialog creates a CLIENT
              opportunity in a client pipeline. Rendered in the applicant
              section it invited someone adding a caregiver to file a client
              record instead — in a pipeline they may not even be able to see.
              Hidden rather than rewired: adding applicants from here is its own
              piece of work, and a button that does the wrong thing is worse
              than no button. */}
          {/* 🔴 THE CLIENT BOARD AND LIST, AND NOWHERE ELSE.
              This was `railWhere === "caregivers" ? null : …`, which is a test
              for ONE excluded section rather than for the two screens the
              button belongs on. railWhere collapses import, access, pipelines
              and master into values that are simply not "caregivers", so all of
              them fell through to the else and rendered it — "+ Add Lead" sat
              on top of the Pipelines, Import and Access screens, where there is
              no board and no record for it to add to.
              Naming the two views it works on cannot drift that way: a new
              section added later is excluded by default rather than included by
              accident. Resources is excluded for the same reason — it is under
              the Clients rail but has no board either. */}
          {view === "list" || view === "board" ? (
            <button
              type="button"
              className="addclientbtn"
              onClick={() => setAddOpen(true)}
              title="Create a new lead and their case"
            >
              + Add Lead
            </button>
          ) : null}
          {/* Replaces refresh-on-focus. ONE request per press, and the person
              looking at the screen decides when — rather than one payload per
              alt-tab, which is what tripped GoHighLevel's rate limit. */}
          {/* ITEM A1 — SECTION-AWARE. This button used to call load()
              unconditionally, which fetches /api/opportunities with no
              ?scope=caregiver: pressed in the Caregivers section it re-read
              CLIENT records the viewer wasn't even looking at and left the
              applicants on screen stale. That is why a second Refresh grew
              inside the caregiver toolbar. Now the one button refreshes
              whichever section is open, and the second one is gone — so the
              control keeps one position across every section. */}
          <button
            type="button"
            className="refreshbtn"
            onClick={() =>
              railWhere === "caregivers"
                ? ((cgTried.current = false), loadCaregivers())
                : load()
            }
            disabled={railWhere === "caregivers" ? cgLoading : loading}
            title={
              railWhere === "caregivers"
                ? "Re-read the applicants from GoHighLevel"
                : "Re-read everything from GoHighLevel"
            }
          >
            <IconRefresh />
            {(railWhere === "caregivers" ? cgLoading : loading)
              ? "Refreshing…"
              : "Refresh"}
          </button>
          {/* ITEM 15 — the segmented control is the CLIENT RECORD VIEWS, so it
              shows in the Clients section and nowhere else. Caregivers already
              hid it; Import and Access now do the same, for the same reason —
              none of List / Board / Master / Resources describes what is on
              screen there, and a control left up with nothing selected reads as
              broken. The rail is the way back. */}
          {/* ITEM A2 — the applicant section gets its own two-button switch, in
              the SAME position as the client one. Only List and Board: Master
              sorts on New lead / Reassign / Sent out / Enrollment / Transfer,
              which are client-work categories, and lib/ghl.ts:527 already
              records that a caregiver pipeline cannot be reassigned into.
              Resources is not per-section. */}
          {railWhere === "caregivers" ? (
            <div className="seg">
              <button
                className={cgView === "list" ? "on" : ""}
                onClick={() => setCgView("list")}
                type="button"
              >
                <IconList />
                List
              </button>
              <button
                className={cgView === "board" ? "on" : ""}
                onClick={() => setCgView("board")}
                type="button"
              >
                <IconBoard />
                Kanban
              </button>
              {/* ITEM 3 — the SAME Resources tab, reachable from here too. Not a
                  caregiver file browser: one component, one folder list, one set
                  of grants. Recruiting staff shouldn't have to leave their own
                  section to open a document they've been granted. */}
              <button
                className={cgView === "resources" ? "on" : ""}
                onClick={() => setCgView("resources")}
                type="button"
                title="Shared documents — the same folders and grants as the Clients section"
              >
                <IconDoc />
                Resources
              </button>
            </div>
          ) : null}
          {railWhere === "clients" ? (
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
              Kanban
            </button>
            {/* ITEM 4 — shown only to viewers the server GRANTED it to. The
                grant is decided in the Access tab and re-derived server-side on
                every payload; hiding the tab is convenience, not the boundary
                (there is nothing to gate here — the view re-arranges records
                the server already sent). */}
            <button
              className={view === "resources" ? "on" : ""}
              onClick={() => setView("resources")}
              type="button"
            >
              <IconDoc />
              Resources
            </button>
          </div>
          ) : null}
        </div>

        {/* Opportunity controls — LIST and BOARD only.
            Master is excluded deliberately rather than added to the "hidden on"
            list: every control here is stage- or pipeline-shaped (the stage
            chips, the pipeline selector, the stats that count `filtered`), and
            in Master the COLUMNS are the pipelines and each card names its own
            stage. Leaving them would mean a stage chip that empties columns it
            doesn't describe and a stat line that disagrees with what's on
            screen. Master renders the two filters that do apply — search and
            office — in its own toolbar below. */}
        {(view === "list" || view === "board") && (
        <>
        {/* A pipeline that failed to load is NOT an empty pipeline, and the
            difference matters: a rep seeing their division empty concludes
            there is no work. Named, with a way to retry. */}
        {failedPipelines.length ? (
          <div className="loadwarn">
            <b>
              {failedPipelines.length === 1
                ? `${failedPipelines[0].name} didn't load.`
                : `${failedPipelines.length} pipelines didn't load.`}
            </b>{" "}
            {failedPipelines.length > 1
              ? failedPipelines.map((f) => f.name).join(", ") + ". "
              : ""}
            Records from{" "}
            {failedPipelines.length === 1 ? "it are" : "them are"} missing from
            everything on this screen — this is not an empty division.{" "}
            <button type="button" className="linkbtn" onClick={() => load()}>
              Try again
            </button>
          </div>
        ) : null}
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
            <div className="k">
              By source
              {srcF !== "all" ? (
                <button
                  type="button"
                  className="srcclr"
                  onClick={() => setSrcF("all")}
                  title="Clear the source filter"
                >
                  clear
                </button>
              ) : null}
            </div>
            <div className="mini" style={{ marginTop: 9 }}>
              {stats.sourceStats.length ? (
                stats.sourceStats.map((x) => (
                  <button
                    type="button"
                    key={x.key}
                    className={`srcpick${srcF === x.key ? " on" : ""}`}
                    // Click to filter; click the same one again to clear.
                    onClick={() => setSrcF(srcF === x.key ? "all" : x.key)}
                    title={
                      srcF === x.key
                        ? `Showing ${x.k} only — click to clear`
                        : `Show ${x.k} only (${x.n})`
                    }
                  >
                    <b>{x.n}</b> {x.k}
                    <SourceMark src={x.k} small />
                  </button>
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

        {/* 🔴 LIST ONLY. On the kanban these did nothing — the columns ARE the
            stages — but they were still rendered, still looked clickable, and
            clicking one silently changed the stat tiles above the board while
            leaving all 209 cards in place.
            Hidden rather than disabled: a greyed-out row of seven chips is
            clutter explaining a control that has no job here. The columns
            already carry the counts the chips would have shown. */}
        {view === "list" ? (
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
        ) : null}
        </>
        )}

        {/* content: Import tab (admin), Resources tab, else loading / error / list / board */}
        {view === "caregivers" ? (
          // ITEM 3 — Resources is checked FIRST, before the applicant loading /
          // error / no-pipeline-access states. Those describe the applicant
          // payload, and Resources does not depend on it: a recruiter with no
          // applicant pipeline granted must still be able to open the documents
          // they DO have access to, rather than hitting "No applicant pipelines
          // assigned yet" on a tab that has nothing to do with pipelines.
          cgView === "resources" ? (
            resourcesPane
          ) : cgLoading ? (
            <div className="statewrap">
              <div className="statecard">
                <div className="spinner" />
                <h3>Loading applicants…</h3>
              </div>
            </div>
          ) : cgErr ? (
            <div className="statewrap">
              <div className="statecard">
                <h3>
                  <span className="errdot">●</span> Couldn&apos;t load applicants
                </h3>
                <p>{cgErr.error}</p>
                {cgErr.detail ? (
                  <div className="detail">{cgErr.detail}</div>
                ) : null}
                <button className="retry" onClick={loadCaregivers} type="button">
                  Try again
                </button>
              </div>
            </div>
          ) : cgVisiblePipelines.length === 0 ? (
            // The SAME empty-state pattern as no pipeline access. A caregiver
            // pipeline is granted in the Access tab like any other.
            <div className="empty noaccess">
              <b>No applicant pipelines assigned yet</b>
              <br />
              You&apos;ll see caregiver and DSP applicants here once an admin
              gives you access to one in the Access tab.
            </div>
          ) : (
            <>
              {/* ITEM 1 — same markup and same classes as the client stats, so
                  the two sections read as one app rather than two. */}
              <div className="stats">
                <div className="stat gold">
                  <div className="k">Unassigned</div>
                  <div className="v">{cgStats.unassigned}</div>
                  <div className="sub">
                    {cgStats.unassigned === 0
                      ? "every applicant has a recruiter"
                      : `of ${cgVisible.length} shown · nobody is calling them`}
                  </div>
                </div>
                <div className="stat blk">
                  <div className="k">Oldest in stage</div>
                  <div className="v">
                    {cgStats.oldest ? `${cgStats.oldest.d}d` : "—"}
                  </div>
                  <div className="sub">
                    {cgStats.oldest
                      ? `${cgStats.oldest.r.oppName ||
                          `${cgStats.oldest.r.first} ${cgStats.oldest.r.last}`.trim()} · ${
                          cgStats.oldest.r.stage
                        }`
                      : "no stage dates on the applicants shown"}
                  </div>
                </div>

                {/* 🔴 THE SAME TREATMENT AS THE MASTER VIEW, different fields.
                    Same markup and classes again — one visual language. */}
                <div className="stat">
                  <div className="k">By stage</div>
                  <div className="mini" style={{ marginTop: 9 }}>
                    {cgStats.byStage.length ? (
                      cgStats.byStage.map((x) => (
                        <button
                          key={x.k}
                          type="button"
                          className={`srcpick${cgF("stage", x.k) ? " on" : ""}`}
                          onClick={() => setCgF("stage", x.k)}
                          title={`Show ${x.k} only (${x.n})`}
                        >
                          <b>{x.n}</b> {x.k}
                        </button>
                      ))
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </div>
                </div>

                <div className="stat">
                  <div className="k">By recruiter</div>
                  <div className="mini" style={{ marginTop: 9 }}>
                    {/* ⚠️ EVERY APPLICANT IS UNASSIGNED TODAY, so this reads as
                        one row carrying the whole count. That is the truth and
                        it is worth seeing. */}
                    <button
                      type="button"
                      className={`srcpick${cgF("recruiter", "") ? " on" : ""}`}
                      onClick={() => setCgF("recruiter", "")}
                      title="Show unassigned applicants only"
                    >
                      <b>{cgStats.unassigned}</b> unassigned
                    </button>
                    {cgStats.byRecruiter.map((x) => (
                      <button
                        key={x.k}
                        type="button"
                        className={`srcpick${cgF("recruiter", x.k) ? " on" : ""}`}
                        onClick={() => setCgF("recruiter", x.k)}
                        title={`Show ${x.k} only (${x.n})`}
                      >
                        <b>{x.n}</b> {x.k}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="stat">
                  <div className="k">By source</div>
                  <div className="mini" style={{ marginTop: 9 }}>
                    {cgStats.bySource.length ? (
                      cgStats.bySource.map((x) => (
                        <button
                          key={x.k}
                          type="button"
                          className={`srcpick${cgF("source", x.k) ? " on" : ""}`}
                          onClick={() => setCgF("source", x.k)}
                          title={`Show ${x.k} only (${x.n})`}
                        >
                          <b>{x.n}</b> {x.k}
                          <SourceMark src={x.k} small />
                        </button>
                      ))
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </div>
                </div>

                <button
                  type="button"
                  className={`stat statbtn${cgF("stalled") ? " on" : ""}`}
                  onClick={() => setCgF("stalled")}
                  title={`Show applicants ${STALL_DAYS}+ days in stage`}
                >
                  <div className="k">Stalled</div>
                  <div className="v">
                    {cgStats.stalled}
                    {cgStats.noDate ? (
                      <span className="vsub"> · {cgStats.noDate} no date</span>
                    ) : null}
                  </div>
                  <div className="sub">
                    {STALL_DAYS}+ days in stage
                    {cgStats.noDate
                      ? ` · ${cgStats.noDate} without a stage date`
                      : ""}
                  </div>
                </button>
              </div>

              {cgFocus ? (
                <div className="mfocus">
                  Showing{" "}
                  <b>
                    {cgFocus.kind === "recruiter" && cgFocus.value === ""
                      ? "unassigned"
                      : cgFocus.kind === "stalled"
                        ? `${STALL_DAYS}+ days in stage`
                        : `${cgFocus.kind}: ${cgFocus.value}`}
                  </b>{" "}
                  —{" "}
                  <button type="button" onClick={() => setCgFocus(null)}>
                    show every applicant
                  </button>
                </div>
              ) : null}
              <div className="toolbar mtoolbar">
                <div className="search">
                  <IconSearch />
                  <input
                    placeholder="Search applicants by name…"
                    value={cgQuery}
                    onChange={(e) => setCgQuery(e.target.value)}
                  />
                </div>
                {cgVisiblePipelines.length > 1 ? (
                  <div className="officefilter">
                    <label htmlFor="cgPipeSel">Pipeline</label>
                    <select
                      id="cgPipeSel"
                      value={cgActivePipeline}
                      onChange={(e) => setCgPipeline(e.target.value)}
                    >
                      {cgVisiblePipelines.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} (
                          {cgData.filter((r) => r.pipelineId === p.id).length})
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                {/* ITEM A3 — sort and group, the same controls the client
                    section has. Office and county are deliberately NOT here:
                    both are client custom fields and would offer an applicant
                    a dimension every row is blank on. */}
                <div className="officefilter">
                  <label htmlFor="cgSortSel">Sort</label>
                  <select
                    id="cgSortSel"
                    value={cgSortKey || ""}
                    onChange={(e) => setCgSortKey(e.target.value || null)}
                  >
                    <option value="">Default order</option>
                    {CG_COLUMNS.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="dirbtn"
                  onClick={() =>
                    setCgSortDir((d) => (d === "asc" ? "desc" : "asc"))
                  }
                  disabled={!cgSortKey}
                  title={cgSortDir === "asc" ? "Ascending" : "Descending"}
                >
                  {cgSortDir === "asc" ? "▲" : "▼"}
                </button>
                <div className="officefilter">
                  <label htmlFor="cgGroupSel">Group</label>
                  <select
                    id="cgGroupSel"
                    value={cgGroupKey || ""}
                    onChange={(e) => setCgGroupKey(e.target.value || null)}
                  >
                    <option value="">No grouping</option>
                    <option value="stage">Stage</option>
                    <option value="recruiter">Recruiter</option>
                    <option value="pipeline">Pipeline</option>
                  </select>
                </div>
                <span className="count">
                  {cgVisible.length} applicant
                  {cgVisible.length === 1 ? "" : "s"}
                </span>
              </div>
              {/* ITEM A3 — STAGE CHIPS. Counted against `cgPreStage` (everything
                  but the stage filter itself), so a chip says how many it would
                  reveal, not how many are showing now. */}
              {/* 🔴 BUG (mine, report 51). This was `className="chips"` — a class
                  that does not exist in globals.css. With no container rule the
                  chips, which are themselves `display:flex`, laid out as blocks
                  and stacked ONE PER LINE. The client section's container is
                  `.stages`; reusing it is the fix.
                  `wrap` is a caregiver-only modifier: ODP DSP Applicant has ten
                  stages, and `.stages` alone is one row with `overflow-x:auto`,
                  which hides half of them behind a sideways scroll. Wrapping to
                  a second row keeps all ten countable at a glance. The client
                  row is left exactly as it was. */}
              <div className="stages wrap">
                <button
                  className={`chip ${cgStage === null ? "on" : ""}`}
                  onClick={() => setCgStage(null)}
                  type="button"
                >
                  All<span className="n">{cgPreStage.length}</span>
                </button>
                {cgStages.map((st) => (
                  <button
                    key={st}
                    className={`chip ${cgStage === st ? "on" : ""}`}
                    onClick={() => setCgStage(st)}
                    type="button"
                  >
                    {st}
                    <span className="n">
                      {cgPreStage.filter((r) => r.stage === st).length}
                    </span>
                  </button>
                ))}
              </div>
              {/* 🔴 REMOVED — IT HAD BECOME THE OPPOSITE OF THE TRUTH.
                  This said "the caregiver fields haven't been created in
                  GoHighLevel yet, so a record shows its stage, owner and notes
                  only". They HAVE been created — 58 fields across Caregiver
                  Application, Compliance and Availability — and the panel has
                  rendered them since the contact-fields work. A standing note
                  that tells a recruiter the panel is empty, while the panel is
                  full, is worse than no note: it teaches them not to open it.

                  Nothing replaces it. The panel now speaks for itself, and a
                  caption that has to be maintained in step with the account is
                  a caption that goes stale again. */}
              {cgView === "list" ? (
                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        {CG_COLUMNS.map((c) => (
                          <th
                            key={c.key}
                            className={`sortable ${cgSortKey === c.key ? "sorted" : ""}`}
                            onClick={() => cgToggleSort(c.key)}
                            title={`Sort by ${c.label}`}
                          >
                            {c.label}
                            <span className="sortcaret">
                              {cgSortKey === c.key
                                ? cgSortDir === "asc"
                                  ? "▲"
                                  : "▼"
                                : "↕"}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {cgGrouped
                        ? cgGrouped.map((g) => (
                            <Fragment key={g.value}>
                              <tr className="grouprow">
                                <td colSpan={CG_COLUMNS.length}>
                                  <span className="gvalue">{g.value}</span>
                                  <span className="gcount">{g.rows.length}</span>
                                </td>
                              </tr>
                              {g.rows.map((r) => renderCgRow(r))}
                            </Fragment>
                          ))
                        : cgSorted.map((r) => renderCgRow(r))}
                    </tbody>
                  </table>
                  {cgVisible.length === 0 ? (
                    <div className="empty">No applicants match this filter.</div>
                  ) : null}
                </div>
              ) : (
              <>
              {dragSaveErr()}
              {/* Drag-and-drop, same as the client board: stage change WITHIN one
                  pipeline. There is no cross-pipeline move here and there must
                  not be — an applicant does not move between PP Caregiver
                  Applicants and ODP DSP Applicant (report 57), so the columns
                  are the only drop targets, and Move is hidden on these
                  records. */}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                onDragStart={(e) => setDragId(String(e.active.id))}
                onDragCancel={() => setDragId(null)}
                onDragEnd={onCgDragEnd}
              >
              <div className="board">
                {cgStages
                  .filter((st) => !cgStage || st === cgStage)
                  .map((st) => {
                  const inCol = cgVisible.filter((r) => r.stage === st);
                  return (
                    <BoardColumn key={st} stage={st} count={inCol.length}>
                      {inCol.length ? (
                        inCol.map((r) => (
                          <BoardCard
                            key={r.id}
                            r={r}
                            // Same permission rule as the client board: admins
                            // drag anything, others only what they own or
                            // follow. The PATCH route's 403 is the backstop.
                            canDrag={canEdit(r)}
                            following={followsNotOwns(r)}
                            relBadge={undefined}
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
              {/* The moving copy. WITHOUT THIS the caregiver card was invisible
                  while dragging: BoardCard deliberately applies no transform of
                  its own (the overlay is what moves, unclipped by the column's
                  overflow), so a DndContext with no DragOverlay drags nothing
                  visible at all. The client board has had one; this one was
                  added without it. */}
              <DragOverlay dropAnimation={null}>
                {(() => {
                  const r = dragId ? cgData.find((x) => x.id === dragId) : null;
                  return r ? (
                    <div className="card dragging" style={{ width: 242 }}>
                      <CardBody
                        r={r}
                        following={followsNotOwns(r)}
                        relBadge={undefined}
                      />
                    </div>
                  ) : null;
                })()}
              </DragOverlay>
              </DndContext>
              </>
              )}
            </>
          )
        ) : view === "access" ? (
          isAdminViewer ? (
            <div className="scroll adminscroll">
              <PipelineAccessTab
                ssoBlob={sso.status === "ready" ? sso.blob : null}
              />
            </div>
          ) : (
            <div className="empty">
              <b>Admins only</b>
              <br />
              Pipeline access is restricted to admin users.
            </div>
          )
        ) : view === "pipelines" ? (
          isAdminViewer ? (
            /* 🔴 .main is overflow:hidden, and these three views were rendered
               straight into the view switch with no scrolling container of
               their own — so anything taller than the viewport was CLIPPED,
               with no scrollbar to reach it. On Pipelines that put "Create
               pipeline" permanently off-screen: the screen could be read but
               not used. The board and the list each sit in a .scroll; the admin
               screens now do too. */
            <div className="scroll adminscroll">
              <PipelineAdmin ssoBlob={sso.status === "ready" ? sso.blob : null} />
            </div>
          ) : (
            <div className="empty">
              <b>Admins only</b>
              <br />
              Creating pipelines is restricted to admin users.
            </div>
          )
        ) : view === "import" ? (
          isAdminViewer ? (
            <div className="scroll adminscroll">
              <ImportWizard ssoBlob={sso.status === "ready" ? sso.blob : null} />
            </div>
          ) : (
            <div className="empty">
              <b>Admins only</b>
              <br />
              The bulk import tool is restricted to admin users.
            </div>
          )
        ) : view === "master" ? (
          // ITEM 4 — MASTER VIEW. Every pipeline this viewer can access, side by
          // side. Not a sixth pipeline: nothing is created in GoHighLevel, and
          // these are the same records the list already returns.
          !canSeeMaster ? (
            <div className="empty">
              <b>Not enabled for you</b>
              <br />
              The Master view is granted per user in the Access tab.
            </div>
          ) : loading ? (
            <div className="statewrap">
              <div className="statecard">
                <div className="spinner" />
                <h3>Loading opportunities…</h3>
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
          ) : masterColumns.length === 0 ? (
            <NoAccessNotice />
          ) : (
            <>
              <div className="toolbar mtoolbar">
                <div className="search">
                  <IconSearch />
                  <input
                    placeholder="Search by client name…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </div>
                <div className="officefilter">
                  <label htmlFor="mofficeSel">Office</label>
                  <select
                    id="mofficeSel"
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
                  {masterColumns.reduce((n, c) => n + c.records.length, 0)} record
                  {masterColumns.reduce((n, c) => n + c.records.length, 0) === 1
                    ? ""
                    : "s"}
                </span>
              </div>
              {/* 🔴 THE MASTER VIEW HAD NO NUMBERS AT ALL — it listed records
                  and nothing else, while the client board carried four tiles.
                  This is the one place someone sees every division at once, so
                  it is where a cross-cutting count is worth most.
                  ⚠️ Same markup and classes as the client board's stats, so the
                  two read as one app rather than two. */}
              <div className="stats mstats">
                <div className="stat">
                  <div className="k">By pipeline</div>
                  {/* 🔴 SPLIT, NOT COLLAPSED — Enrollment and Transfer are
                      different work with different owners. */}
                  <div className="mini" style={{ marginTop: 9 }}>
                    {masterStats.byPipeline.length ? (
                      masterStats.byPipeline.map((x) => (
                        <button
                          key={x.k}
                          type="button"
                          className={`srcpick${mFocus("pipeline", x.k) ? " on" : ""}`}
                          onClick={() => setMFocus("pipeline", x.k)}
                          title={`Show ${x.k} only (${x.n})`}
                        >
                          <b>{x.n}</b> {x.k}
                        </button>
                      ))
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </div>
                </div>

                <div className="stat gold">
                  <div className="k">By owner</div>
                  <div className="mini" style={{ marginTop: 9 }}>
                    {/* Unassigned is its OWN row, first — it is the one that
                        needs action, not a gap in a list. */}
                    <button
                      type="button"
                      className={`srcpick${mFocus("owner", "") ? " on" : ""}`}
                      onClick={() => setMFocus("owner", "")}
                      title="Show unassigned only"
                    >
                      <b>{masterStats.unassigned}</b> unassigned
                    </button>
                    {masterStats.byOwner.map((x) => (
                      <button
                        key={x.k}
                        type="button"
                        className={`srcpick${mFocus("owner", x.k) ? " on" : ""}`}
                        onClick={() => setMFocus("owner", x.k)}
                        title={`Show ${x.k} only (${x.n})`}
                      >
                        <b>{x.n}</b> {x.k}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  className={`stat blk statbtn${mFocus("stalled") ? " on" : ""}`}
                  onClick={() => setMFocus("stalled")}
                  title={`Show records ${STALL_DAYS}+ days in stage`}
                >
                  <div className="k">Stalled</div>
                  <div className="v">
                    {masterStats.stalled}
                    {/* 🔴 SAY WHAT IS EXCLUDED. daysInStage is null when
                        GoHighLevel sent no timestamp, and those records are not
                        "0 days" — they are unknown. A tile that quietly drops
                        eight is the failure class we have hit all week. */}
                    {masterStats.noDate ? (
                      <span className="vsub"> · {masterStats.noDate} no date</span>
                    ) : null}
                  </div>
                  <div className="sub">
                    {STALL_DAYS}+ days in stage
                    {masterStats.noDate
                      ? ` · ${masterStats.noDate} record${
                          masterStats.noDate === 1 ? " has" : "s have"
                        } no stage date, so cannot be judged`
                      : ""}
                  </div>
                </button>

                <button
                  type="button"
                  className={`stat statbtn${mFocus("shared") ? " on" : ""}`}
                  onClick={() => setMFocus("shared")}
                  title="Show shared records only"
                >
                  <div className="k">Shared with you</div>
                  <div className="v">{masterStats.shared}</div>
                  {/* 🔴 NOTHING COUNTED THESE BEFORE, and they are the ones
                      most likely to be missed — surfaced through a NON-home
                      pipeline, so they sit on nobody's board by default. */}
                  <div className="sub">
                    {masterStats.shared === 0
                      ? "none — everything here is your own"
                      : "on nobody's board by default"}
                  </div>
                </button>

                <div className="stat">
                  <div className="k">By source</div>
                  <div className="mini" style={{ marginTop: 9 }}>
                    {masterStats.bySource.length ? (
                      masterStats.bySource.map((x) => (
                        <button
                          key={x.k}
                          type="button"
                          className={`srcpick${mFocus("source", x.k) ? " on" : ""}`}
                          onClick={() => setMFocus("source", x.k)}
                          title={`Show ${x.k} only (${x.n})`}
                        >
                          <b>{x.n}</b> {x.k}
                          <SourceMark src={x.k} small />
                        </button>
                      ))
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </div>
                </div>

                <div className="stat">
                  <div className="k">By status</div>
                  <div className="mini" style={{ marginTop: 9 }}>
                    {masterStats.byStatus.map((x) => (
                      <button
                        key={x.k}
                        type="button"
                        className={`srcpick${mFocus("status", x.k) ? " on" : ""}`}
                        onClick={() => setMFocus("status", x.k)}
                        title={`Show ${x.k} only (${x.n})`}
                      >
                        <b>{x.n}</b> {x.k}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  className={`stat statbtn${mFocus("blocked") ? " on" : ""}`}
                  onClick={() => setMFocus("blocked")}
                  title="Show road-blocked records only"
                >
                  <div className="k">Road-blocked</div>
                  <div className="v">{masterStats.blocked}</div>
                  <div className="sub">
                    of {masterStats.total} · {masterStats.checked} checked this week
                  </div>
                </button>
              </div>

              {masterFocus ? (
                <div className="mfocus">
                  Showing <b>{focusLabel(masterFocus)}</b> —{" "}
                  <button type="button" onClick={() => setMasterFocus(null)}>
                    show everything
                  </button>
                </div>
              ) : null}

              {/* Says the one thing that isn't obvious from looking at it: a
                  drop here ASKS, it doesn't move. */}
              <div className="mnote">
                Everything you can see, by category. <b>Dragging a card opens
                Move</b> — a column is a category, not a pipeline, so the card
                doesn&apos;t move until you confirm which one. Cancel and it stays
                exactly where it is.
              </div>
              {dropRefused ? (
                <div className="mnote refused">✗ {dropRefused}</div>
              ) : null}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCorners}
                onDragStart={(e) => {
                  setDropRefused(null); // a new attempt clears the last refusal
                  setDragId(String(e.active.id).replace(/^m:/, ""));
                }}
                onDragCancel={() => setDragId(null)}
                onDragEnd={onMasterDragEnd}
              >
                <div className="board masterboard">
                  {masterColumns.map((c) => (
                    <MasterColumn
                      key={c.id}
                      cat={c.id}
                      count={c.records.length}
                      droppable={c.droppable}
                    >
                      {c.records.length ? (
                        c.records.map((r) => (
                          <MasterCard
                            key={r.id}
                            r={r}
                            following={followsNotOwns(r)}
                            relBadge={relBadge(r)}
                            canDrag={canEdit(r)}
                            onOpen={() => setSelId(r.id)}
                            from={transferredFrom(r)}
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
                    </MasterColumn>
                  ))}
                </div>
                <DragOverlay dropAnimation={null}>
                  {(() => {
                    const r = dragId
                      ? data.find((x) => x.id === dragId)
                      : null;
                    return r ? (
                      <div className="card mcard dragging" style={{ width: 262 }}>
                        <div className="cn">
                          {r.oppName || `${r.first} ${r.last}`.trim() || "—"}
                        </div>
                        <div className="cm">{r.rep || "Unassigned"}</div>
                        <div className="mstage">{r.stage || "—"}</div>
                      </div>
                    ) : null;
                  })()}
                </DragOverlay>
              </DndContext>
            </>
          )
        ) : view === "resources" ? (
          resourcesPane
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
            {dragSaveErr()}
            {/* 🔴 THE COUNT WAS `data.length` — THE WHOLE PAYLOAD.
                An admin who picked one empty pipeline was told "You have 555
                records shared with you or owned in another division" on a
                pipeline with no records, no transfers and no owners. Both
                halves were false: the 555 were in OTHER pipelines they can see
                perfectly well, and as an admin nothing is shared with them at
                all. A count that large, stated that confidently, on a screen
                showing nothing, reads as a bug in the board rather than an
                empty pipeline.

                So the hint now counts what it names, and only claims sharing
                when something IS shared. An empty pipeline says it is empty. */}
            {boardVisible.length === 0 && data.length > 0
              ? (() => {
                  const sharedCount = data.filter((r) => r.shared).length;
                  const pickedOne = adminPipeline !== "all";
                  if (!sharedCount)
                    return (
                      <div className="empty boardhint">
                        <b>
                          {pickedOne
                            ? "Nothing in this pipeline yet"
                            : "Nothing on your board"}
                        </b>
                        <br />
                        {pickedOne
                          ? "No records have reached it. Records appear here once they are created in this pipeline or moved into it."
                          : "No records match the current filters."}
                      </div>
                    );
                  return (
                    <div className="empty boardhint">
                      <b>Nothing in your own pipelines</b>
                      <br />
                      You have {sharedCount} record{sharedCount === 1 ? "" : "s"}{" "}
                      shared with you or owned in another division. The kanban
                      shows only your own division&apos;s work —{" "}
                      <button
                        type="button"
                        className="linkbtn"
                        onClick={() => setView("list")}
                      >
                        see {sharedCount === 1 ? "it" : "them"} in the list
                      </button>
                      .
                    </div>
                  );
                })()
              : null}
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
            // ITEM 4 — NO IMMEDIATE RE-FETCH.
            //
            // This called load() straight after the write. The local update
            // above is already correct — it uses the record the WRITE RESPONSE
            // returned — but the re-fetch replaced it with GoHighLevel's search
            // index, which can still be serving the pre-write state. A correct
            // local update was being overwritten by a stale server one, which
            // is exactly the "it vanished until I reloaded" symptom.
            //
            // A DELAY WOULD BE WORSE: 1-2s is a guess at GHL's indexing lag and
            // fails silently whenever the lag is longer. Dropping it is
            // deterministic; delaying it is the same race with better odds.
            // Refresh picks up anything else, when the user asks for it.
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

      {/* ITEM 3 — the dialog a Master-view DROP opens.
          Every one of these closes by setting masterDrop back to null and
          nothing else: the card was never moved, so cancelling has nothing to
          undo. Only onMoved/onDone re-renders the board. */}
      {masterDrop && masterDrop.cat === "reassign" ? (
        // ITEM 3 STEP 1 — INTO Reassign. Its own dialog, not Move: there is no
        // pipeline to choose and the consequence (an owner is removed with no
        // undo) needs stating, not a dropdown.
        <ReassignDialog
          key={`ra-${masterDrop.record.id}`}
          record={masterDrop.record}
          ownerName={
            masterDrop.record.ownerId
              ? masterDrop.record.rep ||
                userLabel(masterDrop.record.ownerId).split(" — ")[0]
              : ""
          }
          ssoBlob={sso.status === "ready" ? sso.blob : null}
          onClose={() => setMasterDrop(null)}
          onDone={(rec) => {
            setData((prev) => prev.map((r) => (r.id === rec.id ? rec : r)));
            setMasterDrop(null);
            setSelId(null); // it has left this viewer's board
            // ITEM 4 — NO IMMEDIATE RE-FETCH.
            //
            // This called load() straight after the write. The local update
            // above is already correct — it uses the record the WRITE RESPONSE
            // returned — but the re-fetch replaced it with GoHighLevel's search
            // index, which can still be serving the pre-write state. A correct
            // local update was being overwritten by a stale server one, which
            // is exactly the "it vanished until I reloaded" symptom.
            //
            // A DELAY WOULD BE WORSE: 1-2s is a guess at GHL's indexing lag and
            // fails silently whenever the lag is longer. Dropping it is
            // deterministic; delaying it is the same race with better odds.
            // Refresh picks up anything else, when the user asks for it.
          }}
        />
      ) : masterDrop ? (
        <MoveDialog
          key={`drop-${masterDrop.record.id}-${masterDrop.cat}`}
          record={masterDrop.record}
          pipelines={pipelines}
          stagesByPipeline={stagesByPipeline}
          users={users}
          ssoBlob={sso.status === "ready" ? sso.blob : null}
          allowedPipelineIds={pipelinesFor(masterDrop.cat)}
          // ⚠️ STEP 2 — a card dragged OUT of Reassign is being CLAIMED, so an
          // owner is mandatory and forceUnassigned must be off. Before this,
          // any drop reusing the reassign configuration would have STRIPPED the
          // owner on the one path whose entire purpose is to set one.
          requireOwner={isReassignStage(masterDrop.record.stage)}
          intro={
            isReassignStage(masterDrop.record.stage) ? (
              <>
                You&apos;re handing{" "}
                <b>
                  {masterDrop.record.oppName ||
                    `${masterDrop.record.first} ${masterDrop.record.last}`.trim()}
                </b>{" "}
                over out of <b>Reassign</b>. Choose the <b>pipeline</b>, the{" "}
                <b>owner</b> who will work it, and the <b>stage</b> — all three
                are required. The followers this dashboard added while it waited
                are removed once it&apos;s claimed.
              </>
            ) : (
              <>
                You&apos;re moving{" "}
                <b>
                  {masterDrop.record.oppName ||
                    `${masterDrop.record.first} ${masterDrop.record.last}`.trim()}
                </b>{" "}
                to{" "}
                <b>
                  {MASTER_COLUMNS.find((c) => c.id === masterDrop.cat)?.label}
                </b>
                . <b>Which one?</b>
              </>
            )
          }
          onClose={() => setMasterDrop(null)}
          onMoved={(rec, transferred) => {
            setData((prev) => prev.map((r) => (r.id === rec.id ? rec : r)));
            setMasterDrop(null);
            if (transferred) setSelId(null);
            // ITEM 4 — NO IMMEDIATE RE-FETCH.
            //
            // This called load() straight after the write. The local update
            // above is already correct — it uses the record the WRITE RESPONSE
            // returned — but the re-fetch replaced it with GoHighLevel's search
            // index, which can still be serving the pre-write state. A correct
            // local update was being overwritten by a stale server one, which
            // is exactly the "it vanished until I reloaded" symptom.
            //
            // A DELAY WOULD BE WORSE: 1-2s is a guess at GHL's indexing lag and
            // fails silently whenever the lag is longer. Dropping it is
            // deterministic; delaying it is the same race with better odds.
            // Refresh picks up anything else, when the user asks for it.
          }}
        />
      ) : null}

      {/* ITEM 11 — file deletion, confirmed by NAME. */}
      {delFile ? (
        <ConfirmDialog
          title="Delete this file?"
          body={
            <>
              <b>{delFile.name}</b> will be removed from GoHighLevel. Anyone
              linking to it loses it. This can&apos;t be undone.
            </>
          }
          confirmLabel="Delete file"
          danger
          busy={folderBusy}
          error={folderErr}
          onConfirm={deleteFile}
          onCancel={() => {
            setDelFile(null);
            setFolderErr(null);
          }}
        />
      ) : null}

      {/* ITEM 6a — new folder. An in-app dialog, never window.prompt(), which a
          sandboxed GHL iframe returns null from without ever asking. */}
      {newFolderOpen ? (
        <ConfirmDialog
          title="New resource folder"
          body={
            <>
              <p style={{ margin: "0 0 10px" }}>
                Creates a folder in the GoHighLevel media library. Nobody sees it
                until you grant it in the <b>Access</b> tab.
              </p>
              <input
                className="foldername"
                autoFocus
                placeholder="Folder name"
                value={newFolderName}
                disabled={folderBusy}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newFolderName.trim() && !folderBusy)
                    createFolder();
                }}
              />
              <p className="fnote">
                If a folder with this name already exists, GoHighLevel creates
                “{newFolderName.trim() || "Name"} (1)” instead — without an
                error. We&apos;ll tell you the name it actually used.
              </p>
            </>
          }
          confirmLabel="Create folder"
          busy={folderBusy}
          error={folderErr}
          onConfirm={createFolder}
          onCancel={() => {
            setNewFolderOpen(false);
            setFolderErr(null);
          }}
        />
      ) : null}

      {/* ITEM 6a — folder deletion. The count comes from the SERVER's first
          call, which deleted nothing; this asks with that number in front of
          the admin. */}
      {delFolder ? (
        <ConfirmDialog
          title={`Delete “${delFolder.name}”?`}
          body={
            <>
              This deletes the folder <b>and the {delFolder.fileCount} file
              {delFolder.fileCount === 1 ? "" : "s"} inside it</b> from
              GoHighLevel. Anyone linking to those files loses them. This
              can&apos;t be undone.
            </>
          }
          confirmLabel={
            delFolder.fileCount
              ? `Delete folder and ${delFolder.fileCount} file${
                  delFolder.fileCount === 1 ? "" : "s"
                }`
              : "Delete folder"
          }
          danger
          busy={folderBusy}
          error={folderErr}
          onConfirm={deleteFolder}
          onCancel={() => {
            setDelFolder(null);
            setFolderErr(null);
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
              {/* ITEM 1 — HOW TO REACH THIS PERSON. First thing on the panel and
                  NOT collapsible: a record panel that cannot tell you the
                  phone number has failed at its basic job.
                  Applies to CLIENTS TOO — a client's phone and email are on the
                  contact as well, and the panel showed neither.
                  ⚠️ Native contact fields, so they belong to no folder and
                  CONTACT_FOLDERS never carries them. They already arrive with
                  the opportunity search, so this costs NO extra GHL call.
                  ⚠️ The NAME shown here is the CONTACT's. On a client record the
                  Client First/Last Name CUSTOM fields can disagree with it —
                  see the report; the contact is authoritative for reaching
                  someone, which is what this block is for. */}
              {(selected.contactName ||
                selected.contactPhone ||
                selected.contactEmail) ? (
                <div className="contactbar">
                  <div className="cbname">
                    {selected.contactName || "No name on the contact"}
                  </div>
                  <div className="cbrow">
                    {selected.contactPhone ? (
                      <a
                        className="cbitem"
                        href={`tel:${selected.contactPhone.replace(/[^\d+]/g, "")}`}
                      >
                        {selected.contactPhone}
                      </a>
                    ) : (
                      <span className="cbitem none">No phone</span>
                    )}
                    {selected.contactEmail ? (
                      <a className="cbitem" href={`mailto:${selected.contactEmail}`}>
                        {selected.contactEmail}
                      </a>
                    ) : (
                      <span className="cbitem none">No email</span>
                    )}
                  </div>
                </div>
              ) : null}
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
                  {/* HIDDEN ON APPLICANTS. Move is a CROSS-PIPELINE transfer
                      between client pipelines — it writes the Transferred
                      From/Date stamps, the transferred-to tag and a division
                      note, and its destination list is built from client
                      pipelines. An applicant has nowhere to go: the two
                      applicant pipelines are different jobs, not two stages of
                      one process (report 57), and lib/ghl.ts:527 already
                      records that a caregiver pipeline cannot be reassigned
                      into. It rendered here until now purely because
                      `.panelactions` was gated on canEdit alone. */}
                  {cgData.some((r) => r.id === selected.id) ? null : (
                  <button
                    type="button"
                    className="movebtn"
                    onClick={() => setMoveOpen(true)}
                  >
                    ⇄ Move this case
                  </button>
                  )}
                  {/* MESSAGE — opens the contact's Conversations thread in GHL.
                      All pipelines, clients and caregivers alike.

                      ✅ NOT admin-gated, unlike "Open in GoHighLevel" in the
                      panel footer. That one is correctly restricted because it
                      targets /opportunities/, which reps have switched OFF
                      (opportunitiesEnabled false). Conversations and Contacts
                      are ON for them (conversationsEnabled / contactsEnabled
                      true), so this link works for a rep and hiding it would
                      take away something they can actually use.

                      ⚠️ NO ?category=team-inbox&tab=unread — those filter the
                      inbox LIST and are wrong for a direct thread.

                      ⚠️ contactId is already on the record; no fetch. When it
                      is missing the button is HIDDEN rather than rendered
                      pointing at a URL that 404s. */}
                  {selected.contactId ? (
                    <a
                      className="msgbtn"
                      href={`https://app.gohighlevel.com/v2/location/${LOCATION_ID}/conversations/conversations/${selected.contactId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open this person's conversation in GoHighLevel"
                    >
                      💬 Message
                    </a>
                  ) : null}
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
                    {stagesFor(selected.pipelineId)
                      // ITEM 5a — REASSIGN is hidden as a DESTINATION: nobody
                      // should be able to put a record into the holding state
                      // from this dropdown and skip the flow.
                      //
                      // ⚠️ But a record that IS at REASSIGN must still show its
                      // own stage. Filtering unconditionally would render a
                      // select whose value matches no option — which paints
                      // BLANK, reads as "this record has no stage", and would
                      // silently rewrite the stage on the next save. So the
                      // record's current stage is always kept, and disabled.
                      .filter(
                        (s) =>
                          !isReassignStage(s.name) || s.id === selected.stageId,
                      )
                      .map((s) => (
                        <option
                          key={s.id}
                          value={s.id}
                          disabled={isReassignStage(s.name)}
                        >
                          {s.name}
                          {isReassignStage(s.name)
                            ? " — waiting to be claimed"
                            : ""}
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

              {/* ══ TWO LABELLED BLOCKS, CONTACT FIRST ══════════════════
                  Several field NAMES exist on BOTH models — "Care Needed" is
                  one — so a rep looking at a value had no way to tell which
                  model it belonged to. A scope line between them was not
                  enough; each block now says what it is.

                  ⚠️ CONTACT COMES FIRST: it is what the person told you, and
                  the opportunity fields are what the team has done since. Read
                  the lead before the case.

                  ⚠️ Status & Workflow and Assignment stay ABOVE both headers,
                  deliberately. They are not fields in the folder sense — they
                  are the record's spine, and Stage and Owner are the two things
                  a rep touches most. Putting them under an OPPORTUNITY header
                  would push the panel's most-used controls below every contact
                  section and make the commonest action a scroll.

                  ⚠️ The headers are STRUCTURAL, not collapsible. The folder
                  sections inside them already collapse.

                  ⚠️ SAME ON THE CAREGIVER PANEL. This is one panel branching on
                  kind, so a caregiver record gets the same two headers in the
                  same order for free — which is the point: two panels with
                  opposite structure would be worse than either choice alone. */}

              {/* ── CONTACT ─────────────────────────────────────────────── */}
              {cLoading ? (
                <div className="sechead">
                  Loading{" "}
                  {cgData.some((r) => r.id === selId) ? "the applicant" : "this person"}
                  &apos;s details…
                </div>
              ) : cErr ? (
                <>
                  <div className="sechead">About this person</div>
                  <ErrorMessage error={cErr} />
                </>
              ) : contactGroups.length ? (
                <>
                  <div className="blockhead">Contact</div>
                  {/* The scope line explains THIS block, so it sits inside it,
                      under the header rather than floating between the two. */}
                  <div className="contactscope">
                    <b>About this person, not this case.</b>{" "}
                    {cFields && cFields.opportunityCount > 1
                      ? `Changes here show on all ${cFields.opportunityCount} of their records.`
                      : "Changes here follow them onto every record they hold."}
                  </div>
                  {contactGroups.map((g, gi) => {
                    // One section open by default, the rest collapsed. On a
                    // CAREGIVER record that is the first — Caregiver
                    // Application is what a recruiter reads first, and it is
                    // first in CONTACT_FOLDERS.
                    //
                    // On a CLIENT record the first section is often empty: a
                    // lead answered one of the three Meta forms, so the other
                    // folders hold nothing. Opening the first ANSWERED section
                    // instead means the panel opens on what the person actually
                    // said rather than on a heading with nothing under it.
                    const firstAnswered = contactGroups.findIndex((x) => x.fields.length);
                    const defaultOpen =
                      gi === (firstAnswered >= 0 ? firstAnswered : 0);
                    const open = isSectionOpen(g.key, defaultOpen);
                    return (
                    <Fragment key={g.key}>
                      <button
                        type="button"
                        className={`sechead sectoggle${open ? " open" : ""}`}
                        onClick={() => toggleSection(g.key, open)}
                        aria-expanded={open}
                      >
                        <span className="secarrow" aria-hidden="true">
                          {open ? "▾" : "▸"}
                        </span>
                        {g.label}
                        {/* The count is what is ANSWERED. A client section with
                            nothing answered shows no number at all — a heading
                            followed by a bare "0" reads as broken, and its
                            "Show N empty fields" control already says how many
                            questions are waiting. */}
                        {g.fields.length ? (
                          <span className="seccount">{g.fields.length}</span>
                        ) : null}
                      </button>
                      {open ? (
                      <>
                      <div className="grid">
                        {[
                          ...g.fields,
                          // Revealed empties render in their folder's own
                          // order, beside the answered ones, not in a
                          // second list — once it is on screen it is just a
                          // field.
                          ...(g.hidden || []).filter((d) => revealedFields.has(d.id)),
                        ]
                          // Back into GHL's authored order. Both halves came
                          // from one sorted list and were split by value, so
                          // re-sorting on `position` restores the order the
                          // form asked the questions in.
                          .sort((a, b) => a.position - b.position)
                          .map((def) => (
                          <div
                            className={`f${isWideField(def.dataType) ? " wide" : ""}`}
                            key={`c:${def.id}`}
                          >
                            {/* ITEM 2 — DISPLAY ONLY. `def.name` is still the
                                stored name and is still what the save payload,
                                the read-only blocklist and the folder matcher
                                use; only the text in this label is stripped.
                                `title` keeps the real name one hover away, so
                                anyone cross-referencing GoHighLevel's field
                                list can still find it. */}
                            <label title={def.name}>{fieldLabel(def.name)}</label>
                            <FieldControl
                              def={def}
                              value={cFields?.values[def.id]}
                              save={cSave[def.id]}
                              onSave={(val) => saveContactField(def, val)}
                              users={users}
                              isAdmin={isAdminViewer}
                              ssoBlob={sso.status === "ready" ? sso.blob : null}
                              onOptionAdded={applyNewOption}
                            />
                          </div>
                        ))}
                      </div>
                      {/* CLIENT ONLY — `hidden` is undefined on a caregiver
                          section, so this control simply is not there. The
                          empty fields are reachable rather than gone: a rep can
                          record something a lead said on the phone that the
                          form never asked. */}
                      {(g.hidden || []).some((d) => !revealedFields.has(d.id)) ? (
                        <div className="addfield">
                          <button
                            type="button"
                            className={`addfield-btn${addFieldOpen === g.key ? " on" : ""}`}
                            aria-expanded={addFieldOpen === g.key}
                            onClick={() =>
                              setAddFieldOpen((k) => (k === g.key ? "" : g.key))
                            }
                          >
                            {/* 🔴 SAY WHAT IT DOES. This read "+ Add a field",
                                which is the round-90 CREATE-A-FIELD flow's
                                name — and this control creates nothing. It
                                reveals a field that already exists in this
                                folder and happens to be empty on this record.
                                Someone reading "+ Add a field" reasonably
                                expects to be asked for a name and a type.
                                Round 78 built it as a reveal; only the label
                                had drifted. */}
                            Show{" "}
                            {(g.hidden || []).filter((d) => !revealedFields.has(d.id)).length}{" "}
                            empty field
                            {(g.hidden || []).filter((d) => !revealedFields.has(d.id))
                              .length === 1
                              ? ""
                              : "s"}
                          </button>
                          {addFieldOpen === g.key ? (
                            <div className="addfield-pop" role="listbox">
                              {(g.hidden || [])
                                .filter((d) => !revealedFields.has(d.id))
                                .map((d) => (
                                  <button
                                    key={d.id}
                                    type="button"
                                    role="option"
                                    aria-selected="false"
                                    title={d.name}
                                    onClick={() => {
                                      setRevealedFields((prev) =>
                                        new Set(prev).add(d.id),
                                      );
                                      setAddFieldOpen("");
                                    }}
                                  >
                                    {fieldLabel(d.name)}
                                  </button>
                                ))}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                      </>
                      ) : null}
                    </Fragment>
                    );
                  })}
                </>
              ) : null}

              {/* ── OPPORTUNITY ─────────────────────────────────────────────
                  Folder-driven field sections (Task 4), from the folders mapped
                  to this record's pipeline, in configured order.

                  ⚠️ NO has-a-value rule here. Pipeline scoping already keeps a
                  Private Pay card from carrying ODP milestones, and a rep FILLS
                  these as the case moves — hiding the empty ones would stop
                  them. See the branch comment in groupContactFields. */}
              {/* 🔴 THE DELIVERY HALF. checkPipelineConfig() in lib/ghl.ts has
                  computed this condition since the caregiver incident, and
                  console.warn'd it once per lambda where nobody would ever see
                  it. An unconfigured pipeline now SAYS SO, on the record, to
                  the person looking at it — and shows the Shared folder alone
                  rather than all twelve, because a missing field is a question
                  someone asks while a wrong one misleads quietly. */}
              {fieldGroups.unconfigured && isAdminViewer ? (
                <div className="pfunconf">
                  <b>This pipeline has no field sections configured.</b> Only
                  Shared is shown. Choose its sections under{" "}
                  <button type="button" onClick={() => setView("pipelines")}>
                    Admin → Pipelines
                  </button>
                  .
                </div>
              ) : null}
              {fieldGroups.sections.length || shownSections.size ? (
                <>
                  <div className="blockhead">Opportunity</div>
                  {[
                    ...fieldGroups.sections,
                    ...fieldGroups.available.filter((g) => shownSections.has(g.key)),
                  ].map((g) => (
                    <Fragment key={g.key}>
                      <div className="sechead">{g.label}</div>
                      <div className="grid">
                        {g.fields.map((def) => renderField(selected, def))}
                      </div>
                    </Fragment>
                  ))}
                </>
              ) : null}

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
                // ITEM 2 — decided by WHICH PAYLOAD the record came from, which
                // is exact: the caregiver scope is a different request against a
                // different pipeline set, and the two lists never merge.
                selfRole={
                  cgData.some((r) => r.id === selected.id)
                    ? "caregiver"
                    : "client"
                }
                // ITEM 1 — a POSITIVE signal, not `!cLoading`. `cLoading` is
                // still false on the first commit (the effect that sets it runs
                // in the same pass this child mounts in), so `!cLoading` read
                // TRUE at exactly the moment it needed to read false — measured:
                // the caregivers call still went out ahead of the contact
                // fields. This is true only once the fields have actually
                // resolved, one way or the other.
                panelReady={cFields !== null || cErr !== null}
              />

              {/* ⚠️ "SET AUTOMATICALLY", not "System info".
                  All four of these are written by something other than a rep —
                  Airtable Record ID by the migration, APP - Compliance Cleared
                  by WF3b, Transferred From/Date by the Move flow — so the
                  category is coherent and stays whole. But "System info" reads
                  as plumbing, and two of the four are the receiving rep's
                  answer to HOW A CASE LANDED ON THEM. Something to READ, just
                  not to edit.

                  🔴 The collapse is fine; the WHISPER was the problem. The
                  summary was 11px uppercase in --ink-3 on canvas grey, which is
                  the visual language of chrome — it said IGNORE THIS. It is now
                  legible: normal ink, normal size, still collapsed, still
                  last. */}
              {fieldGroups.systemInfo.length ? (
                <details className="sysinfo">
                  <summary>
                    Set automatically
                    <span className="sysinfo-n">
                      {fieldGroups.systemInfo.length}
                    </span>
                  </summary>
                  <div className="syshint">
                    Written by the system, not editable here.
                  </div>
                  <div className="grid">
                    {fieldGroups.systemInfo.map((def) => renderField(selected, def))}
                  </div>
                </details>
              ) : null}

              {/* ITEM 1 — THE SECTIONS THIS RECORD DID NOT ANSWER.
                  Pulled in WHOLE, never field by field: a rep filling
                  Milestones needs all ten in order.
                  ⚠️ Only folders TICKED for this pipeline are here — this is
                  about what is DRAWN, not what is ALLOWED. */}
              {fieldGroups.available.length ? (
                <div className="addsec">
                  <button
                    type="button"
                    className={`addsec-btn${addSecOpen ? " on" : ""}`}
                    aria-expanded={addSecOpen}
                    onClick={() => setAddSecOpen((v) => !v)}
                  >
                    + Add a section{" "}
                    <span className="addsec-n">({fieldGroups.available.length} available)</span>
                  </button>
                  {addSecOpen ? (
                    <div className="addsec-pop" role="listbox">
                      {fieldGroups.available.map((g) => (
                        <button
                          key={g.key}
                          type="button"
                          role="option"
                          aria-selected="false"
                          onClick={() => {
                            setShownSections((p2) => new Set([...p2, g.key]));
                            setAddSecOpen(false);
                          }}
                        >
                          {g.label}
                          <span>{g.fields.length}</span>
                        </button>
                      ))}
                      {/* ⚠️ SAY WHAT HAPPENS ON RELOAD. Same as the contact
                          rule: "has a value" is evaluated fresh every load, so
                          a section added and left empty is gone next time. */}
                      <div className="addsec-note">
                        Added sections stay until you reload. Fill something in
                        and the section keeps itself.
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* 🔴 NOT .sysinfo. These are not plumbing and not ours: they are
                  real fields somebody created that the dashboard has not been
                  told about yet. Filing them beside the Airtable Record ID,
                  under a heading meaning "we don't know what these are", hid
                  them AND said they did not matter — and a rep looking for
                  "what did this person ask for" would never open it.

                  ⚠️ NAMED WHERE GHL NAMES THEM. `parentName` is already in the
                  payload, so a folder created in GoHighLevel renders under its
                  own heading — "Website Intent Form" — rather than a generic
                  bucket. Only the genuinely unnameable fall back to the
                  generic heading. */}
              {fieldGroups.orphanGroups.map((g) => {
                // Open when it is short enough to read at a glance; collapsed
                // when it would push everything else off the screen. The count
                // is in the heading either way.
                const open = g.fields.length <= ORPHAN_OPEN_MAX;
                return (
                  <details className="unfiled" key={g.id || "none"} open={open}>
                    <summary>
                      {g.label}
                      {g.named ? (
                        <span className="unfiled-tag">not yet assigned</span>
                      ) : null}
                      <span className="unfiled-n">{g.fields.length}</span>
                    </summary>
                    {/* Same voice, same destination as the pipeline-level
                        notice — these are one failure at two scales. */}
                    {!isAdminViewer ? (
                      <div className="pfunconf">
                        This section is not configured yet, so its fields show
                        here rather than in their own place. An admin can fix
                        it.
                      </div>
                    ) : (
                      <div className="pfunconf">
                        {g.named ? (
                          <>
                            <b>{g.label}</b> is a section in GoHighLevel that
                            this pipeline has not been given.
                          </>
                        ) : (
                          <>
                            {/* 🔴 THEY ARE IN A SECTION. The dashboard has not
                                been told about it — which is a different thing
                                and the only one that is true. */}
                            <b>These fields are in a section the dashboard has
                            not been told about.</b>
                          </>
                        )}{" "}
                        {/* 🔴 A REAL LINK, NOT A DESCRIBED JOURNEY. This said
                            "Assign it under Admin → Pipelines", which names a
                            destination instead of offering it — there was no
                            way to act from where the problem is seen.
                            ⚠️ ADMIN ONLY. A rep cannot fix this, and a dead
                            link is worse than none, so they are told what is
                            wrong and who can fix it instead. */}
                        <button type="button" onClick={() => setView("pipelines")}>
                          Fix this in Admin → Pipelines
                        </button>
                      </div>
                    )}
                    <div className="grid">
                      {g.fields.map((def) => renderField(selected, def))}
                    </div>
                  </details>
                );
              })}
              <div className="sechead">Notes</div>
              <div>
                {notesLoading ? (
                  <div className="note">
                    <p className="muted">Loading notes…</p>
                  </div>
                ) : notesErr ? (
                  <div className="note">
                    <ErrorMessage error={notesErr} className="savemsg err" />
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
                              <ErrorMessage error={editErr} className="savemsg err" />
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
                <ErrorMessage error={editErr} className="savemsg err" style={{ marginTop: 6 }} />
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
                <ErrorMessage error={noteErr} className="savemsg err" style={{ marginTop: 6 }} />
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
