// ---------------------------------------------------------------------------
// ROUND 161 — REFERRAL ACCESS: THREE STATES THAT MUST SURVIVE A ROUND TRIP.
//
// 🔴 THE WHOLE FEATURE TURNS ON ONE OF THEM BEING STORABLE.
//
//   absent                          derived — divisions from pipeline grants
//   {mode:"divisions",divisions:[]} sees NO referrals
//   {mode:"agency"}                 every division
//
// "Divisions, none selected" is the only way an admin can say "this person sees
// no referrals". If it collapses to absent, it reads back as DERIVED and the
// person falls to their pipeline grants — the opposite instruction.
//
// ⚠️ AND THE ASSERTION FOR IT IS A RULE-14 SHAPE: `divisions.length === 0` on
// both sides of a save is satisfied by nothing saving at all. Every empty-list
// assertion here is therefore paired with a NON-EMPTY list round-tripping in
// the same run.
//
// Run: npx tsx scripts/referral-access-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";

const LOC = "loc_test";
let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const DERIVED = "u_derived";   // no entry — falls back to pipeline grants
const NONE = "u_none";         // {divisions: []} — sees nothing
const PICKED = "u_picked";     // {divisions: ["ODP"]}
const AGENCY = "u_agency";     // {mode: "agency"}
const P_OLTL = "pipe_oltl", P_ODP = "pipe_odp";

/** The stored custom value, mutated by the route's own writes. */
let stored = JSON.stringify({
  // 🔴 NONE HOLDS A GRANT ON PURPOSE, AND THE PROOF IS WRONG WITHOUT IT.
  // With no grant, "explicitly none" and "derived, with nothing to derive" both
  // resolve to [] — so the assertion below would pass whether the feature works
  // or collapses. Giving them OLTL makes the two answers differ: derived would
  // say ["OLTL"], the override says []. Rule 14, caught by reverting.
  pipelines: { [DERIVED]: [P_OLTL], [NONE]: [P_OLTL] },
  folders: {}, master: [], caseManagers: {},
  referralAccess: {
    [NONE]: { mode: "divisions", divisions: [] },
    [PICKED]: { mode: "divisions", divisions: ["ODP"] },
    [AGENCY]: { mode: "agency" },
  },
});
const puts = [];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : null;
    const [path] = req.url.split("?");
    const send = (code, o) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (path === `/locations/${LOC}/customValues` && req.method === "GET")
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Access", value: stored }] });
    if (/^\/locations\/[^/]+\/customValues\/[^/]+$/.test(path) && req.method === "PUT") {
      if (j?.value) { puts.push(JSON.parse(j.value)); stored = j.value; }
      return send(200, { customValue: { id: "cv1" } });
    }
    if (path === "/users/")
      return send(200, { users: [DERIVED, NONE, PICKED, AGENCY].map((id) => ({ id, name: id })) });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        { id: P_OLTL, name: "OLTL Enrollment", stages: [] },
        { id: P_ODP, name: "ODP Enrollment", stages: [] },
      ] });
    send(404, { message: `no fake handler for ${path}` });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.PIPELINE_IDS = `${P_OLTL},${P_ODP}`;

const ghl = await import("../lib/ghl.ts");
const pa = await import("../lib/pipelineAccess.ts");

const NAMES = new Map([[P_OLTL, "OLTL Enrollment"], [P_ODP, "ODP Enrollment"]]);
/** Resolve inside both stores, the way withGrants installs them. */
const resolve = (userId, isAdmin = false) => {
  const v2 = parsed;
  return pa.runWithGrants(
    pa.buildGrants(v2.pipelines, undefined, undefined),
    () => pa.runWithReferralAccess(
      new Map(Object.entries(v2.referralAccess)),
      () => pa.referralDivisions(userId, NAMES, isAdmin),
    ),
  );
};
let parsed = ghl.parseAccessValue(stored);

console.log("═══ 1 · 🔴 THE THREE STATES RESOLVE DIFFERENTLY ═══");
console.log(`  derived: ${JSON.stringify(resolve(DERIVED))}`);
console.log(`  none:    ${JSON.stringify(resolve(NONE))}`);
console.log(`  picked:  ${JSON.stringify(resolve(PICKED))}`);
console.log(`  agency:  ${JSON.stringify(resolve(AGENCY))}`);
// 🔴 The derived user holds OLTL Enrollment, so their divisions come from the
// grant — nobody said "OLTL" on the referral tab.
ok("🔴 absent → DERIVED from the pipeline grant",
   JSON.stringify(resolve(DERIVED)) === '["OLTL"]', resolve(DERIVED));
ok("🔴 {divisions:[]} → sees NOTHING, even though their GRANT would say OLTL",
   Array.isArray(resolve(NONE)) && resolve(NONE).length === 0, resolve(NONE));
// 🔴 THE CONTROL THAT MAKES THE LINE ABOVE MEAN SOMETHING: the same grant, read
// derived, produces a division. So [] is the override winning, not an absence.
ok("🔴 THE CONTROL — that same OLTL grant DOES produce a division when derived",
   JSON.stringify(resolve(DERIVED)) === '["OLTL"]', resolve(DERIVED));
ok("⚠️ an explicit list is returned as itself",
   JSON.stringify(resolve(PICKED)) === '["ODP"]', resolve(PICKED));
ok("🔴 agency → null, the same 'all' the admin path already uses",
   resolve(AGENCY) === null, resolve(AGENCY));
// 🔴 THE CONTROL THAT SEPARATES THE TWO EMPTIES. `[]` and `null` are different
// answers and the call sites branch on exactly that; if they collapsed, "sees
// nothing" and "sees everything" would be the same value.
ok("🔴 THE CONTROL — 'none' and 'agency' are NOT the same value",
   JSON.stringify(resolve(NONE)) !== JSON.stringify(resolve(AGENCY)),
   { none: resolve(NONE), agency: resolve(AGENCY) });
ok("⚠️ and an admin is 'all' whatever their entry says",
   resolve(NONE, true) === null, resolve(NONE, true));

console.log("\n═══ 2 · 🔴 THE ROUND TRIP — `divisions: []` MUST SURVIVE A SAVE ═══");
// Save an unrelated scope. saveAccessGrantsV2 merges, so referralAccess is
// carried forward untouched — the case that wiped `caseManagers` before.
await ghl.saveAccessGrantsV2({ master: ["u_someone"] });
parsed = ghl.parseAccessValue(stored);
console.log(`  stored after an unrelated save: ${JSON.stringify(parsed.referralAccess)}`);
ok("🔴 the empty list SURVIVED a save of another scope",
   parsed.referralAccess[NONE]?.mode === "divisions" &&
   parsed.referralAccess[NONE].divisions.length === 0, parsed.referralAccess[NONE]);
// 🔴 THE RULE-14 CONTROL. `length === 0` is satisfied by nothing saving at all,
// so a NON-EMPTY list has to round-trip in the same run for the line above to
// mean anything.
ok("🔴 THE CONTROL — a NON-EMPTY list round-tripped in the same save",
   JSON.stringify(parsed.referralAccess[PICKED]) ===
     JSON.stringify({ mode: "divisions", divisions: ["ODP"] }), parsed.referralAccess[PICKED]);
ok("⚠️ and agency survived too", parsed.referralAccess[AGENCY]?.mode === "agency",
   parsed.referralAccess[AGENCY]);
ok("🔴 absent stayed absent — derived is not invented on save",
   !(DERIVED in parsed.referralAccess), Object.keys(parsed.referralAccess));

console.log("\n═══ 3 · 🔴 A VALUE HOLDING ONLY THIS KEY IS STILL READ AS v2 ═══");
// The `caseManagers` trap from round 135: a key missing from the recognition
// test sends a value holding only that key down the LEGACY branch, where every
// user id becomes a pipeline grant.
const only = ghl.parseAccessValue(JSON.stringify({
  referralAccess: { [AGENCY]: { mode: "agency" } },
}));
console.log(`  parsed: pipelines=${JSON.stringify(only.pipelines)} referralAccess=${JSON.stringify(only.referralAccess)}`);
ok("🔴 it is NOT mistaken for a legacy flat pipeline map",
   Object.keys(only.pipelines).length === 0, only.pipelines);
ok("⚠️ and the key itself came through", only.referralAccess[AGENCY]?.mode === "agency",
   only.referralAccess);

console.log("\n═══ 4 · ⚠️ A HAND-EDITED BAD MODE IS DROPPED, NOT WIDENED ═══");
const bad = ghl.parseAccessValue(JSON.stringify({
  referralAccess: { u_x: { mode: "all" }, u_y: { mode: "divisions" }, u_z: "nonsense" },
}));
console.log(`  parsed: ${JSON.stringify(bad.referralAccess)}`);
// 🔴 Guessing "agency" for an unrecognised mode would hand out access nobody
// granted. Absent — derived — is the conservative direction.
ok("🔴 an unknown mode becomes ABSENT (derived), never agency",
   !("u_x" in bad.referralAccess), bad.referralAccess);
ok("⚠️ divisions with no list becomes an empty list, not a crash",
   bad.referralAccess.u_y?.mode === "divisions" &&
   bad.referralAccess.u_y.divisions.length === 0, bad.referralAccess.u_y);
ok("⚠️ and a non-object entry is dropped", !("u_z" in bad.referralAccess), bad.referralAccess);

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
