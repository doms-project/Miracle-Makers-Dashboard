// ---------------------------------------------------------------------------
// ROUND 158 — THE BACKFILL. Case managers for records that predate the rule.
//
// 🔴 WHY IT IS NEEDED. `applyCaseManagers` runs on an owner change and on a new
// lead, and on nothing else. Every record that existed before the rule shipped
// has no managers following it and no "Case Manager" field — 363 on OLTL
// Enrollment alone, ~600 across the client pipelines.
//
// ⚠️ THIS WRITES TO THE LIVE ACCOUNT. It is a DRY RUN unless you pass --apply,
// and the dry run makes no write of any kind. Read the summary first.
//
//   node scripts/backfill-case-managers.mjs                 # dry run
//   node scripts/backfill-case-managers.mjs --apply
//   node scripts/backfill-case-managers.mjs --apply --limit 20
//
// 🔴 FOUR OUTCOMES, AND THEY MUST NOT SHARE A BUCKET.
//
//   applied      followers and fields written, read-back agreed
//   unconfirmed  the write was vouched for by GoHighLevel's own echo and the
//                read-back has not caught up (round 156). NOT a failure, and
//                NOT a success either — it is re-runnable and this records it
//                so a second pass can confirm it.
//   skipped      rule A: the owner has no entry in the map, or the record is
//                not on a client pipeline. A CORRECT no-op, and the common
//                case — 21 of 26 users are unmapped.
//   failed       a write GoHighLevel refused, a read that threw. Needs a human.
//
// ⚠️ A FIFTH THING IS COUNTED AND NEVER ACTED ON: a record whose owner is not
// a user of this location at all. See DEPARTED below.
//
// 🔴 RESUMABLE BY CONSTRUCTION. Every record's outcome is appended to the state
// file the moment it is known, so a crash, a 429 storm or a Ctrl-C loses at
// most the record in flight. A re-run skips anything already recorded as
// `applied` or `skipped`; `unconfirmed` and `failed` are retried, because both
// are states a second pass can legitimately change.
// ---------------------------------------------------------------------------
import { appendFileSync, readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const STATE = (args.find((a) => a.startsWith("--state=")) || "").split("=")[1]
  || ".backfill-case-managers.jsonl";
const LIMIT = Number((args.find((a) => a.startsWith("--limit=")) || "").split("=")[1] || 0);
/**
 * 🔴 RECORDS PER TEN SECONDS, AND IT IS DELIBERATELY WELL UNDER THE BUDGET.
 *
 * The account allows 100 requests per 10 seconds. A record that needs work
 * costs up to five: the uncached read, the followers POST, two field PUTs and
 * the read-back. Twelve records is ~60 requests worst case, leaving 40% of the
 * window for the people using the dashboard while this runs.
 *
 * ⚠️ AND IT DOES NOT RELY ON `pauseIfNearLimit`. That mitigation exists for
 * interactive screens and says so: it lets the budget fall to five remaining
 * and then pauses ~1.2s. Riding a shared limit down to its floor six hundred
 * times would make every live request race this one. Pacing under the limit is
 * a different job from recovering at it.
 */
const RATE = Number((args.find((a) => a.startsWith("--rate=")) || "").split("=")[1] || 12);

const ghl = await import("../lib/ghl.ts");
const { withGrants } = await import("../lib/withGrants.ts");
const pa = await import("../lib/pipelineAccess.ts");

const done = new Map();
if (existsSync(STATE))
  for (const line of readFileSync(STATE, "utf8").split("\n").filter(Boolean)) {
    try {
      const r = JSON.parse(line);
      if (r.id) done.set(r.id, r.outcome);
    } catch { /* a half-written final line after a kill — ignore it */ }
  }
const record = (id, outcome, detail) => {
  done.set(id, outcome);
  // 🔴 A DRY RUN WRITES NOTHING — INCLUDING THE STATE FILE. Found by the proof:
  // the departed-owner branch called this before the `--apply` check, so a dry
  // run left a resume point behind. Fixed HERE rather than in that branch,
  // because the invariant is "a dry run leaves no trace" and a guard in one
  // caller only holds until somebody adds a second.
  //
  // ⚠️ `done` is still updated in memory, so a dry run's own bookkeeping is
  // unchanged — it is only the file on disk that a preview must not touch.
  if (!APPLY) return;
  appendFileSync(STATE, JSON.stringify({ id, outcome, detail, at: new Date().toISOString() }) + "\n");
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Hold the record rate, and brake hard if GoHighLevel says the window is tight. */
const pace = async () => {
  await sleep(Math.round(10000 / RATE));
  const s = ghl.getRateLimitSnapshot?.();
  if (!s || s.remaining == null) return;
  const interval = s.intervalMs ?? 10000;
  if (Date.now() - s.at > interval) return;
  // ⚠️ A REAL BRAKE, NOT THE INTERACTIVE NUDGE. If a quarter of the window is
  // left, wait out the rest of it rather than shaving 1.2s off and going again.
  if (s.remaining < 25) {
    const wait = Math.max(0, interval - (Date.now() - s.at)) + 250;
    console.log(`    …${s.remaining} requests left in the window — waiting ${wait}ms`);
    await sleep(wait);
  }
};

const counts = { applied: 0, unconfirmed: 0, skipped: 0, failed: 0, departed: 0, resumed: 0 };
const failures = [];
const departedOwners = new Map();

console.log(APPLY
  ? "🔴 APPLY MODE — this writes to the live account."
  : "⚠️  DRY RUN — nothing will be written. Pass --apply to write.");
console.log(`    state file: ${STATE}${done.size ? `  (${done.size} already recorded)` : ""}`);
console.log(`    pacing:     ${RATE} records / 10s`);

await withGrants(async () => {
  const board = await ghl.getOltlOpportunities("client");
  const users = await ghl.getUserMap();
  const records = board.records;
  console.log(`\n${records.length} client records across ${board.pipelines.length} pipeline(s).`);
  if (board.failedPipelines?.length)
    // 🔴 A PIPELINE THAT FAILED TO LOAD IS NOT A PIPELINE WITH NO RECORDS. Its
    // records are absent from this run entirely, and a summary that did not say
    // so would read as "everything is done".
    console.log(`🔴 ${board.failedPipelines.length} pipeline(s) FAILED to load and are not in this run: ` +
      board.failedPipelines.map((p) => `${p.name} (${p.error})`).join("; "));

  let worked = 0;
  for (const rec of records) {
    const prior = done.get(rec.id);
    // `unconfirmed` and `failed` are retried; the other two are settled.
    if (prior === "applied" || prior === "skipped") { counts.resumed++; continue; }

    // ═══ THE DEPARTED-OWNER BUCKET — COUNTED, NEVER ACTED ON ════════════════
    //
    // 🔴 "NOT A USER OF THIS LOCATION" IS AN OBSERVABLE FACT, unlike "is a case
    // manager" or "is a sales rep", which this system has repeatedly refused to
    // infer. The user list is authoritative and the id is either in it or not.
    //
    // ⚠️ BUT IT IS STILL NOT A DECISION THIS SCRIPT CAN MAKE. A record owned by
    // somebody who has left will never have its owner changed by the workflow,
    // so it will never acquire managers — and choosing who should supervise it
    // means choosing a new owner, which is a business call about a real client.
    // Named and counted so it lands on a person's desk instead of disappearing
    // into `skipped`, which is exactly what would happen on the map alone.
    if (rec.ownerId && !users.has(rec.ownerId)) {
      counts.departed++;
      departedOwners.set(rec.ownerId, (departedOwners.get(rec.ownerId) || 0) + 1);
      record(rec.id, "departed", rec.ownerId);
      continue;
    }

    if (!APPLY) {
      // 🔴 THE DRY RUN CLASSIFIES WITHOUT WRITING, and it can only see half of
      // rule A: `getCaseManagers` answers "is this owner mapped", but whether
      // the record already carries our own field needs a read per record, and
      // 600 reads to preview a no-op is not worth the budget. So a dry-run
      // "would apply" is an UPPER BOUND — some of those are already done.
      const mapped = rec.ownerId ? pa.getCaseManagers(rec.ownerId) : null;
      if (!rec.ownerId || mapped === null) counts.skipped++;
      else { counts.applied++; worked++; }
      if (LIMIT && worked >= LIMIT) break;
      continue;
    }

    let r;
    try {
      r = await ghl.applyCaseManagers(rec.id, rec.ownerId || "");
    } catch (e) {
      // applyCaseManagers does not throw by contract; this is belt and braces
      // so one unexpected shape cannot end a 600-record run.
      counts.failed++;
      failures.push({ id: rec.id, why: e instanceof Error ? e.message : String(e) });
      record(rec.id, "failed", e instanceof Error ? e.message : String(e));
      await pace();
      continue;
    }

    if (r.skipped && /the apply failed/.test(r.why || "")) {
      counts.failed++;
      failures.push({ id: rec.id, why: r.why });
      record(rec.id, "failed", r.why);
    } else if (r.skipped) {
      counts.skipped++;
      record(rec.id, "skipped", r.why);
    } else if (r.mismatch) {
      counts.unconfirmed++;
      record(rec.id, "unconfirmed", r.mismatch);
      worked++;
    } else {
      counts.applied++;
      record(rec.id, "applied", `+${r.added.length} −${r.removed.length}`);
      worked++;
    }

    if (worked && worked % 10 === 0)
      console.log(`  …${worked} worked · ${counts.applied} applied · ${counts.unconfirmed} unconfirmed · ${counts.failed} failed`);
    if (LIMIT && worked >= LIMIT) { console.log(`\n  --limit ${LIMIT} reached.`); break; }
    await pace();
  }
});

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"} — outcomes`);
console.log(`  applied      ${counts.applied}${APPLY ? "" : "   (upper bound — see the dry-run note)"}`);
if (APPLY) console.log(`  unconfirmed  ${counts.unconfirmed}   re-run to confirm; the echo vouched for these`);
console.log(`  skipped      ${counts.skipped}   correct no-ops: owner unmapped, or no owner`);
console.log(`  failed       ${counts.failed}`);
console.log(`  departed     ${counts.departed}   owner is not a user of this location — NOT acted on`);
if (counts.resumed) console.log(`  resumed      ${counts.resumed}   already settled in ${STATE}`);

if (departedOwners.size) {
  console.log(`\n⚠️  records owned by ${departedOwners.size} departed user(s) — a person has to decide these:`);
  for (const [id, n] of [...departedOwners].sort((a, b) => b[1] - a[1]))
    console.log(`     ${id}  ${n} record(s)`);
}
if (failures.length) {
  console.log(`\n🔴 ${failures.length} failure(s) — these are NOT skips:`);
  for (const f of failures.slice(0, 20)) console.log(`     ${f.id}  ${String(f.why).slice(0, 160)}`);
  if (failures.length > 20) console.log(`     …and ${failures.length - 20} more in ${STATE}`);
}
console.log(`\n${counts.failed ? "🔴" : "✅"} done.${APPLY ? "" : "  Nothing was written."}`);
process.exit(counts.failed ? 1 : 0);
