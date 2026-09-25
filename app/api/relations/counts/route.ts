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
// counts for N records means N upstream calls.
//
// ⚠️ ROUND 152 — "THERE IS NO BULK RELATIONS QUERY" IS AN ASSUMPTION, NOT A
// PROBE. Nothing in this tree has ever called `/associations/relations` without
// a contact id; the only id-less use of that path is a POST that CREATES a
// relation (lib/ghl.ts, createCaregiverRelation). A bulk GET may well exist —
// it is a reasonable thing for an API to have — and if it does, one indexed
// read for the location replaces sixty. That is a probe somebody has to run,
// and until they have, this sentence is what we believe rather than what we
// know. Round 138 is what an unprobed endpoint costs.
//
// Folding N upstream calls into
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
    // 🔴 ROUND 152 — THE IDS THAT COULD NOT BE READ, NAMED.
    //
    // This catch used to be empty, and its comment said the cost was "no badge,
    // which is the same as having no links". 🔴 IT IS NOT THE SAME, and the
    // client proved it: for every id missing from `counts` it recorded a hard
    // `{caregivers:0, clients:0}` — so a failed upstream read became "no links"
    // AND, because the zero is recorded, was never asked about again. One
    // timeout pinned a wrong badge for the rest of the session.
    //
    // ⚠️ SENT EXPLICITLY RATHER THAN LEFT TO BE INFERRED FROM ABSENCE. Every id
    // that succeeds is in `counts`, so absence DOES imply failure and the
    // client could work it out — but "this list is missing an entry, therefore
    // something failed" is exactly the inference this project keeps getting
    // wrong. The route knows; it says so.
    const unknown: string[] = [];
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      await Promise.all(
        ids.slice(i, i + CONCURRENCY).map(async (id) => {
          try {
            counts[id] = await countCaregiverRelations(id);
          } catch (e) {
            // One contact failing must not lose the other 59.
            unknown.push(id);
            // eslint-disable-next-line no-console
            console.warn(
              `[relations] could not count ${id}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }),
      );
    }
    if (unknown.length)
      // eslint-disable-next-line no-console
      console.warn(
        `[relations] ${unknown.length} of ${ids.length} contact(s) could not be counted — their badges read "links unknown", not zero.`,
      );

    return NextResponse.json(
      { ok: true, counts, unknown },
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
