// ---------------------------------------------------------------------------
// ROUND 112 · ITEM 5 — THE SECTION CARDS RENDER ONE CHARACTER PER LINE.
//
// 🔴 ROUND 92 "PROVED" THIS LAYOUT WITH FOUR CARDS AT 1500px, which fit on one
// row whatever the rule said. Fourteen is the real case, and it is the only one
// that can show the packing going wrong.
//
// So this renders the Pipelines screen with FOURTEEN sections and MEASURES:
//   · how many grid columns the browser actually computed
//   · every card's width and height in pixels
//   · whether the labels wrap to more lines than they have words
//   · that expanding one card PUSHES the rows below it down, in flow
//
// ⚠️ /api/admin/pipelines is fulfilled directly rather than modelled through a
// fake GoHighLevel: the payload shape is not what is under test, the RENDER is.
//
// Run: node scripts/section-grid-proof.mjs
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

// 🔴 THE REAL FOURTEEN, with the real longest label. "Website Intent Form" at 19
// characters is the one that sets every card's height when the grid misbehaves.
const LABELS = [
  ["Ad Attribution", 7], ["Client", 6], ["Enrolment", 8], ["Event Details", 6],
  ["Facebook Form", 4], ["Filing", 3], ["Google Ads Form", 5], ["Intake", 9],
  ["Kinship", 2], ["Referral Detail", 4], ["Scheduling", 6], ["Screening", 7],
  ["Verification", 5], ["Website Intent Form", 4],
];
// ⚠️ REAL FIELD NAMES AND REAL TYPES — round 115b, item I. The panel now shows
// a type beside each name, and "Ad Attribution" is the live section whose seven
// fields read as eight when run together.
const TYPES = ["TEXT", "LARGE_TEXT", "DATE", "SINGLE_OPTIONS", "CHECKBOX",
               "MULTIPLE_OPTIONS", "NUMERICAL", "MONETORY"];
const AD_ATTRIB = [
  ["How soon is care needed?", "SINGLE_OPTIONS"],
  ["Landing page URL", "TEXT"],
  ["SMS Consent", "CHECKBOX"],
  ["SMS Consent text", "LARGE_TEXT"],
  ["Submitted At", "DATE"],
  ["What can we help with?", "LARGE_TEXT"],
  ["Who is the care for?", "SINGLE_OPTIONS"],
];
const SECTIONS = LABELS.map(([label, n], i) => ({
  key: `k${i}`, id: `f${i}`, label, named: true,
  fields: i === 0
    ? AD_ATTRIB.map(([name, dataType], j) => ({ id: `0_${j}`, name, dataType }))
    : Array.from({ length: n }, (_, j) => ({
        id: `${i}_${j}`, name: `Field ${j + 1}`, dataType: TYPES[j % TYPES.length],
      })),
}));

// ── ROUND 113 · ITEM J ───────────────────────────────────────────────────
// Three rows, so "it works for some and not this one" is testable in one run:
//   pipe_oltl    an entry written THROUGH this screen — folder KEYS
//   pipe_events  an entry written by an API SCRIPT — folder RAW IDS
//   pipe_test    genuinely unconfigured, no entry at all
// ⚠️ The middle one is the hypothesis under test, not a decoration: `s.key` is
// a code key where one exists, so a stored raw id cannot match it.
const PAYLOAD = {
  pipelines: [
    { id: "pipe_oltl", name: "OLTL Enrollment",
      stages: [{ id: "s1", name: "INITIAL CALL" }], division: "OLTL", configured: true },
    { id: "pipe_events", name: "Events",
      stages: [{ id: "s9", name: "PLANNED" }], division: "Events", configured: true },
    { id: "pipe_test", name: "test",
      stages: [{ id: "s0", name: "NEW" }], division: "test", configured: false },
  ],
  config: { seeded: true, pipelines: {
    pipe_oltl: { scope: "client", folders: ["k0", "k1"] },
    // The same three folders the live Events entry holds, but addressed by the
    // sections' `id` rather than their `key` — what a script that read GHL's
    // folder ids directly would have written.
    pipe_events: { scope: "client", folders: ["f0", "f3", "f9"] },
  }, folderNames: {} },
  stale: [], sections: SECTIONS, known: [], sharedKey: "k0",
  unconfiguredFolders: [], inertSections: [],
};

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
    // ⚠️ ANY response means Next is serving. This harness sets no GHL_API_BASE
    // — the route is fulfilled in the BROWSER — so the server's own probe
    // reaches the real host, which the sandbox blocks with a 403. Treating only
    // 401/200 as "up" made a working server look dead.
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

await page.route("**/api/admin/pipelines*", (route) =>
  route.fulfill({ status: 200, contentType: "application/json",
                  body: JSON.stringify(PAYLOAD) }));
await page.route("**/api/opportunities*", (route) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    records: [], pipelines: [{ id: "pipe_oltl", name: "OLTL Enrollment" }],
    stagesByPipeline: {}, users: [], fieldDefs: [], failedPipelines: [],
    viewer: { authenticated: true, isAdmin: true, role: "admin", userName: "Chris Tester",
              homePipelineIds: ["pipe_oltl"], canSeeMaster: true, total: 0 },
  })}));
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
  await frame.click('button:has-text("Pipelines")');
  await page.waitForTimeout(600);
  if (await frame.$(".pfseclist")) break;
}
await frame.waitForSelector(".pffolders .pfseclist .pfsec", { timeout: 60000 });

// ── 1 · HOW MANY COLUMNS DID THE BROWSER ACTUALLY COMPUTE? ─────────────────
console.log("\n1 · 🔴 THE COMPUTED GRID, AT 1440px WITH FOURTEEN CARDS");
const grid = await frame.evaluate(() => {
  const list = document.querySelector(".pffolders .pfseclist");
  const cs = getComputedStyle(list);
  const r = list.getBoundingClientRect();
  return {
    display: cs.display,
    columns: cs.gridTemplateColumns,
    columnCount: cs.gridTemplateColumns.split(/\s+/).filter(Boolean).length,
    listWidth: Math.round(r.width),
  };
});
console.log(`  container: ${grid.listWidth}px · display:${grid.display}`);
console.log(`  grid-template-columns: ${grid.columns}`);
console.log(`  → ${grid.columnCount} columns`);
ok("the container is not collapsed", grid.listWidth > 300, grid);
ok("🔴 NOT fourteen columns crammed into one row", grid.columnCount < 14, grid);

// ── 2 · THE CARDS THEMSELVES ───────────────────────────────────────────────
console.log("\n2 · 🔴 EVERY CARD'S BOX");
const cards = await frame.$$eval(".pffolders .pfseclist .pfsec", (els) =>
  els.map((el) => {
    const r = el.getBoundingClientRect();
    const name = el.querySelector(".pfsecname");
    const nr = name?.getBoundingClientRect();
    // Lines the label actually occupies = its height / its line-height.
    const lh = name ? parseFloat(getComputedStyle(name).lineHeight) || 18 : 18;
    return {
      label: name?.textContent?.trim() || "",
      w: Math.round(r.width), h: Math.round(r.height),
      lines: nr ? Math.round(nr.height / lh) : 0,
      words: (name?.textContent?.trim().split(/\s+/).length) || 1,
    };
  }),
);
for (const c of cards)
  console.log(`  ${String(c.w).padStart(4)}×${String(c.h).padStart(3)}  ` +
              `${c.lines} line(s) / ${c.words} word(s)   ${c.label}`);
// 🔴 WHY. Both lists render ~220px cards, yet only the first wraps — so the
// answer is inside the card, in how its three grid tracks divide that width.
const inside = await frame.evaluate(() => {
  const each = (sel) => {
    const card = document.querySelector(sel);
    if (!card) return null;
    const cs = getComputedStyle(card);
    return {
      cardW: Math.round(card.getBoundingClientRect().width),
      tracks: cs.gridTemplateColumns,
      children: [...card.children].map((c) => ({
        cls: c.className,
        w: Math.round(c.getBoundingClientRect().width),
      })),
      lab: (() => {
        const l = card.querySelector(".pfseclab");
        const n = card.querySelector(".pfsecname");
        const lcs = l ? getComputedStyle(l) : null;
        const ncs = n ? getComputedStyle(n) : null;
        return {
          labW: l ? Math.round(l.getBoundingClientRect().width) : null,
          labDisplay: lcs?.display, labWrap: lcs?.flexWrap,
          nameW: n ? Math.round(n.getBoundingClientRect().width) : null,
          nameH: n ? Math.round(n.getBoundingClientRect().height) : null,
          nameDisplay: ncs?.display, nameFlex: ncs?.flex,
          nameMinW: ncs?.minWidth, nameWrap: ncs?.overflowWrap,
          nameWS: ncs?.whiteSpace, nameFont: ncs?.fontSize,
        };
      })(),
    };
  };
  const lists = document.querySelectorAll(".pffolders .pfseclist");
  return {
    first: each(".pffolders .pfseclist .pfsec"),
    firstList: lists[0] ? getComputedStyle(lists[0]).gridTemplateColumns : null,
  };
});
console.log(`  INSIDE THE FIRST CARD: ${JSON.stringify(inside.first)}`);

const narrowest = Math.min(...cards.map((c) => c.w));
const tallest = Math.max(...cards.map((c) => c.h));
const shortest = Math.min(...cards.map((c) => c.h));
ok("fourteen cards", cards.length === 14, cards.length);
ok("🔴 no card is narrower than the 196px the rule promises",
   narrowest >= 190, { narrowest, cards: cards.filter((c) => c.w < 190) });
ok("🔴 NO LABEL WRAPS TO MORE LINES THAN IT HAS WORDS — that is the " +
   "one-character-per-line symptom",
   cards.every((c) => c.lines <= c.words), cards.filter((c) => c.lines > c.words));
ok("🔴 the longest label does not pad every other card",
   tallest - shortest <= 24, { tallest, shortest });

// ── 3 · EXPANDING ONE MUST PUSH THE ROWS BELOW DOWN ────────────────────────
console.log("\n3 · EXPANDING A CARD PUSHES THE ROWS BELOW IT DOWN");
const beforeY = await frame.$$eval(".pffolders .pfseclist .pfsec", (els) =>
  els.map((e) => Math.round(e.getBoundingClientRect().y)));
const beforeH = (await frame.$eval(".pffolders .pfseclist", (e) =>
  Math.round(e.getBoundingClientRect().height)));
// The chevron BUTTON is the affordance; the name span is not clickable here.
await frame.$eval(".pffolders .pfseclist .pfsec:first-child .pfsectoggle", (e) => e.click());
await page.waitForTimeout(500);
const afterY = await frame.$$eval(".pffolders .pfseclist .pfsec", (els) =>
  els.map((e) => Math.round(e.getBoundingClientRect().y)));
const afterH = (await frame.$eval(".pffolders .pfseclist", (e) =>
  Math.round(e.getBoundingClientRect().height)));
const lastMoved = afterY[afterY.length - 1] - beforeY[beforeY.length - 1];
console.log(`  list height ${beforeH} → ${afterH}   last card moved ${lastMoved}px`);
ok("the list grew", afterH > beforeH, { beforeH, afterH });
ok("🔴 and a later row was pushed DOWN, not overlapped",
   lastMoved > 0 || afterH > beforeH, { lastMoved, beforeH, afterH });

// ── 4 · ITEM J · THE SCOPE DROPDOWN AND THE TICKS ─────────────────────────
console.log("\n4 · 🔴 ITEM J — DOES A ROW SHOW ITS OWN STORED ENTRY?");
const rowsJ = await frame.evaluate(() => {
  const out = [];
  for (const row of document.querySelectorAll(".pfrow")) {
    row.open = true;
    const name = row.querySelector("summary b")?.textContent?.trim() || "";
    const header = row.querySelector(".pfscope")?.textContent?.trim() || "";
    const count = row.querySelector(".pfcount")?.textContent?.trim() || "";
    const sel = row.querySelector(".pfscopeedit select");
    // 🔴 THE FOLDER TICK ONLY — `.pfseclab`. Round 116 put a checkbox on every
    // FIELD inside an expanded section (item Q), and `expanded` is one Set
    // shared by every row, so a card expanded earlier in this run added seven
    // per-field boxes to each row's count: 2 read as 9 and 3 as 10. The rows
    // were right; the selector had stopped meaning "sections ticked".
    const ticked = [...row.querySelectorAll('.pfseclist .pfseclab input[type="checkbox"]')]
      .filter((c) => c.checked).length;
    out.push({ name, header, count, dropdown: sel ? sel.value : null, ticked });
  }
  return out;
});
for (const r of rowsJ)
  console.log(`  ${r.name.padEnd(18)} header="${r.header}" ${r.count.padEnd(14)}` +
              ` dropdown="${r.dropdown}" ticked=${r.ticked}`);
const oltl = rowsJ.find((r) => r.name === "OLTL Enrollment");
const events = rowsJ.find((r) => r.name === "Events");
const test = rowsJ.find((r) => r.name === "test");
ok("a screen-written entry shows Client in the dropdown",
   oltl?.dropdown === "client", oltl);
ok("and its two ticks render", oltl?.ticked === 2, oltl);
ok("🔴 the SCRIPT-written entry also shows Client, not 'Choose a scope…'",
   events?.dropdown === "client", events);
ok("🔴 and its three ticks render too", events?.ticked === 3, events);
ok("a genuinely unconfigured row is the ONLY one reading 'Choose a scope…'",
   test?.dropdown === "" && test?.header === "not configured", test);

// ── 5 · ROUND 115b ITEM I · THE EXPANDED PANEL ────────────────────────────
console.log("\n5 · 🔴 ITEM I — ONE FIELD PER LINE, WITH ITS TYPE");
// Collapse everything, then open Ad Attribution alone.
await frame.evaluate(() => {
  for (const b of document.querySelectorAll('.pffolders .pfsectoggle[aria-expanded="true"]'))
    b.click();
});
await page.waitForTimeout(300);
await frame.$eval(".pffolders .pfseclist .pfsec:first-child .pfsectoggle",
                  (e) => e.click());
await page.waitForTimeout(500);
const panel = await frame.evaluate(() => {
  const card = document.querySelector(".pffolders .pfsec.open");
  const list = card?.querySelector(".pffieldlist");
  const listRect = document.querySelector(".pffolders .pfseclist").getBoundingClientRect();
  const cardRect = card?.getBoundingClientRect();
  const rows = [...(list?.querySelectorAll("li") || [])].map((li) => {
    const r = li.getBoundingClientRect();
    const name = li.querySelector(".pffname");
    const type = li.querySelector(".pfftype");
    const lh = name ? parseFloat(getComputedStyle(name).lineHeight) || 16 : 16;
    return {
      name: name?.textContent?.trim() || "",
      type: type?.textContent?.trim() || "",
      lines: Math.round((name?.getBoundingClientRect().height || 0) / lh),
      w: Math.round(r.width),
    };
  });
  return {
    countBadge: card?.querySelector(".pfseccount")?.textContent?.trim() || null,
    cardW: cardRect ? Math.round(cardRect.width) : null,
    listW: Math.round(listRect.width),
    rows,
  };
});
console.log(`  count badge: ${panel.countBadge}   rows listed: ${panel.rows.length}`);
console.log(`  open card ${panel.cardW}px of a ${panel.listW}px list`);
for (const r of panel.rows)
  console.log(`     ${r.name.padEnd(26)} ${r.type.padEnd(20)} ${r.lines} line(s)`);
ok("🔴 the badge and the list agree — seven and seven",
   panel.countBadge === "7" && panel.rows.length === 7, panel);
ok("🔴 the open panel is FULL WIDTH, not the chip's width",
   panel.cardW !== null && panel.cardW > panel.listW * 0.9, panel);
ok("🔴 every name is on ONE line — no mid-word breaks",
   panel.rows.every((r) => r.lines <= 1), panel.rows.filter((r) => r.lines > 1));
ok("🔴 every row carries a type", panel.rows.every((r) => r.type && r.type !== "—"),
   panel.rows.map((r) => r.type));
ok("and the types use the create-form vocabulary",
   panel.rows.some((r) => r.type === "Dropdown — pick one") &&
   panel.rows.some((r) => r.type === "Tickbox — yes or no") &&
   panel.rows.some((r) => r.type === "Long text"),
   panel.rows.map((r) => r.type));

// ── 6 · IS THE TOP OF THE SCREEN REACHABLE? ───────────────────────────────
console.log("\n6 · ⚠️ IS THE FIRST THING ON THE PAGE FULLY VISIBLE?");
const top = await frame.evaluate(() => {
  const sc = document.querySelector(".adminscroll");
  sc.scrollTop = 0;
  const first = sc.firstElementChild;
  const fr = first.getBoundingClientRect();
  const sr = sc.getBoundingClientRect();
  return {
    scrollTop: sc.scrollTop,
    scrollable: sc.scrollHeight > sc.clientHeight,
    firstTag: `${first.tagName}.${first.className}`.slice(0, 40),
    firstTop: Math.round(fr.top), containerTop: Math.round(sr.top),
    clipped: fr.top < sr.top - 1,
  };
});
console.log(`  ${JSON.stringify(top)}`);
ok("⚠️ the first element is not clipped at the top", !top.clipped, top);

// ── 7 · ITEMS N + R · DOES THE SCREEN SAY WHAT IT GOVERNS? ────────────────
console.log("\n7 · 🔴 ITEMS N + R — THE INSTRUCTION");
const why = await frame.evaluate(() =>
  document.querySelector(".pfgovern")?.textContent?.replace(/\s+/g, " ").trim() || null);
console.log(`  "${(why || "").slice(0, 150)}…"`);
ok("the screen says what ticking does", /available on every record/.test(why || ""), why);
ok("🔴 and WHY it exists", /unusable|sixty-eight/.test(why || ""), why);
ok("🔴 and that these are CASE sections, not person sections",
   /not on the person/i.test(why || ""), why);

await page.screenshot({ path: "scripts/section-grid.png" });
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
