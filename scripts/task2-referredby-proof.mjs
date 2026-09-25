// ---------------------------------------------------------------------------
// ROUND 148 — "No referral partners exist yet" ON AN ACCOUNT WITH TWO.
//
// 🔴 THIS IS A CONSUMER-SIDE PROOF ON PURPOSE, AND THE REASON IS THE DEFECT.
// The route has sent `withheld` on `?only=partners` since task 2 · §4. A proof
// that asserted the payload carries it WOULD HAVE PASSED FOR TWO ROUNDS while
// the screen said the opposite — because nothing read it. The only assertion
// that could have caught this is one that reads the rendered sentence.
//
// The picker lives on the client record panel, so this drives the whole stack:
// next dev, the real routes, a fake GoHighLevel, and a mocked GHL parent frame
// posting a real encrypted SSO blob.
//
// 🔴 THE CONTROL IS AN ADMIN OPENING THE SAME RECORD IN THE SAME RUN. "The
// picker says nothing is in scope" is satisfied by a picker that renders
// nothing at all, or by a page that failed — so a viewer who SHOULD see the
// partners has to see them, against the same fixture, differing only in who is
// looking. That is the `a11y` lesson, third application.
//
// Run: node scripts/task2-referredby-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { appendFileSync, writeFileSync, rmSync } from "node:fs";
import CryptoJS from "crypto-js";

const LOG = "/tmp/t2refby-progress.log";
try { writeFileSync(LOG, ""); } catch {}
let pass = 0, fail = 0;
const say = (m) => { console.log(m); try { appendFileSync(LOG, `${m}\n`); } catch {} };
const ok = (n, c, got) => {
  if (c) { pass++; say(`  ok   ${n}`); }
  else { fail++; say(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const RT = "F_RT", TIER = "F_TIER", DIV = "F_DIV", REF = "GE6Wj9WhrUVc2ZGwxqLP";
const PP = "pipe_pp", OLTL = "pipe_oltl";
const U_NONE = "u_none", U_ADMIN = "u_admin";

const blob = (userId, role = "user") =>
  CryptoJS.AES.encrypt(JSON.stringify({
    userId, role, type: "location", activeLocation: LOC,
    userName: userId, email: `${userId}@test`, companyId: "co1",
  }), SECRET).toString();

// 🔴 THE CASE IS FOLLOWED BY THE UNGRANTED VIEWER, which is the whole reason
// they can open it at all — applyAccess admits an owned-or-followed record from
// ANY pipeline. It is also the live shape: a case manager holds no pipeline and
// reaches work exactly this way.
const OPP = {
  id: "o1", name: "Smith family", pipelineId: OLTL, pipelineStageId: "ol_s1",
  status: "open", assignedTo: "u_rep", followers: [U_NONE],
  updatedAt: "2026-09-01T10:00:00.000Z", customFields: [],
};
const CONTACT = {
  id: "c1", contactName: "Mary Smith", firstName: "Mary", lastName: "Smith",
  email: "mary@test.example", phone: "+16105550100",
  dateUpdated: "2026-09-01T10:00:00.000Z", customFields: [],
};

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const j = raw ? JSON.parse(raw) : null;
    const [path, qs] = req.url.split("?");
    const q = new URLSearchParams(qs || "");
    const send = (code, o) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };

    if (path === `/locations/${LOC}/customFields`)
      return send(200, { customFields: q.get("model") === "opportunity"
        ? [{ id: REF, name: "Referring Partner", dataType: "TEXT" }]
        : [
            { id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS",
              picklistOptions: ["Referral Partner", "Event Attendee"] },
            { id: TIER, name: "Partner Tier", dataType: "SINGLE_OPTIONS",
              picklistOptions: ["A", "B", "C", "Prospect"] },
            { id: DIV, name: "Partner Division", dataType: "SINGLE_OPTIONS",
              picklistOptions: ["Private Pay", "OLTL", "ODP", "All"] },
          ] });
    if (path === "/users/")
      return send(200, { users: [
        { id: U_NONE, name: "A Case Manager" }, { id: U_ADMIN, name: "An Admin" },
        { id: "u_rep", name: "A Rep" },
      ] });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        { id: OLTL, name: "OLTL Enrollment", stages: [{ id: "ol_s1", name: "NEW LEAD", position: 0 }] },
        { id: PP, name: "Private Pay Clients", stages: [{ id: "pp_s1", name: "NEW ENQUIRY", position: 0 }] },
      ] });
    if (path === `/locations/${LOC}/customValues`)
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Folders", value: JSON.stringify({
            seeded: true, folderNames: {},
            pipelines: { [OLTL]: { scope: "client", folders: [] }, [PP]: { scope: "client", folders: [] } },
          }) },
        // 🔴 u_none HOLDS NOTHING. The admin is not in the map either — they
        // bypass it by role, which is the live shape for both.
        { id: "cv2", name: "MM Pipeline Access", value: JSON.stringify({
            pipelines: { u_rep: [OLTL] }, folders: {}, master: [], caseManagers: {},
          }) },
      ] });

    // TWO PARTNERS, BOTH IN DIVISIONS u_none DOES NOT HOLD. That is the whole
    // fixture: the account HAS partners and this viewer may see none of them.
    if (path === "/contacts/search") {
      if (j?.filters?.[0]?.value !== "Referral Partner")
        return send(200, { contacts: [], total: 0 });
      return send(200, { contacts: [
        { id: "p1", contactName: "Riddle Hospital", email: "dp@riddle.test",
          customFields: [{ id: RT, value: "Referral Partner" }, { id: TIER, value: "A" },
                         { id: DIV, value: "OLTL" }] },
        { id: "p2", contactName: "Delco Elder Law", email: "dl@delco.test",
          customFields: [{ id: RT, value: "Referral Partner" }, { id: TIER, value: "B" },
                         { id: DIV, value: "Private Pay" }] },
      ], total: 2 });
    }

    const withC = (o) => ({ ...o, contactId: "c1", contact: CONTACT });
    if (path === "/opportunities/search") {
      const pid = q.get("pipeline_id") || "";
      const list = !pid || pid === OLTL ? [OPP] : [];
      return send(200, { opportunities: list.map(withC), meta: { total: list.length } });
    }
    if (/^\/opportunities\/[^/]+$/.test(path)) return send(200, { opportunity: withC(OPP) });
    if (/^\/contacts\/[^/]+\/notes/.test(path)) return send(200, { notes: [] });
    if (/^\/contacts\/[^/]+$/.test(path)) return send(200, { contact: CONTACT });
    send(404, { message: `no fake handler for ${path}` });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const fp = server.address().port;

const probe = http.createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const PORT = probe.address().port;
await new Promise((r) => probe.close(r));
const base = `http://localhost:${PORT}`;

const devLog = [];
const dev = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  env: { ...process.env, GHL_API_BASE: `http://127.0.0.1:${fp}`, GHL_LOCATION_ID: LOC,
         GHL_PIT: "pit_test", GHL_SSO_SECRET: SECRET, PIPELINE_IDS: `${OLTL},${PP}` },
  stdio: ["ignore", "pipe", "pipe"],
});
dev.stdout.on("data", (d) => devLog.push(String(d)));
dev.stderr.on("data", (d) => devLog.push(String(d)));

const tryFetch = (url, ms) =>
  fetch(url, { signal: AbortSignal.timeout(ms) }).then((r) => r.status).catch((e) => String(e.name || e));

let up = false;
for (let i = 0; i < 90 && !up; i++) {
  const joined = devLog.join("");
  if (/Another next dev server is already running/.test(joined)) {
    const pid = /PID:\s*(\d+)/.exec(joined)?.[1] || "?";
    say(`  🔴 A DEV SERVER IS ALREADY RUNNING FOR THIS DIRECTORY (pid ${pid}). kill -9 ${pid}`);
    dev.kill(); server.close(); process.exit(1);
  }
  const s = await tryFetch(`${base}/api/opportunities`, 5000);
  if (typeof s === "number") { up = true; say(`  api up after ${i + 1}s (${s})`); }
  else await new Promise((r) => setTimeout(r, 1000));
}
if (!up) { say(`dev never came up:\n${devLog.join("").slice(-1000)}`); dev.kill(); server.close(); process.exit(1); }
for (let i = 0; i < 3; i++) { const w = await tryFetch(base, 150000); say(`  page warm-up ${i + 1}: ${w}`); if (typeof w === "number") break; }

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-proxy-server", "--no-sandbox"],
});

/** Open the client panel as `who` and open the "Referred by" picker. */
const openPickerAs = async (who, role = "user") => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  page.on("pageerror", (e) => say(`  [page error] ${e.message}`));
  await page.route(`${base}/__parent`, (route) => route.fulfill({
    status: 200, contentType: "text/html",
    body: `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0}iframe{border:0;width:1440px;height:950px}</style>
<script>window.addEventListener("message",(e)=>{if(e.data&&e.data.message==="REQUEST_USER_DATA")
e.source.postMessage({message:"REQUEST_USER_DATA_RESPONSE",payload:${JSON.stringify(blob(who, role))}},"*");});</script>
<iframe src="${base}/"></iframe>`,
  }));
  say(`  [${who}] opening…`);
  await page.goto(`${base}/__parent`, { waitUntil: "domcontentloaded" });
  const frame = await (await page.waitForSelector("iframe")).contentFrame();
  await frame.waitForFunction(
    () => !/Checking session/.test(document.querySelector(".viewas")?.textContent || ""),
    { timeout: 90000 },
  );
  // Into the List view, then open the one record.
  for (let i = 0; i < 12; i++) {
    await frame.evaluate(() => {
      const b = [...document.querySelectorAll(".seg button")].find((x) => x.textContent?.trim() === "List");
      b?.click();
    });
    await page.waitForTimeout(600);
    if (await frame.$("tr[data-cid]")) break;
  }
  await frame.waitForSelector("tr[data-cid]", { timeout: 60000 });
  await frame.evaluate(() => document.querySelector("tr[data-cid]")?.click());
  await frame.waitForSelector(".refby", { timeout: 30000 });
  // "set" / "change" opens the picker and fires the load.
  for (let i = 0; i < 10; i++) {
    await frame.evaluate(() => {
      const b = [...document.querySelectorAll(".refby .linkbtn")]
        .find((x) => /^(set|change)$/.test((x.textContent || "").trim()));
      b?.click();
    });
    await page.waitForTimeout(700);
    if (await frame.$(".refbypop")) break;
  }
  await frame.waitForSelector(".refbypop", { timeout: 30000 });
  await page.waitForTimeout(1200); // the partners fetch
  const read = async () => frame.evaluate(() => ({
    empty: (document.querySelector(".refbyempty")?.textContent || "").replace(/\s+/g, " ").trim(),
    hits: [...document.querySelectorAll(".refbyopt .n")].map((e) => (e.textContent || "").trim()),
  }));
  return { page, frame, ...(await read()), read };
};

say("\n═══ 1 · 🔴 THE CASE MANAGER — THE SENTENCE THAT WAS FALSE ═══");
const cm = await openPickerAs(U_NONE);
say(`  empty: ${JSON.stringify(cm.empty)}`);
say(`  hits:  ${JSON.stringify(cm.hits)}`);
ok("the picker offers no partner — correct, they hold no division", cm.hits.length === 0, cm.hits);
// 🔴 THE DEFECT. Two partners exist and this said none did — and its advice
// would have created a duplicate of one they cannot see.
ok("🔴 it does NOT say no referral partners exist — two do",
   !/No referral partners exist yet/.test(cm.empty), cm.empty);
ok("🔴 it does NOT tell them to go and add one",
   !/Add one in the Referrals section/.test(cm.empty), cm.empty);
ok("🔴 it says none is in SCOPE for them", /in scope for you/i.test(cm.empty), cm.empty);
ok("⚠️ and how many exist, so the reader knows it is a filter",
   /2 are tracked on this account/.test(cm.empty), cm.empty);
ok("⚠️ and where to go — a person, not a screen they cannot fix",
   /Admin → Access/.test(cm.empty), cm.empty);
// 🔴 A COUNT, NEVER A NAME. Naming them is the disclosure §4 closed.
ok("🔴 no partner NAME appears in that sentence",
   !/Riddle Hospital|Delco Elder Law/.test(cm.empty), cm.empty);
await cm.page.close();

say("\n═══ 2 · 🔴 THE CONTROL — AN ADMIN, SAME RECORD, SAME FIXTURE ═══");
// Without this, every assertion above is satisfied by a picker that renders
// nothing for anybody — or by a page that never loaded.
const ad = await openPickerAs(U_ADMIN, "admin");
say(`  empty: ${JSON.stringify(ad.empty)}`);
say(`  hits:  ${JSON.stringify(ad.hits)}`);
ok("🔴 THE CONTROL — the admin is offered both partners", ad.hits.length === 2, ad.hits);
ok("🔴 by name, so the picker genuinely works",
   ad.hits.join() === "Riddle Hospital,Delco Elder Law" || ad.hits.join() === "Delco Elder Law,Riddle Hospital",
   ad.hits);
ok("⚠️ and no empty-state sentence is shown to them at all", ad.empty === "", ad.empty);

say("\n═══ 3 · ⚠️ THE THIRD STATE — A SEARCH THAT MATCHES NOTHING ═══");
// `partners.length > 0 && hits.length === 0` is the branch that was always
// correct, and it must stay reachable: the fix added a state above it, and a
// mis-ordered ternary would swallow this one.
await ad.frame.evaluate(() => {
  const i = document.querySelector(".refbypop input");
  if (!i) return;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(i, "zzzz no such partner");
  i.dispatchEvent(new Event("input", { bubbles: true }));
});
await ad.page.waitForTimeout(900);
const searched = await ad.read();
say(`  empty: ${JSON.stringify(searched.empty)}`);
ok("⚠️ it says the SEARCH matched nothing, not that nothing exists",
   /No partner matches/.test(searched.empty), searched.empty);
ok("🔴 and NOT the scope sentence — the states are ordered correctly",
   !/in scope for you/i.test(searched.empty), searched.empty);
await ad.page.close();

await browser.close();
dev.kill("SIGTERM");
server.close();
try { rmSync(".next/dev/lock", { force: true }); } catch {}
say(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
setTimeout(() => process.exit(fail ? 1 : 0), 400);
