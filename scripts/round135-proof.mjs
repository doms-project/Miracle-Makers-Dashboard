// ---------------------------------------------------------------------------
// TASK 1 · STEP 1 — THE FOURTH KEY SURVIVES A SAVE OF THE OTHER THREE.
//
// 🔴 THE BUG THIS FIXES WAS A LITERAL, NOT A SPREAD.
//
//   parseAccessValue  ghl.ts:2801   returned { pipelines, folders, master }
//   saveAccessGrantsV2 ghl.ts:2858  wrote    { pipelines, folders, master }
//
// Both named three keys. Store the case-manager map in that custom value as
// things stood, let anybody tick one box on the Access tab, and the map was
// gone — with a 200, and every case manager silently stopping.
//
// ⚠️ THE ASSERTION IS THE FIX. "I added the key in four places" is a claim.
// What is checked here is the round-129 shape: store a value carrying all four,
// save ONLY `pipelines`, re-read, and assert the other three came back
// BYTE-IDENTICAL — compared as the JSON actually stored, not as a count.
//
// 🔴 AND IT IS CHECKED AGAINST THE BYTES THE FAKE HOLDS, not against the
// object the function returned. A save that returned the right thing and wrote
// the wrong thing is precisely the failure being guarded, so the source of
// truth here is the custom value's stored string.
//
// ⚠️ EVERY READ IS NULL-SAFE, DELIBERATELY. The first version threw a
// TypeError on the old code the moment `caseManagers` came back undefined — so
// it proved the regression existed and then said nothing about the other five
// things it checks. A proof that dies at the first failure reports one symptom
// of a fault that may have several.
//
// Run: npx tsx scripts/round135-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
const CV_NAME = "MM Pipeline Access";

/** The account's stored value, as a STRING — what GoHighLevel actually holds. */
let storedValue = JSON.stringify({
  pipelines: { u_rep: ["pipe_oltl"] },
  folders: { u_cm: ["folder_compliance"] },
  master: ["u_boss"],
  caseManagers: {
    VkvEW5dTHant8jOXAU4r: ["V0gYK3HpF1Tan7Uv0Jcp", "WiFUXs6SShLwFB0Z5enR"],
    RBgFWgr3hpff8ejCQ3zS: ["V0gYK3HpF1Tan7Uv0Jcp", "WiFUXs6SShLwFB0Z5enR"],
    RZZ8IkAYgUzawNDgvcj4: ["hptqeBiFG307OqRQBWWF"],
    "9HN9EobwrCV9V7F0lzV7": ["ZcQ068JfdPGp9hhFhyeB"],
    UjNG7eBJbdy9BXcvyWvl: ["E3nlUhAxGjoVHsKdhu2J"],
  },
});
const writes = [];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const j = raw ? JSON.parse(raw) : null;
    const [path] = req.url.split("?");
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (path === `/locations/${LOC}/customValues` && req.method === "GET")
      return send(200, { customValues: [{ id: "cv1", name: CV_NAME, value: storedValue }] });
    if (/^\/locations\/[^/]+\/customValues\/[^/]+$/.test(path) && req.method === "PUT") {
      writes.push(j);
      if (typeof j?.value === "string") storedValue = j.value;   // as GHL does
      return send(200, { customValue: { id: "cv1", value: storedValue } });
    }
    if (path === `/locations/${LOC}/customValues` && req.method === "POST") {
      writes.push(j);
      if (typeof j?.value === "string") storedValue = j.value;
      return send(200, { customValue: { id: "cv1" } });
    }
    send(404, { message: `no fake handler for ${req.url}` });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;

const ghl = await import("../lib/ghl.ts");

console.log("\n═══ 1 · THE READ KEEPS THE FOURTH KEY ═══");
const before = await ghl.fetchAccessGrantsV2();
console.log(`  keys: ${JSON.stringify(Object.keys(before ?? {}))}`);
ok("🔴 `caseManagers` survives parseAccessValue",
   !!before?.caseManagers && Object.keys(before.caseManagers).length === 5,
   before?.caseManagers);
ok("⚠️ and the ids came through intact, arrays and all",
   before?.caseManagers?.VkvEW5dTHant8jOXAU4r?.join() ===
     "V0gYK3HpF1Tan7Uv0Jcp,WiFUXs6SShLwFB0Z5enR",
   before?.caseManagers?.VkvEW5dTHant8jOXAU4r);
ok("the other three are unchanged by the parse",
   JSON.stringify(before?.pipelines) === '{"u_rep":["pipe_oltl"]}' &&
   JSON.stringify(before?.folders) === '{"u_cm":["folder_compliance"]}' &&
   JSON.stringify(before?.master) === '["u_boss"]', before);

console.log("\n═══ 2 · 🔴 SAVE ONLY `pipelines` — THE ACCESS TAB'S EVERYDAY WRITE ═══");
const beforeBytes = JSON.parse(storedValue);
await ghl.savePipelineAccessGrants({ u_rep: ["pipe_oltl", "pipe_pp"] });
const afterBytes = JSON.parse(storedValue);
console.log(`  stored keys after: ${JSON.stringify(Object.keys(afterBytes))}`);
ok("the pipeline grant it MEANT to change did change",
   JSON.stringify(afterBytes.pipelines) === '{"u_rep":["pipe_oltl","pipe_pp"]}',
   afterBytes.pipelines);
// 🔴 THE LOAD-BEARING THREE. Compared as stored JSON, not as a count.
ok("🔴 `caseManagers` came back BYTE-IDENTICAL",
   JSON.stringify(afterBytes.caseManagers) === JSON.stringify(beforeBytes.caseManagers),
   { before: beforeBytes.caseManagers, after: afterBytes.caseManagers });
ok("🔴 `folders` byte-identical",
   JSON.stringify(afterBytes.folders) === JSON.stringify(beforeBytes.folders),
   afterBytes.folders);
ok("🔴 `master` byte-identical",
   JSON.stringify(afterBytes.master) === JSON.stringify(beforeBytes.master),
   afterBytes.master);
ok("⚠️ and exactly one write was sent — no read-modify-write loop",
   writes.length === 1, writes.length);

console.log("\n═══ 3 · AND THE OTHER THREE DIRECTIONS ═══");
// Saving folders must not wipe caseManagers either, and vice versa.
await ghl.saveAccessGrantsV2({ folders: { u_cm: ["folder_a", "folder_b"] } });
let now = JSON.parse(storedValue);
ok("saving FOLDERS leaves caseManagers intact",
   JSON.stringify(now.caseManagers) === JSON.stringify(beforeBytes.caseManagers), now.caseManagers);
await ghl.saveAccessGrantsV2({ master: ["u_boss", "u_two"] });
now = JSON.parse(storedValue);
ok("saving MASTER leaves caseManagers intact",
   JSON.stringify(now.caseManagers) === JSON.stringify(beforeBytes.caseManagers), now.caseManagers);
await ghl.saveAccessGrantsV2({ caseManagers: { u_new: ["u_mgr"] } });
now = JSON.parse(storedValue);
ok("🔴 and saving caseManagers leaves the OTHER THREE intact — it is not special",
   JSON.stringify(now.pipelines) === '{"u_rep":["pipe_oltl","pipe_pp"]}' &&
   JSON.stringify(now.folders) === '{"u_cm":["folder_a","folder_b"]}' &&
   JSON.stringify(now.master) === '["u_boss","u_two"]', now);
ok("⚠️ and it replaced the map rather than merging into it — a removed rep goes",
   JSON.stringify(now.caseManagers) === '{"u_new":["u_mgr"]}', now.caseManagers);

console.log("\n═══ 4 · 🔴 THE RECOGNITION FIX ═══");
// A value holding ONLY caseManagers. Before the fix this fell through to the
// legacy branch and was read as a FLAT PIPELINE MAP — every rep id becoming a
// grant of the manager ids as though they were pipeline ids.
const onlyCm = ghl.parseAccessValue(
  JSON.stringify({ caseManagers: { u_rep: ["u_mgr_a", "u_mgr_b"] } }),
);
console.log(`  parsed: ${JSON.stringify(onlyCm)}`);
ok("🔴 it is read as v2, not as a legacy flat map",
   JSON.stringify(onlyCm?.caseManagers) === '{"u_rep":["u_mgr_a","u_mgr_b"]}', onlyCm);
ok("🔴 and NOTHING landed in `pipelines` — the bug this prevents",
   JSON.stringify(onlyCm?.pipelines) === "{}", onlyCm?.pipelines);

console.log("\n═══ 5 · ⚠️ NOTHING ELSE MOVED ═══");
const legacy = ghl.parseAccessValue(JSON.stringify({ u_rep: ["pipe_a", "pipe_b"] }));
ok("a legacy FLAT map still reads as pipelines",
   JSON.stringify(legacy?.pipelines) === '{"u_rep":["pipe_a","pipe_b"]}', legacy);
ok("⚠️ and now carries an empty caseManagers rather than undefined",
   JSON.stringify(legacy?.caseManagers) === "{}", legacy?.caseManagers);
const emptyObj = ghl.parseAccessValue("{}");
ok("an empty object is still a REAL state, not 'missing'",
   !!emptyObj && JSON.stringify(emptyObj.pipelines) === "{}", emptyObj);
ok("garbage is still null", ghl.parseAccessValue("not json") === null, "parsed something");
// ⚠️ asIdMap's own guard, inherited for free: a non-array value is dropped
// rather than stored as a string that later code would iterate per character.
const junk = ghl.parseAccessValue(JSON.stringify({ caseManagers: { u_rep: "u_mgr" } }));
ok("⚠️ a non-array value in the map is dropped, not stored as a string",
   JSON.stringify(junk?.caseManagers) === "{}", junk?.caseManagers);

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
