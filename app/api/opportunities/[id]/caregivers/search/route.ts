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

// ═══════════════════════════════════════════════════════════════════════════
// Typeahead for the add-link picker. Same visibility gate as managing the
// record (own/follow, or admin).
//
// 🔴 ROUND 171 — THE SIDE IS DECIDED BY THE PIPELINE, NOT BY THE SEARCH.
//
// This route filtered to Record Type = "Caregiver" unconditionally, so on a
// CAREGIVER's record the heading read "Clients" and the picker offered
// caregivers. Round 170 found it and left it, because the value identifying a
// client was unprobed; the probe came back saying there is no such value (see
// getClientCaseRows), so a client is found by holding a client case.
//
// ⚠️ THE SAME TEST THE WRITE USES, DELIBERATELY. The POST on the parent route
// decides which contact goes in which slot by asking whether this record's
// pipeline is caregiver-scoped. If the picker answered that question a second
// way the two could disagree, and a picker that offers the wrong side feeds a
// correctly-ordered write with the wrong person — which reads as the slot bug
// all over again.
// ═══════════════════════════════════════════════════════════════════════════
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
      const results = await searchCaregiverContacts(q);
      return NextResponse.json(
        { results, role: "caregiver", withheld: 0 },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    // ── the open record is a CAREGIVER, so the other side is a CLIENT ───────
    const rows = await getClientCaseRows();
    const isAdmin = !session || isAdminSession(session.role, session.type);
    // 🔴 THE STANDING RULE: A ROUTE THAT STARTS FILTERING A LIST OWES ITS
    // CONSUMERS A COUNT. A recruiter editing a caregiver may hold no client
    // pipeline at all, and the names of every client on the account are not
    // theirs to read merely because this picker exists. The count travels so
    // the picker can say "none you can see" rather than "none".
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
    // 🔴 NEVER THE CAREGIVER THEMSELVES. Linking a record to its own contact
    // is two clicks and GoHighLevel refuses none of it.
    const exclude = target.contactId ? [target.contactId] : [];
    const results = matchCaseHolders(mine, q, { exclude });
    const everyone = matchCaseHolders(all, q, { exclude });

    return NextResponse.json(
      {
        results: results.map((p) => ({
          id: p.contactId,
          name: p.name,
          email: "",
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


// Grants are loaded once per request so canSeeRecord/canEditRecord see the
// live pipeline-access custom value rather than only the env var.
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return withGrants(() => getHandler(request, ctx));
}
