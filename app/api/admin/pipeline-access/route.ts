import { NextResponse } from "next/server";
import {
  listLocationUsers,
  listPipelines,
  fetchAccessGrantsV2,
  saveAccessGrantsV2,
  listMediaFolders,
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

    // ITEM 6b — folders are a SECOND grid in this tab, from the same custom
    // value under its own key. Fetched here so the admin grants pipelines,
    // folders and the Master view in one place and one save.
    const [users, pipelines, stored, folders] = await Promise.all([
      listLocationUsers(),
      listPipelines(),
      fetchAccessGrantsV2(),
      listMediaFolders().catch(() => []),
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
        // Folders read LIVE from GHL — a folder created in GHL appears here
        // with no code change, same as users and pipelines.
        folders,
        grants: stored?.pipelines ?? {},
        folderGrants: stored?.folders ?? {},
        masterUsers: stored?.master ?? [],
        publicFolderId: (process.env.RESOURCES_PUBLIC_FOLDER_ID || "").trim(),
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
      folderGrants?: Record<string, string[]>;
      masterUsers?: string[];
    };
    const denied = gate(request, body.ssoKey);
    if (denied) return denied;

    // Each scope is OPTIONAL and saved independently. saveAccessGrantsV2 merges
    // against what is stored, so a request carrying only `folderGrants` cannot
    // wipe every pipeline grant on the account — which a naive whole-object
    // write would do the first time the folders grid saves on its own.
    const norm = (
      g: Record<string, string[]> | undefined,
    ): Record<string, string[]> | undefined => {
      if (g === undefined) return undefined;
      if (!g || typeof g !== "object" || Array.isArray(g)) return undefined;
      const clean: Record<string, string[]> = {};
      for (const [userId, ids] of Object.entries(g)) {
        if (!userId || !Array.isArray(ids)) continue;
        const list = [...new Set(ids.map(String).filter(Boolean))];
        if (list.length) clean[userId] = list; // drop empties; keeps it readable
      }
      return clean;
    };

    const pipelinesPatch = norm(body.grants);
    const foldersPatch = norm(body.folderGrants);
    const masterPatch = Array.isArray(body.masterUsers)
      ? [...new Set(body.masterUsers.map(String).filter(Boolean))]
      : undefined;

    if (!pipelinesPatch && !foldersPatch && !masterPatch)
      return NextResponse.json(
        {
          error: "Nothing to save.",
          detail:
            "Send `grants` (userId -> pipelineId[]), `folderGrants` (userId -> folderId[]) or `masterUsers` (userId[]).",
        } as ApiError,
        { status: 400 },
      );

    const { id } = await saveAccessGrantsV2({
      ...(pipelinesPatch ? { pipelines: pipelinesPatch } : {}),
      ...(foldersPatch ? { folders: foldersPatch } : {}),
      ...(masterPatch ? { master: masterPatch } : {}),
    });
    // Echo the MERGED state, not just what was sent — the caller needs to see
    // what is actually stored now, including the scopes it didn't touch.
    const saved = await fetchAccessGrantsV2();
    return NextResponse.json(
      {
        ok: true,
        id,
        grants: saved?.pipelines ?? {},
        folderGrants: saved?.folders ?? {},
        masterUsers: saved?.master ?? [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}
