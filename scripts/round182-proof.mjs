// ---------------------------------------------------------------------------
// ROUND 182 · "FIRST OPENED" CREATED AFTER THE SERVER STARTED.
//
// 🔴 The field is created in GoHighLevel while dashboard instances are already
// warm — by hand, or by live-check-181.mjs. Field definitions and the id→name
// map are cached for an instance's whole life (hours on Vercel). Before this
// round such an instance:
//   · kept saying "no field" → no "New lead" label anywhere, for hours; and
//   · once it did see the field, read "First Opened" through the STALE name
//     map → an opened lead still looked unopened → its label never cleared.
//
// What must be true (one server process, caches warm from the first load):
//   1  no field yet          tracking off, nothing labelled
//   2  field created now      within the minute: still off, and NO extra
//                             GoHighLevel call (the re-check is throttled)
//   3  a minute later         tracking ON, the new lead labelled
//   4  opened                 recorded
//   5  🔴 the next load       label GONE — read by id, not the stale map
//   6  once found             no further re-checks
//
// Run: npx tsx scripts/round182-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${got !== undefined ? `\n       got: ${JSON.stringify(got)}` : ""}`); }
};

const LOC = "LOC182", SECRET = "round182-secret", P1 = "pOLTL", F_OPEN = "F_FIRST_OPENED";
let fieldExists = false, defsGets = 0;
const OPPS = new Map([["o_new", { id: "o_new", name: "New one", pipelineId: P1, pipelineStageId: "s1", status: "open",
  assignedTo: "", followers: [], createdAt: new Date().toISOString(), contact: { id: "c1", firstName: "New", lastName: "One" }, customFields: [] }]]);
const server = http.createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    const send = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (p.startsWith("/users")) return send(200, { users: [{ id: "u_admin", name: "Admin" }] });
    // The stored pipeline config, as on a real account. Without it the
    // dashboard tries to SEED one, cannot read it back from this fake, and
    // retries with back-off — a fallback path, not the one under test.
    if (p === `/locations/${LOC}/customValues`) return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
      value: JSON.stringify({ seeded: true, folderNames: {}, pipelines: { [P1]: { scope: "client", folders: [] } } }) }] });
    if (p === `/locations/${LOC}/customFields`) {
      if (u.searchParams.get("model") !== "contact") defsGets++;
      // ⚠️ NEVER EMPTY: an empty list is not cached, which would hide the bug.
      const defs = [{ id: "F_OFFICE", name: "Office", dataType: "TEXT", model: "opportunity" }];
      if (fieldExists) defs.push({ id: F_OPEN, name: "First Opened", dataType: "TEXT", model: "opportunity" });
      return send(200, { customFields: u.searchParams.get("model") === "contact" ? [] : defs });
    }
    if (p === "/opportunities/pipelines") return send(200, { pipelines: [{ id: P1, name: "OLTL Enrollment", stages: [{ id: "s1", name: "NEW LEAD", position: 0 }] }] });
    if (p === "/opportunities/search") return send(200, { opportunities: [...OPPS.values()], meta: { total: OPPS.size } });
    const m = p.match(/^\/opportunities\/([^/]+)$/);
    if (m && req.method === "GET") return send(200, { opportunity: OPPS.get(m[1]) });
    if (m && req.method === "PUT") {
      const o = OPPS.get(m[1]);
      for (const cf of JSON.parse(raw).customFields || []) o.customFields = o.customFields.filter((x) => x.id !== cf.id).concat([{ id: cf.id, fieldValueString: cf.value }]);
      return send(200, { opportunity: o });
    }
    return send(200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
Object.assign(process.env, {
  GHL_API_BASE: `http://127.0.0.1:${server.address().port}`, GHL_PIT: "pit_test", GHL_LOCATION_ID: LOC,
  GHL_SSO_SECRET: SECRET, PIPELINE_IDS: P1, CAREGIVER_PIPELINE_IDS: "", NEW_LEAD_SINCE: "2026-10-25T00:00:00.000Z",
});
delete process.env.PIPELINE_ACCESS_MAP;

const { default: CryptoJS } = await import("crypto-js");
const blob = CryptoJS.AES.encrypt(JSON.stringify({ userId: "u_admin", role: "admin", type: "agency", activeLocation: LOC }), SECRET).toString();
const G = await import("../lib/ghl.ts");
const board = await import("../app/api/opportunities/route.ts");
const opened = await import("../app/api/opportunities/[id]/opened/route.ts");
const load = async () => (await board.POST(new Request("http://x/api/opportunities", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ssoKey: blob }) }))).json();
const label = (j) => j.records?.find((r) => r.id === "o_new")?.newLead;

console.log("\n1 · THE SERVER STARTS — NO FIELD YET");
const j1 = await load();
ok("tracking is off", j1.newLeads?.tracking === false, j1.newLeads);
ok("nothing is labelled", label(j1) === false, label(j1));

console.log("\n2 · THE FIELD IS CREATED IN GOHIGHLEVEL — SAME MINUTE");
fieldExists = true;
const before = defsGets;
const j2 = await load();
ok("still off inside the minute (throttled)", j2.newLeads?.tracking === false, j2.newLeads);
ok("🔴 and it did NOT call GoHighLevel again to look", defsGets === before, { before, after: defsGets });

console.log("\n3 · A MINUTE LATER");
G.resetFirstOpenedRecheck(); // stands in for 60 seconds passing
const j3 = await load();
ok("🔴 the field is found — tracking ON with no restart", j3.newLeads?.tracking === true, j3.newLeads);
ok("🔴 the new lead is labelled", label(j3) === true, label(j3));

console.log("\n4 · SOMEBODY OPENS IT");
const o = await opened.POST(new Request("http://x/api/opportunities/o_new/opened", {
  method: "POST", headers: { "Content-Type": "application/json", "x-ghl-sso-key": blob }, body: "{}" }), { params: Promise.resolve({ id: "o_new" }) });
const oj = await o.json();
ok("recorded", o.status === 200 && oj.recorded === true, oj);

console.log("\n5 · THE NEXT LOAD, ON THE SAME (STILL STALE-MAPPED) SERVER");
const j5 = await load();
ok("🔴 the label is GONE — First Opened read by id, not through the stale name map", label(j5) === false,
  j5.records?.find((r) => r.id === "o_new"));

console.log("\n6 · ONCE FOUND, NO MORE RE-CHECKS");
const b6 = defsGets;
G.resetFirstOpenedRecheck();
await load(); await load();
ok("a found field costs no further GoHighLevel calls", defsGets === b6, { before: b6, after: defsGets });
ok("the re-check interval is one minute", G.FIRST_OPENED_RECHECK_MS === 60_000, G.FIRST_OPENED_RECHECK_MS);

server.close();
console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
