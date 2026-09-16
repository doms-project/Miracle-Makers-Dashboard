// ---------------------------------------------------------------------------
// ROUND 127 · ITEM 1 — ONE SOURCE OF TRUTH FOR "IS THIS PIPELINE LOADED".
//
// 🔴 THE FIXTURE IS THE LIVE FAULT, REPRODUCED: the environment lists hold the
// two ORIGINAL caregiver ids, and the three staff pipelines exist only in the
// stored config — which is exactly the account's state. A fixture whose env
// list already contained them would have proved nothing at all.
//
// ⚠️ AND IT DRIVES THE ROUTE, not the helper. The bug was never in how a scope
// is stored; it was one screen asking a different question of a different
// source and quietly getting a different answer.
//
// Run: npx tsx scripts/round127-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { readFileSync } from "node:fs";
import CryptoJS from "crypto-js";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const ADMIN = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Admin", email: "a@e.com", companyId: "co1",
}), SECRET).toString();

// ── the account, as it actually is ─────────────────────────────────────────
// cg1/cg2 are the two ORIGINAL caregiver pipelines and are in the env list.
// st1..st3 were created by script and exist only in the stored config.
const PIPES = [
  { id: "pipe_pp", name: "Private Pay Clients", entry: { scope: "client", folders: [] } },
  { id: "cg1", name: "PP Caregiver Applicants", entry: { scope: "caregiver", folders: [] } },
  { id: "cg2", name: "ODP DSP Applicant", entry: { scope: "caregiver", folders: [] } },
  { id: "st1", name: "OLTL Staff Applicants", entry: { scope: "caregiver", folders: [], group: "staff" } },
  { id: "st2", name: "PP Staff Applicants", entry: { scope: "caregiver", folders: [], group: "staff" } },
  { id: "st3", name: "ODP Staff Applicants", entry: { scope: "caregiver", folders: [], group: "staff" } },
  // ⚠️ The Events pipeline: listed by NO board picker, and fetched anyway —
  // by the Referrals tab, because it carries the role. A grant on it counts.
  { id: "pipe_ev", name: "Events", entry: { scope: "none", folders: [], role: "events" } },
  // ⚠️ Listed by no picker AND no role: nothing fetches it, so a grant here
  // genuinely has no effect and the badge is correct.
  { id: "pipe_park", name: "Parked Pipeline", entry: { scope: "none", folders: [] } },
  // ⚠️ No stored entry at all — the case the badge was originally written for.
  { id: "pipe_new", name: "Something Somebody Just Made", entry: null },
];

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const server = http.createServer((req, res) => {
  const [path] = req.url.split("?");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (path === "/opportunities/pipelines")
      return json(res, 200, { pipelines: PIPES.map((p) => ({
        id: p.id, name: p.name, stages: [{ id: `${p.id}_s`, name: "NEW LEAD", position: 0 }] })) });
    if (path === `/locations/${LOC}/customValues`)
      return json(res, 200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({
          seeded: true, folderNames: {},
          pipelines: Object.fromEntries(
            PIPES.filter((p) => p.entry).map((p) => [p.id, p.entry]),
          ),
        }) }] });
    if (path.startsWith("/users/")) return json(res, 200, { users: [{ id: "u1", name: "Admin" }] });
    if (path.startsWith("/locations/") && path.includes("/media"))
      return json(res, 200, { files: [] });
    if (path === `/locations/${LOC}/customFields`) return json(res, 200, { customFields: [] });
    return json(res, 200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.GHL_SSO_SECRET = SECRET;
// 🔴 THE ENV LIST IS THE OLD, WRONG ANSWER — the two originals and nothing
// else, which is the default the account is running on.
process.env.CAREGIVER_PIPELINE_IDS = "cg1,cg2";
process.env.PIPELINE_IDS = "pipe_pp";

const access = await import("../app/api/admin/pipeline-access/route.ts");
const r = await access.GET(
  new Request("http://x/api/admin/pipeline-access", { headers: { "x-ghl-sso-key": ADMIN } }),
);
const body = await r.json();
const by = Object.fromEntries((body.pipelines || []).map((p) => [p.id, p]));

console.log("\n1 · 🔴 THE THREE STAFF PIPELINES WERE 'not loaded' ON THIS SCREEN ALONE");
for (const id of ["st1", "st2", "st3"])
  console.log(`  ${by[id]?.name.padEnd(24)} inDashboard=${by[id]?.inDashboard}`);
ok("🔴 all three staff pipelines are loaded",
   ["st1", "st2", "st3"].every((id) => by[id]?.inDashboard === true),
   ["st1", "st2", "st3"].map((id) => by[id]));
console.log("  ⚠️ and NONE of them is in CAREGIVER_PIPELINE_IDS, which is set to");
console.log(`     "${process.env.CAREGIVER_PIPELINE_IDS}" — the account's default. Reading the env`);
console.log("     list is what reported them absent while four other surfaces drew them.");
ok("the two original caregiver pipelines are still loaded",
   by.cg1?.inDashboard === true && by.cg2?.inDashboard === true, [by.cg1, by.cg2]);
ok("and so is the client pipeline", by.pipe_pp?.inDashboard === true, by.pipe_pp);

console.log("\n2 · ⚠️ 'LOADED' MEANS SOMETHING FETCHES IT — NOT 'IT HAS AN ENTRY'");
console.log(`  ${by.pipe_ev?.name.padEnd(24)} scope none + events role -> ${by.pipe_ev?.inDashboard}`);
console.log(`  ${by.pipe_park?.name.padEnd(24)} scope none, no role     -> ${by.pipe_park?.inDashboard}`);
console.log(`  ${by.pipe_new?.name.padEnd(24)} no entry at all         -> ${by.pipe_new?.inDashboard}`);
ok("🔴 a 'none' pipeline carrying the events role IS loaded — Referrals reads it",
   by.pipe_ev?.inDashboard === true, by.pipe_ev);
ok("⚠️ a 'none' pipeline with no role is NOT — nothing fetches its records",
   by.pipe_park?.inDashboard === false, by.pipe_park);
ok("and one with no stored entry is not either", by.pipe_new?.inDashboard === false, by.pipe_new);

console.log("\n3 · 🔴 AND THE BADGE NAMES A FIX THE ADMIN CAN ACTUALLY MAKE");
console.log(`  parked : ${by.pipe_park?.notLoadedWhy}`);
console.log(`  new    : ${by.pipe_new?.notLoadedWhy}`);
ok("each unloaded pipeline says WHY",
   !!by.pipe_park?.notLoadedWhy && !!by.pipe_new?.notLoadedWhy,
   [by.pipe_park?.notLoadedWhy, by.pipe_new?.notLoadedWhy]);
ok("⚠️ and the two reasons are different — they need different actions",
   by.pipe_park.notLoadedWhy !== by.pipe_new.notLoadedWhy,
   [by.pipe_park?.notLoadedWhy, by.pipe_new?.notLoadedWhy]);
ok("a loaded pipeline carries no reason", by.st1?.notLoadedWhy === undefined, by.st1);
const tab = readFileSync("components/PipelineAccessTab.tsx", "utf8");
ok("🔴 and the screen no longer tells anyone to edit PIPELINE_IDS",
   !/add it to PIPELINE_IDS|PIPELINE_IDS for grants/.test(tab), "the old tooltip survives");

console.log("\n4 · 🔴 THE SECOND SOURCE IS GONE FROM THIS ROUTE");
const route = readFileSync("app/api/admin/pipeline-access/route.ts", "utf8");
const code = route.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
console.log("  ⚠️ comments stripped first — this file's own prose names both");
console.log("     helpers, and a check that matched it would pass on the bug.");
ok("🔴 it does not call the env helpers any more",
   !/caregiverPipelineIds\(|pipelineIds\(/.test(code), "an env read survives");
ok("it reads the stored config instead", /getPipelineConfig\(/.test(code), "no config read");

console.log("\n5 · ⚠️ THE ENV LISTS STILL EXIST, AND FOR A STATED REASON");
const ghl = readFileSync("lib/ghl.ts", "utf8");
const ghlCode = ghl.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
ok("the seed still reads them — a fresh account must not start empty",
   /add\(pipelineIds\(\), "client"\)/.test(ghlCode) &&
   /add\(caregiverPipelineIds\(\), "caregiver"\)/.test(ghlCode), "the seed lost them");
ok("🔴 and getSelectedPipelines still falls back to them when the config is unreadable",
   /ids = idsForScope\(scope\)/.test(ghlCode), "the outage fallback is gone");
console.log("  ⚠️ those two are the whole remaining justification, and neither is");
console.log("     'which pipelines are caregiver ones'. The report says so plainly.");

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
