import { NextResponse } from "next/server";
import {
  listPipelines,
  getEditableFieldDefs,
  getPipelineConfig,
  savePipelineConfig,
  createPipeline,
  deletePipeline,
  countOpportunitiesInPipeline,
  createFieldFolder,
  createCustomField,
  moveFieldToFolder,
  rememberFolderName,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import {
  FOLDERS,
  FOLDER_LABELS,
  CONTACT_FOLDERS,
  folderIdsPresent,
  builtInFoldersAreForeign,
  resolveFolderId,
  folderKeyById,
  fieldIsAlwaysIntercepted,
} from "@/lib/fieldFolders";
import { divisionLabel } from "@/lib/division";
import { checkFieldName, type KnownField } from "@/lib/fieldNaming";
import {
  parsePipelineConfig,
  type StoredPipelineConfig,
  type StoredPipelineEntry,
} from "@/lib/pipelineConfig";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import type { ApiError, EditableFieldDef } from "@/lib/types";
import { BUILD, BUILD_LABEL } from "@/lib/build";
import { resolveLabels, labelProblem, withLabel, type LabelKey } from "@/lib/sorting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const maxDuration = 60;

function gate(request: Request, ssoKey?: string): NextResponse | null {
  if (!ssoConfigured()) return null;
  const blob = ssoKey || request.headers.get("x-ghl-sso-key");
  if (!blob)
    return NextResponse.json({ error: "Sign-in required.", status: 401 } as ApiError, {
      status: 401,
    });
  const s = decryptSso(blob);
  if (!isAdminSession(s.role, s.type))
    return NextResponse.json({ error: "Admin only.", status: 403 } as ApiError, {
      status: 403,
    });
  return null;
}

function fail(e: unknown): Promise<NextResponse> | NextResponse {
  if (e instanceof SsoError)
    return NextResponse.json({ error: e.message, status: e.status } as ApiError, {
      status: e.status,
    });
  if (e instanceof GhlError)
    return explainGhlError(e).then((detail) =>
      NextResponse.json({ error: e.message, detail } as ApiError, {
        status: e.status >= 400 && e.status < 600 ? e.status : 502,
      }),
    );
  return NextResponse.json({ error: "Request failed.", detail: String(e) } as ApiError, {
    status: 500,
  });
}

function sectionsFromDefs(
  defs: EditableFieldDef[],
  folderNames: Record<string, string> = {},
) {
  const byFolder = new Map<string, EditableFieldDef[]>();
  for (const d of defs) {
    if (!d.parentId) continue;
    const arr = byFolder.get(d.parentId) || [];
    arr.push(d);
    byFolder.set(d.parentId, arr);
  }
  const out: {
    key: string;
    id: string;
    label: string;

    named: boolean;

    inert: boolean;
    fields: { id: string; name: string; dataType?: string }[];
  }[] = [];
  for (const [folderId, fields] of byFolder) {
    const key = folderKeyById(folderId);
    const curated = key ? FOLDER_LABELS[key as keyof typeof FOLDER_LABELS] : "";

    const fromGhl = folderNames[folderId] || "";
    const named = !!(curated || fromGhl);
    out.push({
      key: key || folderId,
      id: folderId,

      label:
        curated ||
        fromGhl ||
        `Unnamed section · ${fields
          .slice(0, 2)
          .map((f) => f.name)
          .join(", ")}${fields.length > 2 ? "…" : ""}`,
      named,
      inert: fields.every((f) => fieldIsAlwaysIntercepted(f.name)),

      fields: fields
        .map((f) => ({ id: f.id, name: f.name, dataType: f.dataType }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return out.sort(
    (a, b) => Number(b.named) - Number(a.named) || a.label.localeCompare(b.label),
  );
}

function knownFields(defs: EditableFieldDef[], sections: ReturnType<typeof sectionsFromDefs>): KnownField[] {
  const labelByFolder = new Map(sections.map((s) => [s.id, s]));
  return defs.map((d) => {
    const sec = labelByFolder.get(d.parentId);
    return {
      id: d.id,
      name: d.name,
      folderLabel: sec?.label || "Other fields",
      folderFieldCount: sec?.fields.length ?? 0,
      options: d.options,
    };
  });
}

export async function GET(request: Request) {
  try {
    const denied = gate(request);
    if (denied) return denied;
    const [pipelines, defs, config, contactDefs] = await Promise.all([
      listPipelines(),
      getEditableFieldDefs("opportunity"),
      getPipelineConfig(),

      getEditableFieldDefs("contact").catch(() => [] as EditableFieldDef[]),
    ]);

    const folderIdsHere = folderIdsPresent([...defs, ...contactDefs]);
    const sections = sectionsFromDefs(defs, config.folderNames);
    const live = new Set(pipelines.map((p) => p.id));

    const stale = Object.keys(config.pipelines).filter((id) => !live.has(id));
    return NextResponse.json(
      {
        pipelines: pipelines.map((p) => ({
          ...p,
          division: divisionLabel(p.name),
          configured: Object.prototype.hasOwnProperty.call(config.pipelines, p.id),
        })),
        config,
        stale,

        sections: sections.filter((s) => !s.inert),
        inertSections: sections
          .filter((s) => s.inert)
          .map((s) => ({ id: s.id, key: s.key, fields: s.fields })),

        unconfiguredFolders: sections
          .filter(
            (sec) =>
              !sec.named &&

              !sec.inert &&
              !Object.values(config.pipelines).some((e) => e.folders.includes(sec.key)),
          )
          .map((sec) => ({ id: sec.id, key: sec.key, fields: sec.fields })),
        known: knownFields(defs, sections),
        sharedKey: folderKeyById(FOLDERS.shared),

        contactSections: CONTACT_FOLDERS.map((f) => {
          const resolvedId =
            resolveFolderId(f.id, [f.name, f.label], folderIdsHere, config.folderNames) || "";
          const fields = contactDefs.filter(
            (d) =>
              (!!resolvedId && d.parentId === resolvedId) ||
              (!!(d.parentName || "").trim() &&
                (d.parentName || "").trim().toLowerCase() === f.name.toLowerCase()),
          );
          return {
            id: f.id,

            resolvedId,
            ghlName: f.name,
            label: f.label,
            appliesTo: f.appliesTo,
            renamed: f.label.trim().toLowerCase() !== f.name.trim().toLowerCase(),
            fields: fields.map((d) => ({ id: d.id, name: d.name, dataType: d.dataType })),
          };
        }),

        builtInFoldersForeign: builtInFoldersAreForeign([...contactDefs, ...defs]),

        unknownContactFolders: (() => {

          const known = new Set(
            CONTACT_FOLDERS.map(
              (f) =>
                resolveFolderId(f.id, [f.name, f.label], folderIdsHere, config.folderNames) ||
                f.id,
            ),
          );
          const standard = new Set([
            "O0m1HH8Mou9C9ImAPhJT",
            "4ywdaP7iC0k6zaEkXTTl",
          ]);
          const out = new Map<string, { id: string; fields: { id: string; name: string }[] }>();
          for (const d of contactDefs) {
            const pid = (d.parentId || "").trim();
            if (!pid || known.has(pid) || standard.has(pid)) continue;
            const g = out.get(pid) || { id: pid, fields: [] };
            g.fields.push({ id: d.id, name: d.name });
            out.set(pid, g);
          }
          return [...out.values()];
        })(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}

interface Body {
  ssoKey?: string;
  action?:
    | "create-pipeline"
    | "delete-pipeline"
    | "count-records"
    | "save-config"
    | "create-section"
    | "create-field"
    | "move-field"
    | "name-folder"
    | "rename-tab";

  name?: string;
  stages?: string[];
  scope?: "client" | "caregiver";
  folders?: string[];

  config?: unknown;

  build?: string;

  pipelineId?: string;

  parentId?: string;
  fieldId?: string;
  folderId?: string;
  dataType?: string;
  options?: string[];

  key?: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    const denied = gate(request, body.ssoKey);
    if (denied) return denied;

    switch (body.action) {
      case "create-pipeline": {

        const scope = body.scope === "caregiver" ? "caregiver" : body.scope === "client" ? "client" : null;
        if (!scope)
          return NextResponse.json(
            {
              error: "Choose whether this is a client or a caregiver pipeline.",
              status: 400,
              refusal: true,
            } as ApiError,
            { status: 400 },
          );
        const created = await createPipeline({
          name: String(body.name || ""),
          stages: Array.isArray(body.stages) ? body.stages.map(String) : [],
        });

        const config = await getPipelineConfig();
        const entry: StoredPipelineEntry = {
          scope,
          folders: Array.isArray(body.folders) && body.folders.length
            ? body.folders.map(String)
            : [folderKeyById(FOLDERS.shared) || FOLDERS.shared],
        };
        const saved = await savePipelineConfig({
          ...config,
          seeded: true,
          pipelines: { ...config.pipelines, [created.id]: entry },
        });
        return NextResponse.json({ pipeline: created, config: saved });
      }

      case "count-records": {
        const pipelineId = String(body.pipelineId || "").trim();
        if (!pipelineId)
          return NextResponse.json(
            { error: "No pipeline was named.", status: 400 } as ApiError,
            { status: 400 },
          );
        const count = await countOpportunitiesInPipeline(pipelineId);

        return NextResponse.json({ pipelineId, count });
      }

      case "delete-pipeline": {
        const pipelineId = String(body.pipelineId || "").trim();
        if (!pipelineId)
          return NextResponse.json(
            { error: "No pipeline was named.", status: 400 } as ApiError,
            { status: 400 },
          );
        const count = await countOpportunitiesInPipeline(pipelineId);
        if (count == null)
          return NextResponse.json(
            {
              error:
                "I could not count the records in this pipeline, so I will not delete it. Try again in a moment.",
              status: 503,
              refusal: true,
            } as ApiError,
            { status: 503 },
          );
        if (count > 0)
          return NextResponse.json(
            {
              error: `${count} record${count === 1 ? " is" : "s are"} in this pipeline. Move or close ${
                count === 1 ? "it" : "them"
              } in GoHighLevel first.`,
              status: 409,

              refusal: true,
            } as ApiError,
            { status: 409 },
          );

        let deleteErr: unknown = null;
        try {
          await deletePipeline(pipelineId);
        } catch (e) {
          deleteErr = e;
        }
        if (deleteErr) {
          const still = (await listPipelines()).some((p) => p.id === pipelineId);

          if (still) throw deleteErr;
          // eslint-disable-next-line no-console
          console.warn(
            `[pipelines] delete of ${pipelineId} reported an error but the ` +
              "pipeline is gone from GoHighLevel. Removing the stored entry so " +
              "it does not become a stale key.",
          );
        }

        const cfg = await getPipelineConfig();
        let config = cfg;
        if (Object.prototype.hasOwnProperty.call(cfg.pipelines, pipelineId)) {
          const rest = { ...cfg.pipelines };
          delete rest[pipelineId];
          config = await savePipelineConfig({ ...cfg, seeded: true, pipelines: rest });
        }
        return NextResponse.json({ deleted: pipelineId, config });
      }

      case "save-config": {

        if (String(body.build ?? "") !== BUILD.round)
          return NextResponse.json(
            {
              error:

                `This page is from a different version of the dashboard ` +
                `(page ${body.build ? `v${String(body.build).slice(0, 12)}` : "unknown"}, ` +
                `server ${BUILD_LABEL}). Nothing was saved. Reload the page, ` +
                `then make the change again.`,
              status: 409,
              refusal: true,
            } as ApiError,
            { status: 409 },
          );
        const next = parsePipelineConfig(
          typeof body.config === "string" ? body.config : JSON.stringify(body.config ?? ""),
        );
        if (!next)
          return NextResponse.json(
            { error: "That configuration could not be read.", status: 400 } as ApiError,
            { status: 400 },
          );

        const current = await getPipelineConfig();

        const inertTokens = new Set(
          sectionsFromDefs(
            await getEditableFieldDefs("opportunity"),
            current.folderNames,
          )
            .filter((s) => s.inert)
            .map((s) => s.key),
        );
        if (inertTokens.size)
          for (const [pid, entry] of Object.entries(next.pipelines)) {
            const kept = (current.pipelines[pid]?.folders || []).filter((t) =>
              inertTokens.has(t),
            );
            for (const t of kept)
              if (!entry.folders.includes(t)) entry.folders.push(t);
          }
        const saved = await savePipelineConfig({
          seeded: true,
          pipelines: next.pipelines,

          folderNames: { ...current.folderNames, ...next.folderNames },

          labels: current.labels || {},
        });
        return NextResponse.json({ config: saved });
      }

      case "create-section": {
        const folder = await createFieldFolder({ name: String(body.name || "") });
        return NextResponse.json({ folder });
      }

      case "create-field": {
        const name = String(body.name || "").trim();
        const defs = await getEditableFieldDefs("opportunity");
        const cfg2 = await getPipelineConfig();
        const sections = sectionsFromDefs(defs, cfg2.folderNames);

        const verdict = checkFieldName(name, knownFields(defs, sections), body.options);
        if (verdict.kind === "blocked")
          return NextResponse.json(
            { error: verdict.message, status: 409 } as ApiError,
            { status: 409 },
          );
        const field = await createCustomField({
          name,
          dataType: String(body.dataType || "TEXT"),
          parentId: String(body.parentId || ""),
          options: body.options,
        });
        return NextResponse.json({ field });
      }

      case "move-field": {
        const r = await moveFieldToFolder(
          String(body.fieldId || ""),
          String(body.parentId || ""),
        );
        if (!r.ok)
          return NextResponse.json(
            {
              error:
                "GoHighLevel accepted the move but the field is still in its old section.",
              status: 502,
            } as ApiError,
            { status: 502 },
          );
        return NextResponse.json({ moved: true });
      }

      case "rename-tab": {
        const key = String(body.key || "");
        const okKey =
          key === "newLeads" || key === "staffingTab" || key === "staffingStage" ||
          /^pipeline:[A-Za-z0-9_-]{4,64}$/.test(key);
        if (!okKey)
          return NextResponse.json(
            { error: "That tab can't be renamed.", status: 400, refusal: true } as ApiError,
            { status: 400 },
          );
        const name = String(body.name ?? "");
        const cfg = await getPipelineConfig();
        const shown = resolveLabels(cfg.labels);
        let taken: string[] = [];
        if (key !== "staffingStage") {
          const pipes = await listPipelines();
          taken = [
            ...(key === "newLeads" ? [] : [shown.newLeads]),
            ...(key === "staffingTab" ? [] : [shown.staffingTab]),
            ...pipes
              .filter((p) => `pipeline:${p.id}` !== key)
              .map((p) => shown.pipelines[p.id] || p.name),
          ];
        }
        const problem = labelProblem(name, taken);
        if (problem)
          return NextResponse.json(
            { error: problem, status: 400, refusal: true } as ApiError,
            { status: 400 },
          );
        const saved = await savePipelineConfig({
          ...cfg,
          labels: withLabel(cfg.labels, key as LabelKey, name),
        });
        return NextResponse.json({ config: saved, labels: resolveLabels(saved.labels) });
      }

      case "name-folder": {
        await rememberFolderName(String(body.folderId || ""), String(body.name || ""));
        return NextResponse.json({ config: await getPipelineConfig() });
      }

      default:
        return NextResponse.json(
          { error: "Unknown action.", status: 400 } as ApiError,
          { status: 400 },
        );
    }
  } catch (e) {
    return fail(e);
  }
}

export type { StoredPipelineConfig };
