import { NextResponse } from "next/server";
import {
  listLocationUsers,
  listPipelines,
  fetchPipelineAccessGrants,
  savePipelineAccessGrants,
  pipelineIds,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Admin-only, enforced SERVER-SIDE (not merely hidden in the UI).
function gate(request: Request, ssoKey?: string): NextResponse | null {
  if (!ssoConfigured()) return null;
  const blob = ssoKey || request.headers.get("x-ghl-sso-key");
  if (!blob)
    return NextResponse.json(
      { error: "Sign-in required.", status: 401 } as ApiError,
      { status: 401 },
    );
  const s = decryptSso(blob);
  if (!isAdminSession(s.role, s.type))
    return NextResponse.json(
      { error: "Admin only.", status: 403 } as ApiError,
      { status: 403 },
    );
  return null;
}

function fail(e: unknown): Promise<NextResponse> | NextResponse {
  if (e instanceof SsoError)
    return NextResponse.json(
      { error: e.message, status: e.status } as ApiError,
      { status: e.status },
    );
  if (e instanceof GhlError)
    return explainGhlError(e).then((detail) =>
      NextResponse.json({ error: "Request failed.", detail } as ApiError, {
        status: e.status >= 400 && e.status < 600 ? e.status : 502,
      }),
    );
  return NextResponse.json(
    { error: "Request failed.", detail: String(e) } as ApiError,
    { status: 500 },
  );
}

// GET — everything the grid needs, all fetched LIVE:
//   users     from GHL (new staff appear automatically)
//   pipelines from GHL — ALL of them, each flagged whether the dashboard
//             actually loads it, so granting access to a pipeline outside
//             PIPELINE_IDS is visible rather than silently inert
//   grants    from the custom value (null => the env fallback is in play)
export async function GET(request: Request) {
  try {
    const denied = gate(request);
    if (denied) return denied;

    const [users, pipelines, stored] = await Promise.all([
      listLocationUsers(),
      listPipelines(),
      fetchPipelineAccessGrants(),
    ]);
    const loaded = new Set(pipelineIds());

    return NextResponse.json(
      {
        users,
        pipelines: pipelines.map((p) => ({
          id: p.id,
          name: p.name,
          // false => the dashboard doesn't fetch this pipeline yet; add it to
          // PIPELINE_IDS for grants here to have any effect.
          inDashboard: loaded.has(p.id),
        })),
        grants: stored ?? {},
        // true => nothing readable is stored yet, so the env var is what's
        // actually in force until the first save.
        usingEnvFallback: stored === null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}

// PUT { ssoKey?, grants } — writes the whole map as one JSON custom value.
export async function PUT(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      grants?: Record<string, string[]>;
    };
    const denied = gate(request, body.ssoKey);
    if (denied) return denied;

    const g = body.grants;
    if (!g || typeof g !== "object" || Array.isArray(g))
      return NextResponse.json(
        { error: "grants must be an object of userId -> pipelineId[]." } as ApiError,
        { status: 400 },
      );

    // Normalize: drop empty selections so the stored map stays readable, and
    // coerce everything to strings.
    const clean: Record<string, string[]> = {};
    for (const [userId, pids] of Object.entries(g)) {
      if (!userId || !Array.isArray(pids)) continue;
      const list = [...new Set(pids.map(String).filter(Boolean))];
      if (list.length) clean[userId] = list;
    }

    const { id } = await savePipelineAccessGrants(clean);
    return NextResponse.json(
      { ok: true, id, grants: clean },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}
