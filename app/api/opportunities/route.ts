import { NextResponse } from "next/server";
import {
  getOltlOpportunities,
  getPipelineConfig,
  firstOpenedFieldId,
  GhlError,
  type PipelineScope,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import { isNewLead, newLeadSince } from "@/lib/newLead";
import {
  applyAccess,
  userDivisions,
  getUserHomePipelines,
  hasMasterView,
  staffingLevel,
  canUsePeerTransfer,
} from "@/lib/pipelineAccess";
import { withGrants } from "@/lib/withGrants";
import { peerConfigured, peerLabel } from "@/lib/peer";
import type { OpportunitiesResponse, ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function buildResponse(
  blob: string | null,
  scope: PipelineScope = "client",
): Promise<Response> {
  const { records, pipeline, pipelines, stages, stagesByPipeline, users, fieldDefs, failedPipelines } =
    await getOltlOpportunities(scope);

  let newLeads: { tracking: boolean; since: string } | undefined;
  {
    const since = newLeadSince();
    let fieldId: string | null = null;
    try {
      fieldId = await firstOpenedFieldId();
    } catch {
      fieldId = null;
    }
    const tracking = !!fieldId;

    for (const r of records) {
      if (fieldId) {
        const raw = r.cf[fieldId];
        const v = Array.isArray(raw) ? String(raw[0] ?? "") : String(raw ?? "");
        if (v.trim()) r.firstOpened = v;
      }
      r.newLead = tracking && isNewLead(r, since);
    }
    newLeads = { tracking, since };
  }

  const pipelineNameById = new Map(pipelines.map((p) => [p.id, p.name]));
  const labelledUsers = users.map((u) => ({
    ...u,
    divisions: userDivisions(u.id, pipelineNameById),

    pipelineIds: [...getUserHomePipelines(u.id)],
  }));

  let pipelineFolders: Record<string, string[]> | undefined;
  let folderNames: Record<string, string> | undefined;

  let pipelineExclusions: Record<string, string[]> | undefined;

  let pipelineGroups: Record<string, "caregiver" | "staff"> | undefined;

  let pipelineSidebarHidden: Record<string, true> | undefined;
  let tabLabels: Record<string, string> | undefined;
  try {
    const cfg = await getPipelineConfig();
    tabLabels = cfg.labels || {};
    pipelineFolders = Object.fromEntries(
      Object.entries(cfg.pipelines).map(([id, e]) => [id, e.folders]),
    );
    folderNames = cfg.folderNames;

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

    pipelineSidebarHidden = Object.fromEntries(
      Object.entries(cfg.pipelines)
        .filter(([, e]) => e.sidebar === false)
        .map(([id]) => [id, true as const]),
    );
  } catch {
    pipelineFolders = undefined;
    folderNames = undefined;
    pipelineExclusions = undefined;
    pipelineGroups = undefined;
    pipelineSidebarHidden = undefined;
    tabLabels = undefined;
  }

  const meta = {
    newLeads,
    stages,
    users: labelledUsers,
    fieldDefs,
    pipelineFolders,
    pipelineExclusions,
    pipelineGroups,
    pipelineSidebarHidden,
    folderNames,
    pipelines,
    stagesByPipeline,

    peer: { configured: peerConfigured(), label: peerLabel() },
    tabLabels,
  };

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

        homePipelineIds: pipelines.map((p) => p.id),
        canSeeMaster: true,
        staffing: "admin",
        canPeerTransfer: true,
      },
      ...meta,
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  }

  if (!blob) {
    const err: ApiError = {
      error: "Sign-in required.",
      detail:
        "Open this dashboard inside GoHighLevel — no SSO session was provided.",
      status: 401,
    };
    return NextResponse.json(err, { status: 401 });
  }

  const session = decryptSso(blob);
  const admin = isAdminSession(session.role, session.type);

  const visible = applyAccess(
    records,
    { userId: session.userId, isAdmin: admin },
    { staffingGate: scope === "client" },
  );

  const allowedPipelineIds = new Set<string>([
    ...getUserHomePipelines(session.userId),
    ...visible.map((r) => r.pipelineId).filter(Boolean),
  ]);
  const scopedPipelines = admin
    ? pipelines
    : pipelines.filter((p) => allowedPipelineIds.has(p.id));

  const pipelinesWithheld = pipelines.length - scopedPipelines.length;

  const scopedStages = admin
    ? stagesByPipeline
    : Object.fromEntries(
        Object.entries(stagesByPipeline).filter(([id]) => allowedPipelineIds.has(id)),
      );

  const homeNow = getUserHomePipelines(session.userId);
  const sortTargets =
    scope === "client" && (admin || homeNow.size)
      ? pipelines.map((p) => ({ id: p.id, name: p.name }))
      : [];
  const body: OpportunitiesResponse = {

    ...meta,
    sortTargets,
    pipelines: scopedPipelines,
    stagesByPipeline: scopedStages,
    pipelinesWithheld,
    records: visible,

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

      homePipelineIds: admin
        ? pipelines.map((p) => p.id)
        : [...getUserHomePipelines(session.userId)],

      canSeeMaster: hasMasterView(session.userId, admin),
      staffing: staffingLevel(session.userId, admin),
      canPeerTransfer: canUsePeerTransfer(session.userId, admin),
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
