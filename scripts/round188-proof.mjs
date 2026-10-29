// ---------------------------------------------------------------------------
// ROUND 188 PROOF — the Clients and Recruiting boards filter by created date,
// in EASTERN calendar days (the date each card shows).
// Run: npx tsx scripts/round188-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
const C = await import("../lib/createdRange.ts");

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("1 · Eastern days, not UTC");
ok("11:30pm EDT on Oct 28 is Oct 28 (UTC says Oct 29)", C.easternDayKey("2026-10-29T03:30:00Z") === "2026-10-28", C.easternDayKey("2026-10-29T03:30:00Z"));
ok("11:30pm EST on Nov 1, the night the clocks change, is Nov 1", C.easternDayKey("2026-11-02T04:30:00Z") === "2026-11-01", C.easternDayKey("2026-11-02T04:30:00Z"));
ok("an unreadable date gives no day", C.easternDayKey("not a date") === "" && C.easternDayKey(undefined) === "");

console.log("2 · The ranges (a Thursday afternoon, 29 Oct 2026)");
const now = new Date("2026-10-29T19:00:00Z");
ok("Today", eq(C.createdWindow("today", now), { from: "2026-10-29", to: "2026-10-29" }), C.createdWindow("today", now));
ok("This week is Monday 26 Oct to Sunday 1 Nov", eq(C.createdWindow("week", now), { from: "2026-10-26", to: "2026-11-01" }), C.createdWindow("week", now));
ok("This month is 1–31 Oct", eq(C.createdWindow("month", now), { from: "2026-10-01", to: "2026-10-31" }), C.createdWindow("month", now));
ok("Last month is 1–30 Sep", eq(C.createdWindow("lastMonth", now), { from: "2026-09-01", to: "2026-09-30" }), C.createdWindow("lastMonth", now));
ok("Any time narrows nothing", !C.windowActive(C.createdWindow("all", now)));
const jan = new Date("2027-01-15T15:00:00Z");
ok("in January, Last month is December of the year before", eq(C.createdWindow("lastMonth", jan), { from: "2026-12-01", to: "2026-12-31" }), C.createdWindow("lastMonth", jan));
const sunNight = new Date("2026-11-02T03:00:00Z"); // Sun 1 Nov, 10pm EST
ok("late Sunday evening Eastern is still the same week", eq(C.createdWindow("week", sunNight), { from: "2026-10-26", to: "2026-11-01" }), C.createdWindow("week", sunNight));
const lateToday = new Date("2026-10-30T02:00:00Z"); // Thu 29 Oct, 10pm EDT
ok("'Today' at 10pm Eastern is still today, not UTC's tomorrow", eq(C.createdWindow("today", lateToday), { from: "2026-10-29", to: "2026-10-29" }), C.createdWindow("today", lateToday));

console.log("3 · Custom range");
ok("both ends", eq(C.createdWindow("custom", now, "2026-10-01", "2026-10-15"), { from: "2026-10-01", to: "2026-10-15" }));
ok("typed backwards is read forwards", eq(C.createdWindow("custom", now, "2026-10-15", "2026-10-01"), { from: "2026-10-01", to: "2026-10-15" }));
ok("an open end is allowed", eq(C.createdWindow("custom", now, "2026-10-01", ""), { from: "2026-10-01", to: null }));
ok("nothing typed yet narrows nothing", !C.windowActive(C.createdWindow("custom", now, "", "")));

console.log("4 · Matching a record");
const today = C.createdWindow("today", now);
ok("a case created at 9pm EDT today is in Today", C.inCreatedWindow("2026-10-30T01:00:00Z", today));
ok("a case created yesterday is not", !C.inCreatedWindow("2026-10-28T15:00:00Z", today));
ok("both ends of a range are included", C.inCreatedWindow("2026-10-01T12:00:00Z", C.createdWindow("month", now)) && C.inCreatedWindow("2026-10-31T23:00:00Z", C.createdWindow("month", now)));
ok("with a filter on, a record with no date is left out (and counted by the board)", !C.inCreatedWindow(undefined, today));
ok("with no filter, a record with no date stays", C.inCreatedWindow(undefined, C.createdWindow("all", now)));
ok("the 'nothing matches' message names the filter", C.describeWindow("lastMonth", C.createdWindow("lastMonth", now)) === "created last month");

console.log("5 · Wired into both boards");
const src = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const block = (start, len = 2500) => src.slice(src.indexOf(start), src.indexOf(start) + len);
ok("Clients list/board/tiles (preSrc) filter by it", /inCreatedWindow\(r\.createdAt, clientWin\)/.test(block("const preSrc = useMemo")));
ok("the Master board filters by it too, like Office", /inCreatedWindow\(r\.createdAt, clientWin\)/.test(block("const match = (r: OpportunityRecord) =>", 300)));
ok("Recruiting (cgPreStage) filters by its own", /inCreatedWindow\(r\.createdAt, cgWin\)/.test(block("const cgPreStage = useMemo", 400)));
ok("both toolbars render the Created control", /<CreatedFilter\s+id="createdSel"/.test(src) && /<CreatedFilter\s+id="cgCreatedSel"/.test(src));
ok("the two sides keep separate state", /setCreatedRange/.test(src) && /setCgCreatedRange/.test(src) && /createdWindow\(cgCreatedRange/.test(src));
ok("'Nothing matches' names the date filter", /describeWindow\(createdRange, clientWin\)/.test(src));

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
