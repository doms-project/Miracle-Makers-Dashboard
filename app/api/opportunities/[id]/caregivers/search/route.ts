import { NextResponse } from "next/server";
import {
  getOpportunityById,
  getSelectedPipelines,
  getClientCaseRows,
  searchCaregiverContacts,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canEditRecord, isAdminSession } from "@/lib/visibility";
import { applyAccess } from "@/lib/pipelineAccess";
import { indexCaseHolders, matchCaseHolders } from "@/lib/peopleSearch";
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
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || "";
    const blob = request.headers.get("x-ghl-sso-key");

    const enforce = ssoConfigured();
    let session: { userId: string; role?: string; type?: string } | null = null;
    const target = await getOpportunityById(id);
    if (!target)
      return NextResponse.json(
        { error: "Opportunity not found." } as ApiError,
        { status: 404 },
      );
    if (enforce) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      const s = decryptSso(blob);
      session = { userId: s.userId, role: s.role, type: s.type };
      if (!canEditRecord(target, session))
        return NextResponse.json(
          { error: "Not permitted.", status: 403 } as ApiError,
          { status: 403 },
        );
    }

    if (!q.trim())
      return NextResponse.json(
        { results: [], role: "caregiver", withheld: 0 },
        { headers: { "Cache-Control": "no-store" } },
      );

    const cgPipes = await getSelectedPipelines("caregiver").catch(() => []);
    const openRecordIsCaregiver = cgPipes.some((p) => p.id === target.pipelineId);

    if (!openRecordIsCaregiver) {

      const cg = await searchCaregiverContacts(q);
      return NextResponse.json(
        {
          results: cg.results,
          role: "caregiver",
          withheld: 0,
          labelsUnavailable: cg.labelsUnavailable,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const rows = await getClientCaseRows();
    const isAdmin = !session || isAdminSession(session.role, session.type);

    const allowed = applyAccess(rows, {
      userId: session?.userId || "",
      isAdmin,
    });
    const all = indexCaseHolders(
      rows.map((r) => ({
        contactId: r.contactId,
        contactName: r.contactName,
        first: r.first,
        last: r.last,
        pipelineName: r.pipelineName,
        stage: r.stage,
        status: r.status,
        createdAt: r.createdAt,
      })),
    );
    const mine = indexCaseHolders(
      allowed.map((r) => ({
        contactId: r.contactId,
        contactName: r.contactName,
        first: r.first,
        last: r.last,
        pipelineName: r.pipelineName,
        stage: r.stage,
        status: r.status,
        createdAt: r.createdAt,
      })),
    );

    const exclude = target.contactId ? [target.contactId] : [];
    const results = matchCaseHolders(mine, q, { exclude });
    const everyone = matchCaseHolders(all, q, { exclude });

    return NextResponse.json(
      {
        results: results.map((p) => ({
          id: p.contactId,
          name: p.name,
          pipelineName: p.pipelineName,
          stage: p.stage,
          more: p.more,
        })),
        role: "client",
        withheld: everyone.length - results.length,
      },
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
        { error: e.message, detail: e.detail } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Search failed.", detail: String(e) } as ApiError,
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
