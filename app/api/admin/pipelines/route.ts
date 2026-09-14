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
    /**
     * 🔴 TRUE WHEN TICKING THIS FOLDER WOULD DO NOTHING AT ALL.
     *
     * Every field in it is hidden or system-info, and both of those are
     * intercepted in groupFieldsForPipeline BEFORE any folder rule runs. So the
     * checkbox is not "a bad idea here" — it is inert, and an inert control is
     * worse than an absent one because nothing tells you it did nothing.
     */
    inert: boolean;
    fields: { id: string; name: string; dataType?: string }[];
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
      inert: fields.every((f) => fieldIsAlwaysIntercepted(f.name)),
      // dataType travels with the name: the expanded panel shows it, and it is
      // already on every definition, so withholding it would cost a round trip
      // to say what we already know.
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
    const [pipelines, defs, config, contactDefs] = await Promise.all([
      listPipelines(),
      getEditableFieldDefs("opportunity"),
      getPipelineConfig(),
      // 🔴 ITEM O — THE CONTACT SIDE, READ ONLY. The screen could not show a
      // contact folder at all, so "Enquiry Details" — one field, used by zero of
      // 1,114 contacts, drawn on every client record — was invisible to the only
      // person who could act on it.
      //
      // ⚠️ NO EXTRA ROUND TRIP IN PRACTICE. getEditableFieldDefs memoizes per
      // model per lambda, and the contact defs are already fetched by
      // /api/opportunities on the same instance.
      getEditableFieldDefs("contact").catch(() => [] as EditableFieldDef[]),
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
        // 🔴 THE INERT ONES ARE NOT OFFERED. Round 33 hid Reassign Followers as
        // "a string of meaningless ids that reads as a fault"; the folder it
        // lives in holds nothing else a pipeline can show, so a checkbox for it
        // can only mislead. Split out rather than deleted — the screen says how
        // many were withheld and why, so the count on screen still reconciles
        // with what is in GoHighLevel.
        sections: sections.filter((s) => !s.inert),
        inertSections: sections
          .filter((s) => s.inert)
          .map((s) => ({ id: s.id, key: s.key, fields: s.fields })),
        // ITEM 6 — ⚠️ DETECTION IS FREE, as you said: every def already carries
        // parentId and the defs are already cached, so a folder no pipeline has
        // been given and no name is held for costs no extra call to find.
        unconfiguredFolders: sections
          .filter(
            (sec) =>
              !sec.named &&
              // ⚠️ AND NOT INERT. Asking an admin to type a name for a folder
              // that enables nothing is asking for work with no effect.
              !sec.inert &&
              !Object.values(config.pipelines).some((e) => e.folders.includes(sec.key)),
          )
          .map((sec) => ({ id: sec.id, key: sec.key, fields: sec.fields })),
        known: knownFields(defs, sections),
        sharedKey: folderKeyById(FOLDERS.shared),
        /**
         * 🔴 ITEM O — BOTH NAMES, BECAUSE THE DASHBOARD RENAMES THEM.
         *
         * "Form | Form 6" is what an admin sees in GoHighLevel. "Enquiry
         * Details" is what this app calls it. An admin searching GHL for the
         * second finds nothing, which is how a dead folder stays on every client
         * record with nobody able to name it.
         *
         * ⚠️ READ-ONLY, AND THE SCREEN SAYS SO. CONTACT_FOLDERS is a hardcoded
         * table (lib/fieldFolders.ts:493) and making it editable is a different
         * control from this checklist — contact folders are not pipeline-scoped.
         * Showing what is there and what it costs is the half that can be true
         * today; see the report.
         */
        contactSections: CONTACT_FOLDERS.map((f) => {
          const fields = contactDefs.filter(
            (d) =>
              (d.parentId && d.parentId === f.id) ||
              (!!(d.parentName || "").trim() &&
                (d.parentName || "").trim().toLowerCase() === f.name.toLowerCase()),
          );
          return {
            id: f.id,
            ghlName: f.name,
            label: f.label,
            appliesTo: f.appliesTo,
            renamed: f.label.trim().toLowerCase() !== f.name.trim().toLowerCase(),
            fields: fields.map((d) => ({ id: d.id, name: d.name, dataType: d.dataType })),
          };
        }),
        /**
         * ⚠️ A CONTACT FOLDER GOHIGHLEVEL HAS AND THIS APP DOES NOT — item O's
         * second half. Its fields fall to the contact-side orphan bucket with no
         * banner and no way to file them, so the only thing this screen can
         * honestly do today is SAY THEY EXIST.
         *
         * 🔴 GHL STANDARD FOLDERS ARE NOT LISTED. "Contact" and "Additional
         * Info" are standardFieldsFolder:true — fieldFolders.ts:511 — and
         * offering either drags every native field onto the panel. They are not
         * candidates, so listing them as unfiled would be an invitation to a
         * known incident.
         */
        unknownContactFolders: (() => {
          const known = new Set(CONTACT_FOLDERS.map((f) => f.id));
          const standard = new Set([
            "O0m1HH8Mou9C9ImAPhJT", // "Contact"
            "4ywdaP7iC0k6zaEkXTTl", // "Additional Info"
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
    | "name-folder";
  // create-pipeline
  name?: string;
  stages?: string[];
  scope?: "client" | "caregiver";
  folders?: string[];
  // save-config
  config?: unknown;
  // delete-pipeline
  pipelineId?: string;
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

      /**
       * 🔴 ITEM L — DELETE, GATED ON THE RECORD COUNT SERVER-SIDE.
       *
       * The screen counts too, from the payload it already holds, and refuses to
       * offer the button. That is the good experience. THIS is the guarantee:
       * the browser's number is whatever the browser last loaded, and an
       * opportunity created in GoHighLevel five minutes ago is not in it.
       *
       * ⚠️ ONE REQUEST. `limit=1`, read `meta.total` — not the 6-page fetch
       * `searchAll` would do. Delete is a rare, deliberate, irreversible action;
       * one call to make it safe is the cheapest thing on this screen.
       *
       * 🔴 AND A COUNT WE COULD NOT GET REFUSES. `null` is "I could not count",
       * never "zero" — the same rule round 115b's scope dialog follows.
       */
      /**
       * 🔴 ITEM L — HOW MANY RECORDS ARE IN ONE PIPELINE, ON DEMAND.
       *
       * ⚠️ THE BROWSER'S OWN COUNTS CANNOT ANSWER THIS, and finding that out is
       * what item L cost. `recordCounts` is built by counting the records in the
       * loaded payloads, so a pipeline with NO records never appears in it — and
       * "zero" is then indistinguishable from "never fetched". The two pipelines
       * this item exists to delete, "test" and "round 91 probe", are both
       * unconfigured: they are in NO board's payload, so the browser has never
       * seen them and never will.
       *
       * 🔴 ONE REQUEST, WHEN A ROW IS OPENED. Not on load, and not for all ten —
       * the same rule item T follows. `limit=1` and read the total.
       */
      case "count-records": {
        const pipelineId = String(body.pipelineId || "").trim();
        if (!pipelineId)
          return NextResponse.json(
            { error: "No pipeline was named.", status: 400 } as ApiError,
            { status: 400 },
          );
        const count = await countOpportunitiesInPipeline(pipelineId);
        // ⚠️ null TRAVELS AS null. The screen shows "I cannot say" and offers no
        // delete; turning it into 0 here is how an empty-looking pipeline with
        // records in it gets deleted.
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
            } as ApiError,
            { status: 409 },
          );
        await deletePipeline(pipelineId);
        // 🔴 AND THE STORED ENTRY GOES WITH IT — round 90's stale-key case.
        //
        // ⚠️ THIS IS NOT THE AUTO-DELETE ROUND 90 REFUSED. That refusal protects
        // an admin who deleted the wrong pipeline IN GHL and is about to
        // recreate it — the app must not throw away a mapping it cannot know
        // they still want. Here the same admin is deleting both, in one action,
        // having been told what it does. Leaving the entry behind would only
        // manufacture the stale key this screen then asks them to reconcile.
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
        // 🔴 THE SCREEN CANNOT UNTICK WHAT IT WAS NEVER SHOWN.
        //
        // `next.pipelines` is the whole map as the screen holds it, so anything
        // the screen does not render is absent from it — and absent here means
        // REMOVED. Inert folders are now filtered out of `sections`, so without
        // this an admin pressing Save would silently drop a stored selection
        // they never saw and never chose to change.
        //
        // ⚠️ Narrow on purpose: ONLY tokens for folders that are inert today.
        // Carrying every unrendered token would make deliberate removal
        // impossible, which is the opposite mistake.
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
