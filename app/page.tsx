"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "@/components/ErrorMessage";
import InlineName from "@/components/InlineName";
import { apiFetch, apiError } from "@/lib/apiFetch";
import { isAdminRole } from "@/lib/adminRole";
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
  Caregiver,
  EditableFieldDef,
} from "@/lib/types";
import { applyLinkChangeToCounts } from "@/lib/linkCounts";
import { useGhlSession, ssoResolved, ssoWaiting } from "@/lib/useGhlSession";
import ImportWizard from "@/components/ImportWizard";
import CaregiversSection from "@/components/CaregiversSection";
import PartnerName from "@/components/PartnerName";
import { BUILD, BUILD_LABEL } from "@/lib/build";
import {
  isOdpOnlyRecruiting,
  recruitingNouns,
  recruitingGroupOptions,
} from "@/lib/recruitingLabels";
import {
  stageAge,
  stageKpi,
  stageFunnel,
  timeInStage,
  speedToFirstMove,
  wonLost,
  rangeWindow,
  type StageAge,
  type StageKpiResult,
  type KpiRange,
  type KpiRecord,
} from "@/lib/stageKpi";
import EmailComposer from "@/components/EmailComposer";
import {
  groupFieldsForPipeline,
  groupContactFields,
  fieldLabel,
  hasValue,
} from "@/lib/fieldFolders";
import MoveDialog from "@/components/MoveDialog";
import SortDialog from "@/components/SortDialog";
import SortingTab, { type SortAction } from "@/components/SortingTab";
import {
  isNewLeadStage,
  isStaffingStage,
  isPickableStage,
  resolveLabels,
  labelProblem,
  stageDisplay,
  DEFAULT_LABELS,
  canSort as canSortRule,
  canAssignStaffing,
  canSendToStaffing,
  canPeerTransfer as canPeerTransferRule,
  type Viewer as SortViewer,
} from "@/lib/sorting";
import RecordFooter from "@/components/RecordFooter";
import TransferDialog from "@/components/TransferDialog";
import ReassignDialog from "@/components/ReassignDialog";
import UserPicker from "@/components/UserPicker";
import HybridPicker from "@/components/HybridPicker";
import ConfirmDialog from "@/components/ConfirmDialog";
import {
  toDateInput,
  formatGhlDate,
  hasTime,
  nameImpliesTime,
  formatEastern,
  formatEasternDay,
  formatEasternNoZone,
} from "@/lib/dates";
import {
  CREATED_RANGE_OPTIONS,
  createdWindow,
  inCreatedWindow,
  windowActive,
  describeWindow,
  easternDayKey,
  type CreatedRange,
} from "@/lib/createdRange";
import { byLatestActivity } from "@/lib/activity";

import "./filterbar.css";

import "./spacing.css";
import "./sorting.css";
import {
  parseQuery,
  indexRecord,
  matchesQuery,
  suggest,
  splitNames,
  type Indexed,
  type Suggestion,
} from "@/lib/smartSearch";
import { latestActivity } from "@/lib/activity";
import {
  EVERYONE,
  UNASSIGNED,
  matchesOwner,
  ownerNames as collectOwnerNames,
  ownerOptions,
  describeOwner,
} from "@/lib/owners";
import AddClientDialog from "@/components/AddClientDialog";
import PipelineAccessTab from "@/components/PipelineAccessTab";
import PipelineAdmin from "@/components/PipelineAdmin";
import AddCaregiverDialog from "@/components/AddCaregiverDialog";
import ReferralsSection, { type Payload as ReferralsPayload } from "@/components/ReferralsSection";
import ReferredBy from "@/components/ReferredBy";
import {
  REFERRING_PARTNER_FIELD,
  EVENT_HOST_FIELD_NAMES as EVENT_HOST_NAMES,
  EVENT_HOST_FIELD_ID,
} from "@/lib/referrals";
import { isUserIdListField } from "@/lib/editable";
import { divisionLabel } from "@/lib/division";
import {
  recruitingVisible,
  inGroup,
  recruitingModel,
  activeRecruitingPipeline,
  pickRecruitingPipeline,
  restoreRememberedCg,
  recruitingEmptyCause,
  RECRUITING_EMPTY_LINE,
  REMEMBERED_CG_KEY,
} from "@/lib/recruitingSidebar";
import {
  selectableFor,
  sidebarModel,
  pickClientPipeline,
  selectionAfterHide,
  restoreRemembered,
  REMEMBERED_ENTRY_KEY,
  RAIL_KEY,
} from "@/lib/clientSidebar";

const LOCATION_ID =
  process.env.NEXT_PUBLIC_GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X";

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

type ResFile = { id: string; name: string; url: string; type: string; size: number };
type ResSection = {
  id: string;
  name: string;
  isPublic?: boolean;
  failed?: boolean;
  files: ResFile[];
};

const clientName = (r: OpportunityRecord) => `${r.first} ${r.last}`.trim();

const enrollLabel = (r: OpportunityRecord) =>
  r.oppName || r.last || r.first || "Record";

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
  | "checked"

  | "created";

type CgSortKey = "applicant" | "stage" | "days" | "recruiter" | "pipeline";
const CG_COLUMNS: { key: CgSortKey; label: string }[] = [
  { key: "applicant", label: "Applicant" },
  { key: "stage", label: "Stage" },
  { key: "days", label: "Days in stage" },
  { key: "recruiter", label: "Recruiter" },
  { key: "pipeline", label: "Pipeline" },
];

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

  { key: "created", label: "Created" },
];

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

function MovesTable({
  rows,
  label,
}: {
  rows: { id: string; moves: number }[];
  label: (id: string) => string;
}) {
  if (!rows.length)
    return <div className="mvnone">No moves recorded in this period.</div>;
  const top = rows[0].moves || 1;
  return (
    <ol className="mvlist">
      {rows.map((row) => (
        <li key={row.id} className="mvrow">
          <span className="mvwho" title={label(row.id)}>
            {label(row.id).split(" — ")[0]}
          </span>
          <span className="mvbar" aria-hidden="true">
            <i style={{ width: `${Math.max(2, (row.moves / top) * 100)}%` }} />
          </span>
          <span className="mvn">{row.moves}</span>
        </li>
      ))}
    </ol>
  );
}

const IconMaster = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <rect x="3" y="4" width="18" height="16" rx="1" />
    <path d="M9 4v16M15 4v16M3 9h18" />
  </svg>
);

const IconMoves = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M3 21h18" />
    <rect x="5" y="13" width="4" height="6" rx="1" />
    <rect x="12" y="9" width="4" height="10" rx="1" />
    <rect x="19" y="5" width="4" height="14" rx="1" />
  </svg>
);
const IconPeople = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const IconShare = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
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

const SOURCE_ICONS: {
  match: (k: string) => boolean;
  label: string;
  art: React.ReactNode;
}[] = [
  {
    match: (k) => k.includes("facebook") || k.includes("meta") || k.includes("fb"),
    label: "Facebook",

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

    art: (
      <path
        fill="currentColor"
        d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2c1.2 0 2.6 1.9 3.1 5H8.9C9.4 6.9 10.8 5 12 5zM5.1 11h2.7c-.1 1.3-.1 2.7 0 4H5.1a7 7 0 0 1 0-4zm0 6h2.9c.4 1.6 1 2.9 1.7 3.7A7 7 0 0 1 5.1 17zm4.9 0h4c-.5 2.8-1.8 4.5-2 4.5s-1.5-1.7-2-4.5zm-.2-2a24 24 0 0 1 0-4h4.4a24 24 0 0 1 0 4zm6.2 2h2.9a7 7 0 0 1-4.6 3.7c.7-.8 1.3-2.1 1.7-3.7zm.3-2c.1-1.3.1-2.7 0-4h2.7a7 7 0 0 1 0 4zm1.6-6h-2.4c-.3-1.2-.8-2.3-1.3-3.1A7 7 0 0 1 17.9 9zM9.5 5.9C9 6.7 8.5 7.8 8.2 9H5.8a7 7 0 0 1 3.7-3.1z"
      />
    ),
  },
];

function srcKey(src: string): string {
  return (src || "").trim().toLowerCase();
}

function sourceIcon(src: string): { label: string; art: React.ReactNode } | null {
  const k = srcKey(src);
  if (!k) return null;
  return SOURCE_ICONS.find((x) => x.match(k)) || null;
}

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

const SourceMarkOrInitial = ({ src, small }: { src: string; small?: boolean }) => {
  const t = (src || "").trim();
  if (!t) return null;
  if (sourceIcon(t)) return <SourceMark src={t} small={small} />;
  return (
    <span
      className={small ? "srcmark srcunk sm" : "srcmark srcunk"}
      title={`Source: ${t}`}
      aria-label={`Source: ${t}`}
    >
      {t.charAt(0).toUpperCase()}
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

type SaveState =

  | { status: "saving" | "error" | "warn"; err?: unknown }
  | undefined;

const NAME_KEY = "__contactName";

const PHONE_KEY = "__contactPhone";
const EMAIL_KEY = "__contactEmail";

function ReachScope({ count }: { count?: number }) {
  return (
    <>
      <b>About this person, not this case.</b>{" "}
      {count && count > 1
        ? `This shows on all ${count} of their records.`
        : "This follows them onto every record they hold."}
    </>
  );
}

const isWideField = (dt: string): boolean =>
  ["MULTIPLE_OPTIONS", "LARGE_TEXT"].includes((dt || "").toUpperCase());

const asStr = (v: unknown): string =>
  Array.isArray(v) ? v.map(String).join(", ") : v == null ? "" : String(v);
const asArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)];

const REL_COUNTS_TIMEOUT_MS = 20_000;

const asUserNames = (
  v: unknown,
  users: { id: string; name: string }[],
): string =>
  asStr(v)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((id) => users.find((u) => u.id === id)?.name || "Former user")
    .join(", ");

const asDate = (v: unknown): string => toDateInput(v);

const asDateText = (v: unknown, _def?: { name?: string }): string =>
  formatGhlDate(v, { withTime: hasTime(v) });

type DimKind =
  | "single"
  | "multi"
  | "text"
  | "date"
  | "number"
  | "stage"
  | "owner";
interface Dim {
  key: string;
  label: string;
  kind: DimKind;
  sortable: boolean;
  groupable: boolean;
}

function recordStr(r: OpportunityRecord, key: string): string {
  if (key.startsWith("cf:")) return asStr(r.cf[key.slice(3)]);
  switch (key) {
    case "native:stage":
    case "stage":
      return r.stage;

    case "native:created":
    case "created":
      return r.createdAt || "";
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

const isSensitiveField = (name: string): boolean =>
  /social\s*security|(^|\W)ssn(\W|$)/i.test(name || "");

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

    if (sensitive)
      return (
        <MaskedControl value={value} disabled onSave={() => {}} />
      );

    return (
      <div className="v ro">
        {(t === "DATE"
          ? asDateText(value, def)
          : isUserIdListField(def.name)
            ? asUserNames(value, users)
            : asStr(value)) || "—"}{" "}
        <span className="readonly-note">read-only</span>
      </div>
    );
  }

  const isOptionType =
    t === "SINGLE_OPTIONS" || t === "MULTIPLE_OPTIONS" || t === "CHECKBOX";

  let control: ReactNode;
  if (sensitive) {

    control = (
      <MaskedControl value={value} disabled={disabled} onSave={onSave} />
    );
  } else if (isPeopleField(def.name) && isOptionType) {

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

    control = (
      <>
        <TextControl
          value={value}
          type="date"
          disabled={disabled}
          onSave={onSave}
        />

        {asDateText(value, def) ? (
          <div className="datehint">{asDateText(value, def)}</div>
        ) : null}

        {nameImpliesTime(def.name) ? (
          {}
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
      ) : save?.status === "warn" ? (

        <div className="savewarn">
          {(() => {
            const w = save.err as { error?: string; detail?: string } | undefined;
            return (
              <>
                <b>{w?.error || "Saved with a difference."}</b>
                {w?.detail ? <> {w.detail}</> : null}
              </>
            );
          })()}
        </div>
      ) : null}
    </>
  );
}

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

  saving?: "saving" | "error" | "warn";

  relBadge?: string;
}) {
  return (
    <>
      <div className="cn">
        {r.oppName || `${r.first} ${r.last}`.trim() || "—"}

        {r.newLead ? (
          <span className="newlead-tag" title="Nobody has opened this lead yet — it clears for everyone once someone does">
            New lead
          </span>
        ) : null}
        {following ? (
          <span
            className="follow-tag"
            title="You follow this record (you're not the owner)"
          >
            Following
          </span>
        ) : null}

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

      {formatEastern(r.createdAt) ? (
        <div className="ccreated">Created {formatEastern(r.createdAt)}</div>
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

  saving?: "saving" | "error" | "warn";
  relBadge?: string;
  onOpen: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: r.id,
    disabled: !canDrag,
  });

  return (
    <div
      ref={setNodeRef}

      data-cid={r.contactId || undefined}
      className={`card${canDrag ? " draggable" : " nodrag"}${
        isDragging ? " ghost" : ""
      }`}
      onClick={onOpen}

      {...(canDrag ? listeners : {})}
      {...(canDrag ? attributes : {})}
    >
      <CardBody r={r} following={following} saving={saving} relBadge={relBadge} />
    </div>
  );
}

function ResCard({
  f,
  kind,
  onPreview,
  onDelete,
}: {
  f: ResFile;
  kind: "pdf" | "image" | null;
  onPreview: () => void;

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

type MasterCatId =
  | "new"
  | "enrollment"
  | "transfer"
  | "reassign"
  | "sentout"
  | "other";

export const REASSIGN_STAGE = "REASSIGN";

const isReassignStage = (name: string) =>
  (name || "").trim().toUpperCase() === REASSIGN_STAGE;
const isReassignRec = (r: OpportunityRecord) => isReassignStage(r.stage);

export const LOST_STAGE_NAME = "LOST";
const isLostStage = (name: string) =>
  (name || "").trim().toUpperCase() === LOST_STAGE_NAME;

const REASSIGN_TAG_PREFIX = "reassigned-from-";
const wasReassigned = (r: OpportunityRecord): boolean =>
  r.tags.some((t) => t.toLowerCase().startsWith(REASSIGN_TAG_PREFIX));

const isSentOutRec = (r: OpportunityRecord, hasTransferStamp: boolean) =>
  hasTransferStamp && !!r.ownerId && !isReassignStage(r.stage);
const isNewLeadRec = (r: OpportunityRecord) =>
  (r.stage || "").trim().toUpperCase() === "NEW LEAD" && !r.ownerId;

const PRIVATE_PAY_PIPELINE_ID =
  process.env.NEXT_PUBLIC_PRIVATE_PAY_PIPELINE_ID || "BJBWdRim6SOgjoMelVSZ";
const isEnrollmentPipe = (name: string) => /enroll/i.test(name);

const isEnrollmentPipeline = (p: { id: string; name: string }) =>
  isEnrollmentPipe(p.name) || p.id === PRIVATE_PAY_PIPELINE_ID;
const isTransferPipe = (name: string) => /transfer/i.test(name);

function masterCategory(
  r: OpportunityRecord,
  hasTransferStamp: boolean,
): MasterCatId {

  if (isReassignRec(r)) return "reassign";
  if (isNewLeadRec(r)) return "new";

  if (isSentOutRec(r, hasTransferStamp)) return "sentout";
  if (isEnrollmentPipeline({ id: r.pipelineId, name: r.pipelineName }))
    return "enrollment";

  if (isTransferPipe(r.pipelineName)) return "transfer";

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

    droppable: false,
  },
];

function daysInStage(
  r: OpportunityRecord,
  historyFieldId: string | null,
): number | null {
  return stageAge(r, historyFieldId, Date.now())?.days ?? null;
}

type SearchChip = { key: string; label: string; onRemove: () => void };

function tallyPeople(rows: OpportunityRecord[]) {
  const cms = new Map<string, { name: string; n: number }>();
  const offs = new Map<string, number>();
  for (const r of rows) {
    for (const n of splitNames(r.cm)) {
      const k = n.toLowerCase();
      const hit = cms.get(k);
      if (hit) hit.n++;
      else cms.set(k, { name: n, n: 1 });
    }
    if (r.office) offs.set(r.office, (offs.get(r.office) || 0) + 1);
  }
  return {
    caseManagers: [...cms.values()],
    offices: [...offs.entries()].map(([name, n]) => ({ name, n })),
  };
}

function SearchBox({
  which,
  value,
  onChange,
  placeholder,
  chips = [],
  suggestions = [],
  onPick,
  leadsLabel = "Leads",
}: {
  which: "clients" | "master" | "recruiting" | "sorting";
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  chips?: SearchChip[];
  suggestions?: Suggestion[];
  onPick?: (s: Suggestion) => void;
  leadsLabel?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  useEffect(() => setActive(-1), [value]);
  const show = open && value.trim() !== "" && suggestions.length > 0;
  const pick = (sg: Suggestion) => {
    onPick?.(sg);
    setOpen(false);
    setActive(-1);
  };
  const group = (k: Suggestion["kind"]) =>
    k === "record"
      ? leadsLabel
      : k === "office"
        ? "Offices"
        : k === "pipeline"
          ? "Pipelines"
          : k === "source"
            ? "Sources"
            : "People";
  const listId = `${which}-suggestions`;
  return (
    <div className="search smartsearch">
      <IconSearch />
      {chips.map((c) => (
        <span key={c.key} className="searchchip">
          {c.label}
          <button
            type="button"
            aria-label={`Remove ${c.label}`}
            onClick={() => {
              c.onRemove();
              ref.current?.focus();
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        ref={ref}
        data-search={which}
        placeholder={chips.length ? "Search within…" : placeholder}
        value={value}
        title="Press / to jump here · ↑ ↓ and Enter pick a suggestion · Esc clears"
        role="combobox"
        aria-expanded={show}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={show && active >= 0 ? `${listId}-${active}` : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && suggestions.length) {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, suggestions.length - 1));
          } else if (e.key === "ArrowUp" && show) {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, -1));
          } else if (e.key === "Enter" && show && active >= 0) {
            e.preventDefault();
            pick(suggestions[active]);
          } else if (e.key === "Escape" && show) {
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          } else if (e.key === "Backspace" && !value && chips.length) {
            chips[chips.length - 1].onRemove();
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="searchclear"
          aria-label="Clear search"
          title="Clear search (Esc)"
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
        >
          ×
        </button>
      ) : null}
      {show ? (
        <div id={listId} role="listbox" className="sugg">
          {suggestions.map((sg, i) => (
            <Fragment key={`${sg.kind}:${sg.value}`}>
              {i === 0 || group(suggestions[i - 1].kind) !== group(sg.kind) ? (
                <div className="sugghead">{group(sg.kind)}</div>
              ) : null}
              <div
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`suggrow${i === active ? " on" : ""}`}

                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(sg);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="sugglabel">{sg.label}</span>
                <span className="suggdetail">{sg.detail}</span>
              </div>
            </Fragment>
          ))}
          <div className="suggfoot">↑ ↓ to move · Enter to pick · Esc to close</div>
        </div>
      ) : null}
    </div>
  );
}

function useEasternToday(): string {
  const [key, setKey] = useState(() => easternDayKey(new Date()));
  useEffect(() => {
    const tick = () => {
      const now = easternDayKey(new Date());
      if (now) setKey((k) => (k === now ? k : now));
    };
    const t = setInterval(tick, 60_000);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return key;
}

function CreatedFilter({
  id,
  range,
  onRange,
  from,
  onFrom,
  to,
  onTo,
  undated,
}: {
  id: string;
  range: CreatedRange;
  onRange: (r: CreatedRange) => void;
  from: string;
  onFrom: (v: string) => void;
  to: string;
  onTo: (v: string) => void;
  undated: number;
}) {
  return (
    <div className="officefilter createdfilter">
      <label htmlFor={id}>Created</label>
      <select
        id={id}
        className={range !== "all" ? "on" : undefined}
        value={range}
        onChange={(e) => onRange(e.target.value as CreatedRange)}
      >
        {CREATED_RANGE_OPTIONS.map(([k, label]) => (
          <option key={k} value={k}>
            {label}
          </option>
        ))}
      </select>
      {range === "custom" ? (

        <span className="createdrange">
          <input
            type="date"
            aria-label="Created from"
            value={from}
            onChange={(e) => onFrom(e.target.value)}
          />
          <span className="createdto" aria-hidden="true">
            →
          </span>
          <input
            type="date"
            aria-label="Created to"
            value={to}
            onChange={(e) => onTo(e.target.value)}
          />
        </span>
      ) : null}
      {undated ? (
        <span className="createdundated" title="These records carry no created date, so a date filter cannot place them.">
          {undated} with no date not shown
        </span>
      ) : null}
    </div>
  );
}

function MasterCard({
  r,
  following,
  relBadge,
  canDrag,
  onOpen,
  from,
  age,
}: {
  r: OpportunityRecord;
  following: boolean;
  relBadge?: string;
  canDrag: boolean;
  onOpen: () => void;

  from?: string;

  age?: StageAge | null;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `m:${r.id}`,
    disabled: !canDrag,
  });
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

        {r.newLead ? (
          <span className="newlead-tag" title="Nobody has opened this lead yet — it clears for everyone once someone does">
            New lead
          </span>
        ) : null}
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
        {stageDisplay(r.stage || "—", DEFAULT_LABELS)}

        {age ? (
          <span
            className={`mage${age.days >= 14 ? " stale" : ""}${
              age.source === "ghl" ? " approx" : ""
            }`}
            title={
              age.source === "history"
                ? `Days since this record last changed stage — recorded at the move (${formatEasternDay(age.at)})`
                : "Days since GoHighLevel's stage date, which a bulk edit can move without the record moving. Not recorded by this dashboard."
            }
          >
            {age.source === "ghl" ? "~" : ""}
            {age.days}d
          </span>
        ) : null}
      </div>

      {from ? (
        <div
          className={`mfrom${wasReassigned(r) ? " reassigned" : ""}`}
          title={
            wasReassigned(r)
              ? `Came through Staffing needed (Reassign) from ${from} — given up by that division, then assigned here. Route read from the contact's reassign tag; tags are contact-scoped, so a contact reassigned once keeps the tag.`
              : `Transferred from ${from} — handed straight to a new owner.`
          }
        >
          ← {wasReassigned(r) ? "Reassigned" : "Transferred"} from {from}
        </div>
      ) : null}
      <div className="cf">

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

function MasterColumn({
  cat,
  count,
  droppable,
  children,
  staffingLabel,
}: {
  cat: MasterCatId;
  count: number;
  droppable: boolean;
  children: ReactNode;

  staffingLabel?: string;
}) {

  const { setNodeRef, isOver } = useDroppable({ id: `mcol:${cat}` });
  const def = MASTER_COLUMNS.find((c) => c.id === cat);
  return (
    <div
      ref={setNodeRef}
      className={`col mcol${isOver && droppable ? " dropover" : ""}`}
    >
      <div className="colhead" title={def?.hint}>
        <span>{cat === "reassign" && staffingLabel ? staffingLabel : def?.label ?? cat}</span>

        <span className="pill">{count}</span>
      </div>
      <div className="colbody">{children}</div>
    </div>
  );
}

const ORPHAN_OPEN_MAX = 8;

const SERVER_NO_SSO = "no SSO session was provided";

function honestAuthError(
  body: ApiError | null,
  status: number,
  hadBlob: boolean,
): ApiError {
  const fallback: ApiError = {
    error: `Request failed with status ${status}.`,
  };
  const err = body ?? fallback;
  if (!hadBlob || status !== 401) return err;
  if (!(err.detail || "").includes(SERVER_NO_SSO)) return err;
  return {
    ...err,
    error: "GoHighLevel didn't accept this session.",
    detail:
      "Your sign-in was sent with this request and the dashboard server did not receive it. " +
      "This is a configuration problem on our side, not something you can fix by signing in again — " +
      "reload once, and if it persists it needs to be reported.",
  };
}

const SHOW_ALL_CLIENTS = false;

export default function Dashboard() {

  const sso = useGhlSession();

  const [data, setData] = useState<OpportunityRecord[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  const [fieldDefs, setFieldDefs] = useState<EditableFieldDef[]>([]);

  const [pipelineFolders, setPipelineFolders] = useState<
    Record<string, string[]> | undefined
  >(undefined);
  const [folderNames, setFolderNames] = useState<Record<string, string>>({});

  const [pipelineExclusions, setPipelineExclusions] = useState<
    Record<string, string[]> | undefined
  >(undefined);

  const [shownSections, setShownSections] = useState<Set<string>>(new Set());
  const [addSecOpen, setAddSecOpen] = useState(false);
  const [addCgOpen, setAddCgOpen] = useState(false);

  const [cFields, setCFields] = useState<{
    defs: EditableFieldDef[];
    values: Record<string, unknown>;
    version: string;
    opportunityCount: number;

    firstName: string;
    lastName: string;

    email: string;
    phone: string;
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

  const [homePipelineIds, setHomePipelineIds] = useState<string[]>([]);
  const [scope, setScope] = useState<string>("all");
  const [adminPipeline, setAdminPipeline] = useState<string>("all");

  const [pipelineSidebarHidden, setPipelineSidebarHidden] = useState<
    Record<string, true> | undefined
  >(undefined);

  const [railPref, setRailPref] = useState<"collapsed" | "expanded">("expanded");
  const [railNarrow, setRailNarrow] = useState(false);

  const [clientSettled, setClientSettled] = useState(false);

  const [pipelines, setPipelines] = useState<{ id: string; name: string }[]>([]);
  const [stagesByPipeline, setStagesByPipeline] = useState<
    Record<string, { id: string; name: string }[]>
  >({});
  const [moveOpen, setMoveOpen] = useState(false);

  const [stage, setStage] = useState<string>("all");
  const [office, setOffice] = useState<string>("all");

  const [createdRange, setCreatedRange] = useState<CreatedRange>("all");
  const [createdFrom, setCreatedFrom] = useState("");
  const [createdTo, setCreatedTo] = useState("");

  const [masterCreatedRange, setMasterCreatedRange] = useState<CreatedRange>("all");
  const [masterCreatedFrom, setMasterCreatedFrom] = useState("");
  const [masterCreatedTo, setMasterCreatedTo] = useState("");
  const [cgCreatedRange, setCgCreatedRange] = useState<CreatedRange>("all");
  const [cgCreatedFrom, setCgCreatedFrom] = useState("");
  const [cgCreatedTo, setCgCreatedTo] = useState("");

  const todayKey = useEasternToday();

  const [ownerF, setOwnerF] = useState<string>(EVERYONE);
  const [cgOwnerF, setCgOwnerF] = useState<string>(EVERYONE);

  const [cmF, setCmF] = useState<string>("");

  const [srcF, setSrcF] = useState<string>("all");
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [groupKey, setGroupKey] = useState<string | null>(null);

  const [view, setView] = useState<
    | "list"
    | "board"
    | "master"
    | "kpi"
    | "resources"
    | "import"
    | "access"
    | "pipelines"
    | "caregivers"
    | "referrals"
  >("board");

  const [refReload, setRefReload] = useState(0);
  const [refBusy, setRefBusy] = useState(false);

  const refCache = useRef<ReferralsPayload | null>(null);

  const [delRec, setDelRec] = useState<OpportunityRecord | null>(null);

  const [transferRec, setTransferRec] = useState<OpportunityRecord | null>(null);
  const [peerInfo, setPeerInfo] = useState<{ configured: boolean; label: string } | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState<unknown>(null);

  const rememberReferrals = useCallback((p: ReferralsPayload) => {
    refCache.current = p;
  }, []);
  const [selId, setSelId] = useState<string | null>(null);

  const [clientFocus, setClientFocus] = useState<{
    kind: "office" | "rep" | "blocked" | "checked";
    value?: string;
  } | null>(null);
  const [masterFocus, setMasterFocus] = useState<{
    kind: "pipeline" | "owner" | "source" | "status" | "blocked" | "shared" | "stalled";
    value?: string;
  } | null>(null);
  const [cgFocus, setCgFocus] = useState<{
    kind: "stage" | "recruiter" | "source" | "stalled";
    value?: string;
  } | null>(null);

  const [canSeeMaster, setCanSeeMaster] = useState(false);

  const [sortTab, setSortTab] = useState<"newleads" | "staffing" | null>("newleads");
  const [renaming, setRenaming] = useState<{ key: string; value: string; err: string | null; busy: boolean } | null>(null);

  const [sortView, setSortViewRaw] = useState<"list" | "board">("list");
  const setSortView = (v: "list" | "board") => {
    setSortViewRaw(v);
    try {
      window.localStorage.setItem("mm.sortView", v);
    } catch {

    }
  };
  useEffect(() => {
    try {
      if (window.localStorage.getItem("mm.sortView") === "board") setSortViewRaw("board");
    } catch {

    }
  }, []);
  const [viewerStaffing, setViewerStaffing] = useState<"admin" | "any" | "self" | "off">("off");
  const [viewerPeer, setViewerPeer] = useState(false);
  const [tabLabelsRaw, setTabLabelsRawState] = useState<Record<string, string>>({});

  const [tabLabelsKnown, setTabLabelsKnown] = useState(false);
  const setTabLabelsRaw = (l: Record<string, string>) => {
    setTabLabelsRawState(l);
    setTabLabelsKnown(true);
  };
  const [sortTargets, setSortTargets] = useState<{ id: string; name: string }[]>([]);
  const [sortReq, setSortReq] = useState<{
    record: OpportunityRecord;
    mode: "sort" | "assign";
    target?: "enroll" | "transfer";
  } | null>(null);
  const [staffRec, setStaffRec] = useState<OpportunityRecord | null>(null);

  const [failedPipelines, setFailedPipelines] = useState<
    { id: string; name: string; error: string }[]
  >([]);

  const [cgData, setCgData] = useState<OpportunityRecord[]>([]);
  const [cgPipelines, setCgPipelines] = useState<{ id: string; name: string }[]>([]);

  const [cgGroup, setCgGroup] = useState<"caregiver" | "staff" | "all">("caregiver");
  const [cgGroupOpen, setCgGroupOpen] = useState(false);

  const cgOdpOnly = useMemo(
    () => isOdpOnlyRecruiting(cgPipelines.map((p) => p.name)),
    [cgPipelines],
  );
  const cgNoun = useMemo(
    () => recruitingNouns(cgGroup, cgOdpOnly),
    [cgGroup, cgOdpOnly],
  );

  const cgCount = useCallback(
    (n: number) => `${n} ${n === 1 ? cgNoun.one : cgNoun.many}`,
    [cgNoun],
  );

  const [pipelineGroups, setPipelineGroups] = useState<Record<string, "caregiver" | "staff">>({});
  const [cgStagesByPipeline, setCgStagesByPipeline] = useState<
    Record<string, { id: string; name: string }[]>
  >({});
  const [cgHomeIds, setCgHomeIds] = useState<string[]>([]);

  const [cgPipelinesWithheld, setCgPipelinesWithheld] = useState(0);
  const [cgLoading, setCgLoading] = useState(false);
  const [cgErr, setCgErr] = useState<ApiError | null>(null);
  const [cgLoaded, setCgLoaded] = useState(false);

  const cgTried = useRef(false);
  const [cgPipeline, setCgPipeline] = useState<string>("all");

  const [cgSidebarHidden, setCgSidebarHidden] = useState<Record<string, true> | undefined>(
    undefined,
  );

  const [cgFailedPipelines, setCgFailedPipelines] = useState<
    { id: string; name: string; error: string }[]
  >([]);
  const [cgQuery, setCgQuery] = useState("");

  const [cgView, setCgView] = useState<"list" | "board" | "resources">("board");
  const [cgStage, setCgStage] = useState<string | null>(null);
  const [cgSortKey, setCgSortKey] = useState<string | null>(null);
  const [cgSortDir, setCgSortDir] = useState<"asc" | "desc">("asc");
  const [cgGroupKey, setCgGroupKey] = useState<string | null>(null);

  const [masterDrop, setMasterDrop] = useState<{
    record: OpportunityRecord;
    cat: MasterCatId;
  } | null>(null);

  const [dropRefused, setDropRefused] = useState<string | null>(null);

  const [dragSaveId, setDragSaveId] = useState<string | null>(null);

  const [resources, setResources] = useState<ResFile[]>([]);

  const [resSections, setResSections] = useState<ResSection[]>([]);
  const [canManageFolders, setCanManageFolders] = useState(false);
  const [uploadFolder, setUploadFolder] = useState<string>("");
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderErr, setFolderErr] = useState<unknown>(null);

  const [delFolder, setDelFolder] = useState<{
    id: string;
    name: string;
    fileCount: number;
  } | null>(null);

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

  const [notes, setNotes] = useState<Record<string, Note[]>>({});
  const [noteDraft, setNoteDraft] = useState("");

  const [addOpen, setAddOpen] = useState(false);

  const [relCounts, setRelCounts] = useState<RelationCounts>({});

  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState<unknown>(null);

  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesErr, setNotesErr] = useState<unknown>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteErr, setNoteErr] = useState<unknown>(null);

  const ssoRef = useRef(sso);
  ssoRef.current = sso;

  const loadSeq = useRef(0);
  const cgSeq = useRef(0);
  const resSeq = useRef(0);

  const load = useCallback(async () => {

    const seq = ++loadSeq.current;
    const isCurrent = () => seq === loadSeq.current;

    setLoading(true);
    setError(null);
    try {

      const s = ssoRef.current;
      const res = s.blob
        ? await fetch("/api/opportunities", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ssoKey: s.blob }),
            cache: "no-store",
          })
        : await fetch("/api/opportunities", { cache: "no-store" });
      if (!isCurrent()) return;
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as ApiError | null;
        if (!isCurrent()) return;

        setError(honestAuthError(body, res.status, !!s.blob));
        return;
      }
      const body = (await res.json()) as OpportunitiesResponse;
      if (!isCurrent()) return;

      setError(null);
      setData(body.records || []);
      if (body.fieldDefs) setFieldDefs(body.fieldDefs);
      if (body.pipelineFolders) setPipelineFolders(body.pipelineFolders);

      if (body.pipelineFolders) setPipelineExclusions(body.pipelineExclusions || {});
      setFolderNames(body.folderNames || {});
      if (body.stages) setPipelineStages(body.stages);
      if (body.users) setUsers(body.users);
      if (body.peer) setPeerInfo(body.peer);
      if (body.pipelines) setPipelines(body.pipelines);
      if (body.stagesByPipeline) setStagesByPipeline(body.stagesByPipeline);
      if (body.viewer?.homePipelineIds)
        setHomePipelineIds(body.viewer.homePipelineIds);
      setCanSeeMaster(!!body.viewer?.canSeeMaster);
      setViewerStaffing(body.viewer?.staffing ?? (body.viewer?.isAdmin ? "admin" : "off"));
      setViewerPeer(!!body.viewer?.canPeerTransfer);
      if (body.tabLabels) setTabLabelsRaw(body.tabLabels);
      if (body.sortTargets) setSortTargets(body.sortTargets);
      setFailedPipelines(body.failedPipelines || []);

      setPipelineSidebarHidden(body.pipelineSidebarHidden);
    } catch (e) {
      if (!isCurrent()) return;
      setError({
        error: "Could not reach the dashboard API.",
        detail: e instanceof Error ? e.message : String(e),
      });

    } finally {
      if (isCurrent()) {
        setLoading(false);
        setClientSettled(true);
      }
    }

  }, []);

  useEffect(() => {

    if (!ssoResolved(sso)) return;
    load();
  }, [sso.status, sso.blob, load]);

  const deleteRecord = useCallback(async () => {
    const rec = delRec;
    if (!rec) return;
    setDelBusy(true);
    setDelErr(null);
    try {
      const res = await fetch(`/api/opportunities/${encodeURIComponent(rec.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ssoKey: ssoRef.current.blob ?? undefined }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean } | ApiError;
      if (!res.ok) throw apiError(res, j);
      setData((d) => d.filter((r) => r.id !== rec.id));
      setCgData((d) => d.filter((r) => r.id !== rec.id));
      setSelId(null);
      setDelRec(null);
    } catch (e) {
      setDelErr(e);
    } finally {
      setDelBusy(false);
    }
  }, [delRec]);

  const loadCaregivers = useCallback(async () => {

    const seq = ++cgSeq.current;
    const isCurrent = () => seq === cgSeq.current;

    setCgLoading(true);
    setCgErr(null);
    try {

      const s = ssoRef.current;
      const res = s.blob
        ? await fetch("/api/opportunities?scope=caregiver", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ssoKey: s.blob }),
            cache: "no-store",
          })
        : await fetch("/api/opportunities?scope=caregiver", { cache: "no-store" });
      const body = (await res.json().catch(() => ({}))) as
        | OpportunitiesResponse
        | ApiError;
      if (!isCurrent()) return;
      if (!res.ok) {
        setCgErr(honestAuthError(body as ApiError, res.status, !!s.blob));

        return;
      }
      const b = body as OpportunitiesResponse;
      setCgErr(null);
      setCgData(b.records || []);
      setCgPipelines(b.pipelines || []);
      setCgStagesByPipeline(b.stagesByPipeline || {});
      setCgHomeIds(b.viewer?.homePipelineIds || []);
      setCgPipelinesWithheld(b.pipelinesWithheld || 0);
      if (b.pipelineGroups) setPipelineGroups(b.pipelineGroups);

      setCgSidebarHidden(b.pipelineSidebarHidden);
      setCgFailedPipelines(b.failedPipelines || []);
      setCgLoaded(true);
    } catch (e) {
      if (!isCurrent()) return;
      setCgErr({
        error: "Could not reach the dashboard API.",
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (!isCurrent()) return;
      setCgLoading(false);

      cgTried.current = true;
    }

  }, []);

  useEffect(() => {
    if (
      (clientSettled || view === "caregivers") &&
      !cgLoaded &&
      !cgTried.current &&

      !cgLoading &&
      ssoResolved(sso)
    )
      loadCaregivers();
  }, [view, clientSettled, cgLoaded, cgLoading, sso.status, sso.blob, loadCaregivers]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-esc-local]")) return;
      setSelId(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const box = Array.from(document.querySelectorAll<HTMLInputElement>("input[data-search]")).find(
        (el) => el.offsetParent !== null,
      );
      if (!box) return;
      e.preventDefault();
      box.focus();
      box.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setEmailOpen(false);
    setMoveOpen(false);
  }, [selId]);

  const loadResources = useCallback(async () => {
    const seq = ++resSeq.current;
    const isCurrent = () => seq === resSeq.current;

    setResLoading(true);
    setResErr(null);
    try {
      const headers: Record<string, string> = {};

      const s = ssoRef.current;
      if (s.blob) headers["x-ghl-sso-key"] = s.blob;
      const res = await fetch("/api/resources", { headers, cache: "no-store" });
      const j = (await res.json().catch(() => ({}))) as {
        resources?: ResFile[];
        sections?: ResSection[];
        canManageFolders?: boolean;
        error?: string;
        detail?: string;
      };
      if (!isCurrent()) return;
      if (!res.ok) throw apiError(res, j);

      setResErr(null);
      setResources(j.resources || []);
      const secs = j.sections || [];
      setResSections(secs);
      setCanManageFolders(!!j.canManageFolders);

      setUploadFolder((cur) =>
        cur && secs.some((s) => s.id === cur) ? cur : (secs[0]?.id ?? ""),
      );
      setResLoaded(true);
    } catch (e) {
      if (!isCurrent()) return;

      setResErr(e);
    } finally {
      if (isCurrent()) setResLoading(false);
    }
  }, []);

  const resourcesOpen =
    view === "resources" || (view === "caregivers" && cgView === "resources");
  useEffect(() => {
    if (resourcesOpen && !resLoaded && ssoResolved(sso))
      loadResources();
  }, [resourcesOpen, resLoaded, sso.status, sso.blob, loadResources]);

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
        if (sso.blob) headers["x-ghl-sso-key"] = sso.blob;
        const fd = new FormData();
        fd.append("file", file);

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
        setResLoaded(false);
        await loadResources();
      } catch (e) {
        setUploadMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setUploading(false);
      }
    },
    [sso, loadResources, uploadFolder, resSections],
  );

  const createFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setFolderBusy(true);
    setFolderErr(null);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (sso.blob) headers["x-ghl-sso-key"] = sso.blob;
      const res = await fetch("/api/resources/folders", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ssoKey: sso.blob ?? undefined,
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

  const askDeleteFolder = useCallback(
    async (id: string, name: string) => {
      setFolderErr(null);
      try {
        const headers: Record<string, string> = {};
        if (sso.blob) headers["x-ghl-sso-key"] = sso.blob;
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
      if (sso.blob) headers["x-ghl-sso-key"] = sso.blob;
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
      if (sso.blob) headers["x-ghl-sso-key"] = sso.blob;
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
      return null;
    },
    [],
  );

  const visibleResources = useMemo(() => {
    const t = resQuery.trim().toLowerCase();
    if (!t) return resources;
    return resources.filter((f) => f.name.toLowerCase().includes(t));
  }, [resources, resQuery]);

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

  useEffect(() => {
    if (!selId || !ssoResolved(sso)) return;
    let cancelled = false;
    setNotesLoading(true);
    setNotesErr(null);
    setNoteErr(null);
    const headers: Record<string, string> = {};
    if (sso.blob) headers["x-ghl-sso-key"] = sso.blob;
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

            [selId]: j.notes || [],
          }));
        if (!cancelled) setNotesErr(null);
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
  }, [selId, sso.status, sso.blob]);

  const markedOpen = useRef<Set<string>>(new Set());
  useEffect(() => {

    const stale = (list: OpportunityRecord[]) => list.some((x) => x.newLead && markedOpen.current.has(x.id));
    const unstale = (prev: OpportunityRecord[]) =>
      prev.map((x) => (x.newLead && markedOpen.current.has(x.id) ? { ...x, newLead: false } : x));
    if (stale(data) || stale(cgData)) {
      if (stale(data)) setData(unstale);
      if (stale(cgData)) setCgData(unstale);
      return;
    }
    if (!selId || !ssoResolved(sso)) return;
    const inClients = data.some((x) => x.id === selId);
    const r = (inClients ? data : cgData).find((x) => x.id === selId);
    if (!r?.newLead || markedOpen.current.has(selId)) return;
    const id = selId;
    const setList = inClients ? setData : setCgData;
    markedOpen.current.add(id);
    setList((prev) => prev.map((x) => (x.id === id ? { ...x, newLead: false } : x)));
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (sso.blob) headers["x-ghl-sso-key"] = sso.blob;
    fetch(`/api/opportunities/${encodeURIComponent(id)}/opened`, {
      method: "POST",
      headers,
      body: "{}",
      cache: "no-store",
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      })
      .catch(() => {
        markedOpen.current.delete(id);
        setList((prev) => prev.map((x) => (x.id === id ? { ...x, newLead: true } : x)));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId, sso.status, sso.blob, data, cgData]);

  const isAdminViewer =
    sso.status === "none" ||
    (sso.status === "ready" && isAdminRole(sso.session.role));

  const viewerId = sso.status === "ready" ? sso.session.userId : null;
  const followsNotOwns = (r: OpportunityRecord) =>
    !!viewerId && r.ownerId !== viewerId && r.followerIds.includes(viewerId);

  const tabLabels = useMemo(() => resolveLabels(tabLabelsRaw), [tabLabelsRaw]);
  const sortViewer: SortViewer = useMemo(
    () => ({
      userId: viewerId || "",
      isAdmin: isAdminViewer,
      home: homePipelineIds,
      staffing: isAdminViewer ? "admin" : viewerStaffing,
      peerTransfer: isAdminViewer || viewerPeer,
    }),
    [viewerId, isAdminViewer, homePipelineIds, viewerStaffing, viewerPeer],
  );
  const showStaffingTab = isAdminViewer || viewerStaffing === "any" || viewerStaffing === "self";
  const pipeDisplay = (id: string, fallback: string) => tabLabels.pipelines[id] || fallback;

  const canEdit = (r: OpportunityRecord) =>
    isAdminViewer ||
    (!!viewerId &&
      (r.ownerId === viewerId || r.followerIds.includes(viewerId)));

  const selectablePipelines = useMemo(
    () => selectableFor(isAdminViewer, pipelines, homePipelineIds),
    [isAdminViewer, pipelines, homePipelineIds],
  );

  const scopeOptions = useMemo(() => {
    const divisions = new Set<string>();
    let anyShared = false;
    for (const r of data) {
      if (r.shared) anyShared = true;
      else if (r.pipelineName) divisions.add(divisionLabel(r.pipelineName));
    }
    return { divisions: [...divisions].sort(), anyShared };
  }, [data]);

  const noPipelineAccess =
    sso.status === "ready" &&
    !isAdminViewer &&
    homePipelineIds.length === 0 &&
    data.length === 0;

  const noRecruitingAccess =
    sso.status === "ready" &&
    !isAdminViewer &&
    cgHomeIds.length === 0 &&
    cgData.length === 0;

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

    return data.length ? "Shared with me" : "Cases";
  }, [adminPipeline, isAdminViewer, pipelines, homePipelineIds, data.length]);

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
          title: `Recruiting · ${cgNoun.group}`,
          sub:
            cgGroup === "staff"
              ?

                "Staff applicants across your division"
              : cgGroup === "all"
                ? "Caregiver, DSP and staff applicants across your division"
                : "Caregiver and DSP applicants across your division",
        };
      case "referrals":
        return {
          title: "Referrals",

          sub: "Referral sources, the cadence they are owed, and the events that produced them",
        };
      default:
        return {
          title: headerLabel,
          sub: "Enrollments across your division · contacts, comms and settings stay in GoHighLevel",
        };
    }
  }, [view, headerLabel, cgGroup, cgNoun]);

  const referringPartnerFieldId = useMemo(() => {
    const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (
      fieldDefs.find((d) => n(d.name) === n("Referring Partner"))?.id ||
      (fieldDefs.some((d) => d.id === REFERRING_PARTNER_FIELD)
        ? REFERRING_PARTNER_FIELD
        : "")
    );
  }, [fieldDefs]);

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

  const dataByActivity = useMemo(() => byLatestActivity(data), [data]);

  const ownerNameMap = useMemo(() => collectOwnerNames(data, cgData), [data, cgData]);

  const clientIx = useMemo(() => {
    const m = new Map<string, Indexed>();
    for (const r of data)
      m.set(
        r.id,
        indexRecord(
          [r.oppName, r.first, r.last, r.office, r.stage, r.harmony, r.cm, r.cg, r.rep, r.src],
          r.contactPhone,
          r.contactEmail,
        ),
      );
    return m;
  }, [data]);
  const masterIx = useMemo(() => {
    const m = new Map<string, Indexed>();
    for (const r of data) m.set(r.id, indexRecord([r.oppName, r.first, r.last], r.contactPhone, r.contactEmail));
    return m;
  }, [data]);
  const cgIx = useMemo(() => {
    const m = new Map<string, Indexed>();
    for (const r of cgData)
      m.set(r.id, indexRecord([r.oppName, r.first, r.last, r.stage], r.contactPhone, r.contactEmail));
    return m;
  }, [cgData]);
  const qParsed = useMemo(() => parseQuery(q), [q]);
  const cgParsed = useMemo(() => parseQuery(cgQuery), [cgQuery]);

  const hasCm = useCallback(
    (r: OpportunityRecord) =>
      !cmF || splitNames(r.cm).some((n) => n.toLowerCase() === cmF.toLowerCase()),
    [cmF],
  );
  const clientWin = useMemo(
    () => createdWindow(createdRange, todayKey, createdFrom, createdTo),
    [createdRange, todayKey, createdFrom, createdTo],
  );

  const clientPreOwner = useMemo(() => {
    return dataByActivity.filter(
      (r) =>

        !isReassignRec(r) &&

        !isNewLeadStage(r.stage) &&
        (office === "all" || r.office === office) &&
        (scope === "all" ||
          (scope === "shared"
            ? r.shared
            : !r.shared && divisionLabel(r.pipelineName) === scope)) &&

        (adminPipeline === "all" || r.pipelineId === adminPipeline) &&

        matchesQuery(clientIx.get(r.id), qParsed),
    );
  }, [dataByActivity, office, qParsed, clientIx, scope, adminPipeline]);
  const clientNoDate = useMemo(
    () => clientPreOwner.filter((r) => matchesOwner(r, ownerF) && hasCm(r)),
    [clientPreOwner, ownerF, hasCm],
  );

  const clientPeopleBase = useMemo(
    () =>
      dataByActivity.filter(
        (r) =>
          !isReassignRec(r) &&
          !isNewLeadStage(r.stage) &&
          (office === "all" || r.office === office) &&
          (scope === "all" ||
            (scope === "shared" ? r.shared : !r.shared && divisionLabel(r.pipelineName) === scope)) &&
          (adminPipeline === "all" || r.pipelineId === adminPipeline) &&
          inCreatedWindow(r.createdAt, clientWin),
      ),
    [dataByActivity, office, scope, adminPipeline, clientWin],
  );
  const clientOwnerOpts = useMemo(
    () => ownerOptions(clientPeopleBase, { viewerId, selected: ownerF, names: ownerNameMap }),
    [clientPeopleBase, viewerId, ownerF, ownerNameMap],
  );

  const clientUndated = useMemo(
    () => (windowActive(clientWin) ? clientNoDate.filter((r) => !easternDayKey(r.createdAt)).length : 0),
    [clientNoDate, clientWin],
  );
  const preSrc = useMemo(
    () => clientNoDate.filter((r) => inCreatedWindow(r.createdAt, clientWin)),
    [clientNoDate, clientWin],
  );

  const preStage = useMemo(
    () =>
      srcF === "all"
        ? preSrc
        : preSrc.filter((r) => srcKey(r.src) === srcF),
    [preSrc, srcF],
  );

  const stageActive = view !== "board";
  const filtered = useMemo(
    () =>
      preStage.filter(
        (r) => !stageActive || stage === "all" || r.stage === stage,
      ),
    [preStage, stage, stageActive],
  );

  const srcBase = useMemo(
    () => preSrc.filter((r) => stage === "all" || r.stage === stage),
    [preSrc, stage],
  );

  const scopedTotal = useMemo(
    () =>
      data.filter(
        (r) =>

          !isReassignRec(r) &&
          !isNewLeadStage(r.stage) &&
          (adminPipeline === "all" || r.pipelineId === adminPipeline) &&
          (scope === "all" ||
            (scope === "shared"
              ? r.shared
              : !r.shared && divisionLabel(r.pipelineName) === scope)),
      ).length,
    [data, adminPipeline, scope],
  );

  const stages = useMemo(() => {
    const present: string[] = [];
    const seen = new Set<string>();
    for (const r of preStage) {

      if (r.shared) continue;
      if (r.stage && !seen.has(r.stage)) {
        seen.add(r.stage);
        present.push(r.stage);
      }
    }
    const ordered = STAGE_ORDER.filter((s) => seen.has(s));
    const extra = present.filter((s) => !STAGE_ORDER.includes(s));

    return [...ordered, ...extra].filter((n) => !isReassignStage(n));
  }, [preStage]);

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

  useEffect(() => {
    if (stage !== "all" && !stages.includes(stage)) setStage("all");
  }, [stages, stage]);

  useEffect(() => {
    if (srcF !== "all" && !srcBase.some((r) => srcKey(r.src) === srcF))
      setSrcF("all");
  }, [srcBase, srcF]);

  useEffect(() => {
    if (isAdminViewer && scope !== "all") setScope("all");
  }, [isAdminViewer, scope]);

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

  const dimensions = useMemo<Dim[]>(() => {
    const out: Dim[] = [
      { key: "native:stage", label: "Stage", kind: "stage", sortable: true, groupable: true },

      { key: "native:created", label: "Created", kind: "date", sortable: true, groupable: false },
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
        return n >= 2 && n < data.length;
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

  const matchesClientFocus = useCallback(
    (r: OpportunityRecord) => {
      if (!clientFocus) return true;
      switch (clientFocus.kind) {
        case "office":
          return r.office === clientFocus.value;

        case "rep":
          return clientFocus.value === "" ? !r.ownerId : r.ownerId === clientFocus.value;
        case "blocked":
          return r.block !== "None";
        case "checked":
          return r.checked;
        default:
          return true;
      }
    },
    [clientFocus],
  );

  const clientF = (kind: string, value?: string) =>
    !!clientFocus && clientFocus.kind === kind && clientFocus.value === value;
  const setClientF = (kind: string, value?: string) =>
    setClientFocus((f) =>
      f && f.kind === kind && f.value === value ? null : ({ kind, value } as typeof f),
    );

  const visible = useMemo(() => {

    const base = filtered.filter(matchesClientFocus);
    if (!sortKey) return base;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...base].sort((a, b) => dir * cmpBy(a, b, sortKey));
  }, [filtered, matchesClientFocus, sortKey, sortDir, cmpBy]);

  const [onScreenIds, setOnScreenIds] = useState<string[]>([]);

  const relInFlight = useRef<Set<string>>(new Set());

  const relStale = useRef<Set<string>>(new Set());
  const [relNudge, setRelNudge] = useState(0);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {

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

          if (id && !seen.has(id)) {
            seen.add(id);
            changed = true;
          }
        }
        if (!changed) return;

        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => setOnScreenIds([...seen]));
      },
      { rootMargin: "300px 0px" },
    );
    for (const el of document.querySelectorAll<HTMLElement>("[data-cid]"))
      io.observe(el);

    const mo =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((muts) => {
            for (const m of muts)
              for (const n of m.addedNodes) {
                if (!(n instanceof HTMLElement)) continue;
                if (n.dataset.cid) io.observe(n);
                for (const el of n.querySelectorAll<HTMLElement>("[data-cid]"))
                  io.observe(el);
              }
          });
    mo?.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(raf);
      mo?.disconnect();
      io.disconnect();
    };

  }, [visible, data, view]);

  useEffect(() => {

    if (!ssoResolved(sso)) return;

    if (selId) return;

    const ids = [
      ...new Set(
        onScreenIds.filter(
          (id) => id && !(id in relCounts) && !relInFlight.current.has(id),
        ),
      ),
    ].slice(0, 60);
    if (!ids.length) return;
    for (const id of ids) relInFlight.current.add(id);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REL_COUNTS_TIMEOUT_MS);
    const dropped: string[] = [];

    (async () => {
      try {
        const j = await apiFetch<{ counts?: RelationCounts; unknown?: string[] }>(
          "/api/relations/counts",
          {
            method: "POST",
            ssoBlob: sso.blob,
            signal: ac.signal,
            body: JSON.stringify({
              ssoKey: sso.blob ?? undefined,
              contactIds: ids,
            }),
          },
        );

        const declaredUnknown = new Set(j.unknown ?? []);
        const next: RelationCounts = {};
        for (const id of ids) {
          if (relStale.current.has(id)) {
            relStale.current.delete(id);
            dropped.push(id);
            continue;
          }
          const c = j.counts?.[id];

          next[id] = c && !declaredUnknown.has(id) ? c : { unknown: true };
        }
        setRelCounts((prev) => ({ ...prev, ...next }));
      } catch {

        const next: RelationCounts = {};
        for (const id of ids) {
          if (relStale.current.has(id)) {
            relStale.current.delete(id);
            dropped.push(id);
            continue;
          }
          next[id] = { unknown: true };
        }
        setRelCounts((prev) => ({ ...prev, ...next }));
      } finally {
        clearTimeout(timer);
        for (const id of ids) relInFlight.current.delete(id);

        if (dropped.length) setRelNudge((n) => n + 1);
      }
    })();

  }, [onScreenIds, sso, relCounts, selId, relNudge]);

  const relBadge = useCallback(
    (r: OpportunityRecord): string => {
      const c = relCounts[r.contactId];
      if (!c) return "";

      if (c.unknown) return "links unknown";
      const parts: string[] = [];
      if (c.caregivers)
        parts.push(`${c.caregivers} caregiver${c.caregivers === 1 ? "" : "s"}`);
      if (c.clients)
        parts.push(`${c.clients} client${c.clients === 1 ? "" : "s"}`);
      return parts.join(" · ");
    },
    [relCounts],
  );

  const applyLinkChange = useCallback(
    (selfContactId: string, links: Caregiver[], otherContactId?: string) => {
      if (!selfContactId) return;

      for (const id of [selfContactId, otherContactId])
        if (id && relInFlight.current.has(id)) relStale.current.add(id);
      setRelCounts((prev) =>
        applyLinkChangeToCounts(prev, selfContactId, links, otherContactId),
      );
    },
    [],
  );

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

  const renderCgRow = (r: OpportunityRecord) => {
    const age = dis(r);
    return (
      <tr
        key={r.id}

        data-cid={r.contactId || undefined}
        className={r.id === selId ? "sel" : ""}
        onClick={() => setSelId(r.id)}
      >
        <td className="strong">
          <div className="clientcell">
            <span className="clname">

              {cgStr(r, "applicant") || "—"}

              {r.newLead ? (
                <span className="newlead-tag" title="Nobody has opened this lead yet — it clears for everyone once someone does">
                  New lead
                </span>
              ) : null}
              <SourceMark src={r.src} />
            </span>

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
        <td>{stageDisplay(r.stage || "—", tabLabels)}</td>
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

            {r.newLead ? (
              <span className="newlead-tag" title="Nobody has opened this lead yet — it clears for everyone once someone does">
                New lead
              </span>
            ) : null}
            {r.pipelineName ? (
              <span className="divbadge" title={r.pipelineName}>
                {r.pipelineName}
              </span>
            ) : null}

            <SourceMark src={r.src} />
          </span>

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

          {r.shared ? (
            <span className="provenance">
              {r.ownerId === viewerId
                ? `Your record in ${r.pipelineName || "another pipeline"}`
                : `Shared by ${r.rep || "—"} · ${r.pipelineName || "another pipeline"} · you're a follower`}
            </span>
          ) : null}

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
                  ? `Came through Staffing needed (Reassign) from ${transferredFrom(r)} — given up by that division and assigned here. (Route read from the contact's reassign tag; tags are contact-scoped, so a contact reassigned once keeps it.)`
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
          <span className="pill stage">{stageDisplay(r.stage, tabLabels)}</span>
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

      <td className="createdcell">
        {r.createdAt ? (
          formatEasternNoZone(r.createdAt)
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );

  const boardVisible = useMemo(() => {
    const home = new Set(homePipelineIds);
    return preStage.filter(
      (r) =>
        (home.size === 0 || home.has(r.pipelineId)) &&
        (scope !== "all" || !r.shared),
    );
  }, [preStage, homePipelineIds, scope]);

  const boardFocused = useMemo(
    () => boardVisible.filter(matchesClientFocus),
    [boardVisible, matchesClientFocus],
  );

  useEffect(() => {
    if (!clientFocus) return;
    if (clientFocus.kind === "office" && clientFocus.value &&
        !preSrc.some((r) => r.office === clientFocus.value))
      setClientFocus(null);
    if (clientFocus.kind === "rep" && clientFocus.value &&
        !preSrc.some((r) => r.ownerId === clientFocus.value))
      setClientFocus(null);
  }, [preSrc, clientFocus]);

  const transferredFromId = useMemo(
    () =>
      fieldDefs.find(
        (d) => (d.name || "").toLowerCase().replace(/[^a-z0-9]/g, "") === "transferredfrom",
      )?.id || "",
    [fieldDefs],
  );

  const sortedFieldId = useMemo(
    () =>
      fieldDefs.find(
        (d) => (d.name || "").toLowerCase().replace(/[^a-z0-9]/g, "") === "sortedfromnewleads",
      )?.id || null,
    [fieldDefs],
  );
  const stageHistoryFieldId = useMemo(
    () =>
      fieldDefs.find(
        (d) => (d.name || "").toLowerCase().replace(/[^a-z0-9]/g, "") === "stagehistory",
      )?.id || null,
    [fieldDefs],
  );

  const ageByRecord = useMemo(() => {
    const now = Date.now();
    const m = new Map<string, StageAge | null>();

    for (const r of data) m.set(r.id, stageAge(r, stageHistoryFieldId, now));
    for (const r of cgData) m.set(r.id, stageAge(r, stageHistoryFieldId, now));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, cgData, stageHistoryFieldId]);

  const ageOf = useCallback(
    (r: OpportunityRecord): StageAge | null =>

      ageByRecord.has(r.id)
        ? (ageByRecord.get(r.id) ?? null)
        : stageAge(r, stageHistoryFieldId, Date.now()),
    [ageByRecord, stageHistoryFieldId],
  );
  const dis = useCallback(
    (r: OpportunityRecord): number | null => ageOf(r)?.days ?? null,
    [ageOf],
  );
  const transferredFrom = useCallback(
    (r: OpportunityRecord): string => {
      if (!transferredFromId) return "";
      const v = r.cf[transferredFromId];
      return Array.isArray(v) ? String(v[0] ?? "") : v ? String(v) : "";
    },
    [transferredFromId],
  );

  const STALL_DAYS = 14;

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
    let approx = 0;
    for (const r of rows) {
      const a = ageOf(r);
      if (a == null) noDate++;
      else if (a.days >= STALL_DAYS) {
        stalled++;
        if (a.source === "ghl") approx++;
      }
    }
    return { stalled, noDate, approx };
  };

  const masterWin = useMemo(
    () => createdWindow(masterCreatedRange, todayKey, masterCreatedFrom, masterCreatedTo),
    [masterCreatedRange, todayKey, masterCreatedFrom, masterCreatedTo],
  );

  const masterFocused = useCallback(
    (r: OpportunityRecord) => {
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
          const d = dis(r);
          return d != null && d >= STALL_DAYS;
        }
        default:
          return true;
      }
    },
    [masterFocus, dis],
  );

  const masterUndated = useMemo(() => {
    if (!windowActive(masterWin)) return 0;
    return dataByActivity.filter(
      (r) =>
        !easternDayKey(r.createdAt) &&
        (office === "all" || r.office === office) &&
        matchesOwner(r, ownerF) &&
        hasCm(r) &&
        masterFocused(r) &&
        matchesQuery(masterIx.get(r.id), qParsed),
    ).length;
  }, [dataByActivity, masterWin, qParsed, masterIx, office, ownerF, hasCm, masterFocused]);

  const masterPeopleBase = useMemo(
    () =>
      dataByActivity.filter(
        (r) =>
          (office === "all" || r.office === office) &&
          inCreatedWindow(r.createdAt, masterWin) &&
          masterFocused(r),
      ),
    [dataByActivity, office, masterWin, masterFocused],
  );
  const masterOwnerOpts = useMemo(
    () => ownerOptions(masterPeopleBase, { viewerId, selected: ownerF, names: ownerNameMap }),
    [masterPeopleBase, viewerId, ownerF, ownerNameMap],
  );
  const masterColumns = useMemo(() => {
    const match = (r: OpportunityRecord) =>
      (office === "all" || r.office === office) &&
      inCreatedWindow(r.createdAt, masterWin) &&
      matchesOwner(r, ownerF) &&
      hasCm(r) &&
      masterFocused(r) &&
      matchesQuery(masterIx.get(r.id), qParsed);
    const byCat = new Map<MasterCatId, OpportunityRecord[]>();

    for (const r of dataByActivity) {
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
  }, [dataByActivity, qParsed, masterIx, office, ownerF, hasCm, transferredFrom, masterFocused, masterWin]);

  const mFocus = (kind: string, value?: string) =>
    !!masterFocus && masterFocus.kind === kind && masterFocus.value === value;
  const setMFocus = (kind: string, value?: string) => {

    if (kind === "owner") setOwnerF(EVERYONE);
    setMasterFocus((f) =>
      f && f.kind === kind && f.value === value
        ? null
        : ({ kind, value } as typeof f),
    );
  };

  const pickOwner = (v: string) => {
    setOwnerF(v);
    setClientFocus((f) => (f && f.kind === "rep" ? null : f));
    setMasterFocus((f) => (f && f.kind === "owner" ? null : f));
  };

  const clientTally = useMemo(() => tallyPeople(clientPeopleBase), [clientPeopleBase]);
  const masterTally = useMemo(() => tallyPeople(masterPeopleBase), [masterPeopleBase]);

  const clientSuggestRecords = useMemo(
    () =>
      dataByActivity.map((r) => ({
        id: r.id,
        name: r.oppName || `${r.first} ${r.last}`.trim(),
        detail: [r.pipelineName, r.stage, r.rep && r.rep !== "—" ? r.rep : "Unassigned"].filter(Boolean).join(" · "),
        ix: clientIx.get(r.id) || indexRecord([], ""),
        activity: latestActivity(r),
      })),
    [dataByActivity, clientIx],
  );
  const masterSuggestRecords = useMemo(
    () => clientSuggestRecords.map((x) => ({ ...x, ix: masterIx.get(x.id) || x.ix })),
    [clientSuggestRecords, masterIx],
  );
  const clientSuggestions = useMemo(
    () =>
      suggest({
        query: q,
        ownerWord: "Sales rep",
        owners: clientOwnerOpts.owners,
        unassigned: clientOwnerOpts.unassigned,
        caseManagers: clientTally.caseManagers,
        offices: clientTally.offices,
        records: clientSuggestRecords,
      }),
    [q, clientOwnerOpts, clientTally, clientSuggestRecords],
  );
  const masterSuggestions = useMemo(
    () =>
      suggest({
        query: q,
        ownerWord: "Sales rep",
        owners: masterOwnerOpts.owners,
        unassigned: masterOwnerOpts.unassigned,
        caseManagers: masterTally.caseManagers,
        offices: masterTally.offices,
        records: masterSuggestRecords,
      }),
    [q, masterOwnerOpts, masterTally, masterSuggestRecords],
  );

  const peopleChips = useMemo(() => {
    const out: SearchChip[] = [];
    if (ownerF !== EVERYONE)
      out.push({
        key: "owner",
        label: ownerF === UNASSIGNED ? "Unassigned" : `Sales rep: ${ownerNameMap.get(ownerF) || "former user"}`,
        onRemove: () => setOwnerF(EVERYONE),
      });
    if (cmF) out.push({ key: "cm", label: `Case manager: ${cmF}`, onRemove: () => setCmF("") });
    return out;
  }, [ownerF, cmF, ownerNameMap]);
  const pickClientSuggestion = (sg: Suggestion) => {
    if (sg.kind === "record") return setSelId(sg.value);
    if (sg.kind === "owner") pickOwner(sg.value);
    if (sg.kind === "unassigned") pickOwner(UNASSIGNED);
    if (sg.kind === "cm") setCmF(sg.value);
    if (sg.kind === "office") setOffice(sg.value);
    setQ("");
  };
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

  const stageName = useCallback(
    (id: string): string => {
      for (const list of Object.values(stagesByPipeline))
        for (const s of list) if (s.id === id) return stageDisplay(s.name, tabLabels);
      return id;
    },
    [stagesByPipeline, tabLabels],
  );

  const [kpiRange, setKpiRange] = useState<KpiRange>("month");
  const [kpiFrom, setKpiFrom] = useState("");
  const [kpiTo, setKpiTo] = useState("");
  const [kpiPipe, setKpiPipe] = useState("");
  const [kpiDiv, setKpiDiv] = useState("");

  const [drill, setDrill] = useState<{ title: string; ids: string[] } | null>(null);

  const kpiWindow = useMemo(() => {
    if (kpiRange !== "custom") return rangeWindow(kpiRange, Date.now());

    return {
      from: kpiFrom ? new Date(`${kpiFrom}T00:00:00.000Z`).toISOString() : null,

      to: kpiTo
        ? new Date(Date.parse(`${kpiTo}T00:00:00.000Z`) + 86_400_000).toISOString()
        : null,
    };
  }, [kpiRange, kpiFrom, kpiTo]);

  const kpiRecords = useMemo(
    () =>
      data.filter(
        (r) =>
          (!kpiPipe || r.pipelineId === kpiPipe) &&
          (!kpiDiv || divisionLabel(r.pipelineName) === kpiDiv),
      ),
    [data, kpiPipe, kpiDiv],
  );

  const kpiPipes = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of data) if (r.pipelineId) m.set(r.pipelineId, r.pipelineName);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [data]);
  const kpiDivs = useMemo(
    () =>
      [...new Set(data.map((r) => divisionLabel(r.pipelineName)).filter(Boolean))].sort(),
    [data],
  );

  const asKpi = useCallback(
    (r: OpportunityRecord): KpiRecord => ({
      id: r.id,
      stageId: r.stageId,
      pipelineId: r.pipelineId,
      pipelineName: r.pipelineName,
      ownerId: r.ownerId,
      status: r.status,
      statusChangedAt: r.statusChangedAt,
      stageChangedAt: r.stageChangedAt,
      createdAt: r.createdAt,
      cf: r.cf,
    }),
    [],
  );
  const kpiRows = useMemo(() => kpiRecords.map(asKpi), [kpiRecords, asKpi]);

  const kpi: StageKpiResult = useMemo(
    () => stageKpi(kpiRecords, stageHistoryFieldId, { window: kpiWindow }),
    [kpiRecords, stageHistoryFieldId, kpiWindow],
  );
  const funnels = useMemo(
    () => stageFunnel(kpiRows, stageHistoryFieldId, stagesByPipeline, { window: kpiWindow }),
    [kpiRows, stageHistoryFieldId, stagesByPipeline, kpiWindow],
  );
  const stageNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const list of Object.values(stagesByPipeline))
      for (const st of list) m.set(st.id, st.name);
    return m;
  }, [stagesByPipeline]);
  const dwell = useMemo(
    () => timeInStage(kpiRows, stageHistoryFieldId, stageNameMap, { window: kpiWindow }),
    [kpiRows, stageHistoryFieldId, stageNameMap, kpiWindow],
  );
  const firstMove = useMemo(
    () => speedToFirstMove(kpiRows, stageHistoryFieldId, { window: kpiWindow }),
    [kpiRows, stageHistoryFieldId, kpiWindow],
  );
  const closed = useMemo(() => wonLost(kpiRows, { window: kpiWindow }), [kpiRows, kpiWindow]);

  const masterStats = useMemo(() => {
    const rows = data;
    return {
      total: rows.length,

      byPipeline: tallyBy(rows, (r) => r.pipelineName),

      byOwner: tallyBy(rows.filter((r) => r.ownerId), (r) => r.rep),
      unassigned: rows.filter((r) => !r.ownerId).length,
      bySource: tallyBy(rows, (r) => r.src),
      byStatus: tallyBy(rows, (r) => r.status),
      blocked: rows.filter((r) => r.block && r.block !== "None").length,

      shared: rows.filter((r) => r.shared).length,
      ...stallOf(rows),
      byOffice: tallyBy(rows, (r) => r.office),
      byCounty: tallyBy(rows, (r) => r.county),
      followerNoOwner: rows.filter((r) => !r.ownerId && r.followerIds.length > 0).length,
      checked: rows.filter((r) => r.checked).length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const cgVisiblePipelines = useMemo(() => {
    const home = new Set(cgHomeIds);

    void home;
    const mine = recruitingVisible(isAdminViewer, cgPipelines, cgHomeIds, cgData);

    return inGroup(mine, cgGroup, pipelineGroups);
  }, [cgPipelines, cgHomeIds, cgData, isAdminViewer, cgGroup, pipelineGroups]);

  const recruitingEmpty = useMemo(() => {

    const label = cgNoun.pipelines;

    const inGroup =
      cgGroup === "all"
        ? cgPipelines
        : cgPipelines.filter(
            (p) => (pipelineGroups[p.id] === "staff" ? "staff" : "caregiver") === cgGroup,
          );

    if (noRecruitingAccess)
      return (
        <>
          <b>No pipelines assigned yet</b>
          <br />
          An admin controls which pipelines you can see. Nothing is wrong with
          your sign-in — you&apos;ll see {cgNoun.many} here once you are given
          access to one in the Access tab.
        </>
      );

    if (!inGroup.length && cgPipelinesWithheld > 0)
      return (
        <>
          <b>No {label} pipelines assigned yet</b>
          <br />
          {cgPipelinesWithheld} pipeline{cgPipelinesWithheld === 1 ? "" : "s"} on
          this account {cgPipelinesWithheld === 1 ? "is" : "are"} not yours to
          see. You&apos;ll see records here once an admin gives you access to one
          in the Access tab.
        </>
      );
    if (!inGroup.length)
      return (
        <>
          <b>No {label} pipelines are set up yet.</b>
          <br />
          {cgGroup === "staff" ? (
            <>
              An admin marks a pipeline as <b>Staff</b> under Recruiting group on
              the Pipelines screen. ⚠️ A pipeline with no group set reads as
              Caregivers, so a staff pipeline that has never been marked is
              listed there instead of here.
            </>
          ) : (
            <>An admin sets this up on the Pipelines screen.</>
          )}
        </>
      );

    return (
      <>
        <b>No {label} pipelines assigned yet</b>
        <br />
        {inGroup.length} {label} pipeline{inGroup.length === 1 ? " exists" : "s exist"}, but none is
        yours yet. You&apos;ll see records here once an admin gives you access to
        one in the Access tab.
      </>
    );
  }, [cgGroup, cgNoun, cgPipelines, pipelineGroups, noRecruitingAccess, cgPipelinesWithheld]);

  const cgActivePipeline = useMemo(
    () => activeRecruitingPipeline(cgPipeline, cgVisiblePipelines, cgSidebarHidden),
    [cgPipeline, cgVisiblePipelines, cgSidebarHidden],
  );

  const cgStages = useMemo(
    () => (cgStagesByPipeline[cgActivePipeline] || []).map((st) => st.name),
    [cgStagesByPipeline, cgActivePipeline],
  );

  const cgWin = useMemo(
    () => createdWindow(cgCreatedRange, todayKey, cgCreatedFrom, cgCreatedTo),
    [cgCreatedRange, todayKey, cgCreatedFrom, cgCreatedTo],
  );

  const cgByActivity = useMemo(() => byLatestActivity(cgData), [cgData]);
  const cgPreOwner = useMemo(() => {
    return cgByActivity.filter(
      (r) =>
        r.pipelineId === cgActivePipeline &&

        matchesQuery(cgIx.get(r.id), cgParsed),
    );
  }, [cgByActivity, cgActivePipeline, cgParsed, cgIx]);
  const cgNoDate = useMemo(
    () => cgPreOwner.filter((r) => matchesOwner(r, cgOwnerF)),
    [cgPreOwner, cgOwnerF],
  );

  const cgOwnerOpts = useMemo(
    () =>
      ownerOptions(
        cgByActivity.filter((r) => r.pipelineId === cgActivePipeline && inCreatedWindow(r.createdAt, cgWin)),
        { viewerId, selected: cgOwnerF, names: ownerNameMap },
      ),
    [cgByActivity, cgActivePipeline, cgWin, viewerId, cgOwnerF, ownerNameMap],
  );

  const pickCgOwner = (v: string) => {
    setCgOwnerF(v);
    setCgFocus((f) => (f && f.kind === "recruiter" ? null : f));
  };
  const cgOwnerLabel = describeOwner(cgOwnerF, ownerNameMap, "recruiter");

  const cgSuggestRecords = useMemo(
    () =>
      cgByActivity.map((r) => ({
        id: r.id,
        name: r.oppName || `${r.first} ${r.last}`.trim(),
        detail: [r.pipelineName, r.stage, r.rep && r.rep !== "—" ? r.rep : "Unassigned"].filter(Boolean).join(" · "),
        ix: cgIx.get(r.id) || indexRecord([], ""),
        activity: latestActivity(r),
      })),
    [cgByActivity, cgIx],
  );

  const cgSuggestions = useMemo(
    () =>
      suggest({
        query: cgQuery,
        ownerWord: "Recruiter",
        owners: cgOwnerOpts.owners,
        unassigned: cgOwnerOpts.unassigned,
        records: cgSuggestRecords,
      }),
    [cgQuery, cgOwnerOpts, cgSuggestRecords],
  );
  const cgChips = useMemo(
    () =>
      cgOwnerF === EVERYONE
        ? []
        : [
            {
              key: "owner",
              label: cgOwnerF === UNASSIGNED ? "Unassigned" : `Recruiter: ${ownerNameMap.get(cgOwnerF) || "former user"}`,
              onRemove: () => setCgOwnerF(EVERYONE),
            },
          ],
    [cgOwnerF, ownerNameMap],
  );
  const pickCgSuggestion = (sg: Suggestion) => {
    if (sg.kind === "record") return setSelId(sg.value);
    if (sg.kind === "owner") pickCgOwner(sg.value);
    if (sg.kind === "unassigned") pickCgOwner(UNASSIGNED);
    setCgQuery("");
  };
  const cgUndated = useMemo(
    () => (windowActive(cgWin) ? cgNoDate.filter((r) => !easternDayKey(r.createdAt)).length : 0),
    [cgNoDate, cgWin],
  );
  const cgPreStage = useMemo(
    () => cgNoDate.filter((r) => inCreatedWindow(r.createdAt, cgWin)),
    [cgNoDate, cgWin],
  );

  const cgDateLabel = describeWindow(cgCreatedRange, cgWin);

  const cgVisible = useMemo(
    () => (cgStage ? cgPreStage.filter((r) => r.stage === cgStage) : cgPreStage),
    [cgPreStage, cgStage],
  );

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
          const d = dis(r);
          return d != null && d >= STALL_DAYS;
        }
        default:
          return true;
      }
    });
  }, [cgVisible, cgFocus]);

  const cgSorted = useMemo(() => {
    if (!cgSortKey) return cgFocused;
    const dir = cgSortDir === "asc" ? 1 : -1;
    return [...cgFocused].sort((a, b) => {
      if (cgSortKey === "days") {
        const x = dis(a);
        const y = dis(b);
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

  const cgStats = useMemo(() => {
    const unassigned = cgVisible.filter((r) => !r.ownerId).length;

    const aged = cgVisible
      .map((r) => ({ r, d: dis(r) }))
      .filter((x): x is { r: OpportunityRecord; d: number } => x.d != null)
      .sort((a, b) => b.d - a.d);
    return {
      unassigned,
      oldest: aged[0] || null,
      dated: aged.length,

      total: cgVisible.length,
      byStage: tallyBy(cgVisible, (r) => r.stage),

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

  useEffect(() => {
    if (cgStage && !cgStages.includes(cgStage)) setCgStage(null);
  }, [cgStages, cgStage]);

  const pipelinesFor = useCallback(
    (cat: MasterCatId): string[] => {
      if (cat === "enrollment")
        return selectablePipelines.filter(isEnrollmentPipeline).map((p) => p.id);
      if (cat === "transfer")
        return selectablePipelines
          .filter((p) => isTransferPipe(p.name))
          .map((p) => p.id);

      return [];
    },
    [selectablePipelines],
  );

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

    const repMap = new Map<string, { id: string; k: string; n: number }>();
    for (const r of filtered) {
      if (!r.ownerId) continue;
      const hit = repMap.get(r.ownerId);
      if (hit) hit.n += 1;
      else repMap.set(r.ownerId, {
        id: r.ownerId,
        k: r.rep && r.rep !== "—" ? r.rep : "Former user",
        n: 1,
      });
    }
    const repStats = [...repMap.values()].sort((a, b) => b.n - a.n);
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

  const selected = useMemo(
    () => data.find((r) => r.id === selId) || cgData.find((r) => r.id === selId) || null,
    [data, cgData, selId],
  );

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("mm.openSections");
      if (raw) setOpenSections(JSON.parse(raw) as Record<string, boolean>);
    } catch {

    }
  }, []);
  const toggleSection = useCallback((key: string, openNow: boolean) => {
    setOpenSections((prev) => {
      const next = { ...prev, [key]: !openNow };
      try {
        window.localStorage.setItem("mm.openSections", JSON.stringify(next));
      } catch {

      }
      return next;
    });
  }, []);

  const isSectionOpen = useCallback(
    (key: string, defaultOpen: boolean) =>
      key in openSections ? openSections[key] : defaultOpen,
    [openSections],
  );

  const contactGroups = useMemo(
    () =>
      cFields
        ? groupContactFields(
            cFields.defs,
            cgData.some((r) => r.id === selId) ? "caregiver" : "client",

            cFields.values,

            folderNames,
          )
        : [],
    [cFields, cgData, selId, folderNames],
  );

  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());

  const [addFieldOpen, setAddFieldOpen] = useState<string>("");

  const isQuietSection = useCallback(
    (g: { fields: unknown[]; hidden?: { id: string }[] }) =>
      g.fields.length === 0 &&
      !(g.hidden || []).some((d) => revealedFields.has(d.id)),
    [revealedFields],
  );

  const [showEmptySections, setShowEmptySections] = useState(false);
  useEffect(() => {
    setRevealedFields(new Set());
    setAddFieldOpen("");
    setShowEmptySections(false);
  }, [selId]);

  useEffect(() => {
    if (!addFieldOpen) return;
    const away = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.(".addfield")) setAddFieldOpen("");
    };
    const esc = (e: KeyboardEvent) => {

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
    if (sso.blob) h["x-ghl-sso-key"] = sso.blob;

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
          setCErr(null);
          setCFields({
            defs: j.fieldDefs || [],
            values: j.values || {},
            version: j.version || "",
            opportunityCount: j.opportunityCount || 0,
            firstName: j.firstName || "",
            lastName: j.lastName || "",
            email: j.email || "",
            phone: j.phone || "",
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

  }, [selected?.id, selected?.contactId, sso.blob]);

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
              ssoKey: sso.blob ?? undefined,
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

        setCSave((p) => ({ ...p, [def.id]: undefined }));
      } catch (e) {
        setCSave((p) => ({ ...p, [def.id]: { status: "error", err: e } }));
      }
    },
    [selected, sso, cFields?.version],
  );

  const saveContactReach = useCallback(
    async (which: "phone" | "email", value: string) => {
      if (!selected?.contactId) return false;
      const contactId = selected.contactId;
      const key = which === "phone" ? PHONE_KEY : EMAIL_KEY;
      setCSave((p) => ({ ...p, [key]: { status: "saving" } }));
      try {
        const res = await fetch(
          `/api/contacts/${encodeURIComponent(selected.id)}/fields`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ssoKey: sso.blob ?? undefined,
              expectedVersion: cFields?.version,
              [which]: value,
            }),
          },
        );
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setCSave((p) => ({ ...p, [key]: { status: "error", err: j } }));
          return false;
        }
        const stored = (which === "phone" ? j.phone : j.email) ?? value;
        setCFields((prev) =>
          prev ? { ...prev, [which]: stored, version: j.version || prev.version } : prev,
        );

        const touch = (r: OpportunityRecord) =>
          r.contactId === contactId
            ? { ...r, ...(which === "phone" ? { contactPhone: stored } : { contactEmail: stored }) }
            : r;
        setData((prev) => prev.map(touch));
        setCgData((prev) => prev.map(touch));
        setCSave((p) => ({ ...p, [key]: undefined }));
        return true;
      } catch (e) {
        setCSave((p) => ({ ...p, [key]: { status: "error", err: e } }));
        return false;
      }
    },
    [selected, sso, cFields?.version],
  );

  const saveContactName = useCallback(
    async (firstName: string, lastName: string) => {
      if (!selected?.contactId) return false;
      const contactId = selected.contactId;
      setCSave((p) => ({ ...p, [NAME_KEY]: { status: "saving" } }));
      try {
        const res = await fetch(
          `/api/contacts/${encodeURIComponent(selected.id)}/fields`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ssoKey: sso.blob ?? undefined,
              expectedVersion: cFields?.version,
              name: { firstName, lastName },
            }),
          },
        );
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setCSave((p) => ({ ...p, [NAME_KEY]: { status: "error", err: j } }));
          return false;
        }

        const first = j.firstName ?? firstName;
        const last = j.lastName ?? lastName;

        if (j.nameConfirmed === false)
          setCSave((pv) => ({
            ...pv,
            [NAME_KEY]: {
              status: "warn",
              err: {
                error: "Saved, but GoHighLevel reports a different name.",
                detail: `It stored “${[first, last].filter(Boolean).join(" ") || "(nothing)"}” — shown above — rather than “${j.nameSent || ""}”. Nothing was lost; check it in GoHighLevel if that is not what you meant.`,
              },
            },
          }));
        else setCSave((pv) => ({ ...pv, [NAME_KEY]: undefined }));
        setCFields((prev) =>
          prev ? { ...prev, firstName: first, lastName: last, version: j.version || prev.version } : prev,
        );
        const rename = (r: OpportunityRecord) =>
          r.contactId === contactId
            ? { ...r, first, last, contactName: `${first} ${last}`.trim() }
            : r;
        setData((prev) => prev.map(rename));
        setCgData((prev) => prev.map(rename));
        setCSave((p) => ({ ...p, [NAME_KEY]: undefined }));
        return true;
      } catch (e) {
        setCSave((p) => ({ ...p, [NAME_KEY]: { status: "error", err: e } }));
        return false;
      }
    },
    [selected, sso, cFields?.version],
  );

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

            exclude: pipelineExclusions?.[selected.pipelineId],
          })
        : {
            sections: [],
            systemInfo: [],
            orphans: [],
            orphanGroups: [],
            available: [],
            unconfigured: false,
          },

    [selected, fieldDefs, pipelineFolders, folderNames, pipelineExclusions],
  );

  const ssoHeader = (): Record<string, string> =>
    sso.blob ? { "x-ghl-sso-key": sso.blob } : {};

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
          ssoKey: sso.blob ?? undefined,
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

        [selId]: [n, ...(prev[selId] || [])],
      }));
      setNoteDraft("");
    } catch (e) {
      setNoteErr(e);
    } finally {
      setNoteBusy(false);
    }
  };

  const selNotes = (selId && notes[selId]) || [];

  const removeIsMove = !!selNotes.find((n) => n.id === removeTarget)?.system;

  const applyNewOption = useCallback((fieldId: string, options: string[]) => {
    setFieldDefs((prev) =>
      prev.map((d) => (d.id === fieldId ? { ...d, options } : d)),
    );
  }, []);

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
      setRemoveTarget(null);

    } catch (e) {
      setEditErr(e);
    } finally {
      setEditBusy(false);
    }
  };

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
            ssoKey: sso.blob ?? undefined,
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

  const skey = (id: string, fk: string) => `${id}:${fk}`;

  const stableCf = (v: unknown) => JSON.stringify(v ?? null);
  const fieldUnchangedOnServer = (
    patch: Record<string, unknown>,
    was: OpportunityRecord,
    now: OpportunityRecord,
  ): boolean => {
    if ("stageId" in patch) return (was.stageId || "") === (now.stageId || "");
    if ("status" in patch) return (was.status || "") === (now.status || "");

    if ("assignedTo" in patch) return (was.ownerId || "") === (now.ownerId || "");
    if ("monetaryValue" in patch)
      return (was.monetaryValue || 0) === (now.monetaryValue || 0);

    if ("name" in patch) return (was.oppName || "") === (now.oppName || "");
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

      const applyBoth = (fn: (r: OpportunityRecord) => OpportunityRecord) => {
        setData((prev) => prev.map((r) => (r.id === rec.id ? fn(r) : r)));
        setCgData((prev) => prev.map((r) => (r.id === rec.id ? fn(r) : r)));
      };
      applyBoth(optimistic);

      const attempt = async (expectedVersion: string | undefined) => {
        const res = await fetch(`/api/opportunities/${rec.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ssoKey: sso.blob ?? undefined,
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

        let { res, j } = await attempt(rec.version);

        if (res.status === 409 && j.record && fieldUnchangedOnServer(patch, rec, j.record)) {

          ({ res, j } = await attempt(j.record.version));
        }

        if (!res.ok || !j.ok || !j.record) throw apiError(res, j);

        applyBoth(() => j.record!);
        setSaveState((p) => ({ ...p, [skey(rec.id, fk)]: undefined }));

        return true;
      } catch (e) {

        applyBoth(() => rec);
        setSaveState((p) => ({
          ...p,
          [skey(rec.id, fk)]: {
            status: "error",
            err: e,
          },
        }));
        return false;
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
            ssoKey: sso.blob ?? undefined,
            expectedVersion: rec.version,
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

  const [dragId, setDragId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

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

    const target = stagesFor(rec.pipelineId).find((s) => s.name === targetStage);
    if (!target) return;
    setDragSaveId(rec.id);

    saveField(
      rec,
      "stage",
      { stageId: target.id },
      (r) => ({ ...r, stage: targetStage, stageId: target.id }),
    );
  };

  const onCgDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const { active, over } = e;
    if (!over) return;
    const overId = String(over.id);
    if (!overId.startsWith("col:")) return;
    const targetStage = overId.slice(4);
    const rec = cgData.find((x) => x.id === active.id);
    if (!rec || rec.stage === targetStage || !canEdit(rec)) return;

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

  const onMasterDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const { active, over } = e;
    if (!over) return;
    const overId = String(over.id);
    if (!overId.startsWith("mcol:")) return;
    const cat = overId.slice(5) as MasterCatId;
    const rec = data.find((x) => `m:${x.id}` === String(active.id));
    if (!rec) return;
    if (masterCategory(rec, !!transferredFrom(rec)) === cat) return;
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

    if (cat !== "reassign" && pipelinesFor(cat).length === 0) {
      setDropRefused(
        `You have no ${def.label} pipeline available, so there's nowhere to move this to.`,
      );
      return;
    }
    setDropRefused(null);
    setMasterDrop({ record: rec, cat });
  };

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

    for (const r of boardVisible)
      if (r.stage && !set.has(r.stage)) {
        set.add(r.stage);
        names.push(r.stage);
      }

    return names.filter((n) => !isReassignStage(n) && !isNewLeadStage(n));
  }, [
    adminPipeline,
    homePipelineIds,
    pipelines,
    stagesByPipeline,
    pipelineStages,
    stages,
    boardVisible,
  ]);

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
    if (s?.status === "warn") {
      const w = s.err as { error?: string; detail?: string } | undefined;
      return (
        <div className="savewarn">
          <b>{w?.error || "Saved with a difference."}</b>
          {w?.detail ? <> {w.detail}</> : null}
        </div>
      );
    }
    return null;
  };
  const savingFk = (id: string, fk: string) =>
    saveState[skey(id, fk)]?.status === "saving";

  const eventHostFieldId = useMemo(() => {
    const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (
      fieldDefs.find((d) => EVENT_HOST_NAMES.some((x) => n(x) === n(d.name)))?.id ||
      (fieldDefs.some((d) => d.id === EVENT_HOST_FIELD_ID) ? EVENT_HOST_FIELD_ID : "")
    );
  }, [fieldDefs]);

  const partnerIdField = useCallback(
    (def: EditableFieldDef): "referrer" | "host" | "" => {
      if (referringPartnerFieldId && def.id === referringPartnerFieldId) return "referrer";
      if (eventHostFieldId && def.id === eventHostFieldId) return "host";
      return "";
    },
    [referringPartnerFieldId, eventHostFieldId],
  );

  const renderField = (
    rec: OpportunityRecord,
    def: EditableFieldDef,
  ): ReactNode => {
    const partnerKind = partnerIdField(def);
    if (partnerKind)
      return (
        <div className="f" key={`${rec.id}:${def.id}`}>
          <label title={def.name}>{def.name}</label>
          <PartnerName
            id={String(rec.cf[def.id] ?? "")}
            ssoBlob={sso.blob}
            hint={
              partnerKind === "referrer" && railWhere === "clients"
                ? "change it under Referred by, at the top"
                : "set from Referrals"
            }
          />
        </div>
      );
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
        users={users}
        isAdmin={isAdminViewer}
        ssoBlob={sso.blob}
        onOptionAdded={applyNewOption}
      />
    </div>
    );
  };

  const resourcesPane = (
          <div className="scroll reswrap">

            <div className="restoolbar">
              <div className="search">
                <IconSearch />
                <input
                  placeholder="Search resources by name…"
                  value={resQuery}
                  onChange={(e) => setResQuery(e.target.value)}
                />
              </div>

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

            {resErr && resources.length > 0 ? (
              <div className="loadwarn">
                <div>
                  <b>Couldn&apos;t refresh resources.</b> The files below are
                  from the last load that worked; their download links may have
                  expired.{" "}
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => loadResources()}
                  >
                    Try again
                  </button>
                </div>
                <ErrorMessage error={resErr} className="errbody" />
              </div>
            ) : null}

            {resLoading && resources.length === 0 ? (
              <div className="statewrap">
                <div className="statecard">
                  <div className="spinner" />
                  <h3>Loading resources…</h3>
                  <p>Fetching documents from the shared Resources folder.</p>
                </div>
              </div>
            ) : resErr && resources.length === 0 ? (
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

  const railWhere:
    | "clients"
    | "caregivers"
    | "referrals"
    | "master"
    | "kpi"
    | "import"
    | "access"
    | "pipelines" =
    view === "caregivers" ||
    view === "referrals" ||
    view === "import" ||
    view === "access" ||
    view === "pipelines" ||

    view === "kpi" ||

    view === "master"
      ? view
      : "clients";

  const sortingOn = railWhere === "clients" && (view === "list" || view === "board") && !!sortTab;

  const showSpinner = loading && data.length === 0;

  const sidebar = useMemo(
    () =>
      sidebarModel({
        selectable: selectablePipelines,
        records: data,
        hidden: pipelineSidebarHidden,
        failed: failedPipelines,

        isExcluded: (r: OpportunityRecord) => isReassignRec(r) || isNewLeadStage(r.stage),
      }),
    [selectablePipelines, data, pipelineSidebarHidden, failedPipelines],
  );

  const sidebarLoading = !clientSettled;

  const refreshing = loading || cgLoading;

  const hiddenBefore = useRef(pipelineSidebarHidden);
  useEffect(() => {
    const before = hiddenBefore.current;
    hiddenBefore.current = pipelineSidebarHidden;
    setAdminPipeline((cur) => selectionAfterHide(cur, before, pipelineSidebarHidden));
  }, [pipelineSidebarHidden]);

  const restoredEntry = useRef(false);
  useEffect(() => {
    if (restoredEntry.current || pipelines.length === 0) return;
    restoredEntry.current = true;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(REMEMBERED_ENTRY_KEY);
    } catch {

    }
    const id = restoreRemembered(stored, selectablePipelines, pipelineSidebarHidden);
    if (id !== "all") setAdminPipeline(id);
  }, [pipelines.length, selectablePipelines, pipelineSidebarHidden]);
  useEffect(() => {
    if (!restoredEntry.current) return;
    try {
      window.localStorage.setItem(REMEMBERED_ENTRY_KEY, adminPipeline);
    } catch {

    }
  }, [adminPipeline]);

  const railReady = useRef(false);
  const railIsCollapsed = railNarrow || railPref === "collapsed";
  useLayoutEffect(() => {
    if (!railReady.current) return;
    document.documentElement.setAttribute(
      "data-rail",
      railIsCollapsed ? "collapsed" : "expanded",
    );
  }, [railIsCollapsed]);
  useLayoutEffect(() => {
    let pref: "collapsed" | "expanded" = "expanded";
    try {
      if (window.localStorage.getItem(RAIL_KEY) === "collapsed") pref = "collapsed";
    } catch {

    }
    const mq = window.matchMedia("(max-width: 640px)");
    setRailPref(pref);
    setRailNarrow(mq.matches);
    railReady.current = true;

    document.documentElement.setAttribute(
      "data-rail",
      mq.matches || pref === "collapsed" ? "collapsed" : "expanded",
    );
    const sync = () => setRailNarrow(mq.matches);
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  const toggleRail = useCallback(() => {
    setRailPref((c) => {
      const next = c === "collapsed" ? "expanded" : "collapsed";
      try {
        window.localStorage.setItem(RAIL_KEY, next);
      } catch {

      }
      return next;
    });
  }, []);

  const cgOpenable = useMemo(
    () => recruitingVisible(isAdminViewer, cgPipelines, cgHomeIds, cgData),
    [isAdminViewer, cgPipelines, cgHomeIds, cgData],
  );
  const cgSidebar = useMemo(
    () =>
      recruitingModel({
        visible: cgOpenable,
        records: cgData,
        hidden: cgSidebarHidden,
        failed: cgFailedPipelines,
        groups: pipelineGroups,
      }),
    [cgOpenable, cgData, cgSidebarHidden, cgFailedPipelines, pipelineGroups],
  );

  const cgSidebarLoading = !cgLoaded && !cgErr;
  const cgEmptyCause = cgSidebarLoading
    ? null
    : recruitingEmptyCause({
        loadFailed: !!cgErr && !cgLoaded,
        noRecruitingAccess,
        visibleCount: cgOpenable.length,
        withheld: cgPipelinesWithheld,
        allHidden: cgSidebar.allHidden,
      });

  useEffect(() => {
    if (!cgLoaded || cgPipeline === "all") return;
    if (!cgVisiblePipelines.some((p) => p.id === cgPipeline)) setCgPipeline("all");
  }, [cgLoaded, cgPipeline, cgVisiblePipelines]);

  const cgHiddenBefore = useRef(cgSidebarHidden);
  useEffect(() => {
    const before = cgHiddenBefore.current;
    cgHiddenBefore.current = cgSidebarHidden;
    setCgPipeline((cur) => selectionAfterHide(cur, before, cgSidebarHidden));
  }, [cgSidebarHidden]);

  const restoredCg = useRef(false);
  useEffect(() => {
    if (restoredCg.current || !cgLoaded) return;
    restoredCg.current = true;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(REMEMBERED_CG_KEY);
    } catch {

    }
    const id = restoreRememberedCg(stored, cgOpenable, cgSidebarHidden);
    if (id !== "all") {
      const g = pipelineGroups[id] === "staff" ? "staff" : "caregiver";
      if (cgGroup !== "all" && cgGroup !== g) setCgGroup(g);
      setCgPipeline(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cgLoaded]);
  useEffect(() => {
    if (!restoredCg.current) return;
    try {
      window.localStorage.setItem(REMEMBERED_CG_KEY, cgPipeline);
    } catch {

    }
  }, [cgPipeline]);

  const pickCgEntry = useCallback(
    (id: string) => {
      const n = pickRecruitingPipeline(
        { cgGroup, cgView, cgQuery, selPipelineId: selected ? selected.pipelineId : null },
        id,
        pipelineGroups,
      );
      setView(n.view);
      setCgPipeline(n.cgPipeline);
      setCgGroup(n.cgGroup);
      setCgView(n.cgView);
      setCgStage(n.cgStage);
      setCgFocus(n.cgFocus);
      if (n.closeRecord) setSelId(null);
    },
    [cgGroup, cgView, cgQuery, selected, pipelineGroups],
  );

  const cgEntryActive = (id: string) => railWhere === "caregivers" && cgActivePipeline === id;

  const pickEntry = useCallback(
    (id: string) => {
      const n = pickClientPipeline(
        {
          view,
          adminPipeline,
          scope,
          stage,
          srcF,
          office,
          clientFocus,
          q,
          selPipelineId: selected ? selected.pipelineId : null,
          selIsClient: !!selected && data.some((r) => r.id === selected.id),
        },
        id,
      );
      setView(n.view as typeof view);
      setAdminPipeline(n.adminPipeline);
      setScope(n.scope);
      setStage(n.stage);
      setSrcF(n.srcF);
      setOffice(n.office);
      setClientFocus(n.clientFocus);
      if (n.closeRecord) setSelId(null);
      setSortTab(null);
    },
    [view, adminPipeline, scope, stage, srcF, office, clientFocus, q, selected, data],
  );

  const entryActive = (id: string) =>
    railWhere === "clients" && !sortTab && adminPipeline === id;

  const sortCounts = useMemo(
    () => ({
      newleads: data.filter((r) => isNewLeadStage(r.stage)).length,
      staffing: data.filter((r) => isStaffingStage(r.stage) && !r.ownerId).length,
    }),
    [data],
  );
  const sortEntryActive = (kind: "newleads" | "staffing") =>
    railWhere === "clients" && sortTab === kind;
  const pickSortTab = useCallback(
    (kind: "newleads" | "staffing") => {
      setSortTab(kind);
      setView((v) => (v === "list" || v === "board" ? v : "list"));

      setSelId((id) => {
        const r = id ? data.find((x) => x.id === id) : undefined;
        if (!r) return null;
        const here = kind === "newleads" ? isNewLeadStage(r.stage) : isStaffingStage(r.stage) && !r.ownerId;
        return here ? id : null;
      });
    },
    [data],
  );

  useEffect(() => {
    if (sortTab === "staffing" && !showStaffingTab && sso.status === "ready") setSortTab("newleads");
  }, [sortTab, showStaffingTab, sso.status]);

  const SORT_TAB_KEY = "mm.clientTab";
  const restoredSortTab = useRef(false);
  useEffect(() => {
    if (restoredSortTab.current || pipelines.length === 0) return;
    restoredSortTab.current = true;
    try {
      const v = window.localStorage.getItem(SORT_TAB_KEY);
      if (v === "pipeline") setSortTab(null);
      else if (v === "staffing" || v === "newleads") setSortTab(v);
    } catch {

    }
  }, [pipelines.length]);
  useEffect(() => {
    if (!restoredSortTab.current) return;
    try {
      window.localStorage.setItem(SORT_TAB_KEY, sortTab || "pipeline");
    } catch {

    }
  }, [sortTab]);

  const startRename = (key: string, current: string) =>
    setRenaming({ key, value: current, err: null, busy: false });
  const saveRename = async (key: string, value: string) => {
    const taken = [
      ...(key === "newLeads" ? [] : [tabLabels.newLeads]),
      ...(key === "staffingTab" ? [] : [tabLabels.staffingTab]),
      ...sidebar.entries
        .filter((e) => `pipeline:${e.id}` !== key)
        .map((e) => pipeDisplay(e.id, e.name)),
    ];
    const problem = labelProblem(value, taken);
    if (problem) {
      setRenaming((r) => (r ? { ...r, err: problem } : r));
      return;
    }
    setRenaming((r) => (r ? { ...r, busy: true, err: null } : r));
    try {
      const res = await fetch("/api/admin/pipelines", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sso.blob ? { "x-ghl-sso-key": sso.blob } : {}),
        },
        body: JSON.stringify({ ssoKey: sso.blob ?? undefined, action: "rename-tab", key, name: value }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(res, j);
      if (j.config?.labels) setTabLabelsRaw(j.config.labels);
      setRenaming(null);
    } catch (e) {
      setRenaming((r) => (r ? { ...r, busy: false, err: e instanceof Error ? e.message : String(e) } : r));
    }
  };

  useEffect(() => {
    if (!renaming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setRenaming(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [renaming]);
  const renameBox = (key: string, current: string) => (
    <div className="railrenamebox">
      <input
        className="railrename"

        ref={(el) => {
          if (el && !el.dataset.focused) {
            el.dataset.focused = "1";
            requestAnimationFrame(() => {
              el.focus();
              el.select();
            });
          }
        }}
        maxLength={40}
        defaultValue={current}
        disabled={renaming?.busy}
        spellCheck={false}
        aria-label="New tab name (empty resets to the default)"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void saveRename(key, (e.target as HTMLInputElement).value);
          }
        }}
        onBlur={(e) => {
          if (!renaming?.busy && (e.target as HTMLInputElement).value.trim() === current.trim()) setRenaming(null);
        }}
      />
      {renaming?.err ? <div className="railrenameerr">{renaming.err}</div> : null}
      <div className="railrenamehint">Enter saves · Esc cancels · empty = default name</div>
    </div>
  );

  const recordCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of data) m[r.pipelineId] = (m[r.pipelineId] || 0) + 1;
    for (const r of cgData) m[r.pipelineId] = (m[r.pipelineId] || 0) + 1;
    return m;
  }, [data, cgData]);

  const countFieldValues = useCallback(
    (pipelineId: string, fieldIds: string[]) => {
      const known = recordCounts[pipelineId] != null;

      if (!known && !cgLoaded) return null;
      const pool: OpportunityRecord[] = [];
      for (const r of data) if (r.pipelineId === pipelineId) pool.push(r);
      for (const r of cgData) if (r.pipelineId === pipelineId) pool.push(r);
      if (!pool.length && !cgLoaded && !known) return null;
      const perField: Record<string, number> = {};
      for (const id of fieldIds) perField[id] = 0;
      let records = 0;
      for (const r of pool) {
        let any = false;
        for (const id of fieldIds) {
          if (hasValue(r.cf?.[id])) {
            perField[id] += 1;
            any = true;
          }
        }
        if (any) records += 1;
      }

      return { perField, records, scanned: pool.length };
    },
    [data, cgData, cgLoaded, recordCounts],
  );

  const loadFailed = error && data.length === 0 ? error : null;

  const staleError = error && data.length > 0 ? error : null;

  const cgLoadFailed = cgErr && cgData.length === 0 ? cgErr : null;
  const cgStaleError = cgErr && cgData.length > 0 ? cgErr : null;

  return (
    <div className="app">

      <nav className="rail">
        <div className="logo">M</div>

        <div className="railclients" role="group" aria-labelledby="railhead-clients">
          <h2 id="railhead-clients" className="railhead">
            Clients
          </h2>

          {([
            ["newleads", "newLeads", tabLabels.newLeads, sortCounts.newleads, "NL"],
            ...(showStaffingTab
              ? ([["staffing", "staffingTab", tabLabels.staffingTab, sortCounts.staffing, "SN"]] as const)
              : []),
          ] as const).map(([kind, key, name, count, ini]) =>
            renaming?.key === key ? (
              <div key={kind}>{renameBox(key, name)}</div>
            ) : (
              <button
                key={kind}
                type="button"
                className={sortEntryActive(kind) ? "railpipe active" : "railpipe"}
                data-pipeline={kind}
                aria-current={sortEntryActive(kind) ? "page" : undefined}
                title={
                  (sidebarLoading ? name : `${name} — ${count}`) +
                  (isAdminViewer ? " · double-click to rename" : "")
                }
                aria-label={sidebarLoading ? name : `${name} (${count})`}
                onClick={() => pickSortTab(kind)}
                onDoubleClick={isAdminViewer ? () => startRename(key, name) : undefined}
              >
                <span className="railpipeini" aria-hidden="true">
                  {ini}
                </span>
                <span className="railpipename">{name}</span>
                <span className="railpipecount">{sidebarLoading ? "" : count}</span>
              </button>
            ),
          )}
          {SHOW_ALL_CLIENTS ? (
          <>
          <button
              type="button"
              className={entryActive("all") ? "railpipe active" : "railpipe"}

              data-pipeline="all"
              aria-current={entryActive("all") ? "page" : undefined}

              title={
                sidebarLoading
                  ? "All clients"
                  : [
                      `All clients — ${sidebar.all.count}`,
                      sidebar.all.inHidden > 0
                        ? `includes ${sidebar.all.inHidden} in pipelines hidden from the sidebar`
                        : "",
                      sidebar.all.shared > 0 ? `includes ${sidebar.all.shared} shared` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")
              }
              aria-label={
                sidebarLoading
                  ? "All clients"
                  : `All clients (${sidebar.all.count}${
                      sidebar.all.inHidden > 0
                        ? `, ${sidebar.all.inHidden} in hidden pipelines`
                        : ""
                    }${sidebar.all.shared > 0 ? `, ${sidebar.all.shared} shared` : ""})`
              }
              onClick={() => pickEntry("all")}
            >
              <span className="railpipeini" aria-hidden="true">
                All
              </span>
              <span className="railpipename">All clients</span>
              <span className="railpipecount">{sidebarLoading ? "" : sidebar.all.count}</span>
            </button>

            {sidebar.all.shared > 0 ? (
              <div className="railpipenote">includes {sidebar.all.shared} shared</div>
            ) : null}

            {sidebar.all.inHidden > 0 ? (
              <div className="railpipenote">
                includes {sidebar.all.inHidden} in pipelines hidden from the sidebar
              </div>
            ) : null}
          </>
          ) : null}
          {sidebarLoading
            ? [0, 1, 2].map((i) => <div key={i} className="railskel" aria-hidden="true" />)
            : sidebar.entries.map((e) =>
                renaming?.key === `pipeline:${e.id}` ? (
                  <div key={e.id}>{renameBox(`pipeline:${e.id}`, pipeDisplay(e.id, e.name))}</div>
                ) : (
                <button
                  key={e.id}
                  type="button"
                  className={
                    (entryActive(e.id) ? "railpipe active" : "railpipe") +
                    (e.failed ? " failed" : "")
                  }
                  data-pipeline={e.id}
                  aria-current={entryActive(e.id) ? "page" : undefined}
                  title={e.failed ? `${e.name} — didn't load` : `${e.name} — ${e.count}`}
                  aria-label={
                    e.failed ? `${e.name} (didn't load)` : `${e.name} (${e.count})`
                  }
                  onClick={() => pickEntry(e.id)}
                  onDoubleClick={
                    isAdminViewer ? () => startRename(`pipeline:${e.id}`, pipeDisplay(e.id, e.name)) : undefined
                  }
                >
                  <span className="railpipeini" aria-hidden="true">
                    {e.initials}
                  </span>
                  <span className="railpipename">{pipeDisplay(e.id, e.name)}</span>

                  <span className="railpipecount">{e.failed ? "—" : e.count}</span>
                </button>
              ))}
          {sidebar.allHidden ? (
            <div className="railpipenote">
              No client pipelines are shown in the sidebar. An admin can change
              this on Pipelines.
            </div>
          ) : null}
        </div>
        <div className="raildiv" aria-hidden="true" />

        <div className="railclients" role="group" aria-labelledby="railhead-recruiting">
          <h2 id="railhead-recruiting" className="railhead">
            Recruiting
          </h2>
          {cgSidebarLoading
            ? [0, 1].map((i) => <div key={i} className="railskel" aria-hidden="true" />)
            : (["caregiver", "staff"] as const).map((g, gi) => {
                const list = cgSidebar[g];
                if (!list.length) return null;
                return (
                  <Fragment key={g}>

                    {gi === 1 && cgSidebar.caregiver.length ? (
                      <div className="raildiv railsubdiv" aria-hidden="true" />
                    ) : null}
                    <div className="railsub">{recruitingNouns(g, cgOdpOnly).group}</div>
                    {list.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        className={
                          (cgEntryActive(e.id) ? "railpipe active" : "railpipe") +
                          (e.failed ? " failed" : "")
                        }
                        data-pipeline={e.id}
                        aria-current={cgEntryActive(e.id) ? "page" : undefined}
                        title={e.failed ? `${e.name} — didn't load` : `${e.name} — ${e.count}`}
                        aria-label={
                          e.failed ? `${e.name} (didn't load)` : `${e.name} (${e.count})`
                        }
                        onClick={() => pickCgEntry(e.id)}
                      >
                        <span className="railpipeini" aria-hidden="true">
                          {e.initials}
                        </span>
                        <span className="railpipename">{e.name}</span>
                        <span className="railpipecount">{e.failed ? "—" : e.count}</span>
                      </button>
                    ))}
                  </Fragment>
                );
              })}

          {cgEmptyCause ? (
            <>
              <div className="railpipenote">{RECRUITING_EMPTY_LINE[cgEmptyCause]}</div>
              <button
                type="button"
                className={railWhere === "caregivers" ? "railopen active" : "railopen"}
                title={`${RECRUITING_EMPTY_LINE[cgEmptyCause]} Open Recruiting.`}
                aria-label="Open Recruiting"
                onClick={() => setView("caregivers")}
              >
                <IconPeople />
                <span className="railopenlabel">Open Recruiting</span>
              </button>
            </>
          ) : null}
        </div>
        <div className="raildiv" aria-hidden="true" />

        <button
          className={railWhere === "referrals" ? "railsec active" : "railsec"}
          title="Referral partners, the touch cadence they are owed, and events"
          type="button"
          onClick={() => setView("referrals")}
        >
          <IconShare />
          <span>Referrals</span>
        </button>

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

        {canSeeMaster && (
          <button
            className={railWhere === "kpi" ? "railsec active" : "railsec"}
            title="Stage moves per rep and per case manager"
            type="button"
            onClick={() => setView("kpi")}
          >
            <IconMoves />
            <span>Moves</span>
          </button>
        )}

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

        <div className="railbuild" title={`Round ${BUILD.round} — ${BUILD.summary}`}>
          {BUILD_LABEL}
        </div>
        <button
          type="button"
          className="railcollapse"
          aria-pressed={railIsCollapsed}
          aria-label={railIsCollapsed ? "Expand the sidebar" : "Collapse the sidebar"}
          title={railIsCollapsed ? "Expand the sidebar" : "Collapse the sidebar"}

          onClick={toggleRail}
        >
          {railIsCollapsed ? "»" : "«"}
        </button>
      </nav>

      <div className="main">
        <div className="topbar">
          <div className="title">

            {view === "caregivers" ? (
              <div className="rfhead rechead">

                <h1 className="rechead-h">
                <button
                  type="button"
                  className="rfdiv"
                  aria-haspopup="listbox"
                  aria-expanded={cgGroupOpen}
                  onClick={() => setCgGroupOpen((o) => !o)}
                  title="Switch between applicants and staff — everything below changes with it"
                >
                  <span className="rfdivname">
                    <span className="pipe" /> {screenHeader.title}
                  </span>
                  <svg className="rfcar" viewBox="0 0 10 6" aria-hidden="true">
                    <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                </button>
                </h1>
                {cgGroupOpen ? (
                  <ul className="rfdivpop" role="listbox" aria-label="Recruiting group">
                    {recruitingGroupOptions(cgOdpOnly).map(({ key: k, label, hint }) => (
                      <li key={k} role="option" aria-selected={k === cgGroup}>
                        <button
                          type="button"
                          className={k === cgGroup ? "on" : ""}
                          onClick={() => {
                            setCgGroup(k);

                            setCgPipeline("all");
                            setCgGroupOpen(false);
                          }}
                        >
                          <span>
                            {label}
                            <span className="cghint">{hint}</span>
                          </span>
                          {k === cgGroup ? <span className="rftick">✓</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <small>{screenHeader.sub}</small>
              </div>
            ) : (
              <>
                <h1>
                  <span className="pipe" /> {screenHeader.title}
                </h1>
                <small>{screenHeader.sub}</small>
              </>
            )}
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

              <span title={sso.reason}>
                {sso.answered || !sso.embedded ? "No SSO session" : "Awaiting sign-in"}
              </span>
            )}
          </div>

          {(view === "list" || view === "board") && !(sortingOn && sortTab === "staffing") ? (
            <button
              type="button"
              className="addclientbtn"
              onClick={() => setAddOpen(true)}
              title="Create a new lead and their case"
            >
              + Add Lead
            </button>
          ) : null}

          {railWhere === "caregivers" ? (
            <button
              type="button"
              className="addclientbtn"
              onClick={() => setAddCgOpen(true)}
              title="Create a new applicant and their application"
            >
              + Add Applicant
            </button>
          ) : null}

          <button
            type="button"
            className="refreshbtn"
            onClick={() =>

              railWhere === "caregivers"
                ? void (async () => {
                    cgTried.current = false;
                    await loadCaregivers();
                    await load();
                  })()
                :

                  railWhere === "referrals"
                  ? setRefReload((n) => n + 1)
                  : void (async () => {
                      await load();
                      cgTried.current = false;
                      await loadCaregivers();
                    })()
            }

            disabled={railWhere === "referrals" ? refBusy : refreshing}
            title={
              railWhere === "caregivers"
                ? `Re-read the ${cgNoun.many} from GoHighLevel`
                : railWhere === "referrals"
                  ? "Re-read the partners, and measure their last contact again"
                  : "Re-read everything from GoHighLevel"
            }
          >
            <IconRefresh />
            {(railWhere === "referrals" ? refBusy : refreshing)
              ? "Refreshing…"
              : "Refresh"}
          </button>

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
              className={(sortingOn ? sortView === "list" : view === "list") ? "on" : ""}
              onClick={() => {
                if (sortingOn) setSortView("list");
                else setView("list");
              }}
              type="button"
            >
              <IconList />
              List
            </button>
            <button
              className={(sortingOn ? sortView === "board" : view === "board") ? "on" : ""}
              onClick={() => {
                if (sortingOn) setSortView("board");
                else setView("board");
              }}
              type="button"
            >
              <IconBoard />
              Kanban
            </button>

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

        {staleError ? (
          <div className="loadwarn">
            <b>Couldn&apos;t refresh.</b> {staleError.error}{" "}
            {staleError.detail ? `${staleError.detail} ` : ""}
            The {data.length} records on screen are from the last load that
            worked — they are still real, just not newer than this failure.{" "}

            <button type="button" className="linkbtn" onClick={() => load()} disabled={refreshing}>
              Try again
            </button>
          </div>
        ) : null}

        {(view === "list" || view === "board") && !sortingOn && (
        <>

        {sortCounts.newleads || (showStaffingTab && sortCounts.staffing) ? (

          <div className="sortwaiting" role="status">
            {sortCounts.newleads ? (
              <button type="button" className="sortwait new" onClick={() => pickSortTab("newleads")}>
                <i className="pulse" aria-hidden="true" />
                <b>{sortCounts.newleads}</b> {sortCounts.newleads === 1 ? "lead" : "leads"} waiting to be sorted in{" "}
                {tabLabels.newLeads}
                <span aria-hidden="true">→</span>
              </button>
            ) : null}
            {showStaffingTab && sortCounts.staffing ? (
              <button type="button" className="sortwait staff" onClick={() => pickSortTab("staffing")}>
                <i className="pulse" aria-hidden="true" />
                <b>{sortCounts.staffing}</b> waiting for an owner in {tabLabels.staffingTab}
                <span aria-hidden="true">→</span>
              </button>
            ) : null}
          </div>
        ) : null}

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

            <button type="button" className="linkbtn" onClick={() => load()} disabled={refreshing}>
              Try again
            </button>
          </div>
        ) : null}
        <div className="stats">
          <div className="stat">

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
                  <button
                    type="button"
                    key={x.k}
                    className={`srcpick${clientF("office", x.k) ? " on" : ""}`}
                    onClick={() => setClientF("office", x.k)}
                    title={
                      clientF("office", x.k)
                        ? `Showing ${x.k} only — click to clear`
                        : `Show ${x.k} only (${x.n})`
                    }
                  >
                    <b>{x.n}</b> {x.k.split(" ")[0]}
                  </button>
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
                  <button
                    type="button"
                    key={x.id}
                    className={`srcpick${clientF("rep", x.id) ? " on" : ""}`}
                    onClick={() => setClientF("rep", x.id)}
                    title={
                      clientF("rep", x.id)
                        ? `Showing ${x.k} only — click to clear`
                        : `Show ${x.k} only (${x.n})`
                    }
                  >
                    <b>{x.n}</b> {x.k.split(" ")[0]}
                  </button>
                ))
              ) : (
                <span className="muted">none assigned</span>
              )}
            </div>
          </div>

          <button
            type="button"
            className={`stat blk statbtn${clientF("blocked") ? " on" : ""}`}
            onClick={() => setClientF("blocked")}
            disabled={stats.blocked === 0}
            title={
              clientF("blocked")
                ? "Showing road-blocked only — click to clear"
                : `Show the ${stats.blocked} road-blocked only`
            }
          >
            <div className="k">Road-blocked</div>
            <div className="v">{stats.blocked}</div>
            <div className="sub">need attention</div>
          </button>
          <button
            type="button"
            className={`stat ok statbtn${clientF("checked") ? " on" : ""}`}
            onClick={() => setClientF("checked")}
            disabled={stats.checked === 0}
            title={
              clientF("checked")
                ? "Showing checked-this-week only — click to clear"
                : `Show the ${stats.checked} checked this week only`
            }
          >
            <div className="k">Checked this week</div>
            <div className="v">{stats.checked}</div>
            <div className="sub">{stats.auth} at authorization</div>
          </button>

          <button
            type="button"
            className={`stat statbtn${clientF("rep", "") ? " on" : ""}`}
            data-tile="unassigned"
            onClick={() => setClientF("rep", "")}
            disabled={filtered.filter((r) => !r.ownerId).length === 0}
            title={
              clientF("rep", "")
                ? "Showing unassigned only — click to clear"
                : "Show only cases with no owner"
            }
          >
            <div className="k">Unassigned</div>
            <div className="v">{filtered.filter((r) => !r.ownerId).length}</div>
            <div className="sub">no owner · anyone here can take one</div>
          </button>
        </div>

        {clientFocus ? (
          <div className="mfocus">
            Showing{" "}
            <b>
              {clientFocus.kind === "blocked"
                ? "road-blocked records"
                : clientFocus.kind === "checked"
                  ? "records checked this week"
                  : clientFocus.kind === "rep" && clientFocus.value === ""
                    ? "unassigned records"
                    : clientFocus.kind === "rep"
                      ?

                        `rep: ${
                          stats.repStats.find((x) => x.id === clientFocus.value)?.k ||
                          clientFocus.value
                        }`
                      : `${clientFocus.kind}: ${clientFocus.value}`}
            </b>{" "}
            —{" "}
            <button type="button" onClick={() => setClientFocus(null)}>
              show every record
            </button>
          </div>
        ) : null}

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

        <div className="toolbar filterbar">
          <SearchBox
            which="clients"
            placeholder="Search by client, office, stage, caregiver, case manager…"
            value={q}
            onChange={setQ}
            chips={peopleChips}
            suggestions={clientSuggestions}
            onPick={pickClientSuggestion}
          />
          <div className="filters">

          {!isAdminViewer &&
          (scopeOptions.divisions.length > 1 || scopeOptions.anyShared) ? (
            <div className="officefilter">
              <label htmlFor="scopeSel">Show</label>
              <select
                id="scopeSel"
                className={scope !== "all" ? "on" : undefined}
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

          {selectablePipelines.length > 1 ? (
            <div className="officefilter">
              <label htmlFor="pipeSel">Pipeline</label>
              <select
                id="pipeSel"
                className={adminPipeline !== "all" ? "on" : undefined}
                value={adminPipeline}
                onChange={(e) => setAdminPipeline(e.target.value)}
              >

                <option value="all">All ({sidebar.all.count})</option>
                {selectablePipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (
                    {sidebar.counts[p.id] == null ? "didn't load" : sidebar.counts[p.id]})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <CreatedFilter
            id="createdSel"
            range={createdRange}
            onRange={setCreatedRange}
            from={createdFrom}
            onFrom={setCreatedFrom}
            to={createdTo}
            onTo={setCreatedTo}
            undated={clientUndated}
          />
          <div className="officefilter">
            <label htmlFor="officeSel">Office</label>
            <select
              id="officeSel"
              className={office !== "all" ? "on" : undefined}
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
          </div>
          <div className="viewctls">
          <div className="officefilter">
            <label htmlFor="sortSel">Sort</label>
            <select
              id="sortSel"
              value={sortKey ?? ""}
              onChange={(e) => setSortKey(e.target.value || null)}
            >

              <option value="">Latest activity</option>
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
          </div>
          <span className="count">

            {view === "board" ? boardFocused.length : visible.length} shown ·{" "}
            {clientFocus
              ? `${view === "board" ? boardVisible.length : filtered.length} before this filter`
              : `${scopedTotal} in ${headerLabel}`}
          </span>
        </div>

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

              <span className="n">
                {preStage.filter((r) => r.stage === st).length}
              </span>
            </button>
          ))}
        </div>
        ) : null}
        </>
        )}

        {view === "caregivers" ? (

          cgView === "resources" ? (
            resourcesPane
          ) : cgLoading && cgData.length === 0 ? (
            <div className="statewrap">
              <div className="statecard">
                <div className="spinner" />
                <h3>Loading {cgNoun.many}…</h3>
              </div>
            </div>
          ) : cgLoadFailed ? (
            <div className="statewrap">
              <div className="statecard">
                <h3>
                  <span className="errdot">●</span> Couldn&apos;t load {cgNoun.many}
                </h3>
                <p>{cgLoadFailed.error}</p>
                {cgLoadFailed.detail ? (
                  <div className="detail">{cgLoadFailed.detail}</div>
                ) : null}
                <button className="retry" onClick={loadCaregivers} type="button" disabled={refreshing}>
                  Try again
                </button>
              </div>
            </div>
          ) : cgVisiblePipelines.length === 0 ? (

            <div className="empty noaccess">{recruitingEmpty}</div>
          ) : (
            <>
              {cgStaleError ? (
                <div className="loadwarn">
                  <b>Couldn&apos;t refresh {cgNoun.many}.</b> {cgStaleError.error}{" "}
                  {cgStaleError.detail ? `${cgStaleError.detail} ` : ""}
                  The {cgCount(cgData.length)} below are from the last load
                  that worked.{" "}
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => loadCaregivers()}
                    disabled={refreshing}
                  >
                    Try again
                  </button>
                </div>
              ) : null}

              {cgFailedPipelines.length ? (
                <div className="loadwarn">
                  <b>
                    {cgFailedPipelines.length === 1
                      ? `${cgFailedPipelines[0].name} didn't load.`
                      : `${cgFailedPipelines.length} pipelines didn't load.`}
                  </b>{" "}
                  {cgFailedPipelines.length > 1
                    ? cgFailedPipelines.map((f) => f.name).join(", ") + ". "
                    : ""}
                  Its {cgNoun.many} are missing from this list — it is not an
                  empty pipeline.{" "}
                  <button
                    type="button"
                    className="linkbtn"
                    onClick={() => {
                      cgTried.current = false;
                      void loadCaregivers();
                    }}

                    disabled={refreshing}
                  >
                    Try again
                  </button>
                </div>
              ) : null}

              <div className="stats">
                <div className="stat gold">
                  <div className="k">Unassigned</div>
                  <div className="v">{cgStats.unassigned}</div>
                  <div className="sub">
                    {cgStats.unassigned === 0
                      ? `every ${cgNoun.one} has a recruiter`
                      : `of ${cgFocused.length} shown · nobody is calling them`}
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
                      : `no stage dates on the ${cgNoun.many} shown`}
                  </div>
                </div>

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

                    <button
                      type="button"
                      className={`srcpick${cgF("recruiter", "") ? " on" : ""}`}
                      onClick={() => setCgF("recruiter", "")}
                      title={`Show unassigned ${cgNoun.many} only`}
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
                  title={`Show ${cgNoun.many} ${STALL_DAYS}+ days in stage`}
                >
                  <div className="k">Stalled</div>
                  <div className="v">
                    {cgStats.stalled}
                    {cgStats.noDate ? (
                      <span className="vsub"> · {cgStats.noDate} no date</span>
                    ) : null}

                    {cgStats.approx ? (
                      <span className="vsub"> · {cgStats.approx} approx</span>
                    ) : null}
                  </div>
                  <div className="sub">
                    {STALL_DAYS}+ days in stage
                    {cgStats.noDate
                      ? ` · ${cgStats.noDate} without a stage date`
                      : ""}
                    {cgStats.approx
                      ? ` · ${cgStats.approx} dated from GoHighLevel rather than the stage log`
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
                    show every {cgNoun.one}
                  </button>
                </div>
              ) : null}
              <div className="toolbar mtoolbar filterbar">
                <SearchBox
                  which="recruiting"
                  placeholder={`Search ${cgNoun.many} by name…`}
                  value={cgQuery}
                  onChange={setCgQuery}
                  chips={cgChips}
                  suggestions={cgSuggestions}
                  onPick={pickCgSuggestion}
                  leadsLabel={cgNoun.many.charAt(0).toUpperCase() + cgNoun.many.slice(1)}
                />
                <div className="filters">
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
                          {cgSidebar.counts[p.id] == null ? "didn't load" : cgSidebar.counts[p.id]})
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                <CreatedFilter
                  id="cgCreatedSel"
                  range={cgCreatedRange}
                  onRange={setCgCreatedRange}
                  from={cgCreatedFrom}
                  onFrom={setCgCreatedFrom}
                  to={cgCreatedTo}
                  onTo={setCgCreatedTo}
                  undated={cgUndated}
                />
                </div>
                <div className="viewctls">
                <div className="officefilter">
                  <label htmlFor="cgSortSel">Sort</label>
                  <select
                    id="cgSortSel"
                    value={cgSortKey || ""}
                    onChange={(e) => setCgSortKey(e.target.value || null)}
                  >
                    <option value="">Latest activity</option>
                    {CG_COLUMNS.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>

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
                </div>
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
                </div>

                <span className="count">
                  {cgFocus ? (
                    <>
                      {cgFocused.length} shown · {cgCount(cgVisible.length)} before this filter
                    </>
                  ) : (
                    cgCount(cgVisible.length)
                  )}

                  {cgOwnerLabel ? (
                    <>
                      {" · "}
                      {cgOwnerLabel}{" "}
                      <button type="button" className="linkbtn" onClick={() => setCgOwnerF(EVERYONE)}>
                        Show everyone
                      </button>
                    </>
                  ) : null}
                  {cgDateLabel ? (
                    <>
                      {" · "}
                      {cgDateLabel}{" "}
                      <button
                        type="button"
                        className="linkbtn"
                        onClick={() => {
                          setCgCreatedRange("all");
                          setCgCreatedFrom("");
                          setCgCreatedTo("");
                        }}
                      >
                        Show all dates
                      </button>
                    </>
                  ) : null}
                </span>
              </div>

              {cgData.length === 0 && !cgQuery.trim() && !cgStage && !cgFocus ? (
                <div className="imeta cgempty">
                  No {cgNoun.many} yet — the{" "}
                  {cgVisiblePipelines.length === 1
                    ? "pipeline is"
                    : `${cgVisiblePipelines.length} pipelines are`}{" "}
                  empty. Nothing is filtered out.
                </div>
              ) : null}

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
                  {cgFocused.length === 0 ? (
                    <div className="empty">
                      No {cgNoun.many} match this filter.

                      {(() => {
                        const on: string[] = [];
                        if (cgQuery.trim()) on.push(`search “${cgQuery.trim()}”`);
                        if (cgOwnerLabel) on.push(cgOwnerLabel);
                        if (cgDateLabel) on.push(cgDateLabel);
                        if (cgStage) on.push(`stage ${cgStage}`);
                        if (cgFocus) on.push("a tile above");
                        return on.length ? ` Active: ${on.join(" · ")}.` : null;
                      })()}

                    </div>
                  ) : null}
                </div>
              ) : (
              <>
              {dragSaveErr()}

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

                  const inCol = cgFocused.filter((r) => r.stage === st);
                  return (
                    <BoardColumn key={st} stage={st} count={inCol.length}>
                      {inCol.length ? (
                        inCol.map((r) => (
                          <BoardCard
                            key={r.id}
                            r={r}

                            canDrag={canEdit(r)}
                            following={followsNotOwns(r)}

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
                  const r = dragId ? cgData.find((x) => x.id === dragId) : null;
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
              </>
              )}
            </>
          )
        ) : view === "referrals" ? (

          <ReferralsSection

            onOpenRecord={(id) => setSelId(id)}
            canOpenRecord={(id) => data.some((r) => r.id === id)}
            ssoBlob={sso.blob}

            ssoReady={ssoResolved(sso)}
            reloadToken={refReload}
            onBusy={setRefBusy}

            cache={refCache.current}
            onCache={rememberReferrals}
          />
        ) : view === "access" ? (
          isAdminViewer ? (
            <div className="scroll adminscroll">
              <PipelineAccessTab
                ssoBlob={sso.blob}
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

            <div className="scroll adminscroll">
              <PipelineAdmin
                ssoBlob={sso.blob}

                recordCounts={recordCounts}
                countsComplete={cgLoaded}

                countFieldValues={countFieldValues}

                labels={tabLabelsKnown ? tabLabelsRaw : undefined}
                onLabelsSaved={(labels) => setTabLabelsRaw(labels)}
                onConfigSaved={(folders, exclusions, sidebarHidden) => {
                  setPipelineFolders(folders);
                  setPipelineExclusions(exclusions);

                  setPipelineSidebarHidden(sidebarHidden);
                  setCgSidebarHidden(sidebarHidden);
                }}
              />
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
              <ImportWizard ssoBlob={sso.blob} />
            </div>
          ) : (
            <div className="empty">
              <b>Admins only</b>
              <br />
              The bulk import tool is restricted to admin users.
            </div>
          )
        ) : view === "kpi" ? (

          !canSeeMaster ? (
            <div className="empty">
              <b>Not enabled for you</b>
              <br />
              Moves is granted with the Master view, in the Access tab.
            </div>
          ) : (

            <div className="scroll mvwrap">
              <div className="mvhead">
                <h2 className="mvtitle">Moves</h2>

                <div className="mvseg">
                  {(
                    [
                      ["week", "This week"],
                      ["month", "This month"],
                      ["lastMonth", "Last month"],
                      ["all", "All recorded"],
                      ["custom", "Custom"],
                    ] as [KpiRange, string][]
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      className={kpiRange === k ? "on" : ""}
                      onClick={() => { setKpiRange(k); setDrill(null); }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="kpifilters">
                {kpiRange === "custom" ? (
                  <>
                    <label htmlFor="kpi-from">From</label>
                    <input
                      id="kpi-from" type="date" value={kpiFrom}
                      onChange={(e) => { setKpiFrom(e.target.value); setDrill(null); }}
                    />
                    <label htmlFor="kpi-to">To</label>
                    <input
                      id="kpi-to" type="date" value={kpiTo}
                      onChange={(e) => { setKpiTo(e.target.value); setDrill(null); }}
                    />
                  </>
                ) : null}

                {kpiPipes.length > 1 ? (
                  <>
                    <label htmlFor="kpi-pipe">Pipeline</label>
                    <select
                      id="kpi-pipe" value={kpiPipe}
                      onChange={(e) => { setKpiPipe(e.target.value); setDrill(null); }}
                    >
                      <option value="">All pipelines</option>
                      {kpiPipes.map(([id, name]) => (
                        <option key={id} value={id}>{name}</option>
                      ))}
                    </select>
                  </>
                ) : null}
                {kpiDivs.length > 1 ? (
                  <>
                    <label htmlFor="kpi-div">Division</label>
                    <select
                      id="kpi-div" value={kpiDiv}
                      onChange={(e) => { setKpiDiv(e.target.value); setDrill(null); }}
                    >
                      <option value="">All divisions</option>
                      {kpiDivs.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </>
                ) : null}
                <span className="kpiden">
                  from the <b>{kpiRecords.length}</b> record
                  {kpiRecords.length === 1 ? "" : "s"} you can see
                  {kpiRecords.length !== data.length
                    ? ` · ${data.length - kpiRecords.length} filtered out`
                    : ""}
                </span>
              </div>

              <div className="mvnotes">
                <p>
                  <b>
                    {kpi.since
                      ? `Recording since ${formatEasternDay(kpi.since)}.`
                      : "Nothing recorded yet."}
                  </b>{" "}
                  Moves before then were never captured, so an early month reads
                  near zero and that is correct — not a fault.
                </p>
                <p>
                  Counting <b>{kpi.moves}</b> move
                  {kpi.moves === 1 ? "" : "s"} across{" "}
                  <b>{kpi.recordsWithHistory}</b> record
                  {kpi.recordsWithHistory === 1 ? "" : "s"}

                  <span className="mvscope">
                    {" "}
                    — from the {kpi.recordsScanned} record
                    {kpi.recordsScanned === 1 ? "" : "s"} you can see. Someone
                    with different pipeline access sees different totals.
                  </span>
                </p>

                {kpi.unknownOrigin ? (
                  <p>
                    <b>
                      {kpi.unknownOrigin} move
                      {kpi.unknownOrigin === 1 ? "" : "s"} had an unknown
                      starting stage
                    </b>{" "}
                    — counted above. The log&rsquo;s first row records where a
                    case arrived, not where it came from, so these are known to
                    have moved and not known from where.
                  </p>
                ) : null}
                {kpi.creationRows ? (
                  <p>
                    <b>
                      {kpi.creationRows} row
                      {kpi.creationRows === 1 ? "" : "s"} were the case being
                      created
                    </b>{" "}
                    and are not counted — the workflow fires on creation too,
                    and a case appearing has not gone anywhere. Identified by
                    landing within five minutes of the case&rsquo;s own created
                    time — measured live twice, the workflow takes about 60
                    seconds to write that row.
                  </p>
                ) : null}
                {kpi.unattributed ? (
                  <p>
                    <b>{kpi.unattributed} move
                    {kpi.unattributed === 1 ? "" : "s"} had no owner</b> and are
                    credited to nobody, so the rep column adds up to{" "}
                    {kpi.moves - kpi.unattributed}, not {kpi.moves}.
                  </p>
                ) : null}
                {kpi.missedMoves ? (
                  <p>
                    <b>{kpi.missedMoves} record
                    {kpi.missedMoves === 1 ? "" : "s"} moved without being
                    recorded</b> — the log&rsquo;s last entry disagrees with
                    where the record actually is. A gap is a gap, not a zero.
                  </p>
                ) : null}
                {kpi.skipped ? (
                  <p className="mvbad">
                    <b>{kpi.skipped} unreadable row
                    {kpi.skipped === 1 ? "" : "s"}</b> were skipped. Expected to
                    be none — worth looking at.
                  </p>
                ) : null}
              </div>

              <div className="mvcols">
                <div className="mvcol">
                  <h3>
                    Moves per rep
                    <span className="mvsub">
                      one move, one rep. These sum to the total.
                    </span>
                  </h3>
                  <MovesTable rows={kpi.perRep} label={userLabel} />
                </div>
                <div className="mvcol">
                  <h3>
                    Moves per case manager

                    <span className="mvsub">
                      one move counted for <i>each</i> watching manager — these
                      sum to more than {kpi.moves}.
                    </span>
                  </h3>
                  <MovesTable rows={kpi.perManager} label={userLabel} />
                  {kpi.unmanaged ? (
                    <div className="mvfoot">
                      {kpi.unmanaged} move{kpi.unmanaged === 1 ? "" : "s"} had no
                      case manager recorded.
                    </div>
                  ) : null}
                </div>
              </div>

              {funnels.length ? (
                <div className="kpiblock">
                  <h3>Stage funnel</h3>
                  <p className="kpinote">
                    Reached each stage since recording began on{" "}
                    {kpi.since ? formatEasternDay(kpi.since) : "—"} — a case that
                    passed through before then is not counted.
                  </p>
                  {funnels.map((fn) => (
                    <div key={fn.pipelineId} className="kpifunnel">
                      <h4>{fn.pipelineName}</h4>
                      <table className="kpitable">
                        <thead>
                          <tr><th>Stage</th><th>Reached</th><th>Moved on</th><th>%</th></tr>
                        </thead>
                        <tbody>
                          {fn.rows.map((fr) => (
                            <tr key={fr.stageId}>
                              <td>{fr.name}</td>
                              <td>
                                <button
                                  type="button" className="kpinum"
                                  disabled={!fr.reached}
                                  onClick={() => setDrill({
                                    title: `Reached ${fr.name} — ${fn.pipelineName}`,
                                    ids: fr.caseIds,
                                  })}
                                >{fr.reached}</button>
                              </td>
                              <td>
                                <button
                                  type="button" className="kpinum"
                                  disabled={!fr.movedOn}
                                  onClick={() => setDrill({
                                    title: `Moved on from ${fr.name} — ${fn.pipelineName}`,
                                    ids: fr.movedOnIds,
                                  })}
                                >{fr.movedOn}</button>
                              </td>

                              <td>{fr.pct === null ? "—" : `${fr.pct}%`}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              ) : null}

              {dwell.recorded.length || dwell.approximate.n ? (
                <div className="kpiblock">
                  <h3>Time in stage</h3>
                  <p className="kpinote">
                    From recorded moves.{" "}
                    {dwell.approximate.n ? (
                      <>
                        <b>{dwell.approximate.n}</b> older case
                        {dwell.approximate.n === 1 ? "" : "s"} use GoHighLevel&rsquo;s
                        stage date, shown separately and approximate.
                      </>
                    ) : (
                      "Every case here has recorded moves."
                    )}{" "}
                    Completed stays only — a case still in a stage has no length yet.
                  </p>
                  <table className="kpitable">
                    <thead>
                      <tr><th>Stage</th><th>Median days</th><th>Average</th><th>Stays</th></tr>
                    </thead>
                    <tbody>
                      {dwell.recorded.map((d) => (
                        <tr key={d.stageId}>
                          <td>{d.name}</td>
                          <td><b>{d.median}</b></td>
                          <td>{d.avg}</td>
                          <td>
                            <button
                              type="button" className="kpinum"
                              onClick={() => setDrill({
                                title: `Stays recorded in ${d.name}`, ids: d.caseIds,
                              })}
                            >{d.n}</button>
                          </td>
                        </tr>
                      ))}
                      {dwell.approximate.n ? (
                        <tr className="kpiapprox">
                          <td>
                            Older cases <i>(approximate)</i>
                          </td>
                          <td><b>{dwell.approximate.median}</b></td>
                          <td>{dwell.approximate.avg}</td>
                          <td>
                            <button
                              type="button" className="kpinum"
                              onClick={() => setDrill({
                                title: "Older cases — days in stage from GoHighLevel",
                                ids: dwell.approximate.caseIds,
                              })}
                            >{dwell.approximate.n}</button>
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {firstMove.perRep.length || firstMove.noFirstMove ? (
                <div className="kpiblock">
                  <h3>Speed to first move</h3>
                  <p className="kpinote">
                    Days from a case being created to its first real move. The
                    creation row is not a move. Cases created before recording
                    began have no first move here
                    {firstMove.noFirstMove ? (
                      <>
                        {" "}— <b>{firstMove.noFirstMove}</b> of them, and they are
                        in no column below.
                      </>
                    ) : (
                      "."
                    )}
                  </p>
                  <table className="kpitable">
                    <thead>
                      <tr><th>Rep</th><th>Median days</th><th>Average</th><th>Cases</th></tr>
                    </thead>
                    <tbody>
                      {firstMove.perRep.map((fr) => (
                        <tr key={fr.id || "none"}>

                          <td>{fr.id ? userLabel(fr.id) : "No owner recorded"}</td>
                          <td><b>{fr.median}</b></td>
                          <td>{fr.avg}</td>
                          <td>
                            <button
                              type="button" className="kpinum"
                              onClick={() => setDrill({
                                title: `First move — ${fr.id ? userLabel(fr.id) : "no owner recorded"}`,
                                ids: fr.caseIds,
                              })}
                            >{fr.n}</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {closed.perRep.length || closed.undated ? (
                <div className="kpiblock">
                  <h3>Won / lost</h3>
                  <p className="kpinote">
                    Dated by the last status change, which a bulk edit can move.
                    Current status only — a case reopened after winning shows as
                    open.
                    {closed.undated ? (
                      <>
                        {" "}
                        <b>{closed.undated}</b> closed case
                        {closed.undated === 1 ? "" : "s"} carry no status date and
                        cannot be placed in a period, so they are counted here and
                        nowhere else.
                      </>
                    ) : null}
                  </p>
                  <table className="kpitable">
                    <thead>
                      <tr><th>Rep</th><th>Won</th><th>Lost</th><th>Win rate</th></tr>
                    </thead>
                    <tbody>
                      {closed.perRep.map((cr) => (
                        <tr key={cr.id || "none"}>
                          <td>{cr.id ? userLabel(cr.id) : "Unassigned"}</td>
                          <td>
                            <button
                              type="button" className="kpinum" disabled={!cr.won}
                              onClick={() => setDrill({
                                title: `Won — ${cr.id ? userLabel(cr.id) : "unassigned"}`,
                                ids: cr.wonIds,
                              })}
                            >{cr.won}</button>
                          </td>
                          <td>
                            <button
                              type="button" className="kpinum" disabled={!cr.lost}
                              onClick={() => setDrill({
                                title: `Lost — ${cr.id ? userLabel(cr.id) : "unassigned"}`,
                                ids: cr.lostIds,
                              })}
                            >{cr.lost}</button>
                          </td>
                          <td>{cr.winRate === null ? "—" : `${cr.winRate}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {drill ? (
                <div className="kpidrill">
                  <div className="kpidrillhead">
                    <b>{drill.title}</b>
                    <span className="kpiden">{drill.ids.length} case
                      {drill.ids.length === 1 ? "" : "s"}</span>
                    <button type="button" className="ighost" onClick={() => setDrill(null)}>
                      Close
                    </button>
                  </div>
                  <ul>
                    {drill.ids.map((id) => {
                      const rec = kpiRecords.find((x) => x.id === id);
                      return (
                        <li key={id}>
                          <button
                            type="button"
                            className="kpicase"
                            onClick={() => setSelId(id)}
                          >
                            {rec
                              ? `${rec.oppName || `${rec.first} ${rec.last}`.trim() || "Untitled"} · ${rec.pipelineName} · ${rec.stage}`
                              : id}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}

              {kpi.clusters.length ? (
                <div className="mvclust">
                  <h3>Bulk-looking clusters</h3>
                  <p>
                    Many records entering one stage inside one minute. Shown, not
                    removed — whether these count is yours to decide, and
                    changing your mind costs nothing because the rows are
                    untouched.
                  </p>
                  <ul>
                    {kpi.clusters.map((c) => (
                      <li key={`${c.at}|${c.to}`}>
                        <b>{c.records} records</b> at {c.at.replace("T", " ")} —{" "}
                        {stageName(c.to)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )
        ) : view === "master" ? (

          !canSeeMaster ? (
            <div className="empty">
              <b>Not enabled for you</b>
              <br />
              The Master view is granted per user in the Access tab.
            </div>
          ) : showSpinner ? (
            <div className="statewrap">
              <div className="statecard">
                <div className="spinner" />
                <h3>Loading opportunities…</h3>
              </div>
            </div>
          ) : loadFailed ? (
            <div className="statewrap">
              <div className="statecard">
                <h3>
                  <span className="errdot">●</span> Couldn&apos;t load
                  opportunities
                </h3>
                <p>{loadFailed.error}</p>
                {loadFailed.detail ? (
                  <div className="detail">{loadFailed.detail}</div>
                ) : null}
                <button className="retry" onClick={load} type="button" disabled={refreshing}>
                  Try again
                </button>
              </div>
            </div>
          ) : masterColumns.length === 0 ? (
            <NoAccessNotice />
          ) : (
            <>
              <div className="toolbar mtoolbar filterbar">
                <SearchBox
                  which="master"
                  placeholder="Search by client name…"
                  value={q}
                  onChange={setQ}
                  chips={peopleChips}
                  suggestions={masterSuggestions}
                  onPick={pickClientSuggestion}
                />
                <div className="filters">
                <div className="officefilter">
                  <label htmlFor="mofficeSel">Office</label>
                  <select
                    id="mofficeSel"
                    className={office !== "all" ? "on" : undefined}
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

                <CreatedFilter
                  id="mcreatedSel"
                  range={masterCreatedRange}
                  onRange={setMasterCreatedRange}
                  from={masterCreatedFrom}
                  onFrom={setMasterCreatedFrom}
                  to={masterCreatedTo}
                  onTo={setMasterCreatedTo}
                  undated={masterUndated}
                />
                </div>
                {(() => {

                  const shown = masterColumns.reduce((n, c) => n + c.records.length, 0);
                  const total = data.length;
                  const on: string[] = [];
                  if (q.trim()) on.push(`search “${q.trim()}”`);
                  if (office !== "all") on.push(`office ${office}`);
                  const ow = describeOwner(ownerF, ownerNameMap, "sales rep");
                  if (ow) on.push(ow);
                  if (cmF) on.push(`case manager ${cmF}`);
                  const cw = describeWindow(masterCreatedRange, masterWin);
                  if (cw) on.push(cw);
                  if (masterFocus) on.push(focusLabel(masterFocus));
                  return (
                    <span className="count">
                      {shown === total
                        ? `${total} record${total === 1 ? "" : "s"}`
                        : `Showing ${shown} of ${total} records`}
                      {on.length ? (
                        <>
                          {" · filtered by "}
                          {on.join(", ")}{" "}
                          <button
                            type="button"
                            className="linkbtn"

                            title="Also clears the search, office, sales rep and case manager on the Clients board — those are shared."
                            onClick={() => {
                              setQ("");
                              setOffice("all");
                              setMasterCreatedRange("all");
                              setMasterCreatedFrom("");
                              setMasterCreatedTo("");
                              setMasterFocus(null);
                              setOwnerF(EVERYONE);
                              setCmF("");
                            }}
                          >
                            Clear filters
                          </button>
                        </>
                      ) : null}
                    </span>
                  );
                })()}
              </div>

              <div className="stats mstats">
                <div className="stat">
                  <div className="k">By pipeline</div>

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

                <div className="stat gold wide">
                  <div className="k">By owner</div>
                  <div className="mini" style={{ marginTop: 9 }}>

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

                    {masterStats.noDate ? (
                      <span className="vsub"> · {masterStats.noDate} no date</span>
                    ) : null}

                    {masterStats.approx ? (
                      <span className="vsub"> · {masterStats.approx} approx</span>
                    ) : null}
                  </div>
                  <div className="sub">
                    {STALL_DAYS}+ days in stage
                    {masterStats.noDate
                      ? ` · ${masterStats.noDate} record${
                          masterStats.noDate === 1 ? " has" : "s have"
                        } no stage date, so cannot be judged`
                      : ""}
                    {masterStats.approx
                      ? ` · ${masterStats.approx} dated from GoHighLevel rather than the stage log, which a bulk edit can move`
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
                  setDropRefused(null);
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
                      staffingLabel={tabLabels.staffingStage}
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
                            age={ageOf(r)}
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
                        <div className="mstage">{stageDisplay(r.stage || "—", tabLabels)}</div>
                      </div>
                    ) : null;
                  })()}
                </DragOverlay>
              </DndContext>
            </>
          )
        ) : view === "resources" ? (
          resourcesPane
        ) : ssoWaiting(sso) ? (

          <div className="statewrap">
            <div className="statecard">
              <div className="spinner" />
              <h3>Waiting for GoHighLevel…</h3>
              <p>{sso.status === "none" ? sso.reason : "Asking for your session."}</p>
              {sso.status === "none" ? (
                <button type="button" className="ibtn" onClick={sso.retry}>
                  Ask again
                </button>
              ) : null}
            </div>
          </div>
        ) : showSpinner ? (
          <div className="statewrap">
            <div className="statecard">
              <div className="spinner" />
              <h3>Loading opportunities…</h3>
              <p>Fetching live records from GoHighLevel.</p>
            </div>
          </div>
        ) : loadFailed ? (
          <div className="statewrap">
            <div className="statecard">
              <h3>
                <span className="errdot">●</span> Couldn&apos;t load
                opportunities
              </h3>
              <p>{loadFailed.error}</p>
              {loadFailed.detail ? (
                <div className="detail">{loadFailed.detail}</div>
              ) : null}
              <button className="retry" onClick={load} type="button" disabled={refreshing}>
                Try again
              </button>
            </div>
          </div>
        ) : sortingOn ? (
          <SortingTab
            key={sortTab || "x"}
            kind={sortTab === "staffing" ? "staffing" : "newleads"}
            records={
              sortTab === "staffing"
                ? data.filter((r) => isStaffingStage(r.stage) && !r.ownerId)
                : data.filter((r) => isNewLeadStage(r.stage))
            }
            view={sortView}
            allRecords={data}
            sortedFieldId={sortedFieldId}
            isAdmin={isAdminViewer}
            SearchBox={SearchBox}

            SourceMark={SourceMarkOrInitial}
            pipelines={(isAdminViewer ? pipelines : pipelines.filter((p) => homePipelineIds.includes(p.id) || data.some((r) => r.pipelineId === p.id)))}
            labels={tabLabels}
            privatePayId={PRIVATE_PAY_PIPELINE_ID}
            can={(r, a) => {
              if (a === "assign") return canAssignStaffing(r, sortViewer, viewerId || "x").ok;
              if (a === "staffing") return canSendToStaffing(r, sortViewer).ok;

              return canSortRule(r, sortViewer, { toPipelineId: r.pipelineId, newOwnerId: "" }).ok;
            }}
            onOpen={(r) => setSelId(r.id)}
            onAction={(r, a: SortAction) => {
              if (a === "staffing") setStaffRec(r);
              else if (a === "assign") setSortReq({ record: r, mode: "assign" });
              else setSortReq({ record: r, mode: "sort", target: a });
            }}
          />
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
                      title={
                        c.key === "created"
                          ? "Sort by when the record was created — times are Eastern, matching GoHighLevel"
                          : `Sort by ${c.label}`
                      }
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

                <div className="empty">
                  <b>Nothing matches the filters in use.</b>
                  <br />
                  {(() => {
                    const on: string[] = [];
                    if (q.trim()) on.push(`search “${q.trim()}”`);
                    if (office !== "all") on.push(`office ${office}`);
                    {
                      const ow = describeOwner(ownerF, ownerNameMap, "sales rep");
                      if (ow) on.push(ow);
                      if (cmF) on.push(`case manager ${cmF}`);
                    }
                    {
                      const cw = describeWindow(createdRange, clientWin);
                      if (cw) on.push(cw);
                    }
                    if (scope !== "all") on.push(`division ${scope}`);
                    if (adminPipeline !== "all")
                      on.push(
                        `pipeline ${
                          pipelines.find((p) => p.id === adminPipeline)?.name ||
                          adminPipeline
                        }`,
                      );
                    if (srcF !== "all") on.push(`source ${srcF}`);
                    if (stageActive && stage !== "all") on.push(`stage ${stage}`);
                    if (clientFocus) on.push(`the ${clientFocus.kind} tile`);
                    return on.length
                      ? `Active: ${on.join(" · ")} — over ${scopedTotal} record${
                          scopedTotal === 1 ? "" : "s"
                        } in ${headerLabel}.`
                      : `No filters are active, and there are ${scopedTotal} records in ${headerLabel} — if this is empty, that is a fault, not a filter.`;
                  })()}
                  {q.trim() ? (
                    <>
                      <br />
                      Search compares the opportunity name, contact name, office,
                      stage, Harmony ID, case manager, caregiver, rep and source.
                    </>
                  ) : null}
                </div>
              )
            ) : null}
          </div>
        ) : noPipelineAccess ? (

          <NoAccessNotice />
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={(e) => setDragId(String(e.active.id))}
            onDragCancel={() => setDragId(null)}
            onDragEnd={onDragEnd}
          >

            {dragSaveErr()}

            {boardFocused.length === 0 && data.length > 0
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

            {!boardFocused.length ? (
              <div className="board boardempty">
                <div className="boardemptymsg">
                  <b>
                    {filtered.length === scopedTotal && !scopedTotal
                      ? `No cases in ${headerLabel} right now.`
                      : "Nothing matches these filters."}
                  </b>
                  {sortCounts.newleads ? (
                    <span>
                      New leads wait in{" "}
                      <button type="button" className="linkbtn" onClick={() => pickSortTab("newleads")}>
                        {tabLabels.newLeads} ({sortCounts.newleads})
                      </button>{" "}
                      until they're sorted.
                    </span>
                  ) : null}
                </div>
              </div>
            ) : (
            <div className="board">
              {boardStages.map((st) => {

                const inCol = boardFocused.filter((r) => r.stage === st);
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
            )}
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

      {sortReq ? (
        <SortDialog
          key={`sort-${sortReq.record.id}-${sortReq.mode}-${sortReq.target || ""}`}
          mode={sortReq.mode}
          target={sortReq.target}
          record={sortReq.record}
          targets={sortTargets.length ? sortTargets : pipelines}
          homeIds={homePipelineIds}
          isAdmin={isAdminViewer}
          viewerId={viewerId || ""}
          staffing={isAdminViewer ? "admin" : viewerStaffing}
          stagesByPipeline={stagesByPipeline}
          users={users}
          labels={tabLabels}
          ssoBlob={sso.blob}
          peerLabel={
            peerInfo?.configured && canPeerTransferRule(sortReq.record, sortViewer).ok
              ? peerInfo.label
              : null
          }
          onPeerTransfer={() => {
            setTransferRec(sortReq.record);
            setSortReq(null);
          }}
          onClose={() => setSortReq(null)}
          onDone={(rec) => {

            setData((prev) => prev.map((r) => (r.id === rec.id ? rec : r)));
          }}
        />
      ) : null}
      {staffRec ? (
        <ReassignDialog
          key={`staff-${staffRec.id}`}
          record={staffRec}
          ownerName={staffRec.ownerId ? staffRec.rep || userLabel(staffRec.ownerId).split(" — ")[0] : ""}
          ssoBlob={sso.blob}
          stageLabel={tabLabels.staffingStage}
          onClose={() => setStaffRec(null)}
          onDone={(rec) => {
            setData((prev) => prev.map((r) => (r.id === rec.id ? rec : r)));
            setStaffRec(null);
          }}
        />
      ) : null}

      {selected && moveOpen ? (
        <MoveDialog
          key={selected.id}
          record={selected}
          pipelines={pipelines}
          stagesByPipeline={stagesByPipeline}
          users={users}
          ssoBlob={sso.blob}
          onClose={() => setMoveOpen(false)}
          onMoved={(rec, transferred) => {

            setData((prev) => prev.map((r) => (r.id === rec.id ? rec : r)));
            if (transferred) setSelId(null);

          }}
        />
      ) : null}

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

      {masterDrop && masterDrop.cat === "reassign" ? (

        <ReassignDialog
          key={`ra-${masterDrop.record.id}`}
          record={masterDrop.record}
          stageLabel={tabLabels.staffingStage}
          ownerName={
            masterDrop.record.ownerId
              ? masterDrop.record.rep ||
                userLabel(masterDrop.record.ownerId).split(" — ")[0]
              : ""
          }
          ssoBlob={sso.blob}
          onClose={() => setMasterDrop(null)}
          onDone={(rec) => {
            setData((prev) => prev.map((r) => (r.id === rec.id ? rec : r)));
            setMasterDrop(null);
            setSelId(null);

          }}
        />
      ) : masterDrop ? (
        <MoveDialog
          key={`drop-${masterDrop.record.id}-${masterDrop.cat}`}
          record={masterDrop.record}
          pipelines={pipelines}
          stagesByPipeline={stagesByPipeline}
          users={users}
          ssoBlob={sso.blob}
          allowedPipelineIds={pipelinesFor(masterDrop.cat)}

          requireOwner={isReassignStage(masterDrop.record.stage)}
          intro={
            isReassignStage(masterDrop.record.stage) ? (
              <>
                You&apos;re handing{" "}
                <b>
                  {masterDrop.record.oppName ||
                    `${masterDrop.record.first} ${masterDrop.record.last}`.trim()}
                </b>{" "}
                over out of <b>{tabLabels.staffingStage}</b>. Choose the <b>pipeline</b>, the{" "}
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

          }}
        />
      ) : null}

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

      {delRec ? (
        <ConfirmDialog
          title="Delete this case?"
          danger
          body={
            <>
              <p style={{ margin: "0 0 10px" }}>
                Removes <b>{delRec.oppName || `${delRec.first} ${delRec.last}`.trim() || "this record"}</b>{" "}
                from <b>{delRec.pipelineName || "its pipeline"}</b>.
              </p>

              <p style={{ margin: "0 0 10px" }}>
                The contact stays in GoHighLevel with their notes, their other
                cases and their history. Nothing here can delete a person.
              </p>

              <p className="fnote">
                Its source and referral attribution go with it — this lead will
                not appear in any count again. This cannot be undone.
              </p>
            </>
          }
          confirmLabel="Delete this case"
          busy={delBusy}
          error={delErr}
          onConfirm={() => void deleteRecord()}
          onCancel={() => {
            setDelRec(null);
            setDelErr(null);
          }}
        />
      ) : null}

      {transferRec ? (
        <TransferDialog
          record={transferRec}
          ssoBlob={sso.blob}
          peerLabel={peerInfo?.label || "the other account"}
          onTransferred={() => {
            setData((d) => d.filter((r) => r.id !== transferRec.id));
            setCgData((d) => d.filter((r) => r.id !== transferRec.id));
            setSelId(null);
          }}
          onClose={() => setTransferRec(null)}
        />
      ) : null}

      {addCgOpen ? (
        <AddCaregiverDialog
          ssoBlob={sso.blob}

          pipelines={cgPipelines.map((p) => ({ id: p.id, name: p.name }))}
          onClose={() => setAddCgOpen(false)}
          onAdded={(landedIn) => {

            if (landedIn) {
              const g = pipelineGroups[landedIn] === "staff" ? "staff" : "caregiver";
              if (cgGroup !== "all" && cgGroup !== g) setCgGroup(g);

              setCgPipeline(landedIn);
            }
            void loadCaregivers();
          }}
        />
      ) : null}
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
          ssoBlob={sso.blob}
          onClose={() => setAddOpen(false)}
          onCreated={(oppId) => {

            load().then(() => {
              if (oppId) setSelId(oppId);
            });
          }}
        />
      ) : null}

      {selected && emailOpen ? (
        <EmailComposer
          key={selected.id}
          opportunityId={selected.id}
          ssoBlob={sso.blob}
          context={{
            clientFirst: selected.first,
            clientLast: selected.last,
            office: selected.office,
            stage: selected.stage,
          }}
          onClose={() => setEmailOpen(false)}
        />
      ) : null}

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

                <InlineName
                  heading
                  display={enrollLabel(selected)}
                  parts={[{ key: "name", label: "Case name", value: selected.oppName }]}
                  editLabel="Rename this case"
                  disabled={!canEdit(selected)}
                  busy={saveState[skey(selected.id, "oppName")]?.status === "saving"}
                  err={saveState[skey(selected.id, "oppName")]?.err}
                  scope={
                    <>
                      <b>This case only.</b> The person&apos;s name is on the line
                      below and is a different thing.
                    </>
                  }
                  onSave={(v) =>
                    saveField(selected, "oppName", { name: v.name }, (r) => ({
                      ...r,
                      oppName: v.name,
                    }))
                  }
                />
                <div className="sub">
                  {selected.office || "—"} · {selected.stage || "—"}

                  {selected.harmony ? ` · ${selected.harmony.replace("HRM-", "#")}` : ""}
                  {selected.pipelineName ? (
                    <span className="divbadge" title={selected.pipelineName}>
                      {selected.pipelineName}
                    </span>
                  ) : null}
                </div>
                <InlineName
                  what="Person"
                  display={clientName(selected) || selected.contactName}
                  parts={[
                    { key: "firstName", label: "First name", value: cFields?.firstName ?? selected.first },
                    { key: "lastName", label: "Last name", value: cFields?.lastName ?? selected.last },
                  ]}
                  editLabel="Rename this person"
                  disabled={!canEdit(selected) || !selected.contactId || cLoading}
                  busy={cSave[NAME_KEY]?.status === "saving"}
                  err={cSave[NAME_KEY]?.err}
                  scope={
                    <>
                      <b>About this person, not this case.</b>{" "}
                      {cFields && cFields.opportunityCount > 1
                        ? `This name shows on all ${cFields.opportunityCount} of their records.`
                        : "This name follows them onto every record they hold."}{" "}

                      <span className="renamehint">
                        GoHighLevel keeps only the first word as the first name,
                        so “Mary Ann” will be stored as “Mary” with “Ann” moved
                        into the last name. The full name is kept.
                      </span>
                    </>
                  }
                  onSave={(v) => saveContactName(v.firstName, v.lastName)}
                />
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

              {railWhere === "clients" ? (
                <ReferredBy
                  rec={selected}
                  ssoBlob={sso.blob}
                  fieldId={referringPartnerFieldId}
                  onSave={(value, label) =>
                    saveField(
                      selected,
                      `cf:${referringPartnerFieldId}`,
                      { customFields: [{ id: referringPartnerFieldId, value }] },
                      (r) => ({ ...r, cf: { ...r.cf, [referringPartnerFieldId]: value } }),
                    ).then(() => label)
                  }
                />
              ) : null}

              {selected.contactId ? (
                <div className="contactbar">
                  <div className="cbname">
                    {selected.contactName || "No name on the contact"}
                  </div>
                  <div className="cbrow">
                    <InlineName
                      what="Phone"
                      display={cFields?.phone ?? selected.contactPhone}
                      empty="No phone"
                      link={
                        (cFields?.phone ?? selected.contactPhone)
                          ? `tel:${(cFields?.phone ?? selected.contactPhone).replace(/[^\d+]/g, "")}`
                          : undefined
                      }
                      parts={[{ key: "phone", label: "Phone number",
                        value: cFields?.phone ?? selected.contactPhone }]}
                      editLabel="Edit this person's phone number"
                      disabled={!canEdit(selected) || cLoading}
                      busy={cSave[PHONE_KEY]?.status === "saving"}
                      err={cSave[PHONE_KEY]?.err}
                      scope={<ReachScope count={cFields?.opportunityCount} />}
                      onSave={(v) => saveContactReach("phone", v.phone)}
                    />
                    <InlineName
                      what="Email"
                      display={cFields?.email ?? selected.contactEmail}
                      empty="No email"
                      link={
                        (cFields?.email ?? selected.contactEmail)
                          ? `mailto:${cFields?.email ?? selected.contactEmail}`
                          : undefined
                      }
                      parts={[{ key: "email", label: "Email address",
                        value: cFields?.email ?? selected.contactEmail }]}
                      editLabel="Edit this person's email address"
                      disabled={!canEdit(selected) || cLoading}
                      busy={cSave[EMAIL_KEY]?.status === "saving"}
                      err={cSave[EMAIL_KEY]?.err}
                      scope={<ReachScope count={cFields?.opportunityCount} />}
                      onSave={(v) => saveContactReach("email", v.email)}
                    />
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

                  {cgData.some((r) => r.id === selected.id) ? null : (
                  <button
                    type="button"
                    className="movebtn"
                    onClick={() => setMoveOpen(true)}
                  >
                    ⇄ Move this case
                  </button>
                  )}

                  {!cgData.some((r) => r.id === selected.id) &&
                  canSendToStaffing(selected, sortViewer).ok ? (
                    <button
                      type="button"
                      className="movebtn"
                      onClick={() => setStaffRec(selected)}
                      title="No owner — someone else picks it up"
                    >
                      👥 Send to {tabLabels.staffingStage}
                    </button>
                  ) : null}
                  {!cgData.some((r) => r.id === selected.id) &&
                  isStaffingStage(selected.stage) && !selected.ownerId &&
                  canAssignStaffing(selected, sortViewer, viewerId || "x").ok ? (
                    <button
                      type="button"
                      className="movebtn"
                      onClick={() => setSortReq({ record: selected, mode: "assign" })}
                    >
                      ✓ Assign
                    </button>
                  ) : null}

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

                    {stagesFor(selected.pipelineId)

                      .filter(
                        (s) => isPickableStage(s.name) || s.id === selected.stageId,
                      )
                      .map((s) => (
                        <option
                          key={s.id}
                          value={s.id}
                          disabled={!isPickableStage(s.name)}
                        >
                          {stageDisplay(s.name, tabLabels)}
                          {isReassignStage(s.name)
                            ? " — waiting to be assigned"
                            : isNewLeadStage(s.name)
                              ? ` — sort it from ${tabLabels.newLeads}`
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

              <div className="sechead">Assignment</div>

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

                  <div className="contactscope">
                    <b>About this person, not this case.</b>{" "}
                    {cFields && cFields.opportunityCount > 1
                      ? `Changes here show on all ${cFields.opportunityCount} of their records.`
                      : "Changes here follow them onto every record they hold."}
                  </div>
                  {contactGroups.map((g, gi) => {

                    if (!showEmptySections && isQuietSection(g)) return null;

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

                        {g.hidden === undefined && g.fields.length ? (
                          (() => {
                            const done = g.fields.filter((d) =>
                              hasValue(cFields?.values[d.id]),
                            ).length;
                            return (
                              <span
                                className={`seccount${done === g.fields.length ? " complete" : ""}`}
                                title={`${done} of ${g.fields.length} filled in`}
                              >
                                {done} / {g.fields.length}
                              </span>
                            );
                          })()
                        ) : g.fields.length ? (
                          <span className="seccount">{g.fields.length}</span>
                        ) : null}
                      </button>
                      {open ? (
                      <>
                      <div className="grid">
                        {[
                          ...g.fields,

                          ...(g.hidden || []).filter((d) => revealedFields.has(d.id)),
                        ]

                          .sort((a, b) => a.position - b.position)
                          .map((def) => (
                          <div
                            className={`f${isWideField(def.dataType) ? " wide" : ""}`}
                            key={`c:${def.id}`}
                          >

                            <label title={def.name}>{fieldLabel(def.name)}</label>
                            <FieldControl
                              def={def}
                              value={cFields?.values[def.id]}
                              save={cSave[def.id]}
                              onSave={(val) => saveContactField(def, val)}
                              users={users}
                              isAdmin={isAdminViewer}
                              ssoBlob={sso.blob}
                              onOptionAdded={applyNewOption}
                            />
                          </div>
                        ))}
                      </div>

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

                  {(() => {
                    const quiet = contactGroups.filter(isQuietSection).length;
                    if (!quiet) return null;
                    return (
                      <div className="addfield emptysections">
                        <button
                          type="button"
                          className={`addfield-btn${showEmptySections ? " on" : ""}`}
                          aria-expanded={showEmptySections}
                          onClick={() => setShowEmptySections((v) => !v)}
                        >
                          {showEmptySections
                            ? `Hide ${quiet} empty section${quiet === 1 ? "" : "s"}`
                            : `Show ${quiet} empty section${quiet === 1 ? "" : "s"}`}
                        </button>
                      </div>
                    );
                  })()}
                </>
              ) : null}

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

              <CaregiversSection
                key={selected.id}
                opportunityId={selected.id}
                ssoBlob={sso.blob}
                canManage={canEdit(selected)}
                onLinksChanged={(links, otherId) =>
                  applyLinkChange(selected.contactId, links, otherId)
                }

                selfRole={
                  cgData.some((r) => r.id === selected.id)
                    ? "caregiver"
                    : "client"
                }

                panelReady={cFields !== null || cErr !== null}
              />

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

              <RecordFooter
                opportunityId={selected.id}
                ssoBlob={sso.blob}
                createdAt={selected.createdAt}
                updatedAt={selected.version}
              />

              {fieldGroups.available.length ? (
                <div className="pullsec">
                  <button
                    type="button"
                    className={`pullsec-btn${addSecOpen ? " on" : ""}`}
                    aria-expanded={addSecOpen}
                    onClick={() => setAddSecOpen((v) => !v)}
                  >
                    + Add a section{" "}
                    <span className="pullsec-n">({fieldGroups.available.length} available)</span>
                  </button>
                  {addSecOpen ? (
                    <div className="pullsec-pop" role="listbox">
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

                      <div className="pullsec-note">
                        Added sections stay until you reload. Fill something in
                        and the section keeps itself.
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {fieldGroups.orphanGroups.map((g) => {

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

                            <b>These fields are in a section the dashboard has
                            not been told about.</b>
                          </>
                        )}{" "}

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

                    const mine = !!viewerId && n.authorId === viewerId;
                    const editing = editingNote === n.id && !!n.id;

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

                          {n.division ? (
                            <span className="ndiv"> ({n.division})</span>
                          ) : null}{" "}

                          · {n.when}
                          {n.edited && !n.removed ? (
                            <span
                              className="nedited"
                              title="This note was edited after it was written. The original text is not kept."
                            >
                              edited
                            </span>
                          ) : null}

                          {mine && n.id && !editing && !n.removed ? (
                            <>
                              <button
                                type="button"
                                className="noteedit"
                                onClick={() => {
                                  setEditingNote(n.id);

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

                            {n.system ? (
                              <span className="notesys">{n.system}</span>
                            ) : null}
                            {n.system && !n.removed && (n.reason || n.txt)
                              ? " "
                              : ""}

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

            {isAdminViewer ? (
              <div className="panelfoot">

                {isAdminViewer ? (
                  <button
                    type="button"

                    className="pfdangerbtn"
                    onClick={() => {
                      setDelErr(null);
                      setDelRec(selected);
                    }}
                    title="Removes this opportunity. The contact stays in GoHighLevel."
                  >
                    Delete this case
                  </button>
                ) : (
                  <span className="hint">
                    Mark it lost with a reason rather than deleting it — a lost
                    lead with a reason tells you why leads fail.
                  </span>
                )}

                {peerInfo?.configured && canPeerTransferRule(selected, sortViewer).ok ? (
                  <button
                    type="button"
                    className="pfdangerbtn"
                    onClick={() => setTransferRec(selected)}
                    title={`Recreates this person and case on ${peerInfo.label}, then closes this one. Nothing is deleted.`}
                  >
                    Transfer to {peerInfo.label}
                  </button>
                ) : null}
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
            ) : peerInfo?.configured && canPeerTransferRule(selected, sortViewer).ok ? (

              <div className="panelfoot">
                <button
                  type="button"
                  className="pfdangerbtn"
                  onClick={() => setTransferRec(selected)}
                  title={`Recreates this person and case on ${peerInfo.label}, then closes this one. Nothing is deleted.`}
                >
                  Transfer to {peerInfo.label}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </aside>
    </div>
  );
}
