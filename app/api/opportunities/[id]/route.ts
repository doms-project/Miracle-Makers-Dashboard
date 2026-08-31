import { NextResponse } from "next/server";
import {
  getOpportunityById,
  getReassignFollowers,
  clearReassignFollowers,
  removeOpportunityFollowers,
  REASSIGN_STAGE_NAME,
  getEditableFieldDefs,
  updateOpportunity,
  explainGhlError,
  toGhlDate,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession, canEditRecord, canChangeOwner } from "@/lib/visibility";
import type { ApiError, EditableFieldDef } from "@/lib/types";
import { withGrants } from "@/lib/withGrants";
import { emit } from "@/lib/webhooks";

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
  // ITEM 1 — DATE had NO branch here, so it fell through to String(value) and a
  // date field was written with whatever `<input type="date">` produces:
  // "2026-08-28". A bare date is not the shape proven to store; a full ISO 8601
  // string is. Without this, every DATE field in the panel — all ten Milestones
  // included — writes a value GoHighLevel can drop, with a 200 and no error.
  // An empty string is passed through unchanged so a date can still be CLEARED.
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

    // ITEM 14 — a follower may edit FIELDS but not the OWNER. Enforced HERE,
    // server-side: hiding the dropdown is convenience, and this would hold
    // against a direct PATCH.
    if (
      enforce &&
      session &&
      "assignedTo" in body &&
      (body.assignedTo || "") !== (target.ownerId || "") &&
      !canChangeOwner(target, session)
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

    // ---- ITEM 5c: THE CLAIM -------------------------------------------------
    // A record LEAVES the reassign queue the moment it has an owner and a real
    // stage. That is the whole mechanism — no new state, no tag to clear — so
    // the claim is detected here rather than being a separate action somebody
    // has to remember to take.
    const wasReassign =
      (target.stage || "").trim().toUpperCase() === REASSIGN_STAGE_NAME;
    const nowOwned = !!(record?.ownerId || target.ownerId);
    const nowRealStage =
      !!record &&
      (record.stage || "").trim().toUpperCase() !== REASSIGN_STAGE_NAME;
    // ⚠️ SETTING AN OWNER FROM THE RECORD PANEL IS ALSO A CLAIM.
    //
    // This used to require a real stage as well, so a rep who opened a
    // reassigned card and simply assigned it to themselves left every
    // dashboard-added follower attached — a second path that skipped the
    // cleanup entirely. Either signal now counts: somebody has taken the case.
    const ownerJustSet = "assignedTo" in body && !!body.assignedTo && !target.ownerId;
    if (wasReassign && nowOwned && (nowRealStage || ownerJustSet)) {
      try {
        // 🔴 THE LIST COMES FROM THE FIELD, AND ONLY FROM THE FIELD.
        // `target` is the PRE-write read, so the field still holds what the
        // reassign stored. If it is empty or the field is missing we remove
        // NOTHING and say so: inferring the list from the current followers or
        // from the access map would strip somebody who was following this
        // record long before any reassign — the exact failure this guards.
        const added = await getReassignFollowers(target);
        if (!added.length) {
          // eslint-disable-next-line no-console
          console.warn(
            `[claim] ${id} left ${REASSIGN_STAGE_NAME} but "Reassign Followers" is empty or absent — removing NOTHING. Any dashboard-added followers stay until removed by hand, which is the safe direction.`,
          );
        } else {
          // Never remove the new owner, even if they were on the added list —
          // they are the claimer and belong on the record.
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
        // The claim itself SUCCEEDED — the owner and stage are written. Failing
        // the request now would tell the rep their save didn't work when it did.
        // eslint-disable-next-line no-console
        console.error(`[claim] follower cleanup failed for ${id}:`, e);
      }
    }

    // One event per FIELD, with its name and both values — a consumer shouldn't
    // have to diff two record snapshots to learn what changed. `target` is the
    // pre-write read, so the old values are genuinely old.
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
      // Surface GHL's own reason (e.g. the pipeline-permission 400 on an owner
      // change), resolved to real names rather than raw ids.
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


// Grants are loaded once per request so canSeeRecord/canEditRecord see the
// live pipeline-access custom value rather than only the env var.
export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => patchHandler(request, ctx));
}
