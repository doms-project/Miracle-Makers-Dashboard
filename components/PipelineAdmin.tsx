"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import ConfirmDialog from "./ConfirmDialog";
import { apiError } from "@/lib/apiFetch";
import { BUILD } from "@/lib/build";
import { checkFieldName, suggestPrefix, composeFieldName, type KnownField } from "@/lib/fieldNaming";
import { divisionLabel } from "@/lib/division";
import type {
  StoredPipelineConfig,
  StoredPipelineEntry,
  PipelineScope,
} from "@/lib/pipelineConfig";
import { withExclusion } from "@/lib/pipelineConfig";
import { resolveLabels, DEFAULT_LABELS, LABEL_MAX } from "@/lib/sorting";

function NameEditor({
  id,
  label,
  saved,
  fallback,
  busy,
  onSave,
  hint,
}: {
  id: string;
  label: string;

  saved: string;

  fallback: string;
  busy: boolean;
  onSave: (name: string) => Promise<boolean>;
  hint?: string;
}) {
  const [v, setV] = useState(saved || fallback);
  useEffect(() => setV(saved || fallback), [saved, fallback]);
  const current = saved || fallback;
  const dirty = v.trim() !== current.trim();
  const save = async () => {
    if (!dirty || busy) return;

    await onSave(v.trim() === fallback.trim() ? "" : v);
  };
  return (
    <div className="pfname">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={v}
        maxLength={LABEL_MAX}
        disabled={busy}
        placeholder={fallback}
        spellCheck={false}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setV(current);
          }
        }}
      />
      <button type="button" className="pfnamebtn primary" disabled={!dirty || busy} onClick={() => void save()}>
        Save
      </button>
      {saved ? (
        <button type="button" className="pfnamebtn" disabled={busy} onClick={() => void onSave("")} title={`Back to “${fallback}”`}>
          Use the default
        </button>
      ) : null}
      {hint ? <span className="ihint">{hint}</span> : null}
    </div>
  );
}

const SCOPE_CHOICES: { value: PipelineScope; label: string; hint: string }[] = [
  {
    value: "client",
    label: "the Clients board picker",
    hint: "beside OLTL Enrollment and Private Pay Clients",
  },
  {
    value: "caregiver",
    label: "the Caregivers board picker",
    hint: "beside the applicant pipelines",
  },
  {
    value: "none",
    label: "neither — read by its own section",
    hint: "Events is read by Referrals, not browsed as cases",
  },
];

interface Section {
  key: string;
  id: string;
  label: string;

  named: boolean;

  fields: { id: string; name: string; dataType?: string }[];
}
interface PipelineRow {
  id: string;
  name: string;
  stages: { id: string; name: string }[];
  division: string;
  configured: boolean;
}
interface Unconfigured {
  id: string;
  key: string;
  fields: { id: string; name: string }[];
}
interface Payload {
  pipelines: PipelineRow[];
  config: StoredPipelineConfig;
  stale: string[];
  sections: Section[];
  known: KnownField[];
  sharedKey: string;
  unconfiguredFolders: Unconfigured[];

  inertSections?: Unconfigured[];

  contactSections?: {

    resolvedId?: string;
    id: string;
    ghlName: string;
    label: string;
    appliesTo: "caregiver" | "client" | "both";
    renamed: boolean;
    fields: { id: string; name: string; dataType?: string }[];
  }[];

  unknownContactFolders?: { id: string; fields: { id: string; name: string }[] }[];

  builtInFoldersForeign?: boolean;
}

interface ValueCount {
  perField: Record<string, number>;

  records: number;
  scanned: number;
}

const SUGGESTED_STAGES = ["NEW LEAD", "LOST"];

export function typeLabel(dataType?: string): string {
  const k = String(dataType || "").toUpperCase();
  return DATA_TYPES.find((d) => d.key === k)?.label || dataType || "—";
}

const DATA_TYPES = [
  { key: "TEXT", label: "Text" },
  { key: "LARGE_TEXT", label: "Long text" },
  { key: "NUMERICAL", label: "Number" },
  { key: "MONETORY", label: "Money" },
  { key: "DATE", label: "Date" },

  { key: "SINGLE_OPTIONS", label: "Dropdown — pick one" },
  { key: "MULTIPLE_OPTIONS", label: "Dropdown — pick several" },
  { key: "CHECKBOX", label: "Tickbox — yes or no" },
];

export default function PipelineAdmin({
  ssoBlob,
  recordCounts,
  countsComplete,
  countFieldValues,
  onConfigSaved,
  onLabelsSaved,
  labels: liveLabels,
}: {
  ssoBlob: string | null;

  recordCounts: Record<string, number>;

  onLabelsSaved?: (labels: Record<string, string>) => void;

  labels?: Record<string, string>;

  onConfigSaved?: (
    folders: Record<string, string[]>,
    exclusions: Record<string, string[]>,

    sidebarHidden: Record<string, true>,
  ) => void;

  countFieldValues?: (pipelineId: string, fieldIds: string[]) => ValueCount | null;

  countsComplete: boolean;
}) {

  const [scopeAsk, setScopeAsk] = useState<{
    p: PipelineRow;
    entry: StoredPipelineEntry;
    next: PipelineScope;
  } | null>(null);

  const [hideAsk, setHideAsk] = useState<{
    p: PipelineRow;
    entry: StoredPipelineEntry;
    what: "field" | "section";
    label: string;
    count: ValueCount | null;
    apply: () => void;
  } | null>(null);

  const [deleteAsk, setDeleteAsk] = useState<PipelineRow | null>(null);

  const [serverCounts, setServerCounts] = useState<Record<string, number | null>>({});
  const counting = useRef<Set<string>>(new Set());
  const [data, setData] = useState<Payload | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);

  const loadSeq = useRef(0);
  const [busy, setBusy] = useState(false);

  const [busyAction, setBusyAction] = useState("");
  const [saveErr, setSaveErr] = useState<unknown>(null);
  const [saved, setSaved] = useState("");

  const [rowMsg, setRowMsg] = useState<{
    id: string;
    err?: unknown;
    ok?: string;

    refusal?: string;
  } | null>(null);

  const [busyRow, setBusyRow] = useState("");

  const ssoHeader = useCallback(
    (): Record<string, string> => (ssoBlob ? { "x-ghl-sso-key": ssoBlob } : {}),
    [ssoBlob],
  );

  const load = useCallback(async () => {

    const seq = ++loadSeq.current;
    const isCurrent = () => seq === loadSeq.current;

    setLoadErr(null);
    try {
      const res = await fetch("/api/admin/pipelines", {
        headers: ssoHeader(),
        cache: "no-store",
      });
      const j = await res.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (!res.ok) throw apiError(res, j);
      setLoadErr(null);
      setData(j as Payload);
    } catch (e) {
      if (!isCurrent()) return;
      setLoadErr(e);
    }
  }, [ssoHeader]);

  useEffect(() => {
    void load();
  }, [load]);

  const renameTab = async (key: string, name: string, rowId: string): Promise<boolean> => {
    const j = await post({ action: "rename-tab", key, name }, rowId);
    if (!j?.config || !data) return false;
    setData({ ...data, config: j.config });
    onLabelsSaved?.((j.config.labels || {}) as Record<string, string>);
    setRowMsg({ id: rowId, ok: name.trim() ? `Saved — the sidebar now reads “${name.trim()}”.` : "Saved — back to the default name." });
    return true;
  };

  const post = async (payload: Record<string, unknown>, rowId?: string) => {
    setBusy(true);
    setBusyAction(String(payload.action || ""));
    setBusyRow(rowId || "");
    if (rowId) setRowMsg(null);
    else {
      setSaveErr(null);
      setSaved("");
    }
    try {
      const res = await fetch("/api/admin/pipelines", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ssoHeader() },

        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          ...payload,
          ...(payload.action === "save-config" ? { build: BUILD.round } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(res, j);
      return j;
    } catch (e) {

      const refusal =
        e && typeof e === "object" && (e as { refusal?: boolean }).refusal
          ? String((e as { message?: string }).message || "")
          : "";
      if (rowId) setRowMsg(refusal ? { id: rowId, refusal } : { id: rowId, err: e });
      else setSaveErr(e);
      return null;
    } finally {
      setBusy(false);
      setBusyAction("");
      setBusyRow("");
    }
  };

  const [name, setName] = useState("");
  const [scope, setScope] = useState<"client" | "caregiver" | "">("");
  const [stages, setStages] = useState<string[]>([...SUGGESTED_STAGES]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!data || !scope) return;
    setPicked(new Set(data.sections.map((x) => x.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.sections, scope]);

  const division = useMemo(() => divisionLabel(name.trim()), [name]);
  const divisionClash = useMemo(() => {
    if (!division || !data) return null;
    const other = data.pipelines.find(
      (p) => p.division.toLowerCase() === division.toLowerCase(),
    );
    return other ? other.name : null;
  }, [division, data]);

  const toggle = (key: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const createPipeline = async () => {
    const j = await post({
      action: "create-pipeline",
      name: name.trim(),
      scope,
      stages: stages.map((s) => s.trim()).filter(Boolean),
      folders: [...picked],
    });
    if (!j) return;
    setSaved(`Created “${j.pipeline.name}” with ${j.pipeline.stages.length} stage(s).`);
    setName("");
    setStages([...SUGGESTED_STAGES]);
    await load();
  };

  const canCreate =
    !!name.trim() && !!scope && stages.some((s) => s.trim()) && picked.size > 0 && !busy;

  const announce = useCallback(
    (cfg: StoredPipelineConfig) => {
      if (!onConfigSaved) return;
      onConfigSaved(
        Object.fromEntries(
          Object.entries(cfg.pipelines).map(([id, e]) => [id, e.folders]),
        ),
        Object.fromEntries(
          Object.entries(cfg.pipelines)
            .filter(([, e]) => e.exclude?.length)
            .map(([id, e]) => [id, e.exclude as string[]]),
        ),
        Object.fromEntries(
          Object.entries(cfg.pipelines)
            .filter(([, e]) => e.sidebar === false)
            .map(([id]) => [id, true as const]),
        ),
      );
    },
    [onConfigSaved],
  );

  const isTicked = (entry: StoredPipelineEntry | undefined, s: Section) =>
    !!entry && (entry.folders.includes(s.key) || entry.folders.includes(s.id));

  const normaliseFolders = (
    entry: StoredPipelineEntry | undefined,
    s: Section,
    sections: Section[],
  ): string[] => {
    const on = isTicked(entry, s);
    const keep = (entry?.folders ?? []).filter((tok) => {

      if (tok === s.key || tok === s.id) return false;
      return true;
    });

    const byId = new Map(sections.map((x) => [x.id, x.key]));
    const migrated = keep.map((tok) => byId.get(tok) ?? tok);
    return on ? migrated : [...migrated, s.key];
  };

  const isExcluded = (entry: StoredPipelineEntry | undefined, fieldId: string) =>
    !!entry?.exclude?.includes(fieldId);

  const saveEntry = async (pipelineId: string, entry: StoredPipelineEntry) => {
    if (!data) return;
    const next: StoredPipelineConfig = {
      ...data.config,
      seeded: true,
      pipelines: { ...data.config.pipelines, [pipelineId]: entry },
    };
    const j = await post({ action: "save-config", config: next }, pipelineId);
    if (j) {
      setRowMsg({ id: pipelineId, ok: "Saved." });
      setData({ ...data, config: j.config });
      announce(j.config);
    }
  };

  const setEventsRole = async (pipelineId: string, on: boolean) => {
    if (!data) return;
    const pipelines: Record<string, StoredPipelineEntry> = {};
    for (const [id, e] of Object.entries(data.config.pipelines)) {
      const { role: _drop, ...rest } = e;
      pipelines[id] =
        on && id === pipelineId ? { ...rest, role: "events" } : (rest as StoredPipelineEntry);
    }
    const j = await post(
      { action: "save-config", config: { ...data.config, seeded: true, pipelines } },
      pipelineId,
    );
    if (j) {
      setRowMsg({
        id: pipelineId,
        ok: on
          ? "Marked as the Events pipeline. The Events tab now finds it by id."
          : "No longer the Events pipeline.",
      });
      setData({ ...data, config: j.config });
      announce(j.config);
    }
  };
  const removeEntry = async (pipelineId: string) => {
    if (!data) return;
    const rest = { ...data.config.pipelines };
    delete rest[pipelineId];
    const j = await post({
      action: "save-config",
      config: { ...data.config, seeded: true, pipelines: rest },
    }, pipelineId);
    if (j) {
      setRowMsg({ id: pipelineId, ok: "Removed." });
      setData({ ...data, config: j.config, stale: data.stale.filter((s) => s !== pipelineId) });
      announce(j.config);
    }
  };

  const askThenHide = (
    p: PipelineRow,
    entry: StoredPipelineEntry,
    what: "field" | "section",
    label: string,
    fieldIds: string[],
    apply: () => void,
  ) => {
    const count = countFieldValues ? countFieldValues(p.id, fieldIds) : null;

    if (count && count.records === 0) {
      apply();
      return;
    }
    setHideAsk({ p, entry, what, label, count, apply });
  };

  const onExclusionToggle = (
    p: PipelineRow,
    entry: StoredPipelineEntry,
    s: Section,
    f: { id: string; name: string },
  ) => {
    const hiding = !isExcluded(entry, f.id);
    const apply = () => void saveEntry(p.id, withExclusion(entry, f.id, hiding));
    if (!hiding) {
      apply();
      return;
    }
    askThenHide(p, entry, "field", f.name, [f.id], apply);
  };

  const countFor = (p: PipelineRow): number | null | undefined => {
    const entry = data?.config.pipelines[p.id];
    const local = recordCounts[p.id];
    if (local != null && (countsComplete || entry?.scope !== "caregiver")) return local;
    return serverCounts[p.id];
  };

  const ensureCount = async (p: PipelineRow) => {
    if (countFor(p) !== undefined) return;
    if (counting.current.has(p.id)) return;
    counting.current.add(p.id);
    try {
      const res = await fetch("/api/admin/pipelines", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ssoHeader() },
        body: JSON.stringify({
          ssoKey: ssoBlob ?? undefined,
          action: "count-records",
          pipelineId: p.id,
        }),
      });
      const j = await res.json().catch(() => ({}));

      setServerCounts((s) => ({
        ...s,
        [p.id]: res.ok && typeof j.count === "number" ? j.count : null,
      }));
    } catch {
      setServerCounts((s) => ({ ...s, [p.id]: null }));
    } finally {
      counting.current.delete(p.id);
    }
  };

  const deletePipelineRow = async (p: PipelineRow) => {
    const j = await post({ action: "delete-pipeline", pipelineId: p.id }, p.id);
    if (!j || !data) return;

    setData({
      ...data,
      pipelines: data.pipelines.filter((x) => x.id !== p.id),
      config: j.config ?? data.config,
      stale: data.stale.filter((s) => s !== p.id),
    });
    if (j.config) announce(j.config);
    setSaved(`Deleted “${p.name}”.`);
  };

  const [fieldOpen, setFieldOpen] = useState(false);

  const [fPrefixOn, setFPrefixOn] = useState(false);
  const [fPrefix, setFPrefix] = useState("");
  const [fName, setFName] = useState("");
  const [fType, setFType] = useState("TEXT");
  const [fParent, setFParent] = useState("");
  const [fOptions, setFOptions] = useState("");
  const [sectionOpen, setSectionOpen] = useState(false);
  const [secName, setSecName] = useState("");
  const [unkName, setUnkName] = useState<Record<string, string>>({});

  const nameFolder = async (folderId: string) => {
    const j = await post({
      action: "name-folder",
      folderId,
      name: (unkName[folderId] || "").trim(),
    });
    if (!j) return;
    setSaved("Named. Tick it on the pipelines that should show it.");
    await load();
  };

  const createSection = async () => {
    const j = await post({ action: "create-section", name: secName.trim() });
    if (!j) return;
    setSaved(`Created the section “${j.folder.name}”.`);
    setSecName("");
    setSectionOpen(false);
    await load();

    setFParent(j.folder.id);
  };

  useEffect(() => {

    if (division) setFPrefix(suggestPrefix(division));
  }, [division]);

  const fOptionList = useMemo(
    () => fOptions.split("\n").map((o) => o.trim()).filter(Boolean),
    [fOptions],
  );
  const fFull = composeFieldName(fPrefixOn ? fPrefix : "", fName);
  const verdict = useMemo(
    () => (data ? checkFieldName(fFull, data.known, fOptionList) : { kind: "ok" as const }),
    [fFull, data, fOptionList],
  );

  const createField = async () => {
    const j = await post({
      action: "create-field",
      name: fFull,
      dataType: fType,
      parentId: fParent,
      options: /OPTIONS|CHECKBOX/.test(fType) ? fOptionList : undefined,
    });
    if (!j) return;
    setSaved(
      j.field.parentIdHonoured
        ? `Created “${j.field.name}”.`
        : `Created “${j.field.name}” — but GoHighLevel did not put it in the section you chose. Move it there in GHL.`,
    );
    setFName("");
    setFOptions("");
    await load();
  };

  if (loadErr && !data)
    return (
      <div className="isec">
        <ErrorMessage error={loadErr} className="savemsg err" />
      </div>
    );
  if (!data) return <div className="isec"><div className="imeta">Loading…</div></div>;

  const inert = data.inertSections || [];

  const sectionRow = (
    s: Section,
    checked: boolean,
    onToggle: () => void,
    per?: { p: PipelineRow; entry: StoredPipelineEntry | undefined },
  ) => {
    const hiddenHere = per
      ? s.fields.filter((f) => isExcluded(per.entry, f.id)).length
      : 0;
    return (
    <div
      className={`pfsec ${s.named ? "" : "unnamed"}${
        expanded.has(s.key) ? " open" : ""
      }`}
      key={s.key}
    >
      <label className="pfseclab">

        <input type="checkbox" checked={checked} disabled={busy} onChange={onToggle} />

        {s.named ? (
          <span className="pfsecname">{s.label}</span>
        ) : (

          <span className="pfsecunk" title="GoHighLevel does not share folder names with this dashboard">
            <span className="pfsecunk-w" aria-hidden="true">
              ⚠
            </span>
            <span className="pfsecunk-t">Unnamed section</span>
          </span>
        )}
      </label>

      <span
        className="pfseccount"
        title={
          hiddenHere
            ? `${hiddenHere} of ${s.fields.length} hidden on this pipeline`
            : undefined
        }
      >
        {hiddenHere ? `${s.fields.length - hiddenHere} of ${s.fields.length}` : s.fields.length}
      </span>
      <button
        type="button"
        className="pfsectoggle"
        aria-expanded={expanded.has(s.key)}
        title="Show the fields in this section"
        onClick={() =>
          setExpanded((e) => {
            const n = new Set(e);
            if (n.has(s.key)) n.delete(s.key);
            else n.add(s.key);
            return n;
          })
        }
      >
        {expanded.has(s.key) ? "▴" : "▾"}
      </button>

      {expanded.has(s.key) ? (

        <div className="pfsecfields">

          <ol className="pffieldlist">
            {s.fields.map((f) => {
              const off = per ? isExcluded(per.entry, f.id) : false;
              return (
                <li key={f.id} className={off ? "pffoff" : undefined}>
                  {per ? (
                    <input
                      type="checkbox"
                      className="pffbox"
                      checked={!off}

                      disabled={busy || !checked || !per.entry}
                      title={
                        !checked
                          ? "Tick the section first — nothing from it is shown yet"
                          : off
                            ? "Hidden on this pipeline. Tick to show it again."
                            : "Shown on this pipeline. Untick to hide it."
                      }
                      onChange={() => per.entry && onExclusionToggle(per.p, per.entry, s, f)}
                    />
                  ) : null}
                  <span className="pffname">{f.name}</span>
                  <span className="pfftype">{typeLabel(f.dataType)}</span>
                </li>
              );
            })}
          </ol>
          {per && checked ? (
            <div className="ihint pffnote">

              Unticking a field hides it from this pipeline&apos;s panel. The values
              stay in GoHighLevel and come back if you tick it again. A field added
              in GoHighLevel later is not on this list, so it appears by itself.
            </div>
          ) : null}
          {!s.named ? (
            <div className="pfsecid" title="Paste this into GoHighLevel to find the folder">
              <code>{s.id}</code>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
    );
  };

  return (
    <div className="isec pfadmin">
      {loadErr ? (
        <div className="loadwarn">
          <div>
            <b>Couldn&apos;t refresh pipelines.</b> What is below is from the
            last load that worked.{" "}
            <button type="button" className="linkbtn" onClick={() => void load()}>
              Try again
            </button>
          </div>
          <ErrorMessage error={loadErr} className="savemsg err" />
        </div>
      ) : null}

      {(data.unconfiguredFolders || []).length ? (
        <div className="pfunknown">
          <b>
            {data.unconfiguredFolders.length} section
            {data.unconfiguredFolders.length === 1 ? "" : "s"} need
            {data.unconfiguredFolders.length === 1 ? "s" : ""} a label
          </b>
          <div className="ihint">
            GoHighLevel does not share folder names with this dashboard, so we
            cannot read what {data.unconfiguredFolders.length === 1 ? "this one is" : "these are"}{" "}
            called. Until {data.unconfiguredFolders.length === 1 ? "it is" : "they are"} labelled
            and given to a pipeline, the fields inside show as unfiled on records.
          </div>
          {data.unconfiguredFolders.map((u) => (
            <div className="pfunknownrow" key={u.id}>
              <div className="pfunknownwhat">

                <div className="pfunknownlbl">
                  Fields in it ({u.fields.length})
                </div>
                <ul className="pfunknownfields">
                  {u.fields.map((f) => (
                    <li key={f.id}>{f.name}</li>
                  ))}
                </ul>
                <code className="pfunknownid" title="Paste this into GoHighLevel to find the folder">
                  {u.id}
                </code>
              </div>
              <div className="pfunknownask">
                <label htmlFor={`pfunk-${u.id}`}>
                  What is this section called in GoHighLevel?
                </label>
                <div className="pfunknownacts">
                  <input
                    id={`pfunk-${u.id}`}
                    value={unkName[u.id] ?? ""}
                    placeholder="e.g. Event Details"
                    onChange={(e) =>
                      setUnkName((m) => ({ ...m, [u.id]: e.target.value }))
                    }
                  />
                  <button
                    type="button"
                    disabled={busy || !(unkName[u.id] || "").trim()}
                    onClick={() => nameFolder(u.id)}
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {inert.length ? (
        <div className="pfinert">
          {inert.length} section
          {inert.length === 1 ? " is" : "s are"} not listed below:
          every field in {inert.length === 1 ? "it is" : "them is"}{" "}
          written by GoHighLevel itself, so ticking{" "}
          {inert.length === 1 ? "it" : "them"} onto a pipeline would
          change nothing on a record.{" "}
          <span className="pfinertwhich">
            {inert
              .map((s) => s.fields.map((f) => f.name).join(", "))
              .join(" · ")}
          </span>
        </div>
      ) : null}

      <div className="pfwhy">
        GoHighLevel has no way to say &ldquo;this section belongs to that
        pipeline&rdquo;: a folder made there arrives unmapped and its fields show
        as unfiled, and a field made there lands in Additional Info with nothing
        to tell the dashboard. That is why creating a pipeline, ticking its
        sections, adding a section and adding a field all live on this one
        screen.
      </div>

      <div className="istep">1 · Name and scope</div>

      <div className="irow">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Pipeline name" />
        {name.trim() ? (
          <div className="ihint">
            Records here will belong to the <b>{division}</b> division — that is what
            transfer tags and the division filter use.
            {divisionClash ? (
              <>
                {" "}
                ⚠️ <b>{divisionClash}</b> already resolves to the same division. If these
                are not two halves of one workflow, they will be treated as one.
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="irow">
        <label>This pipeline holds</label>
        <select value={scope} onChange={(e) => setScope(e.target.value as "client" | "caregiver" | "")}>
          <option value="">Choose…</option>
          <option value="client">Clients</option>
          <option value="caregiver">Caregiver / DSP applicants</option>
        </select>

        <div className="ihint">
          Caregiver pipelines never appear on the client board, the client kanban or the
          master view. It can be changed later under Configured pipelines below.
        </div>
      </div>

      <div className="istep">2 · Stages</div>
      <div className="irow pfstages">
        <label>Stages</label>
        <div className="pfstagelist">
          {stages.map((s, i) => (
            <div className="pfstage" key={i}>
              <span className="pfstagepos">{i + 1}</span>
              <input
                value={s}
                onChange={(e) =>
                  setStages((arr) => arr.map((x, j) => (j === i ? e.target.value : x)))
                }
              />

              <button type="button" disabled={i === 0} onClick={() =>
                setStages((a) => { const n=[...a]; [n[i-1],n[i]]=[n[i],n[i-1]]; return n; })}>↑</button>
              <button type="button" disabled={i === stages.length - 1} onClick={() =>
                setStages((a) => { const n=[...a]; [n[i+1],n[i]]=[n[i],n[i+1]]; return n; })}>↓</button>
              <button type="button" disabled={stages.length <= 1} onClick={() =>
                setStages((a) => a.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button type="button" className="ighost" onClick={() => setStages((a) => [...a, ""])}>
            + Add a stage
          </button>
          <div className="ihint">
            At least one is required. Stages can be renamed in GoHighLevel afterwards —
            deleting one is not offered here, because the opportunities in it have to go
            somewhere and a recreated stage changes id, which makes its records vanish
            from the board.
          </div>
        </div>
      </div>

      <div className="istep">3 · Sections its records can show</div>

      <div className="pfgovern">
        <p>
          <b>Ticking a section makes its fields available on every record in
          this pipeline.</b>{" "}
          A section with nothing filled in is not drawn — a rep adds it from the
          record when they need it. Fields you add in GoHighLevel appear here
          automatically, inside whichever section they were created in.
        </p>
        <p>
          <b>Why this exists:</b> a record panel showing every field in the
          account is unusable — sixty-eight fields on one card, most of them
          empty, and the four that matter buried among them. Ticking per
          pipeline is what lets an OLTL enrolment show enrolment fields while a
          caregiver applicant never sees Client SSN.
        </p>

        <p>
          <b>These are sections on the CASE, not on the person.</b> Sections
          about a person — caregiver compliance, availability, the application
          itself — follow them onto every record they hold, are the same
          everywhere, and are chosen by whether the record is a client or an
          applicant. There is nothing to tick for those, and they are not listed
          here.
        </p>
      </div>
      <div className="irow pffolders">
        <label>Field sections this pipeline shows</label>
        <div className="pfseclist">
          {data.sections.map((s) => sectionRow(s, picked.has(s.key), () => toggle(s.key)))}
        </div>
      </div>

      <div className="irow">
        <button type="button" className="ighost" onClick={() => setFieldOpen((v) => !v)}>
          {fieldOpen ? "− Close" : "+ Create a new field"}
        </button>
      </div>

      {fieldOpen ? (
        <div className="pfnew">

          <div className="pffield">
            <label htmlFor="pf-section">Section</label>
            <div className="pffield-sec">
              <select
                id="pf-section"
                autoFocus
                value={fParent}
                onChange={(e) => setFParent(e.target.value)}
              >
                <option value="">Choose a section…</option>
                {data.sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                    {s.named ? "" : " · unnamed"}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ighost"
                onClick={() => setSectionOpen((v) => !v)}
              >
                {sectionOpen ? "− Cancel" : "+ New section"}
              </button>
            </div>

            {sectionOpen ? (
              <>
                <label htmlFor="pf-secname">New section name</label>
                <div className="pffield-sec">
                  <input
                    id="pf-secname"
                    value={secName}
                    onChange={(e) => setSecName(e.target.value)}
                    placeholder="e.g. Intake Details"
                  />
                  <button
                    type="button"
                    onClick={createSection}
                    disabled={busy || !secName.trim()}
                  >
                    Create section
                  </button>
                </div>
              </>
            ) : null}

            <label htmlFor="pf-name">Field name</label>
            <input
              id="pf-name"
              value={fName}
              onChange={(e) => setFName(e.target.value)}
              placeholder="e.g. Preferred contact time"
            />

            <label htmlFor="pf-prefix">
              Prefix
              <input
                type="checkbox"
                checked={fPrefixOn}
                onChange={(e) => setFPrefixOn(e.target.checked)}
                aria-label="Use a prefix"
              />
            </label>
            <input
              id="pf-prefix"
              className="pffield-prefix"
              value={fPrefix}
              disabled={!fPrefixOn}
              placeholder={fPrefixOn ? "" : "off"}
              onChange={(e) => setFPrefix(e.target.value)}
            />

            <label htmlFor="pf-type">Type</label>
            <select id="pf-type" value={fType} onChange={(e) => setFType(e.target.value)}>
              {DATA_TYPES.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>

            {/OPTIONS|CHECKBOX/.test(fType) ? (
              <>
                <label htmlFor="pf-options">Choices</label>
                <textarea
                  id="pf-options"
                  rows={3}
                  value={fOptions}
                  onChange={(e) => setFOptions(e.target.value)}
                  placeholder="One per line"
                />
              </>
            ) : null}
          </div>

          {fFull ? (
            <div className="ihint">
              Will be created as: <code>{fFull}</code>
            </div>
          ) : null}

          {verdict.kind !== "ok" ? (
            <div className={verdict.kind === "blocked" ? "pfblock" : "pfwarn"}>
              <b>{verdict.kind === "blocked" ? "🔴" : "⚠️"} {verdict.message}</b>
              <div className="pfwhere">
                {verdict.existing.name} · {verdict.existing.folderLabel} ·{" "}
                {verdict.existing.folderFieldCount} fields
              </div>
              {verdict.kind === "warn" ? (
                <div className="pfwarnacts">
                  <button type="button" onClick={() => { setFName(verdict.existing.name); setFPrefixOn(false); }}>
                    Use “{verdict.existing.name}”
                  </button>
                  <button type="button" onClick={createField} disabled={busy || !fParent}>
                    Create anyway
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {verdict.kind !== "warn" ? (
            <button
              type="button"
              onClick={createField}
              disabled={busy || !fFull || !fParent || verdict.kind === "blocked"}
            >
              Create field
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="istep">4 · Create</div>
      <div className="irow">
        <button type="button" className="pfprimary" onClick={createPipeline} disabled={!canCreate}>
          {busy && busyAction === "create-pipeline" ? "Creating…" : "Create pipeline"}
        </button>
      </div>

      {saveErr ? <ErrorMessage error={saveErr} className="savemsg err" /> : null}
      {saved ? <div className="savemsg ok">{saved}</div> : null}

      <div className="istep" style={{ marginTop: 20 }}>Clients sidebar — the sorting tabs</div>
      <div className="pfnames">
        {rowMsg && rowMsg.id === "sorting-tabs" ? (
          rowMsg.refusal ? (
            <div className="savemsg warn pfrowmsg">{rowMsg.refusal}</div>
          ) : rowMsg.err ? (
            <ErrorMessage error={rowMsg.err} className="savemsg err pfrowmsg" />
          ) : (
            <div className="savemsg ok pfrowmsg">{rowMsg.ok}</div>
          )
        ) : null}
        <NameEditor
          id="pfname-newLeads"
          label="New leads tab"
          saved={(liveLabels ?? data.config.labels)?.newLeads || ""}
          fallback={DEFAULT_LABELS.newLeads}
          busy={busy}
          onSave={(n) => renameTab("newLeads", n, "sorting-tabs")}
          hint="The first Clients tab, where every new lead lands."
        />
        <NameEditor
          id="pfname-staffingTab"
          label="Staffing tab"
          saved={(liveLabels ?? data.config.labels)?.staffingTab || ""}
          fallback={DEFAULT_LABELS.staffingTab}
          busy={busy}
          onSave={(n) => renameTab("staffingTab", n, "sorting-tabs")}
          hint="Cases with no owner, waiting to be assigned."
        />
        <NameEditor
          id="pfname-staffingStage"
          label="REASSIGN stage shows as"
          saved={(liveLabels ?? data.config.labels)?.staffingStage || ""}
          fallback={DEFAULT_LABELS.staffingStage}
          busy={busy}
          onSave={(n) => renameTab("staffingStage", n, "sorting-tabs")}
          hint="The stage stays REASSIGN in GoHighLevel — only the dashboard's wording changes."
        />
      </div>

      <div className="istep" style={{ marginTop: 20 }}>Configured pipelines</div>
      <div className="pflist">
        {data.pipelines.map((p) => {
          const entry = data.config.pipelines[p.id];
          const count = countFor(p);
          return (
            <details
              className="pfrow"
              key={p.id}

              onToggle={(e) => {
                if ((e.currentTarget as HTMLDetailsElement).open) void ensureCount(p);
              }}
            >
              <summary>
                <b>{(liveLabels ?? data.config.labels)?.[`pipeline:${p.id}`] || p.name}</b>
                {(liveLabels ?? data.config.labels)?.[`pipeline:${p.id}`] ? (
                  <span className="pfghlname" title="Its name in GoHighLevel — unchanged">
                    {p.name} in GoHighLevel
                  </span>
                ) : null}
                <span className="pfscope">

                  {!entry
                    ? "not configured"
                    : entry.scope === "none"
                      ? "no board picker"
                      : entry.scope === "caregiver"
                        ? "Caregivers board"
                        : "Clients board"}
                </span>
                <span className="pfcount">
                  {entry ? `${entry.folders.length} section(s)` : "Shared only"}
                  {entry?.exclude?.length
                    ? ` · ${entry.exclude.length} field${
                        entry.exclude.length === 1 ? "" : "s"
                      } hidden`
                    : ""}
                </span>

                <span className="pfreccount">
                  {count != null ? `${count} record${count === 1 ? "" : "s"}` : ""}
                </span>
              </summary>

              {rowMsg && rowMsg.id === p.id ? (
                rowMsg.refusal ? (

                  <div className="savemsg warn pfrowmsg">{rowMsg.refusal}</div>
                ) : rowMsg.err ? (
                  <ErrorMessage error={rowMsg.err} className="savemsg err pfrowmsg" />
                ) : (
                  <div className="savemsg ok pfrowmsg">{rowMsg.ok}</div>
                )
              ) : null}

              {busy && busyRow === p.id ? (
                <div className="pfrowbusy pfrowmsg">
                  <span className="pfspin" aria-hidden="true" />
                  Saving…
                </div>
              ) : null}
              <div className="pfscopeedit">

                <label htmlFor={`pfscope-${p.id}`}>Show this pipeline in</label>
                <select
                  id={`pfscope-${p.id}`}
                  value={entry?.scope ?? ""}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.value as PipelineScope | "";
                    if (!next) return;

                    if (entry && next !== entry.scope) {
                      e.target.value = entry.scope;
                      setScopeAsk({ p, entry, next });
                      return;
                    }
                    void saveEntry(p.id, {
                      scope: next,
                      folders: entry?.folders ?? [],
                    });
                  }}
                >
                  <option value="">Choose where it is listed…</option>
                  {SCOPE_CHOICES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>

                {entry?.scope === "caregiver" ? (
                  <div className="pfgroupedit">
                    <label htmlFor={`pfgroup-${p.id}`}>Recruiting group</label>
                    <select
                      id={`pfgroup-${p.id}`}
                      value={entry.group ?? "caregiver"}
                      disabled={busy}
                      onChange={(e) =>
                        void saveEntry(p.id, {
                          ...entry,
                          group: e.target.value === "staff" ? "staff" : "caregiver",
                        })
                      }
                    >
                      <option value="caregiver">Caregivers — applicants</option>
                      <option value="staff">Staff — hires</option>
                    </select>
                    <span className="ihint">

                      Which half of the Recruiting section lists it. Unset reads
                      as Caregivers.
                    </span>
                  </div>
                ) : null}

                {entry ? (
                  <div className="pfgroupedit">
                    <label htmlFor={`pfrole-${p.id}`}>Role</label>
                    <select
                      id={`pfrole-${p.id}`}
                      value={entry.role === "events" ? "events" : ""}
                      disabled={busy}
                      onChange={(e) => void setEventsRole(p.id, e.target.value === "events")}
                    >
                      <option value="">No special role</option>
                      <option value="events">The Events pipeline</option>
                    </select>
                    <span className="ihint">
                      Where the Referrals screen reads events from. Only one
                      pipeline can hold it — choosing it here takes it off
                      whichever had it. Unset, the Events tab falls back to
                      matching the name &ldquo;Events&rdquo;, which a rename
                      breaks.
                    </span>
                  </div>
                ) : null}

                {entry?.scope === "client" ? (
                  <NameEditor
                    id={`pfname-${p.id}`}
                    label="Name in the sidebar"
                    saved={(liveLabels ?? data.config.labels)?.[`pipeline:${p.id}`] || ""}
                    fallback={p.name}
                    busy={busy}
                    onSave={(n) => renameTab(`pipeline:${p.id}`, n, p.id)}
                    hint="Only the dashboard's name — the pipeline keeps its name in GoHighLevel, and nothing that reads it changes."
                  />
                ) : null}
                {entry?.scope === "client" || entry?.scope === "caregiver" ? (
                  <div className="pfgroupedit">
                    <input
                      id={`pfside-${p.id}`}
                      type="checkbox"
                      className="pffbox"
                      checked={entry.sidebar !== false}
                      disabled={busy}
                      onChange={(e) => {
                        const { sidebar: _was, ...rest } = entry;
                        void saveEntry(
                          p.id,
                          e.target.checked ? rest : { ...rest, sidebar: false },
                        );
                      }}
                    />
                    <label htmlFor={`pfside-${p.id}`}>Show in the sidebar</label>
                    <span className="ihint">
                      {entry.scope === "caregiver"
                        ? "Unticked, this pipeline has no entry under Recruiting in the sidebar. Its applicants stay loaded and it stays in the Recruiting Pipeline dropdown."
                        : "Unticked, this pipeline has no entry under Clients in the sidebar. Its records stay in All clients, Master and Moves, and it stays in the Pipeline dropdown."}{" "}
                      This is not a permission — Admin → Access decides who
                      sees what.
                    </span>
                  </div>
                ) : null}
                <span className="ihint">

                  Which board&apos;s pipeline picker offers it. The import wizard,
                  Admin → Access and this screen always list every pipeline.
                  Reversible.
                </span>

                <div className="pfdelete">
                  {count === undefined ? (
                    <span className="ihint">Counting the records in this pipeline…</span>
                  ) : count === null ? (

                    <span className="ihint">
                      I could not count the records in this pipeline, so Delete is
                      not offered. Close and reopen this row to try again.
                    </span>
                  ) : count > 0 ? (

                    <span className="ihint">
                      <b>
                        {count} record{count === 1 ? " is" : "s are"}
                      </b>{" "}
                      in this pipeline. Move or close {count === 1 ? "it" : "them"}{" "}
                      in GoHighLevel first.
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="pfdangerbtn"
                      disabled={busy}
                      onClick={() => setDeleteAsk(p)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
              <div className="pfseclist">
                {data.sections.map((s) =>
                  sectionRow(s, isTicked(entry, s), () => {

                    if (!entry) {

                      setRowMsg({
                        id: p.id,
                        refusal:
                          `“${p.name}” has no scope yet. Choose a scope above ` +
                          `before ticking sections — picking one for you is how a ` +
                          `pipeline ends up in the wrong section.`,
                      });

                      document.getElementById(`pfscope-${p.id}`)?.focus();
                      return;
                    }
                    const next = {
                      ...entry,
                      folders: normaliseFolders(entry, s, data.sections),
                    };
                    const apply = () => void saveEntry(p.id, next);

                    if (!isTicked(entry, s)) {
                      apply();
                      return;
                    }
                    askThenHide(
                      p,
                      entry,
                      "section",
                      s.named ? s.label : "This section",

                      s.fields.filter((f) => !isExcluded(entry, f.id)).map((f) => f.id),
                      apply,
                    );
                  }, { p, entry }),
                )}
              </div>
            </details>
          );
        })}
      </div>

      {scopeAsk ? (
        <ConfirmDialog
          title={
            scopeAsk.next === "none"
              ? `Take “${scopeAsk.p.name}” off both board pickers?`
              : `Move “${scopeAsk.p.name}” to the ${
                  scopeAsk.next === "caregiver" ? "Caregivers" : "Clients"
                } section?`
          }
          confirmLabel={
            scopeAsk.next === "none"
              ? "Take it off both"
              : `Move to ${scopeAsk.next === "caregiver" ? "Caregivers" : "Clients"}`
          }
          busy={busy}
          onCancel={() => setScopeAsk(null)}
          onConfirm={() => {
            const { p, entry, next } = scopeAsk;
            setScopeAsk(null);

            if (next === "none") {
              const { sidebar: _drop, ...rest } = entry;
              void _drop;
              void saveEntry(p.id, { ...rest, scope: next });
            } else void saveEntry(p.id, { ...entry, scope: next });
          }}
          body={
            <>
              <p>

                {recordCounts[scopeAsk.p.id] != null && (
                  countsComplete || scopeAsk.entry.scope === "client"
                ) ? (
                  <>
                    <b>
                      {recordCounts[scopeAsk.p.id]} record
                      {recordCounts[scopeAsk.p.id] === 1 ? "" : "s"}
                    </b>{" "}
                    move.
                  </>
                ) : (
                  <>
                    <b>Its records move.</b> I cannot say how many — the
                    applicant payload has not been loaded in this tab, so the
                    number would be a guess.
                  </>
                )}{" "}
                {scopeAsk.next === "none" ? (
                  <>
                    They leave the{" "}
                    {scopeAsk.entry.scope === "caregiver" ? "Caregivers" : "Clients"}{" "}
                    board picker and appear on no board. The records are not
                    touched — they are simply not browsable from a board until a
                    section is built that reads them, the way Referrals reads
                    Events.
                  </>
                ) : (
                  <>
                    They leave the{" "}
                    {scopeAsk.entry.scope === "caregiver"
                      ? "Caregivers"
                      : scopeAsk.entry.scope === "none"
                        ? "no"
                        : "Clients"}{" "}
                    board and appear on the other one instead.
                  </>
                )}
              </p>
              <p className="ihint">

                The import wizard, Admin → Access and this screen still list it.
                Importing is a deliberate choice with a preview and a duplicate
                check in front of it, and granting access is a permission
                decision — neither is browsing.
              </p>
              <p>

                Its{" "}
                <b>
                  {scopeAsk.entry.folders.length} ticked field section
                  {scopeAsk.entry.folders.length === 1 ? "" : "s"}
                </b>{" "}
                {scopeAsk.entry.folders.length === 1 ? "is" : "are"}{" "}
                <b>kept and still shown</b> on every record — scope decides
                which board a pipeline appears on, not which fields its records
                draw. So nothing is lost and this is reversible.
              </p>
              <p className="ihint">
                Nothing changes in GoHighLevel. This is the dashboard&apos;s own
                stored configuration.
              </p>
            </>
          }
        />
      ) : null}

      <div className="istep" style={{ marginTop: 20 }}>Referral attribution</div>
      <div className="pfgovern">
        <p>
          <b>Referring Partner</b> and <b>Event Source</b> live in{" "}
          <b>Referral Attribution</b>, separate from Referral Detail&apos;s
          waiver fields, so attribution can be shown on a client record without
          dragging waiver administration onto it.
        </p>
        <p className="ihint">
          A folder is ticked or not ticked as a whole — that is why the two
          attribution fields needed a folder of their own. If you reorganise
          these folders, keep that separation or attribution stops being
          showable on a client record without Waiver Type beside it.
        </p>
      </div>

      {data.builtInFoldersForeign ? (
        <div className="pfstale" style={{ marginTop: 16 }}>
          <b>This dashboard&apos;s built-in folder map is for a different account</b>
          <div className="ihint">
            Not one of its folder ids exists here, so every section below starts
            empty. That is not a fault on this account — it is this app carrying
            another location&apos;s ids. <b>Point each folder at a section</b> in
            the list underneath and the panels start drawing. Nothing is written
            to GoHighLevel: the mapping is this dashboard&apos;s own stored
            configuration.
          </div>
        </div>
      ) : null}

      {data.contactSections?.length ? (
        <>

          <details className="pfcontacts-wrap">
            <summary>
              Contact sections
              <span className="pfcwcount">
                {data.contactSections.length} mapped
                {data.unknownContactFolders?.length
                  ? ` · ${data.unknownContactFolders.length} not known about`
                  : ""}
              </span>
            </summary>
          <div className="pfgovern">
            <p>

              <b>These are sections on the PERSON, not on the case.</b> They
              follow a contact onto every record they hold, are the same
              everywhere, and are chosen by whether the record is a client or an
              applicant — not per pipeline. They are set in code today, so this
              list shows what is configured rather than letting you change it.
            </p>
            <p>

              <b>Where the two names differ, GoHighLevel&apos;s is on the right.</b>{" "}
              Search for that one in GoHighLevel — the left-hand name is this
              dashboard&apos;s.
            </p>
          </div>
          <div className="pfcontacts">
            {(["client", "caregiver"] as const).map((kind) => (
              <div className="pfcgroup" key={kind}>
                <div className="pfchead">
                  {kind === "client" ? "On a client" : "On an applicant"}
                </div>
                {data.contactSections

                  ?.filter((c) => c.appliesTo === kind || c.appliesTo === "both")
                  .map((c) => (
                    <div className="pfcrow" key={c.id}>
                      <span className="pfcname">{c.label}</span>

                      {c.renamed ? (
                        <span className="pfcghl" title="The name in GoHighLevel">
                          {c.ghlName}
                        </span>
                      ) : null}
                      <span className="pfcfields">

                        {c.fields.length} field{c.fields.length === 1 ? "" : "s"}
                      </span>
                      <code className="pfcid" title="Paste this into GoHighLevel to find the folder">
                        {c.id}
                      </code>
                    </div>
                  ))}
              </div>
            ))}
          </div>
          </details>

          {data.unknownContactFolders?.length ? (
            <div className="pfstale">
              <b>
                Contact folders in GoHighLevel this dashboard does not know about
              </b>

              <div className="ihint">
                Their fields are dropped from contact panels — not shown under
                &quot;Other&quot;, because a location&apos;s contact fields
                include every unrelated form on the account.{" "}
                <b>Point one at a section below and its fields start drawing.</b>
              </div>
              {data.unknownContactFolders.map((u) => (
                <div className="pfstalerow" key={u.id}>
                  <code>{u.id}</code>
                  <span className="ihint">
                    {u.fields.length} field{u.fields.length === 1 ? "" : "s"} ·{" "}
                    {u.fields
                      .slice(0, 3)
                      .map((f) => f.name)
                      .join(", ")}
                    {u.fields.length > 3 ? "…" : ""}
                  </span>
                  <div className="pfunkname">
                    <label htmlFor={`pfcunk-${u.id}`}>This folder is</label>
                    <select
                      id={`pfcunk-${u.id}`}
                      value={unkName[u.id] ?? ""}
                      disabled={busy}
                      onChange={(e) =>
                        setUnkName((m) => ({ ...m, [u.id]: e.target.value }))
                      }
                    >
                      <option value="">Not one of these…</option>
                      {(data.contactSections || [])

                        .filter((sec) => !sec.resolvedId)
                        .map((sec) => (
                          <option key={sec.id} value={sec.ghlName}>
                            {sec.label}
                            {sec.renamed ? ` (${sec.ghlName} in GoHighLevel)` : ""}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      disabled={busy || !(unkName[u.id] || "").trim()}
                      onClick={() => nameFolder(u.id)}
                    >
                      Save
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {hideAsk ? (
        <ConfirmDialog
          title={
            hideAsk.what === "field"
              ? `Hide “${hideAsk.label}” from ${hideAsk.p.name}?`
              : `Hide the ${hideAsk.label} section from ${hideAsk.p.name}?`
          }
          confirmLabel="Hide it anyway"
          busy={busy}
          onCancel={() => setHideAsk(null)}
          onConfirm={() => {
            const { apply } = hideAsk;
            setHideAsk(null);
            apply();
          }}
          body={
            <>
              <p>
                {hideAsk.count ? (
                  <>
                    <b>{hideAsk.label}</b>{" "}
                    {hideAsk.what === "field" ? "holds a value" : "holds values"} on{" "}
                    <b>
                      {hideAsk.count.records} record
                      {hideAsk.count.records === 1 ? "" : "s"}
                    </b>{" "}
                    in this pipeline.
                  </>
                ) : (

                  <>
                    <b>I cannot say how many records hold a value here</b> — the
                    applicant payload has not been loaded in this tab, so the
                    number would be a guess.
                  </>
                )}{" "}
                Unticking hides{" "}
                {hideAsk.what === "field" ? "it" : "those fields"} from the panel
                — <b>the values stay in GoHighLevel</b> and come back if you tick{" "}
                {hideAsk.what === "field" ? "it" : "the section"} again.{" "}
                <b>Nothing is deleted.</b>
              </p>
              {hideAsk.count ? (
                <p className="ihint">

                  Counted over the {hideAsk.count.scanned} record
                  {hideAsk.count.scanned === 1 ? "" : "s"} this tab has loaded for
                  this pipeline.
                </p>
              ) : null}
            </>
          }
        />
      ) : null}

      {deleteAsk ? (
        <ConfirmDialog
          title={`Delete “${deleteAsk.name}” from GoHighLevel?`}
          confirmLabel="Delete the pipeline"
          busy={busy}
          onCancel={() => setDeleteAsk(null)}
          onConfirm={() => {
            const p = deleteAsk;
            setDeleteAsk(null);
            void deletePipelineRow(p);
          }}
          body={
            <>
              <p>
                <b>This pipeline is empty</b> — no opportunities are in any of its{" "}
                {deleteAsk.stages.length} stage
                {deleteAsk.stages.length === 1 ? "" : "s"}. It is deleted{" "}
                <b>in GoHighLevel</b>, not just here, and that cannot be undone
                from this screen.
              </p>
              <p>

                Its dashboard configuration is removed with it. Deleting a
                pipeline in GoHighLevel alone leaves a stale entry here; doing
                both from one button is what avoids that.
              </p>
              <p className="ihint">
                The count is re-checked on the server before anything is deleted,
                so a record created since this screen loaded still stops it.
              </p>
            </>
          }
        />
      ) : null}

      {data.stale.length ? (
        <div className="pfstale">
          <b>No longer in GoHighLevel</b>
          <div className="ihint">
            These are still configured here but the pipeline is gone. Nothing breaks —
            the mapping is simply never read. Remove it when you are sure it is not
            coming back.
          </div>
          {data.stale.map((id) => (
            <div className="pfstalerow" key={id}>
              <code>{id}</code>
              <button type="button" onClick={() => removeEntry(id)} disabled={busy}>
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
