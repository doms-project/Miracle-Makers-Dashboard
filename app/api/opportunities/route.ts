import { NextResponse } from "next/server";
import { getOltlOpportunities, GhlError } from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import type {
  OpportunitiesResponse,
  ApiError,
  OpportunityRecord,
} from "@/lib/types";

// Always dynamic; the GHL token and SSO secret are only ever read server-side.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// PHASE 3 visibility rule — ASSIGNMENT ONLY.
// A restricted (non-admin) user sees an opportunity if and only if they OWN it
// (assignedTo === userId) OR they are a FOLLOWER (co-rep) of it. Followers MUST
// be included — an owner-only filter would wrongly hide co-repped cases.
// Office is NOT a permission gate; it is only a UI dimension.
// Consequence (intended): an unassigned opportunity is visible to NO restricted
// user — only admins see it. Do not "fix" this; it is the defined behavior.
function visibleTo(
  records: OpportunityRecord[],
  userId: string,
): OpportunityRecord[] {
  return records.filter(
    (o) => o.ownerId === userId || o.followerIds.includes(userId),
  );
}

async function buildResponse(blob: string | null): Promise<Response> {
  const { records, pipeline, stages, users, fieldDefs } =
    await getOltlOpportunities();
  const meta = { stages, users, fieldDefs };

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
  const visible = admin ? records : visibleTo(records, session.userId);

  const body: OpportunitiesResponse = {
    records: visible,
    pipeline,
    count: visible.length,
    viewer: {
      authenticated: true,
      isAdmin: admin,
      userName: session.userName ?? null,
      role: session.role ?? null,
      total: records.length,
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
    return await buildResponse(blob);
  } catch (e) {
    return errorResponse(e);
  }
}

// GET has no blob: serves the open/setup view when SSO isn't configured, and
// returns 401 once SSO is enforced (must be opened inside GHL).
export async function GET() {
  try {
    return await buildResponse(null);
  } catch (e) {
    return errorResponse(e);
  }
}
