import { NextResponse } from "next/server";
import {
  getOltlOpportunities,
  getPipelineConfig,
  GhlError,
  type PipelineScope,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import {
  applyAccess,
  userDivisions,
  getUserHomePipelines,
  hasMasterView,
} from "@/lib/pipelineAccess";
import { withGrants } from "@/lib/withGrants";
import { peerConfigured, peerLabel } from "@/lib/peer";
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

// ITEM 13 — `scope` selects the pipeline FAMILY. Caregiver applicants are read
// through this same route on purpose: they get the identical access filter,
// version stamping and viewer payload for free, and there is no second code
// path to keep in step. What keeps them separate is the pipeline list itself —
// a caregiver pipeline is not in pipelineIds(), so a client request can never
// return one no matter what the caller asks for.
async function buildResponse(
  blob: string | null,
  scope: PipelineScope = "client",
): Promise<Response> {
  const { records, pipeline, pipelines, stages, stagesByPipeline, users, fieldDefs, failedPipelines } =
    await getOltlOpportunities(scope);
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
  // 🔴 THE STORED FOLDER MAP SHIPS WITH THE FIELD DEFS — same route, same
  // cache. groupFieldsForPipeline is SYNCHRONOUS (it runs inside a useMemo in
  // app/page.tsx), so it cannot fetch this itself: it has to arrive already
  // loaded, beside the defs it groups.
  //
  // ⚠️ NEVER FATAL. If the config read fails the panel falls back to the code
  // map rather than rendering nothing — an unreadable custom value must not
  // take the record panel down with it.
  let pipelineFolders: Record<string, string[]> | undefined;
  let folderNames: Record<string, string> | undefined;
  // 🔴 ITEM Q — the per-pipeline exclusions travel with the folders they modify.
  // Separately fetched, they could arrive a frame later and the panel would draw
  // a field the admin hid.
  let pipelineExclusions: Record<string, string[]> | undefined;
  // 🔴 ITEM 1 — the recruiting group, so the switcher filters at SOURCE.
  let pipelineGroups: Record<string, "caregiver" | "staff"> | undefined;
  try {
    const cfg = await getPipelineConfig();
    pipelineFolders = Object.fromEntries(
      Object.entries(cfg.pipelines).map(([id, e]) => [id, e.folders]),
    );
    folderNames = cfg.folderNames;
    // ⚠️ ONLY THE PIPELINES THAT EXCLUDE SOMETHING. Ten empty arrays on every
    // payload to say "nothing is hidden anywhere" is the common case.
    // ⚠️ ONLY THE PIPELINES EXPLICITLY MARKED "staff". Absent means caregiver
    // (pipelineConfig.ts), so sending every entry would put the default in two
    // places — which is how round 113 and 114 both broke.
    pipelineGroups = Object.fromEntries(
      Object.entries(cfg.pipelines)
        .filter(([, e]) => e.group === "staff")
        .map(([id]) => [id, "staff" as const]),
    );
    pipelineExclusions = Object.fromEntries(
      Object.entries(cfg.pipelines)
        .filter(([, e]) => e.exclude?.length)
        .map(([id, e]) => [id, e.exclude as string[]]),
    );
  } catch {
    pipelineFolders = undefined;
    folderNames = undefined;
    pipelineExclusions = undefined;
    pipelineGroups = undefined;
  }

  const meta = {
    stages,
    users: labelledUsers,
    fieldDefs,
    pipelineFolders,
    pipelineExclusions,
    pipelineGroups,
    folderNames,
    pipelines,
    stagesByPipeline,
    // 🔴 ROUND 132 — IS THERE ANOTHER COMPANY TO TRANSFER TO, AND WHAT IS IT
    // CALLED? A Transfer button that is always shown and always answers "this
    // deployment has no link" is a button that teaches people to ignore
    // buttons. The label ships with it so every sentence on the screen can name
    // the other company rather than saying "the peer".
    //
    // ⚠️ THE FLAG ONLY. `PEER_PIT` is server-side and never leaves the server —
    // this says whether a token is configured, never what it is.
    peer: { configured: peerConfigured(), label: peerLabel() },
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

  // ═══ ROUND 155 — THE PIPELINE NAMES ARE SCOPED AT THE PAYLOAD ═════════════
  //
  // 🔴 THE CLIENT GATE IS A SECOND LINE, NOT THE ONLY ONE. `meta.pipelines` was
  // the full selected list for the account, so a viewer holding no grant
  // received every pipeline NAME whatever the UI then did with them. Task 2 §1
  // settled this shape for `clientPipelines` in the referrals route: the
  // disclosure is closed in the response body, and the proof asserts the name
  // appears nowhere in it.
  //
  // ⚠️ GRANTED **UNION WHAT THEY CAN ALREADY SEE**, not granted alone.
  // applyAccess admits a record you own, follow, or that is unassigned in your
  // home, and the owner/follower arms never consult a grant — so a viewer can
  // hold no grant and still have records here. Sending only granted ids would
  // name no pipeline for records already on their screen, and the Recruiting
  // board (which is per-pipeline) would render nothing at all.
  //
  // 🔴 IT CANNOT WIDEN ANYTHING: every id in the union either is granted, or
  // belongs to a record in `visible` — a record this viewer is already being
  // sent in full.
  const allowedPipelineIds = new Set<string>([
    ...getUserHomePipelines(session.userId),
    ...visible.map((r) => r.pipelineId).filter(Boolean),
  ]);
  const scopedPipelines = admin
    ? pipelines
    : pipelines.filter((p) => allowedPipelineIds.has(p.id));
  // 🔴 THE COUNT SHIPS WITH THE FILTER, IN THE SAME CHANGE — the standing rule,
  // and here it is load-bearing rather than courtesy. `recruitingEmpty` says
  // "N pipelines exist, but none is yours yet" and derived that N from this
  // list; narrowing it without a count would have turned that sentence into
  // "no pipelines are set up yet", which is false and sends an admin to create
  // a pipeline that already exists.
  const pipelinesWithheld = pipelines.length - scopedPipelines.length;
  // ⚠️ THE STAGE MAP TOO. Stage names for a pipeline you cannot see are the
  // same disclosure one level down, and nothing renders stages for a pipeline
  // that is not in the list above.
  const scopedStages = admin
    ? stagesByPipeline
    : Object.fromEntries(
        Object.entries(stagesByPipeline).filter(([id]) => allowedPipelineIds.has(id)),
      );

  const body: OpportunitiesResponse = {
    // 🔴 `...meta` FIRST, AND THE SCOPED VALUES AFTER IT. It carries the
    // UNSCOPED `pipelines` and `stagesByPipeline`, so spreading it last — which
    // is what this did — silently overwrote the narrowing below and made the
    // whole change a no-op that would have shipped green.
    ...meta,
    pipelines: scopedPipelines,
    stagesByPipeline: scopedStages,
    pipelinesWithheld,
    records: visible,
    // Passed through so the UI can name a pipeline whose fetch failed. Without
    // it a half-failed load is indistinguishable from an empty division.
    failedPipelines,
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
    const scope: PipelineScope =
      new URL(request.url).searchParams.get("scope") === "caregiver"
        ? "caregiver"
        : "client";
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
    return await withGrants(() => buildResponse(blob, scope));
  } catch (e) {
    return errorResponse(e);
  }
}

// GET has no blob: serves the open/setup view when SSO isn't configured, and
// returns 401 once SSO is enforced (must be opened inside GHL).
export async function GET(request: Request) {
  try {
    const scope: PipelineScope =
      new URL(request.url).searchParams.get("scope") === "caregiver"
        ? "caregiver"
        : "client";
    return await withGrants(() => buildResponse(null, scope));
  } catch (e) {
    return errorResponse(e);
  }
}
