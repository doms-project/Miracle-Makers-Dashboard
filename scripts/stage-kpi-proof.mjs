// ---------------------------------------------------------------------------
// ROUND 165 — READING THE STAGE LOG.
//
// 🔴 NO SERVER, NO FAKE, NO BROWSER. Round 163 needed all three to prove the
// WRITER; the reader is arithmetic over an array, so this drives it with
// literals. That is the payoff for keeping lib/stageKpi.ts pure, and it is why
// this proof runs in under a second when stage-recorder takes two.
//
// ⚠️ EVERY NO-OP ASSERTION HERE IS PAIRED WITH A POSITIVE CASE IN THE SAME
// RUN. "first sightings are not counted" is satisfied by counting nothing at
// all, so it sits beside a record whose second row DOES count. Rule 14.
//
// Run: npx tsx scripts/stage-kpi-proof.mjs
// ---------------------------------------------------------------------------
import { stageKpi, stageAge, monthWindow, countStageHistoryLines } from "../lib/stageKpi.ts";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const FID = "169kLJWuSzuEiagrAmKo";   // the live field id
const NOW = Date.parse("2026-09-30T12:00:00.000Z");
// 🔴 ROUND 171 — EVERY FIXTURE NOW CARRIES A createdAt, AND IT IS DELIBERATELY
// NOWHERE NEAR ANY ROW. Row 1 of a log is a MOVE now unless it lands within two
// minutes of the case being created, so a fixture with no createdAt would make
// every scenario below depend on a rule none of them is about. January keeps
// these sections testing transitions, owners, managers and windows — exactly
// what they tested before — while the creation rule gets its own proof.
const BORN = "2026-01-01T00:00:00.000Z";
const rec = (id, stageId, rows, stageChangedAt, createdAt = BORN) => ({
  id, stageId, stageChangedAt, createdAt, cf: { [FID]: rows.join("\n") },
});

// ═══════════════════════════════════════════════════════════════════════════
console.log("═══ 1 · TRANSITIONS, NOT ROWS ═══");
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE CONTROL IS THE SECOND RECORD. `moves === 1` on a two-row log is also
// what you get if the counter is broken and returns rows-minus-anything, so a
// one-row record sits beside it: 3 rows total, 1 move.
const one = rec("r1", "B", ["2026-09-10T09:00:00.000Z|A|u_ern|u_carla",
                            "2026-09-12T09:00:00.000Z|B|u_ern|u_carla"]);
const first = rec("r2", "A", ["2026-09-11T09:00:00.000Z|A|u_ern|u_carla"]);

let k = stageKpi([one, first], FID);
// 🔴 ROUND 171 — UPDATED, AND THE OLD ASSERTION WAS THE BUG. It read "the lone
// first row is NOT a move" and it was GREEN on a Moves screen that counted
// zero. The stage workflow fires on a stage CHANGE, so a first row away from
// the case's creation is somebody moving it from a stage we never saw.
ok("three rows across two records = THREE moves", k.moves === 3, k.moves);
ok("🔴 ROUND 171 — two of them have an unknown starting stage",
  k.unknownOrigin === 2, k.unknownOrigin);
ok("🔴 …and none of them is a creation row (nothing is near January)",
  k.creationRows === 0, k.creationRows);
ok("perRep credits all three to the one rep", k.perRep[0]?.moves === 3, k.perRep);
ok("both records counted as having history", k.recordsWithHistory === 2, k.recordsWithHistory);

// The positive control: `unknownOrigin` must stay a SUBSET of `moves` rather
// than a parallel total, or "counted" could quietly mean "counted twice".
const k2 = stageKpi([one, rec("r2", "C", [
  "2026-09-11T09:00:00.000Z|A|u_ern|u_carla",
  "2026-09-13T09:00:00.000Z|C|u_ern|u_carla",
])], FID);
ok("🔴 CONTROL — a second transition raises moves to 4, unknownOrigin stays 2",
  k2.moves === 4 && k2.unknownOrigin === 2, { m: k2.moves, f: k2.unknownOrigin });
ok("🔴 CONTROL — unknownOrigin never exceeds moves",
  k2.unknownOrigin < k2.moves, { u: k2.unknownOrigin, m: k2.moves });

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 2 · 🔴 A MOVE WITH NO OWNER BELONGS TO NOBODY ═══");
// ═══════════════════════════════════════════════════════════════════════════
// The live row `2026-09-28T07:36:19.260Z|b43041b2-…||` has an empty owner AND
// empty managers — this is not hypothetical.
const orphan = rec("r3", "B", ["2026-09-10T09:00:00.000Z|A||",
                               "2026-09-12T09:00:00.000Z|B||"]);
k = stageKpi([one, orphan], FID);
ok("the ownerless moves are counted in the total", k.moves === 4, k.moves);
ok("🔴 …and credited to NO rep", k.perRep.length === 1, k.perRep);
ok("the shortfall is stated", k.unattributed === 2, k.unattributed);
ok("perRep + unattributed === moves",
  k.perRep.reduce((a, r) => a + r.moves, 0) + k.unattributed === k.moves, k);
ok("the same for managers", k.unmanaged === 2 && k.perManager.length === 1, {
  u: k.unmanaged, m: k.perManager,
});

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 3 · THE MANAGER COLUMN SUMS TO MORE, ON PURPOSE ═══");
// ═══════════════════════════════════════════════════════════════════════════
const watched = rec("r4", "B", [
  "2026-09-10T09:00:00.000Z|A|u_ern|u_carla,u_lamarr",
  "2026-09-12T09:00:00.000Z|B|u_ern|u_carla,u_lamarr",
]);
k = stageKpi([watched], FID);
const mgrTotal = k.perManager.reduce((a, r) => a + r.moves, 0);
ok("two moves, two managers, each credited on both", mgrTotal === 4 && k.moves === 2,
  { mgrTotal, moves: k.moves });
ok("🔴 the manager column EXCEEDS the move count", mgrTotal > k.moves, { mgrTotal, moves: k.moves });
ok("the rep column does not", k.perRep.reduce((a, r) => a + r.moves, 0) === k.moves, k.perRep);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 4 · 🔴 THE WINDOW IS APPLIED AFTER `from` IS DERIVED ═══");
// ═══════════════════════════════════════════════════════════════════════════
// The trap: filter the text by date first and row 2 becomes row 1, gaining a
// null origin it does not have. The record below has its FIRST row in August
// and its second in September — inside a September window that second row is
// still a transition, not a first sighting.
const straddle = rec("r5", "B", [
  "2026-08-20T09:00:00.000Z|A|u_ern|u_carla",
  "2026-09-12T09:00:00.000Z|B|u_ern|u_carla",
]);
const sept = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
k = stageKpi([straddle], FID, { window: sept });
ok("🔴 the in-window row stays a DERIVED transition, not an unknown origin",
  k.moves === 1 && k.unknownOrigin === 0, { m: k.moves, f: k.unknownOrigin });
// CONTROL — the August row really is outside, or the window does nothing.
const kAll = stageKpi([straddle], FID);
ok("🔴 CONTROL — without the window the August row reappears, origin unknown",
  kAll.moves === 2 && kAll.unknownOrigin === 1 && k.unknownOrigin === 0,
  { win: k.unknownOrigin, all: kAll.unknownOrigin, m: kAll.moves });
ok("`since` ignores the window and reaches August",
  k.since === "2026-08-20T09:00:00.000Z", k.since);

const w = monthWindow(Date.parse("2026-09-15T10:00:00.000Z"));
ok("monthWindow spans the calendar month",
  w.from === "2026-09-01T00:00:00.000Z" && w.to === "2026-10-01T00:00:00.000Z", w);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 5 · 🔴 DAYS-IN-STAGE PREFERS THE LOG, AND SAYS WHICH ═══");
// ═══════════════════════════════════════════════════════════════════════════
// The bug this fixes: a bulk correction moves lastStageChangeAt without moving
// the record. Here GHL says "yesterday" and the log says "twenty days ago".
const corrected = rec("r6", "B", [
  "2026-09-10T12:00:00.000Z|B|u_ern|u_carla",
], "2026-09-29T12:00:00.000Z");
let a = stageAge(corrected, FID, NOW);
ok("🔴 the LOG wins over GoHighLevel's corrected date",
  a.days === 20 && a.source === "history", a);
// CONTROL — the same record with no log must fall back and say so, or
// "prefers the log" is unfalsifiable.
a = stageAge({ ...corrected, cf: {} }, FID, NOW);
ok("🔴 CONTROL — with no log it falls back to GHL and marks the source",
  a.days === 1 && a.source === "ghl", a);

// 🔴 THE STALE-LOG GUARD. The log's last row says stage B; the record is in C,
// so a move was missed. Dating C from B's timestamp would be confidently wrong.
const missed = rec("r7", "C", [
  "2026-09-10T12:00:00.000Z|B|u_ern|u_carla",
], "2026-09-28T12:00:00.000Z");
a = stageAge(missed, FID, NOW);
ok("🔴 a log that disagrees with the record is NOT used",
  a.source === "ghl" && a.days === 2, a);
ok("…and the disagreement is reported", a.missedMove === true, a);
ok("the KPI counts it too", stageKpi([missed], FID).missedMoves === 1);
ok("a record whose log AGREES reports no missed move",
  stageKpi([corrected], FID).missedMoves === 0);

ok("no date anywhere = null, never 0",
  stageAge({ id: "x", stageId: "A", cf: {} }, FID, NOW) === null);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 6 · A SKIPPED ROW IS COUNTED, NOT SWALLOWED ═══");
// ═══════════════════════════════════════════════════════════════════════════
const dirty = rec("r8", "B", [
  "2026-09-10T09:00:00.000Z|A|u_ern|u_carla",
  "this line is not a row",
  "2026-09-12T09:00:00.000Z|B|u_ern|u_carla",
]);
k = stageKpi([dirty], FID);
ok("the malformed line does not throw", k.moves === 2, k.moves);
ok("🔴 …and is reported rather than vanishing", k.skipped === 1, k.skipped);
ok("a clean log reports zero skipped", stageKpi([one], FID).skipped === 0);
ok("countStageHistoryLines ignores blanks", countStageHistoryLines("a\n\n  \nb") === 2);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 7 · THE CLUSTER IS SURFACED, NOT FILTERED ═══");
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ ROUND 171 — THE FIRST ROWS ARE STAGGERED NOW, AND THEY HAVE TO BE. They
// all shared one minute, which was harmless while a first row was not a move
// and is a SECOND cluster now that it is. Six records entering one stage in
// one minute genuinely is a cluster — but then this section would be testing
// two of them at once and its control could not fail.
const bulk = [];
for (let i = 0; i < 6; i++)
  bulk.push(rec(`b${i}`, "Z", [
    `2026-09-0${i + 1}T09:00:00.000Z|Y|u_ern|u_carla`,
    `2026-09-20T11:30:0${i}.000Z|Z|u_ern|u_carla`,
  ]));
k = stageKpi(bulk, FID, { clusterMin: 5 });
ok("🔴 every clustered move is still COUNTED", k.moves === 12, k.moves);
ok("…and the cluster is reported separately",
  k.clusters.length === 1 && k.clusters[0].records === 6, k.clusters);
ok("the cluster names its stage and minute",
  k.clusters[0].to === "Z" && k.clusters[0].at === "2026-09-20T11:30", k.clusters[0]);
ok("🔴 CONTROL — six records spread across six hours are NOT a cluster",
  stageKpi(bulk.map((r, i) => rec(r.id, "Z", [
    `2026-09-0${i + 1}T09:00:00.000Z|Y|u_ern|u_carla`,
    `2026-09-20T1${i}:30:00.000Z|Z|u_ern|u_carla`,
  ])), FID, { clusterMin: 5 }).clusters.length === 0);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 8 · NO FIELD ON THE ACCOUNT ═══");
// ═══════════════════════════════════════════════════════════════════════════
k = stageKpi([one, watched], null);
ok("no field id = empty result, not a crash", k.moves === 0 && k.perRep.length === 0, k);
ok("…and it still reports how many records it looked at", k.recordsScanned === 2, k);
ok("stageAge with no field falls straight to GHL",
  stageAge(corrected, null, NOW)?.source === "ghl");

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
