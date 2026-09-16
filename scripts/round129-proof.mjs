// ---------------------------------------------------------------------------
// ROUND 129 — THE FOLDER MAP IS ABOUT ONE ACCOUNT, AND IT IS RUNNING ON TWO.
//
// 🔴 THE ASSERTION THIS ROUND IS JUDGED ON IS THE NO-OP, and it is written the
// way the brief demanded: render the SECTIONS on the main account's shape,
// before and after, and compare them — section labels and the field ids inside
// each, in order. Not a count of assertions. If this comes back different, the
// change does not ship.
//
// ⚠️ AND THE SECOND ACCOUNT IS DRIVEN FROM THE REAL IDS in the brief, so the
// "after" is checkable against a screen somebody has actually seen.
//
// Run: npx tsx scripts/round129-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const FF = await import("../lib/fieldFolders.ts");
const { FOLDERS, CONTACT_FOLDERS, groupContactFields, groupFieldsForPipeline,
        folderIdsPresent, builtInFoldersAreForeign, resolveFolderId } = FF;

// ── THE MAIN ACCOUNT: fields sitting in the folders the code map names ──────
// ⚠️ EVERY CONTACT FOLDER GETS TWO FIELDS, so a section that silently loses one
// is visible. Names are arbitrary; the ids are what the map keys on.
const mmContactDefs = CONTACT_FOLDERS.flatMap((f, i) => [
  { id: `c${i}a`, name: `${f.label} One`, parentId: f.id, parentName: "", dataType: "TEXT", editable: true, options: [] },
  { id: `c${i}b`, name: `${f.label} Two`, parentId: f.id, parentName: "", dataType: "TEXT", editable: true, options: [] },
]);
const mmOppDefs = Object.entries(FOLDERS).flatMap(([k, id], i) => [
  { id: `o${i}a`, name: `${k} One`, parentId: id, parentName: "", dataType: "TEXT", editable: true, options: [] },
  { id: `o${i}b`, name: `${k} Two`, parentId: id, parentName: "", dataType: "TEXT", editable: true, options: [] },
]);

/** Sections as a reader sees them: label, then the field ids inside, in order. */
const shape = (groups) =>
  groups.map((g) => `${g.label}::${(g.fields || []).map((f) => f.id).join(",")}`);

console.log("\n1 · 🔴 THE MAIN ACCOUNT — SECTIONS BEFORE AND AFTER");
console.log("  The 'before' is this build called the way it was called before this");
console.log("  round: no folderNames argument at all. The 'after' passes them.");
for (const kind of ["client", "caregiver"]) {
  // BEFORE — the old call signature, which is still the supported one.
  const before = shape(groupContactFields(mmContactDefs, kind));
  // AFTER — with the account's names available, as app/page.tsx now passes.
  const names = Object.fromEntries(CONTACT_FOLDERS.map((f) => [f.id, f.name]));
  const after = shape(groupContactFields(mmContactDefs, kind, undefined, names));
  console.log(`  ${kind}: ${before.length} section(s)`);
  for (const s of before) console.log(`     ${s}`);
  ok(`🔴 ${kind} — the SECTIONS are identical, label and fields`,
     JSON.stringify(before) === JSON.stringify(after), { before, after });
  ok(`⚠️ ${kind} — and it is not identically EMPTY, which would pass vacuously`,
     before.length > 0 && before.some((s) => s.includes("::c")), before);
}

// 🔴 THE OPPORTUNITY SIDE. Unchanged code, asserted anyway — the brief's
// constraint is about the record panel, and 596 records are behind it.
const stored = { pipe_mm: Object.keys(FOLDERS) };
// ⚠️ IT RETURNS { sections, systemInfo, orphans, … }, NOT AN ARRAY — the first
// version of this file assumed an array and crashed, which is the cheap kind of
// harness bug to have: loud, immediate, and not a false green.
const oppOut = groupFieldsForPipeline(mmOppDefs, "pipe_mm", stored);
const oppBefore = shape(oppOut.sections);
console.log(`\n  opportunity panel: ${oppBefore.length} section(s)`);
for (const s of oppBefore) console.log(`     ${s}`);
// ⚠️ ELEVEN, NOT TWELVE, AND THAT IS CORRECT. `lostReason` renders only for the
// field mapped to THIS pipeline via LOST_REASON_OVERRIDES (fieldFolders.ts:387)
// — a synthetic field id is in no override, so it is dropped. My first
// assertion here said ">= 12" and was wrong about the app, not the other way
// round.
ok("🔴 every code folder except Lost Reason draws its fields on the main account",
   oppBefore.length === Object.keys(FOLDERS).length - 1, oppBefore);
ok("⚠️ and the one missing IS Lost Reason, which is per-field not per-folder",
   !oppBefore.some((x) => x.startsWith("Lost Reason::")), oppBefore);
ok("⚠️ and nothing fell into the unfiled bucket",
   oppOut.orphans.length === 0, oppOut.orphans.map((f) => f.name));

// ── THE SECOND ACCOUNT: the real ids from the brief ────────────────────────
console.log("\n2 · 🔴 THE SECOND ACCOUNT — THE TWO LISTS WERE EXACTLY BACKWARDS");
const ODP_CONTACT = [
  ["mH8jBHSyYjyExCVfCJDN", "Caregiver Application", 22],
  ["gmLObr45Qs0wBSZnMWxz", "Caregiver Availability", 20],
  ["shTJKlO7xOFbW84ZMsLT", "Attribution", 19],
  ["6VFpXWVkHES4phGbGH0j", "Caregiver Compliance", 16],
  ["gp00Da6NoddygQiLzyrv", "Referral Partner", 4],
  ["njz27nPFIOmMYKUn3jLn", "Event Attendance", 3],
];
const odpDefs = ODP_CONTACT.flatMap(([id, name, n]) =>
  Array.from({ length: Math.min(n, 3) }, (_, i) => ({
    id: `${id}_${i}`, name: `${name} field ${i}`, parentId: id,
    parentName: "", dataType: "TEXT", editable: true, options: [],
  })),
);
// ⚠️ GoHighLevel returns `parentName` EMPTY on every contact field — measured
// live in round 55 — so the name path in the matcher is dead and the id is the
// only thing that can resolve. The fixture keeps it empty for that reason.
ok("🔴 not one built-in folder id exists on this account",
   builtInFoldersAreForeign(odpDefs), "some built-in id matched");

const odpBefore = shape(groupContactFields(odpDefs, "caregiver"));
console.log(`  before, with no names stored: ${odpBefore.length} section(s) — ${JSON.stringify(odpBefore)}`);
ok("🔴 which is the reported screen: every section empty",
   odpBefore.length === 0, odpBefore);

// The admin has named the account's folders on the Pipelines screen.
const odpNames = Object.fromEntries(ODP_CONTACT.map(([id, name]) => [id, name]));
const odpAfter = shape(groupContactFields(odpDefs, "caregiver", undefined, odpNames));
console.log(`  after, with the account's own names: ${odpAfter.length} section(s)`);
for (const s of odpAfter) console.log(`     ${s}`);
// ⚠️ FOUR, NOT THREE. Attribution is `appliesTo: "both"` — round 118, item 2 —
// so it belongs on a caregiver record as well. My first assertion said three
// and would have failed the very rule that round established.
ok("🔴 the caregiver sections resolve and hold their fields",
   odpAfter.length === 4 && odpAfter.every((x) => /::.+/.test(x)), odpAfter);
ok("⚠️ Caregiver Application, Compliance and Availability — all three",
   ["Caregiver Application", "Caregiver Compliance", "Caregiver Availability"]
     .every((l) => odpAfter.some((s) => s.startsWith(`${l}::`))), odpAfter);

const odpClient = shape(groupContactFields(odpDefs, "client", undefined, odpNames));
console.log(`  client side: ${JSON.stringify(odpClient)}`);
ok("⚠️ and the 'both' folders reach a client record too",
   odpClient.some((s) => /^(Referral Partner|Event Attendance|Attribution)::/.test(s)), odpClient);

console.log("\n3 · 🔴 THE RESOLVER'S ORDER OF PREFERENCE");
const here = folderIdsPresent(mmContactDefs);
ok("the built-in id wins when it exists here — the main account never changes",
   resolveFolderId(CONTACT_FOLDERS[0].id, ["something else"], here, { zzz: "x" })
     === CONTACT_FOLDERS[0].id, "built-in id lost");
ok("a named folder resolves only when it EXISTS here",
   resolveFolderId("", ["Ghost"], here, { not_here: "Ghost" }) === "", "resolved a folder with no fields");
ok("🔴 and an unresolvable folder returns \"\" rather than guessing",
   resolveFolderId("", ["Nothing Like This"], here, odpNames) === "", "guessed");

console.log("\n4 · 🔴 THE SEED AND THE BACKFILL NO LONGER CROSS ACCOUNTS");
const ghl = readFileSync("lib/ghl.ts", "utf8");
const code = ghl.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
console.log("  ⚠️ comments stripped — this file's prose names SEED_FOLDER_NAMES");
console.log("     repeatedly, and a raw match would pass on the bug.");
ok("🔴 the seed filters the folder names by what is present",
   /Object\.entries\(SEED_FOLDER_NAMES\)\.filter\(\(\[id\]\) => mine\(id\)\)/.test(code),
   "the seed still copies every name");
ok("🔴 the ticked folders are filtered too",
   /SEED_TICKED_ON_CLIENT\]\.filter\(mine\)/.test(code), "the ticks are unfiltered");
ok("🔴 and the per-pipeline folder lists are filtered BEFORE the key conversion",
   /mapped\.filter\(mine\)\.map\(\(fid\) => folderKeyById/.test(code),
   "keys are still written for folders that are not here");
ok("⚠️ the backfill that ran on EVERY read is gated on the same set",
   /!\(cfg\.folderNames \|\| \{\}\)\[id\] && !!present\?\.has\(id\)/.test(code),
   "the backfill still writes foreign names");
ok("⚠️ and a failed field read seeds NO folders rather than assuming ours",
   /catch \{\s*present = new Set<string>\(\);/.test(code), "an unknown read still seeds");

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
