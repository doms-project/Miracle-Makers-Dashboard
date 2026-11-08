// ---------------------------------------------------------------------------
// ROUND 191 PROOF — newest activity first, and the date-filter fixes.
//
//   1. lib/activity.ts — the order: a new lead, an edited case, a stage or
//      status change, and a returning person's case all go to the top.
//   2. lib/createdRange.ts — "today" can be given as a day key, so a window
//      moves to the new Eastern day at midnight.
//   3. app/page.tsx — wiring: every view reads the activity order, every
//      window reads the day key, the "no date" counts use the other filters,
//      and Recruiting names its date filter.
//
// Run: npx tsx scripts/round191-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
const A = await import("../lib/activity.ts");
const C = await import("../lib/createdRange.ts");

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${got === undefined ? "" : `\n       got: ${JSON.stringify(got)}`}`); }
};
const ids = (rows) => rows.map((r) => r.id);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("1 · Newest activity first (lib/activity.ts)");
{
  const old = { id: "old", createdAt: "2026-09-01T14:00:00Z" };
  const mid = { id: "mid", createdAt: "2026-10-01T14:00:00Z" };
  const fresh = { id: "new", createdAt: "2026-10-30T14:00:00Z" };
  ok("a new lead is on top", ids(A.byLatestActivity([old, mid, fresh]))[0] === "new", ids(A.byLatestActivity([old, mid, fresh])));

  const edited = { ...old, updatedAt: "2026-10-31T09:00:00Z" };
  ok("an old case edited today goes above a newer case", eq(ids(A.byLatestActivity([mid, fresh, edited])), ["old", "new", "mid"]), ids(A.byLatestActivity([mid, fresh, edited])));

  const moved = { ...old, stageChangedAt: "2026-10-31T10:00:00Z" };
  ok("a stage move counts as activity (works before the server sends updatedAt)", ids(A.byLatestActivity([fresh, moved]))[0] === "old");
  const won = { ...old, statusChangedAt: "2026-10-31T11:00:00Z" };
  ok("a status change counts as activity", ids(A.byLatestActivity([fresh, won]))[0] === "old");

  // The two cases the owner described.
  // (a) The same person fills in the SAME pipeline's form again: GoHighLevel's
  //     Create/Update Opportunity step updates the case they already have.
  const returning = { id: "returning", createdAt: "2026-08-15T14:00:00Z", updatedAt: "2026-10-31T12:00:00Z" };
  ok("(a) a returning person's existing case jumps above today's new leads", ids(A.byLatestActivity([fresh, mid, returning]))[0] === "returning");
  // (b) A person with an ODP case fills in the OLTL form: a SECOND case, in the
  //     OLTL pipeline. The new one is on top; the ODP case keeps its place.
  const odp = { id: "odp-case", pipelineId: "ODP", createdAt: "2026-09-20T14:00:00Z" };
  const oltl = { id: "oltl-case", pipelineId: "OLTL", createdAt: "2026-10-31T13:00:00Z" };
  const out = ids(A.byLatestActivity([mid, odp, oltl]));
  ok("(b) the new OLTL case is on top and the ODP case is not lost", out[0] === "oltl-case" && out.includes("odp-case"), out);

  const t1 = { id: "a", createdAt: "2026-10-01T00:00:00Z" };
  const t2 = { id: "b", createdAt: "2026-10-01T00:00:00Z" };
  ok("a tie keeps the server's order (stable)", eq(ids(A.byLatestActivity([t1, t2])), ["a", "b"]) && eq(ids(A.byLatestActivity([t2, t1])), ["b", "a"]));
  const none = { id: "none" };
  const bad = { id: "bad", createdAt: "not a date" };
  ok("a record with no readable date goes last, not first", eq(ids(A.byLatestActivity([none, bad, old])), ["old", "none", "bad"]), ids(A.byLatestActivity([none, bad, old])));
  const input = [old, fresh];
  A.byLatestActivity(input);
  ok("the input is not reordered in place", eq(ids(input), ["old", "new"]));
}

console.log("2 · \"Today\" follows the Eastern day (lib/createdRange.ts)");
{
  ok("a day key is accepted as today", eq(C.createdWindow("today", "2026-10-30"), { from: "2026-10-30", to: "2026-10-30" }), C.createdWindow("today", "2026-10-30"));
  const before = C.createdWindow("today", C.easternDayKey(new Date("2026-10-31T03:59:00Z"))); // 11:59pm EDT, 30 Oct
  const after = C.createdWindow("today", C.easternDayKey(new Date("2026-10-31T04:01:00Z"))); // 12:01am EDT, 31 Oct
  ok("one minute past Eastern midnight, Today is the new day", before.from === "2026-10-30" && after.from === "2026-10-31", { before, after });
  ok("a Date still works as before", eq(C.createdWindow("lastMonth", new Date("2026-10-29T19:00:00Z")), { from: "2026-09-01", to: "2026-09-30" }));
  ok("This month from a day key", eq(C.createdWindow("month", "2026-11-01"), { from: "2026-11-01", to: "2026-11-30" }), C.createdWindow("month", "2026-11-01"));
}

console.log("3 · Wired into the page");
const src = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const at = (start, len) => { const i = src.indexOf(start); return i < 0 ? "" : src.slice(i, i + len); };
{
  ok("the client views read the activity order", /const dataByActivity = useMemo\(\(\) => byLatestActivity\(data\), \[data\]\)/.test(src) && /return dataByActivity\.filter\(/.test(at("const clientPreOwner = useMemo", 400)) /* round 193 renamed the block */);
  ok("Master's columns read the activity order", /for \(const r of dataByActivity\)/.test(at("const masterColumns = useMemo", 1200)));
  ok("Recruiting reads the activity order", /const cgByActivity = useMemo\(\(\) => byLatestActivity\(cgData\)/.test(src) && /return cgByActivity\.filter\(/.test(at("const cgPreOwner = useMemo", 400)) /* round 195 */);
  ok("a Sort the viewer picks still wins over it", /if \(!sortKey\) return base;/.test(src) && /if \(!cgSortKey\) return cgFocused;/.test(src));
  ok("both Sort menus call the default \"Latest activity\"", (src.match(/<option value="">Latest activity<\/option>/g) || []).length === 2 && !/Default order/.test(src));

  ok("🔴 all three windows read the day key, none a one-off new Date()",
    /createdWindow\(createdRange, todayKey,/.test(src) && /createdWindow\(masterCreatedRange, todayKey,/.test(src) &&
    /createdWindow\(cgCreatedRange, todayKey,/.test(src) && !/createdWindow\([a-zA-Z]+, new Date\(\)/.test(src));
  ok("the day key is re-read every minute and when the tab is shown again", /setInterval\(tick, 60_000\)/.test(at("function useEasternToday", 900)) && /visibilitychange/.test(at("function useEasternToday", 900)));

  ok("Clients' no-date count uses the other client filters", /clientNoDate\.filter\(\(r\) => !easternDayKey\(r\.createdAt\)\)/.test(src) && /clientNoDate\.filter\(\(r\) => inCreatedWindow\(r\.createdAt, clientWin\)\)/.test(src));
  const mu = at("const masterUndated = useMemo", 600);
  ok("Master's no-date count applies its search, office and tile", /office === "all" \|\| r\.office === office/.test(mu) && /masterFocused\(r\)/.test(mu) && /matchesQuery\(masterIx\.get\(r\.id\), qParsed\)/.test(mu) /* round 195's matcher */);
  ok("Master's columns use the same tile predicate", /masterFocused\(r\)/.test(at("const masterColumns = useMemo", 600)));
  ok("Recruiting's no-date count honours the search", /cgNoDate\.filter\(\(r\) => !easternDayKey\(r\.createdAt\)\)/.test(src) && /cgParsed/.test(at("const cgPreOwner = useMemo", 400)) /* round 195's matcher */);

  ok("🔴 Recruiting's count line names its date filter, with a way to clear it", /\{cgDateLabel \? \(/.test(src) && /Show all dates/.test(src) && /setCgCreatedRange\("all"\)/.test(at("{cgDateLabel ? (", 600)));
  ok("Recruiting's empty list says which filters are on", /if \(cgDateLabel\) on\.push\(cgDateLabel\)/.test(at(`No {cgNoun.many} match this filter.`, 700)));
  ok("Master's Clear filters says it also clears the shared search and office", /title="Also clears the search, office, sales rep and case manager on the Clients board/ /* round 195 */.test(src));
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
