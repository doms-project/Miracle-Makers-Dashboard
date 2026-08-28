import { NextResponse } from "next/server";
import {
  upsertContact,
  createOpportunity,
  getEditableFieldDefs,
  toGhlDate,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import type { ImportSummary, ApiError, EditableFieldDef } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60; // allow time for a chunk of rows

// Target keys the mapping can use.
//   native:firstName | native:lastName | native:name | native:email |
//   native:phone | native:oppName | cf:<fieldId>
type Row = Record<string, unknown>;
interface ImportBody {
  ssoKey?: string;
  pipelineId?: string;
  stageId?: string;
  source?: string;
  mapping?: Record<string, string>; // column -> target key
  rows?: Row[];
  rowOffset?: number; // for correct 1-based row numbers across chunks
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

    const { pipelineId, stageId, source, mapping, rows } = body;
    if (!pipelineId || !stageId)
      return NextResponse.json({ error: "Pick a pipeline and stage." } as ApiError, { status: 400 });
    if (!mapping || !Array.isArray(rows))
      return NextResponse.json({ error: "Missing mapping or rows." } as ApiError, { status: 400 });
    if (rows.length > 50)
      return NextResponse.json({ error: "Chunk too large (max 50 rows/request)." } as ApiError, { status: 400 });

    const defs = await getEditableFieldDefs();
    const defById = new Map(defs.map((d) => [d.id, d]));
    const offset = typeof body.rowOffset === "number" ? body.rowOffset : 0;

    const summary: ImportSummary = { created: 0, skipped: 0, failed: 0, errors: [] };

    // Sequential — respects GHL rate limits and keeps per-row errors clean.
    for (let i = 0; i < rows.length; i++) {
      const rowNo = offset + i + 1;
      const row = rows[i];
      try {
        // Build contact + opportunity fields from the mapping.
        const contact: Parameters<typeof upsertContact>[0] = { source };
        const cfEntries: { id: string; value: unknown }[] = [];
        let oppName = "";

        for (const [col, target] of Object.entries(mapping)) {
          if (!target) continue;
          const val = row[col];
          if (val == null || val === "") continue;
          if (target.startsWith("cf:")) {
            const def = defById.get(target.slice(3));
            if (def) cfEntries.push({ id: def.id, value: formatValue(def, val) });
          } else if (target === "native:firstName") contact.firstName = str(val);
          else if (target === "native:lastName") contact.lastName = str(val);
          else if (target === "native:name") contact.name = str(val);
          else if (target === "native:email") contact.email = str(val);
          else if (target === "native:phone") contact.phone = str(val);
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

        const { id: contactId, isNew } = await upsertContact({
          ...contact,
          customFields: cfEntries, // contact keeps a copy where field ids overlap; harmless otherwise
        });
        if (!contactId) {
          summary.failed++;
          summary.errors.push({ row: rowNo, error: "Contact upsert returned no id." });
          continue;
        }
        if (!isNew) {
          // Deduped — existing contact, skip creating a new opportunity.
          summary.skipped++;
          continue;
        }

        await createOpportunity({
          pipelineId,
          stageId,
          contactId,
          name: oppName,
          source,
          customFields: cfEntries,
        });
        summary.created++;
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
