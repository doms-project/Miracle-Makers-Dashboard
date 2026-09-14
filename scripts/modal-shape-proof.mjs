// ---------------------------------------------------------------------------
// ROUND 117 · ITEM 1 — ALL FOUR REFERRAL MODALS, MEASURED ON SCREEN.
//
// ⚠️ THE ACCEPTANCE TEST IS NOT AN ASSERTION COUNT. It is: open each modal
// and COUNT what a person sees — how many rows tall, how many controls share a
// line, how wide the box is, how many hints there are.
//
// 🔴 115c FIXED "Log a referral" ALONE. So this measures all four against the
// same numbers, and the one that was already fixed is the control: if the
// others do not match it, the round did not happen.
//
// Run: node scripts/modal-shape-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { chromium } from "playwright-core";
import CryptoJS from "crypto-js";

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const RT = "F_RT", CAT = "F_CAT", TIER = "F_TIER", DIV = "F_DIV";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const BLOB = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Chris Tester", email: "chris@example.com", companyId: "co1",
}), SECRET).toString();

// The free-text corpus. "Riddle" must match three of them.
const ALL_CONTACTS = [
  { id: "x1", contactName: "Riddle Hospital",        email: "d@riddle.org",  phone: "" },
  { id: "x2", contactName: "Riddle Memorial Rehab",  email: "",              phone: "610-555-0101" },
  { id: "x3", contactName: "Joan Riddle",            email: "joan@mail.com", phone: "" },
  { id: "x4", contactName: "Crozer SNF",             email: "",              phone: "" },
  // ⚠️ A CLIENT, not a partner. Item 4's path attributes a CLIENT's existing
  // case to a partner, so the fixture needs somebody to be the client — the
  // first run searched "Riddle", found the partner, and listed zero cases.
  { id: "c_mich", contactName: "Michelle Chance", email: "m@ex.com", phone: "610-555-0199" },
];

/** Every request the fake GHL received, so the route's behaviour is visible. */
const ghlCalls = [];

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : null;
    const u = req.url;
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.startsWith(`/locations/${LOC}/customFields`)) {
      const opp = u.includes("model=opportunity");
      return send(200, {
        customFields: opp ? [{ id: "F_REF", name: "Referring Partner", dataType: "TEXT" }] : [
          { id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS",
            picklistOptions: ["Referral Partner", "Event Attendee"] },
          { id: CAT, name: "Partner Category", dataType: "SINGLE_OPTIONS",
            picklistOptions: ["Hospital discharge", "SNF / rehab"] },
          { id: TIER, name: "Partner Tier", dataType: "SINGLE_OPTIONS",
            picklistOptions: ["A", "B", "C", "Prospect"] },
          { id: DIV, name: "Partner Division", dataType: "SINGLE_OPTIONS",
            picklistOptions: ["Private Pay", "OLTL", "All"] },
        ],
      });
    }
    if (u.startsWith("/users/")) return send(200, { users: [{ id: "u1", name: "Chris" }] });
    if (u.startsWith("/opportunities/pipelines"))
      return send(200, { pipelines: [
        { id: "pipe_oltl", name: "OLTL Enrollment", stages: [{ id: "s1", name: "INITIAL CALL" }] },
      ]});
    if (u.startsWith(`/locations/${LOC}/customValues`))
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({ seeded: true,
          pipelines: { pipe_oltl: { scope: "client", folders: [] } }, folderNames: {} }) }] });
    if (u === "/contacts/search") {
      ghlCalls.push({ url: u, body: j });
      // 🔴 TWO DIFFERENT CALLS ARRIVE HERE and the fake must tell them apart the
      // way GoHighLevel does: `query` is free text (searchContacts), `filters`
      // is the custom-field filter (ghlSearchContacts).
      if (j?.query) {
        const needle = String(j.query).toLowerCase();
        const hits = ALL_CONTACTS.filter((c) =>
          c.contactName.toLowerCase().includes(needle));
        return send(200, { contacts: hits, total: hits.length });
      }
      if (j?.filters?.[0]?.value === "Referral Partner")
        return send(200, { contacts: [{ id: "x1", contactName: "Riddle Hospital",
          customFields: [{ id: RT, value: "Referral Partner" },
                         { id: CAT, value: "Hospital discharge" },
                         { id: TIER, value: "A" }, { id: DIV, value: "OLTL" }] }], total: 1 });
      return send(200, { contacts: [], total: 0 });
    }
    if (u.startsWith("/opportunities/search"))
      // 🔴 TWELVE attributed cases, all on partner x1, so the drawer's list is
      // long enough for "does the last row reach the bottom" to mean anything.
      return send(200, { opportunities: Array.from({ length: 12 }, (_, i) => ({
        id: `o${i + 1}`,
        name: [`Michelle Chance`, `FT E-Under21`, `Alvarez family`, `R. Okonkwo`,
               `Bettencourt case`, `D. Whitfield`, `Nguyen household`, `S. Abara`,
               `Kowalczyk family`, `T. Mbeki`, `Fairweather case`, `J. Santoro`][i],
        pipelineId: "pipe_oltl", pipelineStageId: "s1",
        status: i === 1 ? "won" : "open",
        monetaryValue: i === 1 ? 5500 : 0,
        createdAt: new Date(Date.now() - (i + 3) * 86400000).toISOString(),
        contact: { id: "c_mich", firstName: "Michelle", lastName: "Chance" },
        // Most already credited to x1 so "already credited" is testable, a few
        // not — the case item 4 exists for.
        // ⚠️ i===1 MUST stay credited: it is the won/$5,500 case section 6
        // asserts on, and dropping its attribution removed it from the drawer.
        customFields: i === 1 || i % 2 === 0 ? [{ id: "F_REF", fieldValue: "x1" }] : [],
      })), meta: { total: 12 } });
    if (/^\/contacts\/[^/]+\/notes/.test(u)) return send(200, { notes: [] });
    if (/^\/contacts\/[^/]+$/.test(u)) return send(200, { contact: { id: "x1" } });
    send(404, { message: `no fake handler for ${u}` });
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fp = fake.address().port;

// Next 16 is one dev server per DIRECTORY — clear any orphan and its lock.
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
         GHL_PIT: "pit_test", GHL_SSO_SECRET: SECRET, PIPELINE_IDS: "pipe_oltl" },
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
    if (r.status === 401 || r.ok) up = true;
  } catch { /* not listening */ }
  if (!up) await new Promise((r) => setTimeout(r, 1000));
}
if (!up) {
  console.log(`dev server never came up on ${PORT}:`);
  console.log(devLog.join("").slice(-1500));
  process.exit(1);
}
console.log(`  dev server up on ${PORT}`);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-proxy-server", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));

/** Every /api/referrals?only=contacts request the browser makes. */
const searchReqs = [];
page.on("response", async (r) => {
  if (!r.url().includes("only=contacts")) return;
  let text = "";
  try { text = (await r.text()).slice(0, 300); } catch { text = "(unreadable)"; }
  searchReqs.push({ status: r.status(), url: r.url().split("?")[1], body: text });
});

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
  await frame.click('button:has-text("Referrals")');
  await page.waitForTimeout(600);
  if ((await frame.textContent(".main h1"))?.trim() === "Referrals") break;
}
await frame.waitForSelector(".rfwrap", { timeout: 60000 });
await frame.waitForFunction(() => !document.querySelector(".rfwrap .spinner"), { timeout: 60000 });


// ── HOW A MODAL IS MEASURED ───────────────────────────────────────────────
// 🔴 PAIRED means two controls whose top edges are within 4px of each other:
// the actual visual property, not "they are in the same JSX element". The four
// fields in Add-a-partner were ALREADY two-per-`.irow`; `.movebody .irow
// input{width:100%}` put each on its own line anyway. Only geometry can tell
// those apart.
const measure = async (name) => {
  await frame.waitForSelector(".addbox", { timeout: 15000 });
  const m = await frame.evaluate(() => {
    const box = document.querySelector(".addbox");
    const body = box.querySelector(".movebody");
    const ctrls = [...body.querySelectorAll("input:not([type=radio]):not([type=search]), select, textarea")]
      .filter((e) => e.getClientRects().length);
    // ⚠️ TOLERANCE, NOT A BUCKET. Rounding tops to a 4px grid splits two
    // controls at 100px and 103px into different rows — which is how this
    // first reported "Log a referral" as pairing one line when it pairs two.
    // Sorted tops, grouped while within 6px of the row's first member.
    const tops = ctrls.map((c) => c.getBoundingClientRect().top).sort((a, b) => a - b);
    const rows = [];
    for (const t of tops) {
      const last = rows[rows.length - 1];
      if (last && t - last.top <= 6) last.n += 1;
      else rows.push({ top: t, n: 1 });
    }
    return {
      width: Math.round(box.getBoundingClientRect().width),
      controls: ctrls.length,
      rows: rows.length,
      paired: rows.filter((r) => r.n > 1).length,
      groups: body.querySelectorAll(".rfglab").length,
      hints: [...body.querySelectorAll(".rfdhint, .rfpaircell")]
        .filter((e) => e.getClientRects().length).length,
      bodyHeight: Math.round(body.scrollHeight),
      overflows: body.scrollHeight > body.clientHeight + 2,
    };
  });
  console.log(`  ${name.padEnd(22)} ${m.width}px · ${m.controls} controls in ` +
              `${m.rows} rows (${m.paired} paired) · ${m.groups} groups · ${m.hints} hints`);
  return m;
};

const shapes = {};

// ── 1 · ADD A PARTNER ─────────────────────────────────────────────────────
console.log("\n1 · 🔴 THE FOUR MODALS, MEASURED");
await frame.click('button:has-text("Add partner")');
shapes.partner = await measure("Add a referral partner");
await frame.click(".addbox .previewhead .x");
await page.waitForTimeout(300);

// ── 2 · LOG A REFERRAL — THE CONTROL, because 115c already fixed it ───────
await frame.click(".rftable tbody tr:first-child");
await frame.waitForSelector(".rfdrawer", { timeout: 15000 });
await frame.click('.rfdrawer button:has-text("Log a referral")');
shapes.referral = await measure("Log a referral");
await frame.click(".addbox .previewhead .x");
await page.waitForTimeout(300);

// ── 3 · LOG A TOUCH ───────────────────────────────────────────────────────
await frame.click('.rfdrawer button:has-text("Log a touch")');
shapes.touch = await measure("Log a touch");
await frame.click(".addbox .previewhead .x");
await page.waitForTimeout(300);

// ── 4 · ADD AN EVENT ──────────────────────────────────────────────────────
await frame.click('.rfdrawer button:has-text("Add an event")');
shapes.event = await measure("Add an event");

// ── THE ASSERTIONS ────────────────────────────────────────────────────────
console.log("\n2 · ✅ ONE WIDTH");
// 🔴 THE REFERRALS TAB WAS HALF WIDTH until 115c removed max-width:1180px on
// .rfwrap. The brief asks whether the modals carry their own version of that —
// measured, not read: all four are the same box, and it is 760.
for (const [k, m] of Object.entries(shapes))
  ok(`${k} is 760px, like Log a referral`, m.width === 760, m.width);

console.log("\n3 · 🔴 SHORT FIELDS PAIRED");
ok("Add a partner pairs at least three lines", shapes.partner.paired >= 3, shapes.partner);
ok("Log a referral still pairs two", shapes.referral.paired >= 2, shapes.referral);
ok("Add an event pairs two", shapes.event.paired >= 2, shapes.event);
// ⚠️ "Log a touch" has ONE short field and a textarea. There is no pair to
// make, and inventing a field to fill the cell would be worse than the fault.
ok("⚠️ Log a touch has no two short fields to pair — and does not invent one",
   shapes.touch.controls === 2, shapes.touch);

console.log("\n4 · 🔴 GROUPED — NOT ONE UNDIFFERENTIATED COLUMN");
for (const [k, m] of Object.entries(shapes))
  ok(`${k} has headings`, m.groups >= 1, m);
ok("Add a partner has three", shapes.partner.groups === 3, shapes.partner.groups);
ok("Add an event has two", shapes.event.groups === 2, shapes.event.groups);
ok("🔴 and Log a referral — the one 115c fixed — now matches them",
   shapes.referral.groups >= 2, shapes.referral.groups);
console.log("\n   ⚠️ Log a referral was the CONTROL for width and pairing, and the");
console.log("   one thing it lacked was grouping. It has it now, so all four match.");

console.log("\n5 · 🔴 ENOUGH DETAIL — EVERY MODAL EXPLAINS ITSELF");
for (const [k, m] of Object.entries(shapes))
  ok(`${k} carries at least three hints`, m.hints >= 3, m.hints);

console.log("\n6 · ⚠️ AND THE HINTS SAY THE RIGHT THINGS");
const touchText = await frame.evaluate(() => "");
await frame.click(".addbox .previewhead .x");
await page.waitForTimeout(300);
await frame.click('.rfdrawer button:has-text("Log a touch")');
await frame.waitForSelector(".addbox", { timeout: 15000 });
const tTxt = (await frame.textContent(".addbox .movebody")).replace(/\s+/g, " ");
console.log(`  touch: …${tTxt.slice(0, 130)}…`);
ok("🔴 it says what counts as a touch", /A touch is contact with a person/i.test(tTxt), tTxt.slice(0, 200));
ok("🔴 and that it restarts the cadence clock", /restarts the cadence clock/i.test(tTxt), tTxt.slice(0, 400));
await frame.click(".addbox .previewhead .x");
await page.waitForTimeout(300);

await frame.click('.rfdrawer button:has-text("Add an event")');
await frame.waitForSelector(".addbox", { timeout: 15000 });
const eTxt = (await frame.textContent(".addbox .movebody")).replace(/\s+/g, " ");
ok("🔴 the event modal says what the cost is FOR",
   /cost per legitimate lead/i.test(eTxt), eTxt.slice(0, 300));
ok("⚠️ and that leaving it blank does not read as free",
   /does not read as free/i.test(eTxt), eTxt.slice(0, 500));
await frame.click(".addbox .previewhead .x");
await page.waitForTimeout(300);

await frame.click(".rfdrawer .x");
await page.waitForTimeout(300);
await frame.click('button:has-text("Add partner")');
await frame.waitForSelector(".addbox", { timeout: 15000 });
const pTxt = (await frame.textContent(".addbox .movebody")).replace(/\s+/g, " ");
ok("🔴 the partner modal says what a tier does", /Tier sets the contact cadence/i.test(pTxt), pTxt.slice(0, 300));
ok("🔴 what the owner drives", /whose due queue this lands in/i.test(pTxt), pTxt.slice(0, 600));
ok("🔴 and that a category can be set later",
   /Category can be left Not set/i.test(pTxt), pTxt.slice(0, 800));

console.log(`\n${pass} passed, ${fail} failed.`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
