import { NextResponse } from "next/server";
import {
  listPipelines,
  getEditableFieldDefs,
  getPipelineConfig,
  savePipelineConfig,
  createPipeline,
  createFieldFolder,
  createCustomField,
  moveFieldToFolder,
  rememberFolderName,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { FOLDERS, FOLDER_LABELS, folderKeyById } from "@/lib/fieldFolders";
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

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// 🔴 ADMIN-ONLY, ENFORCED HERE — NOT BY THE HIDDEN RAIL ENTRY.
//
// The rail's `isAdminViewer` is convenience: it keeps a link a rep cannot use
// out of their way. It is not the boundary. This route re-derives the role from
// the SSO blob on every call, exactly as /api/admin/pipeline-access does,
// because this one can create pipelines and fields on the live account.
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

/**
 * Folder sections, each with its fields NAMED.
 *
 * ⚠️ EXPANDING A FOLDER HAS TO LIST ITS FIELDS. Ticking a folder name alone is
 * a guess — "More Details" and "Client Details" mean nothing until you can see
 * inside. The defs are already fetched and cached, so this costs no extra call.
 */
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
    key: string; // the stored token: a code key, or a raw id for a runtime folder
    id: string;
    label: string;
    /**
     * 🔴 FALSE MEANS THE LABEL IS A GUESS, and the screen has to say so.
     * Two sections both reading "Section" — 4 fields and 2 fields — is a
     * checklist nobody can tick with confidence: one of them was the Website
     * Intent Form and there was no way to tell which.
     */
    named: boolean;
    fields: { id: string; name: string }[];
  }[] = [];
  for (const [folderId, fields] of byFolder) {
    const key = folderKeyById(folderId);
    const curated = key ? FOLDER_LABELS[key as keyof typeof FOLDER_LABELS] : "";
    // 🔴 NOT parentName. It is EMPTY on every field — round 55 verified that
    // live and wrote it down (lib/fieldFolders.ts:491); round 91 labelled
    // runtime folders by it anyway. The stored name is the only other source
    // there has ever been.
    const fromGhl = folderNames[folderId] || "";
    const named = !!(curated || fromGhl);
    out.push({
      key: key || folderId, // hybrid: runtime folders have no key, so store the id
      id: folderId,
      // With no name from either source, name it by what is IN it rather than
      // by the word "Section" — a heading that is identical for every
      // unnameable folder is worse than no heading.
      label:
        curated ||
        fromGhl ||
        `Unnamed section · ${fields
          .slice(0, 2)
          .map((f) => f.name)
          .join(", ")}${fields.length > 2 ? "…" : ""}`,
      named,
      fields: fields
        .map((f) => ({ id: f.id, name: f.name }))
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

// GET — the screen's whole payload, live:
//   pipelines   ALL of them from GHL (so a pipeline deleted in GHL but still in
//               the stored map can be reconciled rather than silently listed)
//   config      the stored value, seeded on first read if never configured
//   sections    every folder with its fields named, for the checklist
//   known       every field, for the duplicate guard
export async function GET(request: Request) {
  try {
    const denied = gate(request);
    if (denied) return denied;
    const [pipelines, defs, config] = await Promise.all([
      listPipelines(),
      getEditableFieldDefs("opportunity"),
      getPipelineConfig(),
    ]);
    const sections = sectionsFromDefs(defs, config.folderNames);
    const live = new Set(pipelines.map((p) => p.id));
    // ⚠️ RECONCILE, DO NOT AUTO-DELETE. A stored key with no live pipeline is
    // surfaced as "no longer in GoHighLevel" with a remove button. Silently
    // dropping it would also drop the mapping of an admin who deleted the wrong
    // pipeline in GHL and is about to recreate it.
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
        sections,
        // ITEM 6 — ⚠️ DETECTION IS FREE, as you said: every def already carries
        // parentId and the defs are already cached, so a folder no pipeline has
        // been given and no name is held for costs no extra call to find.
        unconfiguredFolders: sections
          .filter(
            (sec) =>
              !sec.named &&
              !Object.values(config.pipelines).some((e) => e.folders.includes(sec.key)),
          )
          .map((sec) => ({ id: sec.id, key: sec.key, fields: sec.fields })),
        known: knownFields(defs, sections),
        sharedKey: folderKeyById(FOLDERS.shared),
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
    | "save-config"
    | "create-section"
    | "create-field"
    | "move-field"
    | "name-folder";
  // create-pipeline
  name?: string;
  stages?: string[];
  scope?: "client" | "caregiver";
  folders?: string[];
  // save-config
  config?: unknown;
  // create-section / create-field
  parentId?: string;
  fieldId?: string;
  folderId?: string;
  dataType?: string;
  options?: string[];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;
    const denied = gate(request, body.ssoKey);
    if (denied) return denied;

    switch (body.action) {
      case "create-pipeline": {
        // 🔴 SCOPE IS REQUIRED AND NEVER INFERRED. The caregiver/client split is
        // structural; guessing it puts an applicant on the client board.
        const scope = body.scope === "caregiver" ? "caregiver" : body.scope === "client" ? "client" : null;
        if (!scope)
          return NextResponse.json(
            { error: "Choose whether this is a client or a caregiver pipeline.", status: 400 } as ApiError,
            { status: 400 },
          );
        const created = await createPipeline({
          name: String(body.name || ""),
          stages: Array.isArray(body.stages) ? body.stages.map(String) : [],
        });
        // The mapping is written in the SAME request. A pipeline that exists
        // without one is the whole failure this screen was built to remove, so
        // there is no window in which it can be created and left unmapped.
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

      case "save-config": {
        const next = parsePipelineConfig(
          typeof body.config === "string" ? body.config : JSON.stringify(body.config ?? ""),
        );
        if (!next)
          return NextResponse.json(
            { error: "That configuration could not be read.", status: 400 } as ApiError,
            { status: 400 },
          );
        // 🔴 ALWAYS seeded:true on a save. Writing false would arm the seed to
        // overwrite this very save on the next read.
        const current = await getPipelineConfig();
        const saved = await savePipelineConfig({
          seeded: true,
          pipelines: next.pipelines,
          // ⚠️ MERGED, never replaced. The screen does not send folderNames, so
          // writing next.folderNames would erase every name we hold.
          folderNames: { ...current.folderNames, ...next.folderNames },
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
        // Re-checked server-side. The screen checks as you type; that is a
        // courtesy, not a gate.
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
