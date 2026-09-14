// ---------------------------------------------------------------------------
// ROUND 120 · ITEM 2 — A SCREENSHOT OF EACH MODAL.
//
// 🔴 A GEOMETRY ASSERTION PASSED ON ALL FOUR LAST ROUND AND THEY STILL LOOKED
// LIKE THIS. "Paired = tops within 6px" proved two controls were on one line,
// not that the line looked right — they can share a top edge and still differ
// in height, width and distance from the sides.
//
// So this round the evidence is an IMAGE. It also measures the three things
// the numbers missed, because those are checkable:
//
//   EDGES     does every label, control and hint start at the same x?
//   HEIGHTS   do two controls on one row end at the same y?
//   PADDING   do the header, the body and the footer share a left edge?
//
// Run: node scripts/modal-screenshot-proof.mjs
// Writes: /tmp/modal-*.png
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



const shot = async (name, file) => {
  await frame.waitForSelector(".addbox", { timeout: 15000 });
  await page.waitForTimeout(250);
  const el = await frame.$(".addbox");
  await el.screenshot({ path: `/tmp/modal-${file}.png` });

  // 🔴 THE THREE THINGS A "PAIRED" ASSERTION CANNOT SEE.
  const m = await frame.evaluate(() => {
    const box = document.querySelector(".addbox");
    const body = box.querySelector(".movebody");
    const head = box.querySelector(".previewhead");
    const acts = box.querySelector(".moveacts");
    const bx = box.getBoundingClientRect();
    const px = (el) => (el ? Math.round(el.getBoundingClientRect().left - bx.left) : null);
    const cs = (el) => (el ? getComputedStyle(el) : null);

    const ctrls = [...body.querySelectorAll(
      "input:not([type=radio]):not([type=checkbox]):not([type=search]), select, textarea",
    )].filter((e) => e.getClientRects().length);
    // ⚠️ A RADIO'S LABEL IS NOT A FIELD LABEL. `<label><input type=radio> New
    // organisation</label>` is inline text beside a control: its weight is
    // deliberately normal and its text starts AFTER the radio, so counting it
    // reported a second "left edge" and a 400 weight that are both correct.
    // The assertion was wrong, not the CSS.
    const labels = [...body.querySelectorAll("label")]
      .filter((e) => e.getClientRects().length && !e.querySelector("input"));
    const hints = [...body.querySelectorAll(".rfdhint")].filter((e) => e.getClientRects().length);

    // Every left edge in the body, de-duplicated to the pixel.
    const lefts = new Set(
      // ⚠️ A CURRENCY-PREFIXED INPUT LEGITIMATELY STARTS AFTER ITS "$". The
      // money field is `$ [input] /mo`, so its control begins ~16px in by
      // design — that is the affix doing its job, not an indent. Its LABEL is
      // still on the column edge, which is the thing being checked.
      [...ctrls.filter((e) => !e.closest(".rfvaluebox")), ...labels, ...hints].map((e) =>
        Math.round(e.getBoundingClientRect().left - bx.left),
      ),
    );

    // Rows, then whether the controls in a row end at the same y.
    const sorted = ctrls
      .map((c) => ({ el: c, r: c.getBoundingClientRect() }))
      .sort((a, b) => a.r.top - b.r.top);
    const rows = [];
    for (const c of sorted) {
      const last = rows[rows.length - 1];
      if (last && c.r.top - last[0].r.top <= 6) last.push(c);
      else rows.push([c]);
    }
    const ragged = rows.filter(
      (r) => r.length > 1 && Math.max(...r.map((c) => c.r.bottom)) - Math.min(...r.map((c) => c.r.bottom)) > 1,
    ).length;

    const labelWeights = new Set(labels.map((l) => cs(l).fontWeight));
    const padOf = (el) => (el ? cs(el).paddingLeft : null);

    return {
      width: Math.round(bx.width),
      headLeft: padOf(head), bodyLeft: padOf(body), actsLeft: padOf(acts),
      footerStyled: acts ? cs(acts).borderTopWidth !== "0px" : false,
      lefts: [...lefts].sort((a, b) => a - b),
      controls: ctrls.length,
      raggedRows: ragged,
      labelWeights: [...labelWeights],
      ctrlPad: ctrls.length ? cs(ctrls[0]).padding : null,
      ctrlMinH: ctrls.length ? cs(ctrls.find((c) => c.tagName !== "TEXTAREA") || ctrls[0]).minHeight : null,
    };
  });
  console.log(`\n  ${name}`);
  console.log(`    header/body/footer left padding: ${m.headLeft} / ${m.bodyLeft} / ${m.actsLeft}`);
  console.log(`    distinct left edges in the body: ${m.lefts.join(", ")}`);
  console.log(`    rows whose controls end at different heights: ${m.raggedRows}`);
  console.log(`    label weight(s): ${m.labelWeights.join(", ")} · control padding: ${m.ctrlPad} · min-height: ${m.ctrlMinH}`);
  console.log(`    → /tmp/modal-${file}.png`);
  return m;
};

const shots = {};

console.log("\n1 · 🔴 EACH MODAL, PHOTOGRAPHED AND MEASURED");
await frame.click('button:has-text("Add partner")');
shots.partner = await shot("Add a referral partner", "partner");
await frame.click(".addbox .previewhead .x");
await page.waitForTimeout(300);

await frame.click(".rftable tbody tr:first-child");
await frame.waitForSelector(".rfdrawer", { timeout: 15000 });
await frame.click('.rfdrawer button:has-text("Log a referral")');
shots.referral = await shot("Log a referral", "referral");
await frame.click(".addbox .previewhead .x");
await page.waitForTimeout(300);

await frame.click('.rfdrawer button:has-text("Log a touch")');
shots.touch = await shot("Log a touch", "touch");
await frame.click(".addbox .previewhead .x");
await page.waitForTimeout(300);

await frame.click('.rfdrawer button:has-text("Add an event")');
shots.event = await shot("Add an event", "event");

console.log("\n2 · 🔴 THE HEADER, THE BODY AND THE FOOTER SHARE A LEFT EDGE");
console.log("  (they were 16 / 18 / unstyled — a title and its first label have");
console.log("   never started at the same x, and the footer had no padding at all)");
for (const [k, m] of Object.entries(shots)) {
  ok(`${k}: header and body agree`, m.headLeft === m.bodyLeft, [m.headLeft, m.bodyLeft]);
  ok(`${k}: the footer agrees too`, m.actsLeft === m.bodyLeft, [m.actsLeft, m.bodyLeft]);
  ok(`${k}: 🔴 the footer is styled at all`, m.footerStyled, m.footerStyled);
}

console.log("\n3 · 🔴 ONE LEFT EDGE INSIDE THE BODY");
for (const [k, m] of Object.entries(shots)) {
  // ⚠️ TWO IS CORRECT, NOT ONE. A paired row has a second column, so its right
  // cell legitimately starts further in. Three or more means something is
  // indented for no reason.
  console.log(`  ${k}: ${m.lefts.length} distinct left edge(s) — ${m.lefts.join(", ")}`);
  ok(`${k}: at most two (the column, and the pair's right cell)`,
     m.lefts.length <= 2, m.lefts);
}

console.log("\n4 · 🔴 CONTROLS ON ONE ROW END AT THE SAME HEIGHT");
console.log("  This is what \"tops within 6px\" could not see.");
for (const [k, m] of Object.entries(shots))
  ok(`${k}: no ragged row`, m.raggedRows === 0, m.raggedRows);

console.log("\n5 · ✅ AND THE SCALE IS THE RECORD PANEL'S, NOT A NEW ONE");
for (const [k, m] of Object.entries(shots)) {
  ok(`${k}: labels are 600, like .f label`, m.labelWeights.every((w) => w === "600"), m.labelWeights);
  ok(`${k}: controls pad 9px 11px, like .f .v`, /^9px 11px/.test(m.ctrlPad || ""), m.ctrlPad);
  ok(`${k}: controls are 36px tall, like .f .v`, m.ctrlMinH === "36px", m.ctrlMinH);
}

console.log(`\n${pass} passed, ${fail} failed.`);
console.log("\n🔴 THE IMAGES ARE THE EVIDENCE: /tmp/modal-partner.png, -referral.png,");
console.log("   -touch.png, -event.png. The numbers above are what the numbers");
console.log("   missed last round, not a replacement for looking.");
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
