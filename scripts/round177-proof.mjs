// ---------------------------------------------------------------------------
// ROUND 177 — RECRUITING IN THE SIDEBAR, AND A SIDEBAR THAT STARTS COLLAPSED.
//
// 🔴 NO VALUE DOES TWO JOBS (rule 4). Every pipeline holds a different number
// of records, so a count from the wrong pipeline cannot land on the right
// number; the hidden caregiver pipeline is FIRST in payload order, so a
// default that does not skip hidden ones picks it; the two staff pipelines and
// the four caregiver ones share no counts; and the owner-without-a-grant owns
// 2 of ODP DSP's 5, so "their entry" and "the pipeline's whole count" differ.
//
// ⚠️ THE FAKE IS NOT TIDIER THAN THE REAL THING (rule 2): one caregiver
// pipeline's search FAILS, one client pipeline's too, and the browser half can
// make the whole ?scope=caregiver request fail.
//
// Part 1 drives lib/recruitingSidebar.ts, lib/clientSidebar.ts and the route
// in-process. Part 2 opens the real page. R177_LIB_ONLY=1 stops after Part 1.
//
// Run: npx tsx scripts/round177-proof.mjs
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
  // clients
  oe: "pc_oltl",        // OLTL Enrollment  — 3 + 1 REASSIGN
  pp: "pc_pp",          // Private Pay      — 2
  de: "pc_odp",         // ODP Enrollment   — 4, HIDDEN
  cf: "pc_lost",        // Lost Clients     — search FAILS
  spare: "pc_spare",    // Spare Clients    — 0, HIDDEN (for R4)
  // recruiting — caregiver group (the hidden one FIRST in payload order)
  g4: "cg_hidden",      // Hidden Caregiver Applicants — 2, HIDDEN
  g1: "cg_pp",          // PP Caregiver Applicants      — 4
  g2: "cg_oltl",        // OLTL Caregiver Applicants    — 3, NO GROUP SET
  g3: "cg_odp",         // ODP DSP Applicant            — 5 (2 owned by u_owner)
  gf: "cg_lost",        // Lost Applicants              — search FAILS
  // recruiting — office staff
  s1: "st_oltl",        // OLTL Staff Applicants — 6
  s2: "st_pp",          // PP Staff Applicants   — 1
  none: "pn_events",    // Events — scope none
};
const NAMES = {
  [P.oe]: "OLTL Enrollment", [P.pp]: "Private Pay", [P.de]: "ODP Enrollment",
  [P.cf]: "Lost Clients", [P.spare]: "Spare Clients",
  [P.g4]: "Hidden Caregiver Applicants", [P.g1]: "PP Caregiver Applicants",
  [P.g2]: "OLTL Caregiver Applicants", [P.g3]: "ODP DSP Applicant", [P.gf]: "Lost Applicants",
  [P.s1]: "OLTL Staff Applicants", [P.s2]: "PP Staff Applicants", [P.none]: "Events",
};
const CLIENT_IDS = [P.oe, P.pp, P.de, P.cf, P.spare];
const CG_IDS = [P.g4, P.g1, P.g2, P.g3, P.gf, P.s1, P.s2];
const ON_ACCOUNT = [...CLIENT_IDS, ...CG_IDS, P.none];
const FAILING = new Set([P.cf, P.gf]);
const STAGES = [
  { id: "s1", name: "NEW LEAD", position: 0 },
  { id: "s2", name: "INTAKE", position: 1 },
  { id: "sR", name: "REASSIGN", position: 2 },
];

const ADMIN = "u_admin";
const REC_BOTH = "u_both";   // granted PP Caregiver + OLTL Staff
const OWNER = "u_owner";     // NO grant; owns 2 ODP DSP applicants
const ZERO = "u_zero";       // nothing at all
const REC_ODP = "u_odp";     // granted ODP DSP only → "DSPs"
const blob = (userId, role = "user") =>
  CryptoJS.AES.encrypt(JSON.stringify({
    userId, role, type: "agency", activeLocation: LOC,
    userName: userId, email: `${userId}@e.com`, companyId: "co1",
  }), SECRET).toString();

let n = 0;
const opp = (pipelineId, extra = {}) => ({
  id: `o${++n}`, name: `Case ${n}`, pipelineId, pipelineStageId: "s1", status: "open",
  assignedTo: "", followers: [], createdAt: new Date(Date.now() - n * 3600000).toISOString(),
  contact: { id: `c${n}`, firstName: "Case", lastName: `N${n}` }, ...extra,
});
const many = (k, pid, extra) => Array.from({ length: k }, () => opp(pid, extra));
const OPPS = [
  ...many(3, P.oe), opp(P.oe, { pipelineStageId: "sR" }),
  ...many(2, P.pp), ...many(4, P.de),
  ...many(2, P.g4), ...many(4, P.g1), ...many(3, P.g2),
  ...many(2, P.g3, { assignedTo: OWNER }), ...many(3, P.g3),
  ...many(6, P.s1), ...many(1, P.s2), ...many(1, P.none),
];
// ═══ ROUND 178 · ITEM 4 — CREATED DATES THAT CAN ONLY BE READ ONE WAY ═══════
// A summer date (EDT), a winter date (EST), the UTC/Eastern day boundary
// (2026-10-01T03:34Z is Sep 30, 11:34pm EDT — the 1st only in UTC), a record
// with NO createdAt, and an applicant on the Recruiting board.
const CREATED = {
  summer: "2026-07-15T18:05:00.000Z",
  winter: "2026-01-20T17:30:00.000Z",
  boundary: "2026-10-01T03:34:00.000Z",
  applicant: "2026-08-02T13:00:00.000Z",
};
{
  const oe = OPPS.filter((o) => o.pipelineId === P.oe && o.pipelineStageId !== "sR");
  oe[0].createdAt = CREATED.summer;
  oe[1].createdAt = CREATED.winter;
  oe[2].createdAt = CREATED.boundary;
  OPPS.find((o) => o.pipelineId === P.pp).createdAt = "";
  OPPS.find((o) => o.pipelineId === P.g1).createdAt = CREATED.applicant;
}
/** contactId → createdAt, so a card (which carries data-cid) maps to its record. */
const CREATED_BY_CID = Object.fromEntries(OPPS.map((o) => [o.contact.id, o.createdAt]));

const countIn = (pid) => OPPS.filter((o) => o.pipelineId === pid && o.pipelineStageId !== "sR").length;

const cfgFor = () => ({
  seeded: true, folderNames: {},
  pipelines: {
    [P.oe]: { scope: "client", folders: [] },
    [P.pp]: { scope: "client", folders: [] },
    [P.de]: { scope: "client", folders: [], sidebar: false },
    [P.cf]: { scope: "client", folders: [] },
    [P.spare]: { scope: "client", folders: [], sidebar: false },
    [P.g4]: { scope: "caregiver", folders: [], group: "caregiver", sidebar: false },
    [P.g1]: { scope: "caregiver", folders: [], group: "caregiver" },
    [P.g2]: { scope: "caregiver", folders: ["shared"], exclude: ["F_X"] }, // NO group
    [P.g3]: { scope: "caregiver", folders: [], group: "caregiver" },
    [P.gf]: { scope: "caregiver", folders: [], group: "caregiver" },
    [P.s1]: { scope: "caregiver", folders: [], group: "staff" },
    [P.s2]: { scope: "caregiver", folders: [], group: "staff" },
    [P.none]: { scope: "none", folders: [] },
  },
});
let storedConfig = JSON.stringify(cfgFor());
const access = JSON.stringify({
  pipelines: { [REC_BOTH]: [P.g1, P.s1], [REC_ODP]: [P.g3] },
  folders: {}, master: [], caseManagers: {}, referralAccess: {},
});

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
    if (path.startsWith("/users"))
      return send(200, { users: [ADMIN, REC_BOTH, OWNER, ZERO, REC_ODP].map((id) => ({ id, name: id })) });
    if (path === `/locations/${LOC}/customValues`)
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Folders", value: storedConfig },
        { id: "cv2", name: "MM Pipeline Access", value: access },
      ] });
    if (path === `/locations/${LOC}/customValues/cv1` && req.method === "PUT") {
      storedConfig = JSON.parse(raw || "{}").value;
      return send(200, { customValue: { id: "cv1" } });
    }
    if (path === `/locations/${LOC}/customFields`) return send(200, { customFields: [] });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: ON_ACCOUNT.map((id) => ({ id, name: NAMES[id], stages: STAGES })) });
    if (path === "/opportunities/search") {
      const pid = url.searchParams.get("pipeline_id") || "";
      if (FAILING.has(pid)) return send(422, { message: "fake: this pipeline could not be searched" });
      const rows = OPPS.filter((o) => !pid || o.pipelineId === pid);
      return send(200, { opportunities: rows, meta: { total: rows.length } });
    }
    if (path === "/contacts/search") return send(200, { contacts: [], total: 0 });
    return send(200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const FAKE = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, {
  GHL_API_BASE: FAKE, GHL_PIT: "pit_test", GHL_LOCATION_ID: LOC, GHL_SSO_SECRET: SECRET,
  PIPELINE_IDS: CLIENT_IDS.join(","), CAREGIVER_PIPELINE_IDS: CG_IDS.join(","),
});
delete process.env.PIPELINE_ACCESS_MAP;

const CS = await import("../lib/clientSidebar.ts");
const RS = await import("../lib/recruitingSidebar.ts");
const RL = await import("../lib/recruitingLabels.ts");
const { formatEastern } = await import("../lib/dates.ts");
const OPP_ROUTE = await import("../app/api/opportunities/route.ts");

const load = async (userId, role, scope) => {
  const r = await OPP_ROUTE.POST(new Request(`http://x/api/opportunities${scope ? "?scope=caregiver" : ""}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoKey: blob(userId, role) }),
  }));
  return r.json();
};
const isReassign = (r) => String(r.stage || "").trim().toUpperCase() === "REASSIGN";
/** The Recruiting sidebar exactly as app/page.tsx builds it. */
const cgSide = (b, hiddenOverride) => RS.recruitingModel({
  visible: RS.recruitingVisible(!!b.viewer?.isAdmin, b.pipelines || [], b.viewer?.homePipelineIds || [], b.records || []),
  records: b.records || [],
  hidden: hiddenOverride === undefined ? b.pipelineSidebarHidden : hiddenOverride,
  failed: b.failedPipelines || [],
  groups: b.pipelineGroups || {},
});
const ids = (l) => l.map((e) => e.id);

// ═══════════════════════════════════════════════════════════════════════════
console.log("═══ 1 · THE RECRUITING ENTRIES, AS THE ADMIN SEES THEM ═══");
// ═══════════════════════════════════════════════════════════════════════════
const aCg = await load(ADMIN, "admin", true);
const aSide = cgSide(aCg);
console.log(`  Caregivers: ${aSide.caregiver.map((e) => e.name).join(" · ")}`);
console.log(`  Office staff: ${aSide.staff.map((e) => e.name).join(" · ")}`);
ok("Caregivers lists PP, OLTL (no group set), ODP DSP and the failed one, in payload order",
  JSON.stringify(ids(aSide.caregiver)) === JSON.stringify([P.g1, P.g2, P.g3, P.gf]), ids(aSide.caregiver));
ok("Office staff lists the two staff pipelines", JSON.stringify(ids(aSide.staff)) === JSON.stringify([P.s1, P.s2]),
  ids(aSide.staff));
const groups = aCg.pipelineGroups || {};
ok("🔴 no staff pipeline under Caregivers", aSide.caregiver.every((e) => groups[e.id] !== "staff"), groups);
ok("🔴 no caregiver pipeline under Office staff", aSide.staff.every((e) => groups[e.id] === "staff"), groups);
ok("🔴 no \"All\" entry under Recruiting",
  ![...aSide.caregiver, ...aSide.staff].some((e) => e.id === "all" || /^all\b/i.test(e.name)), null);
ok("🔴 the hidden caregiver pipeline has NO entry", !ids(aSide.caregiver).includes(P.g4), ids(aSide.caregiver));
ok("🔴 …but its 2 applicants are still in the payload",
  (aCg.records || []).filter((r) => r.pipelineId === P.g4).length === 2, null);
ok("🔴 …and it is still in the Caregivers dropdown's list",
  RS.inGroup(RS.recruitingVisible(true, aCg.pipelines, [], aCg.records), "caregiver", groups)
    .some((p) => p.id === P.g4), null);
ok("…with its real count, 2", aSide.counts[P.g4] === 2, aSide.counts);
ok("…control: un-hidden, its entry comes back", ids(cgSide(aCg, {}).caregiver).includes(P.g4), null);
ok("the caregiver response carries the hidden map (B8)",
  aCg.pipelineSidebarHidden?.[P.g4] === true, aCg.pipelineSidebarHidden);

console.log("\n1b · COUNTS — EACH ITS OWN, THE FAILED ONE NONE");
ok("PP 4, OLTL 3, ODP 5, OLTL Staff 6, PP Staff 1",
  aSide.counts[P.g1] === 4 && aSide.counts[P.g2] === 3 && aSide.counts[P.g3] === 5 &&
    aSide.counts[P.s1] === 6 && aSide.counts[P.s2] === 1, aSide.counts);
const lost = aSide.caregiver.find((e) => e.id === P.gf);
ok("🔴 the failed caregiver pipeline is failed with no count — never 0",
  lost?.failed === true && lost?.count === null, lost);
ok("…control: it really failed, and the response says so",
  (aCg.failedPipelines || []).some((f) => f.id === P.gf), aCg.failedPipelines);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 2 · THE OTHER RECRUITERS ═══");
// ═══════════════════════════════════════════════════════════════════════════
const both = cgSide(await load(REC_BOTH, "user", true));
ok("granted one of each: PP Caregiver under Caregivers, OLTL Staff under Office staff",
  JSON.stringify(ids(both.caregiver)) === JSON.stringify([P.g1]) &&
    JSON.stringify(ids(both.staff)) === JSON.stringify([P.s1]), { cg: ids(both.caregiver), st: ids(both.staff) });
const ownerBody = await load(OWNER, "user", true);
const owner = cgSide(ownerBody);
ok("🔴 B5 — the no-grant owner gets an entry for the pipeline their records are in",
  JSON.stringify(ids(owner.caregiver)) === JSON.stringify([P.g3]), ids(owner.caregiver));
ok("…with THEIR count, 2, not the pipeline's 5", owner.counts[P.g3] === 2, owner.counts);
ok("…control: the client rule (home only) would give them nothing — B6",
  CS.selectableFor(false, ownerBody.pipelines || [], ownerBody.viewer?.homePipelineIds || []).length === 0, null);
const zeroBody = await load(ZERO, "user", true);
const zero = cgSide(zeroBody);
const zeroCause = RS.recruitingEmptyCause({
  loadFailed: false, noRecruitingAccess: true,
  visibleCount: RS.recruitingVisible(false, zeroBody.pipelines || [], zeroBody.viewer?.homePipelineIds || [], zeroBody.records || []).length,
  withheld: zeroBody.pipelinesWithheld || 0, allHidden: zero.allHidden,
});
ok("🔴 D9 — the zero-access user's sidebar says why: no pipelines assigned",
  zeroCause === "noAccess" && /No recruiting pipelines assigned yet/.test(RS.RECRUITING_EMPTY_LINE[zeroCause]), zeroCause);
ok("🔴 M3 — a failed load says it did not load, and outranks the access line",
  RS.recruitingEmptyCause({ loadFailed: true, noRecruitingAccess: true, visibleCount: 0, withheld: 0, allHidden: false }) === "loadFailed" &&
    /didn't load/.test(RS.RECRUITING_EMPTY_LINE.loadFailed), null);
const odpBody = await load(REC_ODP, "user", true);
ok("the ODP-only recruiter's sub-label reads DSPs",
  RL.recruitingNouns("caregiver", RL.isOdpOnlyRecruiting((odpBody.pipelines || []).map((p) => p.name))).group === "DSPs",
  (odpBody.pipelines || []).map((p) => p.name));
ok("…control: the admin's reads Caregivers",
  RL.recruitingNouns("caregiver", RL.isOdpOnlyRecruiting(aCg.pipelines.map((p) => p.name))).group === "Caregivers", null);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 3 · CLICK, DEFAULT, RESET ═══");
// ═══════════════════════════════════════════════════════════════════════════
const st = { cgGroup: "caregiver", cgView: "list", cgQuery: "smith", selPipelineId: P.g1 };
let nx = RS.pickRecruitingPipeline(st, P.s1, groups);
ok("🔴 D5 — Caregivers, click a staff entry → the group becomes staff", nx.cgGroup === "staff", nx);
ok("🔴 D5 — staff, click a caregiver entry → caregiver",
  RS.pickRecruitingPipeline({ ...st, cgGroup: "staff" }, P.g2, groups).cgGroup === "caregiver", null);
ok("🔴 D5 — \"all\" stays \"all\"", RS.pickRecruitingPipeline({ ...st, cgGroup: "all" }, P.s1, groups).cgGroup === "all", null);
ok("it opens Recruiting on that pipeline", nx.view === "caregivers" && nx.cgPipeline === P.s1, nx);
ok("stage and tile focus reset; the search text is kept",
  nx.cgStage === null && nx.cgFocus === null && nx.cgQuery === "smith", nx);
ok("List stays List; Resources goes to Board",
  nx.cgView === "list" && RS.pickRecruitingPipeline({ ...st, cgView: "resources" }, P.s1, groups).cgView === "board", null);
ok("an open record outside the picked pipeline is closed; one inside stays",
  nx.closeRecord === true && RS.pickRecruitingPipeline(st, P.g1, groups).closeRecord === false, null);
const careList = RS.inGroup(RS.recruitingVisible(true, aCg.pipelines, [], aCg.records), "caregiver", groups);
ok("🔴 F — the default is the first SHOWN pipeline, not the hidden one ahead of it",
  careList[0].id === P.g4 && RS.activeRecruitingPipeline("all", careList, aCg.pipelineSidebarHidden) === P.g1,
  careList.map((p) => p.id));
const allHidden = Object.fromEntries(careList.map((p) => [p.id, true]));
ok("F — every one hidden: land on the first hidden one (data on the board)",
  RS.activeRecruitingPipeline("all", careList, allHidden) === P.g4, null);
ok("🔴 B7 — a staff pick is never drawn on the Caregivers board",
  RS.activeRecruitingPipeline(P.s1, careList, aCg.pipelineSidebarHidden) === P.g1, null);
ok("…control: a caregiver pick is kept", RS.activeRecruitingPipeline(P.g3, careList, {}) === P.g3, null);
ok("a remembered pipeline is restored; a hidden or unopenable one is not",
  RS.restoreRememberedCg(P.g3, careList, {}) === P.g3 &&
    RS.restoreRememberedCg(P.g4, careList, aCg.pipelineSidebarHidden) === "all" &&
    RS.restoreRememberedCg("nope", careList, {}) === "all", null);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 4 · THE CLIENT DROPDOWN'S NUMBERS (R1, ADDITION 2) ═══");
// ═══════════════════════════════════════════════════════════════════════════
const aCl = await load(ADMIN, "admin", false);
const cl = CS.sidebarModel({
  selectable: CS.selectableFor(true, aCl.pipelines, []), records: aCl.records,
  hidden: aCl.pipelineSidebarHidden, failed: aCl.failedPipelines || [], isExcluded: isReassign,
});
ok("🔴 a HIDDEN pipeline's dropdown count is its real count (ODP 4)",
  cl.counts[P.de] === 4 && !cl.entries.some((e) => e.id === P.de), cl.counts);
ok("🔴 REASSIGN is not counted (OLTL 3, not 4)", cl.counts[P.oe] === 3, cl.counts[P.oe]);
ok("🔴 a failed client pipeline is null, never 0", cl.counts[P.cf] === null, cl.counts[P.cf]);
ok("the dropdown's All is the sidebar's All clients (no REASSIGN)",
  cl.all.count === countIn(P.oe) + countIn(P.pp) + countIn(P.de), cl.all);
ok("R2 — All clients says how many sit in hidden pipelines", cl.all.inHidden === 4, cl.all);

console.log("\n4b · R5 — THE BUILD REFUSAL SAYS \"DIFFERENT\", NOT \"OLDER\"");
const ADMIN_ROUTE = await import("../app/api/admin/pipelines/route.ts");
const r5 = await ADMIN_ROUTE.POST(new Request("http://x/api/admin/pipelines", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ ssoKey: blob(ADMIN, "admin"), action: "save-config", build: "999", config: cfgFor() }),
}));
const r5b = await r5.json().catch(() => ({}));
ok("a page NEWER than the server is refused", r5.status === 409 && r5b.refusal === true, r5b);
ok("🔴 …and is not told it is older", /different version/.test(r5b.error || "") && !/older/.test(r5b.error || ""),
  r5b.error);

if (process.env.R177_LIB_ONLY) {
  server.close();
  console.log(`\n${pass} passed · ${fail} failed  (lib only — no browser)`);
  process.exit(fail ? 1 : 0);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 5 · THE PAGE, IN A BROWSER ═══");
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
  detached: true, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
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
/** A fresh browser profile signed in as one user, inside the GHL-style parent. */
const openAs = async (userId, role, { width = W, height = H, failCg = false, hold = {} } = {}) => {
  // ROUND 178 — `ctl.hold.cg` / `ctl.hold.client` keep the next request of
  // that kind waiting this many ms, so a leg lasts long enough to press during
  // it; `ctl.mid` records the Refresh button's state half-way through a hold.
  const ctl = { hold: { ...hold }, mid: [] };
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));
  // 🔴 EVERY FRAME'S RAIL WIDTH, FROM THE FIRST ANIMATION FRAME — before the
  // first paint, which is where a 184 → 64 flash would be.
  await page.addInitScript(() => {
    window.__railW = [];
    const tick = () => {
      const r = document.querySelector(".rail");
      if (r) window.__railW.push(Math.round(r.getBoundingClientRect().width));
      if (window.__railW.length < 600) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const log = [];
  await page.route("**/api/opportunities*", async (route) => {
    const cg = /scope=caregiver/.test(route.request().url());
    const entry = { cg, start: Date.now(), cardsAtStart: null };
    if (cg) {
      const f = page.frames().find((x) => x !== page.mainFrame());
      entry.cardsAtStart = await f?.evaluate(() => document.querySelectorAll(".board .colbody .card").length)
        .catch(() => null);
    }
    log.push(entry);
    const holdMs = ctl.hold[cg ? "cg" : "client"] || 0;
    if (holdMs) {
      await new Promise((r) => setTimeout(r, holdMs / 2));
      const f = page.frames().find((x) => x !== page.mainFrame());
      ctl.mid.push({ cg, ...(await f?.evaluate(() => {
        const b = document.querySelector(".refreshbtn");
        const retries = [...document.querySelectorAll(".loadwarn .linkbtn")];
        return { disabled: !!b?.disabled, label: b?.textContent || "",
          retries: retries.length, retriesDisabled: retries.every((x) => x.disabled) };
      }).catch(() => ({}))) });
      await new Promise((r) => setTimeout(r, holdMs / 2));
    }
    if (cg && failCg) {
      entry.end = Date.now();
      return route.fulfill({ status: 500, contentType: "application/json",
        body: JSON.stringify({ error: "fake: the recruiting load failed" }) });
    }
    const resp = await route.fetch();
    entry.end = Date.now();
    return route.fulfill({ response: resp });
  });
  const B = blob(userId, role);
  await page.route(`${base}/__parent`, (route) => route.fulfill({
    status: 200, contentType: "text/html",
    body: `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0}iframe{border:0;width:${width}px;height:${height}px}</style>
<script>window.addEventListener("message",(e)=>{if(e.data&&e.data.message==="REQUEST_USER_DATA")
e.source.postMessage({message:"REQUEST_USER_DATA_RESPONSE",payload:${JSON.stringify(B)}},"*");});</script>
<iframe src="${base}/"></iframe>`,
  }));
  await page.goto(`${base}/__parent`, { waitUntil: "domcontentloaded" });
  const frame = await (await page.waitForSelector("iframe")).contentFrame();
  return { ctx, page, frame, log, ctl };
};
const RG = '[aria-labelledby="railhead-recruiting"]';
const CG = '[aria-labelledby="railhead-clients"]';
const lit = (frame) => frame.evaluate(() =>
  [...document.querySelectorAll(".rail .railpipe.active")].map((b) => b.dataset.pipeline));

// ROUND 178 — the start-up caregiver load is held 1.6s, so the button can be
// read while it is in flight (the accepted "Refreshing…" with nobody pressing).
const A = await openAs(ADMIN, "admin", { hold: { cg: 1600 } });
const { page, frame } = A;
// ⚠️ SOFT: a revert that stops Recruiting loading must fail ASSERTIONS below,
// not crash here — a crash is not a passing revert.
await frame.waitForSelector(`${CG} .railpipe[data-pipeline="${P.oe}"]`, { timeout: 150000 });
await frame.waitForSelector(`${RG} .railpipe[data-pipeline="${P.g1}"]`, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2500);

A.ctl.hold = {};
console.log("\n5a0 · ROUND 178 — THE START-UP CAREGIVER LOAD COUNTS AS LOADING (ACCEPTED)");
const startMid = A.ctl.mid.find((m) => m.cg);
ok("ROUND 178 · while the start-up ?scope=caregiver is in flight, Refresh is disabled and says Refreshing…",
  startMid?.disabled === true && /Refreshing/.test(startMid?.label || ""), startMid);
const btnNow = await frame.evaluate(() => {
  const b = document.querySelector(".refreshbtn");
  return { disabled: b.disabled, label: b.textContent };
});
ok("ROUND 178 · …and enabled, reading Refresh, once it has ended",
  btnNow.disabled === false && /Refresh$/.test(btnNow.label.trim()), btnNow);

// ⚠️ ROUND 181 REVERSED D10: a fresh browser now starts EXPANDED. Same
// assertion shape — every frame one width, never the other — other way round.
console.log("\n5a · 🔴 D10/R181 — A FRESH BROWSER STARTS EXPANDED, WITH NO NARROW FRAME");
const w0 = await frame.evaluate(() => window.__railW);
ok("🔴 every sampled frame from first paint is 184px — never 64",
  w0.length > 0 && w0.every((w) => w === 184), [...new Set(w0)]);
ok("…the server HTML already says expanded",
  /<html[^>]*data-rail="expanded"/.test(await (await fetch(`${base}/`)).text()), null);

console.log("\n5b · D8 — RECRUITING LOADS ONCE, AFTER THE CLIENT BOARD");
const cgReqs = A.log.filter((e) => e.cg);
const firstClient = A.log.find((e) => !e.cg);
ok("🔴 exactly one ?scope=caregiver request on this page load", cgReqs.length === 1, A.log.map((e) => e.cg));
ok("🔴 …it started after the client response was in", cgReqs[0]?.start >= (firstClient?.end || Infinity),
  { client: firstClient, cg: cgReqs[0] });
ok("🔴 …and the client board's cards were already drawn — it was not delayed",
  (cgReqs[0]?.cardsAtStart || 0) > 0, cgReqs[0]?.cardsAtStart);

console.log("\n5c · 🔴 ADDITION 1 — COLLAPSED (THE DEFAULT) HIDES NOTHING THAT MATTERS");
const marks = await frame.evaluate((p) => {
  const q = (id) => document.querySelector(`.railpipe[data-pipeline="${id}"]`);
  const fl = (b) => b && {
    title: b.title, ini: getComputedStyle(b.querySelector(".railpipeini")).color,
    dot: getComputedStyle(b, "::after").content,
  };
  return { cf: fl(q(p.cf)), gf: fl(q(p.gf)), g1: q(p.g1)?.title, oe: q(p.oe)?.title,
    all: document.querySelector('.railpipe[data-pipeline="all"]')?.title };
}, P);
const GOLD = "rgb(232, 154, 60)";
ok("🔴 a failed CLIENT pipeline is marked: gold initials and a dot",
  marks.cf?.ini === GOLD && marks.cf?.dot !== "none", marks.cf);
ok("🔴 a failed CAREGIVER pipeline is marked the same", marks.gf?.ini === GOLD && marks.gf?.dot !== "none", marks.gf);
ok("…and both titles say \"didn't load\"", /didn't load/.test(marks.cf?.title) && /didn't load/.test(marks.gf?.title), marks);
ok("🔴 each entry's title carries its count", marks.g1 === "PP Caregiver Applicants — 4" && marks.oe === "OLTL Enrollment — 3", marks);
ok("🔴 All clients' title carries the hidden-pipelines note (R2)", /includes 4 in pipelines hidden/.test(marks.all || ""), marks.all);

console.log("\n5d · THE ENTRIES ON SCREEN, AND ONE LIT");
const onScreen = await frame.evaluate(({ RG }) => ({
  cg: [...document.querySelectorAll(`${RG} .railpipe`)].map((b) => b.dataset.pipeline),
  subs: [...document.querySelectorAll(`${RG} .railsub`)].map((d) => d.textContent),
  head: document.getElementById("railhead-recruiting")?.tagName,
  headTab: document.getElementById("railhead-recruiting")?.getAttribute("tabindex"),
}), { RG });
ok("Recruiting: Caregivers then Office staff, in order, no hidden one",
  JSON.stringify(onScreen.cg) === JSON.stringify([P.g1, P.g2, P.g3, P.gf, P.s1, P.s2]), onScreen.cg);
ok("the sub-labels read Caregivers and Office staff",
  JSON.stringify(onScreen.subs) === '["Caregivers","Office staff"]', onScreen.subs);
ok("🔴 the Recruiting heading is an H2 with no tabindex", onScreen.head === "H2" && onScreen.headTab === null, onScreen);
ok("🔴 no button is named exactly \"Recruiting\"",
  (await frame.getByRole("button", { name: "Recruiting", exact: true }).count()) === 0, null);
const clientOpts = await frame.evaluate(() =>
  [...document.querySelectorAll("#pipeSel option")].map((o) => o.textContent));
ok("🔴 R1 — the client dropdown shows the sidebar's numbers: hidden ODP 4, OLTL 3 without REASSIGN, All 9",
  clientOpts.includes("ODP Enrollment (4)") && clientOpts.includes("OLTL Enrollment (3)") &&
    clientOpts.includes("All (9)"), clientOpts);
ok("🔴 …and the failed one reads \"didn't load\", never 0", clientOpts.includes("Lost Clients (didn't load)"), clientOpts);
ok("🔴 on Clients, exactly one entry is lit across the whole rail — All clients",
  JSON.stringify(await lit(frame)) === '["all"]', await lit(frame));

console.log("\n5d2 · ROUND 178 · ITEM 4 — THE CREATED LINE ON CLIENT CARDS");
/** Every card on the board: its contact id, its created line (or null), whether it shows. */
const readCards = () => frame.evaluate(() =>
  [...document.querySelectorAll(".board .colbody .card")].map((c) => {
    const line = c.querySelector(".ccreated");
    const r = line?.getBoundingClientRect();
    return { cid: c.getAttribute("data-cid"), text: line ? line.textContent : null,
      shown: !!line && r.width > 0 && r.height > 0 && getComputedStyle(line).display !== "none" };
  }));
const checkCards = (cards, where) => {
  const wrong = cards.filter((c) => {
    const want = formatEastern(CREATED_BY_CID[c.cid]);
    return want ? !(c.text === `Created ${want}` && c.shown) : c.text !== null;
  });
  ok(`ROUND 178 · on the ${where} board every card's line is "Created " + formatEastern(createdAt), and shows`,
    cards.length > 0 && wrong.length === 0, wrong.slice(0, 3));
};
const cc = await readCards();
checkCards(cc, "Clients");
const byCreated = (iso) => cc.find((c) => CREATED_BY_CID[c.cid] === iso);
ok("ROUND 178 · a summer date reads EDT", /\(EDT\)$/.test(byCreated(CREATED.summer)?.text || ""), byCreated(CREATED.summer));
ok("ROUND 178 · a winter date reads EST", /\(EST\)$/.test(byCreated(CREATED.winter)?.text || ""), byCreated(CREATED.winter));
ok("ROUND 178 · 2026-10-01T03:34Z reads Sep 30, 11:34pm (EDT) — not Oct 1",
  byCreated(CREATED.boundary)?.text === "Created Sep 30 2026, 11:34pm (EDT)", byCreated(CREATED.boundary));
const noDate = cc.find((c) => CREATED_BY_CID[c.cid] === "");
ok("ROUND 178 · the record with no createdAt has NO created line", !!noDate && noDate.text === null, noDate);
ok("ROUND 178 · \"Invalid Date\" appears nowhere",
  !/Invalid Date/.test(await frame.evaluate(() => document.body.textContent || "")), null);
const cardH = await frame.evaluate(() => {
  const card = document.querySelector(".board .colbody .card:has(.ccreated)");
  const line = card.querySelector(".ccreated");
  const after = card.getBoundingClientRect().height;
  line.style.display = "none";
  const before = card.getBoundingClientRect().height;
  line.style.display = "";
  return { before: Math.round(before), after: Math.round(after) };
});
console.log(`  card height: ${cardH.before}px without the line → ${cardH.after}px with it`);
ok("ROUND 178 · the line adds one small row to the card (≤ 20px)",
  cardH.after > cardH.before && cardH.after - cardH.before <= 20, cardH);

console.log("\n5e · CLICKING RECRUITING ENTRIES");
const cgState = () => frame.evaluate(() => ({
  h1: document.querySelector(".main h1")?.textContent?.replace(/\s+/g, " ").trim() || "",
  sel: document.querySelector("#cgPipeSel")?.value || "",
  opts: [...document.querySelectorAll("#cgPipeSel option")].map((o) => o.value),
  optText: [...document.querySelectorAll("#cgPipeSel option")].map((o) => o.textContent),
  cards: document.querySelectorAll(".board .colbody .card").length,
  warn: [...document.querySelectorAll(".loadwarn")].map((w) => w.textContent).join(" | "),
}));
await frame.click(`${RG} .railpipe[data-pipeline="${P.s1}"]`);
await page.waitForTimeout(700);
let c1 = await cgState();
ok("from Clients, a staff entry opens Recruiting on Office staff", /Office staff/.test(c1.h1), c1.h1);
ok("…on that pipeline: its 6 cards, the dropdown on it", c1.sel === P.s1 && c1.cards === 6, c1);
ok("🔴 exactly one lit entry across the whole rail — that one", JSON.stringify(await lit(frame)) === `["${P.s1}"]`, await lit(frame));
await frame.click(`${RG} .railpipe[data-pipeline="${P.g2}"]`);
await page.waitForTimeout(600);
c1 = await cgState();
ok("a caregiver entry (no group set) switches to Caregivers", /Caregivers/.test(c1.h1) && c1.sel === P.g2 && c1.cards === 3, c1);
ok("🔴 the hidden pipeline is still offered in #cgPipeSel, with its count",
  c1.opts.includes(P.g4) && c1.optText.some((t) => /^Hidden Caregiver Applicants \(2\)/.test(t)), c1.optText);
ok("🔴 the failed pipeline reads \"didn't load\" in #cgPipeSel, never 0",
  c1.optText.some((t) => /^Lost Applicants \(didn't load\)/.test(t)), c1.optText);
ok("🔴 H — the Recruiting board says it didn't load", /Lost Applicants didn't load/.test(c1.warn), c1.warn);

console.log("\n5f · 🔴 B7 — THE GROUP SWITCH NEVER LEAVES THE OTHER GROUP'S PIPELINE");
const pickGroup = async (label) => {
  await frame.click(".main h1 button");
  await page.waitForTimeout(250);
  await frame.click(`[aria-label="Recruiting group"] button:has-text("${label}")`);
  await page.waitForTimeout(500);
};
await pickGroup("All applicants");
ok("D4 — \"All applicants\" is still in the switcher", /All/.test((await cgState()).h1), (await cgState()).h1);
await frame.click(`${RG} .railpipe[data-pipeline="${P.s2}"]`);
await page.waitForTimeout(600);
c1 = await cgState();
ok("🔴 D5 — under All, clicking a staff entry keeps All", /All/.test(c1.h1) && c1.sel === P.s2, c1);
await pickGroup("Caregiver applicants");
c1 = await cgState();
ok("🔴 switching to Caregivers leaves no staff pipeline on the board",
  c1.sel !== P.s2 && c1.opts.includes(c1.sel) && c1.cards !== 1, c1);
ok("🔴 …it lands on the first SHOWN caregiver pipeline (PP, 4), not the hidden one ahead of it",
  c1.sel === P.g1 && c1.cards === 4, c1);
const rc = await readCards();
checkCards(rc, "Recruiting");
ok("ROUND 178 · the applicant's line reads its Eastern created time",
  rc.some((c) => c.text === `Created ${formatEastern(CREATED.applicant)}`), rc.map((c) => c.text));

console.log("\n5g · 🔴 M9 — A NEW APPLICANT: THE BOARD FOLLOWS IT");
const beforeAdd = (await cgState()).sel;
await page.route("**/api/caregivers", (route) => route.fulfill({ status: 200, contentType: "application/json",
  body: JSON.stringify({ opportunityId: "o_new", pipelineId: P.g3, pipelineName: "ODP DSP Applicant" }) }));
await frame.click('button:has-text("+ Add Applicant")');
await frame.fill("#cg-first", "Nia");
await frame.fill("#cg-phone", "2155550100");
await frame.selectOption("#cg-div", "ODP");
await frame.click('.previewmodal button:has-text("Add")').catch(() => {});
await page.waitForTimeout(2200);
c1 = await cgState();
ok("🔴 after the add, the board is on the pipeline it landed in", c1.sel === P.g3, c1.sel);
ok("…and that entry is the lit one", JSON.stringify(await lit(frame)) === `["${P.g3}"]`, await lit(frame));
ok("…control: it was on PP Caregiver before the add", beforeAdd === P.g1, beforeAdd);

console.log("\n5h · 🔴 Q4 — REFRESH RELOADS BOTH, IN SEQUENCE");
// ═══ ROUND 178 · ITEM 1 — THE BUTTON STAYS DISABLED FOR BOTH LEGS ════════════
// Every animation frame from the press until both requests have ended is
// sampled — the hand-over between legs included, which is where a one-frame
// "enabled" would be — and the SECOND leg is held 2.5s so a second press can
// land during it.
const sampleButton = () => frame.evaluate(() => {
  window.__btn = [];
  window.__sampling = true;
  const tick = () => {
    const b = document.querySelector(".refreshbtn");
    window.__btn.push({ t: Date.now(), disabled: !!b?.disabled, busy: /Refreshing/.test(b?.textContent || "") });
    if (window.__sampling) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const stopSampling = () => frame.evaluate(() => { window.__sampling = false; return window.__btn; });
const pressAndCheck = async (where, secondLeg) => {
  const mark0 = A.log.length;
  A.ctl.mid = [];
  A.ctl.hold = { [secondLeg]: 2500 };
  await sampleButton();
  const t0 = Date.now();
  await frame.click(".refreshbtn");
  // wait for leg 2 to START, then press again while it is held
  for (let i = 0; i < 60 && A.log.length < mark0 + 2; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(300);
  await frame.$eval(".refreshbtn", (b) => b.click());
  for (let i = 0; i < 80 && !(A.log[mark0 + 1]?.end); i++) await page.waitForTimeout(100);
  await page.waitForTimeout(600);
  const frames = await stopSampling();
  A.ctl.hold = {};
  const legs = A.log.slice(mark0);
  const lastEnd = Math.max(...legs.map((e) => e.end || 0));
  // ⚠️ FROM THE FIRST REQUEST, NOT FROM t0. t0 is taken before Playwright's
  // click, which takes ~100ms to land: the first run went red on a frame at
  // +59ms when the press's first request only started at +149ms — a frame
  // from BEFORE the press. The hand-over between legs is inside this window.
  const firstStart = legs[0]?.start || t0;
  const during = frames.filter((f) => f.t >= firstStart && f.t <= lastEnd - 50);
  ok(`ROUND 178 · ${where}: the button is disabled on EVERY frame until both requests end (${during.length} frames)`,
    during.length > 10 && during.every((f) => f.disabled),
    { off: during.filter((f) => !f.disabled).slice(0, 3).map((f) => f.t - t0), legs: legs.map((e) => [e.cg, e.start - t0, (e.end || 0) - t0]) });
  ok(`ROUND 178 · ${where}: …and reads "Refreshing…" on every one of them`,
    during.length > 10 && during.every((f) => f.busy), during.filter((f) => !f.busy).slice(0, 3));
  ok(`ROUND 178 · ${where}: a second press during leg 2 sent NO request`, legs.length === 2, legs.map((e) => e.cg));
  const after = await frame.evaluate(() => ({ d: document.querySelector(".refreshbtn").disabled,
    l: document.querySelector(".refreshbtn").textContent.trim() }));
  ok(`ROUND 178 · ${where}: control — enabled again, reading Refresh, once both have ended`,
    after.d === false && /Refresh$/.test(after.l), after);
  return legs;
};
let mark = A.log.length;
let pressed = await pressAndCheck("on Recruiting", "client");
const midR = A.ctl.mid.find((m) => !m.cg);
ok("ROUND 178 · during a Refresh the H banner's Try again is disabled too",
  (midR?.retries || 0) > 0 && midR.retriesDisabled === true, midR);
ok("🔴 on Recruiting: exactly 2 requests — recruiting first, then clients",
  pressed.length === 2 && pressed[0].cg && !pressed[1].cg, pressed.map((e) => e.cg));
ok("🔴 …the second started after the first was in", pressed[1]?.start >= (pressed[0]?.end || Infinity), pressed);
await frame.click(`${CG} .railpipe[data-pipeline="all"]`);
await page.waitForTimeout(800);
mark = A.log.length;
pressed = await pressAndCheck("on Clients", "cg");
ok("🔴 on Clients: exactly 2 — clients first, then recruiting",
  pressed.length === 2 && !pressed[0].cg && pressed[1].cg, pressed.map((e) => e.cg));
ok("🔴 …in sequence", pressed[1]?.start >= (pressed[0]?.end || Infinity), pressed);
await frame.click('.railsec:has-text("Master")');
await page.waitForTimeout(600);
ok("on Master, nothing is lit", (await lit(frame)).length === 0, await lit(frame));

console.log("\n5i · RAIL HEIGHT — REACHABLE COLLAPSED AND EXPANDED, AT 700 AND 600");
const measure = () => frame.evaluate(() => {
  const rail = document.querySelector(".rail");
  const app = document.querySelector(".app");
  rail.scrollTop = rail.scrollHeight;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.bottom <= innerHeight && r.top >= 0 && (hit === el || el.contains(hit));
  };
  const out = { w: Math.round(rail.getBoundingClientRect().width), content: rail.scrollHeight,
    box: rail.clientHeight, stamp: vis(document.querySelector(".railbuild")),
    last: vis(rail.lastElementChild), app: app.scrollTop,
    railsec: Math.round(document.querySelector(".rail .railsec").getBoundingClientRect().height) };
  rail.scrollTop = 0;
  return out;
});
// ⚠️ THE DEV-MODE INDICATOR IS NOT THE PAGE. `next dev` draws <nextjs-portal>
// in the bottom-left corner, which at 64px sits exactly over the collapsed
// stamp, so elementFromPoint hit the indicator and the first run of this
// section went red on a build that was fine (measured: stamp on screen at
// 637–650px of 700, the hit was NEXTJS-PORTAL). Production has no such
// element; hiding it here measures what a user of the deployed page sees.
await frame.addStyleTag({ content: "nextjs-portal{display:none!important}" });
const heights = {};
for (const mode of ["expanded", "collapsed"]) { // ROUND 181: expanded is first now
  for (const hh of [700, 600]) {
    await page.setViewportSize({ width: W, height: hh });
    await page.evaluate((x) => { document.querySelector("iframe").style.height = `${x}px`; }, hh);
    await page.waitForTimeout(400);
    const m = await measure();
    heights[`${mode}@${hh}`] = m;
    ok(`${mode} at 1280×${hh}: stamp and last control reachable by scrolling the rail, .app unmoved`,
      m.stamp && m.last && m.app === 0, m);
  }
  if (mode === "expanded") {
    await page.setViewportSize({ width: W, height: H });
    await page.evaluate((x) => { document.querySelector("iframe").style.height = `${x}px`; }, H);
    await frame.click(".railcollapse"); // « collapses (ROUND 181: it starts expanded)
    await page.waitForTimeout(500);
  }
}
console.log(`  heights: ${JSON.stringify(Object.fromEntries(Object.entries(heights).map(([k, v]) => [k, `${v.content}/${v.box} railsec ${v.railsec}`])))}`);
ok("the default rail is 184px", heights["expanded@700"].w === 184, heights["expanded@700"].w);
ok("« collapsed the rail to 64px", heights["collapsed@700"].w === 64, heights["collapsed@700"].w);

console.log("\n5j · 🔴 THE CHOICE SURVIVES A RELOAD — AND DOES NOT FLASH NARROW");
await page.setViewportSize({ width: W, height: H });
await frame.evaluate(() => location.reload());
await page.waitForTimeout(500);
const f2 = page.frames().find((x) => x !== page.mainFrame());
await f2.waitForSelector(".railpipe", { timeout: 90000 });
await page.waitForTimeout(1500);
const w1 = await f2.evaluate(() => window.__railW);
// ROUND 181 — the stored choice is now « (collapsed), so the reload must hold
// 64px from the first frame, with no 184px default flashing first.
ok("🔴 after a reload, every frame is 64px — no 184px frame first", w1.length > 0 && w1.every((w) => w === 64),
  [...new Set(w1)]);
// » again, so the narrow check below is still "even for somebody who chose expanded".
await f2.click(".railcollapse");
await page.waitForTimeout(500);
await page.setViewportSize({ width: 600, height: H });
await page.evaluate(() => { document.querySelector("iframe").style.width = "600px"; });
await page.waitForTimeout(700);
const narrow = await f2.evaluate(() => ({
  w: Math.round(document.querySelector(".rail").getBoundingClientRect().width),
  btn: getComputedStyle(document.querySelector(".railcollapse")).display,
}));
ok("🔴 ≤640px is collapsed even for somebody who chose expanded", narrow.w === 64, narrow);
ok("…and « » is hidden there, not disabled", narrow.btn === "none", narrow);
await A.ctx.close();

console.log("\n5k · 🔴 Q1 + ADDITION 1 — THE ZERO-ACCESS USER'S WAY IN, COLLAPSED");
const Z = await openAs(ZERO, "user");
// ⚠️ ATTACHED, NOT VISIBLE: whether it is visible collapsed is the assertion
// (revert A1b crashed here instead of going red).
await Z.frame.waitForSelector(".railopen", { state: "attached", timeout: 150000 });
// ROUND 181 — a fresh browser starts expanded now; « to test the collapsed rail.
await Z.frame.click(".railcollapse");
await Z.page.waitForTimeout(800);
const zo = await Z.frame.evaluate(() => {
  const b = document.querySelector(".railopen");
  const r = b.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { w: Math.round(document.querySelector(".rail").getBoundingClientRect().width),
    shown: r.width > 0 && r.height > 0 && (hit === b || b.contains(hit)),
    title: b.title, label: b.getAttribute("aria-label"),
    entries: document.querySelectorAll('[aria-labelledby="railhead-recruiting"] .railpipe').length };
});
ok("collapsed (after «) for this user too", zo.w === 64, zo.w);
ok("🔴 \"Open Recruiting\" is visible and clickable in the collapsed rail", zo.shown && zo.label === "Open Recruiting", zo);
ok("…its title says why: no pipelines assigned", /No recruiting pipelines assigned yet/.test(zo.title), zo.title);
ok("…and they have no Recruiting entries", zo.entries === 0, zo.entries);
await Z.frame.click(".railopen", { timeout: 5000 }).catch(() => {});
await Z.page.waitForTimeout(900);
const zr = await Z.frame.evaluate(() => ({
  h1: document.querySelector(".main h1")?.textContent || "",
  why: document.querySelector(".empty.noaccess")?.textContent || "",
}));
ok("🔴 it opens Recruiting and its explanation", /Recruiting/.test(zr.h1) && /No pipelines assigned yet/.test(zr.why), zr);
await Z.ctx.close();

console.log("\n5l · 🔴 M3 — A FAILED RECRUITING LOAD IS NOT \"NO ACCESS\"");
const F = await openAs(ADMIN, "admin", { failCg: true });
await F.frame.waitForSelector(".railopen", { state: "attached", timeout: 150000 });
const ft = await F.frame.evaluate(() => document.querySelector(".railopen").title);
ok("🔴 the line says Recruiting didn't load", /Recruiting didn't load/.test(ft), ft);
ok("…not the no-access line", !/assigned/.test(ft), ft);
// ═══ ROUND 178 · M1 — NO SECOND CAREGIVER LOAD BESIDE A REFRESH LEG ══════════
// The first caregiver load failed (cgLoaded false). A Refresh on Clients runs
// its caregiver leg (held 2.5s); switching to Recruiting during it used to
// re-arm the start-up effect and fire a second ?scope=caregiver alongside.
await F.page.waitForTimeout(800);
const fMark = F.log.filter((e) => e.cg).length;
F.ctl.hold = { cg: 2500 };
await F.frame.click(".refreshbtn");
for (let i = 0; i < 60 && F.log.filter((e) => e.cg).length === fMark; i++) await F.page.waitForTimeout(100);
await F.page.waitForTimeout(200);
// ⚠️ ANY VIEW CHANGE re-arms the start-up effect (`view` is a dependency), and
// during the leg the Recruiting section shows its loading placeholder, so
// "Open Recruiting" is not there to click — Master is the view change.
await F.frame.click('.railsec:has-text("Master")');
await F.page.waitForTimeout(3500);
F.ctl.hold = {};
ok("ROUND 178 · M1 — changing the view mid-leg sends no second ?scope=caregiver",
  F.log.filter((e) => e.cg).length - fMark === 1, F.log.map((e) => e.cg));
await F.ctx.close();

console.log("\n5m · D7 + R4 — THE PIPELINES SCREEN");
const PA = await openAs(ADMIN, "admin");
await PA.frame.waitForSelector(`${RG} .railpipe`, { timeout: 150000 });
await PA.frame.click('.railsec:has-text("Pipelines")');
// ⚠️ WAIT ON A CLIENT PIPELINE'S BOX: whether the CAREGIVER one exists is the
// thing being asserted, so it must not be what the proof waits for (revert 4
// crashed here instead of going red).
await PA.frame.waitForSelector(`#pfside-${P.oe}`, { state: "attached", timeout: 60000 });
const boxes = await PA.frame.evaluate((p) => ({
  g2: document.getElementById(`pfside-${p.g2}`)?.checked, g4: document.getElementById(`pfside-${p.g4}`)?.checked,
  oe: !!document.getElementById(`pfside-${p.oe}`), none: !!document.getElementById(`pfside-${p.none}`),
}), P);
ok("🔴 D7 — the checkbox is on caregiver AND client pipelines", boxes.g2 === true && boxes.g4 === false && boxes.oe, boxes);
ok("…never on \"none\"", boxes.none === false, boxes);
const g2Before = JSON.parse(storedConfig).pipelines[P.g2];
await PA.frame.click(`.pflist .pfrow:has(#pfside-${P.g2}) > summary`, { timeout: 5000 }).catch(() => {});
await PA.frame.click(`#pfside-${P.g2}`, { timeout: 5000 }).catch(() => {});
await PA.page.waitForTimeout(2500);
const g2After = JSON.parse(storedConfig).pipelines[P.g2];
const { sidebar: _s, ...g2Rest } = g2After;
ok("🔴 unticking a caregiver pipeline stores sidebar:false", g2After.sidebar === false, g2After);
ok("🔴 …and nothing else on it changed", JSON.stringify(g2Rest) === JSON.stringify(g2Before), { g2Before, g2After });
ok("…and its Recruiting entry is gone without a reload",
  !(await PA.frame.$(`${RG} .railpipe[data-pipeline="${P.g2}"]`)), null);
// R4 — a hidden pipeline moved to "none" loses the key.
await PA.frame.click(`.pflist .pfrow:has(#pfside-${P.spare}) > summary`);
await PA.frame.selectOption(`#pfscope-${P.spare}`, "none");
await PA.page.waitForTimeout(400);
await PA.frame.click('.confirmbox button:has-text("Take it off both")').catch(() => {});
await PA.page.waitForTimeout(2500);
const spare = JSON.parse(storedConfig).pipelines[P.spare];
ok("🔴 R4 — moved to \"none\", it no longer carries sidebar:false", spare.scope === "none" && !("sidebar" in spare), spare);
await PA.ctx.close();

await browser.close();
cleanup();
console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
