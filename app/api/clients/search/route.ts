import { NextResponse } from "next/server";
import {
  searchContacts,
  listContactOpportunities,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import type { ApiError, ContactMatch } from "@/lib/types";
import { withGrants } from "@/lib/withGrants";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function getHandler(request: Request) {
  try {
    const url = new URL(request.url);
    const q = (url.searchParams.get("q") || "").trim();
    const blob =
      request.headers.get("x-ghl-sso-key") || url.searchParams.get("ssoKey");

    if (ssoConfigured()) {
      if (!blob)
        return NextResponse.json(
          { error: "Sign-in required.", status: 401 } as ApiError,
          { status: 401 },
        );
      decryptSso(blob);
    }

    if (q.length < 3)
      return NextResponse.json(
        { ok: true, matches: [] },
        { headers: { "Cache-Control": "no-store" } },
      );

    const contacts = await searchContacts(q);
    const matches: ContactMatch[] = await Promise.all(
      contacts.slice(0, 5).map(async (c) => {
        let pipelines: ContactMatch["pipelines"] = [];
        try {
          pipelines = (await listContactOpportunities(c.id))
            .filter((o) => o.pipelineId)
            .map((o) => ({
              pipelineId: o.pipelineId,
              pipelineName: o.pipelineName,
              stage: o.stage,
            }));
        } catch {

        }
        return { ...c, pipelines };
      }),
    );

    return NextResponse.json(
      { ok: true, matches },
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
        { error: "Contact search failed.", detail: await explainGhlError(e) } as ApiError,
        { status: e.status >= 400 && e.status < 600 ? e.status : 502 },
      );
    return NextResponse.json(
      { error: "Contact search failed.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  return withGrants(() => getHandler(request));
}
