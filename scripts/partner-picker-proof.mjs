// ---------------------------------------------------------------------------
// ROUND 112 · ITEM 6 — "PICK AN EXISTING CONTACT" RENDERS NO RESULTS.
//
// 🔴 THE MARKUP AND THE CSS ARE BOTH FINE. The picker has all three states
// (Searching… / no matches / the hits), every class it uses is defined, and
// nothing is positioned off-screen. So reading cannot tell me why the screen is
// blank — round 108 is exactly this mistake — and this drives the real control
// in a real browser instead.
//
// It reports, at each step, WHAT IS ON SCREEN and WHAT WENT OVER THE WIRE:
//   · does clicking the radio actually change mode?
//   · does typing fire a request, and with what?
//   · what does /api/referrals?only=contacts answer?
//   · what is drawn — a list, a hint, or genuinely nothing?
//
// Run: node scripts/partner-picker-proof.mjs
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

// ── 1 · OPEN THE DIALOG ────────────────────────────────────────────────────
console.log("\n1 · THE DIALOG OPENS");
await frame.click('button:has-text("Add partner")');
await frame.waitForSelector(".addbox", { timeout: 15000 });
const modes = await frame.$$eval(".rfmode label", (e) =>
  e.map((x) => x.textContent.trim()));
console.log(`  mode options: ${JSON.stringify(modes)}`);
ok("both modes are offered", modes.length === 2, modes);

// ── 2 · 🔴 DOES THE RADIO ACTUALLY SWITCH MODE? ───────────────────────────
console.log("\n2 · 🔴 CLICKING 'Pick an existing contact'");
// ⚠️ Neither radio has a `name`, so they are not a group in the HTML sense.
// Whether that matters is exactly what this step measures rather than assumes.
const names = await frame.$$eval(".rfmode input[type=radio]", (e) =>
  e.map((x) => ({ name: x.name || null, checked: x.checked })));
console.log(`  radios before: ${JSON.stringify(names)}`);
await frame.click('.rfmode label:has-text("Pick an existing contact") input');
await page.waitForTimeout(500);
const after = await frame.$$eval(".rfmode input[type=radio]", (e) =>
  e.map((x) => x.checked));
const findBox = await frame.$("#rf-find");
console.log(`  radios after:  ${JSON.stringify(after)}   #rf-find present: ${!!findBox}`);
ok("🔴 the mode actually switched — the search box exists", !!findBox, { after });
ok("the radios are a group (share a name)",
   names.every((n) => n.name), names);

if (!findBox) {
  console.log("\n  🔴 STOPPING: mode never switched, so nothing downstream can be measured.");
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); cleanup(); process.exit(1);
}

// ── 3 · TYPE, AND SEE WHAT IS DRAWN ────────────────────────────────────────
console.log("\n3 · 🔴 TYPING 'Riddle' — WHAT APPEARS?");
await frame.fill("#rf-find", "Riddle");
await page.waitForTimeout(2500); // 300ms debounce + the round trip
const drawn = await frame.evaluate(() => {
  const box = document.querySelector(".rfhits");
  // ⚠️ SCOPED TO THE PICKER. The first `.rfdhint` on the page is the Tier
  // explainer further down the form, so an unscoped read reported the wrong
  // sentence and made step 3 look like it had found a hint when it had not.
  const hint = document.querySelector(".rfhits .rfdhint");
  const r = box?.getBoundingClientRect();
  return {
    rfhitsExists: !!box,
    rfhitsBox: r ? { w: Math.round(r.width), h: Math.round(r.height),
                     x: Math.round(r.x), y: Math.round(r.y) } : null,
    hitCount: document.querySelectorAll(".rfhit").length,
    hitNames: [...document.querySelectorAll(".rfhit .n")].map((n) => n.textContent),
    hintText: hint?.textContent?.trim().replace(/\s+/g, " ").slice(0, 140) || null,
  };
});
console.log(`  ${JSON.stringify(drawn, null, 0)}`);
console.log(`  /api/referrals?only=contacts responses: ${JSON.stringify(searchReqs)}`);
console.log(`  GHL /contacts/search bodies: ${JSON.stringify(ghlCalls.map((c) => c.body))}`);

ok("🔴 a request actually went out", searchReqs.length > 0, searchReqs);
ok("🔴 the route answered 200", searchReqs.every((r) => r.status === 200), searchReqs);
ok("🔴 GoHighLevel was asked with the typed text",
   ghlCalls.some((c) => c.body?.query === "Riddle"), ghlCalls.map((c) => c.body));
ok("🔴 SOMETHING IS ON SCREEN — a list or a sentence, never silence",
   drawn.hitCount > 0 || !!drawn.hintText, drawn);
ok("🔴 THREE MATCHING CONTACTS ARE DRAWN", drawn.hitCount === 3, drawn);
ok("and they are the right three",
   JSON.stringify(drawn.hitNames) ===
     JSON.stringify(["Riddle Hospital", "Riddle Memorial Rehab", "Joan Riddle"]),
   drawn.hitNames);
ok("the list is ON SCREEN with real dimensions",
   !!drawn.rfhitsBox && drawn.rfhitsBox.w > 0 && drawn.rfhitsBox.h > 0,
   drawn.rfhitsBox);

// ── 4 · A QUERY THAT MATCHES NOTHING MUST SAY SO ───────────────────────────
console.log("\n4 · A QUERY THAT MATCHES NOTHING");
await frame.fill("#rf-find", "zzzzz");
await page.waitForTimeout(2500);
const none = await frame.evaluate(() => ({
  hits: document.querySelectorAll(".rfhit").length,
  hint: document.querySelector(".rfhits .rfdhint")?.textContent?.trim().replace(/\s+/g, " ") || null,
}));
console.log(`  ${JSON.stringify(none)}`);
ok("no rows", none.hits === 0, none);
ok("🔴 and it SAYS no matches rather than going blank",
   /No contact matches/.test(none.hint || ""), none);

// ── 5 · A FAILED SEARCH MUST SAY SO TOO ────────────────────────────────────
console.log("\n5 · 🔴 WHEN THE SEARCH ITSELF FAILS");
await page.route("**/api/referrals?only=contacts*", (route) =>
  route.fulfill({ status: 500, contentType: "application/json",
    body: JSON.stringify({ error: "GoHighLevel is unavailable.", status: 500 }) }));
await frame.fill("#rf-find", "Riddle again");
await page.waitForTimeout(2500);
const failed = await frame.evaluate(() => ({
  hits: document.querySelectorAll(".rfhit").length,
  hint: document.querySelector(".rfhits .rfdhint")?.textContent?.trim().replace(/\s+/g, " ") || null,
}));
console.log(`  ${JSON.stringify(failed)}`);
ok("🔴 a failed search is NAMED, not silently 'no matches'",
   /could not|couldn|failed|unavailable/i.test(failed.hint || ""), failed);

// ── 5b · ROUND 113 ITEM H · PROMOTE MUST NOT RE-ASK FOR THE CONTACT ───────
console.log("\n5b · 🔴 ITEM H — PICKING A CONTACT, THEN WHAT IS ASKED FOR");
await page.unroute("**/api/referrals?only=contacts*");
await frame.fill("#rf-find", "Riddle");
await page.waitForTimeout(2500);
await frame.click(".rfhits .rfhit");           // choose Riddle Hospital
await page.waitForTimeout(400);
const promote = await frame.evaluate(() => {
  const box = document.querySelector(".addbox");
  const body = box.querySelector(".movebody");
  const ids = [...box.querySelectorAll("input[id],select[id],textarea[id]")].map((e) => e.id);
  const last = box.querySelector(".movebody > *:last-child");
  const lb = last?.getBoundingClientRect();
  const bb = body.getBoundingClientRect();
  body.scrollTop = body.scrollHeight;
  const after = last?.getBoundingClientRect();
  return {
    confirmed: !!box.querySelector(".rfpicked"),
    fields: ids,
    scrollable: body.scrollHeight > body.clientHeight + 1,
    lastReachable: !!after && after.bottom <= bb.bottom + 2,
  };
});
console.log(`  ${JSON.stringify(promote)}`);
ok("the confirmation is shown", promote.confirmed, promote);
ok("🔴 first name, last name, email and phone are NOT asked for",
   !promote.fields.some((f) => /rf-(first|last|email|phone)$/.test(f)), promote.fields);
ok("🔴 but the PARTNER fields still are",
   ["rf-cat", "rf-tier", "rf-div"].every((f) => promote.fields.includes(f)),
   promote.fields);
ok("🔴 and the modal reaches its end — Notes is not past the fold",
   promote.lastReachable, promote);

// ── 6 · THE DRAWER — ITEMS 2, 3 AND 4 ─────────────────────────────────────
console.log("\n6 · 🔴 THE ATTRIBUTED CASES — NAMED, EDITABLE, REACHABLE");
await frame.click('.addbox .previewhead .x');
await page.waitForTimeout(400);
await frame.click('.rftable tbody tr:first-child');
await frame.waitForSelector(".rfdrawer", { timeout: 15000 });
await frame.waitForSelector(".rfopp", { timeout: 15000 });
const rows = await frame.$$eval(".rfopp", (els) =>
  els.map((el) => ({
    name: el.querySelector(".rfoppname")?.textContent?.trim() || "",
    stat: el.querySelector(".rfoppstat")?.textContent?.trim() || "",
    hasEdit: !!el.querySelector("button"),
  })));
console.log(`  ${rows.length} rows; first three:`);
for (const r of rows.slice(0, 3)) console.log(`    ${r.name}  |  ${r.stat}`);
ok("🔴 ITEM 4 — every row is NAMED, not just dated",
   rows.length > 0 && rows.every((r) => r.name && !/^\d+d ago$/.test(r.name)), rows.slice(0, 3));
ok("the won case still shows its value",
   rows.some((r) => /won/.test(r.stat) && /5,?500/.test(r.stat)), rows.map((r) => r.stat));
ok("every row offers an edit control", rows.every((r) => r.hasEdit), rows.slice(0, 2));

// 🔴 ITEM 4's LAST ⚠️ — DOES THE DRAWER SCROLL TO ITS END?
const reach = await frame.evaluate(() => {
  const bd = document.querySelector(".rfdbd");
  bd.scrollTop = bd.scrollHeight;
  const rows = document.querySelectorAll(".rfopp");
  const last = rows[rows.length - 1];
  const lb = last.getBoundingClientRect();
  const cb = bd.getBoundingClientRect();
  return {
    scrollable: bd.scrollHeight > bd.clientHeight,
    lastBottom: Math.round(lb.bottom), containerBottom: Math.round(cb.bottom),
    fullyVisible: lb.bottom <= cb.bottom + 1 && lb.top >= cb.top - 1,
  };
});
console.log(`  ${JSON.stringify(reach)}`);
ok("🔴 the last attributed row is fully reachable, not cut off",
   reach.fullyVisible, reach);

// ── 7 · ITEMS 2 + 3 · THE CONTROLS OPEN AND CARRY THE WARNING ─────────────
console.log("\n7 · 🔴 THE VALUE AND STATUS CONTROLS");
// 🔴 NOT "the first button in the row" — round 120's item 3 added the case NAME
// as a button, so a positional selector started clicking THAT, which opens the
// record panel and drops a scrim over everything the rest of this proof clicks.
// The edit control is `.linkbtn`; name it.
await frame.$eval(".rfopp:first-child .linkbtn", (e) => e.click());
await page.waitForTimeout(400);
const edit = await frame.evaluate(() => {
  const box = document.querySelector(".rfoppedit");
  if (!box) return null;
  const r = box.getBoundingClientRect();
  return {
    w: Math.round(r.width), h: Math.round(r.height),
    hasValue: !!box.querySelector('input[type="number"]'),
    statuses: [...(box.querySelectorAll("select option") || [])].map((o) => o.value),
    warn: box.querySelector(".rfdhint")?.textContent?.trim().replace(/\s+/g, " ") || null,
  };
});
console.log(`  ${JSON.stringify(edit)}`);
ok("🔴 ITEM 2 — a monthly-value input appears", !!edit?.hasValue, edit);
ok("🔴 ITEM 3 — status is beside it, with the four native values",
   JSON.stringify(edit?.statuses) === JSON.stringify(["open","won","lost","abandoned"]),
   edit?.statuses);
ok("the controls are ON SCREEN", !!edit && edit.w > 0 && edit.h > 0, edit);
ok("🔴 and it SAYS revenue counts won only",
   /count(s)? .*won.* only|counts <?b?>?won/.test(edit?.warn || "") ||
     /won/.test(edit?.warn || ""), edit?.warn);

// ── 8 · ROUND 115c ITEM 4 · ATTRIBUTE AN EXISTING LEAD ────────────────────
console.log("\n8 · 🔴 ITEM 4 — CREDIT AN EXISTING CASE, CREATING NOTHING");
/** Every write the browser makes, so "nothing is created" is checkable. */
const writes = [];
page.on("request", (r) => {
  if (["POST", "PUT", "PATCH"].includes(r.method()) && r.url().includes("/api/"))
    writes.push({ m: r.method(), u: r.url().split("/api/")[1].split("?")[0],
                  // ⚠️ NOT TRUNCATED. The ssoKey blob is ~250 chars on its own,
                  // so a 220-char slice cut the body off before `customFields`
                  // and the assertion failed on a request that was correct.
                  body: r.postData() || "" });
});
await frame.click(".rfdrawer .x");
await page.waitForTimeout(400);
await frame.click('.rftable tbody tr:first-child');
await frame.waitForSelector(".rfdrawer", { timeout: 15000 });
await frame.click('.rfdrawer button:has-text("Log a referral")');
await frame.waitForSelector(".movebox", { timeout: 15000 });

const rrModes = await frame.$$eval(".movebox .rfmode label", (e) =>
  e.map((x) => x.textContent.trim()));
console.log(`  modes offered: ${JSON.stringify(rrModes)}`);
ok("🔴 an existing-lead path is offered",
   rrModes.some((m) => /already in GoHighLevel/i.test(m)), rrModes);

await frame.click('.movebox .rfmode label:has-text("already in GoHighLevel") input');
await page.waitForTimeout(400);
const asks = await frame.$$eval(".movebox input[id],.movebox select[id],.movebox textarea[id]",
  (e) => e.map((x) => x.id));
console.log(`  fields now asked for: ${JSON.stringify(asks)}`);
ok("🔴 it stops asking for a name, phone and value",
   !asks.some((f) => /^rr-(first|last|phone|value|note|pipe)$/.test(f)), asks);
ok("and it asks for a contact instead", asks.includes("rr-find"), asks);

await frame.fill("#rr-find", "Michelle");
await page.waitForTimeout(2500);
await frame.click(".movebox .rfhits .rfhit");
await page.waitForTimeout(2000);
const cases = await frame.$$eval(".movebox .rfhits .rfhit", (e) =>
  e.map((x) => x.textContent.replace(/\s+/g, " ").trim()));
console.log(`  their cases: ${cases.length}`);
for (const c of cases.slice(0, 3)) console.log(`     ${c.slice(0, 80)}`);
ok("🔴 their existing cases are listed", cases.length > 0, cases.length);
ok("🔴 and one already credited to this partner SAYS so",
   cases.some((c) => /already credited/i.test(c)), cases.slice(0, 3));

writes.length = 0; // only count what the attribution itself sends
await frame.click(".movebox .rfhits .rfhit");
await page.waitForTimeout(300);
await frame.click('.moveacts button:has-text("Credit this case")');
await page.waitForTimeout(2000);
console.log(`  writes sent: ${writes.map((w) => `${w.m} ${w.u}`).join(", ")}`);
console.log(`  body (ssoKey elided): ${(writes[0]?.body || "")
  .replace(/"ssoKey":"[^"]*"/, '"ssoKey":"…"')}`);
ok("🔴 EXACTLY ONE write", writes.length === 1, writes);
// 🔴 PATCH, NOT PUT — round 121, item 2. This assertion read "a PUT to an
// opportunity" and PASSED, against a fake that answered any method; the real
// route exports PATCH only, so the write it was proving 405'd in production.
// The assertion proved the harness.
ok("🔴 and it is a PATCH to an opportunity, not a create",
   writes[0]?.m === "PATCH" && /^opportunities\//.test(writes[0]?.u || ""), writes[0]);
ok("🔴 carrying only the Referring Partner field",
   /customFields/.test(writes[0]?.body || "") &&
   !/firstName|lastName|action/.test(writes[0]?.body || ""), writes[0]?.body);

await page.screenshot({ path: "scripts/partner-picker.png" });
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
