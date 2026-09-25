// ---------------------------------------------------------------------------
// ROUND 152 — THE RELATIONS 504 STORM, AND THE BADGE THAT LIED.
//
// 🔴 THIS NEEDS A BROWSER AND THERE IS NO WAY AROUND IT. The finding is "the
// same ids are requested again while the first request is still in flight",
// and that is not readable from source: it is what the effect DOES when a
// response is slow and the user scrolls. The assertion is a REQUEST COUNT.
//
// Two things are under test and they are different failures:
//
//   1. the multiplier   an id in flight was in neither `relCounts` nor any
//                       other set, so every re-render asked for it again.
//                       13,851 timeouts in two minutes.
//   2. the lying badge  an id the server could not read was recorded as
//                       {caregivers:0, clients:0} — "no links" — and the
//                       recorded zero meant it was never asked about again.
//
// ⚠️ THE FAKE DELAYS THE RELATIONS READ ON PURPOSE. A fast fake cannot show
// either bug: the first is only visible while a request is outstanding, and a
// harness that answers instantly is a harness not in the production shape.
//
// Run: node scripts/relations-counts-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { chromium } from "playwright-core";
import CryptoJS from "crypto-js";

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const PIPE = "pipe_oltl";
const ASSOC = "assoc_caregiver";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const BLOB = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Chris Tester", email: "chris@example.com", companyId: "co1",
}), SECRET).toString();

// 30 rows: more than one screen, so scrolling brings new ids in and the
// in-flight set has something to be wrong about.
const N = 30;
const CASES = Array.from({ length: N }, (_, i) => ({
  id: `o${i + 1}`,
  name: `Client ${i + 1}`,
  pipelineId: PIPE,
  pipelineStageId: "s1",
  status: "open",
  assignedTo: "u1",
  createdAt: new Date(Date.now() - i * 86400000).toISOString(),
  contact: { id: `c${i + 1}`, firstName: "Client", lastName: `${i + 1}` },
}));

// 🔴 THE THREE STATES, ONE CONTACT EACH — because the whole point is that they
// must not render the same.
const HAS_LINKS = "c1";   // two real relations
const ZERO_LINKS = "c2";  // read fine, genuinely nothing — must stay blank
const FAILS = "c3";       // the read throws — must NOT become a zero

let relDelayMs = 0;
/** Every /associations/relations/{id} the route asked the fake for. */
const relReads = [];

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
      return send(200, { users: [{ id: "u1", name: "Chris Tester" }] });
    if (u.startsWith("/opportunities/pipelines"))
      return send(200, { pipelines: [{ id: PIPE, name: "OLTL Enrollment",
        stages: [{ id: "s1", name: "NEW LEAD", position: 0 }] }] });
    if (u.startsWith(`/locations/${LOC}/customValues`))
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({ seeded: true,
          pipelines: { [PIPE]: { scope: "client", folders: [] } }, folderNames: {} }) }] });
    if (u.startsWith("/opportunities/search"))
      return send(200, { opportunities: CASES, meta: { total: CASES.length } });
    if (u === "/contacts/search") return send(200, { contacts: [], total: 0 });

    const rel = /^\/associations\/relations\/([^/?]+)/.exec(u);
    if (rel) {
      const cid = decodeURIComponent(rel[1]);
      relReads.push(cid);
      const answer = () => {
        // 🔴 ONE CONTACT'S READ FAILS. The route catches per id, and before
        // this round that catch was empty — the id simply vanished from
        // `counts` and the client turned the absence into a zero.
        if (cid === FAILS) return send(500, { message: "upstream exploded" });
        if (cid === HAS_LINKS)
          return send(200, { relations: [
            { associationId: ASSOC, firstRecordId: "cg_a", secondRecordId: cid },
            { associationId: ASSOC, firstRecordId: "cg_b", secondRecordId: cid },
          ] });
        return send(200, { relations: [] });
      };
      // ⚠️ THE DELAY IS THE HARNESS BEING IN THE PRODUCTION SHAPE. Both bugs
      // live in the window between asking and answering.
      if (relDelayMs) return setTimeout(answer, relDelayMs);
      return answer();
    }
    if (u.startsWith("/associations")) return send(200, { associations: [] });
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
         GHL_PIT: "pit_test", GHL_SSO_SECRET: SECRET, PIPELINE_IDS: PIPE,
         CAREGIVER_ASSOCIATION_ID: ASSOC },
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

/** 🔴 THE MEASUREMENT: every batch the browser posted, and what it asked for. */
const batches = [];
page.on("request", (r) => {
  if (!r.url().includes("/api/relations/counts")) return;
  let ids = [];
  try { ids = JSON.parse(r.postData() || "{}").contactIds || []; } catch { /* ignore */ }
  batches.push(ids);
});
/** How many separate batches asked about this contact. */
const timesAsked = (cid) => batches.filter((b) => b.includes(cid)).length;

await page.route(`${base}/__parent`, (route) => route.fulfill({
  status: 200, contentType: "text/html",
  body: `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0}iframe{border:0;width:1440px;height:950px}</style>
<script>window.addEventListener("message",(e)=>{if(e.data&&e.data.message==="REQUEST_USER_DATA")
e.source.postMessage({message:"REQUEST_USER_DATA_RESPONSE",payload:${JSON.stringify(BLOB)}},"*");});</script>
<iframe src="${base}/"></iframe>`,
}));

// ═══ 1 · THE MULTIPLIER ════════════════════════════════════════════════════
// A four-second relations read, and a user scrolling through it. Every scroll
// changes `onScreenIds` and re-runs the effect; before this round each of those
// re-runs posted the SAME ids again, because nothing recorded that they were
// already being asked about.
relDelayMs = 4000;

await page.goto(`${base}/__parent`, { waitUntil: "domcontentloaded" });
const frame = await (await page.waitForSelector("iframe")).contentFrame();
await frame.waitForFunction(
  () => !/Checking session/.test(document.querySelector(".viewas")?.textContent || ""),
  { timeout: 90000 },
);
await frame.waitForSelector("[data-cid]", { timeout: 60000 });

// ⚠️ FIND THE REAL SCROLLER RATHER THAN NAMING A CLASS. My first version
// scrolled `.scroll`, which is not the element that overflows here — so nothing
// moved, five rows were ever on screen, and section 1 passed having made ONE
// request. The control below is what caught it; the assertion on its own was
// green on a page that had barely asked for anything.
const scrollTo = (y) => {
  const row = document.querySelector("[data-cid]");
  let el = row?.parentElement;
  while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
  (el || document.scrollingElement).scrollTop = y;
};

console.log("\n═══ 1 · 🔴 AN ID IN FLIGHT IS NOT ASKED FOR TWICE ═══");
console.log(`  rows rendered: ${await frame.evaluate(() => document.querySelectorAll("[data-cid]").length)}`);
// Scroll hard while the first batch is still outstanding.
for (let i = 0; i < 8; i++) {
  await frame.evaluate(scrollTo, i * 260);
  await page.waitForTimeout(220);
}
await page.waitForTimeout(6000); // let the 4s batch land

const dupes = [...new Set(batches.flat())].filter((id) => timesAsked(id) > 1);
console.log(`  batches: ${batches.length}  sizes: ${JSON.stringify(batches.map((b) => b.length))}`);
console.log(`  ids asked more than once: ${JSON.stringify(dupes)}`);
ok("🔴 NOT ONE contact was asked about twice while a request was in flight",
   dupes.length === 0, dupes);
// ⚠️ THE CONTROL. Without this the assertion above passes on a page that never
// asked for anything at all — which is exactly what a broken effect looks like.
ok("🔴 THE CONTROL — it did ask, and for the rows that were on screen",
   batches.length > 0 && batches.flat().length >= 10,
   { batches: batches.length, total: batches.flat().length });
ok("⚠️ and every id it asked about reached the fake",
   batches.flat().every((id) => relReads.includes(id)),
   { asked: batches.flat().length, read: relReads.length });

// ═══ 2 · THE THREE STATES ══════════════════════════════════════════════════
console.log("\n═══ 2 · 🔴 A FAILED READ IS NOT A ZERO ═══");
const badgeOf = (cid) => frame.evaluate((c) => {
  const row = document.querySelector(`[data-cid="${c}"]`);
  return row?.querySelector(".rellink")?.textContent?.trim()
      ?? (row?.textContent?.includes("links unknown") ? "links unknown" : "");
}, cid);

const bHas = await badgeOf(HAS_LINKS);
const bZero = await badgeOf(ZERO_LINKS);
const bFail = await badgeOf(FAILS);
console.log(`  ${HAS_LINKS} (2 links): ${JSON.stringify(bHas)}`);
console.log(`  ${ZERO_LINKS} (0 links): ${JSON.stringify(bZero)}`);
console.log(`  ${FAILS} (read failed): ${JSON.stringify(bFail)}`);

ok("🔴 the contact whose read FAILED says so rather than showing nothing",
   /links unknown/.test(bFail), bFail);
// 🔴 THE CONTROL THAT MAKES IT MEAN SOMETHING. If "links unknown" appeared on
// every row, the assertion above would pass while the badge had stopped
// distinguishing anything at all — and a real zero would be slandered as a
// failure, which is the same fault in the other direction.
ok("🔴 THE CONTROL — a genuine zero stays blank, it is NOT called unknown",
   !/links unknown/.test(bZero), bZero);
ok("⚠️ and a contact with links still shows its count",
   /2 caregivers|2 clients/.test(bHas), bHas);

console.log("\n═══ 3 · 🔴 AND AN UNKNOWN IS NOT RE-ASKED FOR EVER ═══");
// Recording nothing on failure WAS the loop: the ids stayed un-recorded, so the
// next render asked again. An explicit unknown is the brake as well as the
// truth, and this is the half that proves the brake.
const askedBefore = timesAsked(FAILS);
for (let i = 0; i < 6; i++) {
  await frame.evaluate(scrollTo, 1800 - i * 280);
  await page.waitForTimeout(250);
}
await page.waitForTimeout(1500);
console.log(`  ${FAILS} asked ${askedBefore} time(s) before, ${timesAsked(FAILS)} after scrolling back`);
ok("🔴 the failed contact is NOT re-requested once its unknown is recorded",
   timesAsked(FAILS) === askedBefore, { before: askedBefore, after: timesAsked(FAILS) });
ok("⚠️ nor is the one that came back zero", timesAsked(ZERO_LINKS) === 1,
   timesAsked(ZERO_LINKS));

// ═══ 4 · 🔴 THE 504 ITSELF — THE WHOLE REQUEST FAILING ════════════════════
//
// ⚠️ SECTIONS 1-3 NEVER REACHED THE CLIENT'S CATCH, and I only found that by
// reverting it and watching nothing go red. A per-id upstream failure still
// answers 200 with the id named in `unknown`, so it travels the SUCCESS path.
// The catch is for the OTHER failure — the one that was actually happening:
// the route itself 504ing, with no answer for anyone in the batch.
//
// Driven by failing the route at the browser, which is the production symptom
// exactly. Sections 1-3 in this same run are its control: the same page, the
// same fixture, resolving normally when the route answers.
console.log("\n═══ 4 · 🔴 A 504 RECORDS `unknown`, NOT NOTHING ═══");
await page.route("**/api/relations/counts", (route) =>
  route.fulfill({ status: 504, contentType: "text/html", body: "<html>gateway timeout</html>" }));
batches.length = 0;
await page.goto(`${base}/__parent`, { waitUntil: "domcontentloaded" });
const frame4 = await (await page.waitForSelector("iframe")).contentFrame();
await frame4.waitForFunction(
  () => !/Checking session/.test(document.querySelector(".viewas")?.textContent || ""),
  { timeout: 90000 },
);
await frame4.waitForSelector("[data-cid]", { timeout: 60000 });
await page.waitForTimeout(2500);
const after504 = await frame4.evaluate((c) => {
  const row = document.querySelector(`[data-cid="${c}"]`);
  return row?.querySelector(".rellink")?.textContent?.trim() ?? "";
}, HAS_LINKS);
const asked504 = timesAsked(HAS_LINKS);
// Scroll about, which before this round would have re-fired for ever.
for (let i = 0; i < 6; i++) {
  await frame4.evaluate(scrollTo, i * 300);
  await page.waitForTimeout(250);
}
await page.waitForTimeout(1500);
console.log(`  badge after the 504: ${JSON.stringify(after504)}`);
console.log(`  asked ${asked504} time(s), then ${timesAsked(HAS_LINKS)} after scrolling`);
ok("🔴 a 504 leaves the badge saying unknown, not blank and not a zero",
   /links unknown/.test(after504), after504);
ok("🔴 AND THE LOOP IS BRAKED — the failed ids are not asked for again",
   timesAsked(HAS_LINKS) === asked504, { before: asked504, after: timesAsked(HAS_LINKS) });
// ⚠️ THE CONTROL for the brake: scrolling DID bring new rows in, so the run
// above is not "nothing happened".
ok("⚠️ THE CONTROL — scrolling did reach rows that had never been asked about",
   batches.flat().length > asked504 * 2, { total: batches.flat().length });

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
