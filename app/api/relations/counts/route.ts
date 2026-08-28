import { NextResponse } from "next/server";
import { countCaregiverRelations, explainGhlError, GhlError } from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// BUG 2 — caregiver/client counts for the list and board badges.
//
// POST { ssoKey?, contactIds: string[] } -> { counts: { [contactId]: {caregivers, clients} } }
//
// WHY A BATCH ENDPOINT AND NOT THE MAIN LIST PAYLOAD.
// GHL exposes relations per RECORD only — there is no bulk relations query — so
// counts for N records means N upstream calls. Folding that into
// /api/opportunities would put 100+ sequential GHL round trips on the critical
// path of the primary view, for a secondary signal, inside a 60s lambda.
//
// So the badges load AFTER the list, for the records actually on screen, and the
// list renders at its normal speed whether this succeeds, fails or is slow.
// Nothing here can break the dashboard: a failure means no badges.
const MAX_IDS = 60; // one screen's worth; the client sends visible rows only
const CONCURRENCY = 6; // parallel upstream calls — bounded so we don't get rate-limited

async function postHandler(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      contactIds?: string[];
    };
    const blob = body.ssoKey || request.headers.get("x-ghl-sso-key");

    if (ssoConfigured()) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      decryptSso(blob); // throws SsoError
    }

    // Counts only — no names, no case details — so this reveals nothing beyond
    // "this contact has N links", for records the caller can already see.
    const ids = [...new Set((body.contactIds || []).filter(Boolean))].slice(
      0,
      MAX_IDS,
    );
    if (!ids.length)
      return NextResponse.json(
        { ok: true, counts: {} },
        { headers: { "Cache-Control": "no-store" } },
      );

    const counts: Record<string, { caregivers: number; clients: number }> = {};
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      await Promise.all(
        ids.slice(i, i + CONCURRENCY).map(async (id) => {
          try {
            counts[id] = await countCaregiverRelations(id);
          } catch {
            // One contact failing must not lose the other 59. It simply gets
            // no badge, which is the same as having no links.
          }
        }),
      );
    }

    return NextResponse.json(
      { ok: true, counts },
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
        { error: "Could not load relation counts.", detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Could not load relation counts.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return postHandler(request);
}
