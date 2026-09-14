"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import ConfirmDialog from "./ConfirmDialog";
import { apiError } from "@/lib/apiFetch";
import { checkFieldName, suggestPrefix, composeFieldName, type KnownField } from "@/lib/fieldNaming";
import { divisionLabel } from "@/lib/division";
import type {
  StoredPipelineConfig,
  StoredPipelineEntry,
  PipelineScope,
} from "@/lib/pipelineConfig";

/**
 * 🔴 ITEM K — SCOPE IS "WHICH PICKER LISTS THIS PIPELINE", AND THE SCREEN NOW
 * SAYS SO.
 *
 * It read "Scope · Decides which section its records appear in", which is the
 * thing it is NOT: 115b established that `groupFieldsForPipeline` never consults
 * scope, so records render identically either way. What it decides is whether
 * the Clients board's picker or the Caregivers board's picker offers it.
 *
 * ⚠️ AND "neither" IS NOT A THIRD BOARD. It is an absence — for a pipeline read
 * by its own section, like Events, which the Referrals screen resolves by name
 * and nothing else ever browses.
 */
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
  /** ITEM O — the contact-side table, read-only, with BOTH names. */
  contactSections?: {
    id: string;
    ghlName: string;
    label: string;
    appliesTo: "caregiver" | "client" | "both";
    renamed: boolean;
    fields: { id: string; name: string; dataType?: string }[];
  }[];
  /** ITEM O — contact folders GoHighLevel has that this app has never heard of. */
  unknownContactFolders?: { id: string; fields: { id: string; name: string }[] }[];
}

/** What `countFieldValues` gives back. null means "I could not count". */
interface ValueCount {
  perField: Record<string, number>;
  /** DISTINCT records holding a value in at least one of the fields asked for. */
  records: number;
  scanned: number;
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
  countFieldValues,
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
  onConfigSaved?: (
    folders: Record<string, string[]>,
    exclusions: Record<string, string[]>,
  ) => void;
  /**
   * 🔴 ITEM T — how many records in this pipeline hold a value in these fields.
   *
   * ⚠️ CALLED ON DEMAND, NEVER ON LOAD. Expanding a section asks; opening an
   * untick confirmation asks. Nothing sweeps 596 records to render a screen
   * nobody has interacted with.
   *
   * ⚠️ AND null MEANS "I CANNOT SAY", not zero — same contract as
   * `countsComplete` above, for the same lazily-loaded applicant payload.
   */
  countFieldValues?: (pipelineId: string, fieldIds: string[]) => ValueCount | null;
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
    next: PipelineScope;
  } | null>(null);
  /**
   * 🔴 ITEM T — an untick that would hide filled-in data, awaiting an answer.
   * `field` for one field, `section` for a whole folder. Held with the count
   * already taken, so the dialog never recomputes while it is open.
   */
  const [hideAsk, setHideAsk] = useState<{
    p: PipelineRow;
    entry: StoredPipelineEntry;
    what: "field" | "section";
    label: string;
    count: ValueCount | null;
    apply: () => void;
  } | null>(null);
  /** ITEM L — the pipeline awaiting a delete confirmation. */
  const [deleteAsk, setDeleteAsk] = useState<PipelineRow | null>(null);
  /**
   * 🔴 ITEM L — COUNTS ASKED OF THE SERVER, pipelineId → number | null.
   *
   * ⚠️ `recordCounts` CANNOT ANSWER THIS AND IT TOOK A MEASUREMENT TO SEE IT.
   * It is built by counting the records in the loaded payloads, so a pipeline
   * with NO records is simply absent from it — and absent already means "not
   * loaded". The two pipelines item L exists to remove are unconfigured, in no
   * board's payload, so the browser will never hold a count for either.
   *
   * `null` is a recorded "I could not count", and is NOT retried on every
   * render — a value being present is what stops the request repeating.
   */
  const [serverCounts, setServerCounts] = useState<Record<string, number | null>>({});
  const counting = useRef<Set<string>>(new Set());
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
  const [rowMsg, setRowMsg] = useState<{
    id: string;
    err?: unknown;
    ok?: string;
    /**
     * 🔴 A REFUSAL — round 119, item 3. The app declined ON PURPOSE and the
     * message IS the instruction, so it is shown directly, in amber, with no
     * "Something went wrong" and no details toggle. A FAULT keeps the
     * ErrorMessage wrapper, which is right for something unexpected.
     */
    refusal?: string;
  } | null>(null);
  /**
   * 🔴 WHICH ROW IS WRITING — round 119, item 4. `busy` is global, so nothing
   * on screen said WHERE the work was happening, and a tick was silent while it
   * saved. An admin then clicks again — which is a second write, and the
   * read-back compares against whichever landed last.
   */
  const [busyRow, setBusyRow] = useState("");

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
        body: JSON.stringify({ ssoKey: ssoBlob ?? undefined, ...payload }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(res, j);
      return j;
    } catch (e) {
      // ⚠️ A REFUSAL THE SERVER MARKED travels as one to the screen. The route
      // is the only thing that knows whether a 409 was a deliberate decline or
      // GoHighLevel objecting, so it says so rather than leaving this to infer
      // it from the status code.
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
        Object.fromEntries(
          Object.entries(cfg.pipelines)
            .filter(([, e]) => e.exclude?.length)
            .map(([id, e]) => [id, e.exclude as string[]]),
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

  /**
   * 🔴 ITEM Q — IS THIS FIELD EXCLUDED ON THIS PIPELINE?
   *
   * ⚠️ DEFAULT IS ALL-IN. An empty (or absent) `exclude` means every field of
   * every ticked folder shows — which is what makes "a field added in GHL
   * tomorrow appears by itself" true. Read the direction carefully: this returns
   * TRUE for the exception.
   */
  const isExcluded = (entry: StoredPipelineEntry | undefined, fieldId: string) =>
    !!entry?.exclude?.includes(fieldId);

  /** The entry with one field's exclusion flipped. */
  const withExclusion = (
    entry: StoredPipelineEntry,
    fieldId: string,
    exclude: boolean,
  ): StoredPipelineEntry => {
    const cur = entry.exclude ?? [];
    const next = exclude
      ? [...new Set([...cur, fieldId])]
      : cur.filter((x) => x !== fieldId);
    // ⚠️ THE KEY IS DROPPED WHEN IT EMPTIES. `exclude: []` on every pipeline is
    // bytes in a custom value with a size limit, and it makes "this pipeline
    // hides nothing" read as a configured state rather than the default.
    return next.length
      ? { ...entry, exclude: next }
      : { scope: entry.scope, folders: entry.folders };
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

  /**
   * 🔴 ITEM T — WARN BEFORE HIDING SOMETHING THAT HOLDS DATA.
   *
   * Unticking hides a field from every record in the pipeline. THE DATA IS NOT
   * DELETED — it stays in GoHighLevel — but a rep who filled it in yesterday
   * finds it gone today and assumes it was lost. So say so first, with the
   * number, because "43 records" is what makes it a decision.
   *
   * ⚠️ NO DIALOG WHEN THE COUNT IS ZERO. A field nobody has filled is a free
   * untick, and a confirmation on every one of them is how people learn to click
   * through the ones that matter.
   *
   * ⚠️ AND NEVER ON THE WAY BACK. Ticking a field SHOWS it — nothing can be lost
   * by that, so it saves immediately.
   */
  const askThenHide = (
    p: PipelineRow,
    entry: StoredPipelineEntry,
    what: "field" | "section",
    label: string,
    fieldIds: string[],
    apply: () => void,
  ) => {
    const count = countFieldValues ? countFieldValues(p.id, fieldIds) : null;
    // 🔴 A REAL ZERO SKIPS THE DIALOG. A null does NOT — "I could not count" is
    // exactly when an admin should be asked, not when they should be waved
    // through. This is the same distinction round 115b drew for the scope
    // dialog, in the direction that costs a click rather than data.
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
      apply(); // showing it again — nothing to warn about
      return;
    }
    askThenHide(p, entry, "field", f.name, [f.id], apply);
  };

  /**
   * The count this screen trusts for one pipeline, or undefined for "not known
   * yet". The browser's payload wins when it has one — it is free and current —
   * and the server answers for everything else.
   *
   * ⚠️ THE CAREGIVER CAVEAT STILL APPLIES to the browser half: before the
   * applicant payload has loaded, a caregiver pipeline's absence from
   * `recordCounts` means nothing, so it falls through to the server.
   */
  const countFor = (p: PipelineRow): number | null | undefined => {
    const entry = data?.config.pipelines[p.id];
    const local = recordCounts[p.id];
    if (local != null && (countsComplete || entry?.scope !== "caregiver")) return local;
    return serverCounts[p.id];
  };

  /**
   * 🔴 ONE REQUEST, WHEN THE ROW IS OPENED — not on load, not for all ten.
   * Ten pipelines counted on load is ten searches against a 100-per-10-seconds
   * budget to render a screen nobody has interacted with yet.
   */
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
      // ⚠️ A FAILED COUNT IS RECORDED AS null, NOT LEFT UNSET. Unset would
      // re-fire on the next render; null is "asked, and could not be told",
      // which is what the row then says.
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

  /**
   * ITEM 3 — run the attribution move and SHOW EVERY STEP.
   *
   * ⚠️ THE STEPS ARE KEPT EVEN WHEN IT FAILS. The route returns them inside the
   * error body precisely so a partial run is readable: "the folder was created,
   * the first field moved, the second did not" is actionable, and "it failed"
   * is not. That was round 93's orphan, from the outside.
   */
  const [attribSteps, setAttribSteps] = useState<
    { step: string; ok: boolean; detail: string }[] | null
  >(null);

  /** The step in flight, named — so the button is never silent. */
  const [attribNow, setAttribNow] = useState("");

  /**
   * 🔴 THREE REQUESTS, NOT ONE — round 119, item 1.
   *
   * ⚠️ IT SHOWED "1." AND THEN NOTHING, and the reason was structural: the
   * route returned every step at the END, so a slow run and a dead run looked
   * identical. The step log existed only once the work was over, which is the
   * one moment it is no longer useful.
   *
   * Now each step is its own request and renders the moment it lands. A run
   * that dies part-way has REPORTED what it did, and clicking again resumes —
   * every step is idempotent.
   */
  const runAttribution = async () => {
    setAttribSteps([]);
    setBusy(true);
    setBusyAction("attribution-folder");
    setSaveErr(null);
    setSaved("");
    const add = (step: string, ok: boolean, detail: string) =>
      setAttribSteps((prev) => [...(prev || []), { step, ok, detail }]);
    try {
      let folderId = "";
      // ⚠️ NAMED IN THE PRESENT TENSE, because the button has to say what is
      // happening while it happens — not afterwards.
      const labels: Record<string, string> = {
        folder: "creating the folder…",
        fields: "moving Referring Partner and Event Source…",
        tick: "ticking it onto the client pipelines…",
      };
      for (const step of ["folder", "fields", "tick"] as const) {
        setAttribNow(labels[step]);
        const res = await fetch("/api/admin/pipelines", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...ssoHeader() },
          body: JSON.stringify({
            ssoKey: ssoBlob ?? undefined,
            action: "attribution-folder",
            step,
            folderId: folderId || undefined,
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          // 🔴 THE STEPS THAT DID SUCCEED STAY ON SCREEN. "The folder was
          // created, the first field moved, the second did not" is actionable;
          // "it failed" is round 93's orphan seen from the outside.
          add(step, false, String(j.detail || j.error || `Step failed (${res.status}).`));
          throw apiError(res, j);
        }
        if (j.folderId) folderId = j.folderId;
        if (Array.isArray(j.results)) for (const r of j.results) add(step, r.ok, r.detail);
        else add(step, j.ok !== false, String(j.detail || "Done."));
        if (j.config) {
          setData((d) => (d ? { ...d, config: j.config } : d));
          announce(j.config);
        }
      }
      setSaved("Referral Attribution is in place.");
      await load(); // the folder is new, so the section list has to be re-read
    } catch (e) {
      setSaveErr(e);
    } finally {
      setAttribNow("");
      setBusy(false);
      setBusyAction("");
    }
  };

  /** ITEM L — delete in GoHighLevel and drop the stored entry, in one call. */  /** ITEM L — delete in GoHighLevel and drop the stored entry, in one call. */
  const deletePipelineRow = async (p: PipelineRow) => {
    const j = await post({ action: "delete-pipeline", pipelineId: p.id }, p.id);
    if (!j || !data) return;
    // ⚠️ REMOVED FROM THE LIST HERE, not by a reload. `load()` would work, but it
    // re-fetches every field definition to redraw a list we can correct in place
    // — and the route has already told us the new config.
    setData({
      ...data,
      pipelines: data.pipelines.filter((x) => x.id !== p.id),
      config: j.config ?? data.config,
      stale: data.stale.filter((s) => s !== p.id),
    });
    if (j.config) announce(j.config);
    setSaved(`Deleted “${p.name}”.`);
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

  /**
   * @param per when given, the expanded panel becomes an EXCLUSION editor for
   *            that pipeline. Absent in the create form, deliberately: there is
   *            no pipeline yet to exclude a field on, and offering the control
   *            there would imply the exceptions travel with the template.
   */
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
        {/* 🔴 ITEM 4 — DISABLED IS THE IMPORTANT HALF. Every other write control
            on this screen already carried `disabled={busy}`; this one, the most
            clicked of them all, did not. A second click during the first
            request is a second write, and the read-back then compares against
            whichever landed last — which is where item 2's false "truncated"
            and 115c's "fails once, works the second time" both live. */}
        <input type="checkbox" checked={checked} disabled={busy} onChange={onToggle} />
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
      {/* 🔴 ITEM Q — THE COUNT SAYS WHAT IS SHOWING, NOT WHAT EXISTS. A folder
          of six with two excluded reads "4 of 6", because "6" beside a panel
          drawing four is the kind of quiet disagreement round 115b's item I was
          about. Unmodified folders are unchanged: a bare number. */}
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
          {/* 🔴 ITEM Q — PER-FIELD EXCLUSIONS, INSIDE THE FOLDER TICK.
              Shared holds six fields and NONE of them describes an applicant:
              Road Blocker is an enrolment concept, Case Manager and Sales Rep
              Assistant are client roles, County means the CLIENT's county. So
              ticking Shared onto a caregiver pipeline put six client fields on
              an applicant card — and unticking it lost Office too, which a
              recruiter legitimately wants.
              ⚠️ THE TICK IS "SHOW", THE STORED VALUE IS "EXCLUDE". Ticked is the
              default, so a field created in GoHighLevel tomorrow is in nobody's
              exclusion list and appears by itself — fieldFolders.ts:8. */}
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
                      // ⚠️ A FOLDER THAT IS NOT TICKED HAS NOTHING TO EXCLUDE
                      // FROM. Leaving these live would let an admin curate a
                      // panel that is not being drawn, and then wonder why.
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
              {/* ⚠️ SAY WHERE THE DATA WENT. "Hidden" and "deleted" are the same
                  word to somebody who filled the field in yesterday. */}
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
          const count = countFor(p);
          return (
            <details
              className="pfrow"
              key={p.id}
              // 🔴 COUNT WHEN IT OPENS. `onToggle` fires for open AND close;
              // `ensureCount` is idempotent and returns immediately once a count
              // (or a recorded null) exists, so closing costs nothing.
              onToggle={(e) => {
                if ((e.currentTarget as HTMLDetailsElement).open) void ensureCount(p);
              }}
            >
              <summary>
                <b>{p.name}</b>
                <span className="pfscope">
                  {/* ⚠️ "none" IS NOT A WORD ON A SCREEN. It is a stored token;
                      what an admin needs to read is what it does. */}
                  {!entry
                    ? "not configured"
                    : entry.scope === "none"
                      ? "no board picker"
                      : entry.scope}
                </span>
                <span className="pfcount">
                  {entry ? `${entry.folders.length} section(s)` : "Shared only"}
                  {entry?.exclude?.length
                    ? ` · ${entry.exclude.length} field${
                        entry.exclude.length === 1 ? "" : "s"
                      } hidden`
                    : ""}
                </span>
                {/* ⚠️ THE RECORD COUNT ON THE FACE OF THE ROW — item L. It is
                    what decides whether Delete is offered, so reading it should
                    not require opening the row and reading a refusal. */}
                <span className="pfreccount">
                  {count != null ? `${count} record${count === 1 ? "" : "s"}` : ""}
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
                rowMsg.refusal ? (
                  // 🔴 AMBER, DIRECT, NO TOGGLE. The message is the instruction.
                  <div className="savemsg warn pfrowmsg">{rowMsg.refusal}</div>
                ) : rowMsg.err ? (
                  <ErrorMessage error={rowMsg.err} className="savemsg err pfrowmsg" />
                ) : (
                  <div className="savemsg ok pfrowmsg">{rowMsg.ok}</div>
                )
              ) : null}
              {/* ITEM 4 — the row says it is working, where the work is. */}
              {busy && busyRow === p.id ? (
                <div className="pfrowbusy pfrowmsg">
                  <span className="pfspin" aria-hidden="true" />
                  Saving…
                </div>
              ) : null}
              <div className="pfscopeedit">
                {/* 🔴 ITEM K — THE LABEL WAS WRONG, NOT JUST SHORT. "Decides
                    which section its records appear in" describes something
                    this setting does not do: 115b established that
                    groupFieldsForPipeline never consults scope, so records draw
                    identically either way. What it decides is which BOARD
                    PICKER lists the pipeline — and the pipeline dropdown is the
                    only place anyone selects one. */}
                <label htmlFor={`pfscope-${p.id}`}>Show this pipeline in</label>
                <select
                  id={`pfscope-${p.id}`}
                  value={entry?.scope ?? ""}
                  disabled={busy}
                  onChange={(e) => {
                    const next = e.target.value as PipelineScope | "";
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
                  <option value="">Choose where it is listed…</option>
                  {SCOPE_CHOICES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                {/* 🔴 ROUND 120 · ITEM 1 — WHICH RECRUITING GROUP.
                    ⚠️ ONLY FOR A CAREGIVER PIPELINE. All five applicant
                    pipelines are caregiver-scope, so scope cannot tell the two
                    families apart and this is the second axis. A client
                    pipeline has no recruiting group and is not asked. */}
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
                      {/* ⚠️ SAY WHAT THE DEFAULT IS. An unset pipeline reads as
                          Caregivers, which is a decision this screen made on
                          the admin's behalf and should therefore admit to. */}
                      Which half of the Recruiting section lists it. Unset reads
                      as Caregivers.
                    </span>
                  </div>
                ) : null}
                <span className="ihint">
                  {/* 🔴 THE RULE, IN ONE SENTENCE: hide from BROWSING surfaces,
                      never from ADMIN ones. Verified in the code, not assumed —
                      every board reads getSelectedPipelines(scope) and every
                      admin surface reads listPipelines(): the import wizard
                      (api/import/meta), the access grid
                      (api/admin/pipeline-access) and this screen. */}
                  Which board&apos;s pipeline picker offers it. The import wizard,
                  Admin → Access and this screen always list every pipeline.
                  Reversible.
                </span>
                {/* 🔴 ITEM L — DELETE, GATED ON THE RECORD COUNT.
                    There was deliberately no delete action because "the
                    opportunities in a stage have to go somewhere". That holds
                    for a pipeline WITH records. It does not hold for an empty
                    one — and two empty, never-configured probe pipelines have
                    been in this list for twenty-five rounds with no way to
                    remove them. */}
                <div className="pfdelete">
                  {count === undefined ? (
                    <span className="ihint">Counting the records in this pipeline…</span>
                  ) : count === null ? (
                    // ⚠️ THE SAME "I CANNOT SAY" AS THE SCOPE DIALOG, and no
                    // delete offered in that state. A refusal to guess is not a
                    // reason to offer the irreversible action anyway.
                    <span className="ihint">
                      I could not count the records in this pipeline, so Delete is
                      not offered. Close and reopen this row to try again.
                    </span>
                  ) : count > 0 ? (
                    // 🔴 SAY THE NUMBER. That is what makes the refusal
                    // understandable rather than arbitrary.
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
                    // 🔴 DO NOT INVENT A SCOPE — round 112, item 9.
                    // This was `entry?.scope ?? "client"`, so ticking a single
                    // section on a pipeline that had NO stored entry silently
                    // stamped it `client`. That is almost certainly how "Events"
                    // became client-scoped: it was created by an API script
                    // rather than through this screen, so it had no entry, and
                    // the first folder tick chose for everybody. A scope is a
                    // decision; it is now asked for rather than assumed.
                    if (!entry) {
                      // 🔴 ROUND 119 · ITEM 3 — A REFUSAL, SHOWN DIRECTLY.
                      // This was `err: new Error(...)`, so round 112's guard —
                      // a deliberate decision, with the instruction in it —
                      // rendered as "✗ Something went wrong. The details below
                      // will help us fix it." with the sentence hidden behind a
                      // disclosure triangle. Nothing went wrong.
                      setRowMsg({
                        id: p.id,
                        refusal:
                          `“${p.name}” has no scope yet. Choose a scope above ` +
                          `before ticking sections — picking one for you is how a ` +
                          `pipeline ends up in the wrong section.`,
                      });
                      // ⚠️ AND POINT AT THE FIX. The dropdown is on this row.
                      document.getElementById(`pfscope-${p.id}`)?.focus();
                      return;
                    }
                    const next = {
                      ...entry,
                      folders: normaliseFolders(entry, s, data.sections),
                    };
                    const apply = () => void saveEntry(p.id, next);
                    // 🔴 ITEM T, FOR A WHOLE FOLDER — sum across its fields.
                    // "Shared holds values on 61 records in this pipeline."
                    // ⚠️ Only on the way OUT. Ticking a section shows fields;
                    // nothing can be lost by that.
                    if (!isTicked(entry, s)) {
                      apply();
                      return;
                    }
                    askThenHide(
                      p,
                      entry,
                      "section",
                      s.named ? s.label : "This section",
                      // ⚠️ EXCLUDED FIELDS ARE NOT COUNTED. They are already
                      // hidden, so unticking the folder does not hide them
                      // again — counting them would inflate the warning with
                      // records that lose nothing.
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

      {/* 🔴 THE SCOPE CONFIRM, WITH THE NUMBER — round 115b, item M.
          "Its records leave the Clients board" without saying how many is the
          difference between a considered choice and a mis-click. ODP Enrolment
          holds 139. */}
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
            // ⚠️ `...entry` — the exclusions travel with it. Rebuilt as
            // `{ scope, folders }` they would be silently dropped by a move.
            void saveEntry(p.id, { ...entry, scope: next });
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
                {/* 🔴 THE HALF THAT DOES NOT CHANGE, SAID OUT LOUD. */}
                The import wizard, Admin → Access and this screen still list it.
                Importing is a deliberate choice with a preview and a duplicate
                check in front of it, and granting access is a permission
                decision — neither is browsing.
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

      {/* ── ROUND 118 · ITEM 3 — THE ATTRIBUTION FOLDER MOVE, WATCHABLE ──── */}
      <div className="istep" style={{ marginTop: 20 }}>Referral attribution</div>
      <div className="pfgovern">
        <p>
          <b>Referring Partner is on the Events pipeline only.</b> It sits in
          <b> Referral Detail</b> beside Waiver Type, Authorized Units and
          Referral Decline Reason — waiver administration, which is a different
          job. A folder is ticked or not ticked as a whole, so attribution
          cannot be shown on a client record without dragging waiver fields onto
          it too.
        </p>
        <p>
          This creates <b>Referral Attribution</b>, moves <b>Referring
          Partner</b> and <b>Event Source</b> into it, and ticks it onto every
          client pipeline. ⚠️ <b>Nothing is deleted</b> — the fields keep their
          values and Referral Detail keeps its other three.
        </p>
        <p className="ihint">
          {/* 🔴 ROUND 93 LEFT AN ORPHAN when createFieldFolder failed, and the
              defence is not a try/catch — it is saying which step got how far.
              Running it twice is safe: an existing folder is reused and a field
              already moved is skipped. */}
          Each step is reported below as it happens. Running it again is safe —
          it reuses the folder and skips anything already moved.
        </p>
      </div>
      <div className="pfattrib">
        <button
          type="button"
          className="pfprimary"
          disabled={busy}
          onClick={() => void runAttribution()}
        >
          {busy && busyAction === "attribution-folder"
            ? attribNow || "Working…"
            : "Create Referral Attribution and move the fields"}
        </button>
        {attribSteps ? (
          <ol className="pfsteps">
            {attribSteps.map((s, i) => (
              <li key={i} className={s.ok ? "ok" : "bad"}>
                <span className="pfstepwhat">{s.step}</span>
                <span className="pfstepdetail">{s.detail}</span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      {/* ── ITEM O — CONTACT SECTIONS, READ-ONLY, WITH BOTH NAMES ────────── */}
      {data.contactSections?.length ? (
        <>
          <div className="istep" style={{ marginTop: 20 }}>
            Contact sections — not editable here
          </div>
          <div className="pfgovern">
            <p>
              {/* 🔴 THE HONEST HALF. These are hardcoded in
                  lib/fieldFolders.ts:493 and there is no way for an admin to
                  change them without a deploy. Building a control that only
                  half works would be worse than saying so. */}
              <b>These are sections on the PERSON, not on the case.</b> They
              follow a contact onto every record they hold, are the same
              everywhere, and are chosen by whether the record is a client or an
              applicant — not per pipeline. They are set in code today, so this
              list shows what is configured rather than letting you change it.
            </p>
            <p>
              {/* 🔴 BOTH NAMES, BECAUSE THE DASHBOARD RENAMES THEM. An admin
                  searching GoHighLevel for "Enquiry Details" finds nothing. */}
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
                  // ⚠️ "both" APPEARS UNDER BOTH HEADINGS — round 118, item 2.
                  // Filtered on equality alone, the attribution folder would
                  // render under neither, which is the same disappearance the
                  // item is fixing one level down.
                  ?.filter((c) => c.appliesTo === kind || c.appliesTo === "both")
                  .map((c) => (
                    <div className="pfcrow" key={c.id}>
                      <span className="pfcname">{c.label}</span>
                      {c.renamed ? (
                        <span className="pfcghl" title="The name in GoHighLevel">
                          {c.ghlName}
                        </span>
                      ) : (
                        <span className="pfcsame">same name in GoHighLevel</span>
                      )}
                      <span className="pfcfields">
                        {/* ⚠️ A SECTION WITH NO FIELDS IS THE FINDING. "Enquiry
                            Details" holds one field used by nobody and renders
                            on every client record; a zero here is how that
                            becomes visible at all. */}
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
          {data.unknownContactFolders?.length ? (
            <div className="pfstale">
              <b>
                Contact folders in GoHighLevel this dashboard does not know about
              </b>
              <div className="ihint">
                Their fields are dropped from contact panels — not shown under
                &quot;Other&quot;, because a location&apos;s contact fields include
                every unrelated form on the account. Adding one needs a code
                change today; this is here so you can see they exist.
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
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {/* 🔴 ITEM T — THE UNTICKING WARNING, WITH THE COUNT. */}
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
                  // ⚠️ THE 115c WORDING, NOT A CONFIDENT ZERO.
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
                  {/* ⚠️ SAY WHAT WAS COUNTED. A number with no denominator is a
                      number nobody can check. */}
                  Counted over the {hideAsk.count.scanned} record
                  {hideAsk.count.scanned === 1 ? "" : "s"} this tab has loaded for
                  this pipeline.
                </p>
              ) : null}
            </>
          }
        />
      ) : null}

      {/* 🔴 ITEM L — THE DELETE CONFIRMATION. The app's own dialog, as 115b
          built for the scope confirm — not a browser confirm(). */}
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
                {/* 🔴 AND THE STORED ENTRY GOES TOO — round 90's stale key.
                    Leaving it behind would manufacture exactly the "no longer in
                    GoHighLevel" row this screen then asks you to reconcile. */}
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
