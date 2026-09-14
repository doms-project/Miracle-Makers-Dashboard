// ---------------------------------------------------------------------------
// ROUND 125 — THE SEARCH-FAILED MESSAGE IS SLICED IN HALF, AND THE ✕ SITS ON
// THE MODAL'S EDGE.
//
// 🔴 BOTH ARE GEOMETRY, SO BOTH ARE MEASURED BEFORE ANYTHING IS CHANGED.
// Reading the CSS produced a plausible cause on the first pass, and a plausible
// cause is what round 108 cost a whole round. This drives the real dialog,
// forces the contact search to FAIL, and prints pixel positions.
//
// ⚠️ THE FIXTURE MAKES THE SEARCH FAIL ON PURPOSE. The message this round is
// about exists only on that path — a fixture that always succeeds can never
// draw it, which is why no proof had ever seen it.
//
// Run: node scripts/round125-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
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

let FAIL_SEARCH = true;

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
      // 🔴 THE FREE-TEXT SEARCH FAILS — that is the whole point of this file.
      // GoHighLevel 500s, apiFetch turns it into "…Check your connection, then
      // reload.", and the dialog renders the warning this round is about.
      if (j?.query) {
        if (FAIL_SEARCH) return send(500, { message: "upstream error" });
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


// ── OPEN "Log a referral" ON A PARTNER, AND SWITCH TO THE EXISTING PATH ────
console.log("\n0 · GETTING TO THE CONTROL");
await frame.click('.rftable tbody tr:first-child');
await frame.waitForSelector(".rfdrawer", { timeout: 20000 });
await frame.click('.rfdrawer button:has-text("Log a referral")');
await frame.waitForSelector(".movebox.rfmodal", { timeout: 20000 });
await frame.click('.movebox .rfmode label:has-text("already in GoHighLevel") input');
await page.waitForTimeout(350);
await frame.fill("#rr-find", "tes");
await frame.waitForSelector(".rfsearchfail", { timeout: 20000 });
await page.waitForTimeout(500);

/** Everything this round is about, in one read. */
const shape = () => frame.evaluate(() => {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom),
             left: Math.round(r.left), right: Math.round(r.right),
             w: Math.round(r.width), h: Math.round(r.height) };
  };
  const modal = document.querySelector(".movebox.rfmodal");
  const head = modal?.querySelector(".previewhead");
  const x = head?.querySelector(".x");
  const body = modal?.querySelector(".movebody");
  const acts = modal?.querySelector(".moveacts");
  const input = document.querySelector("#rr-find");
  const hits = document.querySelector(".rfhits");
  const err = document.querySelector(".rfsearchfail");
  const hs = hits ? getComputedStyle(hits) : null;
  // 🔴 THE GENERAL PROPERTY, not "is it inside .rfhits". Walk up to the nearest
  // ancestor that CLIPS, and ask whether the message starts inside it. That
  // survives the markup moving and is the actual rule being broken.
  let clipper = null;
  for (let el = err?.parentElement; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.overflowY !== "visible" || cs.overflowX !== "visible") { clipper = el; break; }
  }
  const headCs = head ? getComputedStyle(head) : null;
  // The LAST thing drawn in the body, so the gap before the footer is real.
  const kids = body ? [...body.children] : [];
  const last = kids.length ? kids[kids.length - 1] : null;
  return {
    modal: box(modal), head: box(head), x: box(x), body: box(body), acts: box(acts),
    input: box(input), hits: box(hits), err: box(err), last: box(last),
    lastClass: last?.className || null,
    headPadRight: headCs ? parseFloat(headCs.paddingRight) : null,
    hitsOverflow: hs ? hs.overflowY : null,
    errMarginTop: err ? parseFloat(getComputedStyle(err).marginTop) : null,
    text: (err?.textContent || "").replace(/\s+/g, " ").trim(),
    clipper: clipper ? { cls: clipper.className || clipper.tagName, ...box(clipper) } : null,
  };
});

const s = await shape();
console.log(`  modal   ${JSON.stringify(s.modal)}`);
console.log(`  header  ${JSON.stringify(s.head)}  padding-right ${s.headPadRight}`);
console.log(`  ✕       ${JSON.stringify(s.x)}`);
console.log(`  input   ${JSON.stringify(s.input)}`);
console.log(`  .rfhits ${JSON.stringify(s.hits)}  overflow-y:${s.hitsOverflow}`);
console.log(`  message ${JSON.stringify(s.err)}  margin-top ${s.errMarginTop}`);
console.log(`  last    ${s.lastClass} ${JSON.stringify(s.last)}`);
console.log(`  footer  ${JSON.stringify(s.acts)}`);
console.log(`  text    "${s.text}"`);

// ═══ 1 · THE MESSAGE MUST BE WHOLE ════════════════════════════════════════
console.log("\n1 · 🔴 THE FIRST LINE WAS CUT THROUGH THE MIDDLE");
// 🔴 THE MECHANISM, MEASURED: a NEGATIVE top margin on a child of a container
// with overflow-y:auto. The child's top sits above the container's content box,
// and an overflow container cannot paint above its own box — so the first line
// is clipped, not scrolled to.
console.log(`  nearest clipping ancestor: ${JSON.stringify(s.clipper)}`);
ok("🔴 the message starts at or below whatever clips it",
   s.err && s.clipper && s.err.top >= s.clipper.top - 1,
   { err: s.err?.top, clipper: s.clipper?.top, cls: s.clipper?.cls });
ok("🔴 and below the input that sits above it",
   s.err && s.input && s.err.top >= s.input.bottom - 1, { err: s.err?.top, input: s.input?.bottom });
ok("⚠️ its top margin is not negative — that is what pulled it under the input",
   (s.errMarginTop ?? 0) >= 0, s.errMarginTop);
// Whole, not merely positioned: the rendered height must fit the text.
ok("and ends inside it too — the whole sentence is drawn",
   s.err && s.clipper && s.err.bottom <= s.clipper.bottom + 1,
   { err: s.err?.bottom, clipper: s.clipper?.bottom });
// ⚠️ AND IT IS NO LONGER IN THE SCROLLING HIT LIST AT ALL. A one-line state
// that can scroll is a one-line state that can be scrolled out of view.
ok("🔴 the failure is not inside the scrolling hit list",
   !s.hits || !(s.err.top >= s.hits.top && s.err.bottom <= s.hits.bottom) || s.hits.h === 0,
   { hits: s.hits, err: s.err });
ok("🔴 and it says the part that matters — do not switch to New enquiry",
   /Do not switch to New enquiry/i.test(s.text), s.text);
// ⚠️ TWO FULL STOPS. apiFetch's message ends "…then reload." and the sentence
// here appended another one.
ok("⚠️ and there is no double full stop", !/\.\./.test(s.text), s.text);

// ═══ 2 · THE GAP BELOW ════════════════════════════════════════════════════
console.log("\n2 · ⚠️ A LARGE EMPTY GAP SAT BELOW IT WHILE THE MESSAGE WAS SQUEEZED");
const gap = s.acts && s.last ? s.acts.top - s.last.bottom : null;
console.log(`  gap between the last content and the footer: ${gap}px`);
ok("the body does not leave a large empty band above the footer",
   gap !== null && gap <= 40, gap);

// ═══ 3 · THE CLOSE BUTTON ═════════════════════════════════════════════════
console.log("\n3 · 🔴 THE ✕ SAT ON THE MODAL'S RIGHT EDGE");
const inset = s.modal && s.x ? s.modal.right - s.x.right : null;
console.log(`  distance from the modal's right edge to the ✕: ${inset}px`);
console.log(`  the header's own right padding: ${s.headPadRight}px`);
ok("🔴 the ✕ is inside the modal, not on its border", inset !== null && inset > 0, inset);
ok("⚠️ and inside the header's 22px padding, which round 120 set",
   inset !== null && inset >= s.headPadRight - 1, { inset, pad: s.headPadRight });
ok("it is not clipped — its full width is drawn", s.x && s.x.w >= 26, s.x);

await page.screenshot({ path: "scripts/round125-searchfail.png" });
console.log("\n  screenshot: scripts/round125-searchfail.png");

// ═══ 4 · THE TWO I COULD NOT REPRODUCE — LOOKED FOR WHERE THEY WOULD DIFFER ══
console.log("\n4 · ⚠️ THE SAME DIALOG IN A SHORT, NARROW FRAME");
// 🔴 THE LIVE DASHBOARD IS A GOHIGHLEVEL CUSTOM PAGE IFRAME, which is routinely
// narrower and much shorter than 1440x950. `.movebox` is max-height:90vh, so a
// short frame is exactly where a body would start scrolling and a header would
// start competing for width. If the gap and the clipped ✕ are real, this is
// where they show — and if they do not show here either, that is worth saying
// plainly rather than implying I looked everywhere.
await page.setViewportSize({ width: 1040, height: 620 });
await page.evaluate(() => {
  const f = document.querySelector("iframe");
  if (f) { f.style.width = "1040px"; f.style.height = "620px"; }
});
await page.waitForTimeout(700);
const n = await shape();
console.log(`  modal   ${JSON.stringify(n.modal)}`);
console.log(`  ✕       ${JSON.stringify(n.x)}  inset ${n.modal && n.x ? n.modal.right - n.x.right : "?"}px`);
console.log(`  message ${JSON.stringify(n.err)}`);
console.log(`  body    ${JSON.stringify(n.body)}  footer ${JSON.stringify(n.acts)}`);
const nGap = n.acts && n.last ? n.acts.top - n.last.bottom : null;
console.log(`  gap     ${nGap}px`);
ok("🔴 the message is still whole in a short frame",
   n.err && n.clipper && n.err.top >= n.clipper.top - 1,
   { err: n.err?.top, clipper: n.clipper?.top });
ok("🔴 the ✕ is still inside the modal",
   n.modal && n.x && n.modal.right - n.x.right >= n.headPadRight - 1,
   { inset: n.modal && n.x ? n.modal.right - n.x.right : null, pad: n.headPadRight });
ok("and the body still leaves no empty band above the footer",
   nGap !== null && nGap <= 40, nGap);
await page.screenshot({ path: "scripts/round125-narrow.png" });
console.log("  screenshot: scripts/round125-narrow.png");

// ═══ 5 · THE SWEEP RULE MUST ACTUALLY FIRE ═══════════════════════════════
console.log("\n5 · 🔴 A RULE THAT CATCHES NOTHING IS NOT A RULE");
// ⚠️ THREE ROUNDS RUNNING I HAVE SHIPPED A CHECK THAT COULD NOT MATCH THE SHAPE
// IT POLICED (`ghlSend<[^>]*>`, `encodeURIComponent([^)]*)`, `/^Events\b/`).
// So this puts the OLD shape back, runs the sweep for real, and asserts it goes
// red — then restores the file. try/finally, because leaving the tree patched
// would be far worse than a failed assertion.
const TARGET = "components/ReferralsSection.tsx";
const good = readFileSync(TARGET, "utf8");
let swept = "";
try {
  // The pre-125 shape: a one-line hint as the FIRST child of the scrolling list.
  writeFileSync(
    TARGET,
    good.replace(
      '<div className="rfhits">\n                      {hits.map((h) => (',
      '<div className="rfhits">\n                      <div className="rfdhint">Searching…</div>\n                      {hits.map((h) => (',
    ),
  );
  swept = execSync("node scripts/loader-sweep.mjs || true", { encoding: "utf8" });
} finally {
  writeFileSync(TARGET, good);
}
const fired = /NEGATIVE TOP MARGIN INSIDE A CONTAINER THAT CLIPS/.test(swept);
console.log(`  sweep on the old shape: ${fired ? "RED — the rule fires" : "clean — the rule is blind"}`);
ok("🔴 the new sweep rule goes red on the shape this round fixed", fired, swept.slice(-300));
const nowClean = execSync("node scripts/loader-sweep.mjs || true", { encoding: "utf8" });
ok("⚠️ and clean on the fixed tree — no false positive on the intended use",
   !/NEGATIVE TOP MARGIN/.test(nowClean), nowClean.slice(-300));

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
