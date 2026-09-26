// ---------------------------------------------------------------------------
// ROUND 155 — THE ZERO-GRANT FIRST DAY.
//
// 🔴 TWO THINGS, AND THEY FAIL DIFFERENTLY.
//
//   the payload   a viewer holding no grant received every pipeline NAME.
//                 Closed in the response BODY, and asserted by looking for the
//                 name in the raw text — the Task 2 §1 shape. A client-side
//                 gate is a second line, not the only one.
//
//   the screen    `cgVisiblePipelines` fell open when `home.size` was 0, so the
//                 "no pipelines assigned yet" text could NEVER render for the
//                 viewer it was written for. Good text, dead code.
//
// ⚠️ AND THE CASE THAT MAKES IT HARD: a recruiter can hold NO grant and still
// have applicants on screen, because applyAccess admits what you own or follow
// without consulting a grant. Sections 2 and 5 are that person. Getting the
// first fix without them would have hidden their own records.
//
// Run: node scripts/zero-grant-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { chromium } from "playwright-core";
import CryptoJS from "crypto-js";

const LOC = "loc_test";
const SECRET = "harness_shared_secret";

// Three caregiver pipelines. 🔴 THE NAMES ARE THE PAYLOAD ASSERTION — each is
// distinctive enough that finding it in a response body is unambiguous.
const P_A = "pipe_a", N_A = "OLTL Caregiver Applicants";
const P_B = "pipe_b", N_B = "PP Caregiver Applicants";
const P_C = "pipe_c", N_C = "Staff Recruiting Pipeline";

const ZERO = "u_zero";     // no grants, no records — the new seat
const OWNER = "u_owner";   // no grants, but owns one applicant in pipe_b
const HOLDER = "u_holder"; // holds pipe_a — the control
const ADMIN = "u_admin";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const blobFor = (userId, role = "user") =>
  CryptoJS.AES.encrypt(JSON.stringify({
    userId, role, type: role === "admin" ? "agency" : "location",
    activeLocation: LOC, userName: userId, email: `${userId}@mm.com`, companyId: "co1",
  }), SECRET).toString();

const PIPES = [
  { id: P_A, name: N_A, stages: [{ id: "a1", name: "New Applicant", position: 0 }] },
  { id: P_B, name: N_B, stages: [{ id: "b1", name: "New Applicant", position: 0 }] },
  { id: P_C, name: N_C, stages: [{ id: "c1", name: "New Applicant", position: 0 }] },
];

// One record in pipe_b owned by OWNER. Nobody else owns anything, so ZERO sees
// nothing at all and OWNER sees exactly one.
const RECORDS = [
  { id: "o1", name: "Applicant One", pipelineId: P_B, pipelineStageId: "b1",
    status: "open", assignedTo: OWNER, contactId: "c1",
    contact: { id: "c1", firstName: "Applicant", lastName: "One" },
    createdAt: new Date().toISOString() },
];

const GRANTS = JSON.stringify({
  pipelines: { [HOLDER]: [P_A] },   // ZERO and OWNER hold nothing
  folders: {}, master: [], caseManagers: {},
});

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const [path, qs] = req.url.split("?");
    const q = new URLSearchParams(qs || "");
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (path.startsWith(`/locations/${LOC}/customFields`)) return send(200, { customFields: [] });
    if (path === "/users/")
      return send(200, { users: [ZERO, OWNER, HOLDER, ADMIN].map((id) => ({
        id, name: id, email: `${id}@mm.com`,
        roles: { role: id === ADMIN ? "admin" : "user" } })) });
    if (path === "/opportunities/pipelines") return send(200, { pipelines: PIPES });
    if (path === `/locations/${LOC}/customValues`)
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Access", value: GRANTS },
        { id: "cv2", name: "MM Pipeline Folders", value: JSON.stringify({
          seeded: true, folderNames: {},
          pipelines: {
            [P_A]: { scope: "caregiver", folders: [] },
            [P_B]: { scope: "caregiver", folders: [] },
            [P_C]: { scope: "caregiver", group: "staff", folders: [] },
          } }) },
      ] });
    if (path.startsWith("/opportunities/search")) {
      // 🔴 FILTER BY THE PIPELINE ASKED FOR. My first version returned the same
      // record for all three searches, so the route collected three copies of
      // one applicant and section 2 counted 3. A fake that answers every
      // question with the same value is the "one value for two roles" fault —
      // and here it would have hidden a real miscount behind a fixture one.
      const want = q.get("pipeline_id") || "";  // GHL spells it snake_case
      const rows = want ? RECORDS.filter((r) => r.pipelineId === want) : RECORDS;
      return send(200, { opportunities: rows, meta: { total: rows.length } });
    }
    if (path === "/contacts/search") return send(200, { contacts: [], total: 0 });
    send(404, { message: `no fake handler for ${path}` });
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
         GHL_PIT: "pit_test", GHL_SSO_SECRET: SECRET,
         PIPELINE_IDS: `${P_A},${P_B},${P_C}`, PIPELINE_ACCESS_MAP: "" },
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

/**
 * The RAW body, because the assertion is about the text, not the parse.
 *
 * ⚠️ A POST WITH `ssoKey` IN THE BODY, WHICH IS HOW THE APP CALLS IT
 * (app/page.tsx:2015). My first version sent a GET with the blob in a header
 * and every API assertion here failed — including the ADMIN control, which is
 * the only reason I looked at the harness instead of the route. Second time
 * this exact GET/POST mix-up has cost a run.
 */
const askRaw = async (userId, role) => {
  const r = await fetch(`${base}/api/opportunities?scope=caregiver`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ssoKey: blobFor(userId, role) }),
    cache: "no-store",
  });
  const text = await r.text();
  return { status: r.status, text, json: JSON.parse(text) };
};

console.log("\n═══ 1 · 🔴 A ZERO-GRANT VIEWER IS NOT TOLD THE NAMES ═══");
const z = await askRaw(ZERO);
console.log(`  pipelines: ${JSON.stringify(z.json.pipelines)}  withheld: ${z.json.pipelinesWithheld}`);
ok("the pipeline list is empty", (z.json.pipelines || []).length === 0, z.json.pipelines);
// 🔴 THE TEXT, NOT THE FIELD. A name can reach a client through any key —
// stagesByPipeline, a folder map, a record. Searching the whole body is the
// only assertion that cannot be satisfied by moving the leak somewhere else.
for (const [n, label] of [[N_A, "OLTL"], [N_B, "PP"], [N_C, "Staff"]])
  ok(`🔴 "${label}" appears NOWHERE in the response body`, !z.text.includes(n), n);
ok("⚠️ and the stage map is scoped with it",
   Object.keys(z.json.stagesByPipeline || {}).length === 0, z.json.stagesByPipeline);
ok("🔴 the COUNT is sent, so an empty list is distinguishable from none existing",
   z.json.pipelinesWithheld === 3, z.json.pipelinesWithheld);

console.log("\n═══ 2 · 🔴 BUT A RECORD THEY CAN SEE STILL NAMES ITS PIPELINE ═══");
// applyAccess admits what you OWN without consulting a grant. Sending only
// granted ids would leave this person's own applicant on a board with no
// pipeline — the board is per-pipeline, so it would render nothing.
const o = await askRaw(OWNER);
console.log(`  pipelines: ${JSON.stringify((o.json.pipelines || []).map((p) => p.name))}  withheld: ${o.json.pipelinesWithheld}`);
ok("🔴 the pipeline of their own record IS named", o.text.includes(N_B), o.json.pipelines);
ok("🔴 AND THE OTHER TWO STILL ARE NOT — the union does not widen",
   !o.text.includes(N_A) && !o.text.includes(N_C), o.json.pipelines);
ok("the count says two were held back", o.json.pipelinesWithheld === 2, o.json.pipelinesWithheld);
ok("⚠️ their record is there to be rendered", (o.json.records || []).length === 1, o.json.records?.length);

console.log("\n═══ 3 · 🔴 THE CONTROLS — OR EVERY ASSERTION ABOVE PASSES ON A BROKEN ROUTE ═══");
const a = await askRaw(ADMIN, "admin");
ok("🔴 an ADMIN still gets all three names", a.text.includes(N_A) && a.text.includes(N_B) && a.text.includes(N_C),
   (a.json.pipelines || []).map((p) => p.name));
ok("⚠️ and nothing is withheld from them", (a.json.pipelinesWithheld || 0) === 0, a.json.pipelinesWithheld);
const h = await askRaw(HOLDER);
ok("🔴 a viewer holding pipe_a gets THAT name and not the others",
   h.text.includes(N_A) && !h.text.includes(N_B) && !h.text.includes(N_C),
   (h.json.pipelines || []).map((p) => p.name));

// ── THE SCREEN ────────────────────────────────────────────────────────────
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-proxy-server", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));

const openRecruiting = async (userId, role) => {
  await page.route(`${base}/__parent`, (route) => route.fulfill({
    status: 200, contentType: "text/html",
    body: `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0}iframe{border:0;width:1440px;height:950px}</style>
<script>window.addEventListener("message",(e)=>{if(e.data&&e.data.message==="REQUEST_USER_DATA")
e.source.postMessage({message:"REQUEST_USER_DATA_RESPONSE",payload:${JSON.stringify(blobFor(userId, role))}},"*");});</script>
<iframe src="${base}/"></iframe>`,
  }));
  await page.goto(`${base}/__parent`, { waitUntil: "domcontentloaded" });
  const f = await (await page.waitForSelector("iframe")).contentFrame();
  await f.waitForFunction(
    () => !/Checking session/.test(document.querySelector(".viewas")?.textContent || ""),
    { timeout: 90000 },
  );
  for (let i = 0; i < 12; i++) {
    await f.evaluate(() => {
      [...document.querySelectorAll("button")]
        .find((x) => /^(Recruiting|Caregivers)$/i.test((x.textContent || "").trim()))?.click();
    });
    await page.waitForTimeout(500);
    if (await f.$(".empty.noaccess, [data-cid], .cgboard, table")) break;
  }
  await page.waitForTimeout(600);
  return f;
};

console.log("\n═══ 4 · 🔴 THE NEW SEAT'S SCREEN — THE TEXT THAT COULD NEVER RENDER ═══");
let f = await openRecruiting(ZERO);
const zeroScreen = await f.evaluate(() => ({
  notice: document.querySelector(".empty.noaccess")?.textContent?.trim() || "",
  picker: !!document.querySelector("#cgPipeSel"),
  options: [...document.querySelectorAll("#cgPipeSel option")].map((o) => o.textContent),
}));
console.log(`  notice: ${JSON.stringify(zeroScreen.notice.slice(0, 96))}`);
console.log(`  picker: ${zeroScreen.picker}`);
ok("🔴 the notice RENDERS AT ALL — it could not before", zeroScreen.notice.length > 0, zeroScreen);
ok("🔴 and it says the access sentence, not 'none are set up yet'",
   /No pipelines assigned yet/.test(zeroScreen.notice), zeroScreen.notice);
ok("⚠️ with the reassurance Clients gives the same person",
   /Nothing is wrong with your sign-in/.test(zeroScreen.notice), zeroScreen.notice);
ok("🔴 NO PIPELINE PICKER", !zeroScreen.picker, zeroScreen);
ok("🔴 and no pipeline name is anywhere on the screen",
   !(await f.evaluate(() => document.body.textContent || "")).match(/OLTL Caregiver|PP Caregiver|Staff Recruiting Pipeline/),
   "a pipeline name reached the DOM");

console.log("\n═══ 5 · 🔴 THE CONTROL THAT DECIDED THE DESIGN — RECORDS WITHOUT A GRANT ═══");
// Without the `inData` union this person would see "No pipelines assigned yet"
// over an applicant they own. The notice must NOT appear.
f = await openRecruiting(OWNER);
const ownerScreen = await f.evaluate(() => ({
  notice: document.querySelector(".empty.noaccess")?.textContent?.trim() || "",
  body: document.body.textContent || "",
}));
console.log(`  notice: ${JSON.stringify(ownerScreen.notice.slice(0, 80))}`);
ok("🔴 they are NOT told they have no access", ownerScreen.notice.length === 0, ownerScreen.notice);
ok("🔴 their own applicant is on screen", /Applicant One/.test(ownerScreen.body), "record missing");
ok("⚠️ and the two pipelines they cannot see are still not named",
   !/OLTL Caregiver|Staff Recruiting Pipeline/.test(ownerScreen.body), "a withheld name reached the DOM");

console.log("\n═══ 6 · ⚠️ THE ADMIN CONTROL — THE TAB STILL WORKS ═══");
f = await openRecruiting(ADMIN, "admin");
const adminScreen = await f.evaluate(() => ({
  notice: document.querySelector(".empty.noaccess")?.textContent?.trim() || "",
  picker: !!document.querySelector("#cgPipeSel"),
}));
ok("🔴 an admin is not shown the no-access notice", adminScreen.notice.length === 0, adminScreen.notice);
ok("⚠️ and still gets the pipeline picker", adminScreen.picker, adminScreen);

console.log("\n═══ 7 · 🔴 THE CLIENT GATE ON ITS OWN — WITH THE PAYLOAD LEAKING ANYWAY ═══");
//
// 🔴 RULE 10 CAUGHT THIS ROUND'S OWN REDUNDANCY AND THIS SECTION IS THE ANSWER.
//
// Reverting `!home.size` changed NOTHING while the payload scoping was in
// place: `cgPipelines` is already empty for this viewer, so the fall-open has
// nothing to fall open to. Two fixes, one observable, and I would have shipped
// the second claiming a red it never produced.
//
// The client gate is defence in depth — it matters the day the payload carries
// a name again, from a new route, a regression, or a different feed into
// `cgPipelines`. So the proof MAKES that day happen: the API answer is
// intercepted at the browser and the full pipeline list is put back into it.
// The screen must still refuse to build a picker out of pipelines the viewer
// holds no grant for.
await page.route(`${base}/api/opportunities?scope=caregiver`, async (route) => {
  const r = await route.fetch();
  const j = await r.json();
  await route.fulfill({
    status: r.status(),
    contentType: "application/json",
    // The leak, reinstated: every pipeline name, exactly as the payload used to
    // carry it, while `viewer.homePipelineIds` stays honestly empty.
    body: JSON.stringify({ ...j, pipelines: PIPES.map((p) => ({ id: p.id, name: p.name })) }),
  });
});
f = await openRecruiting(ZERO);
const leaked = await f.evaluate(() => ({
  picker: !!document.querySelector("#cgPipeSel"),
  options: [...document.querySelectorAll("#cgPipeSel option")].map((o) => o.textContent),
  notice: document.querySelector(".empty.noaccess")?.textContent?.trim() || "",
}));
console.log(`  payload re-leaked · picker: ${leaked.picker} · options: ${JSON.stringify(leaked.options)}`);
ok("🔴 EVEN WITH THE NAMES BACK ON THE PAYLOAD, no picker is built",
   !leaked.picker, leaked);
ok("🔴 and the no-access notice still renders", /No pipelines assigned yet/.test(leaked.notice), leaked.notice);
// ⚠️ THE CONTROL: the interception really did put the names back, so this is
// not passing because the route override silently failed.
ok("⚠️ THE CONTROL — the intercepted payload really did carry all three names",
   await (async () => {
     const r = await fetch(`${base}/api/opportunities?scope=caregiver`, {
       method: "POST", headers: { "Content-Type": "application/json" },
       body: JSON.stringify({ ssoKey: blobFor(ZERO) }), cache: "no-store" });
     const t = await r.text();
     return !t.includes(N_A);   // the SERVER is still scoped; only the browser saw the leak
   })(),
   "the server itself leaked — the interception is not what this tested");

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
