import { NextResponse } from "next/server";
import {
  getOpportunityById,
  invalidateOpportunity,
  moveOpportunity,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canEditRecord, canManageFollowers, isAdminSession } from "@/lib/visibility";
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
// Resolve the acting user's division for the note stamp, reporting the exact
// reason when it can't be determined. Never throws — a missing stamp must not
// fail a Move.
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
    // ITEM 2 — an ADMIN legitimately has no single division: applyAccess
    // bypasses the map entirely, so most admins have no entry in it at all.
    // Leaving the stamp empty is *correct* but reads as broken — a gap where
    // every other note has a label. "(Admin)" is true, and it distinguishes an
    // admin's action from a rep's, which is worth recording in note history.
    //
    // An admin who IS listed in the access map still gets their real division:
    // grants are checked first, and this is only the fallback.
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
  // Granted, but the ids didn't turn into division labels.
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

    // ITEM 5 — a Move is the most damaging write to lose a race on: it changes
    // pipeline, stage and owner at once, so an overwrite here can move a case
    // out from under whoever just claimed it.
    const conflict = versionGuard(target, body.expectedVersion, "MOVE");
    if (conflict) return conflict;

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

    // The author's division AT WRITE TIME — resolved now and stamped into the
    // note body, never looked up on read (that would rewrite history if the
    // author later changes division).
    //
    // ITEM 2. This resolved to "" with no explanation, and stampDivision then
    // correctly returned the body unprefixed — a silent no-op that looked like a
    // broken stamp. There are FOUR distinct ways it lands empty, and they need
    // different fixes, so each one now says which it is:
    //   a. SSO not configured -> session is null -> no identity at all
    //   b. the actor has no HOME pipelines in the grants map (note: ADMINS are
    //      never required to be in that map — applyAccess bypasses it — so an
    //      admin doing the Move legitimately has no division)
    //   c. their granted pipeline ids don't resolve to names (deleted pipeline,
    //      or an id outside listPipelines())
    //   d. divisionLabel() returned nothing for those names
    const actorDivision = await resolveActorDivision(session);

    // 🔴 EVERYONE WHO CAN SEE THE QUEUE, NOT JUST THE MAPPED USERS.
    //
    // getMasterUsers() returns the `master` array from the access map — the
    // EXPLICITLY granted non-admins. But admins hold the Master view too, via
    // isAdminSession (hasMasterView returns true for them), and they are never
    // in that array. On an admin-only account the array is empty, so a reassign
    // added NOBODY as a follower and the GHL workflow notified nobody — the
    // person watching the queue was the one not told.
    //
    // So the follower list is the SAME set the view itself uses: the mapped
    // users PLUS every admin, read LIVE from GET /users (never a cached list,
    // for the same reason the access map is read live), de-duplicated.
    //
    // A failed users fetch must NOT fail the reassign: fall back to the mapped
    // list and log, rather than leaving a record stuck because we couldn't read
    // roles. The move matters more than a complete follower list.
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
      // ITEM 5b — read LIVE, here, inside withGrants' async context, on every
      // single request. Never cached and never carried over from a previous
      // reassign: that is what makes a user granted the Master view five minutes
      // ago appear in the very next reassign's followers with no backfill.
      // Now the union of mapped holders + admins (see above).
      masterUsers,
    });

    // A partial move is reported as 500 WITH the completed steps, so the caller
    // can finish manually instead of believing the move succeeded.
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

    // 🔴 SAME TRAP AS THE PATCH ROUTE. `target` above cached this record's
    // PRE-MOVE state, and the move completes well inside the 3s burst window —
    // so without this evict, the "fresh record" below would be the record as it
    // was before the transfer, and every caller downstream (the webhook payload
    // included) would be told the move had not happened.
    invalidateOpportunity(id);
    const record = await getOpportunityById(id);

    // ITEM 5 — ONE event for what GoHighLevel sees as several unrelated writes.
    // This is the whole reason outbound webhooks exist rather than GHL triggers:
    // only the dashboard knows these writes were a single transfer, and that
    // knowledge is gone by the time GHL sees them. Fire and forget — emit()
    // never throws, so a webhook failure cannot fail a completed move.
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
      // `actorDivision` is echoed so the stamp can be checked from the response
      // itself — an empty string here is the proof that the prefix was skipped,
      // without having to go and read the server logs.
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
      // explainGhlError turns GHL's id-only pipeline-permission 400 into a
      // named, actionable message; other errors keep their reason.
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


// Grants are loaded once per request so canSeeRecord/canEditRecord see the
// live pipeline-access custom value rather than only the env var.
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => postHandler(request, ctx));
}
