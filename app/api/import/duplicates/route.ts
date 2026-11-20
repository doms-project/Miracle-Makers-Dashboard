import { NextResponse } from "next/server";
import { findContactByEmailOrPhone, GhlError } from "@/lib/ghl";
import { mapLimit } from "@/lib/concurrency";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import type { ApiError, ImportDuplicate } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const LOOKUP_CONCURRENCY = 4;
const MAX_ROWS = 500;

interface Body {
  ssoKey?: string;

  people?: { row: number; email?: string; phone?: string }[];
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Body;

    if (ssoConfigured()) {
      if (!body.ssoKey)
        return NextResponse.json({ error: "Sign-in required.", status: 401 } as ApiError, { status: 401 });
      const s = decryptSso(body.ssoKey);
      if (!isAdminSession(s.role, s.type))
        return NextResponse.json({ error: "Admin only.", status: 403 } as ApiError, { status: 403 });
    }

    const people = Array.isArray(body.people) ? body.people : [];
    if (people.length > MAX_ROWS)
      return NextResponse.json(
        {
          error: `Too many rows to check at once (max ${MAX_ROWS}).`,
          detail:
            "Split the file. The check runs one lookup per row against GoHighLevel's rate limit.",
        } as ApiError,
        { status: 400 },
      );

    const duplicates: ImportDuplicate[] = [];
    const errors: { row: number; error: string }[] = [];

    await mapLimit(people, LOOKUP_CONCURRENCY, async (p) => {
      if (!p.email && !p.phone) return;
      try {
        const hit = await findContactByEmailOrPhone({ email: p.email, phone: p.phone });
        if (hit)
          duplicates.push({
            row: p.row,
            name: hit.name || hit.email || hit.phone || "Unnamed contact",
            contactId: hit.id,
            matchedOn: hit.matchedOn,
          });
      } catch (e) {
        errors.push({
          row: p.row,
          error: e instanceof GhlError ? e.message : String(e),
        });
      }
    });

    duplicates.sort((a, b) => a.row - b.row);
    errors.sort((a, b) => a.row - b.row);
    return NextResponse.json(
      { checked: people.length, duplicates, errors },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (e instanceof SsoError)
      return NextResponse.json({ error: e.message, status: e.status } as ApiError, { status: e.status });
    return NextResponse.json(
      { error: "Could not check for existing records.", detail: String(e) } as ApiError,
      { status: 500 },
    );
  }
}
