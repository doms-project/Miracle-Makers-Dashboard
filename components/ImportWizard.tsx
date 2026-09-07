"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ErrorMessage from "./ErrorMessage";
import { apiError } from "@/lib/apiFetch";
import readXlsxFile from "read-excel-file";
import Papa from "papaparse";
import type {
  ImportMeta,
  ImportPipeline,
  ImportSummary,
  ImportDuplicate,
  DuplicateMode,
} from "@/lib/types";
import {
  buildImportNote,
  splitFullName,
  stripLeadingApostrophe,
} from "@/lib/importNotes";

type Parsed = { columns: string[]; rows: Record<string, unknown>[] };

// "Append to notes" is a TARGET, not a fallback. It is listed first because it
// is where an unclaimed column goes by default, and a person reading the list
// should see the thing most of their columns are already pointing at.
const NOTE_TARGET = "note:";

const NATIVE_TARGETS: { key: string; label: string }[] = [
  { key: NOTE_TARGET, label: "Append to notes" },
  { key: "native:firstName", label: "Contact · First Name" },
  { key: "native:lastName", label: "Contact · Last Name" },
  // ONE column, TWO fields. Split on the first space server-side, and shown in
  // Preview so the split is seen rather than discovered. Indeed sends a single
  // "name"; GHL wants First and Last separately.
  { key: "native:name", label: "Contact · Full Name (split into First / Last)" },
  { key: "native:email", label: "Contact · Email" },
  { key: "native:phone", label: "Contact · Phone" },
  { key: "native:oppName", label: "Opportunity · Name" },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const CHUNK = 25;
const STEPS = ["Upload", "Destination", "Map", "Preview", "Import"] as const;
type StepIdx = 0 | 1 | 2 | 3 | 4;

// ONE fixed vocabulary, ONE choice per import.
//
// This was a free-text input. Free text is how a channel ends up counted twice:
// "Indeed", "indeed" and "Indeed.com" are three rows in the "By source" tile
// and one real channel. The workflows that set `source` on inbound leads write
// exactly these strings, so an import has to be able to write nothing else —
// which means the vocabulary belongs in the picker, not in whoever is typing.
//
// A CSV COLUMN is deliberately not offered: a column fragments the count the
// same way and puts it in the hands of whoever prepared the file. One import,
// one source.
const SOURCE_OPTIONS = [
  "Indeed",
  "Facebook",
  "Google Ads",
  "Website",
  "Referral",
  "Other",
] as const;

/** Match a stored/typed value to the vocabulary, or "" if it isn't in it. */
function canonicalSource(v: string): string {
  const k = (v || "").trim().toLowerCase();
  return SOURCE_OPTIONS.find((o) => o.toLowerCase() === k) || "";
}

export default function ImportWizard({
  ssoBlob,
}: {
  ssoBlob: string | null;
}) {
  const [meta, setMeta] = useState<ImportMeta | null>(null);
  const [metaErr, setMetaErr] = useState<unknown>(null);

  const [step, setStep] = useState<StepIdx>(0);

  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parseErr, setParseErr] = useState<unknown>(null);
  const [dragOver, setDragOver] = useState(false);

  const [pipelineId, setPipelineId] = useState("");
  const [stageId, setStageId] = useState("");
  // Starts EMPTY, not on "Indeed". A default that is a real channel stamps that
  // channel on an import of some other channel whenever nobody looks at this
  // step — the exact miscount the fixed vocabulary exists to prevent.
  const [source, setSource] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [autoMapped, setAutoMapped] = useState<Set<string>>(new Set());

  // ITEM 5 — who already exists, checked on the way into Preview so the choice
  // is made BEFORE anything runs.
  const [dupMode, setDupMode] = useState<DuplicateMode>("update");
  const [dups, setDups] = useState<ImportDuplicate[] | null>(null);
  const [dupBusy, setDupBusy] = useState(false);
  const [dupErr, setDupErr] = useState<unknown>(null);

  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [importErr, setImportErr] = useState<unknown>(null);
  const [presetNames, setPresetNames] = useState<string[]>([]);
  const [namingPreset, setNamingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");

  const fileInput = useRef<HTMLInputElement | null>(null);

  const ssoHeader = useCallback((): Record<string, string> => {
    return ssoBlob ? { "x-ghl-sso-key": ssoBlob } : {};
  }, [ssoBlob]);

  // Load pipelines + field defs (all dynamic).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/import/meta", { headers: ssoHeader(), cache: "no-store" })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw apiError(res, j);
        if (!cancelled) setMeta(j as ImportMeta);
      })
      .catch((e) => {
        if (!cancelled) setMetaErr(e);
      });
    return () => {
      cancelled = true;
    };
  }, [ssoHeader]);

  useEffect(() => {
    try {
      setPresetNames(
        Object.keys(JSON.parse(localStorage.getItem("importPresets") || "{}")),
      );
    } catch {
      /* ignore */
    }
  }, []);

  const pipeline: ImportPipeline | undefined = useMemo(
    () => meta?.pipelines.find((p) => p.id === pipelineId),
    [meta, pipelineId],
  );
  const pipelineName = pipeline?.name || "—";
  const stageName =
    pipeline?.stages.find((s) => s.id === stageId)?.name || "—";

  // Three groups, rendered as <optgroup> so which model a field belongs to is
  // obvious at the point of choosing rather than something you have to know.
  //
  // 🔴 CONTACT FIELDS MATTER MOST HERE. An applicant's experience,
  // certifications and availability are contact fields BY DESIGN — they
  // describe the person and survive a second application — and the wizard
  // could not reach a single one of them until now.
  const targetGroups = useMemo(() => {
    const contact = (meta?.contactFieldDefs || []).map((d) => ({
      key: `ccf:${d.id}`,
      label: d.name,
    }));
    const opp = (meta?.fieldDefs || []).map((d) => ({
      key: `cf:${d.id}`,
      label: d.name,
    }));
    return [
      { group: "", options: NATIVE_TARGETS },
      { group: "Contact fields", options: contact },
      { group: "Opportunity fields", options: opp },
    ].filter((g) => g.options.length);
  }, [meta]);

  // Flat, for looking a target's label up by key (Preview's column headers).
  const targets = useMemo(
    () =>
      targetGroups.flatMap((g) =>
        g.options.map((o) => ({
          key: o.key,
          label: g.group ? `${g.group.replace(/ fields$/, "")} · ${o.label}` : o.label,
        })),
      ),
    [targetGroups],
  );

  const autoMap = useCallback(
    (columns: string[]): { map: Record<string, string>; auto: Set<string> } => {
      const out: Record<string, string> = {};
      const auto = new Set<string>();
      // A full-name column may only auto-map when the file has NO separate
      // first/last columns. With all three present, mapping them all writes the
      // same person twice and the last one silently wins.
      const hasSplitName = columns.some((c) => {
        const n = norm(c);
        return n.includes("firstname") || n.includes("lastname");
      });
      for (const c of columns) {
        const n = norm(c);
        let target = "";
        if (n.includes("email")) target = "native:email";
        else if (n.includes("phone") || n.includes("mobile") || n.includes("cell"))
          target = "native:phone";
        else if (n === "firstname" || n.includes("firstname")) target = "native:firstName";
        else if (n === "lastname" || n.includes("lastname")) target = "native:lastName";
        else if ((n === "name" || n === "fullname") && !hasSplitName)
          target = "native:name";
        else {
          // EXACT normalised name only. Deliberately not fuzzy: "job location"
          // would happily match "CG - Work State" under loose matching and
          // nobody would ever notice. A wrong mapping that looks right is the
          // failure mode this project has hit most often; unmapped is at least
          // visible, and now recoverable.
          //
          // CONTACT fields are searched FIRST. Where both models happen to hold
          // a field of the same name, the contact one is the one that describes
          // the person and survives a second application — which is what an
          // applicant import is writing.
          const cDef = (meta?.contactFieldDefs || []).find((d) => norm(d.name) === n);
          if (cDef) target = `ccf:${cDef.id}`;
          else {
            const def = (meta?.fieldDefs || []).find((d) => norm(d.name) === n);
            if (def) target = `cf:${def.id}`;
          }
        }
        if (target) auto.add(c);
        // 🔴 THE FAILURE MODE FLIPS HERE. An unclaimed column used to be "" —
        // dropped, silently, with the import still reporting success. It now
        // defaults to the note, where it is recoverable. Dropping is still one
        // click away; it is just no longer the thing that happens by default.
        out[c] = target || NOTE_TARGET;
      }
      return { map: out, auto };
    },
    [meta],
  );

  const parseFile = async (file: File) => {
    setParseErr(null);
    setSummary(null);
    setImportErr(null);
    setFileName(file.name);
    try {
      let columns: string[] = [];
      let rows: Record<string, unknown>[] = [];
      if (/\.csv$/i.test(file.name)) {
        const res = await new Promise<Papa.ParseResult<Record<string, unknown>>>(
          (resolve, reject) =>
            Papa.parse<Record<string, unknown>>(file, {
              header: true,
              skipEmptyLines: true,
              complete: resolve,
              error: reject,
            }),
        );
        columns = (res.meta.fields || []).filter(Boolean);
        rows = res.data;
      } else if (/\.xlsx$/i.test(file.name)) {
        const grid = (await readXlsxFile(file)) as unknown[][];
        columns = (grid[0] || []).map((c) => String(c ?? "").trim());
        rows = grid.slice(1).map((r) => {
          const o: Record<string, unknown> = {};
          columns.forEach((c, idx) => (o[c] = r[idx]));
          return o;
        });
      } else {
        throw new Error("Unsupported file type — upload a .xlsx or .csv.");
      }
      columns = columns.filter(Boolean);
      // 🔴 The Excel apostrophe comes off HERE as well as server-side, so
      // Preview shows the value that will actually be stored rather than one
      // with a stray quote in front of it. Leading only, once — O'Brien and
      // D'Angelo are untouched. (The server strips again; it must not trust a
      // client to have done it.)
      rows = rows.map((r) => {
        const o: Record<string, unknown> = {};
        for (const k of Object.keys(r)) o[k] = stripLeadingApostrophe(r[k]);
        return o;
      });
      rows = rows.filter((r) => Object.values(r).some((v) => v != null && v !== ""));
      if (!columns.length) throw new Error("No columns found in the file.");
      if (!rows.length) throw new Error("No data rows found in the file.");
      const { map, auto } = autoMap(columns);
      setParsed({ columns, rows });
      setMapping(map);
      setAutoMapped(auto);
      setStep(1);
    } catch (e) {
      setParseErr(e);
      setParsed(null);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) parseFile(f);
  };

  const runImport = async () => {
    if (!parsed || !pipelineId || !stageId) return;
    setImporting(true);
    setImportErr(null);
    setProgress(0);
    const agg: ImportSummary = {
      created: 0, updated: 0, skipped: 0, failed: 0, noted: 0, notesSkipped: 0,
      errors: [], flagged: [],
    };
    try {
      for (let off = 0; off < parsed.rows.length; off += CHUNK) {
        const chunk = parsed.rows.slice(off, off + CHUNK);
        const res = await fetch("/api/import", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...ssoHeader() },
          body: JSON.stringify({
            ssoKey: ssoBlob ?? undefined,
            pipelineId,
            stageId,
            source,
            mapping,
            rows: chunk,
            rowOffset: off,
            // The whole file, for the note's "N records in this batch" line —
            // the chunk would say 25 on a 47-row import.
            totalRows: parsed.rows.length,
            duplicateMode: dupMode,
            // FILE order, so the note's Q&A pairing still sees the answer
            // column immediately after its question.
            columns: parsed.columns,
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw apiError(res, j);
        agg.created += j.created || 0;
        agg.updated += j.updated || 0;
        agg.skipped += j.skipped || 0;
        agg.failed += j.failed || 0;
        agg.noted += j.noted || 0;
        agg.notesSkipped += j.notesSkipped || 0;
        if (Array.isArray(j.errors)) agg.errors.push(...j.errors);
        if (Array.isArray(j.flagged)) agg.flagged.push(...j.flagged);
        setProgress(Math.min(off + chunk.length, parsed.rows.length));
        setSummary({ ...agg });
      }
    } catch (e) {
      setImportErr(e);
    } finally {
      setImporting(false);
    }
  };

  const downloadErrorReport = () => {
    if (!summary?.errors.length) return;
    const rows = [["row", "error"], ...summary.errors.map((e) => [String(e.row), e.error])];
    const csv = rows
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-errors-${fileName.replace(/\.[^.]+$/, "") || "report"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Presets.
  //
  // This used `window.prompt()`. The dashboard runs INSIDE A GHL IFRAME, and a
  // sandboxed iframe without `allow-modals` makes prompt() return null with no
  // dialog at all — so "Save preset" did nothing, silently, exactly like the
  // Remove-note button did. Same defect, different screen; found while fixing
  // that one. An inline input replaces it.
  const savePreset = (name: string) => {
    const clean = name.trim();
    if (!clean) return;
    const all = JSON.parse(localStorage.getItem("importPresets") || "{}");
    all[clean] = { mapping, source, pipelineId, stageId };
    localStorage.setItem("importPresets", JSON.stringify(all));
    setPresetNames(Object.keys(all));
    setPresetName("");
    setNamingPreset(false);
  };
  const applyPreset = (name: string) => {
    if (!name) return;
    const all = JSON.parse(localStorage.getItem("importPresets") || "{}");
    const p = all[name];
    if (!p) return;
    if (parsed) {
      const next: Record<string, string> = {};
      for (const c of parsed.columns) next[c] = p.mapping?.[c] || mapping[c] || "";
      setMapping(next);
    }
    // Presets saved before the picker existed hold free text. Anything that is
    // not in the vocabulary is dropped rather than coerced to "Other" — a
    // silently mis-stamped batch is worse than being asked the question again.
    if (p.source) setSource(canonicalSource(p.source));
    if (p.pipelineId) setPipelineId(p.pipelineId);
    if (p.stageId) setStageId(p.stageId);
  };

  // Three groups, counted separately, because "mapped" stopped meaning one
  // thing the moment notes became a target: a column going to notes is neither
  // a field nor a silent loss.
  const fieldCols = parsed
    ? parsed.columns.filter((c) => mapping[c] && mapping[c] !== NOTE_TARGET)
    : [];
  const noteCols = parsed
    ? parsed.columns.filter((c) => mapping[c] === NOTE_TARGET)
    : [];
  const droppedCols = parsed ? parsed.columns.filter((c) => !mapping[c]) : [];
  const contactFieldCols = parsed
    ? parsed.columns.filter((c) => (mapping[c] || "").startsWith("ccf:"))
    : [];
  const mappedCount = fieldCols.length + noteCols.length;

  // The column mapped to Full Name, if any — Preview shows what the split does
  // to it. At most one can be mapped there, so the first is the one.
  const nameCol = parsed
    ? parsed.columns.find((c) => mapping[c] === "native:name") || ""
    : "";

  // The note the FIRST row would get, built by the same function the server
  // uses. Not a mock-up of it — the same code, so what is previewed is what
  // lands.
  const notePreview = useMemo(() => {
    if (!parsed || !parsed.rows.length || !noteCols.length) return "";
    const r = parsed.rows[0];
    return buildImportNote({
      source,
      when: new Date(),
      userName: "",
      batchSize: parsed.rows.length,
      columns: noteCols.map((h) => ({ header: h, value: String(r[h] ?? "") })),
    });
    // noteCols is derived from `parsed` and `mapping`; both are listed.
  }, [parsed, mapping, source, noteCols]);

  // A row can only become a GHL contact if at least one column maps to a contact
  // identity (name/email/phone). Without this, every row fails server-side with
  // "No name/email/phone to import." — so require it before Preview/Import.
  const IDENTITY_TARGETS = new Set([
    "native:firstName",
    "native:lastName",
    "native:name",
    "native:email",
    "native:phone",
  ]);
  const hasIdentity = parsed
    ? parsed.columns.some((c) => IDENTITY_TARGETS.has(mapping[c] || ""))
    : false;

  // Resolve each row's identity from the CURRENT mapping — the same columns the
  // import itself will use, so the check can never be asking about a different
  // field than the one that will be written.
  const identityOf = useCallback(
    (r: Record<string, unknown>) => {
      let email = "";
      let phone = "";
      for (const [col, t] of Object.entries(mapping)) {
        if (t === "native:email") email = String(r[col] ?? "").trim();
        else if (t === "native:phone") phone = String(r[col] ?? "").trim();
      }
      return { email, phone };
    },
    [mapping],
  );

  const checkDuplicates = useCallback(async () => {
    if (!parsed) return;
    setDupBusy(true);
    setDupErr(null);
    try {
      const people = parsed.rows.map((r, i) => ({ row: i + 1, ...identityOf(r) }));
      const res = await fetch("/api/import/duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ssoHeader() },
        body: JSON.stringify({ ssoKey: ssoBlob ?? undefined, people }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(res, j);
      setDups(j.duplicates || []);
      // A lookup that FAILED is not "no duplicate" — say so rather than letting
      // a network blip read as a clean file.
      if (Array.isArray(j.errors) && j.errors.length)
        setDupErr({
          error: `${j.errors.length} row${j.errors.length === 1 ? "" : "s"} could not be checked.`,
          detail:
            "Those rows may or may not already exist. Re-run the check, or import knowing they are unverified.",
        });
    } catch (e) {
      setDupErr(e);
      setDups(null);
    } finally {
      setDupBusy(false);
    }
  }, [parsed, identityOf, ssoBlob, ssoHeader]);

  const canNext = (): boolean => {
    if (step === 0) return !!parsed;
    // Source is asked on this step and is not optional: see SOURCE_OPTIONS.
    if (step === 1) return !!pipelineId && !!stageId && !!source;
    if (step === 2) return mappedCount > 0 && hasIdentity;
    return true;
  };

  if (metaErr)
    return (
      <div className="statewrap">
        <div className="statecard">
          <h3>
            <span className="errdot">●</span> Couldn&apos;t start import
          </h3>
          <ErrorMessage error={metaErr} className="errbody" />
          <p className="detail">
            Import is admin-only and needs the PIT to have contacts + opportunities
            write scope.
          </p>
        </div>
      </div>
    );

  return (
    <div className="scroll importwrap">
      {/* progress indicator */}
      <ol className="istepper">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={`istepper-i ${i === step ? "on" : ""} ${i < step ? "done" : ""}`}
          >
            <button
              type="button"
              disabled={i > step && !(i === step + 1 && canNext())}
              onClick={() => setStep(i as StepIdx)}
            >
              <span className="idot">{i < step ? "✓" : i + 1}</span>
              {label}
            </button>
          </li>
        ))}
      </ol>

      {/* STEP 1 — Upload */}
      {step === 0 && (
        <div className="isec">
          <div
            className={`idrop ${dragOver ? "over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInput.current?.click()}
            role="button"
            tabIndex={0}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,.csv"
              hidden
              onChange={(e) => e.target.files?.[0] && parseFile(e.target.files[0])}
            />
            <div className="idrop-i">⬆</div>
            <div className="idrop-t">
              {fileName ? `📄 ${fileName}` : "Drag a .xlsx or .csv here"}
            </div>
            <div className="idrop-s">or click to browse</div>
          </div>
          {parseErr ? <ErrorMessage error={parseErr} className="savemsg err" /> : null}
          {parsed ? (
            <div className="imeta">
              ✓ {parsed.rows.length} rows · {parsed.columns.length} columns parsed
            </div>
          ) : null}
        </div>
      )}

      {/* STEP 2 — Destination */}
      {step === 1 && (
        <div className="isec">
          <div className="istep">Destination</div>
          <div className="irow">
            <label>Pipeline</label>
            <select
              value={pipelineId}
              onChange={(e) => {
                setPipelineId(e.target.value);
                setStageId("");
              }}
            >
              <option value="">Choose a pipeline…</option>
              {meta?.pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <label>Stage</label>
            <select
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
              disabled={!pipeline}
            >
              <option value="">Choose a stage…</option>
              {/* ITEM 6 — REASSIGN is a holding queue, never a starting
                  stage. Importing straight into it would create unowned
                  records with no followers and no notification. */}
              {(pipeline?.stages || [])
                .filter((s) => s.name.trim().toUpperCase() !== "REASSIGN")
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            <label>Source</label>
            <select
              className="isrc"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">What source are these leads?</option>
              {SOURCE_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            <div className="ihint">
              Stamped on every record in this file. One source per import — if
              this file mixes channels, split it and import each separately.
            </div>
          </div>
        </div>
      )}

      {/* STEP 3 — Map */}
      {step === 2 && parsed && (
        <div className="isec">
          <div className="istep">
            Map columns → GHL fields
            <span className="ipresets">
              {namingPreset ? (
                <span className="ipresetname">
                  <input
                    value={presetName}
                    placeholder="Preset name (e.g. Indeed)"
                    autoFocus
                    onChange={(e) => setPresetName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") savePreset(presetName);
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setNamingPreset(false);
                      }
                    }}
                  />
                  <button
                    type="button"
                    disabled={!presetName.trim()}
                    onClick={() => savePreset(presetName)}
                  >
                    Save
                  </button>
                  <button type="button" onClick={() => setNamingPreset(false)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button type="button" onClick={() => setNamingPreset(true)}>
                  Save preset
                </button>
              )}
              {presetNames.length ? (
                <select
                  defaultValue=""
                  onChange={(e) => {
                    applyPreset(e.target.value);
                    e.target.value = "";
                  }}
                >
                  <option value="">Apply preset…</option>
                  {presetNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              ) : null}
            </span>
          </div>
          <div className="imeta" style={{ marginBottom: 10 }}>
            <b>{fieldCols.length}</b> to fields · <b>{noteCols.length}</b> to
            notes · <b>{droppedCols.length}</b> not imported, of{" "}
            {parsed.columns.length} columns
          </div>
          {!hasIdentity ? (
            <div className="savemsg err" style={{ marginBottom: 10 }}>
              ✗ Map at least one column to a <b>Contact</b> field — First Name,
              Full Name, Email, or Phone. Without a contact identity every row is
              rejected (&quot;No name/email/phone to import&quot;).
            </div>
          ) : null}
          <div className="imap">
            {parsed.columns.map((c) => {
              const isAuto = autoMapped.has(c) && mapping[c];
              const unmapped = !mapping[c];
              return (
                <div
                  className={`imaprow ${unmapped ? "skip" : ""}`}
                  key={c}
                >
                  <span className="icol">
                    {c}
                    {isAuto ? <span className="iauto">auto</span> : null}
                    {mapping[c] === NOTE_TARGET ? (
                      <span className="inote">note</span>
                    ) : null}
                    {unmapped ? <span className="iskip">dropped</span> : null}
                  </span>
                  <span className="iarrow">→</span>
                  <select
                    value={mapping[c] ?? ""}
                    onChange={(e) =>
                      setMapping((m) => ({ ...m, [c]: e.target.value }))
                    }
                  >
                    {/* "Don't import" still MEANS dropped. Notes is the
                        default, not a catch-all — choosing this throws the
                        column away, which is often the right call for 45 empty
                        Qualification columns. It is now a click, not an
                        oversight. */}
                    <option value="">— Don&apos;t import —</option>
                    {targetGroups.map((g) =>
                      g.group ? (
                        <optgroup key={g.group} label={g.group}>
                          {g.options.map((t) => (
                            <option key={t.key} value={t.key}>
                              {t.label}
                            </option>
                          ))}
                        </optgroup>
                      ) : (
                        g.options.map((t) => (
                          <option key={t.key} value={t.key}>
                            {t.label}
                          </option>
                        ))
                      ),
                    )}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* STEP 4 — Preview */}
      {step === 3 && parsed && (
        <div className="isec">
          <div className="istep">Preview</div>
          <div className="imeta" style={{ marginBottom: 10 }}>
            {parsed.rows.length} rows into <b>{pipelineName}</b> / <b>{stageName}</b>,
            deduped by email/phone.
          </div>

          {/* ITEM 5 — WHO ALREADY EXISTS, AND WHAT TO DO ABOUT THEM.
              Asked here, before anything runs, and the people are NAMED: "12
              already exist" is abstract, seeing Ebony Logan on the list makes
              the choice real. */}
          {dupBusy ? (
            <div className="idups busy">Checking which of these already exist…</div>
          ) : dups && dups.length ? (
            <div className="idups">
              <div className="idups-head">
                <b>
                  {dups.length} of {parsed.rows.length} already exist
                </b>
                , matched by email or phone:{" "}
                <span className="idups-who">
                  {dups.slice(0, 3).map((d) => d.name).join(" · ")}
                  {dups.length > 3 ? ` · and ${dups.length - 3} more` : ""}
                </span>
              </div>
              <label className={dupMode === "update" ? "on" : ""}>
                <input
                  type="radio"
                  name="dupmode"
                  checked={dupMode === "update"}
                  onChange={() => setDupMode("update")}
                />
                <span>
                  <b>Update</b> — fill empty fields, keep existing values, add
                  the note.
                </span>
              </label>
              <label className={dupMode === "overwrite" ? "on" : ""}>
                <input
                  type="radio"
                  name="dupmode"
                  checked={dupMode === "overwrite"}
                  onChange={() => setDupMode("overwrite")}
                />
                <span>
                  <b>Overwrite</b> — replace existing values, add the note.
                  {dupMode === "overwrite" ? (
                    // Not just a label. A row from this file has 45 empty
                    // columns; overwriting with blanks would wipe the answers a
                    // caregiver gave through the form.
                    <em className="idups-warn">
                      This replaces values on {dups.length} record
                      {dups.length === 1 ? "" : "s"}. A blank cell in the CSV
                      will clear the existing value.
                    </em>
                  ) : null}
                </span>
              </label>
              <label className={dupMode === "skip" ? "on" : ""}>
                <input
                  type="radio"
                  name="dupmode"
                  checked={dupMode === "skip"}
                  onChange={() => setDupMode("skip")}
                />
                <span>
                  <b>Skip</b> — leave untouched, import only the{" "}
                  {parsed.rows.length - dups.length} new.
                  {dupMode === "skip" ? (
                    <em className="idups-warn">
                      Their answers from this file will not be recorded
                      anywhere.
                    </em>
                  ) : null}
                </span>
              </label>
              <details className="idups-all">
                <summary>All {dups.length} by name</summary>
                <ul>
                  {dups.map((d) => (
                    <li key={d.contactId + d.row}>
                      Row {d.row}: {d.name}{" "}
                      <span className="muted">— matched on {d.matchedOn}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          ) : dups ? (
            <div className="idups clean">
              None of these {parsed.rows.length} people already exist.
            </div>
          ) : null}
          {dupErr ? <ErrorMessage error={dupErr} className="savemsg err" /> : null}

          {/* ⚠️ SCOPE. A contact field belongs to the PERSON, not to this
              record — writing one changes what every opportunity that contact
              holds shows. The record panel already says this; the wizard has to
              say it too, before the write rather than after. */}
          {contactFieldCols.length ? (
            <div className="iscope">
              <b>
                {contactFieldCols.length} column
                {contactFieldCols.length === 1 ? "" : "s"} write CONTACT fields
              </b>{" "}
              ({contactFieldCols.join(" · ")}). A contact field belongs to the
              person — the value shows on every opportunity that contact holds,
              not only the one this import creates.
            </div>
          ) : null}

          {/* NAMED, not counted. "6 columns will not be imported" is abstract;
              seeing "education · job location" makes it a decision. Not an
              error — dropping is often right, and the 45 empty Qualification
              columns usually should be. */}
          {droppedCols.length ? (
            <div className="idrops">
              <b>
                {droppedCols.length} column
                {droppedCols.length === 1 ? "" : "s"} will not be imported:
              </b>{" "}
              {droppedCols.join(" · ")}
            </div>
          ) : null}

          {/* The split, SHOWN rather than discovered. Split on the first space,
              so a multi-word surname stays whole. */}
          {nameCol ? (
            <div className="isplit">
              <b>{nameCol}</b> becomes First / Last —
              {parsed.rows.slice(0, 3).map((r, i) => {
                const { first, last } = splitFullName(r[nameCol] as string);
                return (
                  <span key={i} className="isplitex">
                    {String(r[nameCol] ?? "") || "—"} → <b>{first || "—"}</b> |{" "}
                    <b>{last || <i>empty</i>}</b>
                  </span>
                );
              })}
            </div>
          ) : null}

          {/* One note per record, not one per column. Shown for the first row
              so nobody discovers the layout after 47 records already have it. */}
          {noteCols.length && parsed.rows.length ? (
            <details className="inotepv">
              <summary>
                {noteCols.length} column{noteCols.length === 1 ? "" : "s"} go to
                a note on each record — preview the first
              </summary>
              <pre>{notePreview}</pre>
            </details>
          ) : null}
          <div className="ipreview">
            <table>
              <thead>
                <tr>
                  {parsed.columns
                    .filter((c) => mapping[c])
                    .map((c) => (
                      <th key={c}>
                        {targets.find((t) => t.key === mapping[c])?.label || c}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {parsed.rows.slice(0, 8).map((r, i) => (
                  <tr key={i}>
                    {parsed.columns
                      .filter((c) => mapping[c])
                      .map((c) => (
                        <td key={c}>{String(r[c] ?? "")}</td>
                      ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {parsed.rows.length > 8 ? (
              <div className="imeta">…and {parsed.rows.length - 8} more</div>
            ) : null}
          </div>
        </div>
      )}

      {/* STEP 5 — Import */}
      {step === 4 && parsed && (
        <div className="isec">
          <div className="istep">Import</div>
          {importing || summary ? (
            <div className="iprogwrap">
              <div className="iprogbar">
                <div
                  className="iprogfill"
                  style={{
                    width: `${Math.round((progress / parsed.rows.length) * 100)}%`,
                  }}
                />
              </div>
              <div className="imeta">
                {progress}/{parsed.rows.length} rows processed
              </div>
            </div>
          ) : (
            <div className="imeta" style={{ marginBottom: 12 }}>
              Ready to import <b>{parsed.rows.length}</b> rows into{" "}
              <b>{pipelineName}</b> / <b>{stageName}</b>.
              {dups && dups.length ? (
                <>
                  {" "}
                  <b>{dups.length}</b> already exist and will be{" "}
                  <b>
                    {dupMode === "update"
                      ? "updated"
                      : dupMode === "overwrite"
                        ? "overwritten"
                        : "left untouched"}
                  </b>
                  .
                </>
              ) : null}
              {noteCols.length ? (
                <>
                  {" "}
                  Each new record gets one note holding{" "}
                  <b>{noteCols.length}</b> column
                  {noteCols.length === 1 ? "" : "s"}.
                </>
              ) : null}
              {droppedCols.length ? (
                <>
                  {" "}
                  <b>{droppedCols.length}</b> column
                  {droppedCols.length === 1 ? "" : "s"} will not be imported.
                </>
              ) : null}
            </div>
          )}

          {!summary && (
            <button
              className="ibtn"
              type="button"
              disabled={importing || !pipelineId || !stageId || !source}
              onClick={runImport}
            >
              {importing ? "Importing…" : `Import ${parsed.rows.length} rows`}
            </button>
          )}
          {importErr ? <ErrorMessage error={importErr} className="savemsg err" /> : null}

          {summary ? (
            <div className="iresult">
              <div className="iresult-nums">
                <span className="ok">✓ {summary.created} created</span>
                <span>· {summary.updated} updated</span>
                <span>· {summary.skipped} skipped (untouched)</span>
                <span>· {summary.noted} notes</span>
                {summary.notesSkipped ? (
                  <span>· {summary.notesSkipped} notes already present</span>
                ) : null}
                <span className="bad">· {summary.failed} failed</span>
              </div>
              {/* NOT errors. The value went in exactly as written; this is the
                  list a person looks at afterwards to decide whether it was
                  right. An international phone that doesn't fit E.164 may be
                  perfectly correct — code must not decide that. */}
              {summary.flagged.length ? (
                <div className="iflags">
                  <b>
                    {summary.flagged.length} value
                    {summary.flagged.length === 1 ? "" : "s"} imported as
                    written — worth a look:
                  </b>
                  <ul>
                    {summary.flagged.slice(0, 20).map((f, i) => (
                      <li key={i}>
                        Row {f.row} · <b>{f.column}</b>: “{f.value}” — {f.reason}
                      </li>
                    ))}
                  </ul>
                  {summary.flagged.length > 20 ? (
                    <div className="imeta">
                      …and {summary.flagged.length - 20} more
                    </div>
                  ) : null}
                </div>
              ) : null}
              {summary.errors.length ? (
                <>
                  <button
                    type="button"
                    className="idl"
                    onClick={downloadErrorReport}
                  >
                    ⬇ Download error report ({summary.errors.length})
                  </button>
                  <ul className="ierrs">
                    {summary.errors.slice(0, 50).map((e, i) => (
                      <li key={i}>
                        Row {e.row}: {e.error}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {!importing ? (
                <button
                  type="button"
                  className="ireset"
                  onClick={() => {
                    setParsed(null);
                    setFileName("");
                    setSummary(null);
                    setProgress(0);
                    setStep(0);
                  }}
                >
                  Import another file
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {/* nav */}
      {!(step === 4 && summary) ? (
        <div className="inav">
          <button
            type="button"
            className="ighost"
            disabled={step === 0 || importing}
            onClick={() => setStep((s) => (s > 0 ? ((s - 1) as StepIdx) : s))}
          >
            ← Back
          </button>
          {step < 4 ? (
            <button
              type="button"
              className="ibtn"
              disabled={!canNext()}
              onClick={() => {
                // 🔴 THE CHECK MUST NOT LIVE INSIDE THE STATE UPDATER. React
                // may call an updater more than once (it does, in development),
                // and a side effect in there fires with it — the first run of
                // this cost 15 GoHighLevel lookups on a 3-row file instead of
                // 5, because the whole duplicate check ran twice. On a 47-row
                // import that is 94 calls against a 100-per-10-seconds budget.
                // Updaters are pure; the effect goes beside it.
                const next = Math.min(step + 1, 4) as StepIdx;
                // Entering Preview: find out who already exists BEFORE anything
                // runs. Re-run each time, because the mapping may have changed
                // which column is the email.
                if (next === 3) void checkDuplicates();
                setStep(next);
              }}
            >
              Next →
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
