import { NextResponse } from "next/server";
import { getOpportunityById, moveOpportunity, GhlError } from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canEditRecord, canManageFollowers } from "@/lib/visibility";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// POST { ssoKey?, toPipelineId, toStageId?, newOwnerId?, reason?,
//        addSenderAsFollower? }
//
// ONE permission check at entry, then moveOpportunity() drives every sub-write
// directly in lib. It deliberately does NOT go through the per-record PATCH /
// followers routes: those re-evaluate permission against MUTATED state (after
// the owner changes, the person performing the move would 403 on their own
// operation), and PATCH strips the read-only Transferred From/Date fields that
// a transfer must stamp.
//
// Entry gate:
//   simple move (owner unchanged) -> canEditRecord (own/follow/admin/home-unassigned)
//   transfer    (owner changed)   -> owner or admin only; a follower must not be
//                                    able to hand someone else's case away.
export async function POST(
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

    const isTransfer =
      typeof body.newOwnerId === "string" &&
      (body.newOwnerId || "") !== (target.ownerId || "");

    if (enforce && session) {
      const allowed = isTransfer
        ? canManageFollowers(target, session) // owner or admin
        : canEditRecord(target, session);
      if (!allowed)
        return NextResponse.json(
          {
            error: "Not permitted.",
            detail: isTransfer
              ? "Only the record owner or an admin can transfer a record to a new owner."
              : "You can only move records you own or follow.",
            status: 403,
          } as ApiError,
          { status: 403 },
        );
    }

    const result = await moveOpportunity({
      oppId: id,
      toPipelineId: body.toPipelineId,
      toStageId: body.toStageId,
      newOwnerId: body.newOwnerId ?? undefined,
      reason: body.reason,
      actorUserId: session?.userId || "",
      addSenderAsFollower: !!body.addSenderAsFollower,
    });

    // A partial move is reported as 500 WITH the completed steps, so the caller
    // can finish manually instead of believing the move succeeded.
    if (result.failedStep)
      return NextResponse.json(
        {
          error: `Move stopped at "${result.failedStep}".`,
          detail: `Completed: ${result.steps.join(" → ") || "nothing"}. ${result.error ?? ""}`,
          status: 500,
        } as ApiError,
        { status: 500 },
      );

    const record = await getOpportunityById(id);
    return NextResponse.json(
      { ok: true, ...result, record },
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
        { error: e.message, detail: e.detail } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Move failed.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}
