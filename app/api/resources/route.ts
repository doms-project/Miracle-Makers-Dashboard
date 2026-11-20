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
      const s = decryptSso(blob);
      session = { userId: s.userId, role: s.role, type: s.type };
    }
    const isAdmin = !session || isAdminSession(session.role, session.type);
    const publicFolderId = (process.env.RESOURCES_PUBLIC_FOLDER_ID || "").trim();

    const all = (await listMediaFolders()).filter((f) => !isReservedFolder(f.name));
    const granted = session ? getUserFolders(session.userId) : new Set<string>();
    const visible = all.filter(
      (f) => isAdmin || granted.has(f.id) || (publicFolderId && f.id === publicFolderId),
    );

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

    let legacy: ResourceFile[] = [];
    if (!sections.length && RESOURCES_FOLDER_ID) {
      try {
        legacy = await listResources();
      } catch {

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

export async function GET(request: Request) {
  return withGrants(() => getHandler(request));
}
