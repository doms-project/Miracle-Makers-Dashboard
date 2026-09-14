// ---------------------------------------------------------------------------
// ROUND 121b — THE THREE EMPTY STATES, AND THE TWO SETTINGS THAT SHARED A WORD.
//
// ⚠️ ITEMS 1 AND 2 ARE NOT RE-TESTED HERE — they are round 121's, and
// scripts/round121-proof.mjs already drives both against a fake that answers
// the real refusal. This covers only what 121b added.
//
// Run: npx tsx scripts/round121b-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
const C = await import("../lib/pipelineConfig.ts");

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};
const page = readFileSync("app/page.tsx", "utf8");
const admin = readFileSync("components/PipelineAdmin.tsx", "utf8");

// 🔴 THE DECISION, LIFTED OUT OF THE COMPONENT SO IT CAN BE DRIVEN. This is the
// same order the memo uses: group first, access second — because the group case
// can be true while the viewer's access is perfect, which is exactly the state
// that blamed the Access tab.
const whyEmpty = (group, pipelines, groups, granted) => {
  const inGroup =
    group === "all"
      ? pipelines
      : pipelines.filter((p) => (groups[p.id] === "staff" ? "staff" : "caregiver") === group);
  if (!inGroup.length) return "no-pipelines";
  const mine = inGroup.filter((p) => granted.includes(p.id));
  if (!mine.length) return "no-access";
  return "has-pipelines";
};

const CG = [{ id: "cg1" }, { id: "cg2" }];
const STAFF = [{ id: "st1" }, { id: "st2" }, { id: "st3" }];
const ALL = [...CG, ...STAFF];
const marked = { st1: "staff", st2: "staff", st3: "staff" };

console.log("\n1 · 🔴 THREE STATES, THREE ANSWERS");
console.log("  a) Staff, before any pipeline is marked — the state you hit");
ok("🔴 it is NOT an access problem",
   whyEmpty("staff", ALL, {}, ["cg1", "cg2", "st1"]) === "no-pipelines",
   whyEmpty("staff", ALL, {}, ["cg1", "cg2", "st1"]));
console.log("  b) Staff, marked, none granted to this viewer");
ok("that one IS an access problem",
   whyEmpty("staff", ALL, marked, ["cg1"]) === "no-access",
   whyEmpty("staff", ALL, marked, ["cg1"]));
console.log("  c) Staff, marked and granted — pipelines exist, records may not");
ok("neither sentence applies",
   whyEmpty("staff", ALL, marked, ["st1"]) === "has-pipelines",
   whyEmpty("staff", ALL, marked, ["st1"]));

console.log("\n  ⚠️ AND THE ORDER IS LOAD-BEARING:");
// With perfect access and nothing marked, an access-first test would blame the
// Access tab — which is precisely what happened live.
ok("🔴 perfect access + nothing marked still reads as no-pipelines",
   whyEmpty("staff", ALL, {}, ALL.map((p) => p.id)) === "no-pipelines", "blamed access");

console.log("\n2 · 🔴 THE CAREGIVERS SIDE CANNOT SHOW THE EMPTY STATE WITH 187 BEHIND IT");
// ⚠️ THE CHECK THE BRIEF ASKED FOR. Unset reads as caregiver, so the two real
// applicant pipelines are always IN that group — with or without a stored entry.
ok("unmarked pipelines land in Caregivers",
   whyEmpty("caregiver", ALL, {}, ["cg1"]) === "has-pipelines",
   whyEmpty("caregiver", ALL, {}, ["cg1"]));
ok("🔴 and marking every staff pipeline does not empty Caregivers",
   whyEmpty("caregiver", ALL, marked, ["cg1"]) === "has-pipelines",
   whyEmpty("caregiver", ALL, marked, ["cg1"]));
ok("⚠️ All is never empty while any pipeline is granted",
   whyEmpty("all", ALL, marked, ["st3"]) === "has-pipelines", "All went empty");
// The only honest way Caregivers empties is no grant at all — which IS access.
ok("with no grant at all it is an access problem, correctly",
   whyEmpty("caregiver", ALL, marked, []) === "no-access", "wrong cause");

console.log("\n3 · ✅ THE COPY NAMES THE GROUP, NOT \"caregiver and DSP\" ALWAYS");
ok("🔴 the old one-size sentence is gone",
   !/You&apos;ll see caregiver and DSP applicants here once an admin/.test(page), "still there");
ok("the empty state is computed, not hardcoded", /const recruitingEmpty = useMemo/.test(page), "not a memo");
ok("🔴 it names Staff specifically", /marks a pipeline as <b>Staff<\/b>/.test(page), "no staff wording");
ok("⚠️ and explains the unset default, which was the real cause",
   /A pipeline with no group set reads as\s*\n?\s*Caregivers/.test(page), "default unexplained");
ok("the access sentence survives for the case that IS access",
   /gives you access to\s*\n?\s*one in the Access tab/.test(page), "access wording lost");
ok("🔴 and it says how many exist, so \"none is yours\" is checkable",
   /pipeline\{inGroup\.length === 1 \? " exists" : "s exist"\}/.test(page), "no count");

console.log("\n4 · ✅ THE MIDDLE STATE — PIPELINES EXIST, RECORDS DO NOT");
ok("it renders when the payload is empty", /cgData\.length === 0 && !cgQuery\.trim\(\)/.test(page), "no middle state");
ok("🔴 and ONLY when nothing is narrowing the set",
   /!cgStage && !cgFocus/.test(page), "fires under a filter");
ok("⚠️ it says nothing is filtered out, which is the thing to rule out",
   /Nothing is filtered out\./.test(page), "no reassurance");

console.log("\n5 · ✅ TWO SETTINGS NO LONGER SHARE ONE WORD");
ok("🔴 the row header names the BOARD", /"Caregivers board"/.test(admin) && /"Clients board"/.test(admin), "still bare");
ok("⚠️ and the bare scope word is gone from the header",
   !/\? "no board picker"\s*\n\s*:\s*entry\.scope\}/.test(admin), "still renders entry.scope");
ok("the Recruiting group control is still its own labelled row",
   /Recruiting group/.test(admin), "label lost");

console.log("\n6 · ✅ AND ITEMS 1 AND 2 ARE ALREADY IN THE TREE (round 121)");
const ghl = readFileSync("lib/ghl.ts", "utf8");
const route = readFileSync("app/api/admin/pipelines/route.ts", "utf8");
ok("🔴 the move uses the location endpoint",
   /customFields\/\$\{encodeURIComponent\(fieldId\)\}/.test(ghl), "still on /custom-fields/");
// ⬜ ROUND 124 RETIRED THE OTHER TWO. They asserted the resume check and the
// skipped tick INSIDE the attribution migration, which is finished and whose
// button and route action are both deleted — a completed one-time migration
// left as a control is a hazard, not a feature. Replaced rather than removed,
// so nobody has to wonder whether they went red.
ok("🔴 the attribution migration is gone from the admin route",
   !/case "attribution-folder"/.test(route), "the action survives");
ok("⚠️ and the reasoning it existed for is kept on the screen",
   /so attribution can be shown on a client record without/.test(admin), "the sentence is gone");

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
