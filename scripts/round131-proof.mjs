// ---------------------------------------------------------------------------
// ROUND 131 — THE TWO NAMES.
//
// 🔴 PART A DRIVES THE ROUTES, PART B DRIVES A BROWSER, AND NEITHER READS A
// SOURCE FILE. The brief's first item was reported as a GoHighLevel naming
// fault and turned out to be a template literal in `app/page.tsx` — a symptom
// attributed to the account because the string could not be grepped. So the
// header is not asserted from the code that builds it; it is read off a
// rendered page.
//
// ⚠️ THE FAKE STORES WHAT IT IS SENT, AND ONE TEST MAKES IT NOT.
// GoHighLevel answers 200 to a PUT carrying keys it does not recognise, which
// is the entire reason both rename paths read back. A fake that always stored
// the write could never draw that failure, and the guard would be untested
// decoration. Section A3 and A6 turn storing OFF and assert a 502.
//
// Run: node scripts/round131-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { chromium } from "playwright-core";
import CryptoJS from "crypto-js";

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const HARM = "F_HARM";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};
const sso = (over) => CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Chris Tester", email: "chris@example.com", companyId: "co1", ...over,
}), SECRET).toString();
const ADMIN = sso();
const REP = sso({ userId: "u9", role: "user", type: "account", userName: "Rep" });

// ═══════════════════════════════════════════════════════════════════════════
// THE ACCOUNT. One contact holds TWO cases, in two pipelines — the GoHighLevel
// constraint is one opportunity per contact per pipeline, so this is the only
// shape "shows on every record they hold" can be drawn in.
//
// ⚠️ o2 HAS NO NAME, AND THAT IS NOT A CONVENIENCE. GoHighLevel does not
// require one, `renderRow` has a `r.oppName || clientName(r)` fallback written
// for exactly that record, and it is the one place on the board where a
// CONTACT rename is visible without reloading anything. It is also why the
// rename routes refuse an empty name: this is what the result looks like.
// ═══════════════════════════════════════════════════════════════════════════
const PIPES = [
  { id: "pipe_oltl", name: "OLTL Enrollment" },
  { id: "pipe_pp", name: "Private Pay Enrollment" },
];
const mkState = () => ({
  contacts: {
    c1: { id: "c1", firstName: "Mary", lastName: "Malone", name: "Mary Malone",
          dateUpdated: "2026-09-01T10:00:00.000Z", customFields: [] },
    c2: { id: "c2", firstName: "Bob", lastName: "Vance", name: "Bob Vance",
          dateUpdated: "2026-09-01T10:00:00.000Z", customFields: [] },
  },
  opps: {
    o1: { id: "o1", name: "Mary Malone", pipelineId: "pipe_oltl",
          pipelineStageId: "pipe_oltl_s2", status: "open", assignedTo: "u1",
          updatedAt: "2026-09-01T10:00:00.000Z", customFields: [] },
    o2: { id: "o2", name: "", pipelineId: "pipe_pp",
          pipelineStageId: "pipe_pp_s1", status: "open", assignedTo: "u1",
          updatedAt: "2026-09-01T10:00:00.000Z", customFields: [] },
    o3: { id: "o3", name: "Bob Vance", pipelineId: "pipe_oltl",
          pipelineStageId: "pipe_oltl_s1", status: "open", assignedTo: "u1",
          updatedAt: "2026-09-01T10:00:00.000Z",
          customFields: [{ id: HARM, fieldValue: "HRM-4821" }] },
  },
  contactOf: { o1: "c1", o2: "c1", o3: "c2" },
  /** Flipped off to reproduce GoHighLevel's 200-and-discard. */
  storeWrites: true,
  /** Every write the fake received, so "what was sent" is never inferred. */
  writes: [],
});

function makeFake(S) {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const j = raw ? JSON.parse(raw) : null;
      const u = req.url;
      const path = u.split("?")[0];
      const send = (code, obj) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const withContact = (o) => ({ ...o, contactId: S.contactOf[o.id],
        contact: S.contacts[S.contactOf[o.id]] });

      if (path === `/locations/${LOC}/customFields`)
        return send(200, { customFields: u.includes("model=opportunity")
          ? [{ id: HARM, name: "Harmony ID", dataType: "TEXT" }]
          : [{ id: "CF_NOTE", name: "Client Notes", dataType: "LARGE_TEXT" }] });
      if (path.startsWith("/users/"))
        return send(200, { users: [{ id: "u1", name: "Chris Tester" }] });
      if (path === "/opportunities/pipelines")
        return send(200, { pipelines: PIPES.map((p) => ({ id: p.id, name: p.name,
          stages: [
            { id: `${p.id}_s1`, name: "NEW LEAD", position: 0 },
            { id: `${p.id}_s2`, name: "WAITING FOR DOCS", position: 1 },
          ] })) });
      if (path === `/locations/${LOC}/customValues`)
        return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
          value: JSON.stringify({ seeded: true, folderNames: {},
            pipelines: Object.fromEntries(PIPES.map((p) => [p.id,
              { scope: "client", folders: [] }])) }) }] });

      if (path === "/opportunities/search") {
        const q = new URL(`http://x${u}`).searchParams;
        const pid = q.get("pipeline_id") || "";
        const cid = q.get("contact_id") || "";
        let list = Object.values(S.opps);
        if (pid) list = list.filter((o) => o.pipelineId === pid);
        if (cid) list = list.filter((o) => S.contactOf[o.id] === cid);
        return send(200, { opportunities: list.map(withContact),
          meta: { total: list.length } });
      }
      if (/^\/opportunities\/[^/]+$/.test(path)) {
        const id = path.split("/")[2];
        const o = S.opps[id];
        if (!o) return send(404, { message: "not found" });
        if (req.method === "PUT") {
          S.writes.push({ what: "opportunity", id, body: j });
          // 🔴 200 EITHER WAY. That is the hazard the read-back exists for.
          if (S.storeWrites)
            S.opps[id] = { ...o, ...j, updatedAt: new Date().toISOString() };
          return send(200, { opportunity: withContact(S.opps[id]) });
        }
        return send(200, { opportunity: withContact(o) });
      }
      if (/^\/contacts\/[^/]+\/notes/.test(path))
        return send(200, req.method === "POST" ? { note: { id: "n1" } } : { notes: [] });
      if (/^\/contacts\/[^/]+$/.test(path)) {
        const id = path.split("/")[2];
        const c = S.contacts[id];
        if (!c) return send(404, { message: "not found" });
        if (req.method === "PUT") {
          S.writes.push({ what: "contact", id, body: j });
          if (S.storeWrites)
            S.contacts[id] = { ...c, ...j, dateUpdated: new Date().toISOString() };
          return send(200, { contact: S.contacts[id] });
        }
        return send(200, { contact: c });
      }
      if (path === "/contacts/search") return send(200, { contacts: [], total: 0 });
      send(404, { message: `no fake handler for ${u}` });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PART A — THE ROUTES
// ═══════════════════════════════════════════════════════════════════════════
const S = mkState();
const fakeA = makeFake(S);
await new Promise((r) => fakeA.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${fakeA.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.GHL_SSO_SECRET = SECRET;
process.env.PIPELINE_IDS = PIPES.map((p) => p.id).join(",");

const oppRoute = await import("../app/api/opportunities/[id]/route.ts");
const cfRoute = await import("../app/api/contacts/[id]/fields/route.ts");
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const patchOpp = async (id, body) => {
  const r = await oppRoute.PATCH(new Request(`http://x/api/opportunities/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) }), ctx(id));
  return { status: r.status, body: await r.json() };
};
const patchContact = async (oppId, body) => {
  const r = await cfRoute.PATCH(new Request(`http://x/api/contacts/${oppId}/fields`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify(body) }), ctx(oppId));
  return { status: r.status, body: await r.json() };
};

console.log("\n═══ PART A · THE ROUTES ═══");

console.log("\nA1 · 🔴 THE CASE NAME IS NATIVE, SO IT MUST NOT GO NEAR customFields");
let n = S.writes.length;
let r = await patchOpp("o1", { ssoKey: ADMIN, name: "  Malone — OLTL intake  " });
let w = S.writes[n];
ok("the rename is accepted", r.status === 200 && r.body.ok === true, r);
ok("🔴 GoHighLevel was sent `name`, the key it actually reads",
   w?.what === "opportunity" && w.body.name === "Malone — OLTL intake", w);
ok("⚠️ and NOT a customFields array — a native field has no field id",
   !("customFields" in (w?.body || {})), w?.body);
ok("the surrounding write is untouched: nothing else was sent",
   Object.keys(w?.body || {}).join() === "name", w?.body);
ok("the fresh record comes back renamed", r.body.record?.oppName === "Malone — OLTL intake",
   r.body.record?.oppName);

console.log("\nA2 · 🔴 AN EMPTY NAME IS REFUSED BEFORE ANY WRITE");
n = S.writes.length;
r = await patchOpp("o1", { ssoKey: ADMIN, name: "   " });
ok("it is refused", r.status === 400 && r.body.refusal === true, r);
ok("🔴 and NOTHING reached GoHighLevel — a blank name is unrecoverable from the board",
   S.writes.length === n, S.writes.slice(n));

console.log("\nA3 · 🔴 THE READ-BACK: GOHIGHLEVEL SAYS 200 AND STORES NOTHING");
S.storeWrites = false;
n = S.writes.length;
r = await patchOpp("o1", { ssoKey: ADMIN, name: "Discarded name" });
S.storeWrites = true;
ok("⚠️ the PUT was sent and answered 200", S.writes.length === n + 1, S.writes.slice(n));
ok("🔴 the route still FAILS the request rather than reporting a save",
   r.status === 502, r);
ok("⚠️ and the message names both spellings, so the rep can see what happened",
   /Discarded name/.test(r.body.detail || "") && /Malone — OLTL intake/.test(r.body.detail || ""),
   r.body);

console.log("\nA4 · ⚠️ A REP WHO NEITHER OWNS NOR FOLLOWS CANNOT RENAME EITHER ONE");
n = S.writes.length;
const rr = await patchOpp("o1", { ssoKey: REP, name: "Rep's rename" });
const rc = await patchContact("o1", { ssoKey: REP, name: { firstName: "Rep", lastName: "Rename" } });
ok("the case rename is refused", rr.status === 403, rr);
ok("the person rename is refused", rc.status === 403, rc);
ok("🔴 and neither one wrote anything", S.writes.length === n, S.writes.slice(n));

console.log("\nA5 · 🔴 THE PERSON'S NAME — NATIVE TOO, AND `name` GOES WITH IT");
n = S.writes.length;
r = await patchContact("o1", { ssoKey: ADMIN, name: { firstName: " Marie ", lastName: "Malone" } });
w = S.writes[n];
ok("the rename is accepted", r.status === 200, r);
ok("🔴 it was written to the CONTACT, not the opportunity",
   w?.what === "contact" && w.id === "c1", w);
ok("⚠️ firstName and lastName are trimmed and sent",
   w?.body.firstName === "Marie" && w.body.lastName === "Malone", w?.body);
ok("🔴 and the composed `name` is sent too — GoHighLevel keeps its own copy",
   w?.body.name === "Marie Malone", w?.body);
ok("the route answers with the stored name, for the panel to hold",
   r.body.firstName === "Marie" && r.body.lastName === "Malone", r.body);

console.log("\nA6 · 🔴 THE SAME READ-BACK ON THE CONTACT PATH");
S.storeWrites = false;
r = await patchContact("o1", { ssoKey: ADMIN, name: { firstName: "Ignored", lastName: "Write" } });
S.storeWrites = true;
ok("🔴 a discarded contact write fails the request", r.status === 502, r);
ok("⚠️ and says what was read back instead", /Marie Malone/.test(r.body.detail || ""), r.body);

console.log("\nA7 · 🔴 A PERSON CANNOT BE LEFT NAMELESS");
n = S.writes.length;
r = await patchContact("o1", { ssoKey: ADMIN, name: { firstName: " ", lastName: "" } });
ok("both blank is refused", r.status === 400 && r.body.refusal === true, r);
ok("⚠️ and nothing was written", S.writes.length === n, S.writes.slice(n));
r = await patchContact("o1", { ssoKey: ADMIN, name: { firstName: "Cher", lastName: "" } });
ok("⚠️ but ONE name is a name — a mononym is not a validation failure",
   r.status === 200 && r.body.firstName === "Cher" && r.body.lastName === "", r.body);

console.log("\nA8 · ⚠️ THE READ HANDS THE PANEL A NAME TO SEED THE EDITOR WITH");
const g = await cfRoute.GET(new Request("http://x/api/contacts/o1/fields", {
  headers: { "x-ghl-sso-key": ADMIN } }), ctx("o1"));
const gj = await g.json();
ok("firstName and lastName come back on the contact read",
   gj.firstName === "Cher" && gj.lastName === "", gj);
ok("🔴 and they are NOT in `values` — that map is keyed by custom-field id",
   !Object.values(gj.values || {}).includes("Cher"), gj.values);

fakeA.close();

// ═══════════════════════════════════════════════════════════════════════════
// PART B — THE SCREEN
// ═══════════════════════════════════════════════════════════════════════════
const B = mkState();
const fakeB = makeFake(B);
await new Promise((r2) => fakeB.listen(0, "127.0.0.1", r2));
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
  env: { ...process.env, GHL_API_BASE: `http://127.0.0.1:${fp}`, GHL_LOCATION_ID: LOC,
         GHL_PIT: "pit_test", GHL_SSO_SECRET: SECRET,
         PIPELINE_IDS: PIPES.map((p) => p.id).join(",") },
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
  if (!up) await new Promise((r2) => setTimeout(r2, 1000));
}
if (!up) {
  console.log(`dev server never came up on ${PORT}:`);
  console.log(devLog.join("").slice(-1500));
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
// ⚠️ THE DASHBOARD OPENS ON KANBAN. The list is where a row carries
// `data-cid` — and the row is the only surface where a CONTACT rename is
// visible on a record other than the open one, which section B5 needs.
await frame.waitForSelector(".seg button", { timeout: 90000 });
for (let i = 0; i < 10; i++) {
  await frame.evaluate(() => {
    const b = [...document.querySelectorAll(".seg button")]
      .find((x) => x.textContent?.trim() === "List");
    b?.click();
  });
  await page.waitForTimeout(500);
  if (await frame.$("tr[data-cid]")) break;
}
await frame.waitForSelector("tr[data-cid]", { timeout: 90000 });

const rows = () => frame.evaluate(() => [...document.querySelectorAll("tr[data-cid]")]
  .map((tr) => ({ cid: tr.dataset.cid, label: tr.querySelector(".clname")?.firstChild?.textContent?.trim() })));
const openRow = async (label) => {
  await frame.evaluate((t) => {
    const tr = [...document.querySelectorAll("tr[data-cid]")]
      .find((x) => x.querySelector(".clname")?.textContent?.trim().startsWith(t));
    tr?.click();
  }, label);
  await frame.waitForSelector(".panel.on .phead", { timeout: 20000 });
  await page.waitForTimeout(900); // the contact read is staggered behind notes
};
const head = () => frame.evaluate(() => {
  const h = document.querySelector(".panel.on .phead");
  return {
    heading: h?.querySelector(".inmhead .inmval")?.textContent?.trim() ?? null,
    sub: h?.querySelector(".sub")?.textContent?.trim() ?? null,
    person: h?.querySelector(".inmline .inmval")?.textContent?.trim() ?? null,
    personLabel: h?.querySelector(".inmline .inmwhat")?.textContent?.trim() ?? null,
    all: h?.textContent ?? "",
  };
});

console.log("\nB1 · 🔴 “— new” — THE STRING THE BRIEF PUT IN GOHIGHLEVEL");
await openRow("Mary Malone");
let h = await head();
console.log(`  heading: ${JSON.stringify(h.heading)}`);
console.log(`  sub:     ${JSON.stringify(h.sub)}`);
console.log(`  person:  ${JSON.stringify(h.personLabel)} ${JSON.stringify(h.person)}`);
ok("🔴 the heading reads the case's name and nothing else", h.heading === "Mary Malone", h);
ok("🔴 “— new” is gone from the panel", !/—\s*new/.test(h.all), h.all);
const bodyText = await frame.evaluate(() => document.body.innerText);
ok("🔴 and from the whole page — the record is at WAITING FOR DOCS, not new",
   !/—\s*new\b/.test(bodyText), bodyText.slice(0, 400));
ok("⚠️ the stage is still on screen, in the line under it", /WAITING FOR DOCS/.test(h.sub), h.sub);
ok("⚠️ and a record with no Harmony ID shows no number at all", !/#/.test(h.sub), h.sub);

console.log("\nB2 · ⚠️ WHERE THE HARMONY ID WENT");
await openRow("Bob Vance");
h = await head();
console.log(`  heading: ${JSON.stringify(h.heading)}  sub: ${JSON.stringify(h.sub)}`);
ok("🔴 the heading is the editable name alone", h.heading === "Bob Vance", h);
ok("🔴 the Harmony ID is in the sub-line, still telling two records apart",
   /#4821/.test(h.sub), h.sub);

console.log("\nB3 · 🔴 BOTH NAMES ARE ON SCREEN EVEN WHEN THEY ARE IDENTICAL");
await openRow("Mary Malone");
h = await head();
ok("⚠️ the person's name is shown though it matches the case's exactly",
   h.person === "Mary Malone" && h.heading === "Mary Malone", h);
ok("🔴 and it is labelled, so the two are not one heading repeated",
   /^person$/i.test(h.personLabel || ""), h.personLabel);

console.log("\nB4 · 🔴 CLICK THE NAME, AND THE SCREEN SAYS WHICH ONE");
await frame.click(".panel.on .phead .inmhead .inmbtn");
await frame.waitForSelector(".panel.on .phead .inmedit", { timeout: 10000 });
let ed = await frame.evaluate(() => {
  const e = document.querySelector(".panel.on .phead .inmedit");
  return { scope: e?.querySelector(".inmscope")?.textContent?.trim(),
           boxes: [...e.querySelectorAll(".inminput")].map((i) => i.value),
           focused: document.activeElement?.className };
});
console.log(`  scope: ${JSON.stringify(ed.scope)}  boxes: ${JSON.stringify(ed.boxes)}`);
ok("🔴 the case editor says “This case only”", /This case only/.test(ed.scope || ""), ed);
ok("⚠️ it points at the other one rather than leaving it to be guessed",
   /person's name/i.test(ed.scope || ""), ed.scope);
ok("🔴 one box, holding EXACTLY what the button read",
   ed.boxes.length === 1 && ed.boxes[0] === "Mary Malone", ed.boxes);
ok("⚠️ and it has the focus — “click the name, type” has to mean typing",
   /inminput/.test(ed.focused || ""), ed.focused);

// 🔴 ESCAPE CANCELS THE RENAME — AND NOTHING ELSE. The page has a
// document-level Escape handler that closes the record panel, so before this
// round changing your mind about a spelling also shut the record. Found here,
// by driving the screen; the editor's own handler is correct in isolation.
await frame.press(".panel.on .phead .inminput", "Escape");
await page.waitForTimeout(400);
const afterEsc = await frame.evaluate(() => ({
  panelOpen: !!document.querySelector(".panel.on"),
  editorOpen: !!document.querySelector(".panel.on .phead .inmedit"),
  heading: document.querySelector(".panel.on .phead .inmhead .inmval")?.textContent?.trim(),
}));
ok("🔴 Escape closes the editor and LEAVES THE RECORD OPEN",
   afterEsc.panelOpen && !afterEsc.editorOpen, afterEsc);
ok("⚠️ and the name is back as it was — a cancel that saved would be worse",
   afterEsc.heading === "Mary Malone", afterEsc);

await frame.click(".panel.on .phead .inmline .inmbtn");
await frame.waitForSelector(".panel.on .phead .inmedit", { timeout: 10000 });
ed = await frame.evaluate(() => {
  const e = document.querySelector(".panel.on .phead .inmedit");
  return { scope: e?.querySelector(".inmscope")?.textContent?.trim(),
           boxes: [...e.querySelectorAll(".inminput")].map((i) => i.value) };
});
console.log(`  scope: ${JSON.stringify(ed.scope)}  boxes: ${JSON.stringify(ed.boxes)}`);
ok("🔴 the person editor uses the panel's own wording for the same distinction",
   /About this person, not this case/.test(ed.scope || ""), ed);
ok("⚠️ and says how far it reaches — this contact holds two cases",
   /all 2 of their records/.test(ed.scope || ""), ed.scope);
ok("⚠️ first and last are separate boxes, seeded from the contact",
   ed.boxes.join("|") === "Mary|Malone", ed.boxes);

console.log("\nB5 · 🔴 RENAME THE PERSON — IT MOVES ON EVERY RECORD THEY HOLD");
const before = await rows();
console.log(`  rows before: ${JSON.stringify(before)}`);
let nb = B.writes.length;
await frame.evaluate(() => {
  const i = document.querySelector(".panel.on .phead .inminput");
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  set.call(i, "Marie");
  i.dispatchEvent(new Event("input", { bubbles: true }));
});
await frame.click(".panel.on .phead .inmsave");
await frame.waitForSelector(".panel.on .phead .inmline .inmbtn", { timeout: 20000 });
await page.waitForTimeout(400);
const after = await rows();
h = await head();
console.log(`  rows after:  ${JSON.stringify(after)}`);
const wB = B.writes[nb];
ok("🔴 the write went to the CONTACT", wB?.what === "contact" && wB.id === "c1", wB);
ok("⚠️ carrying firstName, lastName and the composed name",
   wB?.body.firstName === "Marie" && wB.body.lastName === "Malone"
     && wB.body.name === "Marie Malone", wB?.body);
ok("🔴 the person's line now reads the new name", h.person === "Marie Malone", h.person);
ok("🔴 AND THE OTHER CASE'S ROW MOVED WITH IT — the one with no case name of " +
   "its own, which is why it shows the person's",
   after.find((x) => x.label === "Marie Malone"),
   { before: before.map((x) => x.label), after: after.map((x) => x.label) });
ok("🔴 while THIS case's name did not change — the whole point of two controls",
   h.heading === "Mary Malone", h);

console.log("\nB6 · 🔴 RENAME THE CASE — IT MOVES ON THIS RECORD AND NO OTHER");
nb = B.writes.length;
await frame.click(".panel.on .phead .inmhead .inmbtn");
await frame.waitForSelector(".panel.on .phead .inmedit", { timeout: 10000 });
await frame.evaluate(() => {
  const i = document.querySelector(".panel.on .phead .inminput");
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  set.call(i, "Malone — OLTL intake");
  i.dispatchEvent(new Event("input", { bubbles: true }));
});
await frame.press(".panel.on .phead .inminput", "Enter");
await frame.waitForSelector(".panel.on .phead .inmhead .inmbtn", { timeout: 20000 });
await page.waitForTimeout(400);
const after2 = await rows();
h = await head();
console.log(`  rows after:  ${JSON.stringify(after2)}`);
const wC = B.writes[nb];
ok("🔴 the write went to the OPPORTUNITY", wC?.what === "opportunity" && wC.id === "o1", wC);
ok("⚠️ and carried only `name`", Object.keys(wC?.body || {}).join() === "name", wC?.body);
ok("the heading now reads the new case name", h.heading === "Malone — OLTL intake", h);
ok("🔴 the person's name is untouched", h.person === "Marie Malone", h.person);
ok("🔴 and the contact's OTHER case is untouched — one case, one name",
   after2.filter((x) => x.cid === "c1").map((x) => x.label).sort().join("|")
     === "Malone — OLTL intake|Marie Malone",
   after2.filter((x) => x.cid === "c1"));

await browser.close();
cleanup();
console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
