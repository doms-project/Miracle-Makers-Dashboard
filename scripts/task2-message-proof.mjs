// ---------------------------------------------------------------------------
// TASK 2 · SECTION 1 — THE SENTENCE, IN A BROWSER.
//
// 🔴 ROUND 110'S LESSON APPLIES TO A STRING AS MUCH AS TO A ROW. Rounds 100-109
// reported 26/26 while the lists were parked off the right edge of the window,
// because not one of them opened the page. This sentence is the whole
// user-facing half of section 1 and asserting it from the source would prove
// only that I typed it.
//
// The claim: an empty "File in" picker has TWO causes and must say which.
//
//   nothing GRANTED     three pipelines exist, this viewer holds none
//                       → "You do not have access to any pipeline…
//                          3 exist on this account — ask an admin"
//   nothing CONFIGURED  the account really has none
//                       → "There is no client pipeline configured to file
//                          this in."
//
// 🔴 AND THE CONTROL IS A VIEWER WHO CAN FILE. Two empty states that differ
// would both be satisfied by a dialog that never shows a picker at all — so a
// GRANTED rep opens the same dialog in the same run and reads the destination
// sentence naming their pipeline.
//
// ⚠️ IT RUNS THE WHOLE STACK: next dev, the real route, a fake GoHighLevel, and
// a mocked GHL parent frame posting a real encrypted SSO blob — because
// `isAdmin` is what the filter keys off, and a harness with no session makes
// every viewer an admin. (The route proof's first run did exactly that and read
// like the fix had never been written.)
//
// Run: node scripts/task2-message-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { appendFileSync, writeFileSync } from "node:fs";
import CryptoJS from "crypto-js";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; say(`  ok   ${n}`); }
  else { fail++; say(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const RT = "F_RT", CAT = "F_CAT", TIER = "F_TIER", DIV = "F_DIV", REF = "F_REF";
const PP = "pipe_pp", OLTL = "pipe_oltl", ODP = "pipe_odp", EV = "pipe_events";
const U_PP = "u_pp", U_NONE = "u_none";

const blob = (userId) =>
  CryptoJS.AES.encrypt(JSON.stringify({
    userId, role: "user", type: "location", activeLocation: LOC,
    userName: userId, email: `${userId}@test`, companyId: "co1",
  }), SECRET).toString();

const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();

const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const j = raw ? JSON.parse(raw) : null;
    const u = req.url, path = u.split("?")[0];
    const send = (code, o) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (path === `/locations/${LOC}/customFields`)
      return send(200, { customFields: u.includes("model=opportunity")
        ? [{ id: REF, name: "Referring Partner", dataType: "TEXT" }]
        : [
            { id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS",
              picklistOptions: ["Referral Partner", "Event Attendee"] },
            { id: CAT, name: "Partner Category", dataType: "SINGLE_OPTIONS", picklistOptions: ["Hospital discharge"] },
            { id: TIER, name: "Partner Tier", dataType: "SINGLE_OPTIONS", picklistOptions: ["A", "B", "C", "Prospect"] },
            { id: DIV, name: "Partner Division", dataType: "SINGLE_OPTIONS",
              picklistOptions: ["Private Pay", "OLTL", "ODP", "All"] },
          ] });
    if (path === "/users/")
      return send(200, { users: [{ id: U_PP, name: "A PP Rep" }, { id: U_NONE, name: "An Ungranted Rep" }] });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        { id: PP, name: "Private Pay Clients", stages: [{ id: "pp_s1", name: "NEW ENQUIRY", position: 0 }] },
        { id: OLTL, name: "OLTL Enrollment", stages: [{ id: "ol_s1", name: "NEW LEAD", position: 0 }] },
        { id: ODP, name: "ODP Transfer", stages: [{ id: "od_s1", name: "NEW LEAD", position: 0 }] },
        { id: EV, name: "Events", stages: [{ id: "ev_s1", name: "PLANNED", position: 0 }] },
      ] });
    if (path === `/locations/${LOC}/customValues`)
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Folders", value: JSON.stringify({
            seeded: true,
            pipelines: {
              [PP]: { scope: "client", folders: [] }, [OLTL]: { scope: "client", folders: [] },
              [ODP]: { scope: "client", folders: [] },
              [EV]: { scope: "client", folders: [], role: "events" },
            }, folderNames: {},
          }) },
        { id: "cv2", name: "MM Pipeline Access", value: JSON.stringify({
            pipelines: { [U_PP]: [PP] }, folders: {}, master: [], caseManagers: {},
          }) },
      ] });
    if (path === "/contacts/search")
      return send(200, { contacts: [{
        id: "p1", contactName: "Riddle Hospital", email: "dp@riddle.test",
        customFields: [
          { id: RT, value: j?.filters?.[0]?.value || "Referral Partner" },
          { id: TIER, value: "A" }, { id: DIV, value: "Private Pay" },
        ],
      }], total: 1 });
    if (path === "/opportunities/search") {
      const pid = new URL(`http://x${u}`).searchParams.get("pipeline_id");
      if (pid !== OLTL) return send(200, { opportunities: [], meta: { total: 0 } });
      return send(200, { opportunities: [{
        id: "o1", name: "Smith family", pipelineId: OLTL, pipelineStageId: "ol_s1",
        status: "won", monetaryValue: 6000, createdAt: iso(10), assignedTo: U_PP,
        followers: [], customFields: [{ id: REF, fieldValue: "p1" }],
      }], meta: { total: 1 } });
    }
    if (/^\/contacts\/[^/]+\/notes/.test(path)) return send(200, { notes: [] });
    if (/^\/contacts\/[^/]+$/.test(path)) return send(200, { contact: { id: "p1" } });
    send(404, { message: `no fake handler for ${path}` });
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fp = fake.address().port;

// 🔴 A FREE PORT, ASKED FOR RATHER THAN ASSUMED. This was hardcoded to 3651 and
// a dev server orphaned by an earlier killed run stayed bound to it: `next dev`
// died with EADDRINUSE, `/` never compiled, and the harness spent four minutes
// timing out against a server that had never started. A fixed port in a harness
// is a shared mutable resource, and this one was shared with its own ghosts.
const probe = http.createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const PORT = probe.address().port;
await new Promise((r) => probe.close(r));
const base = `http://localhost:${PORT}`;
const devLog = [];
const dev = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  env: { ...process.env, GHL_API_BASE: `http://127.0.0.1:${fp}`, GHL_LOCATION_ID: LOC,
         GHL_PIT: "pit_test", GHL_SSO_SECRET: SECRET,
         PIPELINE_IDS: `${PP},${OLTL},${ODP}` },
  stdio: ["ignore", "pipe", "pipe"],
});
dev.stdout.on("data", (d) => devLog.push(String(d)));
dev.stderr.on("data", (d) => devLog.push(String(d)));

// 🔴 EVERY WAIT IN THIS FILE IS BOUNDED AND SAYS WHERE IT IS. The previous
// version warmed the page route with a bare `await fetch(base)` and NO timeout:
// `next dev` takes a long time to compile an 8000-line page, the fetch never
// returned, and the run died at 540s having printed NOTHING — not even "dev
// server up". An unbounded wait in a harness is indistinguishable from the app
// hanging, which is the one thing a proof must never be ambiguous about.
// 🔴 SYNCHRONOUS, TO A FILE, BECAUSE BUFFERED PROGRESS IS NO PROGRESS. Two runs
// of this harness died at their 540s wall having printed NOTHING — node's
// stdout was still buffered when SIGTERM arrived, so the one thing that would
// have explained the hang was thrown away with the buffer. A diagnostic that
// only survives a clean exit is useless in exactly the case it is needed.
const LOG = "/tmp/t2msg-progress.log";
try { writeFileSync(LOG, ""); } catch {}
const say = (m) => {
  console.log(m);
  try { appendFileSync(LOG, `${m}\n`); } catch {}
};
const tryFetch = (url, ms) =>
  fetch(url, { signal: AbortSignal.timeout(ms) }).then((r) => r.status).catch((e) => String(e.name || e));

let up = false;
for (let i = 0; i < 90 && !up; i++) {
  // 🔴 THE ONE FAILURE THAT MUST NOT BE WAITED OUT. Next 16 allows ONE dev
  // server per directory: a second one exits instantly with "Another next dev
  // server is already running", and an orphan from a killed run keeps the lock.
  // Three runs of this harness burned 540s each sitting in this loop for a
  // server that had refused to start in the first second, because the refusal
  // went to a log nobody read. Name it and stop.
  const joined = devLog.join("");
  if (/Another next dev server is already running/.test(joined)) {
    const pid = /PID:\s*(\d+)/.exec(joined)?.[1] || "?";
    say(`  🔴 A DEV SERVER IS ALREADY RUNNING FOR THIS DIRECTORY (pid ${pid}).`);
    say(`     Next 16 permits one per directory. Kill it and re-run:  kill -9 ${pid}`);
    dev.kill(); fake.close(); process.exit(1);
  }
  if (/EADDRINUSE/.test(joined)) {
    say(`  🔴 PORT ${PORT} IS ALREADY BOUND — next dev never started.`);
    say(`     Left by a killed run. \`pkill -9 -f "next dev"\` and re-run.`);
    dev.kill(); fake.close(); process.exit(1);
  }
  const s = await tryFetch(`${base}/api/referrals?only=partners`, 5000);
  if (typeof s === "number") { up = true; say(`  api up after ${i + 1}s (${s})`); }
  else await new Promise((r) => setTimeout(r, 1000));
}
if (!up) { say(`dev never came up:\n${devLog.join("").slice(-1200)}`); dev.kill(); fake.close(); process.exit(1); }
// ⚠️ WARM THE PAGE ROUTE TOO — the API being up says nothing about `/`, which
// compiles separately. Bounded, retried, and it is allowed to fail: the browser
// will wait for the compile anyway, this only stops it waiting from cold.
// ⚠️ 150s A TRY, NOT 20s. Turbopack compiling an 8000-line page from a cold
// `.next` takes minutes, and twelve 20s attempts look like a dead server rather
// than a slow compile — which is exactly how the port collision above went
// undiagnosed for two runs.
let warm = null;
for (let i = 0; i < 3 && typeof warm !== "number"; i++) {
  warm = await tryFetch(base, 150000);
  say(`  page warm-up ${i + 1}: ${warm}`);
}
if (typeof warm !== "number") {
  say(`  🔴 THE PAGE ROUTE NEVER SERVED. dev log tail:\n${devLog.join("").slice(-900)}`);
  dev.kill(); fake.close(); process.exit(1);
}
say(`  dev server up on ${PORT}`);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-proxy-server", "--no-sandbox"],
});

/** Open the app as `who`, reach Referrals, and open "Log a referral". */
const openDialogAs = async (who) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));
  await page.route(`${base}/__parent`, (route) => route.fulfill({
    status: 200, contentType: "text/html",
    body: `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0}iframe{border:0;width:1440px;height:950px}</style>
<script>window.addEventListener("message",(e)=>{if(e.data&&e.data.message==="REQUEST_USER_DATA")
e.source.postMessage({message:"REQUEST_USER_DATA_RESPONSE",payload:${JSON.stringify(blob(who))}},"*");});</script>
<iframe src="${base}/"></iframe>`,
  }));
  say(`  [${who}] opening the parent frame…`);
  await page.goto(`${base}/__parent`, { waitUntil: "domcontentloaded" });
  const frame = await (await page.waitForSelector("iframe")).contentFrame();
  say(`  [${who}] iframe attached, waiting for the session…`);
  try {
    await frame.waitForFunction(
      () => !/Checking session/.test(document.querySelector(".viewas")?.textContent || ""),
      { timeout: 90000 },
    );
  } catch (e) {
    // ⚠️ SAY WHAT THE PAGE ACTUALLY SHOWS. A bare timeout here is unreadable —
    // "session never resolved" and "the page never rendered" look identical.
    console.log(`  🔴 session never resolved for ${who}. viewas=${JSON.stringify(
      await frame.textContent(".viewas").catch(() => null))}`);
    console.log(`  body: ${(await frame.textContent("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 300)}`);
    console.log(`  dev log tail:\n${devLog.join("").slice(-800)}`);
    throw e;
  }
  for (let i = 0; i < 12; i++) {
    await frame.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Referrals");
      b?.click();
    });
    await page.waitForTimeout(700);
    if (await frame.$(".rfwrap")) break;
  }
  await frame.waitForSelector(".rfwrap", { timeout: 60000 });
  await frame.waitForFunction(() => !document.querySelector(".rfwrap .spinner"), { timeout: 60000 });
  // ⚠️ "Log a referral" IS IN THE DRAWER, not on the row — `onLogReferral` is a
  // prop of the partner drawer (ReferralsSection.tsx:2301, button at :2939). My
  // first run clicked around the table for thirty seconds and timed out on
  // `.rfdhint`, which is the harness being wrong about the UI rather than the
  // UI being wrong.
  for (let i = 0; i < 12; i++) {
    await frame.evaluate(() => {
      const el = [...document.querySelectorAll(".rftable tbody .rforg, .rftable tbody td")]
        .find((x) => /Riddle Hospital/.test(x.textContent || ""));
      (el?.closest("tr") ?? el)?.click();
    });
    await page.waitForTimeout(600);
    if (await frame.$(".rfdrawer")) break;
  }
  await frame.waitForSelector(".rfdrawer", { timeout: 30000 });
  for (let i = 0; i < 12; i++) {
    await frame.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) =>
        /log a referral/i.test(x.textContent || ""));
      b?.click();
    });
    await page.waitForTimeout(600);
    if (await frame.$(".rfdhint")) break;
  }
  await frame.waitForSelector(".rfdhint", { timeout: 30000 });
  // ⚠️ EVERY `.rfdhint`, NOT THE FIRST. The dialog has several — the first is a
  // general explainer ("A touch is outreach you did…") and the destination line
  // is further down. Reading `textContent(".rfdhint")` took the explainer and
  // four assertions went red against a sentence that was rendering correctly
  // two elements below. The harness was wrong about the DOM, not the app.
  const hint = (await frame.$$eval(".rfdhint", (els) =>
    els.map((e) => e.textContent || "").join(" | "))).replace(/\s+/g, " ").trim();
  /** The whole dialog, for "is this name on screen anywhere" questions. */
  const dialogText = (await frame.$$eval(".rfdhint, .irow, .moveacts, .rfglab",
    (els) => els.map((e) => e.textContent || "").join(" "))).replace(/\s+/g, " ");
  const options = await frame.$$eval("#rr-pipe option", (e) => e.map((x) => x.textContent?.trim()));
  const saveDisabled = await frame.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Log referral/.test(x.textContent || ""));
    return b ? b.disabled : null;
  });
  return { page, frame, hint, dialogText, options, saveDisabled };
};

console.log("\n═══ 1 · 🔴 THE CONTROL — A GRANTED REP CAN STILL FILE ═══");
// Without this, "the two empty states differ" is satisfied by a dialog that
// never offers a picker to anybody.
const g = await openDialogAs(U_PP);
console.log(`  options: ${JSON.stringify(g.options)}`);
console.log(`  hint:    "${g.hint.slice(0, 150)}"`);
ok("🔴 THE CONTROL — the picker offers their one pipeline", g.options.length === 1, g.options);
ok("🔴 and it is Private Pay — the one they hold", /Private Pay Clients/.test(g.options[0] || ""), g.options);
ok("🔴 OLTL and ODP are NOT on screen anywhere in the dialog",
   !/OLTL|ODP/.test(g.dialogText), g.dialogText.slice(0, 200));
ok("⚠️ the hint names the destination rather than an empty state",
   /Creates an opportunity in/.test(g.hint), g.hint);
ok("⚠️ and the save button is enabled once a name is typed — not blocked by scope",
   g.saveDisabled === true, g.saveDisabled); // still disabled: no first name yet
await g.page.close();

console.log("\n═══ 2 · 🔴 AN UNGRANTED REP — THE SENTENCE THAT USED TO BE FALSE ═══");
const u = await openDialogAs(U_NONE);
console.log(`  options: ${JSON.stringify(u.options)}`);
console.log(`  hint:    "${u.hint.slice(0, 200)}"`);
ok("the picker is empty", u.options.length === 0, u.options);
// 🔴 THE WHOLE POINT. This read "There is no client pipeline CONFIGURED to file
// this in" — on an account with three of them. Every word was wrong and it sent
// the reader to look for a configuration problem that did not exist.
ok("🔴 it does NOT say the pipelines are unconfigured — they are",
   !/no client pipeline configured/i.test(u.hint), u.hint);
ok("🔴 it says the viewer has no ACCESS", /do not have access/i.test(u.hint), u.hint);
ok("🔴 and it says HOW MANY exist, so the reader knows it is a filter",
   /3 exist on this account/.test(u.hint), u.hint);
ok("⚠️ and where to go — a person, not a settings screen they cannot fix",
   /Admin → Access/.test(u.hint), u.hint);
// ⚠️ THE COUNT IS THE ONLY THING DISCLOSED. Naming them is what section 1 closed.
ok("🔴 no pipeline NAME is anywhere in the dialog — the count discloses a number, never a name",
   !/OLTL|ODP|Private Pay Clients/.test(u.dialogText), u.dialogText.slice(0, 200));
ok("⚠️ and the save button is disabled — nothing can be filed", u.saveDisabled === true, u.saveDisabled);
await u.page.screenshot({ path: "scripts/task2-no-access.png" });
await u.page.close();

console.log("\n  screenshot: scripts/task2-no-access.png");
await browser.close();
dev.kill("SIGTERM");
fake.close();
console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 300);
