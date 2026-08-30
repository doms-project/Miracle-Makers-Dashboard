import { NextResponse } from "next/server";
import {
  listMediaFolders,
  createMediaFolder,
  deleteMediaFolder,
  countFilesInFolder,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ITEM 6a — resource folders. CREATE and DELETE are ADMIN ONLY, enforced HERE.
// Hiding the buttons is convenience; this is the boundary, and it would hold
// against a direct POST.
function adminGate(
  request: Request,
  ssoKey?: string,
): { ok: true } | { ok: false; res: NextResponse } {
  if (!ssoConfigured()) return { ok: true };
  const blob = ssoKey || request.headers.get("x-ghl-sso-key");
  if (!blob)
    return {
      ok: false,
      res: NextResponse.json(
        { error: "Sign-in required.", status: 401 } as ApiError,
        { status: 401 },
      ),
    };
  const s = decryptSso(blob);
  if (!isAdminSession(s.role, s.type))
    return {
      ok: false,
      res: NextResponse.json(
        {
          error: "Admin only.",
          detail: "Only an admin can create or delete resource folders.",
          status: 403,
        } as ApiError,
        { status: 403 },
      ),
    };
  return { ok: true };
}

function fail(e: unknown): Promise<NextResponse> | NextResponse {
  if (e instanceof SsoError)
    return NextResponse.json(
      { error: e.message, status: e.status } as ApiError,
      { status: e.status },
    );
  if (e instanceof GhlError)
    return explainGhlError(e).then((detail) =>
      NextResponse.json({ error: "Folder operation failed.", detail } as ApiError, {
        status: e.status >= 400 && e.status < 600 ? e.status : 502,
      }),
    );
  return NextResponse.json(
    { error: "Folder operation failed.", detail: String(e) } as ApiError,
    { status: 500 },
  );
}

// GET — every folder in the location, read LIVE. Any signed-in user may list
// them; what they can SEE in the tab is decided by the folder grants, and the
// admin grid needs the full list to grant against.
export async function GET(request: Request) {
  try {
    if (ssoConfigured()) {
      const blob = request.headers.get("x-ghl-sso-key");
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      decryptSso(blob);
    }
    const folders = await listMediaFolders();
    return NextResponse.json(
      { ok: true, folders },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}

// POST { ssoKey?, name } — create.
//
// ⚠️ GHL AUTO-RENAMES ON COLLISION: asking for "OLTL" when one exists yields
// "OLTL (1)" with NO error. The response reports the name GHL ACTUALLY assigned
// and a `renamed` flag, so the UI can say so instead of showing a folder the
// admin didn't think they made.
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      name?: string;
    };
    const gate = adminGate(request, body.ssoKey);
    if (!gate.ok) return gate.res;

    const name = (body.name || "").trim();
    if (!name)
      return NextResponse.json(
        { error: "Give the folder a name.", status: 400 } as ApiError,
        { status: 400 },
      );

    const created = await createMediaFolder(name);
    return NextResponse.json(
      { ok: true, folder: created },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}

// DELETE ?id=… [&confirm=1]
//
// 🔴 DELETING A FOLDER REMOVES ITS CONTENTS. Without `confirm=1` this returns
// the FILE COUNT and deletes nothing, so the UI can name the number in its
// confirmation. The count is taken server-side: a client-supplied one could be
// stale or simply wrong, and this is a destructive, irreversible call.
export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const gate = adminGate(request, url.searchParams.get("ssoKey") || undefined);
    if (!gate.ok) return gate.res;

    const id = (url.searchParams.get("id") || "").trim();
    if (!id)
      return NextResponse.json(
        { error: "Which folder?", status: 400 } as ApiError,
        { status: 400 },
      );

    const fileCount = await countFilesInFolder(id);
    if (url.searchParams.get("confirm") !== "1")
      return NextResponse.json(
        { ok: true, deleted: false, fileCount },
        { headers: { "Cache-Control": "no-store" } },
      );

    await deleteMediaFolder(id);
    // eslint-disable-next-line no-console
    console.warn(`[resources] folder ${id} deleted with ${fileCount} file(s).`);
    return NextResponse.json(
      { ok: true, deleted: true, fileCount },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}
