import { NextResponse } from "next/server";
import {
  upsertContact,
  createOpportunity,
  findContactByEmailOrPhone,
  updateContactCustomFields,
  listContactOpportunities,
  listOpportunityNotes,
  addOpportunityNote,
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

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60; // allow time for a chunk of rows

// Target keys the mapping can use.
//   native:firstName | native:lastName | native:name | native:email |
//   native:phone | native:oppName | cf:<fieldId> | ccf:<fieldId> | note:
//
// `cf:` is an OPPORTUNITY custom field, `ccf:` a CONTACT one. They are separate
// prefixes rather than one id space because the two models can hold the same
// id-shaped string and, more importantly, because they are written to DIFFERENT
// OBJECTS. Before this existed, every mapped field id was posted to BOTH the
// contact and the opportunity ("harmless otherwise") — which meant a contact
// field could not be imported at all, and an opportunity field id was being
// sent to the contact endpoint for no reason.
//
// `note:` is the recoverable default for a column nothing else claims. Before
// it existed, an unmapped column was dropped in the loop below with no record
// anywhere and the import still reported success — 54 of a 57-column Indeed
// export vanished that way. Dropping is still possible and still supported; it
// is now something a person CHOSE ("— Don't import —"), not something that
// happened while they weren't looking.
type Row = Record<string, unknown>;
interface ImportBody {
  ssoKey?: string;
  pipelineId?: string;
  stageId?: string;
  source?: string;
  mapping?: Record<string, string>; // column -> target key
  rows?: Row[];
  rowOffset?: number; // for correct 1-based row numbers across chunks
  // The whole file, not this chunk — the note says "47 records in this batch"
  // and the wizard posts in chunks of 25, so the count has to be passed in.
  totalRows?: number;
  // ITEM 5 — what to do with rows whose person already exists. Defaults to
  // "update": the safe middle, where nothing is lost either way and the note
  // always lands. An older client that sends nothing gets that default.
  duplicateMode?: DuplicateMode;
  // Column order as the FILE had it. Object key order survives JSON in practice
  // but is not guaranteed by it, and the note's layout depends on the order —
  // a Q&A pair is only a pair because the answer column follows the question.
  columns?: string[];
}

function formatValue(def: EditableFieldDef, value: unknown): unknown {
  const t = (def.dataType || "").toUpperCase();
  if (t === "MULTIPLE_OPTIONS" || t === "CHECKBOX") {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (value === "" || value == null) return [];
    // allow comma-separated cells for multi-select
    return String(value)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (t === "MONETORY" || t === "NUMERICAL" || t === "NUMBER") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  // ITEM 1 — same gap as the panel PATCH route: DATE had no branch, so an
  // imported date cell went to GHL as whatever the spreadsheet held. Normalize
  // to full ISO 8601, the shape proven to store. This also rescues Excel/CSV
  // cells that arrive as a Date object or a US "8/28/2026" string.
  if (t === "DATE") {
    if (value == null || String(value).trim() === "") return "";
    return toGhlDate(value);
  }
  return value == null ? "" : String(value);
}

const str = (v: unknown) => (v == null ? "" : String(v).trim());

// A sentinel, not an error: "this record already has this import's note".
// Thrown so the note block has one exit and the row still counts as imported.
const SKIP_NOTE = Symbol("note already present");

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as ImportBody;

    // ---- admin gate ----
    if (ssoConfigured()) {
      if (!body.ssoKey)
        return NextResponse.json({ error: "Sign-in required.", status: 401 } as ApiError, { status: 401 });
      const s = decryptSso(body.ssoKey);
      if (!isAdminSession(s.role, s.type))
        return NextResponse.json({ error: "Admin only.", status: 403 } as ApiError, { status: 403 });
    }

    // The importing user, for the note's second line. GHL still needs a real
    // userId as the note's author (the API rejects a note without one), so the
    // note is AUTHORED by whoever ran the import but its content lives in the
    // SYSTEM half of the body — the half the panel renders unstruck and no rep
    // can edit or withdraw, exactly like a Move note. That is what "system
    // note, not attributed" means mechanically: the person is named in the
    // text, and nobody can rewrite what another system said.
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
      errors: [],
      flagged: [],
    };
    // The whole file, for the note's "N records in this batch" line. Falls back
    // to the chunk so an older client still produces a truthful sentence.
    const totalRows =
      typeof body.totalRows === "number" && body.totalRows > 0
        ? body.totalRows
        : rows.length;

    // Sequential — respects GHL rate limits and keeps per-row errors clean.
    for (let i = 0; i < rows.length; i++) {
      const rowNo = offset + i + 1;
      const row = rows[i];
      try {
        // Build contact + opportunity fields from the mapping.
        const contact: Parameters<typeof upsertContact>[0] = { source };
        const oppCf: { id: string; value: unknown }[] = [];
        const contactCf: { id: string; value: unknown }[] = [];
        const noteCols: NoteColumn[] = [];
        let oppName = "";

        // FILE ORDER, not object-key order: the note's Q&A pairing depends on
        // the answer column following its question.
        const cols =
          Array.isArray(body.columns) && body.columns.length
            ? body.columns
            : Object.keys(mapping);

        for (const col of cols) {
          const target = mapping[col];
          if (!target) continue; // "— Don't import —": a deliberate drop.
          // 🔴 The apostrophe comes off EVERY cell, whatever its destination.
          // Excel adds it to anything it would otherwise reformat, and most of
          // those land in TEXT fields where it would be stored and shown on the
          // record for ever. Leading only — O'Brien and D'Angelo are untouched.
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
            // A value that could not be normalised is passed through UNCHANGED
            // and reported, never dropped and never guessed at: an unusual date
            // or a number with a unit in it may well be correct, and a person
            // decides that, not this code.
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
            // 🔴 To the object it belongs to, and ONLY that object.
            if (onContact) contactCf.push(entry);
            else oppCf.push(entry);
          } else if (target === "native:firstName") contact.firstName = str(val);
          else if (target === "native:lastName") contact.lastName = str(val);
          else if (target === "native:name") {
            // ONE "name" column, two GHL fields. Split on the FIRST space so a
            // multi-word surname stays whole: "Mary Anne Van Der Berg" is
            // Mary / Anne Van Der Berg, never Mary Anne Van Der / Berg.
            const { first, last } = splitFullName(val);
            if (first) contact.firstName = first;
            if (last) contact.lastName = last;
          } else if (target === "native:email") contact.email = str(val);
          else if (target === "native:phone") {
            // ITEM 6 — E.164, the forms' rule, from lib/phone.ts. A number that
            // does not fit is written EXACTLY as it appears in the file and put
            // on the flagged list: an international number may be perfectly
            // correct and a person decides that, not this code.
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

        // Sensible opportunity name if none mapped.
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

        // 🔴 DECIDE FIRST, WRITE SECOND.
        //
        // This used to run `upsertContact` and only THEN read its `isNew` flag
        // to decide whether to "skip" the row. By that point the contact's
        // custom fields had already been overwritten — so a "skipped" duplicate
        // had in fact been modified, silently, on records the importer believed
        // it had left untouched. The existence check now happens BEFORE any
        // write, and "skip" means what it says.
        const existing = await findContactByEmailOrPhone({
          email: contact.email,
          phone: contact.phone,
        });

        if (existing && dupMode === "skip") {
          // Untouched. Nothing written, and the row is reported so the count
          // says what actually happened.
          summary.skipped++;
          continue;
        }

        let contactId = "";

        if (existing) {
          contactId = existing.id;
          // UPDATE fills empty fields and keeps existing values; OVERWRITE
          // replaces them. Both are contact-field writes, so both go through
          // the contact endpoint — and neither creates a second opportunity in
          // the destination pipeline (GHL rejects that with
          // OPPORTUNITY_NO_DUPLICATE, and its message says "create" even on an
          // update, which reads like a bug in this dashboard rather than a
          // rule in theirs).
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

        // The opportunity is created only for a genuinely new person. An
        // existing contact already holds one in this pipeline, and a second is
        // both rejected by GHL and wrong.
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
          // The note still has to land on the person's existing record — that
          // is the whole point of Update: "their Indeed answers ARE recorded".
          // Prefer one in the destination pipeline; otherwise any they hold, so
          // an applicant who exists in a different pipeline still gets the
          // note rather than losing it for being filed elsewhere.
          const held = await listContactOpportunities(contactId);
          oppId =
            held.find((o) => o.pipelineId === pipelineId)?.id ||
            held[0]?.id ||
            "";
        }

        // ONE note per record per import — not one per column. Written after
        // the opportunity exists, and never allowed to fail the row: the
        // records are in, and losing the import over a note would be worse than
        // a missing note.
        if (noteCols.length && oppId) {
          try {
            // 🔴 DEDUPE ON RE-IMPORT. Running the same file twice must not
            // stack two identical notes on one person. The heading is stable
            // for a given source and day and deliberately excludes the batch
            // size and the user, either of which can differ between two runs of
            // the same file.
            //
            // Only checked on a record that ALREADY EXISTED — an opportunity
            // created a moment ago has no notes, and asking would be a wasted
            // call on every new row.
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
