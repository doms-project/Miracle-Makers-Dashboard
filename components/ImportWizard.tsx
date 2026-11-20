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
import { checkBatchTag } from "@/lib/batchTag";
import {
  buildImportNote,
  splitFullName,
  stripLeadingApostrophe,
} from "@/lib/importNotes";

type Parsed = { columns: string[]; rows: Record<string, unknown>[] };

const NOTE_TARGET = "note:";

const NATIVE_TARGETS: { key: string; label: string }[] = [
  { key: NOTE_TARGET, label: "Append to notes" },
  { key: "native:firstName", label: "Contact · First Name" },
  { key: "native:lastName", label: "Contact · Last Name" },

  { key: "native:name", label: "Contact · Full Name (split into First / Last)" },
  { key: "native:email", label: "Contact · Email" },
  { key: "native:phone", label: "Contact · Phone" },
  { key: "native:oppName", label: "Opportunity · Name" },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const CHUNK = 25;
const STEPS = ["Upload", "Destination", "Map", "Preview", "Import"] as const;
type StepIdx = 0 | 1 | 2 | 3 | 4;

const SOURCE_OPTIONS = [
  "Indeed",
  "Facebook",
  "Google Ads",
  "Website",
  "Referral",
  "Other",
] as const;

function canonicalSource(v: string): string {
  const k = (v || "").trim().toLowerCase();
  return SOURCE_OPTIONS.find((o) => o.toLowerCase() === k) || "";
}

const HEADER_SCAN_LIMIT = 10;

const populated = (row: unknown[]): number =>
  row.filter((c) => String(c ?? "").trim() !== "").length;

function findHeaderRow(grid: unknown[][]): { idx: number; skipped: string[] } {
  const limit = Math.min(grid.length, HEADER_SCAN_LIMIT);
  let best = -1;
  for (let i = 0; i < limit; i++) {
    if (populated(grid[i] || []) >= 2) {
      best = i;
      break;
    }
  }
  if (best <= 0) return { idx: 0, skipped: [] };
  const skipped = grid
    .slice(0, best)
    .map((r) => (r || []).map((c) => String(c ?? "").trim()).filter(Boolean).join(" · "))
    .filter(Boolean);
  return { idx: best, skipped };
}

function gridToParsed(
  grid: unknown[][],
  headerIdx: number,
  dropTotals: boolean,
): { columns: string[]; rows: Record<string, unknown>[]; dropped: string | null } {
  const header = (grid[headerIdx] || []).map((c) => String(c ?? "").trim());
  const columns = header.filter(Boolean);
  const totalsIdx = dropTotals ? trailingTotalsRow(grid, headerIdx) : null;
  const dropped =
    totalsIdx == null
      ? null
      : (grid[totalsIdx] || [])
          .map((c) => String(c ?? "").trim())
          .filter(Boolean)
          .join(" · ") || "(blank row)";
  const body = grid.slice(headerIdx + 1, totalsIdx == null ? undefined : totalsIdx);
  const rows = body
    .map((r) => {
      const o: Record<string, unknown> = {};
      header.forEach((c, i) => {
        if (c) o[c] = stripLeadingApostrophe(r?.[i]);
      });
      return o;
    })
    .filter((r) => Object.values(r).some((v) => v != null && v !== ""));
  return { columns, rows, dropped };
}

function trailingTotalsRow(grid: unknown[][], headerIdx: number): number | null {
  if (grid.length - headerIdx < 3) return null;
  const last = grid[grid.length - 1] || [];
  const first = String(last[0] ?? "").trim();
  const headerCells = populated(grid[headerIdx] || []);
  const isSummary =
    /^(total|totals|grand total|sum)\b/i.test(first) ||
    (populated(last) <= 1 && headerCells >= 2) ||

    (!first && populated(last) > 0 && populated(last) < headerCells / 2);
  return isSummary ? grid.length - 1 : null;
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

  const [rawGrid, setRawGrid] = useState<unknown[][] | null>(null);

  const [skipNotice, setSkipNotice] = useState<{
    top: string[];
    bottom: string | null;
    headerIdx: number;

    overridden: boolean;
  } | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parseErr, setParseErr] = useState<unknown>(null);
  const [dragOver, setDragOver] = useState(false);

  const [pipelineId, setPipelineId] = useState("");
  const [stageId, setStageId] = useState("");

  const [source, setSource] = useState("");

  const [batchTag, setBatchTag] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [autoMapped, setAutoMapped] = useState<Set<string>>(new Set());

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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/import/meta", { headers: ssoHeader(), cache: "no-store" })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw apiError(res, j);
        if (!cancelled) {
          setMetaErr(null);
          setMeta(j as ImportMeta);
        }
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

    }
  }, []);

  const pipeline: ImportPipeline | undefined = useMemo(
    () => meta?.pipelines.find((p) => p.id === pipelineId),
    [meta, pipelineId],
  );
  const pipelineName = pipeline?.name || "—";
  const stageName =
    pipeline?.stages.find((s) => s.id === stageId)?.name || "—";

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

          const cDef = (meta?.contactFieldDefs || []).find((d) => norm(d.name) === n);
          if (cDef) target = `ccf:${cDef.id}`;
          else {
            const def = (meta?.fieldDefs || []).find((d) => norm(d.name) === n);
            if (def) target = `cf:${def.id}`;
          }
        }
        if (target) auto.add(c);

        out[c] = target || NOTE_TARGET;
      }
      return { map: out, auto };
    },
    [meta],
  );

  const applyGrid = (
    grid: unknown[][],
    headerIdx: number,
    overridden: boolean,
  ): string | null => {
    const { columns, rows, dropped } = gridToParsed(grid, headerIdx, !overridden);
    if (!columns.length) throw new Error("No columns found in the file.");
    if (!rows.length) throw new Error("No data rows found in the file.");
    const { map, auto } = autoMap(columns);
    setParsed({ columns, rows });
    setMapping(map);
    setAutoMapped(auto);
    return dropped;
  };

  const useFileAsWritten = () => {
    if (!rawGrid || !skipNotice) return;
    try {
      applyGrid(rawGrid, 0, true);
      setSkipNotice({ ...skipNotice, overridden: true });
      setParseErr(null);
    } catch (e) {
      setParseErr(e);
    }
  };
  const useDetectedHeader = () => {
    if (!rawGrid || !skipNotice) return;
    try {
      applyGrid(rawGrid, skipNotice.headerIdx, false);
      setSkipNotice({ ...skipNotice, overridden: false });
      setParseErr(null);
    } catch (e) {
      setParseErr(e);
    }
  };

  const tagCheck = useMemo(() => checkBatchTag(batchTag), [batchTag]);

  const parseFile = async (file: File) => {
    setParseErr(null);
    setSummary(null);
    setImportErr(null);
    setFileName(file.name);

    setRawGrid(null);
    setSkipNotice(null);
    try {

      let grid: unknown[][];
      if (/\.csv$/i.test(file.name)) {
        const res = await new Promise<Papa.ParseResult<string[]>>(
          (resolve, reject) =>
            Papa.parse<string[]>(file, {
              header: false,
              skipEmptyLines: true,
              complete: resolve,
              error: reject,
            }),
        );
        grid = res.data;
      } else if (/\.xlsx$/i.test(file.name)) {
        grid = (await readXlsxFile(file)) as unknown[][];
      } else {
        throw new Error("Unsupported file type — upload a .xlsx or .csv.");
      }
      setRawGrid(grid);
      const found = findHeaderRow(grid);
      const dropped = applyGrid(grid, found.idx, false);
      const notice =
        found.skipped.length || dropped
          ? { top: found.skipped, bottom: dropped, headerIdx: found.idx, overridden: false }
          : null;
      setSkipNotice(notice);

      if (!notice) setStep(1);
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
      tagged: 0, errors: [], flagged: [],
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

            totalRows: parsed.rows.length,
            duplicateMode: dupMode,

            batchTag,

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

    if (p.source) setSource(canonicalSource(p.source));
    if (p.pipelineId) setPipelineId(p.pipelineId);
    if (p.stageId) setStageId(p.stageId);
  };

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

  const nameCol = parsed
    ? parsed.columns.find((c) => mapping[c] === "native:name") || ""
    : "";

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

  }, [parsed, mapping, source, noteCols]);

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

    if (step === 1)
      return !!pipelineId && !!stageId && !!source && !tagCheck.error;
    if (step === 2) return mappedCount > 0 && hasIdentity;
    return true;
  };

  if (metaErr && !meta)
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

          {skipNotice ? (
            <div className={`ihead ${skipNotice.overridden ? "raw" : ""}`}>
              {skipNotice.overridden ? (
                <>
                  <b>Using the file exactly as written.</b> Row 1 is the header
                  and nothing has been dropped from the bottom.
                </>
              ) : (
                <>
                  <b>
                    Row {skipNotice.headerIdx + 1} looks like the real header —
                    the rows above it were skipped.
                  </b>
                  {skipNotice.top.length ? (
                    <ul>
                      {skipNotice.top.map((t, i) => (
                        <li key={i}>
                          <span className="iheadn">Row {i + 1}</span>
                          <span className="iheadv">{t}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {skipNotice.bottom ? (
                    <ul>
                      <li>
                        <span className="iheadn">
                          Row {rawGrid ? rawGrid.length : "—"} · totals
                        </span>
                        <span className="iheadv">{skipNotice.bottom}</span>
                      </li>
                    </ul>
                  ) : null}
                </>
              )}
              <div className="iheadact">
                {skipNotice.overridden ? (
                  <button type="button" onClick={useDetectedHeader}>
                    Skip them after all
                  </button>
                ) : (
                  <button type="button" onClick={useFileAsWritten}>
                    No — use the file exactly as written
                  </button>
                )}
                <button
                  type="button"
                  className="iheadok"
                  onClick={() => setStep(1)}
                  disabled={!parsed}
                >
                  Looks right, continue
                </button>
              </div>
            </div>
          ) : null}
        </div>
      )}

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

            <label>Batch tag <span className="iopt">optional</span></label>
            <input
              className="itag"
              value={batchTag}
              list="batchtags"
              placeholder="Name this batch, however is useful to you"
              onChange={(e) => setBatchTag(e.target.value)}
              aria-invalid={!!tagCheck.error}
            />

            <datalist id="batchtags">
              {(meta?.tags ?? []).map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>

            {tagCheck.error ? (
              <div className="itagerr">🔴 {tagCheck.error}</div>
            ) : tagCheck.tag ? (
              <div className="ihint">
                Applied to every contact this import writes, as{" "}
                <code>{tagCheck.tag}</code>
                {tagCheck.tag !== batchTag.trim() ? (
                  <> — GHL tags are lowercase and hyphenated.</>
                ) : null}
                <br />
                Tags live on the contact, not the opportunity. Skipped
                duplicates are not tagged — skip means untouched.
              </div>
            ) : (
              <div className="ihint">
                Leave blank for no tag. This is not the source — it is a label
                for finding this one import again.
              </div>
            )}
          </div>
        </div>
      )}

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

      {step === 3 && parsed && (
        <div className="isec">
          <div className="istep">Preview</div>
          <div className="imeta" style={{ marginBottom: 10 }}>
            {parsed.rows.length} rows into <b>{pipelineName}</b> / <b>{stageName}</b>,
            deduped by email/phone.
          </div>

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

          {skipNotice && !skipNotice.overridden ? (
            <div className="idrops">
              <b>
                {skipNotice.top.length + (skipNotice.bottom ? 1 : 0)} row
                {skipNotice.top.length + (skipNotice.bottom ? 1 : 0) === 1
                  ? ""
                  : "s"}{" "}
                skipped as report furniture:
              </b>{" "}
              {[...skipNotice.top, skipNotice.bottom]
                .filter(Boolean)
                .join(" · ")}
            </div>
          ) : null}

          {droppedCols.length ? (
            <div className="idrops">
              <b>
                {droppedCols.length} column
                {droppedCols.length === 1 ? "" : "s"} will not be imported:
              </b>{" "}
              {droppedCols.join(" · ")}
            </div>
          ) : null}

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

                {tagCheck.tag ? (
                  <span>
                    · {summary.tagged} tagged <code>{tagCheck.tag}</code>
                  </span>
                ) : null}
                <span className="bad">· {summary.failed} failed</span>
              </div>

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

                const next = Math.min(step + 1, 4) as StepIdx;

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
