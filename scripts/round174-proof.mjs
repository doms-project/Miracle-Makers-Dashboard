// ---------------------------------------------------------------------------
// ROUND 174 — THE MOVES KPIs.
//
// 🔴 NO SERVER, NO FAKE, NO BROWSER. Every number on that screen is arithmetic
// over the board payload the page already holds, so this drives it with
// literals — the payoff for keeping lib/stageKpi.ts pure.
//
// 🔴 THE FIXTURE'S NUMBERS ARE CHOSEN SO EVERY ANSWER IS EXACT AND DIFFERENT.
// 67% / 50% / 0% cannot be confused with each other; medians of 3, 5 and 30.5
// cannot be produced by returning the mean; and one case sits in the
// APPROXIMATE bucket so "never mixed in" is a thing that can fail rather than a
// claim. Rule 4: no value does two jobs here.
//
// Run: npx tsx scripts/round174-proof.mjs
// ---------------------------------------------------------------------------
import {
  stageFunnel,
  timeInStage,
  speedToFirstMove,
  wonLost,
  orderedStages,
  rangeWindow,
} from "../lib/stageKpi.ts";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const FID = "169kLJWuSzuEiagrAmKo";
const P1 = "pipe_oltl";
const P2 = "pipe_odp";
const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const BORN = "2026-09-01T00:00:00.000Z"; // 30 days before 1 October, exactly

const rec = (o) => ({
  id: o.id,
  stageId: o.stageId,
  pipelineId: o.pipelineId || P1,
  pipelineName: o.pipelineId === P2 ? "ODP Enrollment" : "OLTL Enrollment",
  ownerId: o.ownerId || "",
  status: o.status || "open",
  statusChangedAt: o.statusChangedAt,
  stageChangedAt: o.stageChangedAt,
  createdAt: o.createdAt ?? BORN,
  cf: { [FID]: (o.rows || []).join("\n") },
});

// ⚠️ EVERY ROW IS WELL CLEAR OF `createdAt`, so none of them is a creation row.
// A fixture whose first row landed inside the five-minute window would be
// testing the creation rule instead of the funnel.
const r1 = rec({
  id: "r1", stageId: "C", ownerId: "u_a", status: "won",
  statusChangedAt: "2026-10-09T00:00:00.000Z",
  rows: [
    "2026-10-01T00:00:00.000Z|A|u_a|u_m",
    "2026-10-03T00:00:00.000Z|B|u_a|u_m",
    "2026-10-08T00:00:00.000Z|C|u_a|u_m",
  ],
});
const r2 = rec({
  id: "r2", stageId: "B", ownerId: "u_a", status: "lost",
  statusChangedAt: "2026-10-06T00:00:00.000Z",
  rows: [
    "2026-10-01T00:00:00.000Z|A|u_b|u_m",
    "2026-10-05T00:00:00.000Z|B|u_b|u_m",
  ],
});
const r3 = rec({
  id: "r3", stageId: "A", ownerId: "u_b",
  rows: ["2026-10-02T00:00:00.000Z|A|u_a|u_m"],
});
// 🔴 NO ROWS AT ALL — older than the recorder. Its days-in-stage can only come
// from GoHighLevel's own date, and it must land in the labelled bucket.
const r4 = rec({ id: "r4", stageId: "A", ownerId: "u_b", stageChangedAt: "2026-10-10T00:00:00.000Z" });
// A won case with NO status date: cannot be placed in a period.
const r5 = rec({ id: "r5", stageId: "C", ownerId: "u_a", status: "won" });
// Won in SEPTEMBER — outside the October window, so the filter has something
// to exclude.
const r6 = rec({
  id: "r6", stageId: "C", ownerId: "u_a", status: "won",
  statusChangedAt: "2026-09-15T00:00:00.000Z",
});
// 🔴 A CASE WHOSE FIRST ROW IS THE CREATION ROW — and revert H found that the
// fixture had none, so `speedToFirstMove`'s creation filter was untested and
// dropping it changed nothing. Created 10:00, creation row 10:01 (inside the
// five-minute window), real first move two days later.
const r8 = rec({
  id: "r8", stageId: "B", ownerId: "u_d",
  createdAt: "2026-10-01T10:00:00.000Z",
  rows: [
    "2026-10-01T10:01:00.000Z|A|u_d|",
    "2026-10-03T10:00:00.000Z|B|u_d|",
  ],
});
// A second pipeline, so the funnel must separate them.
const r7 = rec({
  id: "r7", stageId: "Y", pipelineId: P2, ownerId: "u_c",
  rows: ["2026-10-04T00:00:00.000Z|X|u_c|", "2026-10-06T00:00:00.000Z|Y|u_c|"],
});

const ALL = [r1, r2, r3, r4, r5, r6, r7, r8];
const STAGES = {
  [P1]: [
    { id: "C", name: "ENROLLED", position: 2 },
    { id: "A", name: "NEW LEAD", position: 0 },
    { id: "B", name: "PAPERWORK", position: 1 },
  ],
  [P2]: [{ id: "X", name: "INTAKE", position: 0 }, { id: "Y", name: "ACTIVE", position: 1 }],
};
const NAMES = new Map([["A", "NEW LEAD"], ["B", "PAPERWORK"], ["C", "ENROLLED"],
                       ["X", "INTAKE"], ["Y", "ACTIVE"]]);
const OCT = { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" };
const SEP = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };

// ═══════════════════════════════════════════════════════════════════════════
console.log("═══ 1 · THE STAGE ORDER IS THE PIPELINE'S OWN ═══");
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ THE FIXTURE LISTS THE STAGES OUT OF ORDER ON PURPOSE. Declaration order
// would read C, A, B — so a funnel that trusted the array would score every
// forward move as backwards.
ok("positions win over declaration order",
  orderedStages(STAGES[P1]).map((s) => s.id).join("") === "ABC",
  orderedStages(STAGES[P1]).map((s) => s.id));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 2 · THE FUNNEL ═══");
// ═══════════════════════════════════════════════════════════════════════════
let f = stageFunnel(ALL, FID, STAGES, { window: OCT });
const p1 = f.find((x) => x.pipelineId === P1);
const row = (id) => p1.rows.find((r) => r.stageId === id);
ok("two pipelines, kept apart", f.length === 2, f.map((x) => x.pipelineId));
ok("the rows are in stage order", p1.rows.map((r) => r.stageId).join("") === "ABC",
  p1.rows.map((r) => r.stageId));
// ⚠️ r8's creation row is NOT a move, so it reaches only B — which is why
// NEW LEAD stays at 3 while PAPERWORK rises to 3.
ok("🔴 NEW LEAD: 3 reached, 2 moved on → 67%",
  row("A").reached === 3 && row("A").movedOn === 2 && row("A").pct === 67, row("A"));
ok("🔴 PAPERWORK: 3 reached, 1 moved on → 33%",
  row("B").reached === 3 && row("B").movedOn === 1 && row("B").pct === 33, row("B"));
ok("🔴 ENROLLED: 1 reached, 0 moved on → 0%",
  row("C").reached === 1 && row("C").movedOn === 0 && row("C").pct === 0, row("C"));
ok("…and the cases behind a number are listed",
  row("B").caseIds.sort().join(",") === "r1,r2,r8", row("B").caseIds);
// 🔴 THE CONTROL FOR `pct === null`. 0% and "nothing reached it" are different
// facts and the screen prints them differently.
const empty = stageFunnel([r3], FID, STAGES, { window: OCT })
  .find((x) => x.pipelineId === P1);
ok("🔴 a stage nothing reached is null, not 0%",
  empty.rows.find((r) => r.stageId === "C").pct === null,
  empty.rows.find((r) => r.stageId === "C"));
// ⚠️ r4 has no rows: it must not be counted as having reached anything.
ok("🔴 a case older than the recorder reaches nothing",
  !row("A").caseIds.includes("r4"), row("A").caseIds);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 3 · TIME IN STAGE, AND THE APPROXIMATE BUCKET ═══");
// ═══════════════════════════════════════════════════════════════════════════
let t = timeInStage(ALL, FID, NAMES, { window: OCT, now: NOW });
const dur = (id) => t.recorded.find((d) => d.stageId === id);
// ⚠️ THREE INTERVALS NOW: r1's 2 days, r2's 4, and r8's 2. r8's stay STARTS at
// its creation row, and that is correct — the case really was in NEW LEAD for
// two days. A creation row is not a move; it is still a moment in a stage.
ok("🔴 NEW LEAD: intervals of 2, 4 and 2 days → avg 2.7, median 2",
  dur("A").avg === 2.7 && dur("A").median === 2 && dur("A").n === 3, dur("A"));
ok("🔴 PAPERWORK: one interval of 5 days", dur("B").median === 5 && dur("B").n === 1, dur("B"));
ok("🔴 ENROLLED has NO completed interval — the case is still in it",
  !dur("C"), t.recorded.map((d) => d.stageId));
ok("🔴 the approximate bucket holds exactly the row-less case",
  t.approximate.n === 1 && t.approximate.caseIds.join(",") === "r4", t.approximate);
ok("…at 10 days, from GoHighLevel's own date", t.approximate.median === 10, t.approximate);
// 🔴 THE CONTROL. "never mixed in" is satisfied by an empty bucket, so the
// measured figures must be unchanged by its presence.
// ⚠️ EXACTLY ONE RECORD REMOVED — r4, the approximate one. My first version
// dropped r5, r6 AND r7 too and the comparison failed on r7's own stage, which
// is a fixture error wearing the costume of a bug. A control has to change ONE
// thing.
const without = timeInStage(ALL.filter((x) => x.id !== "r4"), FID, NAMES,
  { window: OCT, now: NOW });
ok("🔴 CONTROL — removing the approximate case changes no recorded figure",
  JSON.stringify(without.recorded) === JSON.stringify(t.recorded), {
    with: t.recorded.map((d) => [d.stageId, d.median]),
    without: without.recorded.map((d) => [d.stageId, d.median]),
  });
ok("…and the bucket is then empty", without.approximate.n === 0, without.approximate);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 4 · SPEED TO FIRST MOVE ═══");
// ═══════════════════════════════════════════════════════════════════════════
let sp = speedToFirstMove(ALL, FID, { window: OCT });
const rep = (id) => sp.perRep.find((r) => r.id === id);
ok("🔴 credited to the ROW's owner, not the record's",
  rep("u_a").n === 2 && rep("u_b").n === 1, sp.perRep);
ok("🔴 u_a: 30 and 31 days → median 30.5", rep("u_a").median === 30.5, rep("u_a"));
ok("🔴 u_b: one case at 30 days", rep("u_b").median === 30 && rep("u_b").avg === 30, rep("u_b"));
// 🔴 REVERT H'S GAP, CLOSED. The creation row is 1 minute after createdAt and
// the real move is 2 days after. Measuring from the creation row would read
// ~0.0 days; measuring from the move reads 2.
ok("🔴 the creation row is NOT the first move — u_d reads 2 days, not 0",
  rep("u_d")?.median === 2 && rep("u_d")?.n === 1, rep("u_d"));
ok("🔴 cases with no first move are counted and named, not dropped",
  sp.noFirstMove === 3 && sp.noFirstMoveIds.sort().join(",") === "r4,r5,r6", sp);
// ⚠️ r3's row belongs to u_a even though the RECORD is owned by u_b — the
// control that this is not reading `ownerId` off the record.
ok("🔴 CONTROL — r3 is credited to u_a, while the record belongs to u_b",
  rep("u_a").caseIds.includes("r3") && r3.ownerId === "u_b", {
    u_a: rep("u_a").caseIds, recordOwner: r3.ownerId,
  });

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 5 · WON / LOST, AND WHAT IT CANNOT SAY ═══");
// ═══════════════════════════════════════════════════════════════════════════
let wl = wonLost(ALL, { window: OCT });
const w = (id) => wl.perRep.find((r) => r.id === id);
ok("🔴 u_a: 1 won, 1 lost in October → 50%",
  w("u_a").won === 1 && w("u_a").lost === 1 && w("u_a").winRate === 50, w("u_a"));
ok("🔴 the September win is excluded by the window",
  !w("u_a").wonIds.includes("r6"), w("u_a").wonIds);
ok("🔴 the undated win is counted and named, never placed in a period",
  wl.undated === 1 && wl.undatedIds.join(",") === "r5", wl);
ok("an open case is in neither column",
  !JSON.stringify(wl.perRep).includes("r3"), wl.perRep);
// 🔴 THE CONTROL. 0% and "nothing closed" are different.
const none = wonLost([r3], { window: OCT });
ok("🔴 a rep who closed nothing has no row at all", none.perRep.length === 0, none);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 6 · 🔴 THE FILTERS MOVE EVERY NUMBER TOGETHER ═══");
// ═══════════════════════════════════════════════════════════════════════════
const sepF = stageFunnel(ALL, FID, STAGES, { window: SEP }).find((x) => x.pipelineId === P1);
const sepT = timeInStage(ALL, FID, NAMES, { window: SEP, now: NOW });
const sepS = speedToFirstMove(ALL, FID, { window: SEP });
const sepW = wonLost(ALL, { window: SEP });
ok("🔴 September: the funnel is empty", sepF.rows.every((r) => r.reached === 0), sepF.rows);
ok("🔴 September: no recorded interval", sepT.recorded.length === 0, sepT.recorded);
ok("🔴 September: nobody has a first move", sepS.perRep.length === 0, sepS.perRep);
ok("🔴 September: only the September win counts",
  sepW.perRep.length === 1 && sepW.perRep[0].won === 1 && sepW.perRep[0].lost === 0,
  sepW.perRep);
// ⚠️ THE SECOND PIPELINE'S CASE COUNTS IN THE GLOBAL TALLIES — three stages
// with intervals (A, B and P2's X) and three reps with a first move. Getting
// that wrong once is why this assertion names every figure rather than a total.
ok("🔴 CONTROL — and October was NOT empty, so the window is doing the work",
  row("A").reached === 3 && t.recorded.length === 3 && sp.perRep.length === 4 &&
  wl.perRep.length === 1, {
    funnel: row("A").reached, time: t.recorded.length,
    first: sp.perRep.length, wl: wl.perRep.length,
  });

// ⚠️ A PIPELINE FILTER IS THE CALLER FILTERING THE ARRAY, which is why there is
// no pipeline argument: "every number follows the filters" is then true by
// construction rather than by five functions remembering to.
const onlyP2 = ALL.filter((r) => r.pipelineId === P2);
ok("filtering the array to one pipeline narrows the funnel to it",
  stageFunnel(onlyP2, FID, STAGES, { window: OCT }).length === 1,
  stageFunnel(onlyP2, FID, STAGES, { window: OCT }).map((x) => x.pipelineId));
ok("…and every other number with it",
  speedToFirstMove(onlyP2, FID, { window: OCT }).perRep[0]?.id === "u_c",
  speedToFirstMove(onlyP2, FID, { window: OCT }).perRep);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 7 · THE RANGE WINDOWS ═══");
// ═══════════════════════════════════════════════════════════════════════════
const mid = Date.parse("2026-10-15T12:00:00.000Z"); // a Thursday
let r = rangeWindow("month", mid);
ok("this month spans the calendar month",
  r.from === "2026-10-01T00:00:00.000Z" && r.to === "2026-11-01T00:00:00.000Z", r);
r = rangeWindow("lastMonth", mid);
ok("last month is September", r.from === "2026-09-01T00:00:00.000Z" &&
  r.to === "2026-10-01T00:00:00.000Z", r);
r = rangeWindow("week", mid);
ok("🔴 the week starts on MONDAY, not Sunday",
  r.from === "2026-10-12T00:00:00.000Z" && r.to === "2026-10-19T00:00:00.000Z", r);
ok("'all recorded' is an open window, not a wide one",
  rangeWindow("all", mid).from === null && rangeWindow("all", mid).to === null,
  rangeWindow("all", mid));

// ═══════════════════════════════════════════════════════════════════════════
const total = pass + fail;
console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
console.log(`assertions: ${total}`);
process.exit(fail ? 1 : 0);
