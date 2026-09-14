// ---------------------------------------------------------------------------
// ROUND 110 · DOES A ROW APPEAR? — THE TEST THAT SHOULD HAVE EXISTED AT 100.
//
// 🔴 Rounds 100-109 reported 26/26, 9/9, 17/17, 13/13. Every one tested the
// ARITHMETIC, which was always right. Not one of them opened the page. The
// lists were `position:fixed; transform:translateX(100%)` — rendered perfectly,
// parked off the right edge of the window — and a count-based proof cannot see
// that, because a count is computed and never drawn.
//
// So this drives a REAL BROWSER against the real app and counts what is ON
// SCREEN, not what is in an array. It asserts on:
//
//   · the number of ROWS in the Sources table
//   · that each row's box is inside the viewport and has real dimensions
//   · the Touch queue's rows
//   · the Events cards, the drawer, the drawer's touch history and its
//     attributed opportunities — every list the section has
//
// Run: node scripts/referrals-render-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const LOC = "loc_test";
const RT = "F_RT", CAT = "F_CAT", TIER = "F_TIER", DIV = "F_DIV";
const REF = "F_REFERRING", EVDATE = "F_EVDATE", EVCOST = "F_EVCOST";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const now = Date.now();
const iso = (d) => new Date(now - d * 86400000).toISOString();

// FIVE partners, as on the live account: varied tier, varied category, one
// owned, three with notes.
const PARTNERS = [
  ["p1", "Riddle Hospital",    "Hospital discharge", "A",        "OLTL",        "u1"],
  ["p2", "Main Line Chamber",  "Chamber / business network", "Prospect", "All", ""],
  ["p3", "Crozer SNF",         "SNF / rehab",        "B",        "Private Pay", ""],
  ["p4", "Bryn Mawr Elder Law","Elder law",          "C",        "ODP",         ""],
  ["p5", "Springfield Senior Center", "Senior center", "Prospect","All",        ""],
];

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
        customFields: opp
          ? [
              { id: REF, name: "Referring Partner", dataType: "TEXT" },
              { id: EVDATE, name: "Event Date", dataType: "DATE" },
              { id: EVCOST, name: "Event Cost", dataType: "MONETORY" },
              { id: "F_EVHOST", name: "Event Host", dataType: "TEXT" },
              { id: "F_EVSRC", name: "Event Source", dataType: "TEXT" },
            ]
          : [
              { id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS", picklistOptions: ["Referral Partner", "Event Attendee"] },
              { id: CAT, name: "Partner Category", dataType: "SINGLE_OPTIONS", picklistOptions: ["Hospital discharge", "SNF / rehab", "Elder law", "Senior center", "Chamber / business network"] },
              { id: TIER, name: "Partner Tier", dataType: "SINGLE_OPTIONS", picklistOptions: ["A", "B", "C", "Prospect"] },
              { id: DIV, name: "Partner Division", dataType: "SINGLE_OPTIONS", picklistOptions: ["Private Pay", "OLTL", "ODP", "All"] },
              { id: "F_PROF", name: "Attendee Profile", dataType: "TEXT" },
              { id: "F_OUT", name: "Event Outcome", dataType: "SINGLE_OPTIONS", picklistOptions: ["Legit lead", "Noise"] },
              { id: "F_EVATT", name: "Event Attended", dataType: "TEXT" },
            ],
      });
    }
    if (u.startsWith("/users/")) return send(200, { users: [{ id: "u1", name: "Chris" }] });
    if (u.startsWith("/opportunities/pipelines"))
      return send(200, {
        pipelines: [
          { id: "pipe_oltl", name: "OLTL Enrollment", stages: [{ id: "s1", name: "INITIAL CALL" }] },
          { id: "pipe_events", name: "Events", stages: [{ id: "s9", name: "PLANNED" }] },
        ],
      });
    if (u.startsWith(`/locations/${LOC}/customValues`))
      return send(200, {
        customValues: [{ id: "cv1", name: "MM Pipeline Folders", value: JSON.stringify({
          seeded: true,
          pipelines: { pipe_oltl: { scope: "client", folders: [] }, pipe_events: { scope: "client", folders: [] } },
          folderNames: {},
        })}],
      });
    if (u === "/contacts/search") {
      const want = j?.filters?.[0]?.value;
      if (want !== "Referral Partner")
        return send(200, { contacts: [{ id: "a1", contactName: "Jane Attendee",
          customFields: [{ id: RT, value: "Event Attendee" }, { id: "F_EVATT", value: "ev1" }, { id: "F_OUT", value: "Legit lead" }] }], total: 1 });
      return send(200, {
        contacts: PARTNERS.map(([id, org, cat, tier, div, owner]) => ({
          id, contactName: org, assignedTo: owner,
          customFields: [
            { id: RT, value: "Referral Partner" },
            { id: CAT, value: cat }, { id: TIER, value: tier }, { id: DIV, value: div },
          ],
        })),
        total: PARTNERS.length,
      });
    }
    if (u.startsWith("/opportunities/search")) {
      const pid = new URL(`http://x${u}`).searchParams.get("pipeline_id");
      if (pid === "pipe_events")
        return send(200, { opportunities: [{ id: "ev1", name: "Delco Senior Expo",
          pipelineId: "pipe_events", pipelineStageId: "s9", status: "open", createdAt: iso(12),
          customFields: [{ id: EVDATE, fieldValue: "2026-05-04" }, { id: EVCOST, fieldValue: 1800 }, { id: "F_EVHOST", fieldValue: "p1" }] }], meta: { total: 1 } });
      return send(200, { opportunities: [
        { id: "o1", name: "Smith family", pipelineId: "pipe_oltl", pipelineStageId: "s1",
          status: "won", monetaryValue: 6000, createdAt: iso(20), customFields: [{ id: REF, fieldValue: "p1" }] },
        { id: "o2", name: "Doe family", pipelineId: "pipe_oltl", pipelineStageId: "s1",
          status: "open", monetaryValue: 5000, createdAt: iso(40), customFields: [{ id: REF, fieldValue: "p1" }] },
      ], meta: { total: 2 } });
    }
    if (/^\/contacts\/[^/]+$/.test(u)) {
      const id = u.split("/")[2];
      const row = PARTNERS.find((p) => p[0] === id);
      return send(200, { contact: { id, contactName: row?.[1] || "",
        customFields: [{ id: RT, value: "Referral Partner" }], dateUpdated: iso(1) } });
    }
    if (/^\/contacts\/[^/]+\/notes/.test(u)) {
      const id = u.split("/")[2];
      const notes = { p1: [{ id: "n1", body: "Visit: Dropped lunch.", userId: "u1", dateAdded: iso(40) }],
                      p3: [{ id: "n2", body: "Call: Checked capacity.", userId: "u1", dateAdded: iso(5) }],
                      p4: [{ id: "n3", body: "Quarterly update.", userId: "u1", dateAdded: iso(200) }] }[id] || [];
      return send(200, { notes });
    }
    send(404, { message: `no fake handler for ${u}` });
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fp = fake.address().port;

const PORT = 3644;
const dev = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  env: { ...process.env, GHL_API_BASE: `http://127.0.0.1:${fp}`, GHL_LOCATION_ID: LOC,
         GHL_PIT: "pit_test", PIPELINE_IDS: "pipe_oltl,pipe_events" },
  stdio: ["ignore", "pipe", "pipe"],
});
dev.stdout.on("data", () => {});
dev.stderr.on("data", () => {});

// 🔴 localhost, NOT 127.0.0.1 — AND THIS IS WHY NO BROWSER TEST EVER EXISTED.
// Next 16 blocks cross-origin requests to dev-only assets, and the dev server
// initialises with `localhost`. A browser at http://127.0.0.1:PORT is a
// DIFFERENT ORIGIN, so every /_next/static/chunks/*.js came back 403, no client
// JS ran, and the page sat on its server-rendered HTML for ever. The earlier
// harnesses used fetch(), which sends no Origin header, so they never hit it.
// (node_modules/next/dist/docs/.../allowedDevOrigins.md)
const base = `http://localhost:${PORT}`;
let up = false;
for (let i = 0; i < 90 && !up; i++) {
  try { const r = await fetch(`${base}/api/referrals?only=partners`, { signal: AbortSignal.timeout(5000) }); if (r.ok) up = true; }
  catch { await new Promise((r) => setTimeout(r, 1000)); }
}
if (!up) { console.log("dev server never came up"); dev.kill(); fake.close(); process.exit(1); }

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-proxy-server", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") console.log(`  [console] ${m.text().slice(0, 200)}`); });
page.on("requestfailed", (r) => console.log(`  [failed] ${r.url().slice(0, 120)} — ${r.failure()?.errorText}`));
await page.goto(base, { waitUntil: "domcontentloaded" });

// Into the Referrals section.
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(1500);
  const hydrated = await page.evaluate(() =>
    !!document.querySelector("#__next, body > div")?.hasAttribute("data-reactroot") ||
    typeof window.next !== "undefined",
  );
  const hdr = (await page.textContent(".viewas"))?.trim().replace(/\s+/g, " ");
  console.log(`  t+${((i + 1) * 1.5).toFixed(1)}s  hydrated=${hydrated}  header="${hdr}"`);
  if (!/Checking session/.test(hdr || "")) break;
}
// ⚠️ WAIT FOR HYDRATION BEFORE CLICKING. The first attempt clicked at ~1s,
// before React had attached its handlers in `next dev`, so setView never ran
// and the headline stayed on "Cases" — the test failing for its own reason
// rather than the app's.
await page.waitForFunction(
  () => !/Checking session/.test(document.querySelector(".viewas")?.textContent || ""),
  { timeout: 30000 },
);
const railNames = await page.$$eval(".railsec span", (e) => e.map((x) => x.textContent));
console.log(`  rail entries: ${JSON.stringify(railNames)}`);
// Click until the view actually changes — proof the handler is live.
for (let i = 0; i < 10; i++) {
  await page.getByRole("button", { name: "Referrals" }).click();
  await page.waitForTimeout(600);
  const h = (await page.textContent(".main h1"))?.trim();
  if (h === "Referrals") break;
}
console.log(`  after click, headline: ${JSON.stringify((await page.textContent(".main h1"))?.trim())}`);
console.log(`  statecard: ${JSON.stringify((await page.$(".statecard")) ? (await page.textContent(".statecard"))?.trim().replace(/\s+/g, " ").slice(0, 120) : null)}`);
try {
  await page.waitForSelector(".rfwrap", { timeout: 45000 });
} catch {
  console.log(`  🔴 .rfwrap never appeared. body text:`);
  console.log((await page.textContent("body")).replace(/\s+/g, " ").slice(0, 500));
  await page.screenshot({ path: "scripts/referrals-render-FAILED.png" });
  await browser.close(); dev.kill("SIGTERM"); fake.close();
  process.exit(1);
}
await page.waitForFunction(() => !document.querySelector(".rfwrap .spinner"), { timeout: 60000 });

/** Is the element actually on screen, with real dimensions? */
const visible = (sel) =>
  page.$$eval(sel, (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x),
               onScreen: r.width > 0 && r.height > 0 && r.x < window.innerWidth && r.x + r.width > 0 };
    }),
  );

console.log("\n1 · 🔴 THE SOURCES TABLE — DOES A ROW APPEAR?");
const srcRows = await visible(".rftable tbody tr");
console.log(`  rows in the DOM: ${srcRows.length}`);
console.log(`  first row box:   ${JSON.stringify(srcRows[0] || null)}`);
ok("FIVE rows are rendered", srcRows.length === 5, srcRows.length);
ok("every row is ON SCREEN with real dimensions", srcRows.length > 0 && srcRows.every((r) => r.onScreen), srcRows);
const orgs = await page.$$eval(".rftable tbody .rforg", (e) => e.map((x) => x.textContent));
console.log(`  organisations drawn: ${JSON.stringify(orgs)}`);
ok("the five partner names are the ones drawn", orgs.length === 5, orgs);
const foot = await page.textContent(".rffoot");
console.log(`  footnote: ${foot?.trim().replace(/\s+/g, " ").slice(0, 90)}`);

console.log("\n2 · THE TOUCH QUEUE");
await page.getByRole("tab", { name: /Touch queue/ }).click();
await page.waitForTimeout(400);
const qRows = await visible(".rfq");
console.log(`  queue rows: ${qRows.length} · first: ${JSON.stringify(qRows[0] || null)}`);
ok("the queue draws rows", qRows.length > 0, qRows.length);
ok("  and they are on screen", qRows.every((r) => r.onScreen), qRows);

console.log("\n3 · THE EVENTS CARDS");
await page.getByRole("tab", { name: /Events/ }).click();
await page.waitForTimeout(400);
const evCards = await visible(".rfev");
console.log(`  event cards: ${evCards.length} · first: ${JSON.stringify(evCards[0] || null)}`);
ok("the event card draws", evCards.length === 1, evCards.length);
ok("  and is on screen", evCards.every((r) => r.onScreen), evCards);
const stats = await page.$$eval(".rfev .rfstat .v", (e) => e.map((x) => x.textContent));
console.log(`  its six stats: ${JSON.stringify(stats)}`);
ok("six stats are drawn", stats.length === 6, stats);
const attRows = await visible(".rfoc");
ok("the per-event attendee row draws", attRows.length >= 1, attRows.length);

console.log("\n4 · THE DRAWER, AND THE TWO LISTS INSIDE IT");
await page.getByRole("tab", { name: /Sources/ }).click();
await page.waitForTimeout(300);
// ⚠️ BY NAME. The first run clicked whatever sorted first — Main Line Chamber,
// which has no notes in this fixture — and reported "touch history draws 0" as
// though the app were at fault. Riddle Hospital is the one with a note.
await page.getByText("Riddle Hospital", { exact: true }).first().click();
await page.waitForSelector(".rfdrawer", { timeout: 15000 });
await page.waitForTimeout(900); // the notes fetch
const drawer = (await visible(".rfdrawer"))[0];
console.log(`  drawer box: ${JSON.stringify(drawer)}`);
ok("the drawer is on screen", !!drawer && drawer.onScreen, drawer);
const tl = await visible(".rftl .rftli");
console.log(`  touch-history entries: ${tl.length}`);
ok("touch history draws", tl.length >= 1, tl.length);
const kv = await page.$$eval(".rfdrawer .rfkv dd", (e) => e.map((x) => x.textContent));
console.log(`  attributed opportunities + performance values: ${kv.length} cells`);
ok("the attributed-opportunities list draws", kv.length > 6, kv.length);

await page.screenshot({ path: "scripts/referrals-render.png", fullPage: false });
console.log("\n  screenshot: scripts/referrals-render.png");

await browser.close();
dev.kill("SIGTERM");
fake.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
setTimeout(() => process.exit(fail ? 1 : 0), 300);
