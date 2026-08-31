import { NextResponse } from "next/server";
import { getOltlOpportunities, GhlError } from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import {
  applyAccess,
  userDivisions,
  getUserHomePipelines,
  hasMasterView,
} from "@/lib/pipelineAccess";
import { withGrants } from "@/lib/withGrants";
import type { OpportunitiesResponse, ApiError } from "@/lib/types";

// Always dynamic; the GHL token and SSO secret are only ever read server-side.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// v2 visibility — division scoping (see lib/pipelineAccess.applyAccess):
//   admin                                          -> all
//   home pipeline AND (owner OR follower OR unassigned) -> theirs (shared=false)
//   ANY pipeline  AND (owner OR follower)               -> shared = true
//   otherwise                                           -> excluded
// The unassigned branch is HOME-ONLY on purpose — an unassigned record in
// another division must never surface.

async function buildResponse(blob: string | null): Promise<Response> {
  const { records, pipeline, pipelines, stages, stagesByPipeline, users, fieldDefs } =
    await getOltlOpportunities();
  // Label every user with their division(s) for the owner/follower pickers.
  const pipelineNameById = new Map(pipelines.map((p) => [p.id, p.name]));
  const labelledUsers = users.map((u) => ({
    ...u,
    divisions: userDivisions(u.id, pipelineNameById),
    // ITEM 1 — the PIPELINE IDS this user actually holds.
    //
    // `divisions` is a DIVISION label ("OLTL"), which is lossy: it cannot tell
    // OLTL Enrollment from OLTL Transfer, so an owner-access warning built on it
    // stayed silent for exactly the case that matters — someone who holds one
    // pipeline of a division being made owner in the other. Ids are exact and
    // need no string matching at all.
    pipelineIds: [...getUserHomePipelines(u.id)],
  }));
  const meta = {
    stages,
    users: labelledUsers,
    fieldDefs,
    pipelines,
    stagesByPipeline,
  };

  // SSO is enforced only once a Shared Secret is configured. Before that
  // (initial setup / local dev without GHL_SSO_SECRET) the route runs "open"
  // so the dashboard is usable; the UI still shows it as an unauthenticated view.
  if (!ssoConfigured()) {
    const body: OpportunitiesResponse = {
      records,
      pipeline,
      count: records.length,
      viewer: {
        authenticated: false,
        isAdmin: true,
        userName: null,
        role: null,
        total: records.length,
        // Open/setup mode behaves like an admin: every selected pipeline is home.
        homePipelineIds: pipelines.map((p) => p.id),
        canSeeMaster: true,
      },
      ...meta,
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  }

  // SSO configured → a valid session is required. The identity is derived from
  // the encrypted blob server-side; a client-sent userId is never trusted.
  if (!blob) {
    const err: ApiError = {
      error: "Sign-in required.",
      detail:
        "Open this dashboard inside GoHighLevel — no SSO session was provided.",
      status: 401,
    };
    return NextResponse.json(err, { status: 401 });
  }

  const session = decryptSso(blob); // throws SsoError on bad secret/blob
  const admin = isAdminSession(session.role, session.type);
  // Division scoping + per-viewer `shared` tagging.
  const visible = applyAccess(records, { userId: session.userId, isAdmin: admin });

  const body: OpportunitiesResponse = {
    records: visible,
    pipeline,
    count: visible.length,
    viewer: {
      authenticated: true,
      isAdmin: admin,
      userName: session.userName ?? null,
      role: session.role ?? null,
      type: session.type ?? null,
      total: records.length,
      // Admins treat every selected pipeline as home; others get their mapped set.
      homePipelineIds: admin
        ? pipelines.map((p) => p.id)
        : [...getUserHomePipelines(session.userId)],
      // ITEM 4 — the Master view is a GRANT, not a role. It shows the records
      // this viewer can ALREADY see, laid out by pipeline, so granting it can
      // never widen access — only how it is presented. That is also what solves
      // the carve-out cleanly: someone sees reassigned-out records because they
      // were GRANTED the view, not through an exception in the access rule.
      canSeeMaster: hasMasterView(session.userId, admin),
    },
    ...meta,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

function errorResponse(e: unknown): Response {
  if (e instanceof SsoError) {
    const body: ApiError = { error: "SSO error.", detail: e.message, status: e.status };
    return NextResponse.json(body, { status: e.status });
  }
  if (e instanceof GhlError) {
    const body: ApiError = { error: e.message, detail: e.detail, status: e.status };
    const status = e.status >= 400 && e.status < 600 ? e.status : 502;
    return NextResponse.json(body, { status });
  }
  const body: ApiError = {
    error: "Unexpected server error while loading opportunities.",
    detail: e instanceof Error ? e.message : String(e),
  };
  return NextResponse.json(body, { status: 500 });
}

// Primary path: the client POSTs its encrypted SSO blob so the server can
// re-derive identity and filter before any data leaves the server.
export async function POST(request: Request) {
  try {
    let blob: string | null = null;
    try {
      const b = (await request.json()) as Record<string, unknown>;
      blob =
        (typeof b?.ssoKey === "string" && b.ssoKey) ||
        (typeof b?.key === "string" && b.key) ||
        null;
    } catch {
      blob = null;
    }
    return await withGrants(() => buildResponse(blob));
  } catch (e) {
    return errorResponse(e);
  }
}

// GET has no blob: serves the open/setup view when SSO isn't configured, and
// returns 401 once SSO is enforced (must be opened inside GHL).
export async function GET() {
  try {
    return await withGrants(() => buildResponse(null));
  } catch (e) {
    return errorResponse(e);
  }
}
