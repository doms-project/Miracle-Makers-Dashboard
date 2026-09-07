import { NextResponse } from "next/server";
import { isReservedFolder } from "@/lib/fieldFolders";
import {
  listResources,
  listMediaFolders,
  listFolderFiles,
  RESOURCES_FOLDER_ID,
  GhlError,
} from "@/lib/ghl";
import { isAdminSession } from "@/lib/visibility";
import { getUserFolders } from "@/lib/pipelineAccess";
import { withGrants } from "@/lib/withGrants";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import type { ApiError, ResourceFile } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Resources are not case-specific — available to ALL authenticated users
// (reps + onboarding + admin), no per-record filtering. But a valid SSO session
// is still required (don't leave it open) once SSO is configured. The list is
// always fetched fresh so the signed-URL TTL is handled at display time.
// ITEM 6c — SECTIONS PER VISIBLE FOLDER, not one shared folder.
//
// Which folders a viewer sees comes from the FOLDER grants in the access custom
// value — their own scope, not derived from pipeline access, because a
// compliance folder may belong to case managers who hold no pipeline at all.
//
// ⭐ One folder can be marked visible to EVERYONE (RESOURCES_PUBLIC_FOLDER_ID).
// A MARKED folder, not a magic name: matching on a name like "Company Policies"
// would silently change what the whole company can see the moment someone
// renames a folder in GHL.
//
// 🔴 ORGANISATION, NOT SECURITY. This decides what people SEE listed.
//
// CORRECTED: an earlier note here said GHL media URLs were "publicly reachable
// once known". They are not — they are Google Cloud Storage links, SIGNED and
// TIME-LIMITED, tested and confirmed to expire. The file persists; only the
// link does not, and GHL mints a fresh one when it serves the file. The old
// wording was wrong and had knock-on effects: it is why the per-applicant
// document upload feature was deferred.
async function getHandler(request: Request) {
  try {
    let session: { userId: string; role?: string; type?: string } | null = null;
    if (ssoConfigured()) {
      const blob = request.headers.get("x-ghl-sso-key");
      if (!blob) {
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      }
      const s = decryptSso(blob); // throws SsoError on bad/absent secret/blob
      session = { userId: s.userId, role: s.role, type: s.type };
    }
    const isAdmin = !session || isAdminSession(session.role, session.type);
    const publicFolderId = (process.env.RESOURCES_PUBLIC_FOLDER_ID || "").trim();

    const all = (await listMediaFolders()).filter((f) => !isReservedFolder(f.name));
    const granted = session ? getUserFolders(session.userId) : new Set<string>();
    const visible = all.filter(
      (f) => isAdmin || granted.has(f.id) || (publicFolderId && f.id === publicFolderId),
    );

    // Load each visible folder's files in parallel; one failing folder must not
    // empty the whole tab.
    const sections = await Promise.all(
      visible.map(async (f) => {
        try {
          return {
            ...f,
            isPublic: !!publicFolderId && f.id === publicFolderId,
            files: await listFolderFiles(f.id),
          };
        } catch {
          return { ...f, isPublic: false, files: [], failed: true };
        }
      }),
    );

    // The legacy single-folder env path still works when no folders are granted
    // and RESOURCES_FOLDER_ID is set, so this deploy cannot empty the tab for
    // anyone who was seeing files before the grants existed.
    let legacy: ResourceFile[] = [];
    if (!sections.length && RESOURCES_FOLDER_ID) {
      try {
        legacy = await listResources();
      } catch {
        /* the sections answer is what matters */
      }
    }

    return NextResponse.json(
      {
        sections,
        resources: legacy,
        folderId: RESOURCES_FOLDER_ID,
        count: sections.reduce((n, s2) => n + s2.files.length, legacy.length),
        canManageFolders: isAdmin,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json(
        { error: "SSO error.", detail: e.message, status: e.status } as ApiError,
        { status: e.status },
      );
    if (e instanceof GhlError) {
      const status = e.status >= 400 && e.status < 600 ? e.status : 502;
      const detail =
        e.status === 401
          ? `${e.detail || ""} (If media specifically fails, the PIT may be missing the medias/media scope — add it to the Private Integration.)`
          : e.detail;
      return NextResponse.json(
        { error: e.message, detail, status: e.status } as ApiError,
        { status },
      );
    }
    return NextResponse.json(
      { error: "Unexpected error loading resources.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}

// Grants are loaded once per request so getUserFolders() sees the live custom
// value rather than nothing.
export async function GET(request: Request) {
  return withGrants(() => getHandler(request));
}
