"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

export default function ImportWizard({
  ssoBlob,
}: {
  ssoBlob: string | null;
}) {
  const [meta, setMeta] = useState<ImportMeta | null>(null);
  const [metaErr, setMetaErr] = useState<string | null>(null);

  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);

  const [pipelineId, setPipelineId] = useState("");
  const [stageId, setStageId] = useState("");
  const [source, setSource] = useState("Indeed");
  const [mapping, setMapping] = useState<Record<string, string>>({});

  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);

  const ssoHeader = useCallback((): Record<string, string> => {
    return ssoBlob ? { "x-ghl-sso-key": ssoBlob } : {};
  }, [ssoBlob]);

  // Load pipelines + field defs (all dynamic).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/import/meta", { headers: ssoHeader(), cache: "no-store" })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.detail || j.error || `HTTP ${res.status}`);
        if (!cancelled) setMeta(j as ImportMeta);
      })
      .catch((e) => {
        if (!cancelled) setMetaErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [ssoHeader]);

  const pipeline: ImportPipeline | undefined = useMemo(
    () => meta?.pipelines.find((p) => p.id === pipelineId),
    [meta, pipelineId],
  );

  const targets = useMemo(() => {
    const cf = (meta?.fieldDefs || []).map((d) => ({
      key: `cf:${d.id}`,
      label: `Field · ${d.name}`,
    }));
    return [...NATIVE_TARGETS, ...cf];
  }, [meta]);

  // Auto-suggest a target for each column by name.
  const autoMap = useCallback(
    (columns: string[]): Record<string, string> => {
      const out: Record<string, string> = {};
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
      }
      return out;
    },
    [meta],
  );

  const onFile = async (file: File) => {
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
      } else {
        const grid = (await readXlsxFile(file)) as unknown[][];
        columns = (grid[0] || []).map((c) => String(c ?? "").trim());
        rows = grid.slice(1).map((r) => {
          const o: Record<string, unknown> = {};
          columns.forEach((c, idx) => (o[c] = r[idx]));
          return o;
        });
      }
      rows = rows.filter((r) => Object.values(r).some((v) => v != null && v !== ""));
      setParsed({ columns, rows });
      setMapping(autoMap(columns));
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : String(e));
      setParsed(null);
    }
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
        if (!res.ok) throw new Error(j.detail || j.error || `HTTP ${res.status}`);
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

  // Reusable mapping presets (localStorage).
  const savePreset = () => {
    const name = window.prompt("Save this mapping as (e.g. 'Indeed')");
    if (!name) return;
    const all = JSON.parse(localStorage.getItem("importPresets") || "{}");
    all[name] = { mapping, source, pipelineId, stageId };
    localStorage.setItem("importPresets", JSON.stringify(all));
    setPresetNames(Object.keys(all));
  };
  const [presetNames, setPresetNames] = useState<string[]>([]);
  useEffect(() => {
    try {
      setPresetNames(
        Object.keys(JSON.parse(localStorage.getItem("importPresets") || "{}")),
      );
    } catch {
      /* ignore */
    }
  }, []);
  const applyPreset = (name: string) => {
    if (!name) return;
    const all = JSON.parse(localStorage.getItem("importPresets") || "{}");
    const p = all[name];
    if (!p) return;
    // Only apply mappings for columns present in the current file.
    if (parsed) {
      const next: Record<string, string> = {};
      for (const c of parsed.columns) next[c] = p.mapping?.[c] || mapping[c] || "";
      setMapping(next);
    }
    if (p.source) setSource(p.source);
    if (p.pipelineId) setPipelineId(p.pipelineId);
    if (p.stageId) setStageId(p.stageId);
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
      {/* 1 — upload */}
      <div className="isec">
        <div className="istep">1 · Upload a file</div>
        <label className="ifile">
          <input
            type="file"
            accept=".xlsx,.csv"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
          {fileName ? `📄 ${fileName}` : "Choose .xlsx or .csv…"}
        </label>
        {parseErr ? <div className="savemsg err">✗ {parseErr}</div> : null}
        {parsed ? (
          <div className="imeta">
            {parsed.rows.length} rows · {parsed.columns.length} columns
          </div>
        ) : null}
      </div>

      {parsed ? (
        <>
          {/* 2 — destination */}
          <div className="isec">
            <div className="istep">2 · Destination</div>
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

          {/* 3 — mapping */}
          <div className="isec">
            <div className="istep">
              3 · Map columns → GHL fields
              <span className="ipresets">
                <button type="button" onClick={savePreset}>
                  Save preset
                </button>
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
            <div className="imap">
              {parsed.columns.map((c) => (
                <div className="imaprow" key={c}>
                  <span className="icol">{c}</span>
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
              ))}
            </div>
          </div>

          {/* 4 — preview + import */}
          <div className="isec">
            <div className="istep">4 · Preview &amp; import</div>
            <div className="ipreview">
              <table>
                <thead>
                  <tr>
                    {parsed.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 5).map((r, i) => (
                    <tr key={i}>
                      {parsed.columns.map((c) => (
                        <td key={c}>{String(r[c] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.rows.length > 5 ? (
                <div className="imeta">…and {parsed.rows.length - 5} more</div>
              ) : null}
            </div>
            <button
              className="ibtn"
              type="button"
              disabled={importing || !pipelineId || !stageId}
              onClick={runImport}
            >
              {importing
                ? `Importing… ${progress}/${parsed.rows.length}`
                : `Import ${parsed.rows.length} rows`}
            </button>
            <div className="imeta">
              Dedupes by email/phone; existing contacts are skipped. Server-side,
              admin-only.
            </div>
            {importErr ? <div className="savemsg err">✗ {importErr}</div> : null}
            {summary ? (
              <div className="iresult">
                <span className="ok">✓ {summary.created} created</span>
                <span>· {summary.skipped} skipped (existing)</span>
                <span className="bad">· {summary.failed} failed</span>
                {summary.errors.length ? (
                  <ul className="ierrs">
                    {summary.errors.slice(0, 30).map((e, i) => (
                      <li key={i}>
                        Row {e.row}: {e.error}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
