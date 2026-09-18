// ---------------------------------------------------------------------------
// ROUND 133 — THE PREFLIGHT CATCHES THE UNTRANSFERABLE CONTACT.
//
// 🔴 THE LOAD-BEARING ASSERTION IS NOT "IT REFUSES". It is WHICH COPY OF THE
// CONTACT IT ASKED.
//
// An opportunity carries an embedded copy of its contact, and that copy comes
// from GoHighLevel's opportunities SEARCH INDEX, which lags. Round 132's code
// read `record.contactEmail` from it. A refusal built on a stale copy would
// block the transfer of somebody whose email was added an hour ago — the app
// confidently telling a rep that a record they are looking at does not have
// the thing they can see on it.
//
// So sections A2 and A3 set the two copies DELIBERATELY AT ODDS, in both
// directions, and assert the answer follows the CONTACT. Assert only that it
// refuses Jack Ratigan and both the right code and the wrong one pass.
//
// Run: npx tsx scripts/round133-proof.mjs
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

const SECRET = "harness_shared_secret";
const SELF_LOC = "loc_self", PEER_LOC = "loc_peer";
const SELF_TOK = "pit_self", PEER_TOK = "pit_peer";
const ADMIN = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: SELF_LOC,
  userName: "Chris Tester", email: "c@e.com", companyId: "co1",
}), SECRET).toString();

const CARE = "sf_care", OLTL = "sf_oltl", PEERID = "sf_peerid";
const PCARE = "pf_care";

/**
 * 🔴 `embedded` IS WHAT THE OPPORTUNITY SEARCH RETURNS; `contacts` IS WHAT
 * /contacts/{id} RETURNS. GoHighLevel really does let these disagree — that is
 * what an index lag IS — so the fake lets them, and the proof uses it.
 */
const mkState = () => ({
  fail: {},
  self: {
    loc: SELF_LOC,
    contactFields: [
      { id: CARE, name: "Care Needs", dataType: "TEXT" },
      { id: OLTL, name: "OLTL Waiver Number", dataType: "TEXT" },
    ],
    oppFields: [{ id: PEERID, name: "Peer Record Id", dataType: "TEXT" }],
    pipelines: [
      { id: "sp_oltl", name: "OLTL Enrollment", stages: [
        { id: "sp_oltl_s0", name: "TRANSFERRED IN", position: 0 },
        { id: "sp_oltl_s2", name: "WAITING FOR DOCS", position: 2 }] },
      { id: "sp_out", name: "Transferred Out", stages: [{ id: "sp_out_s0", name: "Sent", position: 0 }] },
    ],
    contacts: {
      // Transferable: an email on the contact record.
      c1: { id: "c1", firstName: "Mary", lastName: "Malone", name: "Mary Malone",
        email: "mary@ex.com", phone: "", dateUpdated: "2026-09-01T10:00:00.000Z",
        customFields: [{ id: CARE, value: "Two visits a day" }] },
      // 🔴 THE LIVE CASE. Jack Ratigan: no phone, no email. GoHighLevel will not
      // create him at all, and round 132 only found that out after Send.
      c2: { id: "c2", firstName: "Jack", lastName: "Ratigan", name: "Jack Ratigan",
        email: "", phone: "", dateUpdated: "2026-09-01T10:00:00.000Z",
        customFields: [{ id: CARE, value: "Days only" }] },
      // Every answer is in a field the peer does not have → zero carry.
      c3: { id: "c3", firstName: "Nina", lastName: "Okafor", name: "Nina Okafor",
        email: "nina@ex.com", phone: "", dateUpdated: "2026-09-01T10:00:00.000Z",
        customFields: [{ id: OLTL, value: "W-4410" }] },
    },
    /** The SEARCH-INDEX copy. Set per test to disagree with the contact above. */
    embedded: {},
    opps: {
      o1: { id: "o1", name: "Mary Malone", pipelineId: "sp_oltl", pipelineStageId: "sp_oltl_s2",
        status: "open", assignedTo: "u1", monetaryValue: 3000,
        updatedAt: "2026-09-01T10:00:00.000Z", customFields: [] },
      o2: { id: "o2", name: "Jack Ratigan", pipelineId: "sp_oltl", pipelineStageId: "sp_oltl_s2",
        status: "open", assignedTo: "u1", monetaryValue: 0,
        updatedAt: "2026-09-01T10:00:00.000Z", customFields: [] },
      o3: { id: "o3", name: "Nina Okafor", pipelineId: "sp_oltl", pipelineStageId: "sp_oltl_s2",
        status: "open", assignedTo: "u1", monetaryValue: 0,
        updatedAt: "2026-09-01T10:00:00.000Z", customFields: [] },
    },
    contactOf: { o1: "c1", o2: "c2", o3: "c3" },
    notes: {},
  },
  peer: {
    loc: PEER_LOC,
    contactFields: [{ id: PCARE, name: "Care Needs", dataType: "TEXT" }],
    oppFields: [],
    pipelines: [{ id: "pp_oltl", name: "OLTL Enrollment", stages: [
      { id: "pp_oltl_s2", name: "WAITING FOR DOCS", position: 2 },
      { id: "pp_oltl_s0", name: "TRANSFERRED IN", position: 0 }] }],
    contacts: {}, opps: {}, contactOf: {}, notes: {},
  },
});

function makeFake(S, calls) {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const j = raw ? JSON.parse(raw) : null;
      const [path, qs] = req.url.split("?");
      const q = new URLSearchParams(qs || "");
      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const which = tok === SELF_TOK ? "self" : tok === PEER_TOK ? "peer" : null;
      if (!which) return send(401, { message: "invalid jwt" });
      const A = S[which];
      calls.push({ acct: which, method: req.method, path });
      const named = q.get("locationId") || q.get("location_id") || j?.locationId ||
        (/^\/locations\/([^/]+)/.exec(path) || [])[1] || "";
      if (named && named !== A.loc)
        return send(401, { message: `token for ${A.loc} cannot access ${named}` });

      if (/^\/locations\/[^/]+\/customFields$/.test(path))
        return send(200, { customFields: q.get("model") === "opportunity" ? A.oppFields : A.contactFields });
      if (path === `/locations/${A.loc}/customValues`)
        return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
          value: JSON.stringify({ seeded: true, folderNames: {},
            pipelines: Object.fromEntries(A.pipelines.map((p) => [p.id, { scope: "client", folders: [] }])) }) }] });
      if (path === "/users/") return send(200, { users: [{ id: "u1", name: "Chris Tester" }] });
      if (path === "/opportunities/pipelines") return send(200, { pipelines: A.pipelines });

      // 🔴 THE SEARCH RETURNS THE EMBEDDED COPY, which `A.embedded` may make
      // disagree with the contact record. That is the whole point of A2/A3.
      const withC = (o) => {
        const cid = A.contactOf[o.id];
        return { ...o, contactId: cid, contact: (A.embedded || {})[cid] || A.contacts[cid] };
      };
      if (path === "/opportunities/search") {
        const pid = q.get("pipeline_id") || "", cid = q.get("contact_id") || "";
        let list = Object.values(A.opps);
        if (pid) list = list.filter((o) => o.pipelineId === pid);
        if (cid) list = list.filter((o) => A.contactOf[o.id] === cid);
        return send(200, { opportunities: list.map(withC), meta: { total: list.length } });
      }
      if (path === "/opportunities/" && req.method === "POST") {
        const id = `p_o${Object.keys(A.opps).length + 1}`;
        A.opps[id] = { id, ...j }; A.contactOf[id] = j.contactId;
        return send(200, { opportunity: { id } });
      }
      if (/^\/opportunities\/[^/]+$/.test(path)) {
        const id = path.split("/")[2];
        const o = A.opps[id];
        if (!o) return send(404, { message: "not found" });
        if (req.method === "PUT") { A.opps[id] = { ...o, ...j, updatedAt: new Date().toISOString() }; return send(200, { opportunity: withC(A.opps[id]) }); }
        return send(200, { opportunity: withC(o) });
      }
      if (path === "/contacts/upsert" && req.method === "POST") {
        // 🔴 GOHIGHLEVEL'S OWN RULE, WORD FOR WORD FROM THE LIVE 400. A fake
        // that accepted a contact with neither would make this whole round
        // untestable — and round 121's rule is that a fake answering something
        // GoHighLevel would refuse is a harness bug.
        if (!j?.email && !j?.phone)
          return send(400, { message: "Pass at least one of number, email query parameter" });
        const hit = Object.values(A.contacts).find(
          (c) => (j.email && c.email === j.email) || (j.phone && c.phone === j.phone));
        const id = hit?.id || `p_c${Object.keys(A.contacts).length + 1}`;
        A.contacts[id] = { ...(hit || {}), id, ...j };
        return send(200, { contact: { id }, new: !hit });
      }
      if (path === "/contacts/search" && req.method === "POST") {
        const needle = String(j?.query || "").toLowerCase();
        const hits = Object.values(A.contacts).filter((c) =>
          [c.email, c.phone].some((v) => v && String(v).toLowerCase() === needle));
        return send(200, { contacts: hits, total: hits.length });
      }
      if (/^\/contacts\/[^/]+\/notes$/.test(path)) {
        const id = path.split("/")[2];
        if (req.method === "POST") { (A.notes[id] ||= []).push({ id: "n", body: j.body }); return send(200, { note: { id: "n" } }); }
        return send(200, { notes: A.notes[id] || [] });
      }
      if (/^\/contacts\/[^/]+$/.test(path)) {
        const id = path.split("/")[2];
        const c = A.contacts[id];
        if (!c) return send(404, { message: "not found" });
        if (req.method === "PUT") { A.contacts[id] = { ...c, ...j }; return send(200, { contact: A.contacts[id] }); }
        return send(200, { contact: c });
      }
      send(404, { message: `no fake handler for ${req.url}` });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PART A — THE ROUTE
// ═══════════════════════════════════════════════════════════════════════════
let S = mkState();
let calls = [];
const fakeA = makeFake(S, calls);
await new Promise((r) => fakeA.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${fakeA.address().port}`;
process.env.GHL_PIT = SELF_TOK;
process.env.GHL_LOCATION_ID = SELF_LOC;
process.env.GHL_SSO_SECRET = SECRET;
process.env.PIPELINE_IDS = "sp_oltl,sp_out";
process.env.PEER_PIT = PEER_TOK;
process.env.PEER_LOCATION_ID = PEER_LOC;
process.env.PEER_LABEL = "ODP Care";

const route = await import("../app/api/opportunities/[id]/transfer/route.ts");
const ghl = await import("../lib/ghl.ts");
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const pre = async (id) => {
  const res = await route.GET(new Request(`http://x/t/${id}`, {
    headers: { "x-ghl-sso-key": ADMIN } }), ctx(id));
  return { status: res.status, body: await res.json() };
};
const go = async (id) => {
  const res = await route.POST(new Request(`http://x/t/${id}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoKey: ADMIN, confirm: true }) }), ctx(id));
  return { status: res.status, body: await res.json() };
};
const writes = () => calls.filter((c) => c.method !== "GET" && !/\/search$/.test(c.path));
const fresh = () => { ghl.invalidateOpportunity?.("o1"); ghl.invalidateOpportunity?.("o2"); ghl.invalidateOpportunity?.("o3"); calls.length = 0; };

console.log("\n═══ PART A · THE ROUTE ═══");

console.log("\nA1 · 🔴 JACK RATIGAN — CAUGHT BY THE PREFLIGHT, NOT BY A 400");
fresh();
let p = await pre("o2");
console.log(`  canTransfer: ${p.body.canTransfer}`);
console.log(`  ${p.body.refusals?.[0]?.error}`);
console.log(`  ${p.body.refusals?.[0]?.detail}`);
ok("the preflight answers 200 — a refusal is not a fault", p.status === 200, p.status);
ok("🔴 and says it cannot be transferred", p.body.canTransfer === false, p.body);
ok("🔴 naming the person and the two things missing",
   /Jack Ratigan has no phone number and no email address/.test(p.body.refusals?.[0]?.error || ""),
   p.body.refusals);
ok("⚠️ and saying which company it cannot be created on",
   /ODP Care/.test(p.body.refusals?.[0]?.error || ""), p.body.refusals?.[0]?.error);
// ⚠️ THE PROPERTY, NOT THE SENTENCE. This first read
// `/Add a phone number or an email on this record, then transfer/` — the exact
// wording round 133 shipped — and round 134 changed that wording ON PURPOSE,
// because the old one instructed an action the screen did not offer. The
// assertion went red while the app got better, which is the fourth time an
// assertion of mine has been pinned to a literal I then improved.
//
// What must hold, whatever the phrasing: it names BOTH fields, it tells the
// reader to ADD one, and GoHighLevel's own wording stays out of it. Round
// 134's A7 owns the claim about where it points.
ok("🔴 the fix is in the message — add one of the two",
   /\badd\b/i.test(p.body.refusals?.[0]?.detail || "") &&
   /phone/i.test(p.body.refusals?.[0]?.detail || "") &&
   /email/i.test(p.body.refusals?.[0]?.detail || ""),
   p.body.refusals?.[0]?.detail);
ok("⚠️ the words “query parameter” are nowhere near it",
   !/query parameter/i.test(JSON.stringify(p.body)), p.body.refusals);
ok("🔴 AND THE PREFLIGHT WROTE NOTHING", writes().length === 0, writes());

console.log("\n   and pressing Send anyway is refused the same way:");
fresh();
const blocked = await go("o2");
console.log(`  -> ${blocked.status} · ${blocked.body.error}`);
ok("a POST is refused at 409 with `refusal`, not a 400 from GoHighLevel",
   blocked.status === 409 && blocked.body.refusal === true, blocked.body);
ok("🔴 and /contacts/upsert was never called — nothing reached the other company",
   !calls.some((c) => c.acct === "peer" && c.method === "POST"), calls.filter((c) => c.acct === "peer"));

console.log("\nA2 · 🔴 WHICH COPY OF THE CONTACT DID IT ASK?  (stale index says EMPTY)");
// The opportunity's embedded contact has no email; the contact record has one.
S.self.embedded = { c1: { id: "c1", firstName: "Mary", lastName: "Malone", email: "", phone: "" } };
fresh();
p = await pre("o1");
console.log(`  embedded copy: no email · contact record: mary@ex.com`);
console.log(`  canTransfer: ${p.body.canTransfer}`);
ok("🔴 IT TRANSFERS. The contact record is the answer; the search index lags",
   p.body.canTransfer === true, p.body.refusals);
// ⚠️ MY FIRST VERSION OF THIS ONE READ `... === undefined || true`, which is a
// tautology dressed as a check — it could not fail. Written properly, it is the
// assertion that matters more than the boolean above it: the parcel about to be
// SENT carries the contact record's email, not the index's blank.
ok("🔴 and the parcel carries the email the CONTACT has, not the index's blank",
   p.body.parcel?.contact?.email === "mary@ex.com", p.body.parcel?.contact);

console.log("\nA3 · 🔴 AND THE OTHER WAY ROUND  (stale index says an email exists)");
S.self.embedded = { c2: { id: "c2", firstName: "Jack", lastName: "Ratigan", email: "stale@ex.com", phone: "" } };
fresh();
p = await pre("o2");
console.log(`  embedded copy: stale@ex.com · contact record: nothing`);
console.log(`  canTransfer: ${p.body.canTransfer}`);
ok("🔴 IT STILL REFUSES — a stale email is not an email",
   p.body.canTransfer === false, p.body);
ok("⚠️ which is the assertion round 132's code would have failed",
   /no phone number and no email/.test(p.body.refusals?.[0]?.error || ""), p.body.refusals);
S.self.embedded = {};

console.log("\nA4 · ⚠️ ZERO FIELDS IS NOT A REFUSAL");
fresh();
p = await pre("o3");
console.log(`  carried: ${p.body.parcel?.carried.length} · skipped: ${JSON.stringify(p.body.parcel?.skipped.map((s) => s.name))}`);
ok("nothing carries — every answer is in a field the peer does not have",
   p.body.parcel?.carried.length === 0, p.body.parcel?.carried);
ok("🔴 and it is STILL transferable — the person and the case are the point",
   p.body.canTransfer === true, p.body.refusals);
ok("⚠️ the field that did not carry is named, not just counted",
   p.body.parcel?.skipped.some((s) => s.name === "OLTL Waiver Number"), p.body.parcel?.skipped);
fresh();
const zero = await go("o3");
ok("it completes", zero.status === 200 && zero.body.ok === true, zero.body);
ok("⚠️ and the person still arrived", Object.keys(S.peer.contacts).length > 0, S.peer.contacts);

console.log("\nA5 · ⚠️ THE RUNTIME MESSAGE, FOR THE CASE THE PREFLIGHT CANNOT COVER");
// The contact's email is removed between the dialog opening and Send.
const peerMod = await import("../lib/peer.ts");
let thrown = null;
try {
  await peerMod.peerUpsertContact({
    firstName: "Jack", lastName: "Ratigan", email: "", phone: "",
    source: "Transfer", tags: [], customFields: [],
  });
} catch (e) { thrown = e; }
console.log(`  ${thrown?.message}`);
console.log(`  ${thrown?.detail}`);
ok("🔴 it no longer reads as the other company objecting",
   !/ODP Care refused the request/.test(thrown?.message || ""), thrown?.message);
ok("🔴 it says what is actually wrong with the person",
   /no phone number and no email address/.test(thrown?.message || ""), thrown?.message);
ok("⚠️ and explains that this is GoHighLevel's rule on ANY account",
   /will not accept a person with neither, on any account/.test(thrown?.detail || ""), thrown?.detail);
ok("⚠️ the raw wording is kept, in the detail, for anyone who needs it",
   /ODP Care/.test(thrown?.detail || ""), thrown?.detail);

fakeA.close();

// ═══════════════════════════════════════════════════════════════════════════
// PART B — THE SCREEN. 🔴 "THE BUTTON SHOULD BE DISABLED WITH THAT SENTENCE
// BESIDE IT" IS A CLAIM ABOUT PIXELS, SO IT IS READ OFF A RENDERED PAGE.
// ═══════════════════════════════════════════════════════════════════════════
const B = mkState();
const bcalls = [];
const fakeB = makeFake(B, bcalls);
await new Promise((r) => fakeB.listen(0, "127.0.0.1", r));
const fp = fakeB.address().port;

try {
  const stale = execSync("pgrep -f '^next-server' || true").toString().trim();
  for (const pid of stale.split("\n").filter(Boolean))
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
} catch { /* no pgrep */ }
try { rmSync(".next/dev/lock", { force: true }); } catch { /* nothing */ }

const PORT = 3700 + Math.floor(Math.random() * 250);
const dev = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  detached: true,
  env: { ...process.env, GHL_API_BASE: `http://127.0.0.1:${fp}`, GHL_LOCATION_ID: SELF_LOC,
         GHL_PIT: SELF_TOK, GHL_SSO_SECRET: SECRET, PIPELINE_IDS: "sp_oltl,sp_out",
         PEER_PIT: PEER_TOK, PEER_LOCATION_ID: PEER_LOC, PEER_LABEL: "ODP Care" },
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
  try { fakeB.close(); } catch { /* closed */ }
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
    const res = await fetch(`${base}/api/opportunities`, { signal: AbortSignal.timeout(4000) });
    if (res.status === 401 || res.ok) up = true;
  } catch { /* not listening */ }
  if (!up) await new Promise((r) => setTimeout(r, 1000));
}
if (!up) {
  console.log(`dev server never came up on ${PORT}:\n${devLog.join("").slice(-1500)}`);
  process.exit(1);
}
console.log(`\n═══ PART B · THE SCREEN ═══\n  dev server up on ${PORT}`);

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

const openTransfer = async (label) => {
  // ⚠️ DISMISS THE PREVIOUS DIALOG FIRST, AND WAIT FOR IT TO GO. My first
  // version clicked the record panel's `.scrim`, which is UNDERNEATH an open
  // `.previewmodal` — so the click never reached the row, and the wait for
  // `.movebox` then passed instantly against the STALE dialog. That is the
  // shape that makes a browser assertion pass for the wrong reason.
  await frame.evaluate(() => {
    document.querySelector(".previewmodal .previewhead .x")?.click();
  });
  await frame.waitForFunction(() => !document.querySelector(".previewmodal"), { timeout: 10000 });
  await frame.evaluate(() => document.querySelector(".scrim")?.click());
  await page.waitForTimeout(250);
  await frame.evaluate((t) => {
    const tr = [...document.querySelectorAll("tr[data-cid]")]
      .find((x) => x.querySelector(".clname")?.textContent?.trim().startsWith(t));
    tr?.click();
  }, label);
  await frame.waitForSelector(".panel.on .panelfoot", { timeout: 20000 });
  await frame.evaluate(() => {
    const b = [...document.querySelectorAll(".panel.on .panelfoot button")]
      .find((x) => /^Transfer to/.test(x.textContent || ""));
    b?.click();
  });
  await frame.waitForSelector(".previewmodal .movebox", { timeout: 20000 });
  await frame.waitForFunction(
    () => !/Reading both accounts/.test(document.querySelector(".movebox .movebody")?.textContent || ""),
    { timeout: 30000 },
  );
  await page.waitForTimeout(300);
};
const dialog = () => frame.evaluate(() => {
  const box = document.querySelector(".previewmodal .movebox");
  const send = [...(box?.querySelectorAll(".moveacts button") || [])]
    .find((b) => /^Send to/.test(b.textContent || ""));
  const why = box?.querySelector(".tfwhynot");
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right) }; };
  return {
    refusal: box?.querySelector(".tfrefuse")?.textContent?.trim() || null,
    sendDisabled: send ? send.disabled : null,
    sendTitle: send?.getAttribute("title") || null,
    whyNot: why?.textContent?.trim() || null,
    whyBox: rect(why),
    sendBox: rect(send),
    body: box?.querySelector(".movebody")?.textContent || "",
  };
});

console.log("\nB1 · 🔴 JACK RATIGAN — THE BUTTON IS DEAD AND THE REASON IS BESIDE IT");
await openTransfer("Jack Ratigan");
let d = await dialog();
console.log(`  refusal: ${JSON.stringify(d.refusal)}`);
console.log(`  beside the button: ${JSON.stringify(d.whyNot)}`);
console.log(`  send disabled: ${d.sendDisabled}`);
ok("🔴 Send is DISABLED — nobody is allowed to walk into the 400",
   d.sendDisabled === true, d.sendDisabled);
ok("🔴 the amber refusal names the problem and the fix",
   /no phone number and no email address/.test(d.refusal || "") &&
   /\badd\b/i.test(d.refusal || ""), d.refusal);
ok("🔴 AND THE SHORT REASON IS IN THE BUTTON ROW, not only at the top",
   /no phone number and no email address/.test(d.whyNot || ""), d.whyNot);
ok("⚠️ physically beside it — same row, to its left",
   d.whyBox && d.sendBox && Math.abs(d.whyBox.top - d.sendBox.top) < 40 &&
   d.whyBox.left < d.sendBox.left, { why: d.whyBox, send: d.sendBox });
ok("⚠️ and hovering the dead button explains rather than repeating itself",
   /GoHighLevel needs one of them/.test(d.sendTitle || ""), d.sendTitle);
ok("🔴 it is NOT wearing the fault wrapper — no “Something went wrong”",
   !/Something went wrong/i.test(d.body), d.body.slice(0, 200));

console.log("\nB2 · ⚠️ NINA OKAFOR — NOTHING CARRIES, AND IT SAYS SO IN WORDS");
await openTransfer("Nina Okafor");
d = await dialog();
ok("Send is enabled — zero fields is not a refusal", d.sendDisabled === false, d.sendDisabled);
ok("🔴 and the screen says it plainly rather than printing a nought",
   /No custom fields will carry/.test(d.body), d.body.slice(0, 400));
ok("⚠️ naming what still goes, so the reader is not left guessing",
   /The person, the case name, its value and the notes still go/.test(d.body), d.body.slice(0, 400));
ok("⚠️ and the skipped field is still named", /OLTL Waiver Number/.test(d.body), d.body.slice(0, 600));

console.log("\nB3 · ✅ MARY MALONE — THE ORDINARY CASE IS UNCHANGED");
await openTransfer("Mary Malone");
d = await dialog();
ok("Send is live", d.sendDisabled === false, d.sendDisabled);
ok("no refusal is shown", d.refusal === null && d.whyNot === null, d);
ok("⚠️ and the copy that was kept is still there",
   /Never at the stage it left/.test(d.body) &&
   /the evidence of the work done on it/.test(d.body) &&
   /days-in-stage and created-date restart/.test(d.body), d.body.slice(0, 600));

await browser.close();
cleanup();
console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
