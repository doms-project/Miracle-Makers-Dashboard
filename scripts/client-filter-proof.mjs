// ---------------------------------------------------------------------------
// ROUND 114 · THE CLIENT BOARD — ONE SET, AND TILES THAT FILTER.
//
// 🔴 A LIST-ONLY TEST WOULD PASS WHILE THE KANBAN WAS WRONG. That is how round
// 97 shipped the caregiver bug and it is the only reason this file exists, so
// every assertion below is made TWICE — once with the list on screen, once with
// the kanban — and always by counting what is DRAWN.
//
// The fixture makes every expected number unique, so no assertion can pass by
// coincidence:
//
//   20 client records in ONE pipeline, two stages
//   offices   Media 11 · Broomall 9
//   reps      Bill 7 · Dana 5 · Ivy 6 · unassigned 2
//   blocked   4        checked 3
//
// ⚠️ WHAT THIS FIXTURE DOES *NOT* EXERCISE, and I am not going to imply it
// does: the two narrowings the board keeps — your own pipelines, and shared-in
// records. `shared` is stamped server-side by applyAccess, and an admin's home
// set is every selected pipeline, so neither can be forced from a fake payload
// without a second viewer and a second pipeline. The agreement proved below is
// therefore "both views apply the same filters", NOT "the board still narrows
// the two ways it is supposed to". That second claim is read from the code.
//
// Run: node scripts/client-filter-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { chromium } from "playwright-core";
import CryptoJS from "crypto-js";

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const P1 = "pipe_oltl";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const BLOB = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Chris Tester", email: "c@e.com", companyId: "co1",
}), SECRET).toString();

const USERS = [
  ["u1", "Bill Lockfeld -Sale"],
  ["u2", "Dana Ruiz"],
  ["u3", "Ivy Chen"],
];
// office, owner, blocked, checked
const ROWS = [
  ["Media", "u1", 1, 0], ["Media", "u1", 0, 1], ["Media", "u1", 0, 0],
  ["Media", "u1", 1, 0], ["Media", "u1", 0, 0], ["Media", "u1", 0, 1],
  ["Media", "u1", 0, 0],
  ["Media", "u2", 1, 0], ["Media", "u2", 0, 0], ["Media", "u2", 0, 0],
  ["Media", "u3", 0, 1],
  ["Broomall", "u2", 0, 0], ["Broomall", "u2", 1, 0],
  ["Broomall", "u3", 0, 0], ["Broomall", "u3", 0, 0], ["Broomall", "u3", 0, 0],
  ["Broomall", "u3", 0, 0], ["Broomall", "u3", 0, 0],
  ["Broomall", "",   0, 0], ["Broomall", "",   0, 0],
];
const EXPECT = {
  total: ROWS.length,                                        // 20
  media: ROWS.filter((r) => r[0] === "Media").length,         // 11
  bill: ROWS.filter((r) => r[1] === "u1").length,             // 7
  blocked: ROWS.filter((r) => r[2]).length,                   // 4
  checked: ROWS.filter((r) => r[3]).length,                   // 3
};

const OPPS = ROWS.map(([office, owner, blocked, checked], i) => ({
  id: `o${i + 1}`,
  name: `Family ${i + 1}`,
  pipelineId: P1,
  pipelineStageId: i % 2 === 0 ? "s1" : "s2",
  status: "open",
  ...(owner ? { assignedTo: owner } : {}),
  createdAt: new Date(Date.now() - i * 3600000).toISOString(),
  contact: { id: `c${i + 1}`, firstName: "First", lastName: `Last${i + 1}` },
  customFields: [
    { id: "F_OFFICE", fieldValue: office },
    ...(blocked ? [{ id: "F_BLOCK", fieldValue: "Waiting on documents" }] : []),
    ...(checked ? [{ id: "F_CHECK", fieldValue: "true" }] : []),
  ],
}));

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
        // ⚠️ THE NAMES MUST MATCH lib/ghl.ts's FIELD_ALIASES, normalised:
        // "roadblocker" and "checkedthisweek". A made-up name is simply not
        // mapped, so `stats.checked` stayed 0 and the tile correctly disabled
        // itself — the harness being wrong about the app, again.
        { id: "F_BLOCK", name: "Road Blocker", dataType: "TEXT" },
        { id: "F_CHECK", name: "Checked This Week", dataType: "CHECKBOX" },
      ]});
    if (u.startsWith("/users/"))
      return send(200, { users: USERS.map(([id, name]) => ({ id, name })) });
    if (u.startsWith("/opportunities/pipelines"))
      return send(200, { pipelines: [{ id: P1, name: "OLTL Enrollment",
        stages: [{ id: "s1", name: "INITIAL CALL" }, { id: "s2", name: "AUTH PENDING" }] }] });
    if (u.startsWith(`/locations/${LOC}/customValues`))
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({ seeded: true,
          pipelines: { [P1]: { scope: "client", folders: [] } }, folderNames: {} }) }] });
    if (u.startsWith("/opportunities/search"))
      return send(200, { opportunities: OPPS, meta: { total: OPPS.length } });
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
         GHL_PIT: "pit_test", GHL_SSO_SECRET: SECRET, PIPELINE_IDS: P1 },
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
await frame.waitForSelector(".board .colbody .card, table tbody tr", { timeout: 60000 });

const toView = async (which) => {
  await frame.click(`.seg button:has-text("${which}")`);
  await page.waitForTimeout(500);
};
/** What is DRAWN, in whichever view is open. */
const drawn = () => frame.evaluate(() => {
  const cards = [...document.querySelectorAll(".board .colbody .card")];
  const rows = [...document.querySelectorAll("table tbody tr")];
  const els = cards.length ? cards : rows;
  return {
    view: cards.length ? "board" : "list",
    n: els.length,
    onScreen: els.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.x < window.innerWidth && r.x + r.width > 0;
    }).length,
    count: document.querySelector(".count")?.textContent?.trim().replace(/\s+/g, " ") || null,
    banner: document.querySelector(".mfocus")?.textContent?.trim().replace(/\s+/g, " ") || null,
  };
});
/** Click a named pick-button inside a stat tile. */
const clickPick = async (label) => {
  const h = await frame.evaluateHandle((t) => {
    const b = [...document.querySelectorAll(".stat .srcpick, .stat.statbtn")]
      .find((x) => x.textContent.includes(t));
    return b || null;
  }, label);
  const el = h.asElement();
  if (!el) throw new Error(`no clickable tile entry containing "${label}"`);
  await el.click();
  await page.waitForTimeout(600);
};

// ── 1 · THE SEARCH BOX MUST GIVE ONE ANSWER ───────────────────────────────
console.log("\n1 · 🔴 SEARCH — THE LIST MATCHED 10 FIELDS, THE BOARD ONLY THE NAME");
// "Broomall" is an OFFICE, never part of a record's name. Before this round the
// list narrowed to 9 and the kanban stayed at 20.
await toView("List");
await frame.fill(".search input", "Broomall");
await page.waitForTimeout(700);
const listSearch = await drawn();
await toView("Kanban");
const boardSearch = await drawn();
console.log(`  list:  ${JSON.stringify(listSearch)}`);
console.log(`  board: ${JSON.stringify(boardSearch)}`);
const broomall = EXPECT.total - EXPECT.media;
ok(`the list narrows to ${broomall}`, listSearch.n === broomall, listSearch);
ok(`🔴 AND SO DOES THE BOARD — ${broomall} cards, not ${EXPECT.total}`,
   boardSearch.n === broomall, boardSearch);
ok("both views draw the same number", listSearch.n === boardSearch.n,
   { list: listSearch.n, board: boardSearch.n });
ok("every drawn card is on screen", boardSearch.onScreen === boardSearch.n, boardSearch);
await frame.fill(".search input", "");
await page.waitForTimeout(600);

// ── 2 · THE TILES FILTER — BOTH VIEWS ─────────────────────────────────────
for (const [label, expected, what] of [
  ["Media", EXPECT.media, "By office"],
  ["Bill", EXPECT.bill, "By rep"],
]) {
  console.log(`\n2 · 🔴 ${what.toUpperCase()} — CLICK "${label}", EXPECT ${expected}`);
  await toView("Kanban");
  await clickPick(label);
  const b = await drawn();
  console.log(`  board: ${JSON.stringify(b)}`);
  ok(`the board draws ${expected}, not ${EXPECT.total}`, b.n === expected, b);
  ok("a banner says what is showing", !!b.banner && /Showing/.test(b.banner), b.banner);
  ok("the count agrees with the cards",
     new RegExp(`^${expected} shown`).test(b.count || ""), b.count);
  ok(`and it names the set before the filter (${EXPECT.total})`,
     new RegExp(`${EXPECT.total} before this filter`).test(b.count || ""), b.count);
  await toView("List");
  const l = await drawn();
  console.log(`  list:  ${JSON.stringify(l)}`);
  ok(`🔴 the list agrees — ${expected} rows`, l.n === expected, l);
  // Escape
  await frame.click(".mfocus button");
  await page.waitForTimeout(600);
  const back = await drawn();
  ok("the escape restores every record", back.n === EXPECT.total, back);
  ok("and the banner is gone", !back.banner, back.banner);
}

// ── 3 · THE WHOLE-TILE FILTERS ────────────────────────────────────────────
for (const [label, expected] of [
  ["Road-blocked", EXPECT.blocked],
  ["Checked this week", EXPECT.checked],
]) {
  console.log(`\n3 · 🔴 "${label}" — EXPECT ${expected}`);
  await toView("Kanban");
  await clickPick(label);
  const b = await drawn();
  console.log(`  board: ${JSON.stringify(b)}`);
  ok(`the board draws ${expected}`, b.n === expected, b);
  await toView("List");
  const l = await drawn();
  ok(`the list draws ${expected} too`, l.n === expected, l);
  await frame.click(".mfocus button");
  await page.waitForTimeout(600);
}

// ── 4 · 🔴 THE TILES STILL COUNT THE UNFOCUSED SET (round 97's rule) ──────
console.log("\n4 · 🔴 CLICKING A TILE MUST NOT REWRITE THE NUMBER YOU CLICKED");
await toView("Kanban");
const beforeTiles = await frame.$$eval(".stat", (e) =>
  e.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
await clickPick("Media");
const afterTiles = await frame.$$eval(".stat", (e) =>
  e.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
const repTileBefore = beforeTiles.find((t) => t.startsWith("By rep"));
const repTileAfter = afterTiles.find((t) => t.startsWith("By rep"));
console.log(`  By rep before: ${repTileBefore}`);
console.log(`  By rep after:  ${repTileAfter}`);
ok("🔴 the other tiles are unchanged by the focus",
   repTileBefore === repTileAfter, { repTileBefore, repTileAfter });
await frame.click(".mfocus button");
await page.waitForTimeout(600);

await page.screenshot({ path: "scripts/client-filter.png" });
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
