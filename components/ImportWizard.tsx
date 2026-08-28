"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { failureMessage } from "@/lib/apiFetch";
import readXlsxFile from "read-excel-file";
import Papa from "papaparse";
import type {
  ImportMeta,
  ImportPipeline,
  ImportSummary,
} from "@/lib/types";

type Parsed = { columns: string[]; rows: Record<string, unknown>[] };

const NATIVE_TARGETS: { key: string; label: string }[] = [
  { key: "native:firstName", label: "Contact · First Name" },
  { key: "native:lastName", label: "Contact · Last Name" },
  { key: "native:name", label: "Contact · Full Name" },
  { key: "native:email", label: "Contact · Email" },
  { key: "native:phone", label: "Contact · Phone" },
  { key: "native:oppName", label: "Opportunity · Name" },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const CHUNK = 25;
const STEPS = ["Upload", "Destination", "Map", "Preview", "Import"] as const;
type StepIdx = 0 | 1 | 2 | 3 | 4;

export default function ImportWizard({
  ssoBlob,
}: {
  ssoBlob: string | null;
}) {
  const [meta, setMeta] = useState<ImportMeta | null>(null);
  const [metaErr, setMetaErr] = useState<string | null>(null);

  const [step, setStep] = useState<StepIdx>(0);

  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [pipelineId, setPipelineId] = useState("");
  const [stageId, setStageId] = useState("");
  const [source, setSource] = useState("Indeed");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [autoMapped, setAutoMapped] = useState<Set<string>>(new Set());

  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);
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
        if (!res.ok) throw new Error(failureMessage(res, j));
        if (!cancelled) setMeta(j as ImportMeta);
      })
      .catch((e) => {
        if (!cancelled) setMetaErr(e instanceof Error ? e.message : String(e));
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

  const targets = useMemo(() => {
    const cf = (meta?.fieldDefs || []).map((d) => ({
      key: `cf:${d.id}`,
      label: `Field · ${d.name}`,
    }));
    return [...NATIVE_TARGETS, ...cf];
  }, [meta]);

  const autoMap = useCallback(
    (columns: string[]): { map: Record<string, string>; auto: Set<string> } => {
      const out: Record<string, string> = {};
      const auto = new Set<string>();
      for (const c of columns) {
        const n = norm(c);
        let target = "";
        if (n.includes("email")) target = "native:email";
        else if (n.includes("phone") || n.includes("mobile") || n.includes("cell"))
          target = "native:phone";
        else if (n === "firstname" || n.includes("firstname")) target = "native:firstName";
        else if (n === "lastname" || n.includes("lastname")) target = "native:lastName";
        else if (n === "name" || n === "fullname") target = "native:name";
        else {
          const def = (meta?.fieldDefs || []).find((d) => norm(d.name) === n);
          if (def) target = `cf:${def.id}`;
        }
        out[c] = target;
        if (target) auto.add(c);
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
      rows = rows.filter((r) => Object.values(r).some((v) => v != null && v !== ""));
      if (!columns.length) throw new Error("No columns found in the file.");
      if (!rows.length) throw new Error("No data rows found in the file.");
      const { map, auto } = autoMap(columns);
      setParsed({ columns, rows });
      setMapping(map);
      setAutoMapped(auto);
      setStep(1);
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : String(e));
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
    const agg: ImportSummary = { created: 0, skipped: 0, failed: 0, errors: [] };
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
          }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(failureMessage(res, j));
        agg.created += j.created || 0;
        agg.skipped += j.skipped || 0;
        agg.failed += j.failed || 0;
        if (Array.isArray(j.errors)) agg.errors.push(...j.errors);
        setProgress(Math.min(off + chunk.length, parsed.rows.length));
        setSummary({ ...agg });
      }
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : String(e));
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
    if (p.source) setSource(p.source);
    if (p.pipelineId) setPipelineId(p.pipelineId);
    if (p.stageId) setStageId(p.stageId);
  };

  const mappedCount = parsed
    ? parsed.columns.filter((c) => mapping[c]).length
    : 0;

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

  const canNext = (): boolean => {
    if (step === 0) return !!parsed;
    if (step === 1) return !!pipelineId && !!stageId;
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
          <p>{metaErr}</p>
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
          {parseErr ? <div className="savemsg err">✗ {parseErr}</div> : null}
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
              {(pipeline?.stages || []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <label>Source</label>
            <input
              className="isrc"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="e.g. Indeed"
            />
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
            {mappedCount} of {parsed.columns.length} columns mapped · unmapped
            columns are skipped
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
                    {unmapped ? <span className="iskip">skip</span> : null}
                  </span>
                  <span className="iarrow">→</span>
                  <select
                    value={mapping[c] ?? ""}
                    onChange={(e) =>
                      setMapping((m) => ({ ...m, [c]: e.target.value }))
                    }
                  >
                    <option value="">— skip —</option>
                    {targets.map((t) => (
                      <option key={t.key} value={t.key}>
                        {t.label}
                      </option>
                    ))}
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
              <b>{pipelineName}</b> / <b>{stageName}</b>. Existing contacts
              (matched by email/phone) are skipped.
            </div>
          )}

          {!summary && (
            <button
              className="ibtn"
              type="button"
              disabled={importing || !pipelineId || !stageId}
              onClick={runImport}
            >
              {importing ? "Importing…" : `Import ${parsed.rows.length} rows`}
            </button>
          )}
          {importErr ? <div className="savemsg err">✗ {importErr}</div> : null}

          {summary ? (
            <div className="iresult">
              <div className="iresult-nums">
                <span className="ok">✓ {summary.created} created</span>
                <span>· {summary.skipped} skipped (existing)</span>
                <span className="bad">· {summary.failed} failed</span>
              </div>
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
              onClick={() => setStep((s) => ((s + 1) as StepIdx))}
            >
              Next →
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
