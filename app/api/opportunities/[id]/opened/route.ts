import { NextResponse } from "next/server";
import {
  getOpportunityById,
  markFirstOpened,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { canSeeRecord } from "@/lib/visibility";
import { withGrants } from "@/lib/withGrants";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 🔴 ROUND 181 — POST: "this person just opened this case."
 *
 * Writes the "First Opened" field ONCE per case (lib/ghl.ts markFirstOpened),
 * which ends the "New lead" label for everybody. Called by the record panel
 * the moment it opens a case that is still a new lead.
 *
 * ⚠️ THE OPENER IS THE SIGNED-IN PERSON, from the SSO blob — never a userId the
 * browser sends. And they must be able to SEE the case (canSeeRecord, the same
 * rule as the panel itself): a rep cannot clear another division's label by
 * posting an id they were never shown.
 *
 * ⚠️ "Nothing to do" is 200 with recorded:false — no field on the account, or
 * somebody opened it first. Only a refusal or a GoHighLevel failure is an error.
 */
async function handler(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: Record<string, unknown> = {};
  try { body = (await request.json()) as Record<string, unknown>; } catch { /* no body */ }
  const blob =
    request.headers.get("x-ghl-sso-key") ||
    (typeof body.ssoKey === "string" ? body.ssoKey : "") ||
    "";

  let userId = "open-mode";
  if (ssoConfigured()) {
    if (!blob)
      return NextResponse.json({ error: "Sign-in required.", status: 401 } as ApiError, { status: 401 });
    const session = decryptSso(blob);
    const rec = await getOpportunityById(id);
    if (!rec)
      return NextResponse.json({ error: "Opportunity not found.", status: 404 } as ApiError, { status: 404 });
    if (!canSeeRecord(rec, session))
      return NextResponse.json(
        { error: "You don't have access to this record.", status: 403 } as ApiError,
        { status: 403 },
      );
    userId = session.userId;
  }

  const result = await markFirstOpened(id, userId);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    return await withGrants(() => handler(request, ctx));
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json({ error: e.message, status: e.status } as ApiError, { status: e.status });
    if (e instanceof GhlError)
      return NextResponse.json(
        { error: e.message, detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json({ error: "Request failed.", detail: String(e) } as ApiError, { status: 500 });
  }
}
