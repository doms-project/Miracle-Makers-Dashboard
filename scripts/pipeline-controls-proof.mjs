// ---------------------------------------------------------------------------
// ROUND 116 — THE PIPELINE SCREEN'S MISSING CONTROLS, ON SCREEN.
//
// ⚠️ THE ACCEPTANCE TEST IS NOT AN ASSERTION COUNT. It is: render the screen,
// count the CONTROLS ON SCREEN, click them, and read what was SENT.
//
// So this drives the real component in a real browser and records:
//   Q  the six real Shared fields, each with its own tickbox, and the exact
//      request body an untick produces
//   T  the warning, with its number, before an untick that would hide data —
//      and NO warning when nothing would be hidden
//   K  three choices in the picker, and what "neither" writes
//   L  delete offered on the empty pipeline, refused WITH THE NUMBER on the
//      full one, and not offered at all when the count is unknown
//   O  the contact table, with BOTH names on one row
//   +  the screen's shape: how many pipeline rows are open at load
//
// ⚠️ /api/admin/pipelines is fulfilled in the BROWSER — the payload shape is not
// what is under test, the screen is — and every POST is CAPTURED rather than
// answered blind, so an assertion is about what was sent, not what was intended.
//
// Run: node scripts/pipeline-controls-proof.mjs
// ---------------------------------------------------------------------------
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { chromium } from "playwright-core";
import CryptoJS from "crypto-js";

const LOC = "loc_test";
const SECRET = "harness_shared_secret";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const BLOB = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Chris Tester", email: "c@e.com", companyId: "co1",
}), SECRET).toString();

// 🔴 THE REAL SHARED SIX. Verified live by the owner, and the reason item Q
// exists: not one of them describes an applicant.
const SHARED_FIELDS = [
  ["fld_cm", "Case Manager", "TEXT"],
  ["fld_asst", "Sales Rep Assistant", "TEXT"],
  ["fld_county", "County", "TEXT"],
  ["fld_block", "Road Blocker", "SINGLE_OPTIONS"],
  ["fld_office", "Office", "SINGLE_OPTIONS"],
  ["fld_onb", "Onboarding Rep", "TEXT"],
];
const SECTIONS = [
  { key: "shared", id: "B6cunntgpATjWseEb1iC", label: "Shared", named: true,
    fields: SHARED_FIELDS.map(([id, name, dataType]) => ({ id, name, dataType })) },
  { key: "transfer", id: "7qJlA2QBcha929nsphFk", label: "Transfer", named: true,
    fields: [
      { id: "tr_from", name: "Transferred From", dataType: "TEXT" },
      { id: "tr_date", name: "Transferred Date", dataType: "DATE" },
      { id: "tr_why", name: "Transfer Reason", dataType: "LARGE_TEXT" },
    ] },
];

// Four rows, each the case one item needs:
//   pipe_cg     a caregiver pipeline with Shared ticked — item Q and item T
//   pipe_events scope client today, read only by Referrals — item K
//   pipe_test   empty, never configured — item L's delete
//   pipe_oltl   139 records — item L's refusal, with the number
const PAYLOAD = {
  pipelines: [
    { id: "pipe_cg", name: "PP Caregiver Applicants",
      stages: [{ id: "s1", name: "NEW LEAD" }], division: "PP", configured: true },
    { id: "pipe_events", name: "Events",
      stages: [{ id: "s9", name: "PLANNED" }], division: "Events", configured: true },
    { id: "pipe_test", name: "test",
      stages: [{ id: "s0", name: "NEW" }], division: "test", configured: false },
    { id: "pipe_oltl", name: "OLTL Enrollment",
      stages: [{ id: "s2", name: "INITIAL CALL" }], division: "OLTL", configured: true },
    { id: "pipe_probe", name: "round 91 probe",
      stages: [{ id: "s7", name: "NEW" }], division: "round 91 probe", configured: false },
  ],
  config: { seeded: true, pipelines: {
    pipe_cg: { scope: "caregiver", folders: ["shared"] },
    pipe_events: { scope: "client", folders: ["shared"] },
    pipe_oltl: { scope: "client", folders: ["shared", "transfer"] },
  }, folderNames: {} },
  stale: [], sections: SECTIONS, known: [], sharedKey: "shared",
  unconfiguredFolders: [], inertSections: [],
  // ITEM O — both names, and the dead folder that started it.
  contactSections: [
    { id: "EeU1n8FZZ4WziJwsgwpX", ghlName: "Caregiver Application",
      label: "Caregiver Application", appliesTo: "caregiver", renamed: false,
      fields: [{ id: "c1", name: "CG - Work State" }] },
    { id: "5QrSWnBaHJlWsDifTlnu", ghlName: "FB Private Pay Form",
      label: "Private Pay Enquiry", appliesTo: "client", renamed: true,
      fields: [{ id: "c2", name: "Budget" }, { id: "c3", name: "Start date" }] },
    { id: "wE8YbYKaPhigU6rJ10sl", ghlName: "Form | Form 6",
      label: "Enquiry Details", appliesTo: "client", renamed: true,
      fields: [{ id: "c4", name: "Who is the care for?" }] },
  ],
  unknownContactFolders: [
    { id: "zz_new_folder", fields: [{ id: "c9", name: "Referral notes" }] },
  ],
};

// 🔴 THE RECORDS ARE REAL RECORDS, because item T's number comes from them.
// Three of the five caregiver applicants answered Road Blocker; none answered
// Onboarding Rep. Those two fields are the whole of item T's "warn" and
// "do not warn" pair.
const CG_RECORDS = [
  { id: "r1", cf: { fld_block: "Waiting on paperwork", fld_office: "Erie" } },
  { id: "r2", cf: { fld_block: "No transport" } },
  { id: "r3", cf: { fld_block: "", fld_office: "Erie" } },   // "" is NOT a value
  { id: "r4", cf: { fld_block: "Background check" } },
  { id: "r5", cf: {} },
];

try {
  const stale = execSync("pgrep -f '^next-server' || true").toString().trim();
  for (const pid of stale.split("\n").filter(Boolean))
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
} catch { /* no pgrep */ }
try { rmSync(".next/dev/lock", { force: true }); } catch { /* nothing */ }

const PORT = 3700 + Math.floor(Math.random() * 250);
const dev = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  detached: true,
  env: { ...process.env, GHL_LOCATION_ID: LOC, GHL_PIT: "pit_test",
         GHL_SSO_SECRET: SECRET, PIPELINE_IDS: "pipe_oltl" },
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
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(sig, () => { cleanup(); process.exit(130); });
process.on("uncaughtException", (e) => {
  console.log(`\n🔴 ${e.message}`); cleanup(); process.exit(1);
});

const base = `http://localhost:${PORT}`;
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try {
    // ⚠️ ANY response means Next is serving — the sandbox answers the server's
    // own probe of the real GHL host with a 403, so 401/200 is too narrow.
    const r = await fetch(`${base}/api/opportunities`, { signal: AbortSignal.timeout(4000) });
    if (r.status > 0) up = true;
  } catch { /* not listening */ }
  if (!up) await new Promise((r) => setTimeout(r, 1000));
}
if (!up) { console.log(devLog.join("").slice(-1500)); process.exit(1); }
console.log(`  dev server up on ${PORT}`);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-proxy-server", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));

// 🔴 EVERY WRITE IS CAPTURED, and answered with a config that reflects it — so
// the screen behaves as it would in production rather than freezing on a
// canned reply. `sent` is what the assertions read.
const sent = [];
let live = JSON.parse(JSON.stringify(PAYLOAD.config));
await page.route("**/api/admin/pipelines*", async (route) => {
  const req = route.request();
  if (req.method() === "POST") {
    const body = JSON.parse(req.postData() || "{}");
    sent.push(body);
    if (body.action === "save-config" && body.config) live = body.config;
    // 🔴 ITEM L's ON-DEMAND COUNT. "test" is empty; OLTL holds 139; the probe
    // is a pipeline GoHighLevel refuses to count, so the screen must say so
    // rather than offer a delete.
    if (body.action === "count-records") {
      const n = { pipe_test: 0, pipe_oltl: 139, pipe_cg: 5, pipe_events: 0,
                  pipe_probe: null }[body.pipelineId];
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ pipelineId: body.pipelineId, count: n === undefined ? null : n }) });
    }
    if (body.action === "delete-pipeline") {
      delete live.pipelines[body.pipelineId];
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ deleted: body.pipelineId, config: live }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ config: live }) });
  }
  return route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify({ ...PAYLOAD, config: live }) });
});
const CLIENT_PAYLOAD = {
  records: [], pipelines: [{ id: "pipe_oltl", name: "OLTL Enrollment" }],
  stagesByPipeline: {}, users: [], fieldDefs: [], failedPipelines: [],
  pipelineFolders: { pipe_oltl: ["shared"] }, pipelineExclusions: {},
  viewer: { authenticated: true, isAdmin: true, role: "admin", userName: "Chris Tester",
            homePipelineIds: ["pipe_oltl"], canSeeMaster: true, total: 0 },
};
// 🔴 THE APPLICANT PAYLOAD IS THE SAME ROUTE WITH ?scope=caregiver — NOT
// /api/caregivers. I wrote the second first, the route never matched, and the
// client payload answered both: `cgLoaded` stayed false and item T's count
// could never become real. Exactly the class of harness bug flagged for five
// rounds — the fixture has to reproduce the production SHAPE.
const CG_PAYLOAD = {
  records: CG_RECORDS.map((r) => ({
    id: r.id, pipelineId: "pipe_cg", stageId: "s1", stage: "NEW LEAD",
    first: "A", last: r.id, name: `A ${r.id}`, phone: "", email: "",
    pipeline: "PP Caregiver Applicants", cf: r.cf, status: "open",
    ownerId: "u1", rep: "Chris Tester", updated: "", created: "",
  })),
  pipelines: [{ id: "pipe_cg", name: "PP Caregiver Applicants" }],
  stagesByPipeline: { pipe_cg: [{ id: "s1", name: "NEW LEAD" }] },
  stages: [{ id: "s1", name: "NEW LEAD" }], users: [], fieldDefs: [],
  failedPipelines: [], pipelineFolders: { pipe_cg: ["shared"] }, pipelineExclusions: {},
  viewer: { authenticated: true, isAdmin: true, role: "admin", userName: "Chris Tester",
            homePipelineIds: ["pipe_cg"], canSeeMaster: true, total: CG_RECORDS.length },
};
await page.route("**/api/opportunities*", (route) =>
  route.fulfill({ status: 200, contentType: "application/json",
    body: JSON.stringify(
      /scope=caregiver/.test(route.request().url()) ? CG_PAYLOAD : CLIENT_PAYLOAD,
    ) }));
await page.route(`${base}/__parent`, (route) => route.fulfill({
  status: 200, contentType: "text/html",
  body: `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0}iframe{border:0;width:1440px;height:950px}</style>
<script>window.addEventListener("message",(e)=>{if(e.data&&e.data.message==="REQUEST_USER_DATA")
e.source.postMessage({message:"REQUEST_USER_DATA_RESPONSE",payload:${JSON.stringify(BLOB)}},"*");});</script>
<iframe src="${base}/"></iframe>`,
}));

await page.goto(`${base}/__parent`, { waitUntil: "domcontentloaded" });
const frame = await (await page.waitForSelector("iframe")).contentFrame();
await frame.waitForFunction(
  () => !/Checking session/.test(document.querySelector(".viewas")?.textContent || ""),
  { timeout: 90000 },
);

// 🔴 THE CAREGIVER SECTION IS OPENED FIRST, ON PURPOSE. `countsComplete` is
// false until that payload lands, and item T is REQUIRED to refuse to guess in
// that state — so the run has to pass through it deliberately rather than race
// it. The "cannot say" wording is asserted separately below, before this.
const openPipelines = async () => {
  for (let i = 0; i < 12; i++) {
    await frame.click('button:has-text("Pipelines")');
    await page.waitForTimeout(500);
    if (await frame.$(".pflist .pfrow")) return true;
  }
  return false;
};
if (!(await openPipelines())) { console.log("could not reach the Pipelines screen"); process.exit(1); }

// ── SHAPE · HOW MANY ROWS ARE OPEN AT LOAD? ───────────────────────────────
console.log("\n0 · ⚠️ THE SCREEN'S SHAPE — MEASURED, NOT ASSUMED");
// ⚠️ VISIBLE, NOT PRESENT. React renders a <details>'s children into the DOM
// whether or not it is open, so a querySelectorAll count would say "8 chips
// rendered" while the screen shows none. The question the brief asks — "does it
// still read as one screen" — is about what a person SEES.
const shapeRowsExpected = 5;
const shape = await frame.evaluate(() => {
  const seen = (el) => !!el.getClientRects().length;
  const chips = [...document.querySelectorAll(".pflist .pfsec")];
  return {
    rows: document.querySelectorAll(".pflist .pfrow").length,
    open: document.querySelectorAll(".pflist .pfrow[open]").length,
    chipsInDom: chips.length,
    chipsVisible: chips.filter(seen).length,
    createChips: [...document.querySelectorAll(".pffolders .pfsec")].filter(seen).length,
    pageHeight: Math.round(document.querySelector(".pfadmin")?.getBoundingClientRect().height || 0),
    // ⚠️ SPLIT, because "the screen is long" is not the finding. WHICH HALF is
    // long is — and the brief's two candidate shapes disagree about exactly
    // that. `.pflist` is the ten pipelines; everything above it is create.
    listHeight: Math.round(document.querySelector(".pflist")?.getBoundingClientRect().height || 0),
    rowHeight: Math.round(document.querySelector(".pflist .pfrow")?.getBoundingClientRect().height || 0),
  };
});
console.log(`  pipeline rows: ${shape.rows} · OPEN at load: ${shape.open}`);
console.log(`  per-pipeline chips — in the DOM: ${shape.chipsInDom} · VISIBLE: ${shape.chipsVisible}`);
console.log(`  create-form chips visible: ${shape.createChips}`);
console.log(`  the whole screen is ${shape.pageHeight}px tall`);
console.log(`  of which the pipeline list is ${shape.listHeight}px · one row is ${shape.rowHeight}px`);
console.log(`  → the create form and its checklist are ${shape.pageHeight - shape.listHeight}px of it`);
ok("🔴 every configured pipeline is COLLAPSED at load", shape.open === 0, shape);
ok("all five pipelines are listed", shape.rows === shapeRowsExpected, shape);
ok("🔴 and NO per-pipeline chip grid is on screen until a row is opened",
   shape.chipsVisible === 0, shape);
ok("⚠️ they are in the DOM though — collapsed is not unmounted",
   shape.chipsInDom > 0, shape);
// 🔴 THE MEASUREMENT, NOT A TARGET I PICKED. Five collapsed rows are ~40px
// each; the create form with TWO sections is already most of the page, and in
// production it carries fourteen. So the additions do not make this screen
// longer — the create form is what does, and it was always the top half.
ok("🔴 five collapsed rows cost less than a third of the screen",
   shape.listHeight < shape.pageHeight / 3, shape);
ok("one collapsed row is a row, not a panel", shape.rowHeight < 60, shape);

// ── K · THE PICKER ────────────────────────────────────────────────────────
console.log("\nK · 🔴 WHICH PICKER LISTS THIS PIPELINE");
await frame.click('.pflist .pfrow:has(summary:has-text("Events")) > summary');
await page.waitForTimeout(400);
const scopeSel = '.pfrow:has(summary:has-text("Events")) .pfscopeedit select';
const opts = await frame.$$eval(`${scopeSel} option`, (os) =>
  os.map((o) => ({ value: o.value, label: o.textContent.trim() })));
console.log("  options on screen:");
for (const o of opts) console.log(`    ${o.value || "(empty)"} · ${o.label}`);
ok("three real choices plus the unconfigured empty state", opts.length === 4, opts);
ok("🔴 a third value exists", opts.some((o) => o.value === "none"), opts);
ok("and it is described, not named \"none\"",
   opts.find((o) => o.value === "none")?.label === "neither — read by its own section", opts);
const scopeLabel = await frame.textContent('.pfrow:has(summary:has-text("Events")) .pfscopeedit label');
console.log(`  label: "${scopeLabel.trim()}"`);
ok("🔴 the label says which PICKER, not where records render",
   /Show this pipeline in/i.test(scopeLabel), scopeLabel);

await frame.selectOption(scopeSel, "none");
await page.waitForTimeout(400);
const confirmText = await frame.textContent(".confirmbox").catch(() => "");
console.log(`  confirm: ${confirmText.replace(/\s+/g, " ").slice(0, 170)}…`);
ok("it asks first", /off both board pickers/i.test(confirmText), confirmText.slice(0, 200));
ok("🔴 and says the admin surfaces keep it",
   /import wizard/i.test(confirmText) && /Access/i.test(confirmText), confirmText.slice(0, 400));
await frame.click('button:has-text("Take it off both")');
await page.waitForTimeout(600);
const kWrite = sent.filter((s) => s.action === "save-config").at(-1);
console.log(`  written: ${JSON.stringify(kWrite?.config?.pipelines?.pipe_events)}`);
ok("🔴 scope \"none\" is stored", kWrite?.config?.pipelines?.pipe_events?.scope === "none", kWrite);
ok("and its folder ticks are kept",
   kWrite?.config?.pipelines?.pipe_events?.folders?.includes("shared"), kWrite);

// ── Q · PER-FIELD EXCLUSIONS ──────────────────────────────────────────────
console.log("\nQ · 🔴 PER-FIELD EXCLUSIONS INSIDE A TICKED FOLDER");
await frame.click('.pflist .pfrow:has(summary:has-text("Events")) > summary'); // close it
await frame.click('.pflist .pfrow:has(summary:has-text("PP Caregiver Applicants")) > summary');
await page.waitForTimeout(400);
const cgRow = '.pfrow:has(summary:has-text("PP Caregiver Applicants"))';
await frame.click(`${cgRow} .pfsec:has(.pfsecname:text-is("Shared")) .pfsectoggle`);
await page.waitForTimeout(400);
const fields = await frame.$$eval(`${cgRow} .pfsec.open .pffieldlist li`, (ls) =>
  ls.map((l) => ({
    name: l.querySelector(".pffname")?.textContent.trim(),
    type: l.querySelector(".pfftype")?.textContent.trim(),
    box: !!l.querySelector("input[type=checkbox]"),
    ticked: l.querySelector("input[type=checkbox]")?.checked,
  })));
console.log(`  Shared, expanded — ${fields.length} rows on screen:`);
for (const f of fields)
  console.log(`    [${f.ticked ? "x" : " "}] ${f.name.padEnd(22)} ${f.type}`);
ok("🔴 six field rows, the real six", fields.length === 6, fields.map((f) => f.name));
ok("every one carries its own tickbox", fields.every((f) => f.box), fields);
ok("🔴 DEFAULT IS ALL-IN — every box starts ticked", fields.every((f) => f.ticked), fields);

// ── T · THE WARNING, WITH THE NUMBER ──────────────────────────────────────
console.log("\nT · 🔴 WARN BEFORE HIDING A FIELD THAT HOLDS VALUES");
console.log("  (the applicant payload has NOT been loaded yet in this tab)");
const roadBox = `${cgRow} .pfsec.open .pffieldlist li:has(.pffname:text-is("Road Blocker")) input`;
await frame.click(roadBox);
await page.waitForTimeout(400);
let warn = await frame.textContent(".confirmbox").catch(() => "");
console.log(`  dialog: ${warn.replace(/\s+/g, " ").slice(0, 200)}…`);
ok("🔴 it refuses to guess rather than showing a confident zero",
   /cannot say how many/i.test(warn), warn.slice(0, 250));
await frame.click('button:has-text("Cancel")');
await page.waitForTimeout(300);

// Now load the applicants, so the count is real.
// ⚠️ WAIT ON THE RESPONSE, NOT A ROW COUNT. A selector guess is how five
// rounds of harness bugs started; the payload landing is the actual condition
// `countsComplete` turns on.
const cgLanded = page.waitForResponse(
  (r) => /scope=caregiver/.test(r.url()), { timeout: 60000 },
);
await frame.click('.railsec[title="Caregiver and DSP applicants"]');
await cgLanded;
await page.waitForTimeout(900);
await openPipelines();
await frame.click(`${cgRow} > summary`);
await page.waitForTimeout(300);
await frame.click(`${cgRow} .pfsec:has(.pfsecname:text-is("Shared")) .pfsectoggle`);
await page.waitForTimeout(300);

await frame.click(roadBox);
await page.waitForTimeout(400);
warn = await frame.textContent(".confirmbox").catch(() => "");
console.log(`  dialog: ${warn.replace(/\s+/g, " ").slice(0, 260)}…`);
// 🔴 THREE of five hold a value. r3's "" is NOT a value and r5 answered nothing.
ok("🔴 the count is on screen, and it is 3", /\b3 records\b/.test(warn), warn.slice(0, 300));
ok("it says the data is not deleted", /Nothing is deleted/i.test(warn), warn.slice(0, 400));
ok("and that the values come back", /come back if you tick/i.test(warn), warn.slice(0, 400));
ok("it names what was counted over", /5 records this tab has loaded/i.test(warn), warn.slice(0, 500));
await frame.click('button:has-text("Hide it anyway")');
await page.waitForTimeout(600);

const qWrite = sent.filter((s) => s.action === "save-config").at(-1);
const cgEntry = qWrite?.config?.pipelines?.pipe_cg;
console.log(`  written: ${JSON.stringify(cgEntry)}`);
ok("🔴 an EXCLUSION is stored, not an inclusion list",
   Array.isArray(cgEntry?.exclude) && cgEntry.exclude.length === 1, cgEntry);
ok("and it is the field id", cgEntry?.exclude?.[0] === "fld_block", cgEntry);
ok("🔴 the folder tick is UNTOUCHED — Office is not lost with it",
   cgEntry?.folders?.includes("shared"), cgEntry);
ok("⚠️ the stored config grows by the exception only, not 6 entries",
   JSON.stringify(cgEntry).length < 120, JSON.stringify(cgEntry));

const badge = await frame.textContent(`${cgRow} .pfsec:has(.pfsecname:text-is("Shared")) .pfseccount`);
console.log(`  count badge now reads: "${badge.trim()}"`);
ok("🔴 the badge says what is SHOWING, not what exists", badge.trim() === "5 of 6", badge);

console.log("\nT · ⚠️ AND NO DIALOG WHEN NOTHING WOULD BE HIDDEN");
const before = sent.length;
const onbBox = `${cgRow} .pfsec.open .pffieldlist li:has(.pffname:text-is("Onboarding Rep")) input`;
await frame.click(onbBox);
await page.waitForTimeout(600);
const dialogOpen = await frame.$(".confirmbox");
ok("🔴 a field nobody filled is a free untick — no dialog", !dialogOpen, "a dialog opened");
ok("and it saved straight away", sent.length > before, { before, after: sent.length });
const onbWrite = sent.filter((s) => s.action === "save-config").at(-1);
ok("both exclusions are now stored",
   onbWrite?.config?.pipelines?.pipe_cg?.exclude?.length === 2,
   onbWrite?.config?.pipelines?.pipe_cg);

// ── L · DELETE ────────────────────────────────────────────────────────────
console.log("\nL · 🔴 DELETE, GATED ON THE RECORD COUNT");
await frame.click(`${cgRow} > summary`);
await frame.click('.pflist .pfrow:has(summary:has-text("OLTL Enrollment")) > summary');
await page.waitForTimeout(400);
const oltlDel = await frame.textContent('.pfrow:has(summary:has-text("OLTL Enrollment")) .pfdelete');
const oltlBtn = await frame.$('.pfrow:has(summary:has-text("OLTL Enrollment")) .pfdangerbtn');
console.log(`  OLTL Enrollment (has records): "${oltlDel.replace(/\s+/g, " ").trim()}"`);
ok("🔴 no delete button on a pipeline with records", !oltlBtn, "a button was offered");
ok("🔴 and the refusal SAYS THE NUMBER", /139 records are/.test(oltlDel), oltlDel);

await frame.click('.pflist .pfrow:has(summary:has-text("OLTL Enrollment")) > summary');
await frame.click('.pflist .pfrow:has(b:text-is("round 91 probe")) > summary');
await page.waitForTimeout(700);
const probeText = await frame.textContent('.pflist .pfrow:has(b:text-is("round 91 probe")) .pfdelete');
const probeBtn = await frame.$('.pflist .pfrow:has(b:text-is("round 91 probe")) .pfdangerbtn');
console.log(`  round 91 probe (count unavailable): "${probeText.replace(/\s+/g, " ").trim()}"`);
ok("⚠️ a count that could not be got offers NO delete", !probeBtn, "a button was offered");
ok("and says so rather than showing a confident zero",
   /could not count/i.test(probeText), probeText);
await frame.click('.pflist .pfrow:has(b:text-is("round 91 probe")) > summary');

await frame.click('.pflist .pfrow:has(b:text-is("test")) > summary');
await page.waitForTimeout(800);
const testRow = '.pflist .pfrow:has(b:text-is("test"))';
const testBtn = await frame.$(`${testRow} .pfdangerbtn`);
console.log(`  test (0 records): delete offered = ${!!testBtn}`);
ok("🔴 delete IS offered on the empty one", !!testBtn, "no button");
await testBtn.click();
await page.waitForTimeout(400);
const delText = await frame.textContent(".confirmbox").catch(() => "");
console.log(`  confirm: ${delText.replace(/\s+/g, " ").slice(0, 200)}…`);
ok("⚠️ the app's own dialog, and it says GoHighLevel", /in GoHighLevel/i.test(delText), delText.slice(0, 250));
ok("🔴 and that the stored entry goes with it",
   /configuration is removed with it/i.test(delText), delText.slice(0, 400));
await frame.click('button:has-text("Delete the pipeline")');
await page.waitForTimeout(700);
const del = sent.filter((s) => s.action === "delete-pipeline").at(-1);
console.log(`  written: ${JSON.stringify(del)}`);
ok("one delete, naming the pipeline", del?.pipelineId === "pipe_test", del);
const rowsNow = await frame.evaluate(() => document.querySelectorAll(".pflist .pfrow").length);
console.log(`  pipeline rows on screen: 5 → ${rowsNow}`);
ok("🔴 and it left the list without a reload", rowsNow === 4, rowsNow);

// ── O · CONTACT SECTIONS ──────────────────────────────────────────────────
console.log("\nO · 🔴 CONTACT FOLDERS HAVE AN ADMIN SURFACE — WITH BOTH NAMES");
const contacts = await frame.$$eval(".pfcontacts .pfcrow", (rs) =>
  rs.map((r) => ({
    label: r.querySelector(".pfcname")?.textContent.trim(),
    ghl: r.querySelector(".pfcghl")?.textContent.trim() || "(same)",
    fields: r.querySelector(".pfcfields")?.textContent.trim(),
  })));
console.log(`  ${contacts.length} contact sections on screen:`);
for (const c of contacts) console.log(`    ${c.label.padEnd(24)} GHL: ${c.ghl.padEnd(22)} ${c.fields}`);
ok("all three render", contacts.length === 3, contacts);
ok("🔴 \"Enquiry Details\" shows its GoHighLevel name on the same row",
   contacts.some((c) => c.label === "Enquiry Details" && c.ghl === "Form | Form 6"), contacts);
ok("and \"Private Pay Enquiry\" shows \"FB Private Pay Form\"",
   contacts.some((c) => c.label === "Private Pay Enquiry" && c.ghl === "FB Private Pay Form"), contacts);
ok("a section whose name is not changed says so",
   contacts.some((c) => c.label === "Caregiver Application" && c.ghl === "(same)"), contacts);
const unknown = await frame.textContent(".pfstale").catch(() => "");
ok("🔴 a folder GoHighLevel has and this app does not is surfaced",
   /zz_new_folder/.test(unknown), unknown.slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed.`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
