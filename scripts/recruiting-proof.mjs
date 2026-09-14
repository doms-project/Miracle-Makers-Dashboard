// ---------------------------------------------------------------------------
// ROUND 120 · ITEM 1 — THE RECRUITING SWITCHER, FILTERED AT SOURCE.
//
// 🔴 THE POINT OF THIS ITEM IS **WHERE** THE FILTER LIVES. Round 113 broke the
// caregiver tile and round 114 the client board because the rule was a
// predicate every consumer had to remember. So this asserts the shape of the
// code as well as the behaviour: ONE filter, on the pipeline LIST, with every
// consumer keyed off `cgActivePipeline` which derives from it.
//
// Run: npx tsx scripts/recruiting-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
const C = await import("../lib/pipelineConfig.ts");

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

// 🔴 THE REAL FIVE. All caregiver-scope, which is the whole difficulty.
const CG = { pp: "EXVMveGzgDy9qf4wQR2H", odp: "232bytrK7FWNAwC6shME" };
const STAFF = { oltl: "JYIdBfNN8P17ivgnqVYA", pp: "lumhvu4sh08yFM8M2F4p", odp: "v1ei3K0OuGNXVJahwnw0" };

console.log("\n1 · 🔴 SCOPE CANNOT TELL THEM APART — ALL FIVE ARE caregiver");
const cfg = {
  seeded: true, folderNames: {},
  pipelines: {
    [CG.pp]: { scope: "caregiver", folders: ["lostReason"] },
    [CG.odp]: { scope: "caregiver", folders: ["lostReason"] },
    // ⚠️ The three new ones were created by script, so they have NO entry at
    // all until an admin opens the screen. Two are marked; one is left unset on
    // purpose, to prove what the default does.
    [STAFF.oltl]: { scope: "caregiver", folders: [], group: "staff" },
    [STAFF.pp]: { scope: "caregiver", folders: [], group: "staff" },
    [STAFF.odp]: { scope: "caregiver", folders: [] },
    pipe_client: { scope: "client", folders: ["shared"] },
  },
};
const round = C.parsePipelineConfig(C.serialisePipelineConfig(cfg));
const inScope = C.idsInScope(round, "caregiver");
console.log(`  caregiver-scope pipelines: ${inScope.length}`);
ok("all five applicant pipelines share one scope", inScope.length === 5, inScope);

console.log("\n2 · ✅ THE GROUP SURVIVES A ROUND TRIP, AND ABSENT MEANS caregiver");
console.log(`  stored: ${JSON.stringify(round.pipelines[STAFF.oltl])}`);
console.log(`  unset:  ${JSON.stringify(round.pipelines[STAFF.odp])}`);
ok("a marked staff pipeline keeps its group", round.pipelines[STAFF.oltl].group === "staff", round.pipelines[STAFF.oltl]);
ok("🔴 an UNSET entry stores no group at all — \"nobody chose\" stays visible",
   round.pipelines[STAFF.odp].group === undefined, round.pipelines[STAFF.odp]);
ok("🔴 and reads as caregiver through the ONE helper",
   C.recruitingGroup(round, STAFF.odp) === "caregiver", C.recruitingGroup(round, STAFF.odp));
ok("a marked one reads as staff", C.recruitingGroup(round, STAFF.oltl) === "staff", "staff");
ok("⚠️ and a pipeline with no entry at all also reads caregiver, not undefined",
   C.recruitingGroup(round, "never_seen") === "caregiver", C.recruitingGroup(round, "never_seen"));
ok("a garbage group is dropped, not stored",
   C.parsePipelineConfig(JSON.stringify({ seeded: true, pipelines: { x: { scope: "caregiver", folders: [], group: "banana" } } }))
     .pipelines.x.group === undefined, "banana survived");

console.log("\n3 · 🔴 WHAT EACH CHOICE SHOWS");
const groups = Object.fromEntries(
  Object.entries(round.pipelines)
    .filter(([, e]) => e.group === "staff")
    .map(([id]) => [id, "staff"]),
);
const pick = (g) =>
  inScope.filter((id) => g === "all" || (groups[id] === "staff" ? "staff" : "caregiver") === g);
for (const g of ["caregiver", "staff", "all"]) {
  const got = pick(g);
  console.log(`  ${g.padEnd(10)} ${got.length} pipeline(s)`);
}
// 🔴 THREE, NOT TWO — AND THIS ASSERTION CONTRADICTED THE ONE BELOW IT.
// The unset ODP Staff pipeline defaults to caregiver, which is the documented
// choice: 187 records live in the caregiver pipelines and nothing is in staff,
// so an undecided pipeline shows up rather than hiding behind a setting nobody
// has touched. "Two" was me asserting the behaviour I had just argued against.
ok("Caregivers shows the two applicant pipelines PLUS anything unset",
   pick("caregiver").length === 3, pick("caregiver"));
ok("⚠️ and the UNSET staff pipeline is among them — visible, not hidden",
   pick("caregiver").includes(STAFF.odp), pick("caregiver"));
ok("⚠️ one dropdown away from correct: marking it moves it",
   pick("staff").length === 2 && !pick("staff").includes(STAFF.odp), pick("staff"));
ok("Staff shows the two that were marked", pick("staff").length === 2, pick("staff"));
ok("All shows every one", pick("all").length === 5, pick("all"));
ok("🔴 and NO choice ever reaches a client pipeline",
   !pick("all").includes("pipe_client"), pick("all"));

console.log("\n4 · 🔴 THE FILTER IS AT SOURCE — ONE PLACE, NOT A PREDICATE");
const page = readFileSync("app/page.tsx", "utf8");
// 🔴 ASSERT POSITIVELY, AGAINST THE CODE THAT FILTERS — not by counting
// mentions. Two of my earlier attempts matched the switcher drawing itself,
// and one matched THIS FILE'S OWN COMMENT saying "not a <select>". A negative
// regex over prose is not evidence.
//
// `cgGroup` is legitimately read in exactly two kinds of place:
//   1. cgVisiblePipelines — the ONE filter
//   2. screenHeader       — the subtitle, which is the heading describing
//                           itself, not a rule any consumer applies
const memoSrc = page.slice(page.indexOf("const cgVisiblePipelines"), page.indexOf("const cgActivePipeline"));
const headerSrc = page.slice(page.indexOf("const screenHeader"), page.indexOf("const screenHeader") + 2200);
const bodyWithout = page.replace(memoSrc, "").replace(headerSrc, "");
// Everything left is the switcher's own JSX; nothing there may FILTER.
const straySources = [...bodyWithout.matchAll(/\.filter\([^)]*cgGroup(?!Key|Open)/g)];
console.log(`  filters outside the one memo: ${straySources.length}`);
ok("🔴 NOTHING outside cgVisiblePipelines filters on cgGroup",
   straySources.length === 0, straySources.map((m) => m[0]));
ok("and the memo does the filtering", /\.filter\(/.test(memoSrc) && /cgGroup/.test(memoSrc), memoSrc.slice(0, 80));
ok("⚠️ the subtitle reads it too — describing itself, not filtering",
   /cgGroup === "staff"/.test(headerSrc), "subtitle does not follow the switcher");
ok("and the memo short-circuits on All", /cgGroup === "all"/.test(memoSrc), "not in the memo");
ok("⚠️ the board still derives from cgActivePipeline, untouched",
   /r\.pipelineId === cgActivePipeline/.test(page), "board no longer keys off the active pipeline");
ok("🔴 and cgData is NOT filtered by group anywhere",
   !/cgData\.filter\([^)]*cgGroup/.test(page), "a second filter appeared on the records");

console.log("\n5 · ✅ THE SWITCHER REUSES THE REFERRALS CONTROL");
ok("it is the same classes, not a copy",
   /className="rfhead cghead"/.test(page) && /className="rfdivpop"/.test(page), "not reused");
// 🔴 POSITIVE, NOT NEGATIVE. "No <select> mentions cgGroup" matched this
// file's own comment explaining that it is not a select. What is checkable is
// the control that IS there: a button with aria-haspopup, and a listbox.
const sw = page.slice(page.indexOf('className="rfhead cghead"'), page.indexOf('className="rfhead cghead"') + 2600);
ok("🔴 it is a button with a listbox, like the Referrals switcher",
   /aria-haspopup="listbox"/.test(sw) && /role="listbox"/.test(sw) && /role="option"/.test(sw), "not a listbox");
ok("and the three choices are there",
   /"caregiver", "Caregivers"/.test(sw) && /"staff", "Staff"/.test(sw) && /"all", "All"/.test(sw), "choices missing");
ok("⚠️ while the board's own group-by select is untouched",
   /<select[^>]*cgGroupKey|cgGroupKey/.test(page), "the group-by disappeared");
ok("the subtitle changes with the choice", /Staff hires across your division/.test(page), "no subtitle");
ok("the rail says Recruiting", /<span>Recruiting<\/span>/.test(page), "rail not renamed");
const admin = readFileSync("components/PipelineAdmin.tsx", "utf8");
ok("⚠️ and the group is only offered on a CAREGIVER pipeline",
   /entry\?\.scope === "caregiver" \? \(/.test(admin), "offered on every scope");

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
