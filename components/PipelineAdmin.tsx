"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import ConfirmDialog from "./ConfirmDialog";
import { apiError } from "@/lib/apiFetch";
import { checkFieldName, suggestPrefix, composeFieldName, type KnownField } from "@/lib/fieldNaming";
import { divisionLabel } from "@/lib/division";
import type { StoredPipelineConfig, StoredPipelineEntry } from "@/lib/pipelineConfig";

interface Section {
  key: string;
  id: string;
  label: string;
  /** False when the label is a guess — the row then shows the id too. */
  named: boolean;
  /** `dataType` is what the expanded panel renders beside each name. */
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
  /** Folders withheld from the checklist because ticking them does nothing. */
  inertSections?: Unconfigured[];
}

// ⚠️ SUGGEST TWO, DO NOT IMPOSE. Every pipeline on this account starts with an
// intake stage and ends in a terminal one, but OLTL Enrollment has 13 stages and
// PP Caregiver Applicants has 7. There is no standard shape, so the form opens
// with two rows and an Add button rather than a template.
const SUGGESTED_STAGES = ["NEW LEAD", "LOST"];

/**
 * 🔴 ONE VOCABULARY FOR ONE THING — round 115b, item I.
 *
 * The expanded section panel and the create-field form both name a field's
 * type, and they must not name it two ways. "Choose one" vs "Dropdown — pick
 * one" is exactly how a screen ends up describing the same control twice, and
 * the create form's wording is the one a person has already read.
 *
 * ⚠️ An unknown key is returned AS GoHighLevel SENT IT rather than mapped to
 * "Other": a type this app has never met is something to notice, not to hide.
 */
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
  // ⚠️ NAME THE CONTROL, NOT THE ABSTRACTION. "Choose one" / "Choose several"
  // describe a rule; they do not tell an admin what will appear on the record.
  { key: "SINGLE_OPTIONS", label: "Dropdown — pick one" },
  { key: "MULTIPLE_OPTIONS", label: "Dropdown — pick several" },
  { key: "CHECKBOX", label: "Tickbox — yes or no" },
];

export default function PipelineAdmin({
  ssoBlob,
  recordCounts,
  countsComplete,
  onConfigSaved,
}: {
  ssoBlob: string | null;
  /**
   * pipelineId → records currently loaded for it.
   *
   * 🔴 FROM THE BROWSER'S OWN PAYLOAD, not a new request. The admin route would
   * need one opportunity search per pipeline to answer this, which is six calls
   * against a 100-per-10-seconds budget to render a sentence. page.tsx already
   * has the records.
   */
  recordCounts: Record<string, number>;
  /**
   * 🔴 ITEM S — TELL THE REST OF THE APP. Ticking a section saved correctly but
   * the record panel's "+ Add a section (N available)" stayed stale until a
   * page reload, because the panel reads `pipelineFolders` from the
   * /api/opportunities payload and nothing told it the config had changed.
   * The save already returns the new config; this just hands it over, so no
   * extra request is made to learn what we were just told.
   */
  onConfigSaved?: (folders: Record<string, string[]>) => void;
  /**
   * ⚠️ FALSE MEANS "I CANNOT SAY", NOT "ZERO". The applicant payload loads
   * lazily, so before the Caregivers section has been opened a caregiver
   * pipeline's count is unknown — and a confirm dialog that says "0 records
   * move" when it means "I did not look" is worse than one that says nothing.
   */
  countsComplete: boolean;
}) {
  /** The pipeline whose scope change is awaiting confirmation. */
  const [scopeAsk, setScopeAsk] = useState<{
    p: PipelineRow;
    entry: StoredPipelineEntry;
    next: "client" | "caregiver";
  } | null>(null);
  const [data, setData] = useState<Payload | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>(null);
  /** Which load() is current — see the sequence guard inside it. */
  const loadSeq = useRef(0);
  const [busy, setBusy] = useState(false);
  /**
   * 🔴 WHICH ACTION IS IN FLIGHT — round 115c, item 1.
   *
   * `busy` is shared by every write on this screen, and the Create button read
   * it directly: `{busy ? "Creating…" : "Create pipeline"}`. So ticking a
   * section on an ALREADY CONFIGURED pipeline relabelled the create button and
   * put its outcome in the create form's status line — an action reporting
   * itself in the wrong half of the screen.
   */
  const [busyAction, setBusyAction] = useState("");
  const [saveErr, setSaveErr] = useState<unknown>(null);
  const [saved, setSaved] = useState("");
  /**
   * 🔴 AND A PER-ROW OUTCOME — round 115c, item 1, and round 94 item 8 before
   * it. "It flashed and cleared" is an error nobody can read. A tick's result
   * now appears IN ITS OWN ROW and stays there until the next action on that
   * row, so a failure can be read, quoted, and reported.
   */
  const [rowMsg, setRowMsg] = useState<{ id: string; err?: unknown; ok?: string } | null>(null);

  const ssoHeader = useCallback(
    (): Record<string, string> => (ssoBlob ? { "x-ghl-sso-key": ssoBlob } : {}),
    [ssoBlob],
  );

  const load = useCallback(async () => {
    // 🔴 SEQUENCED — round 111, same reason as PipelineAccessTab: `ssoHeader`
    // depends on `ssoBlob`, so the arrival of the blob re-fires this with the
    // credential-less first attempt still open, and the loser used to win.
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

  /**
   * @param rowId when given, the outcome is reported IN THAT PIPELINE'S ROW
   *              rather than in the create form's status line.
   */
  const post = async (payload: Record<string, unknown>, rowId?: string) => {
    setBusy(true);
    setBusyAction(String(payload.action || ""));
    if (rowId) setRowMsg(null);
    else {
      setSaveErr(null);
      setSaved("");
    }
    try {
      const res = await fetch("/api/admin/pipelines", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ssoHeader() },
        body: JSON.stringify({ ssoKey: ssoBlob ?? undefined, ...payload }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(res, j);
      return j;
    } catch (e) {
      if (rowId) setRowMsg({ id: rowId, err: e });
      else setSaveErr(e);
      return null;
    } finally {
      setBusy(false);
      setBusyAction("");
    }
  };

  // ── CREATE FORM STATE ──────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"client" | "caregiver" | "">("");
  const [stages, setStages] = useState<string[]>([...SUGGESTED_STAGES]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // ITEM 3 — 🔴 TICK GENEROUSLY. Every section for the chosen scope is ticked
  // by default.
  //
  // ⚠️ SAFE ONLY BECAUSE OF ITEM 1. An empty section is not drawn, so the
  // all-twelve problem cannot come back: a record shows what it answered and
  // nothing else.
  //
  // 🔴 AND IT REMOVES THE ACCESS BOTTLENECK. A rep only has to ask an admin
  // when the admin ticked too few. Ticking everything means they never do —
  // they pull in what they need with "+ Add a section" themselves.
  useEffect(() => {
    if (!data || !scope) return;
    setPicked(new Set(data.sections.map((x) => x.key)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.sections, scope]);

  // ⚠️ THE DERIVED DIVISION, LIVE. divisionLabel() strips a trailing
  // Enrollment/Transfer/Clients/Applicants, so "Events Clients" and "Events"
  // both become "Events" and silently merge into one division. Showing the
  // result before the pipeline exists is the only way that is visible.
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

  /** Hand a freshly saved config to whoever renders record panels. */
  const announce = useCallback(
    (cfg: StoredPipelineConfig) => {
      if (!onConfigSaved) return;
      onConfigSaved(
        Object.fromEntries(
          Object.entries(cfg.pipelines).map(([id, e]) => [id, e.folders]),
        ),
      );
    },
    [onConfigSaved],
  );

  // ── PER-PIPELINE FOLDER EDITING ────────────────────────────────────────
  /**
   * 🔴 A STORED FOLDER MAY BE A KEY *OR* A RAW ID — round 113, item J.
   *
   * `StoredPipelineEntry.folders` is documented as hybrid (pipelineConfig.ts:47):
   * a folder created in code has a key like "shared", one created at runtime has
   * only its GoHighLevel id. The checkbox asked `folders.includes(s.key)` and
   * `s.key` is "the code key when there is one, the raw id otherwise" — so an
   * entry written by an API SCRIPT, which knows only ids, ticks nothing at all.
   *
   * ⚠️ REPRODUCED, NOT REASONED. scripts/section-grid-proof.mjs renders three
   * rows — screen-written, script-written, unconfigured — and the middle one
   * showed `3 section(s)` in its header with ZERO boxes ticked, which is exactly
   * what Events does live.
   *
   * Accepting both spellings is the read fix; `normaliseFolders` below is the
   * write fix, so an edited entry stops being ambiguous.
   */
  const isTicked = (entry: StoredPipelineEntry | undefined, s: Section) =>
    !!entry && (entry.folders.includes(s.key) || entry.folders.includes(s.id));

  /**
   * Toggle one section, writing back in the KEY spelling and dropping the id
   * spelling of the same folder so the entry converges on one form.
   */
  const normaliseFolders = (
    entry: StoredPipelineEntry | undefined,
    s: Section,
    sections: Section[],
  ): string[] => {
    const on = isTicked(entry, s);
    const keep = (entry?.folders ?? []).filter((tok) => {
      // Drop BOTH spellings of the folder being toggled…
      if (tok === s.key || tok === s.id) return false;
      return true;
    });
    // …and rewrite every other token to its key spelling where one exists, so
    // the whole entry is migrated by any single edit rather than half of it.
    const byId = new Map(sections.map((x) => [x.id, x.key]));
    const migrated = keep.map((tok) => byId.get(tok) ?? tok);
    return on ? migrated : [...migrated, s.key];
  };

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

  // ── NEW FIELD ──────────────────────────────────────────────────────────
  const [fieldOpen, setFieldOpen] = useState(false);
  // 🔴 OFF BY DEFAULT. It was on, prefilled from the pipeline name, and
  // offered BEFORE the section was chosen — so it suggested "RPM - " before
  // anything was known about where the field would land, which reads as the
  // app having decided something it could not have decided. A prefix is a
  // convention worth offering, not a default worth imposing.
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
    // Select what was just made, so the field being created lands in it.
    setFParent(j.folder.id);
  };

  useEffect(() => {
    // ⚠️ FROM THE DIVISION, NOT THE FOLDER NAME — "More Details - Office" is
    // meaningless, while "CG - " and "APP - " are instantly identifiable.
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

  // ⚠️ Only when there is nothing else to show. A failed RELOAD over a loaded
  // screen is a strip below (see the `loadErr` banner inside the return), not a
  // replacement for the screen.
  if (loadErr && !data)
    return (
      <div className="isec">
        <ErrorMessage error={loadErr} className="savemsg err" />
      </div>
    );
  if (!data) return <div className="isec"><div className="imeta">Loading…</div></div>;

  const inert = data.inertSections || [];

  const sectionRow = (s: Section, checked: boolean, onToggle: () => void) => (
    <div
      className={`pfsec ${s.named ? "" : "unnamed"}${
        expanded.has(s.key) ? " open" : ""
      }`}
      key={s.key}
    >
      <label className="pfseclab">
        <input type="checkbox" checked={checked} onChange={onToggle} />
        {/* 🔴 A NAME AND A DIAGNOSIS ARE NOT THE SAME THING, so they are not
            styled the same.

            A NAMED section's label is one or two words and reads as an
            identity — unchanged, at the card's own size.

            An UNNAMED section's label is a SENTENCE: the words "Unnamed
            section" plus a list of what is inside it. Rendered at the same
            weight and size as "Milestones" it READS AS A NAME, which invites
            an admin to tick it as though they know what it is. The whole
            reason the fields are listed is to say WE DO NOT KNOW, so the
            styling has to say that too: the marker small and in the warning
            colour already used by .pfunconf and .pfsecid, the field list
            smaller again and quieter, as supporting detail. */}
        {s.named ? (
          <span className="pfsecname">{s.label}</span>
        ) : (
          // 🔴 ONE LINE, LIKE EVERY OTHER ROW. This used to be a marker, a field
          // list AND an id on its own line — three lines each, four of them on a
          // screen of sixteen, so the rows that say "we do not know what this is"
          // took more space than the twelve that are fine.
          //
          // ⚠️ THE FIELD NAMES DID NOT GO MISSING, THEY WENT WHERE THEY BELONG.
          // Every row already has a chevron that reveals its fields; an unnamed
          // row needed no second mechanism for the same information, and showing
          // two of them with an ellipsis was never enough to recognise a folder
          // by anyway. Expanded, it shows ALL of them.
          <span className="pfsecunk" title="GoHighLevel does not share folder names with this dashboard">
            <span className="pfsecunk-w" aria-hidden="true">
              ⚠
            </span>
            <span className="pfsecunk-t">Unnamed section</span>
          </span>
        )}
      </label>
      <span className="pfseccount">{s.fields.length}</span>
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
      {/* ⚠️ EXPANDING LISTS THE FIELDS. Ticking a name alone is a guess —
          "More Details" and "Client Details" mean nothing until you see
          inside. The defs are already cached, so this costs no call.

          🔴 AND FOR AN UNNAMED FOLDER THE ID COMES WITH THEM. It was on the
          face of the collapsed row, in a code block, on its own line — a
          debugging aid dressed as a heading. It is the thing you paste into
          GoHighLevel to find the folder, so it belongs beside the fields you
          are reading to recognise it, not above them. */}
      {expanded.has(s.key) ? (
        /* 🔴 ONE FIELD PER LINE, WITH ITS TYPE — round 115b, item I.
           This joined every name with " · " into a block as narrow as the chip,
           so names broke mid-word and the separator landed at the start of a
           line as often as the end. Seven fields read as eight — the count and
           the list both come from `s.fields`, so they never disagreed; the
           rendering simply made them uncountable.
           ⚠️ AND THE TYPE IS THE POINT OF EXPANDING. A name alone does not say
           whether "Submitted At" is a date you can sort on or a string somebody
           typed, and `dataType` is already on every definition. */
        <div className="pfsecfields">
          <ol className="pffieldlist">
            {s.fields.map((f) => (
              <li key={f.id}>
                <span className="pffname">{f.name}</span>
                <span className="pfftype">{typeLabel(f.dataType)}</span>
              </li>
            ))}
          </ol>
          {!s.named ? (
            <div className="pfsecid" title="Paste this into GoHighLevel to find the folder">
              <code>{s.id}</code>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

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
      {/* ITEM 6 — 🔴 A FOLDER MADE IN GHL, FIXED IN ONE ACTION.
          We cannot read its name — GoHighLevel returns parentName empty and
          refuses the folder endpoint — so it cannot be mapped silently. The
          admin supplies the one thing we cannot obtain, and the ticking happens
          in the same action. */}
      {/* 🔴 THIS BANNER USED TO ASK THE WRONG QUESTION.
          "Unnamed section … [ Name it ]" says the folder has no name and the
          admin is inventing one. IT HAS A NAME. GoHighLevel simply will not
          share it — verified live, twice: `parentName` is empty on every field
          (lib/fieldFolders.ts:491, round 55), and
          GET /custom-fields/object-key/opportunity answers 400 "Api does not
          support objectKey of type contact or opportunity".
          So the admin is not naming anything. They are TELLING THIS DASHBOARD
          WHAT GOHIGHLEVEL ALREADY CALLS IT — a different, much easier question,
          and one they can answer by looking rather than by deciding. */}
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
                {/* ⚠️ ALL OF THEM, NEVER "two and an ellipsis". These names are
                    the ONLY way to recognise which folder this is — the whole
                    point of listing them. Truncating the evidence and then
                    asking the question is asking a question that cannot be
                    answered. */}
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

      {/* ⚠️ WITHHELD, NOT MISSING. A folder that vanishes with no explanation is
          the same class of problem as one that appears with no name. */}
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

      {/* ⚠️ WHY ALL FOUR CONTROLS ARE HERE. */}
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
        {/* 🔴 REQUIRED, NEVER GUESSED. The two lists being separate is what
            stops an applicant reaching a client caller. */}
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
              {/* Position comes from LIST ORDER, never typed. */}
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
      {/* 🔴 SAY WHAT TICKING DOES, AND WHY THE SCREEN EXISTS — round 115b,
          items N and R. Fourteen checkboxes under a four-word label left an
          admin to infer the rest, and an admin who does not know the reason
          ticks everything — which is the exact failure the screen was built to
          prevent.
          ⚠️ `.pfgovern`, NOT `.pfwhy` — that class already belongs to the
          screen-level note further up, and reusing it gave the page two
          elements with one class and one name for two different explanations.
          Caught by loader-sweep rule 7 within a minute of writing it. */}
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
        {/* 🔴 ITEM N — and it is verified, not assumed: the route reads
            getEditableFieldDefs("opportunity") at :167, :306 and :337 and never
            touches contact fields. The names collide, too — "Client" is an
            opportunity folder and the contact side has one of its own — so an
            admin hunting for "Caregiver Application" here would wrongly
            conclude it does not exist. */}
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
          {/* 🔴 ITS OWN GRID, NOT `.irow`. This borrowed the Destination row's
              flex layout, where `.irow input` carries min-width:150px and the
              label another 150 — four controls on one wrapping line, inside a
              container that was itself being clipped. The result was an input
              that could not be reached or typed into. A two-column grid with
              explicit widths cannot collapse that way. */}
          {/* 🔴 SECTION FIRST. The form asked for the name and a prefix before
              the section, so the prefix was suggested before anything was known
              about where the field would land. Choose the destination, then
              name the thing going into it. */}
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

            {/* ⚠️ WIRED UP AT LAST. The route has had a `create-section` action
                since round 90 and nothing on screen ever called it, so
                "everything for this pipeline stays together" was an intention
                with no control behind it. */}
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

          {/* 🔴 BLOCK a normalised clash. ⚠️ WARN, never block, on a similar
              name or an identical picklist — a false positive that stops
              someone working is worse than a duplicate they can merge. */}
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

      {/* ── EXISTING PIPELINES ─────────────────────────────────────────── */}
      <div className="istep" style={{ marginTop: 20 }}>Configured pipelines</div>
      <div className="pflist">
        {data.pipelines.map((p) => {
          const entry = data.config.pipelines[p.id];
          return (
            <details className="pfrow" key={p.id}>
              <summary>
                <b>{p.name}</b>
                <span className="pfscope">{entry ? entry.scope : "not configured"}</span>
                <span className="pfcount">
                  {entry ? `${entry.folders.length} section(s)` : "Shared only"}
                </span>
              </summary>
              {/* 🔴 SCOPE IS EDITABLE AFTER ALL — round 112, item 9.
                  The create form says "This cannot be changed afterwards from
                  here", and that was true of the SCREEN, not of the data: the
                  `save-config` action writes the whole stored entry, scope
                  included, and this editor was already re-sending it on every
                  folder tick. So the only thing missing was a control.
                  ⚠️ IT MOVES A WHOLE PIPELINE between the client and applicant
                  sections, which is why it asks first and says so. Nothing is
                  written to GoHighLevel's pipeline itself — this is the stored
                  MM Pipeline Folders value, and it is reversible here. */}
              {/* 🔴 THE OUTCOME, IN THE ROW THAT CAUSED IT — round 115c.
                  It used to land in the create form's status line at the top of
                  the screen, where it flashed past unread. It stays here until
                  the next action on this row. */}
              {rowMsg && rowMsg.id === p.id ? (
                rowMsg.err ? (
                  <ErrorMessage error={rowMsg.err} className="savemsg err pfrowmsg" />
                ) : (
                  <div className="savemsg ok pfrowmsg">{rowMsg.ok}</div>
                )
              ) : null}
              <div className="pfscopeedit">
                <label htmlFor={`pfscope-${p.id}`}>Scope</label>
                <select
                  id={`pfscope-${p.id}`}
                  value={entry?.scope ?? ""}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.value as "client" | "caregiver" | "";
                    if (!next) return;
                    // 🔴 THE APP'S OWN DIALOG — round 115b, item M. A native
                    // confirm() cannot be styled, carries the vercel.app URL,
                    // and reads as a browser warning rather than part of the
                    // app. Every other consequential action here already uses
                    // ConfirmDialog; this was the one that did not.
                    if (entry && next !== entry.scope) {
                      e.target.value = entry.scope; // until the answer comes back
                      setScopeAsk({ p, entry, next });
                      return;
                    }
                    void saveEntry(p.id, {
                      scope: next,
                      folders: entry?.folders ?? [],
                    });
                  }}
                >
                  <option value="">Choose a scope…</option>
                  <option value="client">Client</option>
                  <option value="caregiver">Caregiver</option>
                </select>
                <span className="ihint">
                  Decides which section its records appear in. Reversible.
                </span>
              </div>
              <div className="pfseclist">
                {data.sections.map((s) =>
                  sectionRow(s, isTicked(entry, s), () => {
                    // 🔴 DO NOT INVENT A SCOPE — round 112, item 9.
                    // This was `entry?.scope ?? "client"`, so ticking a single
                    // section on a pipeline that had NO stored entry silently
                    // stamped it `client`. That is almost certainly how "Events"
                    // became client-scoped: it was created by an API script
                    // rather than through this screen, so it had no entry, and
                    // the first folder tick chose for everybody. A scope is a
                    // decision; it is now asked for rather than assumed.
                    if (!entry) {
                      setRowMsg({
                        id: p.id,
                        err: new Error(
                          `"${p.name}" has no scope yet. Choose Client or Caregiver ` +
                            `above before ticking sections — picking one for you is ` +
                            `how a pipeline ends up in the wrong section.`,
                        ),
                      });
                      return;
                    }
                    void saveEntry(p.id, {
                      scope: entry.scope,
                      folders: normaliseFolders(entry, s, data.sections),
                    });
                  }),
                )}
              </div>
            </details>
          );
        })}
      </div>

      {/* 🔴 THE SCOPE CONFIRM, WITH THE NUMBER — round 115b, item M.
          "Its records leave the Clients board" without saying how many is the
          difference between a considered choice and a mis-click. ODP Enrolment
          holds 139. */}
      {scopeAsk ? (
        <ConfirmDialog
          title={`Move “${scopeAsk.p.name}” to the ${
            scopeAsk.next === "caregiver" ? "Caregivers" : "Clients"
          } section?`}
          confirmLabel={`Move to ${
            scopeAsk.next === "caregiver" ? "Caregivers" : "Clients"
          }`}
          busy={busy}
          onCancel={() => setScopeAsk(null)}
          onConfirm={() => {
            const { p, entry, next } = scopeAsk;
            setScopeAsk(null);
            void saveEntry(p.id, { scope: next, folders: entry.folders });
          }}
          body={
            <>
              <p>
                {/* ⚠️ A NUMBER, OR AN HONEST ABSENCE OF ONE. */}
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
                They leave the{" "}
                {scopeAsk.entry.scope === "caregiver" ? "Caregivers" : "Clients"}{" "}
                board and appear on the other one instead.
              </p>
              <p>
                {/* 🔴 THE QUESTION YOU ASKED: KEPT AND STILL USED. Verified —
                    `groupFieldsForPipeline` takes the stored folder list and the
                    pipeline id and never consults scope, so the ticks survive a
                    move and the record panel keeps drawing them. Which is also
                    what makes "you can move it back" true. */}
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

      {/* ⚠️ RECONCILE, NEVER AUTO-DELETE. */}
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
