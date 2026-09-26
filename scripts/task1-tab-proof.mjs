// ---------------------------------------------------------------------------
// TASK 1 · STEP 3 — THE ACCESS TAB'S CASE-MANAGER SECTION.
//
// 🔴 EVERY CLAIM HERE IS ABOUT A SCREEN, so every assertion reads a rendered
// page. "Both counts are clickable" and "editing works from either side" cannot
// be checked any other way, and the second one is the claim most likely to be
// quietly half-true: two views over one map is exactly the shape where an edit
// made from the wrong end writes to a copy.
//
// ⚠️ AND THE COUNTS CARRY A CONTROL ASSERTION OF THEIR OWN. "They look
// clickable" is meaningless unless something says what a number that is NOT a
// control looks like — so the grid's own count line is measured in the same run
// and the two are required to differ.
//
// Run: npx tsx scripts/task1-tab-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { chromium } from "playwright-core";
import CryptoJS from "crypto-js";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const ADMIN = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u_admin", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Chris Tester", email: "c@e.com", companyId: "co1",
}), SECRET).toString();

// The real ids and names from the brief.
const ERN = "VkvEW5dTHant8jOXAU4r", DARIUS = "RBgFWgr3hpff8ejCQ3zS";
const HAYDEE = "RZZ8IkAYgUzawNDgvcj4", RAYMOND = "9HN9EobwrCV9V7F0lzV7";
const MARC = "UjNG7eBJbdy9BXcvyWvl";
const CARLA = "V0gYK3HpF1Tan7Uv0Jcp", EDMARK = "WiFUXs6SShLwFB0Z5enR";
const ROI = "hptqeBiFG307OqRQBWWF", KIM = "ZcQ068JfdPGp9hhFhyeB";
const MAHAGONY = "E3nlUhAxGjoVHsKdhu2J";
const SPARE = "u_spare";

const USERS = [
  [ERN, "Ern Holden"], [DARIUS, "Darius Boyce"], [HAYDEE, "Haydee Ortiz"],
  [RAYMOND, "Raymond Arcangel"], [MARC, "marc barnes"],
  [CARLA, "Carla Winnigan"], [EDMARK, "Edmark Villanueva"], [ROI, "Roi Navarte"],
  [KIM, "Kimberly Bowen"], [MAHAGONY, "Mahagony Stewart"],
  [SPARE, "Someone Unlisted"], ["u_admin", "Chris Tester"],
];

// 🔴 ROUND 151 — A MANAGER WHO LEFT THE ACCOUNT, still in the map. This is the
// live state on the account today (two departed people are still mapped), and
// it is the branch that rendered a bare twenty-character id in a column of
// people's names. Nothing else in this fixture reaches it.
const GONE = "0IcvXMDmxEToQTM7VZ9w";

const REAL_MAP = {
  [ERN]: [CARLA, EDMARK],
  [DARIUS]: [CARLA, EDMARK],
  [HAYDEE]: [ROI],
  [RAYMOND]: [KIM],
  [MARC]: [MAHAGONY],
};

/** The stored custom value, mutated by the route's own writes. */
let stored = JSON.stringify({
  pipelines: { [ERN]: ["p1"] },
  folders: {},
  master: [],
  caseManagers: REAL_MAP,
  // 🔴 ROUND 162 — a granted division whose pipeline does not exist here. The
  // fixture has one pipeline, "OLTL Enrollment", so "ODP" is an orphan: it is
  // in the stored map and not in the choices the tab derives from pipelines.
  referralAccess: { [SPARE]: { mode: "divisions", divisions: ["ODP"] } },
});
const puts = [];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const j = raw ? JSON.parse(raw) : null;
    const [path] = req.url.split("?");
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (path === "/users/")
      return send(200, { users: USERS.map(([id, name]) => ({
        id, name, email: `${name.split(" ")[0].toLowerCase()}@mm.com`,
        roles: { role: id === "u_admin" ? "admin" : "user" } })) });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [{ id: "p1", name: "OLTL Enrollment",
        stages: [{ id: "p1_s1", name: "NEW LEAD", position: 0 }] }] });
    if (path === `/locations/${LOC}/customValues` && req.method === "GET")
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Access", value: stored },
        { id: "cv2", name: "MM Pipeline Folders", value: JSON.stringify({
          seeded: true, folderNames: {}, pipelines: { p1: { scope: "client", folders: [] } } }) },
      ] });
    if (/^\/locations\/[^/]+\/customValues\/[^/]+$/.test(path) && req.method === "PUT") {
      if (j?.name === "MM Pipeline Access" && j?.value) { puts.push(JSON.parse(j.value)); stored = j.value; }
      return send(200, { customValue: { id: "cv1", value: stored } });
    }
    if (path === `/locations/${LOC}/customFields`) return send(200, { customFields: [] });
    if (path.startsWith("/medias/")) return send(200, { files: [] });
    if (path === "/opportunities/search") return send(200, { opportunities: [], meta: { total: 0 } });
    send(200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const fp = server.address().port;

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
         GHL_PIT: "pit_test", GHL_SSO_SECRET: SECRET, PIPELINE_IDS: "p1" },
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
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(sig, () => { cleanup(); process.exit(130); });
process.on("uncaughtException", (e) => {
  console.log(`\n🔴 ${e.message}\n${e.stack}`); cleanup(); process.exit(1);
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
  console.log(`dev server never came up on ${PORT}:\n${devLog.join("").slice(-1500)}`);
  process.exit(1);
}
console.log(`\n═══ THE ACCESS TAB ═══\n  dev server up on ${PORT}`);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-proxy-server", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));
await page.route(`${base}/__parent`, (route) => route.fulfill({
  status: 200, contentType: "text/html",
  body: `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0}iframe{border:0;width:1440px;height:1100px}</style>
<script>window.addEventListener("message",(e)=>{if(e.data&&e.data.message==="REQUEST_USER_DATA")
e.source.postMessage({message:"REQUEST_USER_DATA_RESPONSE",payload:${JSON.stringify(ADMIN)}},"*");});</script>
<iframe src="${base}/"></iframe>`,
}));
await page.goto(`${base}/__parent`, { waitUntil: "domcontentloaded" });
const frame = await (await page.waitForSelector("iframe")).contentFrame();
await frame.waitForFunction(
  () => !/Checking session/.test(document.querySelector(".viewas")?.textContent || ""),
  { timeout: 90000 },
);
for (let i = 0; i < 12; i++) {
  await frame.evaluate(() => {
    const b = [...document.querySelectorAll("button")]
      .find((x) => /^Access$/i.test((x.textContent || "").trim()));
    b?.click();
  });
  await page.waitForTimeout(500);
  if (await frame.$(".cmhead")) break;
}
await frame.waitForSelector(".cmhead", { timeout: 60000 });
await page.waitForTimeout(400);

// ⚠️ ROUND 162 — THE ROW SELECTORS ARE SCOPED TO `.cmlist`, AND THEY WERE NOT.
// `.cmrow:not(.cmnew)` addressed rows across the WHOLE document, which was true
// until a second section on the same tab used the same class: this file started
// counting 17 rows instead of 5. The product was fixed too (that section now has
// its own classes), but an unscoped selector is a latent version of the same
// break, so it is scoped here as well — a proof should not depend on a class
// being unique everywhere.
const shape = () => frame.evaluate(() => {
  const rows = [...document.querySelectorAll(".cmlist .cmrow:not(.cmnew)")].map((r) => ({
    who: r.querySelector(".cmwho")?.textContent?.trim(),
    chips: [...r.querySelectorAll(".cmchip")].map((c) => c.textContent.replace(/×\s*$/, "").trim()),
  }));
  const counts = [...document.querySelectorAll(".cmcount")].map((b) => ({
    text: b.textContent.trim(),
    tag: b.tagName,
    pressed: b.getAttribute("aria-pressed"),
    bg: getComputedStyle(b).backgroundColor,
    cursor: getComputedStyle(b).cursor,
    border: getComputedStyle(b).borderTopWidth,
  }));
  // ⚠️ THE CONTROL: the grid's own count line — a number that is JUST a number.
  const plain = document.querySelector(".pacount, .imeta");
  return {
    rows, counts,
    plainCursor: plain ? getComputedStyle(plain).cursor : null,
    all: document.querySelector(".cmlist")?.textContent || "",
    head: document.querySelector(".cmhead")?.textContent || "",
  };
});

console.log("\n1 · 🔴 THE HEADER, AND THE COUNTS ARE CONTROLS");
let v = await shape();
console.log(`  head: ${JSON.stringify(v.head)}`);
console.log(`  counts: ${JSON.stringify(v.counts)}`);
ok("it reads “5 managers · 5 reps”",
   /5\s*managers/.test(v.head) && /5\s*reps/.test(v.head), v.head);
ok("🔴 both counts are real buttons", v.counts.length === 2 && v.counts.every((c) => c.tag === "BUTTON"), v.counts);
ok("⚠️ exactly one is pressed", v.counts.filter((c) => c.pressed === "true").length === 1, v.counts);
ok("🔴 THE CONTROL — they do not look like a number that is just a number",
   v.counts.every((c) => c.cursor === "pointer") && v.plainCursor !== "pointer",
   { counts: v.counts.map((c) => c.cursor), plain: v.plainCursor });
ok("⚠️ and the pressed one is visually distinct from the other",
   v.counts[0].bg !== v.counts[1].bg, v.counts.map((c) => c.bg));

console.log("\n2 · ⚠️ MANAGER-FIRST — ROWS FROM THE LIVE USER LIST, BY NAME");
console.log(`  ${JSON.stringify(v.rows)}`);
ok("five manager rows", v.rows.length === 5, v.rows.length);
const carlaRow = v.rows.find((r) => r.who === "Carla Winnigan");
ok("🔴 Carla's row lists BOTH her reps, by name and not by id",
   carlaRow && carlaRow.chips.sort().join("|") === "Darius Boyce|Ern Holden", carlaRow);
ok("⚠️ no id leaked into the screen", !/VkvEW5dTHant8jOXAU4r|V0gYK3HpF1Tan7Uv0Jcp/.test(v.all), v.all.slice(0, 200));
ok("🔴 no role labels and no warnings anywhere in the section",
   !/\brep\b(?!s\b)|manager of|no manager|not mapped|sees nothing|⚠/i.test(
     v.all.replace(/\+ rep|\+ manager/g, "")), v.all.slice(0, 300));
ok("⚠️ and there is no “add manager” BUTTON outside the new-row control",
   (await frame.evaluate(() =>
     [...document.querySelectorAll(".cmrow:not(.cmnew) .cmadd")]
       .every((b) => /\+ rep/.test(b.textContent)))), "a row offers + manager");

console.log("\n3 · 🔴 FLIP TO REP-FIRST — SAME DATA, READ FROM THE OTHER END");
await frame.evaluate(() => {
  const b = [...document.querySelectorAll(".cmcount")].find((x) => /reps?$/.test(x.textContent.trim()));
  b?.click();
});
await page.waitForTimeout(300);
v = await shape();
console.log(`  ${JSON.stringify(v.rows)}`);
ok("five rep rows now", v.rows.length === 5, v.rows.length);
const ernRow = v.rows.find((r) => r.who === "Ern Holden");
ok("🔴 Ern's row lists both his managers",
   ernRow && ernRow.chips.sort().join("|") === "Carla Winnigan|Edmark Villanueva", ernRow);
ok("⚠️ and the pressed control moved with it",
   v.counts.find((c) => /reps?$/.test(c.text))?.pressed === "true", v.counts);

console.log("\n4 · 🔴 EDIT FROM ONE END, READ IT FROM THE OTHER");
// Remove Carla from Ern's row here, in REP-first…
await frame.evaluate(() => {
  const row = [...document.querySelectorAll(".cmrow")]
    .find((r) => r.querySelector(".cmwho")?.textContent?.trim() === "Ern Holden");
  const chip = [...row.querySelectorAll(".cmchip")]
    .find((c) => /Carla Winnigan/.test(c.textContent));
  chip.querySelector(".cmx").click();
});
await page.waitForTimeout(250);
v = await shape();
const ernAfter = v.rows.find((r) => r.who === "Ern Holden");
ok("Carla is off Ern's row", ernAfter && !ernAfter.chips.includes("Carla Winnigan"), ernAfter);
ok("⚠️ Edmark is untouched", ernAfter?.chips.includes("Edmark Villanueva"), ernAfter);
// …and read it back in MANAGER-first.
await frame.evaluate(() => {
  const b = [...document.querySelectorAll(".cmcount")].find((x) => /managers?$/.test(x.textContent.trim()));
  b?.click();
});
await page.waitForTimeout(300);
v = await shape();
const carlaAfter = v.rows.find((r) => r.who === "Carla Winnigan");
console.log(`  Carla now: ${JSON.stringify(carlaAfter)}`);
ok("🔴 THE SAME WRITE — Ern is gone from Carla's row, with no second edit",
   carlaAfter && !carlaAfter.chips.includes("Ern Holden"), carlaAfter);
ok("⚠️ and Darius is still hers", carlaAfter?.chips.includes("Darius Boyce"), carlaAfter);

console.log("\n5 · ⚠️ ADDING FROM THIS END WRITES THE SAME MAP");
await frame.evaluate(() => {
  const row = [...document.querySelectorAll(".cmrow")]
    .find((r) => r.querySelector(".cmwho")?.textContent?.trim() === "Carla Winnigan");
  row.querySelector(".cmadd").click();
});
await frame.waitForSelector(".cmpick", { timeout: 10000 });
const offered = await frame.evaluate(() =>
  [...document.querySelectorAll(".cmpick .cmpickname")].map((n) => n.textContent.trim()));
console.log(`  the picker offers ${offered.length}: ${JSON.stringify(offered.slice(0, 4))}…`);
ok("🔴 it offers EVERYONE — no role filter, because roles are not data",
   offered.includes("Someone Unlisted") && offered.includes("Kimberly Bowen"), offered);
ok("⚠️ minus the row's own subject and who is already on it",
   !offered.includes("Carla Winnigan") && !offered.includes("Darius Boyce"), offered);
await frame.evaluate(() => {
  const b = [...document.querySelectorAll(".cmpick .cmpickrow")]
    .find((x) => /Haydee Ortiz/.test(x.textContent));
  b.click();
});
await page.waitForTimeout(250);
v = await shape();
ok("Haydee is now one of Carla's reps",
   v.rows.find((r) => r.who === "Carla Winnigan")?.chips.includes("Haydee Ortiz"), v.rows);

console.log("\n6 · 🔴 SAVE — AND THE MAP THAT LANDS IS THE ONE ON SCREEN");
const before = puts.length;
await frame.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /Save changes/i.test(x.textContent || ""));
  b?.click();
});
await frame.waitForFunction(
  () => /Saved to GoHighLevel|✗/.test(document.body.textContent || ""), { timeout: 30000 });
await page.waitForTimeout(300);
const put = puts[before];
console.log(`  stored caseManagers: ${JSON.stringify(put?.caseManagers)}`);
ok("a write was sent", !!put, puts.length);
ok("🔴 Ern lost Carla and kept Edmark", put?.caseManagers?.[ERN]?.join() === EDMARK, put?.caseManagers?.[ERN]);
ok("🔴 Haydee now has TWO managers — Roi and Carla",
   [...(put?.caseManagers?.[HAYDEE] || [])].sort().join() === [ROI, CARLA].sort().join(),
   put?.caseManagers?.[HAYDEE]);
ok("🔴 AND THE OTHER THREE KEYS SURVIVED — the round-135 fix, on the real screen",
   JSON.stringify(put?.pipelines) === JSON.stringify({ [ERN]: ["p1"] }) &&
   JSON.stringify(put?.folders) === "{}" && JSON.stringify(put?.master) === "[]",
   { p: put?.pipelines, f: put?.folders, m: put?.master });

console.log("\n7 · ⚠️ REMOVING THE LAST REP TAKES THE ROW AWAY");
// marc barnes is Mahagony's only rep.
await frame.evaluate(() => {
  const row = [...document.querySelectorAll(".cmrow")]
    .find((r) => r.querySelector(".cmwho")?.textContent?.trim() === "Mahagony Stewart");
  row.querySelector(".cmchip .cmx").click();
});
await page.waitForTimeout(250);
v = await shape();
console.log(`  head now: ${JSON.stringify(v.head)}`);
ok("🔴 Mahagony is no longer a manager — the row is gone",
   !v.rows.some((r) => r.who === "Mahagony Stewart"), v.rows.map((r) => r.who));
ok("⚠️ and the count says four", /4\s*managers/.test(v.head), v.head);

console.log("\n8 · 🔴 STARTING A ROW FROM NOTHING — TWO PICKS, ONE WRITE");
// ⚠️ THE PATH I REWROTE MID-BUILD, so it is the likeliest to be wrong. A row
// needs both halves before the map can hold it; a half-made row must exist only
// on screen and must never be written.
await frame.evaluate(() => {
  document.querySelector(".cmrow.cmnew .cmadd")?.click();
});
await frame.waitForSelector(".cmpick", { timeout: 10000 });
const newOffers = await frame.evaluate(() =>
  [...document.querySelectorAll(".cmpick .cmpickname")].map((n) => n.textContent.trim()));
ok("⚠️ it does not offer somebody who is already a manager",
   !newOffers.includes("Carla Winnigan") && newOffers.includes("Someone Unlisted"), newOffers);
await frame.evaluate(() => {
  const b = [...document.querySelectorAll(".cmpick .cmpickrow")]
    .find((x) => /Someone Unlisted/.test(x.textContent));
  b.click();
});
await page.waitForTimeout(250);
let mid = await frame.evaluate(() => ({
  rows: [...document.querySelectorAll(".cmlist .cmrow:not(.cmnew)")].map((r) => r.querySelector(".cmwho")?.textContent?.trim()),
  pickerOpen: !!document.querySelector(".cmpick"),
  head: document.querySelector(".cmhead")?.textContent || "",
}));
console.log(`  after the first pick: ${JSON.stringify(mid)}`);
ok("🔴 the half-made row is ON SCREEN", mid.rows.includes("Someone Unlisted"), mid.rows);
ok("🔴 with its second picker already open — one continuous action", mid.pickerOpen, mid);
ok("⚠️ AND THE COUNT HAS NOT MOVED — nothing is in the map yet",
   /4\s*managers/.test(mid.head), mid.head);
// Abandon it: the row must vanish rather than persist as an empty manager.
await frame.evaluate(() => {
  const b = [...document.querySelectorAll(".cmpick button")].find((x) => /Cancel/.test(x.textContent));
  b?.click();
});
await page.waitForTimeout(200);
mid = await frame.evaluate(() => ({
  rows: [...document.querySelectorAll(".cmlist .cmrow:not(.cmnew)")].map((r) => r.querySelector(".cmwho")?.textContent?.trim()),
}));
ok("🔴 cancelling takes the half-made row away — no empty manager is left behind",
   !mid.rows.includes("Someone Unlisted"), mid.rows);
// And do it for real.
await frame.evaluate(() => { document.querySelector(".cmrow.cmnew .cmadd")?.click(); });
await frame.waitForSelector(".cmpick", { timeout: 10000 });
await frame.evaluate(() => {
  [...document.querySelectorAll(".cmpick .cmpickrow")].find((x) => /Someone Unlisted/.test(x.textContent))?.click();
});
await page.waitForTimeout(200);
await frame.evaluate(() => {
  [...document.querySelectorAll(".cmpick .cmpickrow")].find((x) => /marc barnes/.test(x.textContent))?.click();
});
await page.waitForTimeout(250);
v = await shape();
console.log(`  head now: ${JSON.stringify(v.head)}`);
ok("🔴 the second pick makes it a real row", 
   v.rows.find((r) => r.who === "Someone Unlisted")?.chips.includes("marc barnes"), v.rows);
ok("⚠️ and the count moves only now", /5\s*managers/.test(v.head), v.head);

console.log("\n10 · 🔴 ROUND 162 — A GRANTED DIVISION WITH NO PIPELINE IS STILL SHOWN");
// 🔴 The choices come from the live pipelines, so a division whose pipeline was
// renamed falls out of that list while staying in the stored map. The GRANT is
// safe — the save sends the state object, not a re-derivation — but the SCREEN
// was not: no chip, and no "none selected" hint either, so the row read as
// "Divisions, nothing ticked" for somebody who really was seeing ODP referrals.
const rfa = await frame.evaluate(() => {
  const row = [...document.querySelectorAll(".rfarow")]
    .find((r) => /Someone Unlisted/.test(r.querySelector(".rfawho")?.textContent || ""));
  return {
    chips: [...(row?.querySelectorAll(".rfachip") || [])].map((c) => c.textContent.trim()),
    onChips: [...(row?.querySelectorAll(".rfachip.on") || [])].map((c) => c.textContent.trim()),
    hint: row?.textContent?.includes("none selected") || false,
  };
});
console.log(`  chips: ${JSON.stringify(rfa.chips)}`);
ok("🔴 the orphaned division is ON SCREEN, not silently absent",
   rfa.chips.some((c) => /^ODP/.test(c)), rfa.chips);
ok("🔴 and marked as having no pipeline, so it reads as a fact not a typo",
   rfa.chips.some((c) => /ODP — no pipeline/.test(c)), rfa.chips);
ok("🔴 it is TICKED — it is a live grant, not an offer",
   rfa.onChips.some((c) => /^ODP/.test(c)), rfa.onChips);
// ⚠️ THE CONTROL: the row must not ALSO claim they see nothing. That sentence
// beside a live grant is the contradiction this fix exists to remove.
ok("⚠️ THE CONTROL — and it does NOT say 'none selected'", !rfa.hint, rfa);

console.log("\n9 · 🔴 ROUND 151 — A DEPARTED MANAGER IS NOT A BARE ID");
// ⚠️ THE STALE ENTRY ARRIVES HERE, NOT IN THE FIXTURE, AND THAT IS A MISTAKE I
// MADE AND UNDID. Seeding it into REAL_MAP added a fifth manager and shifted
// every count assertion in sections 7 and 8 by one — six correct assertions
// went red because the FIXTURE had moved under them, which is round 148's rule
// 5 arriving from the other direction. Injected after those have run instead,
// by rewriting the stored value and reloading the tab.
stored = JSON.stringify({
  ...JSON.parse(stored),
  caseManagers: { ...JSON.parse(stored).caseManagers, [SPARE]: [GONE] },
});
await page.reload({ waitUntil: "domcontentloaded" });
const frame9 = await (await page.waitForSelector("iframe")).contentFrame();
await frame9.waitForFunction(
  () => !/Checking session/.test(document.querySelector(".viewas")?.textContent || ""),
  { timeout: 90000 },
);
for (let i = 0; i < 12; i++) {
  await frame9.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((x) => /^Access$/i.test((x.textContent || "").trim()))?.click();
  });
  await page.waitForTimeout(500);
  if (await frame9.$(".cmhead")) break;
}
await frame9.waitForSelector(".cmhead", { timeout: 60000 });
await page.waitForTimeout(400);
// 🔴 IN THE BROWSER, NOT IN A UNIT ASSERTION. The complaint was about what is
// on screen, and `nameOf` falling back to the raw id is only visible once a row
// renders. Every other row here resolves to a person's name, which is exactly
// what made a twenty-character token in the same column read as a fault.
const ids = await frame9.evaluate(() =>
  [...document.querySelectorAll(".cmwho, .cmof")].map((r) => r.textContent?.trim() || ""));
console.log(`  rows: ${JSON.stringify(ids)}`);
// ⚠️ THE PROPERTY, NOT THE SENTENCE — a GHL id is 20 chars of [A-Za-z0-9], and
// what must hold is that no cell IS one, not how the replacement is worded.
const bare = ids.filter((t) => /^[A-Za-z0-9]{20}$/.test(t));
ok("🔴 NOT ONE cell on the tab is a bare id", bare.length === 0, bare);
ok("🔴 the departed manager renders as a person-shaped label",
   ids.some((t) => /Former user/.test(t)), ids);
// ⚠️ THE CONTROL. Without this, the assertion above passes on a tab that has
// stopped rendering the stale row at all — which would be worse than the id,
// because the entry would be invisible AND unremovable.
ok("🔴 THE CONTROL — and the id is still THERE, so it can still be removed",
   ids.some((t) => t.includes(GONE)), ids);

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
