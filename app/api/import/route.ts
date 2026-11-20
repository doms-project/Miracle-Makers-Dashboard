import { NextResponse } from "next/server";
import {
  upsertContact,
  createOpportunity,
  findContactByEmailOrPhone,
  updateContactCustomFields,
  listContactOpportunities,
  listOpportunityNotes,
  addOpportunityNote,
  addContactTags,
  composeNoteBody,
  getEditableFieldDefs,
  toGhlDate,
  GhlError,
} from "@/lib/ghl";
import {
  buildImportNote,
  importNoteHeading,
  normaliseCell,
  splitFullName,
  stripLeadingApostrophe,
  type NoteColumn,
} from "@/lib/importNotes";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import { e164 } from "@/lib/phone";
import type {
  ImportSummary,
  ApiError,
  EditableFieldDef,
  DuplicateMode,
} from "@/lib/types";
import { checkBatchTag } from "@/lib/batchTag";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type Row = Record<string, unknown>;
interface ImportBody {
  ssoKey?: string;
  pipelineId?: string;
  stageId?: string;
  source?: string;
  mapping?: Record<string, string>;
  rows?: Row[];
  rowOffset?: number;

  totalRows?: number;

  duplicateMode?: DuplicateMode;

  batchTag?: string;

  columns?: string[];
}

function formatValue(def: EditableFieldDef, value: unknown): unknown {
  const t = (def.dataType || "").toUpperCase();
  if (t === "MULTIPLE_OPTIONS" || t === "CHECKBOX") {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (value === "" || value == null) return [];

    return String(value)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (t === "MONETORY" || t === "NUMERICAL" || t === "NUMBER") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  if (t === "DATE") {
    if (value == null || String(value).trim() === "") return "";
    return toGhlDate(value);
  }
  return value == null ? "" : String(value);
}

const str = (v: unknown) => (v == null ? "" : String(v).trim());

const SKIP_NOTE = Symbol("note already present");

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as ImportBody;

    if (ssoConfigured()) {
      if (!body.ssoKey)
        return NextResponse.json({ error: "Sign-in required.", status: 401 } as ApiError, { status: 401 });
      const s = decryptSso(body.ssoKey);
      if (!isAdminSession(s.role, s.type))
        return NextResponse.json({ error: "Admin only.", status: 403 } as ApiError, { status: 403 });
    }

    let actorId = "";
    let actorName = "";
    if (ssoConfigured() && body.ssoKey) {
      const s2 = decryptSso(body.ssoKey);
      actorId = s2.userId || "";
      actorName = s2.userName || "";
    }

    const { pipelineId, stageId, source, mapping, rows } = body;
    if (!pipelineId || !stageId)
      return NextResponse.json({ error: "Pick a pipeline and stage." } as ApiError, { status: 400 });
    if (!mapping || !Array.isArray(rows))
      return NextResponse.json({ error: "Missing mapping or rows." } as ApiError, { status: 400 });
    if (rows.length > 50)
      return NextResponse.json({ error: "Chunk too large (max 50 rows/request)." } as ApiError, { status: 400 });

    const { tag: batchTag, error: tagError } = checkBatchTag(
      typeof body.batchTag === "string" ? body.batchTag : "",
    );
    if (tagError)
      return NextResponse.json(
        { error: tagError, status: 400 } as ApiError,
        { status: 400 },
      );

    const [oppDefs, contactDefs] = await Promise.all([
      getEditableFieldDefs("opportunity"),
      getEditableFieldDefs("contact"),
    ]);
    const oppById = new Map(oppDefs.map((d) => [d.id, d]));
    const contactById = new Map(contactDefs.map((d) => [d.id, d]));
    const dupMode: DuplicateMode = body.duplicateMode || "update";
    const offset = typeof body.rowOffset === "number" ? body.rowOffset : 0;

    const summary: ImportSummary = {
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      noted: 0,
      notesSkipped: 0,
      tagged: 0,
      errors: [],
      flagged: [],
    };

    const totalRows =
      typeof body.totalRows === "number" && body.totalRows > 0
        ? body.totalRows
        : rows.length;

    for (let i = 0; i < rows.length; i++) {
      const rowNo = offset + i + 1;
      const row = rows[i];
      try {

        const contact: Parameters<typeof upsertContact>[0] = { source };
        const oppCf: { id: string; value: unknown }[] = [];
        const contactCf: { id: string; value: unknown }[] = [];
        const noteCols: NoteColumn[] = [];
        let oppName = "";

        const cols =
          Array.isArray(body.columns) && body.columns.length
            ? body.columns
            : Object.keys(mapping);

        for (const col of cols) {
          const target = mapping[col];
          if (!target) continue;

          const val = stripLeadingApostrophe(row[col]);
          if (val == null || val === "") continue;

          if (target === "note:") {
            noteCols.push({ header: col, value: String(val) });
            continue;
          }
          if (target.startsWith("cf:") || target.startsWith("ccf:")) {
            const onContact = target.startsWith("ccf:");
            const def = onContact
              ? contactById.get(target.slice(4))
              : oppById.get(target.slice(3));
            if (!def) continue;
            const t = (def.dataType || "").toUpperCase();
            const kind =
              t === "DATE"
                ? "date"
                : t === "MONETORY" || t === "NUMERICAL" || t === "NUMBER"
                  ? "number"
                  : "text";
            const norm = normaliseCell(val, kind);

            if (norm.unnormalised)
              summary.flagged.push({
                row: rowNo,
                column: col,
                value: String(val).slice(0, 120),
                reason:
                  norm.value === val || typeof norm.value === "string"
                    ? `Could not be read as a ${kind} — imported exactly as written.`
                    : `Imported as ${JSON.stringify(norm.value)} — the rest of the cell is not part of a ${kind}.`,
              });
            const entry = { id: def.id, value: formatValue(def, norm.value) };

            if (onContact) contactCf.push(entry);
            else oppCf.push(entry);
          } else if (target === "native:firstName") contact.firstName = str(val);
          else if (target === "native:lastName") contact.lastName = str(val);
          else if (target === "native:name") {

            const { first, last } = splitFullName(val);
            if (first) contact.firstName = first;
            if (last) contact.lastName = last;
          } else if (target === "native:email") contact.email = str(val);
          else if (target === "native:phone") {

            const ph = e164(val);
            contact.phone = ph.value;
            if (ph.unnormalised)
              summary.flagged.push({
                row: rowNo,
                column: col,
                value: String(val).slice(0, 120),
                reason:
                  "Not a 10-digit or 1+10-digit US number — imported exactly as written.",
              });
          }
          else if (target === "native:oppName") oppName = str(val);
        }

        if (!oppName)
          oppName =
            [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() ||
            contact.name ||
            contact.email ||
            `Imported lead ${rowNo}`;

        if (
          !contact.email &&
          !contact.phone &&
          !contact.name &&
          !contact.firstName &&
          !contact.lastName
        ) {
          summary.failed++;
          summary.errors.push({
            row: rowNo,
            error: "No name/email/phone to import.",
          });
          continue;
        }

        const existing = await findContactByEmailOrPhone({
          email: contact.email,
          phone: contact.phone,
        });

        if (existing && dupMode === "skip") {

          summary.skipped++;
          continue;
        }

        let contactId = "";

        if (existing) {
          contactId = existing.id;

          if (contactCf.length) {
            try {
              await updateContactCustomFields(contactId, contactCf);
            } catch (e) {
              summary.errors.push({
                row: rowNo,
                error: `Existing record kept, but its fields did not save — ${
                  e instanceof Error ? e.message : String(e)
                }`.slice(0, 300),
              });
            }
          }
          summary.updated++;
        } else {
          const up = await upsertContact({
            ...contact,
            customFields: contactCf,
          });
          contactId = up.id;
          if (!contactId) {
            summary.failed++;
            summary.errors.push({ row: rowNo, error: "Contact upsert returned no id." });
            continue;
          }
        }

        if (batchTag && contactId) {
          try {
            await addContactTags(contactId, [batchTag]);
            summary.tagged++;
          } catch (e) {
            summary.errors.push({
              row: rowNo,
              error: `Record imported, but the batch tag "${batchTag}" did not save — ${
                e instanceof Error ? e.message : String(e)
              }`.slice(0, 300),
            });
          }
        }

        let oppId = "";
        if (!existing) {
          oppId = await createOpportunity({
            pipelineId,
            stageId,
            contactId,
            name: oppName,
            source,
            customFields: oppCf,
          });
          summary.created++;
        } else {

          const held = await listContactOpportunities(contactId);
          oppId =
            held.find((o) => o.pipelineId === pipelineId)?.id ||
            held[0]?.id ||
            "";
        }

        if (noteCols.length && oppId) {
          try {

            if (existing) {
              const heading = importNoteHeading(source || "", new Date());
              const notes = await listOpportunityNotes(contactId, oppId);
              const already = notes.some((n) =>
                `${n.system || ""}${n.txt || ""}`.trimStart().startsWith(heading),
              );
              if (already) {
                summary.notesSkipped++;
                throw SKIP_NOTE;
              }
            }
            await addOpportunityNote(
              contactId,
              oppId,
              composeNoteBody({
                system: buildImportNote({
                  source: source || "",
                  when: new Date(),
                  userName: actorName,
                  batchSize: totalRows,
                  columns: noteCols,
                }),
                reason: "",
              }),
              actorId,
            );
            summary.noted++;
          } catch (e) {
            if (e === SKIP_NOTE) continue;
            summary.errors.push({
              row: rowNo,
              error: `Record imported, but its note did not save — ${
                e instanceof Error ? e.message : String(e)
              }`.slice(0, 300),
            });
          }
        }
      } catch (e) {
        summary.failed++;
        const msg =
          e instanceof GhlError
            ? `${e.message}${e.detail ? ` — ${e.detail}` : ""}`
            : e instanceof Error
              ? e.message
              : String(e);
        summary.errors.push({ row: rowNo, error: msg.slice(0, 300) });
      }
    }

    return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json({ error: e.message, status: e.status } as ApiError, { status: e.status });
    return NextResponse.json({ error: "Import failed.", detail: String(e) } as ApiError, { status: 500 });
  }
}
