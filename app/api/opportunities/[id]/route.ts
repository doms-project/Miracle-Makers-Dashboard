import { NextResponse } from "next/server";
import {
  getOpportunityById,
  getEditableFieldDefs,
  updateOpportunity,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession, canEditRecord } from "@/lib/visibility";
import type { ApiError, EditableFieldDef } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PatchBody {
  ssoKey?: string;
  key?: string;
  stageId?: string;
  assignedTo?: string | null;
  status?: string;
  monetaryValue?: number;
  customFields?: { id: string; value: unknown }[];
}

// Coerce a value to GHL's expected write format for the field's dataType.
function formatValue(def: EditableFieldDef, value: unknown): unknown {
  const t = (def.dataType || "").toUpperCase();
  if (t === "MULTIPLE_OPTIONS" || t === "CHECKBOX") {
    if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
    if (value === "" || value == null) return [];
    return [String(value)];
  }
  if (t === "MONETORY" || t === "NUMERICAL" || t === "NUMBER") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return value == null ? "" : String(value);
}

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as PatchBody;
    const blob = body.ssoKey || body.key || null;

    // ---- identity (server-derived; never trust a client-sent userId) ----
    let session: { userId: string; role?: string; type?: string } | null = null;
    const enforce = ssoConfigured();
    if (enforce) {
      if (!blob) {
        const err: ApiError = {
          error: "Sign-in required.",
          detail: "No SSO session was provided.",
          status: 401,
        };
        return NextResponse.json(err, { status: 401 });
      }
      const s = decryptSso(blob); // throws SsoError
      session = { userId: s.userId, role: s.role, type: s.type };
    }

    // ---- load target + re-check visibility (owner/follower or admin) ----
    const target = await getOpportunityById(id);
    if (!target) {
      return NextResponse.json({ error: "Opportunity not found." } as ApiError, {
        status: 404,
      });
    }
    if (enforce && session && !canEditRecord(target, session)) {
      const err: ApiError = {
        error: "Not permitted.",
        detail: "You can only edit records you own or follow.",
        status: 403,
      };
      return NextResponse.json(err, { status: 403 });
    }

    // ---- build the PUT body (strip blocklist, format per dataType) ----
    const defs = await getEditableFieldDefs();
    const defById = new Map(defs.map((d) => [d.id, d]));

    const put: Record<string, unknown> = {};
    if (typeof body.stageId === "string" && body.stageId)
      put.pipelineStageId = body.stageId;
    if ("assignedTo" in body)
      put.assignedTo = body.assignedTo ? body.assignedTo : null;
    if (typeof body.status === "string" && body.status) put.status = body.status;
    if (typeof body.monetaryValue === "number")
      put.monetaryValue = body.monetaryValue;

    const rejected: string[] = [];
    const customFields: { id: string; value: unknown }[] = [];
    for (const cf of body.customFields || []) {
      const def = defById.get(cf.id);
      if (!def) {
        rejected.push(cf.id);
        continue;
      }
      if (!def.editable) {
        // Read-only blocklist — strip server-side even if the UI sent it.
        rejected.push(def.name);
        continue;
      }
      customFields.push({ id: def.id, value: formatValue(def, cf.value) });
    }
    if (customFields.length) put.customFields = customFields;

    if (Object.keys(put).length === 0) {
      const err: ApiError = {
        error: "Nothing to update.",
        detail: rejected.length
          ? `Ignored non-editable/unknown fields: ${rejected.join(", ")}`
          : "No editable fields were provided.",
        status: 400,
      };
      return NextResponse.json(err, { status: 400 });
    }

    // ---- write + return the fresh record ----
    const record = await updateOpportunity(id, put);
    return NextResponse.json(
      { ok: true, record, rejected },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof SsoError) {
      return NextResponse.json(
        { error: "SSO error.", detail: e.message, status: e.status } as ApiError,
        { status: e.status },
      );
    }
    if (e instanceof GhlError) {
      const status = e.status >= 400 && e.status < 600 ? e.status : 502;
      return NextResponse.json(
        { error: e.message, detail: e.detail, status: e.status } as ApiError,
        { status },
      );
    }
    return NextResponse.json(
      {
        error: "Unexpected error saving the opportunity.",
        detail: e instanceof Error ? e.message : String(e),
      } as ApiError,
      { status: 500 },
    );
  }
}
