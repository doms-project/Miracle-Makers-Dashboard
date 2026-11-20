import { NextResponse } from "next/server";
import {
  getOpportunityById,
  listContactOpportunities,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canSeeRecord } from "@/lib/visibility";
import type { ApiError } from "@/lib/types";
import { withGrants } from "@/lib/withGrants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function getHandler(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await ctx.params;
    const blob =
      request.headers.get("x-ghl-sso-key") ||
      new URL(request.url).searchParams.get("ssoKey");

    let session: { userId: string; role?: string; type?: string } | null = null;
    if (ssoConfigured()) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      const s = decryptSso(blob);
      session = { userId: s.userId, role: s.role, type: s.type };
    }

    const target = await getOpportunityById(id);
    if (!target)
      return NextResponse.json({ error: "Opportunity not found." } as ApiError, {
        status: 404,
      });
    if (session && !canSeeRecord(target, session))
      return NextResponse.json(
        { error: "Not permitted.", status: 403 } as ApiError,
        { status: 403 },
      );

    if (!target.contactId)
      return NextResponse.json(
        { ok: true, conflicts: [] },
        { headers: { "Cache-Control": "no-store" } },
      );

    const all = await listContactOpportunities(target.contactId);

    const conflicts = all
      .filter((o) => o.id !== id && o.pipelineId)
      .map((o) => ({
        opportunityId: o.id,
        name: o.name,
        pipelineId: o.pipelineId,
        pipelineName: o.pipelineName,
        stage: o.stage,
        status: o.status,
      }));

    return NextResponse.json(
      { ok: true, conflicts },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json(
        { error: e.message, status: e.status } as ApiError,
        { status: e.status },
      );
    if (e instanceof GhlError)
      return NextResponse.json(
        { error: "Could not check for existing cases.", detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Could not check for existing cases.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => getHandler(request, ctx));
}
