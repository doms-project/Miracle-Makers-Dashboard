import { NextResponse } from "next/server";
import type { ApiError, OpportunityRecord } from "./types";

// ---------------------------------------------------------------------------
// ITEM 5 — OPTIMISTIC CONCURRENCY.
//
// Two people open the same record. The first saves. The second saves. The
// first change is gone, with no error and no trace that it ever existed. With
// 25 users that is occasional; with 100 it is routine, and the damage is
// invisible — nobody finds out until the data is wrong downstream.
//
// The client sends the version it last READ. If the stored version has moved
// on, somebody else wrote in between and this write is refused.
//
// 🔴 A WEBSOCKET DOES NOT FIX THIS. Live updates shorten the window; they do
// not close it. Two people can still submit inside the same second, and a
// broadcast that arrives mid-save changes nothing. This check is a guarantee,
// and it belongs in first regardless of what live updates get built later.
//
// WHY `updatedAt` AND NOT A COUNTER. GoHighLevel already stamps it on every
// opportunity write, including writes made in GHL's own UI — so a change made
// outside this dashboard is caught too. A counter of our own would only see
// our own writes, which is the smaller half of the problem.
// ---------------------------------------------------------------------------

/** Sent by the client alongside every mutating request. */
export interface Versioned {
  expectedVersion?: string;
}

export interface ConflictInfo {
  expected: string;
  actual: string;
}

/**
 * True when the caller's version is stale.
 *
 * Returns FALSE (i.e. "go ahead") in two cases, both deliberate:
 *
 *   - the client sent no version. Callers that predate this check, and any
 *     background write, keep working rather than failing closed on a field the
 *     UI may not have plumbed through yet. Tightening this to "reject" is one
 *     line, once every caller is confirmed to send it.
 *   - the record has no stored version. GoHighLevel didn't give us one, so
 *     there is nothing to compare; refusing every write over a missing field
 *     would be worse than the last-write-wins behaviour we already had.
 *
 * Both are logged by the caller rather than passing silently.
 */
export function isStale(
  stored: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || !stored) return false;
  return stored.trim() !== expected.trim();
}

/**
 * The 409 to return when a write loses the race. Its wording is deliberately
 * about the RECORD, not about a version number: "reload to see the current
 * version" is something a rep can act on, and it does not imply their own work
 * was wrong — only that it arrived second.
 */
export function conflictResponse(info: ConflictInfo): NextResponse {
  return NextResponse.json(
    {
      error:
        "This record was updated by someone else while you had it open. Reload to see the current version.",
      // Kept for us, never shown as the headline: the two timestamps are what
      // tell us whether this was a genuine race or a stale client.
      detail: `Expected version ${info.expected || "(none)"}, but the record is now at ${info.actual || "(none)"}.`,
      status: 409,
    } as ApiError,
    { status: 409 },
  );
}

/**
 * One call for the common shape: given the record just read and the caller's
 * expected version, return the 409 to send back, or null to proceed.
 *
 * `label` names the write in the log, so a conflict is traceable to the action
 * that lost rather than just to a route.
 */
export function versionGuard(
  record: Pick<OpportunityRecord, "id" | "version">,
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
  return conflictResponse({ expected: expected || "", actual: stored || "" });
}

// ═══════════════════════════════════════════════════════════════════════════
// PARALLEL FETCH WITH A CAP.
//
// ⚠️ Different sense of "concurrency" from the rest of this file, which is about
// OPTIMISTIC concurrency (version checks on writes). Both live here because the
// caller was told to look here for it; they share nothing but the word.
//
// Why a cap at all: GoHighLevel allows 100 requests per 10 seconds. Firing an
// unbounded wave is how you turn a slow load into a 429 — the failure this
// project has spent two rounds removing. `limit` is the promise that we never
// widen faster than the budget allows.
//
// SETTLED, NOT ALL-OR-NOTHING. `Promise.all` rejects on the first failure and
// abandons the rest, so one pipeline timing out would lose the four that
// succeeded. Each result is returned tagged instead, and the caller decides.
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
      // Each worker pulls the next index until the queue is empty, so a single
      // slow item never blocks the others behind a fixed chunk boundary.
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
