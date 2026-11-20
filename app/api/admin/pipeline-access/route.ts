import { NextResponse } from "next/server";
import { peerConfigured, peerLabel } from "@/lib/peer";
import {
  listLocationUsers,
  listPipelines,
  fetchAccessGrantsV2,
  saveAccessGrantsV2,
  asStaffing,
  listMediaFolders,
  getPipelineConfig,
  getEditableFieldDefs,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { PARTNER_FIELDS } from "@/lib/referrals";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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

export async function GET(request: Request) {
  try {
    const denied = gate(request);
    if (denied) return denied;

    let foldersError: string | null = null;
    const [users, pipelines, stored, folders] = await Promise.all([
      listLocationUsers(),
      listPipelines(),
      fetchAccessGrantsV2(),
      listMediaFolders().catch(async (e) => {
        foldersError =
          e instanceof GhlError ? await explainGhlError(e) : String(e);
        // eslint-disable-next-line no-console
        console.error("[access] the media-folder list failed:", foldersError);
        return [];
      }),
    ]);

    const cfg = await getPipelineConfig();
    const entryOf = (id: string) => cfg.pipelines[id];
    const loadedReason = (id: string): string => {
      const e = entryOf(id);
      if (!e)
        return "It has no entry on the Pipelines screen, so nothing fetches it and a grant here has no effect.";
      if (e.scope === "none" && e.role !== "events")
        return "Its scope is “listed by no board picker” and it carries no role, so nothing fetches its records.";
      return "";
    };
    const loaded = new Set(
      pipelines.filter((p) => !loadedReason(p.id)).map((p) => p.id),
    );

    return NextResponse.json(
      {
        users,
        pipelines: pipelines.map((p) => ({
          id: p.id,
          name: p.name,

          inDashboard: loaded.has(p.id),

          notLoadedWhy: loadedReason(p.id) || undefined,
        })),

        divisionOptions: await (async () => {
          const defs = await getEditableFieldDefs("contact");
          const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
          const def = defs.find((d) => n(d.name) === n(PARTNER_FIELDS.division.name));
          return def?.options?.length ? [...def.options] : [];
        })(),

        folders,

        foldersError,
        grants: stored?.pipelines ?? {},
        folderGrants: stored?.folders ?? {},
        masterUsers: stored?.master ?? [],

        caseManagers: stored?.caseManagers ?? {},
        referralAccess: stored?.referralAccess ?? {},

        staffing: stored?.staffing ?? {},
        peerTransfer: stored?.peerTransfer ?? [],
        peer: { configured: peerConfigured(), label: peerLabel() },
        publicFolderId: (process.env.RESOURCES_PUBLIC_FOLDER_ID || "").trim(),

        usingEnvFallback: stored === null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      grants?: Record<string, string[]>;
      folderGrants?: Record<string, string[]>;
      masterUsers?: string[];

      caseManagers?: Record<string, string[]>;

      referralAccess?: Record<string, unknown>;

      staffing?: Record<string, unknown>;

      peerTransfer?: string[];
    };
    const denied = gate(request, body.ssoKey);
    if (denied) return denied;

    const norm = (
      g: Record<string, string[]> | undefined,
    ): Record<string, string[]> | undefined => {
      if (g === undefined) return undefined;
      if (!g || typeof g !== "object" || Array.isArray(g)) return undefined;
      const clean: Record<string, string[]> = {};
      for (const [userId, ids] of Object.entries(g)) {
        if (!userId || !Array.isArray(ids)) continue;
        const list = [...new Set(ids.map(String).filter(Boolean))];
        if (list.length) clean[userId] = list;
      }
      return clean;
    };

    const normReferral = (
      g: Record<string, unknown> | undefined,
    ): Record<string, { mode: "agency" } | { mode: "divisions"; divisions: string[] }> | undefined => {
      if (g === undefined) return undefined;
      if (!g || typeof g !== "object" || Array.isArray(g)) return undefined;
      const clean: Record<string, { mode: "agency" } | { mode: "divisions"; divisions: string[] }> = {};
      for (const [userId, raw] of Object.entries(g)) {
        if (!userId || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const e = raw as Record<string, unknown>;
        if (e.mode === "agency") clean[userId] = { mode: "agency" };
        else if (e.mode === "divisions")
          clean[userId] = {
            mode: "divisions",

            divisions: Array.isArray(e.divisions)
              ? [...new Set(e.divisions.map(String).filter(Boolean))]
              : [],
          };
      }
      return clean;
    };

    const referralAccessPatch = normReferral(body.referralAccess);
    const caseManagersPatch = norm(body.caseManagers);
    const pipelinesPatch = norm(body.grants);
    const foldersPatch = norm(body.folderGrants);
    const masterPatch = Array.isArray(body.masterUsers)
      ? [...new Set(body.masterUsers.map(String).filter(Boolean))]
      : undefined;

    const staffingPatch = body.staffing === undefined ? undefined : asStaffing(body.staffing);
    const peerPatch = Array.isArray(body.peerTransfer)
      ? [...new Set(body.peerTransfer.map(String).filter(Boolean))]
      : undefined;

    if (
      !pipelinesPatch && !foldersPatch && !masterPatch && !caseManagersPatch &&
      !referralAccessPatch && !staffingPatch && !peerPatch
    )
      return NextResponse.json(
        {
          error: "Nothing to save.",
          detail:
            "Send `grants` (userId -> pipelineId[]), `folderGrants` (userId -> folderId[]), `masterUsers` (userId[]) or `caseManagers` (repId -> managerId[]).",
        } as ApiError,
        { status: 400 },
      );

    const { id } = await saveAccessGrantsV2({
      ...(pipelinesPatch ? { pipelines: pipelinesPatch } : {}),
      ...(foldersPatch ? { folders: foldersPatch } : {}),
      ...(masterPatch ? { master: masterPatch } : {}),
      ...(caseManagersPatch ? { caseManagers: caseManagersPatch } : {}),
      ...(referralAccessPatch ? { referralAccess: referralAccessPatch } : {}),
      ...(staffingPatch ? { staffing: staffingPatch } : {}),
      ...(peerPatch ? { peerTransfer: peerPatch } : {}),
    });

    const saved = await fetchAccessGrantsV2();
    return NextResponse.json(
      {
        ok: true,
        id,
        grants: saved?.pipelines ?? {},
        folderGrants: saved?.folders ?? {},
        masterUsers: saved?.master ?? [],
        caseManagers: saved?.caseManagers ?? {},
        referralAccess: saved?.referralAccess ?? {},
        staffing: saved?.staffing ?? {},
        peerTransfer: saved?.peerTransfer ?? [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}
