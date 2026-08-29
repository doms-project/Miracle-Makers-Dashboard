import { NextResponse } from "next/server";
import {
  getOpportunityById,
  listCaregiverRelations,
  createCaregiverRelation,
  deleteCaregiverRelation,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canEditRecord } from "@/lib/visibility";
import type { ApiError } from "@/lib/types";
import { withGrants } from "@/lib/withGrants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Session = { userId: string; role?: string; type?: string } | null;

// Resolve the opportunity + re-check visibility (manage caregivers == edit the
// record: own/follow, or admin). Returns the client contactId to operate on.
async function authorize(
  id: string,
  blob: string | null,
): Promise<
  | { ok: true; contactId: string }
  | { ok: false; res: NextResponse }
> {
  let session: Session = null;
  const enforce = ssoConfigured();
  if (enforce) {
    if (!blob)
      return {
        ok: false,
        res: NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        ),
      };
    const s = decryptSso(blob);
    session = { userId: s.userId, role: s.role, type: s.type };
  }
  const target = await getOpportunityById(id);
  if (!target)
    return {
      ok: false,
      res: NextResponse.json({ error: "Opportunity not found." } as ApiError, {
        status: 404,
      }),
    };
  if (enforce && session && !canEditRecord(target, session))
    return {
      ok: false,
      res: NextResponse.json(
        {
          error: "Not permitted.",
          detail: "You can only manage caregivers on records you own or follow.",
          status: 403,
        } as ApiError,
        { status: 403 },
      ),
    };
  if (!target.contactId)
    return {
      ok: false,
      res: NextResponse.json(
        {
          error: "This opportunity has no linked contact.",
          detail: "A client contact is required to associate caregivers.",
        } as ApiError,
        { status: 400 },
      ),
    };
  return { ok: true, contactId: target.contactId };
}

function fail(e: unknown): NextResponse {
  if (e instanceof SsoError)
    return NextResponse.json(
      { error: e.message, status: e.status } as ApiError,
      { status: e.status },
    );
  if (e instanceof GhlError) {
    const status = e.status >= 400 && e.status < 600 ? e.status : 502;
    const detail =
      e.status === 401 || e.status === 403
        ? `${e.detail || ""} (If association calls specifically fail, the PIT may lack access to the Associations/Relations API — this often needs an OAuth app token or an added scope.)`
        : e.detail;
    return NextResponse.json(
      { error: e.message, detail, status: e.status } as ApiError,
      { status },
    );
  }
  return NextResponse.json(
    { error: "Caregiver operation failed.", detail: String(e) } as ApiError,
    { status: 500 },
  );
}

// GET — list the caregivers linked to this opportunity's client contact.
async function getHandler(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const blob = request.headers.get("x-ghl-sso-key");
    const a = await authorize(id, blob);
    if (!a.ok) return a.res;
    const caregivers = await listCaregiverRelations(a.contactId);
    return NextResponse.json(
      { caregivers },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}

// POST { ssoKey?, caregiverContactId } — link an existing caregiver contact.
async function postHandler(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      caregiverContactId?: string;
    };
    const blob = body.ssoKey || request.headers.get("x-ghl-sso-key");
    const a = await authorize(id, blob);
    if (!a.ok) return a.res;
    if (!body.caregiverContactId)
      return NextResponse.json(
        { error: "caregiverContactId is required." } as ApiError,
        { status: 400 },
      );
    const relationId = await createCaregiverRelation(
      a.contactId,
      body.caregiverContactId,
    );
    const caregivers = await listCaregiverRelations(a.contactId);
    return NextResponse.json(
      { ok: true, relationId, caregivers },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}

// DELETE { ssoKey?, relationId } — remove a single caregiver link.
async function deleteHandler(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      relationId?: string;
    };
    const blob = body.ssoKey || request.headers.get("x-ghl-sso-key");
    const a = await authorize(id, blob);
    if (!a.ok) return a.res;
    if (!body.relationId)
      return NextResponse.json(
        { error: "relationId is required." } as ApiError,
        { status: 400 },
      );
    await deleteCaregiverRelation(body.relationId);
    const caregivers = await listCaregiverRelations(a.contactId);
    return NextResponse.json(
      { ok: true, caregivers },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}


// Grants are loaded once per request so canSeeRecord/canEditRecord see the
// live pipeline-access custom value rather than only the env var.
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => getHandler(request, ctx));
}

// Grants are loaded once per request so canSeeRecord/canEditRecord see the
// live pipeline-access custom value rather than only the env var.
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => postHandler(request, ctx));
}

// Grants are loaded once per request so canSeeRecord/canEditRecord see the
// live pipeline-access custom value rather than only the env var.
export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => deleteHandler(request, ctx));
}
