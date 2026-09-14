// ---------------------------------------------------------------------------
// ROUND 122 · ANALYSIS 104 · 17 / 18 / 19 — THE ACCESSIBILITY GROUP.
//
// 🔴 THE ONE ITEM THIS ROUND THAT NEEDS A BROWSER. Escape, focus movement and
// whether a control can be reached by Tab are not readable from source: they
// are what the DOM does when a key is pressed.
//
// Run: node scripts/a11y-proof.mjs
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


// ── 18 · THE DIVISION SWITCHER'S ARIA ─────────────────────────────────────
console.log("\n18 · 🔴 THE SWITCHER'S ARIA — THE BRIEF'S CENTREPIECE");
const aria = await frame.evaluate(() => {
  const btn = document.querySelector(".rfdiv");
  return {
    haspopup: btn?.getAttribute("aria-haspopup"),
    expanded: btn?.getAttribute("aria-expanded"),
    controls: btn?.getAttribute("aria-controls"),
  };
});
console.log(`  button: ${JSON.stringify(aria)}`);
// ⚠️ `listbox` PLUS `aria-expanded` DESCRIBES A COMBOBOX, and a combobox owes
// its listbox an aria-controls and an active option. This had neither.
ok("🔴 it no longer claims to be a combobox", aria.haspopup !== "listbox", aria);
ok("and it points at the thing it opens", !!aria.controls, aria);

await frame.click(".rfdiv");
await page.waitForTimeout(300);
const menu = await frame.evaluate(() => {
  const pop = document.querySelector(".rfdivpop");
  const items = [...(pop?.querySelectorAll("[role]") || [])].map((e) => ({
    tag: e.tagName,
    role: e.getAttribute("role"),
    checked: e.getAttribute("aria-checked"),
    focusable: e.tagName === "BUTTON" || e.hasAttribute("tabindex"),
  }));
  return { id: pop?.id, role: pop?.getAttribute("role"), items };
});
console.log(`  popup: role=${menu.role} id=${menu.id}`);
for (const i of menu.items)
  console.log(`    ${i.tag} role=${i.role} checked=${i.checked} focusable=${i.focusable}`);
ok("the popup id matches aria-controls", menu.id === aria.controls, [menu.id, aria.controls]);
// 🔴 THE ROLE MUST BE ON THE FOCUSABLE ELEMENT. It sat on the <li> while the
// <button> inside was the reachable thing — so the element a keyboard lands on
// had no role, and the element with the role could not be reached.
ok("🔴 every role sits on a FOCUSABLE element",
   menu.items.length > 0 && menu.items.every((i) => i.focusable), menu.items);
ok("and exactly one is marked current",
   menu.items.filter((i) => i.checked === "true").length === 1, menu.items);
await frame.click(".rfdiv");
await page.waitForTimeout(200);

// ── 19 · KEYBOARD REACH ───────────────────────────────────────────────────
console.log("\n19 · 🔴 THE SORTABLE HEADERS AND ROWS ARE REACHABLE");
const reach = await frame.evaluate(() => {
  const ths = [...document.querySelectorAll(".rftable thead th")];
  const rows = [...document.querySelectorAll(".rftable tbody tr")];
  return {
    headers: ths.map((t) => ({
      text: t.textContent.trim().slice(0, 14),
      tabindex: t.getAttribute("tabindex"),
      sort: t.getAttribute("aria-sort"),
    })),
    rowFocusable: rows.length ? rows[0].getAttribute("tabindex") === "0" : null,
    rowRole: rows.length ? rows[0].getAttribute("role") : null,
  };
});
for (const h of reach.headers)
  console.log(`  ${h.text.padEnd(16)} tabindex=${h.tabindex} aria-sort=${h.sort}`);
ok("🔴 every sortable header is in the tab order",
   reach.headers.every((h) => h.tabindex === "0"), reach.headers);
// ⚠️ aria-sort IS THE OTHER HALF: without it a screen reader can operate the
// control and cannot hear what it did.
ok("⚠️ and each announces its sort state",
   reach.headers.every((h) => ["ascending", "descending", "none"].includes(h.sort)),
   reach.headers);
ok("exactly one header is sorted at a time",
   reach.headers.filter((h) => h.sort !== "none").length === 1, reach.headers);
ok("🔴 the clickable row is reachable too", reach.rowFocusable === true, reach);
ok("and describes itself as a button, not a link", reach.rowRole === "button", reach);

console.log("\n  …and Enter on a header actually sorts:");
const before = await frame.$eval('.rftable thead th[aria-sort]:not([aria-sort="none"])', (e) => e.textContent.trim());
await frame.$eval('.rftable thead th:nth-child(2)', (e) => e.focus());
await page.keyboard.press("Enter");
await page.waitForTimeout(300);
const after = await frame.$eval('.rftable thead th[aria-sort]:not([aria-sort="none"])', (e) => e.textContent.trim());
console.log(`  sorted by "${before}" → "${after}"`);
ok("🔴 Enter on a focused header changes the sort", before !== after, [before, after]);

// ── 17 · THE DRAWER: FOCUS IN, ESCAPE OUT, FOCUS BACK ────────────────────
console.log("\n17 · 🔴 THE DRAWER TAKES FOCUS, ESCAPE CLOSES IT, FOCUS COMES BACK");
await frame.$eval(".rftable tbody tr:first-child", (e) => e.focus());
const opener = await frame.evaluate(() => document.activeElement?.tagName + ":" + (document.activeElement?.getAttribute("aria-label") || ""));
console.log(`  focus before opening: ${opener}`);
await page.keyboard.press("Enter");
await frame.waitForSelector(".rfdrawer", { timeout: 15000 });
await page.waitForTimeout(400);
const inside = await frame.evaluate(() => {
  const d = document.querySelector(".rfdrawer");
  return {
    modal: d?.getAttribute("aria-modal"),
    hasFocus: !!d && (d === document.activeElement || d.contains(document.activeElement)),
    active: document.activeElement?.className || document.activeElement?.tagName,
  };
});
console.log(`  aria-modal=${inside.modal} · focus inside=${inside.hasFocus} (${inside.active})`);
// 🔴 aria-modal WAS ALREADY A PROMISE THE COMPONENT DID NOT KEEP.
ok("🔴 focus moved INTO the drawer", inside.hasFocus, inside);
ok("and it still declares itself modal", inside.modal === "true", inside);

await page.keyboard.press("Escape");
await page.waitForTimeout(400);
const closed = await frame.evaluate(() => !document.querySelector(".rfdrawer"));
ok("🔴 Escape closes it", closed, "still open");
const returned = await frame.evaluate(() => document.activeElement?.tagName + ":" + (document.activeElement?.getAttribute("aria-label") || ""));
console.log(`  focus after closing: ${returned}`);
// ⚠️ RETURNING IT IS THE HALF PEOPLE FORGET — dropping focus at the document
// root sends a keyboard user back to the top of the page.
ok("⚠️ and focus came back to the row that opened it", returned === opener, [opener, returned]);

console.log(`\n${pass} passed, ${fail} failed.`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
