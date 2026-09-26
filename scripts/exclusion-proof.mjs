// ---------------------------------------------------------------------------
// ROUND 116 · ITEM Q — PER-FIELD EXCLUSIONS, AT THE FUNCTION THAT DRAWS PANELS.
//
// 🔴 THE SCREEN PROOF IS NOT ENOUGH FOR THIS ONE. The admin screen can show a
// tickbox and store an id and still be useless if `groupFieldsForPipeline` does
// not honour it — which is exactly round 113's item J: a checkbox that saved
// correctly and changed nothing on any record.
//
// So this asserts the PANEL, not the control:
//   · the six real Shared fields, on a caregiver pipeline, with two excluded
//   · a field ADDED IN GOHIGHLEVEL LATER appears without any config change
//     — the property an inclusion list would have destroyed
//   · excluding every field of a folder removes the SECTION, not just its rows
//   · an excluded field does NOT reappear under "Other"
//   · exclusions are per pipeline: the same folder, ticked on two pipelines
//   · the stored value round-trips through parse/serialise and drops empties
//
// Run: npx tsx scripts/exclusion-proof.mjs
// ---------------------------------------------------------------------------
const F = await import("../lib/fieldFolders.ts");
const C = await import("../lib/pipelineConfig.ts");

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

// 🔴 THE REAL FOLDER AND THE REAL SIX, verified live by the owner:
//   Case Manager · Sales Rep Assistant · County · Road Blocker · Office ·
//   Onboarding Rep
// and NONE of them describes an applicant. That is the whole of item Q.
const SHARED = "B6cunntgpATjWseEb1iC";
const CG_APP = "EeU1n8FZZ4WziJwsgwpX"; // a folder the config has never seen
const defs = [
  { id: "fld_cm",     name: "Case Manager",        parentId: SHARED, dataType: "TEXT",   position: 50 },
  { id: "fld_asst",   name: "Sales Rep Assistant", parentId: SHARED, dataType: "TEXT",   position: 100 },
  { id: "fld_county", name: "County",              parentId: SHARED, dataType: "TEXT",   position: 150 },
  { id: "fld_block",  name: "Road Blocker",        parentId: SHARED, dataType: "SINGLE_OPTIONS", position: 200 },
  { id: "fld_office", name: "Office",              parentId: SHARED, dataType: "SINGLE_OPTIONS", position: 250 },
  { id: "fld_onb",    name: "Onboarding Rep",      parentId: SHARED, dataType: "TEXT",   position: 300 },
];
// ⚠️ EVERY FIELD HOLDS A VALUE. A section with nothing filled in is not drawn
// at all (the round-92 rule), so an empty `values` map would make every one of
// these assertions pass for the wrong reason.
const values = Object.fromEntries(defs.map((d) => [d.id, "x"]));

const PIPE = "pipe_cg";
const folders = { [PIPE]: ["shared"], pipe_other: ["shared"] };
const names = (g) => g.sections.flatMap((s) => s.fields.map((f) => f.name));

console.log("\n1 · 🔴 WITHOUT EXCLUSIONS — ALL SIX CLIENT FIELDS ON AN APPLICANT");
const before = F.groupFieldsForPipeline(defs, PIPE, folders, { values });
console.log(`  Shared draws: ${names(before).join(" · ")}`);
ok("six fields drawn", names(before).length === 6, names(before));
ok("🔴 Road Blocker is on an applicant card", names(before).includes("Road Blocker"), names(before));

console.log("\n2 · ✅ WITH FOUR EXCLUDED — OFFICE AND ONBOARDING REP SURVIVE");
// The brief's own example: keep Office and Onboarding Rep, drop the rest.
const exclude = ["fld_block", "fld_cm", "fld_asst", "fld_county"];
const after = F.groupFieldsForPipeline(defs, PIPE, folders, { values, exclude });
console.log(`  Shared draws: ${names(after).join(" · ")}`);
ok("two fields drawn", names(after).length === 2, names(after));
ok("Office kept", names(after).includes("Office"), names(after));
ok("Onboarding Rep kept", names(after).includes("Onboarding Rep"), names(after));
ok("🔴 Road Blocker gone", !names(after).includes("Road Blocker"), names(after));
ok("🔴 County gone", !names(after).includes("County"), names(after));
// 🔴 THE ONE THAT MATTERS MOST. An excluded field surfacing under "Other" would
// put back on the card the exact thing the admin took off it.
const orphanNames = after.orphans.map((f) => f.name);
console.log(`  orphan bucket: ${orphanNames.length ? orphanNames.join(" · ") : "(empty)"}`);
ok("🔴 NOT re-surfaced as an orphan", after.orphans.length === 0, orphanNames);
ok("the section is still drawn", after.sections.length === 1, after.sections.map((s) => s.label));

console.log("\n3 · 🔴 A FIELD ADDED IN GOHIGHLEVEL TOMORROW APPEARS BY ITSELF");
// fieldFolders.ts:8 — "Adding/moving a field in GoHighLevel changes the panel
// with no code change." An INCLUSION list would have broken this: the new field
// would be invisible until somebody ticked it, and nobody would know to.
const later = [...defs, {
  id: "fld_new", name: "CG - Shift Preference", parentId: SHARED,
  dataType: "TEXT", position: 350,
}];
const grown = F.groupFieldsForPipeline(later, PIPE, folders, {
  values: { ...values, fld_new: "Nights" },
  exclude, // 🔴 UNCHANGED — the stored config knows nothing about the new field
});
console.log(`  Shared draws: ${names(grown).join(" · ")}`);
ok("🔴 the new field appears with NO config change", names(grown).includes("CG - Shift Preference"), names(grown));
ok("and the four exclusions still hold", names(grown).length === 3, names(grown));

console.log("\n4 · ✅ EXCLUDING EVERY FIELD REMOVES THE SECTION, NOT AN EMPTY HEADING");
const allOut = F.groupFieldsForPipeline(defs, PIPE, folders, {
  values, exclude: defs.map((d) => d.id),
});
console.log(`  sections: ${allOut.sections.length} · available: ${allOut.available.length} · orphans: ${allOut.orphans.length}`);
ok("no section drawn", allOut.sections.length === 0, allOut.sections);
ok("not offered under + Add a section either", allOut.available.length === 0, allOut.available);
ok("and nothing leaked to Other", allOut.orphans.length === 0, allOut.orphans);

console.log("\n5 · ✅ PER PIPELINE — THE SAME FOLDER, TWO DIFFERENT ANSWERS");
const other = F.groupFieldsForPipeline(defs, "pipe_other", folders, { values });
console.log(`  ${PIPE}: ${names(after).length} fields · pipe_other: ${names(other).length} fields`);
ok("🔴 the client pipeline is untouched by the caregiver's exclusions",
   names(other).length === 6, names(other));

console.log("\n6 · ✅ A FOLDER THE CONFIG HAS NEVER SEEN IS STILL ORPHANED, NOT DROPPED");
// ⚠️ The exclusion test sits BELOW the two name checks and ABOVE the folder
// rules; this proves it did not swallow the "never heard of it" path, which is
// how a field added to a NEW folder in GHL asks to be filed.
const loose = F.groupFieldsForPipeline(
  [...defs, { id: "fld_loose", name: "CG - Availability", parentId: CG_APP, dataType: "TEXT", position: 50 }],
  PIPE, folders, { values: { ...values, fld_loose: "y" }, exclude },
);
console.log(`  orphans: ${loose.orphans.map((f) => f.name).join(" · ") || "(empty)"}`);
ok("the unknown folder's field is surfaced", loose.orphans.some((f) => f.name === "CG - Availability"), loose.orphans.map((f) => f.name));
ok("and the excluded ones are still not there", !loose.orphans.some((f) => f.name === "Road Blocker"), loose.orphans.map((f) => f.name));

console.log("\n7 · ✅ THE STORED VALUE ROUND-TRIPS, AND DROPS WHAT IT DOES NOT NEED");
const cfg = {
  seeded: true,
  folderNames: {},
  pipelines: {
    [PIPE]: { scope: "caregiver", folders: ["shared"], exclude },
    pipe_other: { scope: "client", folders: ["shared"], exclude: [] },
    // 🔴 ITEM K — "none" MUST SURVIVE THE PARSER. Read as invalid it would DROP
    // the whole entry, taking its folder ticks and exclusions with it, and the
    // pipeline would silently fall back to Shared-only.
    pipe_events: { scope: "none", folders: ["shared", "eventDetail"] },
  },
};
const round = C.parsePipelineConfig(C.serialisePipelineConfig(cfg));
console.log(`  parsed: ${JSON.stringify(round.pipelines)}`);
ok("the exclusions survive", round.pipelines[PIPE].exclude.length === 4, round.pipelines[PIPE]);
ok("🔴 an EMPTY exclude list is dropped, not stored",
   round.pipelines.pipe_other.exclude === undefined, round.pipelines.pipe_other);
ok("🔴 scope \"none\" keeps its entry", round.pipelines.pipe_events?.scope === "none", round.pipelines.pipe_events);
ok("and keeps its two folder ticks", round.pipelines.pipe_events?.folders.length === 2, round.pipelines.pipe_events);
ok("a garbage scope is still dropped",
   C.parsePipelineConfig(JSON.stringify({ seeded: true, pipelines: { x: { scope: "banana", folders: [] } } })).pipelines.x === undefined,
   "x survived");

console.log("\n8 · 🔴 idsInScope — \"none\" IS LISTED BY NO BOARD");
const clientIds = C.idsInScope(round, "client");
const cgIds = C.idsInScope(round, "caregiver");
const noneIds = C.idsInScope(round, "none");
console.log(`  client: [${clientIds}] · caregiver: [${cgIds}] · none: [${noneIds}]`);
ok("the events pipeline is on NEITHER board",
   !clientIds.includes("pipe_events") && !cgIds.includes("pipe_events"), { clientIds, cgIds });
ok("and it is still addressable as \"none\"", noneIds.includes("pipe_events"), noneIds);
ok("exclusionsFor reads the set back", C.exclusionsFor(round, PIPE).has("fld_block"), [...C.exclusionsFor(round, PIPE)]);
ok("and is empty for a pipeline that hides nothing", C.exclusionsFor(round, "pipe_other").size === 0, [...C.exclusionsFor(round, "pipe_other")]);

console.log("\n9 · 🔴 ROUND 157 — \"Case Manager Followers\" IS NOT RENDERED AT ALL");
// 🔴 IT IS RULE B's MACHINE RECORD: a comma-separated list of user ids, read
// back on every apply so a removal can be surgical. It was visible on the
// panel because "who is watching this case" is a real question — but "Case
// Manager" answers it in names, the Followers control answers it from the live
// list, and `[casemgr]`'s steps beat raw ids for anyone debugging a removal.
//
// ⚠️ HIDDEN ENTIRELY, NOT MOVED TO System info. This asserts the difference,
// because "collapsed" and "absent" are easy to confuse in a grouping function
// and only one of them is what was asked for.
const cmfDefs = [
  ...defs,
  { id: "fld_cmf",  name: "Case Manager Followers", parentId: SHARED, dataType: "TEXT", position: 60 },
  { id: "fld_peer", name: "Peer Record Id",         parentId: SHARED, dataType: "TEXT", position: 70 },
];
const cmfValues = Object.fromEntries(cmfDefs.map((d) => [d.id, "x"]));
const g9 = F.groupFieldsForPipeline(cmfDefs, PIPE, folders, { values: cmfValues });
const sysNames9 = (g9.systemInfo || []).map((f) => f.name);
console.log(`  sections: ${JSON.stringify(names(g9))}`);
console.log(`  system info: ${JSON.stringify(sysNames9)}`);
ok("🔴 it is in NO section", !names(g9).includes("Case Manager Followers"), names(g9));
ok("🔴 and NOT in System info either — hidden, not collapsed",
   !sysNames9.includes("Case Manager Followers"), sysNames9);
// 🔴 THE CONTROLS. Without these the two above pass on a grouping function
// that has stopped returning anything, or one that hides everything.
ok("🔴 THE CONTROL — \"Case Manager\" is still rendered, in names, for people to read",
   names(g9).includes("Case Manager"), names(g9));
ok("🔴 THE CONTROL — \"Peer Record Id\" still goes to System info, so the two " +
   "treatments really are different",
   sysNames9.includes("Peer Record Id"), sysNames9);
ok("⚠️ and the Pipelines screen agrees it is intercepted, so no folder tickbox offers it",
   F.fieldIsAlwaysIntercepted("Case Manager Followers"), "fieldIsAlwaysIntercepted said no");

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
