import { NextResponse } from "next/server";
import {
  getOpportunityById,
  getSelectedPipelines,
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
  | { ok: true; contactId: string; pipelineId: string }
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
  // ⚠️ ROUND 170 — THE PIPELINE TRAVELS WITH THE CONTACT. The POST has to know
  // whether the record it is called on is a CLIENT or a CAREGIVER, and the
  // pipeline is the server's own answer to that — see the note at the write.
  return { ok: true, contactId: target.contactId, pipelineId: target.pipelineId };
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
    // ═══ 🔴 ROUND 170 — WHICH SIDE AM I ON? ══════════════════════════════
    //
    // This passed `(a.contactId, body.caregiverContactId)` into a function whose
    // first parameter was called `clientContactId` — true on a client's panel
    // and false on a caregiver's, where the open record IS the caregiver. The
    // live result: an applicant linked from the CLIENT's panel stored the
    // client in the caregiver slot, and /api/relations/counts answered
    // `{"caregivers":0,"clients":1}` for that client.
    //
    // 🔴 DECIDED FROM THE PIPELINE, NOT FROM A ROLE THE CLIENT SENDS. The
    // browser knows which side it is on (`selfRole` in CaregiversSection, "by
    // WHICH PAYLOAD the record came from") — but a role posted by a browser is
    // a claim, and getting it wrong writes a reversed link that nobody notices
    // for forty rounds. The pipeline's recruiting group is the server's own
    // answer and cannot be spoofed.
    //
    // ⚠️ AND IT IS `recruitingGroup`, WHICH HAD NO CALLERS UNTIL NOW. It was
    // written in round 113/114 as the one place the caregiver/staff default
    // lives, precisely so a rule each consumer remembers cannot drift.
    const cgPipes = await getSelectedPipelines("caregiver").catch(() => []);
    const openRecordIsCaregiver = cgPipes.some((p) => p.id === a.pipelineId);
    const relationId = await createCaregiverRelation(
      openRecordIsCaregiver
        ? // The open record is the CAREGIVER, so the picked contact is the client.
          { caregiverContactId: a.contactId, clientContactId: body.caregiverContactId }
        : // The ordinary case: a client's panel, picking their caregiver.
          { clientContactId: a.contactId, caregiverContactId: body.caregiverContactId },
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
