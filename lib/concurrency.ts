import { NextResponse } from "next/server";
import type { ApiError, OpportunityRecord } from "./types";

export interface Versioned {
  expectedVersion?: string;
}

export interface ConflictInfo {
  expected: string;
  actual: string;
}

export function isStale(
  stored: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || !stored) return false;
  return stored.trim() !== expected.trim();
}

export function conflictResponse(
  info: ConflictInfo,

  record?: Pick<OpportunityRecord, "id" | "version"> &
    Partial<
      Pick<
        OpportunityRecord,
        "stageId" | "status" | "ownerId" | "monetaryValue" | "cf"
      >
    >,
): NextResponse {
  return NextResponse.json(
    {
      error:
        "This record was updated by someone else while you had it open. Reload to see the current version.",

      detail: `Expected version ${info.expected || "(none)"}, but the record is now at ${info.actual || "(none)"}.`,
      status: 409,
      ...(record ? { record } : {}),
    } as ApiError,
    { status: 409 },
  );
}

export function versionGuard(
  record: Pick<OpportunityRecord, "id" | "version"> &
    Partial<
      Pick<
        OpportunityRecord,
        "stageId" | "status" | "ownerId" | "monetaryValue" | "cf"
      >
    >,
  expected: string | undefined,
  label: string,
): NextResponse | null {
  const stored = record.version;
  if (!isStale(stored, expected)) {
    if (!expected)
      // eslint-disable-next-line no-console
      console.warn(
        `[version] ${label} on ${record.id} sent NO expectedVersion — the concurrency check could not run for this write.`,
      );
    else if (!stored)
      // eslint-disable-next-line no-console
      console.warn(
        `[version] ${label} on ${record.id}: GoHighLevel returned no updatedAt, so there was nothing to compare against.`,
      );
    return null;
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[version] ${label} on ${record.id} REFUSED: caller had ${expected}, record is at ${stored}. Someone else wrote in between.`,
  );
  return conflictResponse({ expected: expected || "", actual: stored || "" }, record);
}

export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  const out: Settled<R>[] = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {

      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        try {
          out[i] = { ok: true, value: await fn(items[i], i) };
        } catch (error) {
          out[i] = { ok: false, error };
        }
      }
    }),
  );
  return out;
}
