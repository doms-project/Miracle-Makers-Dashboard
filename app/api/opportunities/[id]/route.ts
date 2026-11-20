import { NextResponse } from "next/server";
import {
  getOpportunityById,
  getReassignFollowers,
  clearReassignFollowers,
  removeOpportunityFollowers,
  REASSIGN_STAGE_NAME,
  getEditableFieldDefs,
  updateOpportunity,
  deleteOpportunity,
  explainGhlError,
  toGhlDate,
  GhlError,
  listPipelines,
} from "@/lib/ghl";
import { isNewLeadStage } from "@/lib/sorting";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession, canEditRecord, canChangeOwner } from "@/lib/visibility";
import type { ApiError, EditableFieldDef } from "@/lib/types";
import { withGrants } from "@/lib/withGrants";
import { emit } from "@/lib/webhooks";
import { versionGuard } from "@/lib/concurrency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PatchBody {
  ssoKey?: string;
  key?: string;

  name?: string;
  stageId?: string;
  assignedTo?: string | null;
  status?: string;
  monetaryValue?: number;
  customFields?: { id: string; value: unknown }[];

  expectedVersion?: string;
}

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

  if (t === "DATE") {
    if (value == null || String(value).trim() === "") return "";
    return toGhlDate(value);
  }
  return value == null ? "" : String(value);
}

async function patchHandler(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as PatchBody;
    const blob = body.ssoKey || body.key || null;

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
      const s = decryptSso(blob);
      session = { userId: s.userId, role: s.role, type: s.type };
    }

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

    const conflict = versionGuard(target, body.expectedVersion, "PATCH");
    if (conflict) return conflict;

    if (
      enforce &&
      session &&
      "assignedTo" in body &&
      (body.assignedTo || "") !== (target.ownerId || "") &&
      !canChangeOwner(target, session, body.assignedTo || "")
    ) {
      return NextResponse.json(
        {
          error: "Not permitted.",
          detail:
            "Only the record owner or an admin can change who owns a case. You can still edit its fields.",
          status: 403,
        } as ApiError,
        { status: 403 },
      );
    }

    const defs = await getEditableFieldDefs();
    const defById = new Map(defs.map((d) => [d.id, d]));

    const put: Record<string, unknown> = {};

    const renamedTo =
      typeof body.name === "string" ? body.name.trim().slice(0, 200) : null;
    if (renamedTo !== null && !renamedTo)
      return NextResponse.json(
        {
          error: "A case needs a name.",
          detail: "Type a name for this record. Nothing has been changed.",
          refusal: true,
          status: 400,
        } as ApiError,
        { status: 400 },
      );
    if (renamedTo) put.name = renamedTo;
    if (typeof body.stageId === "string" && body.stageId)
      put.pipelineStageId = body.stageId;

    if (
      typeof body.stageId === "string" &&
      body.stageId &&
      body.stageId !== target.stageId &&
      !isNewLeadStage(target.stage)
    ) {
      const dest = (await listPipelines()).find((p) => p.id === target.pipelineId);
      const name = dest?.stages?.find((st) => st.id === body.stageId)?.name || "";
      if (isNewLeadStage(name))
        return NextResponse.json(
          {
            error: "New lead can't be chosen.",
            detail: "New lead is where leads arrive. Pick the stage the case is really at. Nothing has been changed.",
            refusal: true,
            status: 400,
          } as ApiError,
          { status: 400 },
        );
    }
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

    const record = await updateOpportunity(id, put);

    if (renamedTo && record && (record.oppName || "") !== renamedTo)
      return NextResponse.json(
        {
          error: "GoHighLevel accepted the rename but did not store it.",
          detail: `Sent “${renamedTo}”, read back “${record.oppName || "(nothing)"}”. The name has been left as it was on screen; change it in GoHighLevel.`,
          status: 502,
        } as ApiError,
        { status: 502 },
      );

    const wasReassign =
      (target.stage || "").trim().toUpperCase() === REASSIGN_STAGE_NAME;
    const nowOwned = !!(record?.ownerId || target.ownerId);
    const nowRealStage =
      !!record &&
      (record.stage || "").trim().toUpperCase() !== REASSIGN_STAGE_NAME;

    const ownerJustSet = "assignedTo" in body && !!body.assignedTo && !target.ownerId;
    if (wasReassign && nowOwned && (nowRealStage || ownerJustSet)) {
      try {

        const added = await getReassignFollowers(target);
        if (!added.length) {
          // eslint-disable-next-line no-console
          console.warn(
            `[claim] ${id} left ${REASSIGN_STAGE_NAME} but "Reassign Followers" is empty or absent — removing NOTHING. Any dashboard-added followers stay until removed by hand, which is the safe direction.`,
          );
        } else {

          const owner = record?.ownerId || "";
          const toRemove = added.filter((u) => u && u !== owner);
          if (toRemove.length) await removeOpportunityFollowers(id, toRemove);
          await clearReassignFollowers(id);
          // eslint-disable-next-line no-console
          console.log(
            `[claim] ${id} claimed by ${owner || "(none)"} — removed ${toRemove.length} dashboard-added follower(s): ${toRemove.join(", ")}`,
          );
        }
      } catch (e) {

        // eslint-disable-next-line no-console
        console.error(`[claim] follower cleanup failed for ${id}:`, e);
      }
    }

    for (const cf of customFields) {
      const def = defById.get(cf.id);
      await emit(
        "field.changed",
        {
          actor: { userId: session?.userId || "" },
          opportunityId: id,
          contactId: target.contactId,
        },
        {
          fieldId: cf.id,
          field: def?.name ?? cf.id,
          from: target.cf[cf.id] ?? null,
          to: cf.value,
        },
      );
    }
    if (renamedTo && renamedTo !== (target.oppName || ""))
      await emit(
        "field.changed",
        {
          actor: { userId: session?.userId || "" },
          opportunityId: id,
          contactId: target.contactId,
        },
        { field: "Name", from: target.oppName, to: renamedTo },
      );
    if (typeof body.stageId === "string" && body.stageId && body.stageId !== target.stageId)
      await emit(
        "field.changed",
        {
          actor: { userId: session?.userId || "" },
          opportunityId: id,
          contactId: target.contactId,
        },
        { field: "Stage", from: target.stage, to: record?.stage ?? "" },
      );
    if ("assignedTo" in body && (body.assignedTo || "") !== target.ownerId)
      await emit(
        "opportunity.assigned",
        {
          actor: { userId: session?.userId || "" },
          opportunityId: id,
          contactId: target.contactId,
        },
        { oldOwnerId: target.ownerId, newOwnerId: body.assignedTo || "" },
      );

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
        {
          error: "Couldn't save.",
          detail: await explainGhlError(e),
          status: e.status,
        } as ApiError,
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

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => patchHandler(request, ctx));
}

async function deleteHandler(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as { ssoKey?: string; key?: string };
    const blob = body.ssoKey || body.key || null;

    let session: { userId: string; role?: string; type?: string } | null = null;
    const enforce = ssoConfigured();
    if (enforce) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", detail: "No SSO session was provided.", status: 401 } as ApiError,
          { status: 401 },
        );
      const s = decryptSso(blob);
      session = { userId: s.userId, role: s.role, type: s.type };
      if (!isAdminSession(session.role, session.type))
        return NextResponse.json(
          {
            error: "Only an admin can delete a record.",
            detail:
              "Mark it lost with a reason instead — a lost lead with a reason tells you why leads fail; a deleted one tells you nothing.",
            refusal: true,
            status: 403,
          } as ApiError,
          { status: 403 },
        );
    }

    const target = await getOpportunityById(id);
    if (!target)
      return NextResponse.json(
        {
          error: "That record no longer exists.",
          detail: "It may already have been deleted. Refresh to see the current list.",
          status: 404,
        } as ApiError,
        { status: 404 },
      );

    const label = target.oppName || `${target.first} ${target.last}`.trim() || "the record";
    await deleteOpportunity(id);

    void emit(
      "opportunity.deleted",
      { actor: { userId: session?.userId || "" }, opportunityId: id, contactId: target.contactId || "" },
      { name: label, pipelineId: target.pipelineId, pipelineName: target.pipelineName || "" },
    );
    return NextResponse.json({
      ok: true,
      id,
      name: label,
      pipelineName: target.pipelineName || "",
      contactId: target.contactId || "",
    });
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json({ error: e.message, status: 401 } as ApiError, { status: 401 });
    if (e instanceof GhlError)
      return NextResponse.json(
        { error: await explainGhlError(e), detail: e.detail, status: e.status } as ApiError,
        { status: e.status >= 400 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Delete failed.", status: 500 } as ApiError,
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => deleteHandler(request, ctx));
}
