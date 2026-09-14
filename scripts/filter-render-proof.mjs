// ---------------------------------------------------------------------------
// ROUND 113 · ITEM A — DOES A FILTER ACTUALLY FILTER?
//
// 🔴 THE ACCEPTANCE TEST IS "COUNT THE CARDS ON SCREEN", not an assertion count.
// Round 97 reported the master tiles filtering correctly with a passing script.
// The caregiver tiles were built in the same round by the same method and do
// not filter — because that script never opened the page.
//
// This clicks the real control in a real browser and counts DRAWN CARDS, then
// checks the three things that must agree:
//
//     the BANNER   says a filter is on
//     the LIST     actually narrows
//     the COUNT    matches the list, not the unfiltered total
//
// ⚠️ AND IT CHECKS BOTH VIEWS. The bug was view-specific: the caregiver LIST
// honoured the tile and the BOARD did not, so a proof that only opened one of
// them would have passed while the screen was wrong.
//
// The fixture is built so the answer is unambiguous: 12 applicants, of which
// exactly 2 belong to "Chris Miracle Makers".
//
// Run: node scripts/filter-render-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { chromium } from "playwright-core";
import CryptoJS from "crypto-js";

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const CG = "pipe_cg";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const BLOB = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Chris Tester", email: "c@e.com", companyId: "co1",
}), SECRET).toString();

// ⚠️ THE NAME IS THE ACCOUNT'S, NOT A TYPO. "Chris Miracle Makers" is how the
// GHL user is named; the harness uses it verbatim so the assertion matches what
// a recruiter actually clicks.
const RECRUITERS = [
  ["u1", "Chris Miracle Makers"],
  ["u2", "Bill Lockfeld -Sale"],
  ["u3", "Archie Emperado -Onboarding"],
];
// 12 applicants: 2 for u1, 5 for u2, 4 for u3, 1 unassigned. Two stages, so the
// board has more than one column and "did the OTHER column empty" is testable.
const OWNERS = ["u1", "u2", "u1", "u2", "u3", "u2", "u3", "u2", "u3", "u2", "u3", ""];
const APPS = OWNERS.map((owner, i) => ({
  id: `a${i + 1}`,
  name: `Applicant ${i + 1}`,
  pipelineId: CG,
  pipelineStageId: i % 2 === 0 ? "cs1" : "cs2",
  status: "open",
  ...(owner ? { assignedTo: owner } : {}),
  createdAt: new Date(Date.now() - i * 86400000).toISOString(),
  contact: { id: `c${i + 1}`, firstName: "App", lastName: `Licant${i + 1}` },
}));
const MINE = OWNERS.filter((o) => o === "u1").length; // 2

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = req.url;
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.startsWith(`/locations/${LOC}/customFields`)) return send(200, { customFields: [] });
    if (u.startsWith("/users/"))
      return send(200, { users: RECRUITERS.map(([id, name]) => ({ id, name })) });
    if (u.startsWith("/opportunities/pipelines"))
      return send(200, { pipelines: [{ id: CG, name: "PP Caregiver Applicants",
        stages: [{ id: "cs1", name: "New Applicant" }, { id: "cs2", name: "Interview" }] }] });
    if (u.startsWith(`/locations/${LOC}/customValues`))
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({ seeded: true,
          pipelines: { [CG]: { scope: "caregiver", folders: [] } }, folderNames: {} }) }] });
    if (u.startsWith("/opportunities/search"))
      return send(200, { opportunities: APPS, meta: { total: APPS.length } });
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
         GHL_PIT: "pit_test", GHL_SSO_SECRET: SECRET, PIPELINE_IDS: CG },
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
for (let i = 0; i < 10; i++) {
  // ⚠️ ROUND 120 RENAMED THIS RAIL ENTRY to Recruiting. Anchored on the rail
  // button's class as well as its label, so a future rename fails loudly here
  // rather than matching some other button that happens to say the word.
  await frame.click('.railsec:has-text("Recruiting")');
  await page.waitForTimeout(700);
  if ((await frame.textContent(".main h1"))?.includes("Applicant")) break;
}
await frame.waitForSelector(".board .colbody .card", { timeout: 60000 });

/** Cards actually drawn on the board, and the shared count line. */
const read = () => frame.evaluate(() => ({
  cards: document.querySelectorAll(".board .colbody .card").length,
  onScreen: [...document.querySelectorAll(".board .colbody .card")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.x < window.innerWidth && r.x + r.width > 0;
  }).length,
  count: document.querySelector(".count")?.textContent?.trim().replace(/\s+/g, " ") || null,
  banner: document.querySelector(".mfocus")?.textContent
            ?.trim().replace(/\s+/g, " ") || null,
  columns: document.querySelectorAll(".board .col").length,
}));

// ── 1 · UNFILTERED ─────────────────────────────────────────────────────────
console.log("\n1 · THE BOARD BEFORE ANY FILTER");
const before = await read();
console.log(`  ${JSON.stringify(before)}`);
ok("twelve cards are drawn", before.cards === 12, before);
ok("every card is on screen", before.onScreen === before.cards, before);
ok("the count says twelve", /12 applicants/.test(before.count || ""), before.count);

// ── 2 · 🔴 CLICK THE RECRUITER TILE ───────────────────────────────────────
console.log(`\n2 · 🔴 CLICK "Chris Miracle Makers" — EXPECT ${MINE} CARDS, NOT 12`);
const tile = await frame.evaluateHandle((who) => {
  const rows = [...document.querySelectorAll(".stat .srcpick")];
  return rows.find((el) => el.textContent.includes(who)) || null;
}, "Chris Miracle Makers");
const tileEl = tile.asElement();
if (!tileEl) {
  console.log("  🔴 could not find the BY RECRUITER row to click. Rows present:");
  console.log(await frame.$$eval(".stat", (e) =>
    e.map((x) => x.textContent.replace(/\s+/g, " ").slice(0, 90))));
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  await browser.close(); cleanup(); process.exit(1);
}
await tileEl.click();
await page.waitForTimeout(700);
const after = await read();
console.log(`  ${JSON.stringify(after)}`);
ok("the banner says a filter is on",
   /Chris Miracle Makers/.test(after.banner || ""), after.banner);
ok(`🔴 THE BOARD DRAWS ${MINE} CARDS, NOT 12`, after.cards === MINE, after);
ok("every remaining card is on screen", after.onScreen === after.cards, after);
ok("🔴 THE COUNT AGREES WITH THE BOARD",
   new RegExp(`${MINE} shown`).test(after.count || ""), after.count);
ok("and it still says what the unfiltered total was",
   /12 applicants? before this filter/.test(after.count || ""), after.count);

// ── 3 · THE LIST VIEW MUST AGREE WITH THE BOARD ───────────────────────────
console.log("\n3 · THE SAME FILTER, IN THE LIST VIEW");
await frame.click('.seg button:has-text("List")');
await page.waitForTimeout(700);
const rows = await frame.$$eval("table tbody tr", (e) => e.length);
const listCount = (await frame.textContent(".count"))?.trim().replace(/\s+/g, " ");
console.log(`  rows: ${rows}   count: "${listCount}"`);
ok(`🔴 the list draws ${MINE} rows too`, rows === MINE, rows);
ok("and the two views agree", new RegExp(`${MINE} shown`).test(listCount || ""), listCount);

// ── 4 · THE ESCAPE HATCH RESTORES EVERYTHING ──────────────────────────────
console.log("\n4 · 'show every applicant' PUTS THEM BACK");
await frame.click('.seg button:has-text("Kanban")');
await page.waitForTimeout(400);
await frame.click(".mfocus button");
await page.waitForTimeout(700);
const restored = await read();
console.log(`  ${JSON.stringify(restored)}`);
ok("all twelve are back", restored.cards === 12, restored);
ok("the banner is gone", !restored.banner, restored.banner);
ok("the count is a plain total again",
   /12 applicants/.test(restored.count || "") && !/shown/.test(restored.count || ""),
   restored.count);

await page.screenshot({ path: "scripts/filter-render.png" });
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
