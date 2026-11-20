import { NextResponse } from "next/server";
import {
  getOpportunityById,
  invalidateOpportunity,
  moveOpportunity,
  sortOpportunity,
  stampSortedFromNewLeads,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canEditRecord, canManageFollowers, isAdminSession, viewerFor } from "@/lib/visibility";
import { canSort, canAssignStaffing, isNewLeadStage, isStaffingStage } from "@/lib/sorting";
import {
  userDivisions,
  getUserHomePipelines,
  getMasterUsers,
} from "@/lib/pipelineAccess";
import { listPipelines, listLocationUsers } from "@/lib/ghl";
import type { ApiError } from "@/lib/types";
import { withGrants } from "@/lib/withGrants";
import { emit } from "@/lib/webhooks";
import { versionGuard } from "@/lib/concurrency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

async function resolveActorDivision(
  session: { userId: string; role?: string; type?: string } | null,
): Promise<string> {
  if (!session?.userId) {
    // eslint-disable-next-line no-console
    console.warn(
      "[move:division] no SSO session (GHL_SSO_SECRET unset, or no blob sent) — the note will have no [DIVISION] prefix and no author.",
    );
    return "";
  }
  let pipelineNameById: Map<string, string>;
  try {
    pipelineNameById = new Map(
      (await listPipelines()).map((p) => [p.id, p.name]),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      "[move:division] pipelines could not be listed, so home pipelines can't be named:",
      e instanceof Error ? e.message : String(e),
    );
    return "";
  }

  const home = getUserHomePipelines(session.userId);
  const divisions = userDivisions(session.userId, pipelineNameById);
  if (divisions.length) return divisions.join(" · ");

  if (!home.size) {

    if (isAdminSession(session.role, session.type)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[move:division] user ${session.userId} is an admin with no entry in the access map — stamping "Admin". Add them in the Pipeline Access tab if their notes should read a real division instead.`,
      );
      return "Admin";
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[move:division] user ${session.userId} (role "${session.role ?? "—"}") has NO home pipelines in the effective grants — add them in the Pipeline Access tab, or to PIPELINE_ACCESS_MAP. See the [grants] line above for what was loaded.`,
    );
    return "";
  }

  // eslint-disable-next-line no-console
  console.warn(
    `[move:division] user ${session.userId} is granted ${[...home].join(", ")}, but none resolved to a division label. Known pipelines: ${[...pipelineNameById.entries()].map(([id, n]) => `${id}=${n}`).join(", ")}.`,
  );
  return "";
}

async function postHandler(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      toPipelineId?: string;
      toStageId?: string;
      newOwnerId?: string | null;
      reason?: string;
      addSenderAsFollower?: boolean;
      expectedVersion?: string;

      mode?: "sort" | "assign";
    };
    const blob = body.ssoKey || request.headers.get("x-ghl-sso-key");

    let session: { userId: string; role?: string; type?: string } | null = null;
    const enforce = ssoConfigured();
    if (enforce) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      const s = decryptSso(blob);
      session = { userId: s.userId, role: s.role, type: s.type };
    }

    if (!body.toPipelineId)
      return NextResponse.json(
        { error: "Pick a destination pipeline." } as ApiError,
        { status: 400 },
      );

    const target = await getOpportunityById(id);
    if (!target)
      return NextResponse.json({ error: "Opportunity not found." } as ApiError, {
        status: 404,
      });

    const conflict = versionGuard(target, body.expectedVersion, "MOVE");
    if (conflict) return conflict;

    if (body.mode === "sort" || body.mode === "assign") {
      if (enforce && session) {
        const v = viewerFor(session);
        const verdict =
          body.mode === "sort"
            ? canSort(target, v, {
                toPipelineId: body.toPipelineId,
                newOwnerId: typeof body.newOwnerId === "string" ? body.newOwnerId : undefined,
              })
            : canAssignStaffing(target, v, typeof body.newOwnerId === "string" ? body.newOwnerId : "");
        if (!verdict.ok)
          return NextResponse.json(
            { error: "Not permitted.", detail: verdict.why, refusal: true, status: 403 } as ApiError,
            { status: 403 },
          );
      }
      const actorDivisionSort = await resolveActorDivision(session);
      const result = await sortOpportunity({
        mode: body.mode,
        oppId: id,
        toPipelineId: body.toPipelineId,
        toStageId: body.toStageId || undefined,
        newOwnerId: typeof body.newOwnerId === "string" ? body.newOwnerId : undefined,
        reason: body.reason,
        actorUserId: session?.userId || "",
        actorDivision: actorDivisionSort,
      });
      invalidateOpportunity(id);
      const record = await getOpportunityById(id);
      await emit(
        "opportunity.moved",
        { actor: { userId: session?.userId || "", name: undefined }, opportunityId: id, contactId: target.contactId },
        {
          transferred: false,
          mode: body.mode,
          fromPipelineId: target.pipelineId,
          fromPipelineName: target.pipelineName,
          toPipelineId: body.toPipelineId,
          fromStage: target.stage,
          toStage: record?.stage ?? "",
          fromOwnerId: target.ownerId,
          toOwnerId: record?.ownerId ?? target.ownerId,
          reason: body.reason ?? "",
          actorDivision: actorDivisionSort,
          steps: result.steps,
        },
      );
      if ((record?.ownerId ?? "") !== (target.ownerId || ""))
        await emit(
          "opportunity.assigned",
          { actor: { userId: session?.userId || "" }, opportunityId: id, contactId: target.contactId },
          { oldOwnerId: target.ownerId, newOwnerId: record?.ownerId ?? "" },
        );
      return NextResponse.json(
        { ok: true, ...result, actorDivision: actorDivisionSort, record },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    if (body.toStageId && !isNewLeadStage(target.stage)) {
      const destPipe = (await listPipelines()).find((p) => p.id === body.toPipelineId);
      const destStageName = destPipe?.stages?.find((st) => st.id === body.toStageId)?.name || "";
      if (isNewLeadStage(destStageName))
        return NextResponse.json(
          {
            error: "New lead can't be chosen.",
            detail: "New lead is where leads arrive. Pick the stage the case is really at.",
            refusal: true,
            status: 400,
          } as ApiError,
          { status: 400 },
        );
    }

    const ownerChanged =
      typeof body.newOwnerId === "string" &&
      (body.newOwnerId || "") !== (target.ownerId || "");

    if (enforce && session) {
      const allowed = ownerChanged
        ? canManageFollowers(target, session)
        : canEditRecord(target, session);
      if (!allowed)
        return NextResponse.json(
          {
            error: "Not permitted.",
            detail: ownerChanged
              ? "Only the record owner or an admin can transfer a record to a new owner."
              : "You can only move records you own or follow.",
            status: 403,
          } as ApiError,
          { status: 403 },
        );
    }

    const actorDivision = await resolveActorDivision(session);

    let adminIds: string[] = [];
    try {
      adminIds = (await listLocationUsers())
        .filter((u) => isAdminSession(u.role))
        .map((u) => u.id);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(
        "[reassign] could not read location users to add admins as followers — proceeding with the mapped master-view holders only:",
        e,
      );
    }
    const masterUsers = [...new Set([...getMasterUsers(), ...adminIds])];

    const result = await moveOpportunity({
      oppId: id,
      toPipelineId: body.toPipelineId,
      toStageId: body.toStageId,
      newOwnerId: body.newOwnerId ?? undefined,
      reason: body.reason,
      actorUserId: session?.userId || "",
      actorDivision,
      addSenderAsFollower: !!body.addSenderAsFollower,

      masterUsers,
    });

    if (result.failedStep) {
      const parts = [
        `Completed: ${result.steps.join(" → ") || "nothing"}.`,
      ];
      if (result.stranded)
        parts.push(
          "⚠️ THIS RECORD IS STRANDED: the owner has already changed and followers were cleared, but it is STILL IN THE SOURCE PIPELINE. The new owner will only see it as 'shared' and the previous owner cannot see it at all — nobody will find it by browsing. Move it to the destination pipeline in GoHighLevel now, or re-run this Move (the owner change is already done, so it will be treated as a simple move).",
        );
      if (result.attemptedFollowerRemovals?.length)
        parts.push(
          `Follower removals attempted (verify in GHL; any still attached keep shared access): ${result.attemptedFollowerRemovals.join(", ")}.`,
        );
      if (result.error) parts.push(result.error);
      return NextResponse.json(
        {
          error: result.stranded
            ? "Move incomplete — record stranded in the source pipeline."
            : `Move stopped at "${result.failedStep}".`,
          detail: parts.join(" "),
          status: 500,
        } as ApiError,
        { status: 500 },
      );
    }

    invalidateOpportunity(id);
    let record = await getOpportunityById(id);

    if (isNewLeadStage(target.stage) && record && isStaffingStage(record.stage)) {
      result.steps.push(`stats: ${await stampSortedFromNewLeads(id, "staffing", record.pipelineId, session?.userId || "")}`);
      record = (await getOpportunityById(id)) ?? record;
    }

    await emit(
      "opportunity.moved",
      {
        actor: { userId: session?.userId || "", name: undefined },
        opportunityId: id,
        contactId: target.contactId,
      },
      {
        transferred: !!result.transferred,
        fromPipelineId: target.pipelineId,
        fromPipelineName: target.pipelineName,
        toPipelineId: body.toPipelineId,
        fromStage: target.stage,
        toStage: record?.stage ?? "",
        fromOwnerId: target.ownerId,
        toOwnerId: record?.ownerId ?? target.ownerId,
        reason: body.reason ?? "",
        actorDivision,
        steps: result.steps,
      },
    );
    if (result.transferred && (record?.ownerId ?? "") !== target.ownerId)
      await emit(
        "opportunity.assigned",
        {
          actor: { userId: session?.userId || "" },
          opportunityId: id,
          contactId: target.contactId,
        },
        { oldOwnerId: target.ownerId, newOwnerId: record?.ownerId ?? "" },
      );

    return NextResponse.json(

      { ok: true, ...result, actorDivision, record },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json(
        { error: e.message, status: e.status } as ApiError,
        { status: e.status },
      );
    if (e instanceof GhlError)

      return NextResponse.json(
        { error: "Move failed.", detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Move failed.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => postHandler(request, ctx));
}
