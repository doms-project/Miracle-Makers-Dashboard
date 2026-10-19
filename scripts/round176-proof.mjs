// ---------------------------------------------------------------------------
// ROUND 176 — THE CLIENTS HEADING, ITS PIPELINE ENTRIES, AND THE SETTING THAT
// HIDES A TAB.
//
// 🔴 THE FIXTURE IS THE MAIN ACCOUNT AS IT IS: OLTL Enrollment, OLTL Transfer,
// Private Pay, ODP Enrollment and ODP Transfer, ALL client-scope, with the two
// ODP pipelines hidden by the new setting. That is the exact case the owner
// will set up after deploy, and the assertion that matters is the pair: NO TAB,
// and STILL THE RECORDS. A proof that only checked "no tab" would pass on a
// build that hid the records too.
//
// ⚠️ NO VALUE DOES TWO JOBS (rule 4). Every pipeline holds a DIFFERENT number
// of records (6 with one REASSIGN, 2, 3, 4, 2, and 3 in the "none" pipeline),
// so a count read from the wrong pipeline, or one that includes the reassigned
// record, cannot land on the right number by accident.
//
// ⚠️ AND THE FAKE IS NOT TIDIER THAN GOHIGHLEVEL (rule 2). It can accept a
// config write and store the OLD value, and it can accept one and store it
// with the `sidebar` keys stripped — the second is what a reader that did not
// know the field would do, and only a read-back that knows it can catch it.
//
// Part 1 drives lib/clientSidebar.ts, lib/pipelineConfig.ts and both routes
// in-process. Part 2 opens the real page in a real browser.
//
// Run: npx tsx scripts/round176-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import CryptoJS from "crypto-js";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const P = {
  oe: "pipe_oltl_enr",    // OLTL Enrollment — 5 live + 1 REASSIGN
  ot: "pipe_oltl_tr",     // OLTL Transfer   — 2
  pp: "pipe_pp",          // Private Pay     — 3
  de: "pipe_odp_enr",     // ODP Enrollment  — 4, HIDDEN by the setting
  dt: "pipe_odp_tr",      // ODP Transfer    — 2, HIDDEN by the setting
  long: "pipe_long",      // a long name     — 1
  none: "pipe_events",    // scope "none"    — 3, never loaded
  bad: "pipe_lost",       // client-scope, its search FAILS
  cg: "pipe_cg",          // a caregiver pipeline — not on the client board
  dead: "pipe_dead",      // in the config, NOT on this account
};
const NAMES = {
  [P.oe]: "OLTL Enrollment", [P.ot]: "OLTL Transfer", [P.pp]: "Private Pay",
  [P.de]: "ODP Enrollment", [P.dt]: "ODP Transfer",
  [P.long]: "Private Pay Clients — Montgomery County Waiver Intake",
  [P.none]: "Events", [P.bad]: "Lost Pipeline", [P.cg]: "PP Caregiver Applicants",
};
const ON_ACCOUNT = [P.oe, P.ot, P.pp, P.de, P.dt, P.long, P.none, P.bad, P.cg];
const STAGES = [
  { id: "s1", name: "NEW LEAD", position: 0 },
  { id: "s2", name: "INTAKE", position: 1 },
  { id: "sR", name: "REASSIGN", position: 2 },
];

const ADMIN = "u_admin";
const REP_DIV = "u_div";    // homes OLTL Enrollment + Private Pay, follows an ODP Transfer case
const REP_ZERO = "u_zero";  // no grants at all, follows one ODP Enrollment case
const REP_ONE = "u_one";    // homes OLTL Transfer only
const blob = (userId, role) =>
  CryptoJS.AES.encrypt(JSON.stringify({
    userId, role, type: "agency", activeLocation: LOC,
    userName: userId, email: `${userId}@e.com`, companyId: "co1",
  }), SECRET).toString();

// ── the records ─────────────────────────────────────────────────────────────
let n = 0;
const opp = (pipelineId, extra = {}) => ({
  id: `o${++n}`, name: `Case ${n}`, pipelineId, pipelineStageId: "s1", status: "open",
  assignedTo: "", followers: [], createdAt: new Date(Date.now() - n * 3600000).toISOString(),
  contact: { id: `c${n}`, firstName: "Case", lastName: `N${n}` }, ...extra,
});
const OPPS = [
  ...Array.from({ length: 5 }, () => opp(P.oe)),
  opp(P.oe, { pipelineStageId: "sR" }),                 // the REASSIGN record
  ...Array.from({ length: 2 }, () => opp(P.ot, { pipelineStageId: "s2" })),
  ...Array.from({ length: 3 }, () => opp(P.pp)),
  opp(P.de, { followers: [REP_ZERO] }),                  // the zero-grant rep's share
  ...Array.from({ length: 3 }, () => opp(P.de)),
  opp(P.dt, { followers: [REP_DIV] }),                   // the division rep's share
  opp(P.dt),
  opp(P.long),
  ...Array.from({ length: 3 }, () => opp(P.none)),
];
const countIn = (pid, { reassign = false } = {}) =>
  OPPS.filter((o) => o.pipelineId === pid && (reassign || o.pipelineStageId !== "sR")).length;

// ── the stored config ───────────────────────────────────────────────────────
const baseConfig = (hideOdp) => ({
  seeded: true, folderNames: {},
  pipelines: {
    [P.oe]: { scope: "client", folders: ["shared"] },
    // OLTL Transfer carries an exclusion AND folders, so "saving the checkbox
    // changes nothing else" has something else to change.
    [P.ot]: { scope: "client", folders: ["shared", "client"], exclude: ["F_X"] },
    [P.pp]: { scope: "client", folders: [] },
    [P.de]: hideOdp ? { scope: "client", folders: [], sidebar: false } : { scope: "client", folders: [] },
    [P.dt]: hideOdp ? { scope: "client", folders: [], sidebar: false } : { scope: "client", folders: [] },
    [P.long]: { scope: "client", folders: [] },
    [P.none]: { scope: "none", folders: [] },
    [P.bad]: { scope: "client", folders: [] },
    [P.cg]: { scope: "caregiver", folders: [], group: "staff" },
    [P.dead]: { scope: "client", folders: [] },
  },
});
let storedConfig = JSON.stringify(baseConfig(true));
const access = JSON.stringify({
  pipelines: { [REP_DIV]: [P.oe, P.pp], [REP_ONE]: [P.ot] },
  folders: {}, master: [], caseManagers: {}, referralAccess: {},
});
/** "store" · "drop" (keep the old value) · "strip" (store it minus `sidebar`). */
let writeMode = "store";
let customValuesFail = false;
let configPuts = 0;

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const send = (code, o) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (path === "/users/" || path.startsWith("/users"))
      return send(200, { users: [ADMIN, REP_DIV, REP_ZERO, REP_ONE].map((id) => ({ id, name: id })) });
    if (path === `/locations/${LOC}/customValues`) {
      if (customValuesFail) return send(500, { message: "fake outage" });
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Folders", value: storedConfig },
        { id: "cv2", name: "MM Pipeline Access", value: access },
      ] });
    }
    if (path === `/locations/${LOC}/customValues/cv1` && req.method === "PUT") {
      configPuts += 1;
      const j = JSON.parse(raw || "{}");
      if (writeMode === "store") storedConfig = j.value;
      else if (writeMode === "strip") {
        const c = JSON.parse(j.value);
        for (const e of Object.values(c.pipelines)) delete e.sidebar;
        storedConfig = JSON.stringify(c);
      } // "drop": a 200 that stores nothing
      return send(200, { customValue: { id: "cv1", name: "MM Pipeline Folders", value: j.value } });
    }
    if (path === `/locations/${LOC}/customFields`)
      return send(200, { customFields: [] });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: ON_ACCOUNT.map((id) => ({ id, name: NAMES[id], stages: STAGES })) });
    if (path === "/opportunities/search") {
      const pid = url.searchParams.get("pipeline_id") || "";
      // 🔴 THE FAILED PIPELINE. A 4xx so the client does not sit in a retry
      // loop; what matters is that this pipeline's records never arrive.
      if (pid === P.bad) return send(422, { message: "fake: this pipeline could not be searched" });
      const rows = OPPS.filter((o) => !pid || o.pipelineId === pid);
      return send(200, { opportunities: rows, meta: { total: rows.length } });
    }
    if (path === "/contacts/search") return send(200, { contacts: [], total: 0 });
    return send(200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const FAKE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_API_BASE = FAKE;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.GHL_SSO_SECRET = SECRET;
process.env.PIPELINE_IDS = [P.oe, P.ot, P.pp, P.de, P.dt, P.long, P.bad].join(",");
delete process.env.PIPELINE_ACCESS_MAP;

const SB = await import("../lib/clientSidebar.ts");
const PC = await import("../lib/pipelineConfig.ts");
const OPP_ROUTE = await import("../app/api/opportunities/route.ts");
const ADMIN_ROUTE = await import("../app/api/admin/pipelines/route.ts");
const { BUILD } = await import("../lib/build.ts");

const load = async (userId, role = "user") => {
  const r = await OPP_ROUTE.POST(new Request("http://x/api/opportunities", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoKey: blob(userId, role) }),
  }));
  return r.json();
};
const isReassign = (r) => String(r.stage || "").trim().toUpperCase() === "REASSIGN";
/** The sidebar a viewer gets, built exactly as app/page.tsx builds it. */
const sidebarFor = (body, hiddenOverride) =>
  SB.sidebarModel({
    selectable: SB.selectableFor(!!body.viewer?.isAdmin, body.pipelines || [],
      body.viewer?.homePipelineIds || []),
    records: body.records || [],
    hidden: hiddenOverride === undefined ? body.pipelineSidebarHidden : hiddenOverride,
    failed: body.failedPipelines || [],
    isExcluded: isReassign,
  });
const ids = (m) => m.entries.map((e) => e.id);

// ═══════════════════════════════════════════════════════════════════════════
console.log("═══ 1 · THE MAIN ACCOUNT, AS THE ADMIN SEES IT ═══");
// ═══════════════════════════════════════════════════════════════════════════
const adminBody = await load(ADMIN, "admin");
const adminSide = sidebarFor(adminBody);
console.log(`  entries: ${adminSide.entries.map((e) => e.name).join(" · ")}`);
ok("the entries are OLTL Enrollment, OLTL Transfer, Private Pay, the long one and the failed one",
  JSON.stringify(ids(adminSide)) === JSON.stringify([P.oe, P.ot, P.pp, P.long, P.bad]), ids(adminSide));
ok("🔴 ODP Enrollment has NO entry", !ids(adminSide).includes(P.de), ids(adminSide));
ok("🔴 ODP Transfer has NO entry", !ids(adminSide).includes(P.dt), ids(adminSide));
ok("the scope-\"none\" pipeline has no entry, as today",
  !ids(adminSide).includes(P.none) && !(adminBody.pipelines || []).some((p) => p.id === P.none),
  ids(adminSide));
// ⚠️ THE CONTROL FOR THE LINE ABOVE: "none" exists on the account and holds
// records. Without this, "no entry" is also what an account without it shows.
ok("…control: the \"none\" pipeline is on the account and holds 3 records",
  ON_ACCOUNT.includes(P.none) && countIn(P.none) === 3, countIn(P.none));
ok("the caregiver pipeline has no entry", !ids(adminSide).includes(P.cg), ids(adminSide));

console.log("\n1b · 🔴 HIDDEN MEANS NO TAB — AND STILL THE RECORDS");
const recPids = (adminBody.records || []).map((r) => r.pipelineId);
ok("🔴 ODP Enrollment's 4 records are still in the payload (All clients, Master)",
  recPids.filter((p) => p === P.de).length === 4, recPids.filter((p) => p === P.de).length);
ok("🔴 ODP Transfer's 2 records are still in the payload",
  recPids.filter((p) => p === P.dt).length === 2, recPids.filter((p) => p === P.dt).length);
const allExpected = [P.oe, P.ot, P.pp, P.de, P.dt, P.long].reduce((s, p) => s + countIn(p), 0);
ok(`🔴 "All clients" counts them: ${allExpected} records, the ODP six included`,
  adminSide.all.count === allExpected, adminSide.all);
const dropdown = SB.selectableFor(true, adminBody.pipelines || [], []).map((p) => p.id);
ok("🔴 both ODP pipelines are still in the toolbar dropdown's list",
  dropdown.includes(P.de) && dropdown.includes(P.dt), dropdown);
// THE POSITIVE CONTROL: un-hiding restores the entries.
const unhidden = sidebarFor(adminBody, {});
ok("…control: un-hidden, both ODP entries come back",
  ids(unhidden).includes(P.de) && ids(unhidden).includes(P.dt), ids(unhidden));
ok("…and the hidden map in the payload names exactly the two ODP pipelines",
  JSON.stringify(Object.keys(adminBody.pipelineSidebarHidden || {}).sort()) ===
    JSON.stringify([P.de, P.dt].sort()), adminBody.pipelineSidebarHidden);

console.log("\n1c · ENTRIES COME FROM WHAT THE ACCOUNT RETURNED, NEVER CONFIG KEYS");
const cfgNow = PC.parsePipelineConfig(storedConfig);
ok("…the config DOES hold a client-scope id that is not on this account",
  cfgNow?.pipelines?.[P.dead]?.scope === "client", Object.keys(cfgNow?.pipelines || {}));
ok("🔴 and it has no entry", !ids(adminSide).includes(P.dead), ids(adminSide));

console.log("\n1d · COUNTS — EACH ENTRY ITS OWN, THE FAILED ONE NONE");
const cnt = (m, id) => m.entries.find((e) => e.id === id)?.count;
ok("OLTL Enrollment reads 5 — the REASSIGN record is not counted",
  cnt(adminSide, P.oe) === 5 && countIn(P.oe, { reassign: true }) === 6, cnt(adminSide, P.oe));
ok("OLTL Transfer reads 2", cnt(adminSide, P.ot) === 2, cnt(adminSide, P.ot));
ok("Private Pay reads 3", cnt(adminSide, P.pp) === 3, cnt(adminSide, P.pp));
const badE = adminSide.entries.find((e) => e.id === P.bad);
ok("🔴 the failed pipeline is marked failed with NO count — never 0",
  badE?.failed === true && badE?.count === null, badE);
ok("…control: it really did fail to load",
  (adminBody.failedPipelines || []).some((f) => f.id === P.bad), adminBody.failedPipelines);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 2 · REPS ═══");
// ═══════════════════════════════════════════════════════════════════════════
const divBody = await load(REP_DIV);
const divSide = sidebarFor(divBody);
ok("the division rep's entries are their two home pipelines",
  JSON.stringify(ids(divSide)) === JSON.stringify([P.oe, P.pp]), ids(divSide));
ok("…not the ODP Transfer case shared with them", !ids(divSide).includes(P.dt), ids(divSide));
ok("🔴 …but All clients holds it, and says one is shared",
  divSide.all.shared === 1 && divSide.all.count === countIn(P.oe) + countIn(P.pp) + 1, divSide.all);
const zeroBody = await load(REP_ZERO);
const zeroSide = sidebarFor(zeroBody);
ok("🔴 the zero-grant rep gets no pipeline entries",
  zeroSide.entries.length === 0, ids(zeroSide));
ok("🔴 …and All clients holds their one shared record",
  zeroSide.all.count === 1 && zeroSide.all.shared === 1, zeroSide.all);
ok("…and that is not the all-hidden state", zeroSide.allHidden === false, zeroSide);
const oneBody = await load(REP_ONE);
const oneSide = sidebarFor(oneBody);
ok("the single-pipeline rep sees their one pipeline by name",
  oneSide.entries.length === 1 && oneSide.entries[0].name === "OLTL Transfer", oneSide.entries);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 3 · 🔴 THE PAYLOAD — THE FLAG CHANGES ONE MAP AND NOTHING ELSE ═══");
// ═══════════════════════════════════════════════════════════════════════════
storedConfig = JSON.stringify(baseConfig(false));
await new Promise((r) => setTimeout(r, 3200)); // past the 3s search dedupe
const offBody = await load(ADMIN, "admin");
storedConfig = JSON.stringify(baseConfig(true));
await new Promise((r) => setTimeout(r, 3200));
const onBody = await load(ADMIN, "admin");
const strip = (rs) => JSON.stringify((rs || []).map((r) => ({ ...r })).sort((a, b) => a.id.localeCompare(b.id)));
ok("🔴 `records` are identical with the flag on and off",
  strip(offBody.records) === strip(onBody.records) && (onBody.records || []).length > 0,
  { off: (offBody.records || []).length, on: (onBody.records || []).length });
ok("🔴 `pipelines` are identical with the flag on and off",
  JSON.stringify(offBody.pipelines) === JSON.stringify(onBody.pipelines), onBody.pipelines);
ok("the map is present and names the hidden ones when on",
  onBody.pipelineSidebarHidden?.[P.de] === true && onBody.pipelineSidebarHidden?.[P.dt] === true,
  onBody.pipelineSidebarHidden);
ok("…and present and EMPTY when nothing is hidden",
  offBody.pipelineSidebarHidden && Object.keys(offBody.pipelineSidebarHidden).length === 0,
  offBody.pipelineSidebarHidden);
customValuesFail = true;
await new Promise((r) => setTimeout(r, 3200));
const outBody = await load(ADMIN, "admin");
customValuesFail = false;
ok("🔴 a config that cannot be read sends NO map", outBody.pipelineSidebarHidden === undefined,
  outBody.pipelineSidebarHidden);
ok("…and the sidebar then shows every pipeline, ODP included",
  ids(sidebarFor(outBody)).includes(P.de) && ids(sidebarFor(outBody)).includes(P.dt),
  ids(sidebarFor(outBody)));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 4 · THE STORED FIELD — PARSER, SAVE, READ-BACK, STALE TABS ═══");
// ═══════════════════════════════════════════════════════════════════════════
const parsed = PC.parsePipelineConfig(JSON.stringify({
  seeded: true, folderNames: {},
  pipelines: {
    a: { scope: "client", folders: [], sidebar: false },
    b: { scope: "client", folders: [], sidebar: true },
    c: { scope: "client", folders: [], sidebar: "false" },
    d: { scope: "client", folders: [] },
  },
}));
ok("the parser keeps `sidebar: false`", parsed.pipelines.a.sidebar === false, parsed.pipelines.a);
ok("…and stores nothing for the default, or for anything that is not false",
  !("sidebar" in parsed.pipelines.b) && !("sidebar" in parsed.pipelines.c) &&
    !("sidebar" in parsed.pipelines.d), parsed.pipelines);
ok("a default entry serialises with no `sidebar` key at all",
  !PC.serialisePipelineConfig(parsed).includes('"b":{"scope":"client","folders":[],"sidebar'),
  PC.serialisePipelineConfig(parsed));

const save = async (config, build) => {
  const body = { action: "save-config", config };
  if (build !== undefined) body.build = build;
  const r = await ADMIN_ROUTE.POST(new Request("http://x/api/admin/pipelines", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoKey: blob(ADMIN, "admin"), ...body }),
  }));
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const hideOt = () => {
  const c = baseConfig(true);
  c.pipelines[P.ot] = { ...c.pipelines[P.ot], sidebar: false };
  return c;
};

console.log("\n4b · 🔴 A PAGE FROM ANOTHER BUILD MAY NOT SAVE");
storedConfig = JSON.stringify(baseConfig(true));
const before = storedConfig;
configPuts = 0;
let s = await save(hideOt(), undefined);
ok("🔴 a save with no build is refused (409, marked a refusal)",
  s.status === 409 && s.body.refusal === true, s);
ok("…and says to reload", /Reload the page/.test(s.body.error || ""), s.body.error);
ok("🔴 …and nothing was written", configPuts === 0 && storedConfig === before, configPuts);
s = await save(hideOt(), "174");
ok("🔴 a save from build 174 is refused too", s.status === 409 && configPuts === 0, s);
// THE CONTROL: the same save, from this build, lands.
s = await save(hideOt(), BUILD.round);
ok("…control: the same save from this build is stored",
  s.status === 200 && PC.parsePipelineConfig(storedConfig)?.pipelines?.[P.ot]?.sidebar === false,
  { status: s.status, stored: PC.parsePipelineConfig(storedConfig)?.pipelines?.[P.ot] });

console.log("\n4c · 🔴 A WRITE GOHIGHLEVEL DOES NOT KEEP");
storedConfig = JSON.stringify(baseConfig(true));
writeMode = "drop";
s = await save(hideOt(), BUILD.round);
ok("🔴 a write stored as the OLD value is reported as failed, not saved",
  s.status !== 200 && !s.body.config, { status: s.status, error: s.body.error });
writeMode = "strip";
storedConfig = JSON.stringify(baseConfig(true));
s = await save(hideOt(), BUILD.round);
ok("🔴 a write stored WITHOUT its `sidebar` keys is caught by the read-back",
  s.status !== 200 && !s.body.config, { status: s.status, error: s.body.error, detail: s.body.detail });
writeMode = "store";
storedConfig = JSON.stringify(baseConfig(true));

console.log("\n4d · M3 — UN-EXCLUDING THE LAST FIELD KEEPS EVERY OTHER KEY");
const full = { scope: "client", folders: ["shared"], exclude: ["F1"], group: "staff", role: "events", sidebar: false };
const after = PC.withExclusion(full, "F1", false);
ok("🔴 `sidebar: false` survives", after.sidebar === false, after);
ok("🔴 `group` and `role` survive", after.group === "staff" && after.role === "events", after);
ok("…and `exclude` is gone, not left as []", !("exclude" in after), after);
ok("…control: adding an exclusion still adds it",
  JSON.stringify(PC.withExclusion(after, "F2", true).exclude) === '["F2"]', PC.withExclusion(after, "F2", true));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 5 · ONE CLICK — WHAT IT RESETS, WHAT IT KEEPS ═══");
// ═══════════════════════════════════════════════════════════════════════════
const st = {
  view: "list", adminPipeline: "all", scope: "OLTL", stage: "INTAKE", srcF: "facebook",
  office: "Erie", clientFocus: { kind: "rep", value: "u1" }, q: "smith",
  selPipelineId: P.oe, selIsClient: true,
};
let nx = SB.pickClientPipeline(st, P.ot);
ok("stage, source, office and tile focus are cleared",
  nx.stage === "all" && nx.srcF === "all" && nx.office === "all" && nx.clientFocus === null, nx);
ok("🔴 the rep's division scope goes back to all (D2)", nx.scope === "all", nx.scope);
ok("the search text is KEPT", nx.q === "smith", nx.q);
ok("the selection is the clicked pipeline", nx.adminPipeline === P.ot, nx.adminPipeline);
ok("🔴 an open record in another pipeline is closed", nx.closeRecord === true, nx);
ok("…an open record IN that pipeline stays open",
  SB.pickClientPipeline(st, P.oe).closeRecord === false, SB.pickClientPipeline(st, P.oe));
ok("…All clients keeps an open client record",
  SB.pickClientPipeline(st, "all").closeRecord === false, SB.pickClientPipeline(st, "all"));
ok("…All clients closes an open APPLICANT record",
  SB.pickClientPipeline({ ...st, selPipelineId: P.cg, selIsClient: false }, "all").closeRecord === true,
  null);
ok("List stays List", nx.view === "list", nx.view);
ok("Board stays Board", SB.pickClientPipeline({ ...st, view: "board" }, P.ot).view === "board", null);
ok("Resources, Master and Moves go to Board",
  ["resources", "master", "kpi", "caregivers"].every((v) =>
    SB.pickClientPipeline({ ...st, view: v }, P.ot).view === "board"), null);

console.log("\n5b · E5 / E4 — HIDING MID-SESSION, AND THE REMEMBERED ENTRY");
ok("🔴 hiding the pipeline you stand on resets to all",
  SB.selectionAfterHide(P.ot, {}, { [P.ot]: true }) === "all", null);
ok("…a pipeline picked from the dropdown while ALREADY hidden stays picked",
  SB.selectionAfterHide(P.de, { [P.de]: true }, { [P.de]: true }) === P.de, null);
ok("…hiding a different pipeline leaves the selection alone",
  SB.selectionAfterHide(P.ot, {}, { [P.de]: true }) === P.ot, null);
const sel = SB.selectableFor(true, adminBody.pipelines, []);
ok("a remembered entry is restored", SB.restoreRemembered(P.ot, sel, {}) === P.ot, null);
ok("🔴 …one since hidden falls back to all",
  SB.restoreRemembered(P.de, sel, adminBody.pipelineSidebarHidden) === "all", null);
ok("…one no longer selectable falls back to all",
  SB.restoreRemembered(P.dead, sel, {}) === "all" && SB.restoreRemembered("", sel, {}) === "all", null);

console.log("\n5c · B6 — EVERY PIPELINE HIDDEN");
const everyHidden = Object.fromEntries(sel.map((p) => [p.id, true]));
const empty = sidebarFor(adminBody, everyHidden);
ok("no entries, and the all-hidden state is set",
  empty.entries.length === 0 && empty.allHidden === true, empty);
ok("…All clients still counts every record", empty.all.count === allExpected, empty.all);

console.log("\n5d · COLLAPSED LABELS");
const ini = SB.entryInitials(["OLTL Enrollment", "ODP Enrollment", "Private Pay", "OLTL Transfer"]);
ok("acronyms stay whole, so OLTL and ODP Enrollment differ",
  ini[0] === "OLTL·E" && ini[1] === "ODP·E" && ini[2] === "PP", ini);
ok("…and any that still collide get a number",
  JSON.stringify(SB.entryInitials(["Private Pay", "Pending Payments"])) === '["PP1","PP2"]',
  SB.entryInitials(["Private Pay", "Pending Payments"]));

// ⚠️ R176_LIB_ONLY=1 STOPS HERE — for the reverts whose red lands in Parts 1–5,
// so they do not each pay a dev-server boot. The suite always runs it whole.
if (process.env.R176_LIB_ONLY) {
  server.close();
  console.log(`\n${pass} passed · ${fail} failed  (lib only — no browser)`);
  process.exit(fail ? 1 : 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 6 · THE PAGE, IN A BROWSER ═══");
// ═══════════════════════════════════════════════════════════════════════════
const { chromium } = await import("playwright-core");
try {
  const stale = execSync("pgrep -f '^next-server' || true").toString().trim();
  for (const pid of stale.split("\n").filter(Boolean))
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
} catch { /* no pgrep */ }
try { rmSync(".next/dev/lock", { force: true }); } catch { /* nothing */ }
const PORT = 3700 + Math.floor(Math.random() * 250);
const dev = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  detached: true,
  env: { ...process.env, GHL_API_BASE: FAKE, GHL_LOCATION_ID: LOC, GHL_PIT: "pit_test",
         GHL_SSO_SECRET: SECRET, PIPELINE_IDS: process.env.PIPELINE_IDS },
  stdio: ["ignore", "pipe", "pipe"],
});
const devLog = [];
dev.stdout.on("data", (d) => devLog.push(String(d)));
dev.stderr.on("data", (d) => devLog.push(String(d)));
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { process.kill(-dev.pid, "SIGKILL"); } catch { /* gone */ }
  try { server.close(); } catch { /* closed */ }
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { cleanup(); process.exit(130); });

const base = `http://localhost:${PORT}`;
let up = false;
for (let i = 0; i < 150 && !up; i++) {
  try {
    const r = await fetch(`${base}/api/opportunities`, { signal: AbortSignal.timeout(4000) });
    if (r.status > 0) up = true;
  } catch { /* not listening */ }
  if (!up) await new Promise((r) => setTimeout(r, 1000));
}
if (!up) { console.log(devLog.join("").slice(-1500)); process.exit(1); }

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-proxy-server", "--no-sandbox"],
});
const W = 1280, H = 700;
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));
const ADMIN_BLOB = blob(ADMIN, "admin");
await page.route(`${base}/__parent`, (route) => route.fulfill({
  status: 200, contentType: "text/html",
  body: `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0}iframe{border:0;width:${W}px;height:${H}px}</style>
<script>window.addEventListener("message",(e)=>{if(e.data&&e.data.message==="REQUEST_USER_DATA")
e.source.postMessage({message:"REQUEST_USER_DATA_RESPONSE",payload:${JSON.stringify(ADMIN_BLOB)}},"*");});</script>
<iframe src="${base}/"></iframe>`,
}));
await page.goto(`${base}/__parent`, { waitUntil: "domcontentloaded" });
const frame = await (await page.waitForSelector("iframe")).contentFrame();
await frame.waitForSelector(".railpipe[title='OLTL Enrollment']", { timeout: 120000 });
await frame.waitForSelector(".board .col", { timeout: 60000 });

const railState = () => frame.evaluate(() => ({
  entries: [...document.querySelectorAll(".rail .railpipe")].map((b) => b.getAttribute("title")),
  active: [...document.querySelectorAll(".rail .railpipe.active")].map((b) => b.getAttribute("title")),
  h1: document.querySelector(".main h1")?.textContent?.trim() || "",
  cards: document.querySelectorAll(".board .colbody .card").length,
  cols: [...document.querySelectorAll(".board .col")].length,
}));

console.log("\n6a · THE HEADING");
ok("🔴 no button is named exactly \"Clients\"",
  (await frame.getByRole("button", { name: "Clients", exact: true }).count()) === 0, null);
ok("…control: a heading named \"Clients\" exists",
  (await frame.getByRole("heading", { name: "Clients", exact: true }).count()) === 1, null);
const head = await frame.evaluate(() => {
  const h = document.getElementById("railhead-clients");
  const g = h?.closest("[role=group]");
  return { tag: h?.tagName, tabindex: h?.getAttribute("tabindex"), inButton: !!h?.closest("button"),
    group: g?.getAttribute("aria-labelledby") };
});
ok("🔴 it is an H2, not a button, inside a group it labels",
  head.tag === "H2" && !head.inButton && head.group === "railhead-clients", head);
ok("🔴 it has no tabindex", head.tabindex === null, head);
// Tab through the page: the heading must never take focus.
await frame.focus("body").catch(() => {});
let headingFocused = false, focusedEntries = 0;
for (let i = 0; i < 40; i++) {
  await page.keyboard.press("Tab");
  const f = await frame.evaluate(() => ({
    id: document.activeElement?.id || "", cls: document.activeElement?.className || "",
  }));
  if (f.id === "railhead-clients") headingFocused = true;
  if (/railpipe/.test(String(f.cls))) focusedEntries += 1;
}
ok("🔴 forty Tab presses never focus the heading", !headingFocused, null);
ok("…control: the same presses DO reach the entries", focusedEntries > 0, focusedEntries);
const r0 = await railState();
await frame.click("#railhead-clients");
await page.waitForTimeout(400);
const r1 = await railState();
ok("🔴 clicking the heading changes nothing",
  JSON.stringify(r0) === JSON.stringify(r1), { r0, r1 });

console.log("\n6b · THE ENTRIES");
console.log(`  ${r0.entries.join(" · ")}`);
ok("All clients first, then the five shown pipelines — no ODP",
  JSON.stringify(r0.entries) === JSON.stringify(["All clients", "OLTL Enrollment", "OLTL Transfer",
    "Private Pay", NAMES[P.long], "Lost Pipeline — didn't load"]), r0.entries);
ok("exactly one entry is active, and it is All clients",
  JSON.stringify(r0.active) === '["All clients"]', r0.active);
const failedRow = await frame.evaluate(() => {
  const b = [...document.querySelectorAll(".rail .railpipe")].find((x) => /Lost/.test(x.title));
  return { count: b?.querySelector(".railpipecount")?.textContent, label: b?.getAttribute("aria-label") };
});
ok("🔴 the failed pipeline reads — and \"didn't load\", never 0",
  failedRow.count === "—" && /didn't load/.test(failedRow.label || ""), failedRow);
const longRow = await frame.evaluate((full) => {
  const b = [...document.querySelectorAll(".rail .railpipe")].find((x) => x.title === full);
  const nm = b?.querySelector(".railpipename");
  return { cut: nm ? nm.scrollWidth > nm.clientWidth : null, ell: nm ? getComputedStyle(nm).textOverflow : "" };
}, NAMES[P.long]);
ok("a long name is cut with an ellipsis and carries its full name in title",
  longRow.cut === true && longRow.ell === "ellipsis", longRow);
const pipeOpts = await frame.evaluate(() =>
  [...document.querySelectorAll("#pipeSel option")].map((o) => o.textContent));
ok("🔴 the toolbar dropdown still offers both ODP pipelines",
  pipeOpts.some((t) => /^ODP Enrollment/.test(t)) && pipeOpts.some((t) => /^ODP Transfer/.test(t)), pipeOpts);
ok("🔴 …and the board shows ODP records under All clients",
  r0.cards === allExpected, r0.cards);

console.log("\n6c · CLICKING AN ENTRY");
await frame.click(".railpipe[title='OLTL Transfer']");
await page.waitForTimeout(600);
const r2 = await railState();
ok("the header names the pipeline", r2.h1 === "OLTL Transfer", r2.h1);
ok("the board holds its 2 cards", r2.cards === 2, r2.cards);
ok("exactly one entry is active, the clicked one", JSON.stringify(r2.active) === '["OLTL Transfer"]', r2.active);
const selVal = await frame.evaluate(() => document.querySelector("#pipeSel")?.value);
ok("…and the toolbar dropdown follows — one state, not two", selVal === P.ot, selVal);

await frame.click('.railsec:has-text("Master")');
await page.waitForTimeout(600);
const r3 = await railState();
ok("🔴 on Master, no entry is active", r3.active.length === 0, r3.active);
await frame.click(".railpipe[title='OLTL Enrollment']");
await page.waitForTimeout(800);
const r4 = await railState();
ok("from Master, an entry opens the board on that pipeline",
  r4.h1 === "OLTL Enrollment" && r4.cards === 5, r4);
ok("…with exactly that entry lit", JSON.stringify(r4.active) === '["OLTL Enrollment"]', r4.active);

console.log("\n6d · A SHORT VIEWPORT — THE STAMP IS STILL REACHABLE");
const measureRail = () => frame.evaluate(() => {
  const rail = document.querySelector(".rail");
  const st = document.querySelector(".railbuild");
  const app = document.querySelector(".app");
  // ⚠️ SCROLL THE RAIL, THE WAY A USER CAN — NOT scrollIntoView. The first
  // version used scrollIntoView, and revert J showed it passing on the bug:
  // it scrolled `.app`, which is overflow:hidden and which no user can
  // scroll. So this moves only the rail, and checks `.app` never moved.
  rail.scrollTop = rail.scrollHeight;
  const r = st.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  // ⚠️ AND THE LAST THING IN THE RAIL, not only the stamp: the collapse
  // control sits below it, so on the bug it is the one clipped first.
  const last = rail.lastElementChild;
  const lr = last.getBoundingClientRect();
  const lastHit = document.elementFromPoint(lr.left + lr.width / 2, lr.top + lr.height / 2);
  return { overflows: rail.scrollHeight > rail.clientHeight, inView: r.bottom <= innerHeight && r.top >= 0,
           hit: hit === st || st.contains(hit), appScrolled: app.scrollTop,
           lastCls: last.className, lastInView: lr.bottom <= innerHeight && lr.top >= 0,
           lastHit: lastHit === last || last.contains(lastHit),
           scrollH: rail.scrollHeight, clientH: rail.clientHeight };
});
const fit = await measureRail();
console.log(`  rail ${fit.scrollH}px of content in ${fit.clientH}px`);
ok("…precondition: at 1280×700 the rail's content is taller than the rail", fit.overflows, fit);
ok("🔴 scrolling the rail brings the build stamp on screen", fit.inView && fit.hit, fit);
ok("…without moving `.app`, which no user can scroll", fit.appScrolled === 0, fit.appScrolled);
ok("🔴 …and so does the rail's LAST control (the collapse button)",
  fit.lastCls === "railcollapse" && fit.lastInView && fit.lastHit, fit);


// ⚠️ 700px IS BARELY SHORT ENOUGH TO MATTER. Revert J showed it: with the
// scroll removed, the rail's 5px of overflow is its own bottom padding, so
// nothing visible is cut and only the precondition above goes red. At 600px
// the same rail overflows by a hundred pixels of real controls.
await page.setViewportSize({ width: W, height: 600 });
await page.evaluate(() => { document.querySelector("iframe").style.height = "600px"; });
await page.waitForTimeout(500);
const fit6 = await measureRail();
console.log(`  at 600px: rail ${fit6.scrollH}px of content in ${fit6.clientH}px`);
ok("🔴 at 1280×600 the stamp and the last control are both reachable by scrolling the rail",
  fit6.overflows && fit6.inView && fit6.hit && fit6.lastInView && fit6.lastHit && fit6.appScrolled === 0, fit6);
await page.setViewportSize({ width: W, height: H });
await page.evaluate((h) => { document.querySelector("iframe").style.height = `${h}px`; }, H);
await page.waitForTimeout(400);

console.log("\n6e · COLLAPSED");
await frame.click(".railcollapse");
await page.waitForTimeout(400);
const col = await frame.evaluate(() => {
  const b = document.querySelector(".railpipe[title='OLTL Enrollment']");
  return {
    railW: document.querySelector(".rail").getBoundingClientRect().width,
    ini: b?.querySelector(".railpipeini")?.textContent,
    iniShown: b ? getComputedStyle(b.querySelector(".railpipeini")).display !== "none" : false,
    nameShown: b ? getComputedStyle(b.querySelector(".railpipename")).display !== "none" : true,
    label: b?.getAttribute("aria-label"),
  };
});
ok("collapsed, the rail is 64px", Math.round(col.railW) === 64, col.railW);
ok("…each entry shows its initials, not its name",
  col.ini === "OLTL·E" && col.iniShown && !col.nameShown, col);
ok("…and keeps its full name in aria-label", /^OLTL Enrollment/.test(col.label || ""), col.label);
await frame.click(".railcollapse");
await page.waitForTimeout(300);

console.log("\n6f · THE PIPELINES SCREEN — UNTICK A TAB");
await frame.click(".railpipe[title='OLTL Transfer']");
await page.waitForTimeout(400);
await frame.click('.railsec:has-text("Pipelines")');
await frame.waitForSelector(`#pfside-${P.ot}`, { timeout: 60000 }).catch(() => {});
const boxes = await frame.evaluate((p) => ({
  ot: document.getElementById(`pfside-${p.ot}`)?.checked,
  de: document.getElementById(`pfside-${p.de}`)?.checked,
  cg: !!document.getElementById(`pfside-${p.cg}`),
  none: !!document.getElementById(`pfside-${p.none}`),
}), P);
ok("the checkbox is ticked for a shown pipeline and unticked for a hidden one",
  boxes.ot === true && boxes.de === false, boxes);
ok("…and offered on client pipelines only", boxes.cg === false && boxes.none === false, boxes);
const otBefore = PC.parsePipelineConfig(storedConfig).pipelines[P.ot];
const rememberedBefore = await frame.evaluate(() => localStorage.getItem("mm.clientPipeline"));
// Each pipeline is a <details> row; its controls are inside the closed body.
await frame.click(`.pflist .pfrow:has(#pfside-${P.ot}) > summary`);
await frame.click(`#pfside-${P.ot}`);
await page.waitForTimeout(2500);
const otAfter = PC.parsePipelineConfig(storedConfig).pipelines[P.ot];
ok("🔴 the stored entry gains `sidebar: false`", otAfter.sidebar === false, otAfter);
const { sidebar: _s, ...otRest } = otAfter;
ok("🔴 …and nothing else on it changed",
  JSON.stringify(otRest) === JSON.stringify(otBefore), { otBefore, otAfter });
const r5 = await railState();
ok("🔴 the tab is gone without a reload", !r5.entries.includes("OLTL Transfer"), r5.entries);
// ⚠️ READ AS STATE, NOT BY CLICKING. There is no Clients button any more, and
// clicking "All clients" to get back would set "all" by itself and prove
// nothing. The remembered entry is written from `adminPipeline` on every
// change, so it says what the selection IS.
const remembered = await frame.evaluate(() => localStorage.getItem("mm.clientPipeline"));
ok("🔴 E5 — the selection that stood on it went back to all",
  remembered === "all", remembered);
ok("…control: it WAS on OLTL Transfer just before the untick",
  rememberedBefore === P.ot, rememberedBefore);
await frame.click(".railpipe[title='OLTL Enrollment']");
await page.waitForTimeout(500);
await frame.click(".railpipe[title='All clients']");
await page.waitForTimeout(500);
const r6 = await railState();
ok("…and back on the board, All clients is the one lit entry",
  JSON.stringify(r6.active) === '["All clients"]', r6.active);

await browser.close();
cleanup();
console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
