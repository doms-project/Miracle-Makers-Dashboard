// ---------------------------------------------------------------------------
// TASK 1 · STEP 2, GATE — WHAT DOES "Case Manager" RENDER AS NOW?
//
// 🔴 THE QUESTION THE BRIEF ASKED ME NOT TO ANSWER FROM READING.
//
// "Case Manager" is in `PEOPLE_FIELDS` (app/page.tsx:609) AND now in
// `READ_ONLY_FIELDS` (lib/editable.ts). Nothing states which wins. If the panel
// renders a live picker whose save the PATCH route then rejects, that is worse
// than either extreme — a control that looks live and silently does nothing.
//
// ⚠️ SO IT IS READ OFF A RENDERED PAGE, not off `FieldControl`'s branches. I
// have been wrong about this file from reading twice this month.
//
// TWO SHAPES, because there are two different questions:
//
//   DATATYPE=TEXT             the field as it is TODAY, after the recreate
//   DATATYPE=SINGLE_OPTIONS   the field as it was YESTERDAY — the general
//                             precedence question, which still matters for the
//                             other three people-fields if one is ever
//                             blocklisted
//
// ⚠️ AND A CONTROL CASE IN BOTH: "Onboarding Rep", a people-field that is NOT
// blocklisted. If the harness cannot see a live HybridPicker there, it cannot
// claim to have seen its absence anywhere else.
//
// Run: npx tsx scripts/task1-picker-check.mjs            (TEXT)
//      DATATYPE=SINGLE_OPTIONS npx tsx scripts/task1-picker-check.mjs
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
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Chris Tester", email: "c@e.com", companyId: "co1",
}), SECRET).toString();

/** TEXT today; SINGLE_OPTIONS is what it was before the recreate. */
const DT = process.env.DATATYPE || "TEXT";
const CM = "f_cm", ONB = "f_onb", FOLDER = "B6cunntgpATjWseEb1iC";

const oppFields = [
  {
    id: CM, name: "Case Manager", dataType: DT, parentId: FOLDER,
    ...(DT === "SINGLE_OPTIONS" ? { picklistOptions: ["TBD", "Carla Winnigan"] } : {}),
  },
  // ⚠️ THE CONTROL. A people-field that is NOT on the blocklist, so a live
  // HybridPicker MUST appear here or this harness is blind.
  { id: ONB, name: "Onboarding Rep", dataType: "SINGLE_OPTIONS", parentId: FOLDER,
    picklistOptions: ["TBD", "Someone Else"] },
  // 🔴 THE THIRD CASE, AND IT IS A CLAIM I WOULD OTHERWISE BE MAKING FROM
  // READING. `FieldControl` gates the people-picker on
  // `isPeopleField(name) && isOptionType` — so a people-field that is TEXT
  // should get NO picker even without the blocklist. That matters, because it
  // means keeping "Case Manager" in PEOPLE_FIELDS is now INERT: the field was
  // recreated as TEXT, and the stated reason for keeping it there ("it displays
  // as a person rather than a bare string") no longer applies. Measured, not
  // read: this field is a people-field, is TEXT, and is NOT blocklisted.
  { id: "f_asst", name: "Sales Rep Assistant", dataType: "TEXT", parentId: FOLDER },
];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const [path, qs] = req.url.split("?");
    const q = new URLSearchParams(qs || "");
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (path === `/locations/${LOC}/customFields`)
      return send(200, { customFields: q.get("model") === "opportunity" ? oppFields : [] });
    if (path === "/users/")
      return send(200, { users: [
        { id: "u1", name: "Chris Tester" },
        { id: "u_carla", name: "Carla Winnigan" },
        { id: "u_edmark", name: "Edmark Villanueva" },
      ] });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [{ id: "p1", name: "OLTL Enrollment",
        stages: [{ id: "p1_s1", name: "NEW LEAD", position: 0 }] }] });
    if (path === `/locations/${LOC}/customValues`)
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({ seeded: true, folderNames: { [FOLDER]: "OLTL Detail" },
          pipelines: { p1: { scope: "client", folders: [FOLDER] } } }) }] });
    if (path === "/opportunities/search")
      return send(200, { opportunities: [{
        id: "o1", name: "Mary Malone", pipelineId: "p1", pipelineStageId: "p1_s1",
        status: "open", assignedTo: "u1", updatedAt: "2026-09-01T10:00:00.000Z",
        contactId: "c1", contact: { id: "c1", firstName: "Mary", lastName: "Malone",
          email: "mary@ex.com", phone: "" },
        customFields: [{ id: CM, fieldValue: "Carla Winnigan" }],
      }], meta: { total: 1 } });
    if (/^\/opportunities\/[^/]+$/.test(path))
      return send(200, { opportunity: { id: "o1", name: "Mary Malone", pipelineId: "p1",
        pipelineStageId: "p1_s1", contactId: "c1", customFields: [{ id: CM, fieldValue: "Carla Winnigan" }] } });
    if (/^\/contacts\/[^/]+\/notes$/.test(path)) return send(200, { notes: [] });
    if (/^\/contacts\/[^/]+$/.test(path))
      return send(200, { contact: { id: "c1", firstName: "Mary", lastName: "Malone",
        email: "mary@ex.com", phone: "", dateUpdated: "x", customFields: [] } });
    send(404, { message: `no fake handler for ${req.url}` });
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
console.log(`\n═══ "Case Manager" AS ${DT} ═══\n  dev server up on ${PORT}`);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-proxy-server", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));
await page.route(`${base}/__parent`, (route) => route.fulfill({
  status: 200, contentType: "text/html",
  body: `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0}iframe{border:0;width:1440px;height:950px}</style>
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
await frame.waitForSelector(".seg button", { timeout: 90000 });
for (let i = 0; i < 10; i++) {
  await frame.evaluate(() => {
    const b = [...document.querySelectorAll(".seg button")].find((x) => x.textContent?.trim() === "List");
    b?.click();
  });
  await page.waitForTimeout(500);
  if (await frame.$("tr[data-cid]")) break;
}
await frame.waitForSelector("tr[data-cid]", { timeout: 60000 });
await frame.click("tr[data-cid]");
await frame.waitForSelector(".panel.on .pbody", { timeout: 20000 });
// Open every collapsed section so the field is in the DOM.
for (let i = 0; i < 12; i++) {
  const opened = await frame.evaluate(() => {
    const t = [...document.querySelectorAll(".panel.on .sechead.sectoggle:not(.open)")][0];
    if (!t) return false;
    t.click();
    return true;
  });
  if (!opened) break;
  await page.waitForTimeout(150);
}
await page.waitForTimeout(600);

/** Read the row for a field by its LABEL, and say what control it holds. */
const row = (label) => frame.evaluate((want) => {
  const lab = [...document.querySelectorAll(".panel.on label, .panel.on .f > label, .panel.on .flabel")]
    .find((l) => (l.textContent || "").trim().replace(/\s+/g, " ").startsWith(want));
  const host = lab?.closest(".f") || lab?.parentElement;
  if (!host) return { found: false };
  // 🔴 `.uppick` IS THE PICKER'S REAL WRAPPER, and its control is a BUTTON with
  // a caret, not a <select>. My first version looked for `.hp*`, found nothing,
  // and the CONTROL CASE failed — which is the only reason I know the rest of
  // this read was not also blind. That is what the control is for.
  const picker = host.querySelector(".uppick");
  const sel = host.querySelector("select");
  const inp = host.querySelector("input");
  const pickBtn = host.querySelector(".uppick button, .upbtnlabel");
  const ro = host.querySelector(".v.ro");
  return {
    found: true,
    text: (host.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160),
    hasPicker: !!picker,
    hasPickerButton: !!pickBtn,
    hasSelect: !!sel,
    hasInput: !!inp,
    selDisabled: sel ? sel.disabled : null,
    inpDisabled: inp ? inp.disabled : null,
    readOnlyBlock: !!ro,
    readOnlyNote: !!host.querySelector(".readonly-note"),
  };
}, label);

console.log("\n── THE CONTROL CASE: a people-field that is NOT blocklisted ──────");
const onb = await row("Onboarding Rep");
console.log(`  ${JSON.stringify(onb)}`);
ok("🔴 the harness CAN see a live people-picker — otherwise it proves nothing",
   onb.found && !onb.readOnlyBlock && onb.hasPicker && onb.hasPickerButton, onb);

console.log("\n── THE QUESTION: Case Manager, in BOTH lists ─────────────────────");
const cm = await row("Case Manager");
console.log(`  ${JSON.stringify(cm)}`);
ok("the field is on the panel at all", cm.found, cm);
ok("⚠️ its value is still readable — this is not hidden, only uneditable",
   /Carla Winnigan/.test(cm.text || ""), cm.text);
ok("🔴 NO live control: no picker, no select, no input",
   !cm.hasPicker && !cm.hasPickerButton && !cm.hasSelect && !cm.hasInput, cm);
ok("🔴 it renders as the read-only block", cm.readOnlyBlock === true, cm);
ok('⚠️ and it says so on screen — "read-only"', cm.readOnlyNote === true, cm);

console.log("\n── IS `PEOPLE_FIELDS` STILL DOING ANYTHING FOR A **TEXT** FIELD? ──");
const asst = await row("Sales Rep Assistant");
console.log(`  ${JSON.stringify(asst)}`);
ok("it is editable — not blocklisted, so this is not the blocklist talking",
   asst.found && !asst.readOnlyBlock, asst);
ok("🔴 and it gets NO people-picker, because TEXT is not an option type",
   !asst.hasPicker && !asst.hasPickerButton, asst);
ok("⚠️ it is a plain text input instead", asst.hasInput === true, asst);

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
