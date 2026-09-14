// ---------------------------------------------------------------------------
// ROUND 115 · WHY v114 REGRESSED LIVE — A FIXTURE SHAPED LIKE THE ACCOUNT.
//
// 🔴 ROUND 114's HARNESS PASSED 23/23 AGAINST 20 RECORDS IN ONE PIPELINE.
// The account is 596 records across SIX pipelines, 174 of them unassigned, with
// one rep holding 151. Every number in that fixture was too small and too tidy
// to catch either regression, which is the fifth round running that the harness
// was wrong about the app.
//
// So this one is built from the numbers reported live, and it DIAGNOSES before
// it asserts: at each step it prints what the screen is actually doing, so a
// failure names a cause instead of a symptom.
//
//   1 · does SEARCH still match the ten fields it used to?
//   2 · does clicking "By rep" set the focus at all — banner, count, rows?
//   3 · do By office and Checked this week behave the same way?
//
// Run: node scripts/live-shape-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
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

// 🔴 SIX PIPELINES, as live. The round-114 fixture had one, so `adminPipeline`,
// `homePipelineIds` and the division switcher were all trivially satisfied.
const PIPES = [
  ["p_oltl", "OLTL Enrollment"],
  ["p_oltlt", "OLTL Transfer"],
  ["p_odp", "ODP Enrollment"],
  ["p_odpt", "ODP Transfer"],
  ["p_pp", "Private Pay Enrollment"],
  ["p_ev", "Events"],
];
const STAGES = [["s1", "INITIAL CALL"], ["s2", "AUTH PENDING"], ["s3", "ACTIVE"]];
const USERS = [
  ["u1", "Bill Lockfeld -Sale"],
  ["u2", "Archie Emperado -Onboarding"],
  ["u3", "Chris Miracle Makers"],
];
const OFFICES = ["Media", "Broomall", "Upper Darby"];

// 596 records · 151 for Bill · 174 unassigned — the live numbers.
const TOTAL = 596, BILL = 151, UNASSIGNED = 174;
const OPPS = Array.from({ length: TOTAL }, (_, i) => {
  const owner = i < BILL ? "u1" : i < TOTAL - UNASSIGNED ? (i % 2 ? "u2" : "u3") : "";
  const office = OFFICES[i % OFFICES.length];
  const [pid] = PIPES[i % PIPES.length];
  const [sid] = STAGES[i % STAGES.length];
  return {
    id: `o${i}`,
    name: `Family ${i}`,
    pipelineId: pid,
    pipelineStageId: sid,
    status: "open",
    ...(owner ? { assignedTo: owner } : {}),
    createdAt: new Date(Date.now() - i * 60000).toISOString(),
    contact: { id: `c${i}`, firstName: "First", lastName: `Last${i}` },
    customFields: [
      { id: "F_OFFICE", fieldValue: office },
      ...(i % 149 === 0 ? [{ id: "F_BLOCK", fieldValue: "Waiting on documents" }] : []),
      ...(i % 199 === 0 ? [{ id: "F_CHECK", fieldValue: "true" }] : []),
    ],
  };
});
const EXPECT = {
  total: TOTAL,
  bill: BILL,
  broomall: OPPS.filter((o) =>
    o.customFields.some((f) => f.id === "F_OFFICE" && f.fieldValue === "Broomall")).length,
  blocked: OPPS.filter((o) => o.customFields.some((f) => f.id === "F_BLOCK")).length,
  checked: OPPS.filter((o) => o.customFields.some((f) => f.id === "F_CHECK")).length,
};
console.log(`  fixture: ${JSON.stringify(EXPECT)}`);

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = req.url;
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.startsWith(`/locations/${LOC}/customFields`))
      return send(200, { customFields: [
        { id: "F_OFFICE", name: "Office", dataType: "TEXT" },
        { id: "F_BLOCK", name: "Road Blocker", dataType: "TEXT" },
        { id: "F_CHECK", name: "Checked This Week", dataType: "CHECKBOX" },
      ]});
    if (u.startsWith("/users/"))
      return send(200, { users: USERS.map(([id, name]) => ({ id, name })) });
    if (u.startsWith("/opportunities/pipelines"))
      return send(200, { pipelines: PIPES.map(([id, name]) => ({
        id, name, stages: STAGES.map(([sid, sn]) => ({ id: sid, name: sn })) })) });
    if (u.startsWith(`/locations/${LOC}/customValues`))
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({ seeded: true,
          pipelines: Object.fromEntries(
            PIPES.map(([id]) => [id, { scope: "client", folders: [] }])),
          folderNames: {} }) }] });
    if (u.startsWith("/opportunities/search")) {
      const pid = new URL(`http://x${u}`).searchParams.get("pipeline_id");
      const mine = pid ? OPPS.filter((o) => o.pipelineId === pid) : OPPS;
      return send(200, { opportunities: mine, meta: { total: mine.length } });
    }
    if (u === "/contacts/search") return send(200, { contacts: [], total: 0 });
    send(404, { message: `no fake handler for ${u}` });
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fp = fake.address().port;

try {
  const stale = execSync("pgrep -f '^next-server' || true").toString().trim();
  for (const pid of stale.split("\n").filter(Boolean))
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
} catch { /* no pgrep */ }
try { rmSync(".next/dev/lock", { force: true }); } catch { /* nothing */ }

const PORT = 3700 + Math.floor(Math.random() * 250);
const dev = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  detached: true,
  env: { ...process.env, GHL_API_BASE: `http://127.0.0.1:${fp}`, GHL_LOCATION_ID: LOC,
         GHL_PIT: "pit_test", GHL_SSO_SECRET: SECRET,
         PIPELINE_IDS: PIPES.map(([id]) => id).join(",") },
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
  try { fake.close(); } catch { /* closed */ }
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
    const r = await fetch(`${base}/api/opportunities`, { signal: AbortSignal.timeout(6000) });
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
await frame.waitForSelector(".board .colbody .card, table tbody tr", { timeout: 90000 });

const toView = async (which) => {
  await frame.click(`.seg button:has-text("${which}")`);
  await page.waitForTimeout(700);
};
const read = () => frame.evaluate(() => {
  const cards = [...document.querySelectorAll(".board .colbody .card")];
  const rows = [...document.querySelectorAll("table tbody tr")];
  const els = cards.length ? cards : rows;
  return {
    view: cards.length ? "board" : "list",
    n: els.length,
    count: document.querySelector(".count")?.textContent?.trim().replace(/\s+/g, " ") || null,
    banner: document.querySelector(".mfocus")?.textContent?.trim().replace(/\s+/g, " ") || null,
    empty: document.querySelector(".empty")?.textContent?.trim().replace(/\s+/g, " ").slice(0, 90) || null,
  };
});

// ── 0 · THE BASELINE ──────────────────────────────────────────────────────
console.log("\n0 · THE SCREEN WITH 596 RECORDS AND NO FILTER");
await toView("List");
const base0 = await read();
console.log(`  list:  ${JSON.stringify(base0)}`);
ok("the list draws rows", base0.n > 0, base0);
ok(`the count names ${TOTAL}`, (base0.count || "").includes(String(TOTAL)), base0.count);

// ── 1 · 🔴 SEARCH ─────────────────────────────────────────────────────────
console.log("\n1 · 🔴 SEARCH — DOES IT STILL MATCH THE TEN FIELDS?");
for (const [term, expected, why] of [
  ["Broomall", EXPECT.broomall, "an OFFICE value — list-only field before 114"],
  ["Family 4", null, "the opportunity NAME — matched by both views before 114"],
  ["Lockfeld", null, "a REP name — a list-only field before 114"],
  ["zzzznotpresent", 0, "present nowhere — must be zero"],
]) {
  await toView("List");
  await frame.fill(".search input", term);
  await page.waitForTimeout(900);
  const l = await read();
  await toView("Kanban");
  const b = await read();
  console.log(`  "${term}" (${why})`);
  console.log(`     list ${String(l.n).padStart(4)}  count="${l.count}"`);
  console.log(`     board${String(b.n).padStart(4)}  count="${b.count}"`);
  if (expected !== null)
    ok(`"${term}" → ${expected} on the list`, l.n === expected, { got: l.n, expected });
  ok(`"${term}" — both views agree`, l.n === b.n, { list: l.n, board: b.n });
  if (term !== "zzzznotpresent")
    ok(`🔴 "${term}" is NOT zero — the search still works`, l.n > 0, l);
  await frame.fill(".search input", "");
  await page.waitForTimeout(700);
}

// ── 2 · 🔴 THE TILES, ONE AT A TIME, WITH DIAGNOSIS ───────────────────────
console.log("\n2 · 🔴 EVERY TILE — DOES THE FOCUS EVEN GET SET?");
const tiles = await frame.$$eval(".stat", (els) =>
  els.map((e) => ({
    head: e.querySelector(".k")?.textContent?.trim() || "",
    picks: [...e.querySelectorAll(".srcpick")].map((b) => b.textContent.trim()),
    isButton: e.tagName === "BUTTON",
    disabled: e.tagName === "BUTTON" ? e.disabled : null,
  })));
for (const t of tiles)
  console.log(`  ${t.head.padEnd(20)} button=${t.isButton} disabled=${t.disabled} ` +
              `picks=${JSON.stringify(t.picks.slice(0, 3))}`);

const clickPick = async (label) => {
  const h = await frame.evaluateHandle((t) => {
    const b = [...document.querySelectorAll(".stat .srcpick, .stat.statbtn")]
      .find((x) => x.textContent.includes(t));
    return b || null;
  }, label);
  const el = h.asElement();
  if (!el) return false;
  await el.click();
  await page.waitForTimeout(900);
  return true;
};

for (const [label, expected, kind] of [
  ["Bill", EXPECT.bill, "rep"],
  ["Broomall", EXPECT.broomall, "office"],
  ["Road-blocked", EXPECT.blocked, "blocked"],
  ["Checked this week", EXPECT.checked, "checked"],
]) {
  console.log(`\n  🔴 CLICK "${label}" (${kind}) — EXPECT ${expected}`);
  await toView("List");
  const before = await read();
  const clicked = await clickPick(label);
  if (!clicked) { ok(`"${label}" is clickable`, false, "no matching control found"); continue; }
  const l = await read();
  await toView("Kanban");
  const b = await read();
  console.log(`     list  ${before.n} → ${l.n}   banner=${JSON.stringify(l.banner)}`);
  console.log(`     board          ${b.n}   count="${b.count}"`);
  ok(`🔴 "${label}" sets a banner — the focus was stored`, !!l.banner, l);
  ok(`🔴 the list narrows to ${expected}`, l.n === expected, { got: l.n, expected });
  ok(`🔴 the board narrows to ${expected} too`, b.n === expected, { got: b.n, expected });
  if (l.banner) {
    await frame.click(".mfocus button");
    await page.waitForTimeout(800);
  }
}

// ── 3 · THE BUILD STAMP AND THE DIAGNOSTIC EMPTY STATE ────────────────────
console.log("\n3 · 🔴 CAN THE SCREEN TELL ME WHAT IT IS AND WHAT IT DID?");
const stamp = await frame.evaluate(() => {
  const el = document.querySelector(".railbuild");
  return el ? { text: el.textContent.trim(), title: el.title } : null;
});
console.log(`  build stamp: ${JSON.stringify(stamp)}`);
// ⚠️ A LABEL, NOT A NUMBER. Rounds can carry a suffix — 115 and 115b exist —
// and an assertion that assumed digits only failed a stamp that was correct.
ok("🔴 the build is stamped on screen",
   !!stamp?.text && /^v\d+[a-z]?$/.test(stamp.text), stamp);
ok("and its tooltip names what the round changed",
   !!stamp?.title && stamp.title.length > 20, stamp?.title);

await toView("List");
await frame.fill(".search input", "zzzznotpresent");
await page.waitForTimeout(900);
const diag = await frame.evaluate(() =>
  document.querySelector(".empty")?.textContent?.trim().replace(/\s+/g, " ") || null);
console.log(`  empty state: "${diag}"`);
ok("🔴 a zero result names the active filters",
   /Active: search/.test(diag || ""), diag);
ok("and it says how many records it searched over",
   new RegExp(`over ${TOTAL} records`).test(diag || ""), diag);
ok("and which fields a search compares",
   /Harmony ID/.test(diag || ""), diag);
await frame.fill(".search input", "");
await page.waitForTimeout(600);

await page.screenshot({ path: "scripts/live-shape.png" });
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
