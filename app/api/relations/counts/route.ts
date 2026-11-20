import { NextResponse } from "next/server";
import { countCaregiverRelations, explainGhlError, GhlError } from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_IDS = 60;
const CONCURRENCY = 6;

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
      decryptSso(blob);
    }

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

    const unknown: string[] = [];
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      await Promise.all(
        ids.slice(i, i + CONCURRENCY).map(async (id) => {
          try {
            counts[id] = await countCaregiverRelations(id);
          } catch (e) {

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
