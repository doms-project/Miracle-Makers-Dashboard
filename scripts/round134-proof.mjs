// ---------------------------------------------------------------------------
// ROUND 134 — PHONE AND EMAIL, EDITABLE IN PLACE.
//
// 🔴 THE ASSERTION THAT MATTERS MOST IS NOT "IT SAVES". It is that the
// read-back compares MEANING RATHER THAN TEXT.
//
// GoHighLevel normalises both of these: send "610-555-0101" and it stores
// "+16105550101"; send "Mary@Example.COM" and it stores it lower-cased. Round
// 131's read-back rule is a string comparison, and applied literally here it
// would FAIL A SAVE THAT WORKED — reverting a correct number on screen and
// telling the rep to go and fix it in GoHighLevel, where they would find it
// already correct. That is a worse bug than the one the read-back exists to
// catch, because it fires on the happy path.
//
// ⚠️ SO THE FAKE NORMALISES, THE WAY THE ACCOUNT DOES. A fake that echoed back
// exactly what it was sent could not tell a correct read-back from a broken
// one, and section A2 would pass either way.
//
// Run: npx tsx scripts/round134-proof.mjs
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
const CARE = "cf_care";

const mkState = () => ({
  contacts: {
    c1: { id: "c1", firstName: "Mary", lastName: "Malone", name: "Mary Malone",
      email: "mary@ex.com", phone: "+16105550101",
      dateUpdated: "2026-09-01T10:00:00.000Z", customFields: [{ id: CARE, value: "Days" }] },
    // 🔴 THE RECORD ROUND 133's REFUSAL POINTS AT. Neither field set, so the
    // contact bar's OLD gate would still have shown (he has a name) — but the
    // controls had to exist for the sentence to be true.
    c2: { id: "c2", firstName: "Jack", lastName: "Ratigan", name: "Jack Ratigan",
      email: "", phone: "", dateUpdated: "2026-09-01T10:00:00.000Z", customFields: [] },
  },
  opps: {
    o1: { id: "o1", name: "Mary Malone", pipelineId: "p1", pipelineStageId: "p1_s1",
      status: "open", assignedTo: "u1", updatedAt: "2026-09-01T10:00:00.000Z", customFields: [] },
    o2: { id: "o2", name: "Jack Ratigan", pipelineId: "p1", pipelineStageId: "p1_s1",
      status: "open", assignedTo: "u1", updatedAt: "2026-09-01T10:00:00.000Z", customFields: [] },
    // Mary's SECOND case, so "shows on all N of their records" is a number the
    // fixture can actually produce rather than a sentence nobody checked.
    o3: { id: "o3", name: "Malone — Private Pay", pipelineId: "p2", pipelineStageId: "p2_s1",
      status: "open", assignedTo: "u1", updatedAt: "2026-09-01T10:00:00.000Z", customFields: [] },
  },
  contactOf: { o1: "c1", o2: "c2", o3: "c1" },
  writes: [],
  /** Flipped on to reproduce GoHighLevel's 200-and-store-nothing. */
  dropWrites: false,
});

/**
 * 🔴 GOHIGHLEVEL NORMALISES ON THE WAY IN, AND SO DOES THIS.
 * Verified shape: a US number comes back E.164, an email comes back lower-case.
 * Without this the read-back check in A2 would pass against a fake that simply
 * echoed — which is the harness bug, not the app's.
 */
const ghlNormalise = (c) => ({
  ...c,
  email: String(c.email ?? "").trim().toLowerCase(),
  phone: (() => {
    const d = String(c.phone ?? "").replace(/\D/g, "");
    if (d.length === 10) return `+1${d}`;
    if (d.length === 11 && d.startsWith("1")) return `+${d}`;
    return String(c.phone ?? "").trim();
  })(),
});

function makeFake(S) {
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
      if (path === `/locations/${LOC}/customFields`)
        return send(200, { customFields: q.get("model") === "opportunity"
          ? [] : [{ id: CARE, name: "Care Needs", dataType: "TEXT" }] });
      if (path === "/users/") return send(200, { users: [{ id: "u1", name: "Chris Tester" }] });
      if (path === "/opportunities/pipelines")
        return send(200, { pipelines: [
          { id: "p1", name: "OLTL Enrollment", stages: [{ id: "p1_s1", name: "NEW LEAD", position: 0 }] },
          { id: "p2", name: "Private Pay Clients", stages: [{ id: "p2_s1", name: "NEW LEAD", position: 0 }] },
        ] });
      if (path === `/locations/${LOC}/customValues`)
        return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
          value: JSON.stringify({ seeded: true, folderNames: {},
            pipelines: { p1: { scope: "client", folders: [] }, p2: { scope: "client", folders: [] } } }) }] });
      const withC = (o) => ({ ...o, contactId: S.contactOf[o.id], contact: S.contacts[S.contactOf[o.id]] });
      if (path === "/opportunities/search") {
        const pid = q.get("pipeline_id") || "", cid = q.get("contact_id") || "";
        let list = Object.values(S.opps);
        if (pid) list = list.filter((o) => o.pipelineId === pid);
        if (cid) list = list.filter((o) => S.contactOf[o.id] === cid);
        return send(200, { opportunities: list.map(withC), meta: { total: list.length } });
      }
      if (/^\/opportunities\/[^/]+$/.test(path)) {
        const o = S.opps[path.split("/")[2]];
        if (!o) return send(404, { message: "not found" });
        if (req.method === "PUT") { S.opps[o.id] = { ...o, ...j }; return send(200, { opportunity: withC(S.opps[o.id]) }); }
        return send(200, { opportunity: withC(o) });
      }
      // 🔴 GOHIGHLEVEL'S OWN 400, WORD FOR WORD FROM THE LIVE REFUSAL.
      // A7 asserts that this message is REWRITTEN into something readable, and
      // without this handler the fake 404s instead — so the mapping never runs
      // and the assertion fails for a reason that has nothing to do with the
      // app. My first version had exactly that hole.
      if (path === "/contacts/upsert" && req.method === "POST") {
        if (!j?.email && !j?.phone)
          return send(400, { message: "Pass at least one of number, email query parameter" });
        return send(200, { contact: { id: "p_c1" }, new: true });
      }
      if (/^\/contacts\/[^/]+\/notes$/.test(path)) return send(200, { notes: [] });
      if (/^\/contacts\/[^/]+$/.test(path)) {
        const id = path.split("/")[2];
        const c = S.contacts[id];
        if (!c) return send(404, { message: "not found" });
        if (req.method === "PUT") {
          S.writes.push({ id, body: j });
          // 🔴 200 EITHER WAY — the hazard the read-back exists for.
          if (!S.dropWrites)
            S.contacts[id] = ghlNormalise({ ...c, ...j, dateUpdated: new Date().toISOString() });
          return send(200, { contact: S.contacts[id] });
        }
        return send(200, { contact: c });
      }
      send(404, { message: `no fake handler for ${req.url}` });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PART A — THE ROUTE
// ═══════════════════════════════════════════════════════════════════════════
const S = mkState();
const fakeA = makeFake(S);
await new Promise((r) => fakeA.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${fakeA.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.GHL_SSO_SECRET = SECRET;
process.env.PIPELINE_IDS = "p1,p2";

const cf = await import("../app/api/contacts/[id]/fields/route.ts");
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const patch = async (oppId, body) => {
  const r = await cf.PATCH(new Request(`http://x/api/contacts/${oppId}/fields`, {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoKey: ADMIN, ...body }) }), ctx(oppId));
  return { status: r.status, body: await r.json() };
};
const read = async (oppId) => {
  const r = await cf.GET(new Request(`http://x/api/contacts/${oppId}/fields`, {
    headers: { "x-ghl-sso-key": ADMIN } }), ctx(oppId));
  return await r.json();
};

console.log("\n═══ PART A · THE ROUTE ═══");

console.log("\nA1 · ✅ THE ORDINARY SAVE");
let n = S.writes.length;
let r = await patch("o2", { phone: "610 555 0199" });
console.log(`  -> ${r.status} · stored ${JSON.stringify(r.body.phone)}`);
ok("the phone saves", r.status === 200, r.body);
ok("🔴 written as E.164 by `e164()`, not by a second rule written in the route",
   S.writes[n]?.body.phone === "+16105550199", S.writes[n]?.body);
ok("⚠️ and ONLY `phone` was sent — the email is not in the body at all",
   !("email" in (S.writes[n]?.body || {})) && !("name" in (S.writes[n]?.body || {})),
   S.writes[n]?.body);
ok("the route answers with what GoHighLevel stored, not what was typed",
   r.body.phone === "+16105550199", r.body.phone);

console.log("\nA2 · 🔴 THE READ-BACK COMPARES MEANING, NOT TEXT");
r = await patch("o1", { phone: "(610) 555-0123" });
console.log(`  sent "(610) 555-0123" · stored ${JSON.stringify(r.body.phone)}`);
ok("🔴 a normalising backend does NOT read as a failed save",
   r.status === 200, r.body);
ok("⚠️ even though the stored string is nothing like the typed one",
   r.body.phone === "+16105550123", r.body.phone);
r = await patch("o1", { email: "Mary.Malone@Example.COM" });
console.log(`  sent "Mary.Malone@Example.COM" · stored ${JSON.stringify(r.body.email)}`);
ok("🔴 and a lower-casing backend does not either",
   r.status === 200 && r.body.email === "mary.malone@example.com", r.body);

console.log("\nA3 · 🔴 AND IT STILL CATCHES A WRITE THAT WENT NOWHERE");
S.dropWrites = true;
r = await patch("o1", { phone: "610 555 7777" });
S.dropWrites = false;
console.log(`  -> ${r.status} · ${r.body.error}`);
ok("🔴 a discarded write fails the request", r.status === 502, r.status);
ok("⚠️ naming both the sent and the stored value",
   /610 555 7777/.test(r.body.detail || "") && /6105550123/.test(r.body.detail || ""),
   r.body.detail);

console.log("\nA4 · 🔴 VALIDATION — USEFUL, NOT ANNOYING");
n = S.writes.length;
r = await patch("o1", { email: "not-an-address" });
console.log(`  -> ${r.status} · ${r.body.error}`);
ok("a malformed email is refused HERE, before GoHighLevel's own 400",
   r.status === 400 && r.body.refusal === true, r.body);
ok("⚠️ and the sentence says what one looks like",
   /needs an @ and a dot after it/.test(r.body.detail || ""), r.body.detail);
r = await patch("o1", { phone: "1234" });
ok("a four-digit phone is refused", r.status === 400 && r.body.refusal === true, r.body);
ok("⚠️ against `phoneKey`'s own threshold, not one invented here",
   /at least ten digits/.test(r.body.detail || ""), r.body.detail);
ok("🔴 and neither refusal wrote anything", S.writes.length === n, S.writes.slice(n));

console.log("\n   ⚠️ and the loose cases go through, because they are not our business:");
r = await patch("o1", { email: "a+tag@sub.domain.co.uk" });
ok("a plus-tagged address on a two-part TLD saves",
   r.status === 200 && r.body.email === "a+tag@sub.domain.co.uk", r.body);
r = await patch("o1", { phone: "+44 20 7946 0958" });
ok("🔴 an international number saves EXACTLY AS TYPED — `e164` never guesses",
   r.status === 200 && r.body.phone === "+44 20 7946 0958", r.body.phone);

console.log("\nA5 · ⚠️ CLEARING IS A CORRECTION, NOT AN ERROR");
r = await patch("o1", { phone: "" });
ok("an empty string clears", r.status === 200 && r.body.phone === "", r.body);
ok("⚠️ and the email is untouched by it",
   r.body.email === "a+tag@sub.domain.co.uk", r.body.email);
const back = await read("o1");
ok("🔴 absent ≠ empty: a save that sends neither key changes neither field",
   back.phone === "" && back.email === "a+tag@sub.domain.co.uk", back);

console.log("\nA6 · ⚠️ AND THE TRANSFER'S SENTENCE IS TRUE NOW");
const tr = await import("../app/api/opportunities/[id]/transfer/route.ts");
process.env.PEER_PIT = "pit_peer";
process.env.PEER_LOCATION_ID = "loc_peer";
process.env.PEER_LABEL = "ODP Care";
const tres = await tr.GET(new Request("http://x/t/o2", {
  headers: { "x-ghl-sso-key": ADMIN } }), ctx("o2"));
const tbody = await tres.json();
delete process.env.PEER_PIT;
// o2 is Jack Ratigan — but A1 gave him a phone, so he is transferable now and
// the refusal is not raised. That IS the round: the fix was reachable.
console.log(`  Jack Ratigan now has ${JSON.stringify(S.contacts.c2.phone)}`);
ok("🔴 the record the refusal pointed at is transferable once the panel fixed it",
   S.contacts.c2.phone === "+16105550199", S.contacts.c2);
// ⚠️ NO ASSERTION ON `tbody` HERE. My first draft had one reading `… || true`
// — a tautology, the same fault flagged in round 133 — so it is deleted rather
// than propped up. A7 makes the wording claim properly, against the string.
void tbody;

console.log("\nA7 · ⚠️ THE WORDING, ON BOTH PATHS");
const peer = await import("../lib/peer.ts");
process.env.PEER_PIT = "pit_peer";
let thrown = null;
try {
  await peer.peerUpsertContact({ firstName: "X", lastName: "Y", email: "", phone: "",
    source: "Transfer", tags: [], customFields: [] });
} catch (e) { thrown = e; }
delete process.env.PEER_PIT;
ok("the runtime message points at the panel",
   /editable there/.test(thrown?.detail || ""), thrown?.detail);
ok("🔴 and no longer tells anybody to do something the screen does not offer",
   !/Add a phone number or an email on this record, then transfer/.test(thrown?.detail || ""),
   thrown?.detail);

fakeA.close();

// ═══════════════════════════════════════════════════════════════════════════
// PART B — THE PANEL. "CLICK IT, TYPE, IT SAVES" IS A CLAIM ABOUT A SCREEN.
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
         GHL_PIT: "pit_test", GHL_SSO_SECRET: SECRET, PIPELINE_IDS: "p1,p2" },
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
  console.log(`dev server never came up on ${PORT}:\n${devLog.join("").slice(-1500)}`);
  process.exit(1);
}
console.log(`\n═══ PART B · THE PANEL ═══\n  dev server up on ${PORT}`);

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

const openRow = async (label) => {
  await frame.evaluate(() => document.querySelector(".scrim")?.click());
  await page.waitForTimeout(200);
  await frame.evaluate((t) => {
    const tr = [...document.querySelectorAll("tr[data-cid]")]
      .find((x) => x.querySelector(".clname")?.textContent?.trim().startsWith(t));
    tr?.click();
  }, label);
  await frame.waitForSelector(".panel.on .contactbar", { timeout: 20000 });
  await page.waitForTimeout(1000); // the contact read is staggered behind notes
};
const bar = () => frame.evaluate(() => {
  const rows = [...document.querySelectorAll(".panel.on .contactbar .cbrow .inmline")];
  return rows.map((r) => ({
    what: r.querySelector(".inmwhat")?.textContent?.trim() || null,
    value: r.querySelector(".inmval")?.textContent?.trim() || null,
    isLink: !!r.querySelector("a.inmanchor"),
    href: r.querySelector("a.inmanchor")?.getAttribute("href") || null,
    hasPencil: !!r.querySelector(".inmpenbtn"),
  }));
});

console.log("\nB1 · 🔴 JACK RATIGAN — THE EMPTY STATE IS THE BUTTON");
await openRow("Jack Ratigan");
let b = await bar();
console.log(`  ${JSON.stringify(b)}`);
ok("both controls are on screen", b.length === 2, b);
ok("🔴 the phone reads “No phone” and is a BUTTON, not a dead link",
   b[0].what === "Phone" && b[0].value === "No phone" && !b[0].isLink, b[0]);
ok("🔴 the email likewise", b[1].what === "Email" && b[1].value === "No email" && !b[1].isLink, b[1]);

console.log("\n   click it, type, save — the sentence round 133 wrote:");
await frame.click(".panel.on .contactbar .cbrow .inmline:first-child .inmbtn");
await frame.waitForSelector(".panel.on .contactbar .inmedit", { timeout: 10000 });
const scope = await frame.evaluate(() =>
  document.querySelector(".panel.on .contactbar .inmscope")?.textContent?.trim());
console.log(`  scope: ${JSON.stringify(scope)}`);
ok("⚠️ it says which scope, in the panel's own words",
   /About this person, not this case/.test(scope || ""), scope);
ok("⚠️ and Jack holds one record, so it says so that way",
   /follows them onto every record they hold/.test(scope || ""), scope);
await frame.evaluate(() => {
  const i = document.querySelector(".panel.on .contactbar .inminput");
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  set.call(i, "610 555 0177");
  i.dispatchEvent(new Event("input", { bubbles: true }));
});
await frame.click(".panel.on .contactbar .inmsave");
await frame.waitForFunction(
  () => !document.querySelector(".panel.on .contactbar .inmedit"), { timeout: 20000 });
await page.waitForTimeout(300);
b = await bar();
console.log(`  ${JSON.stringify(b[0])}`);
ok("🔴 IT SAVED", B.contacts.c2.phone === "+16105550177", B.contacts.c2);
ok("🔴 and the panel shows WHAT WAS STORED, not what was typed",
   b[0].value === "+16105550177", b[0]);
ok("⚠️ it is a tel: link now, because there is a number to dial",
   b[0].isLink && /^tel:\+16105550177$/.test(b[0].href || ""), b[0]);
ok("⚠️ with the pencil beside it, so the link is not lost to the editor",
   b[0].hasPencil === true, b[0]);

console.log("\nB2 · ⚠️ MARY MALONE — TWO RECORDS, AND THE SENTENCE SAYS SO");
await openRow("Mary Malone");
b = await bar();
console.log(`  ${JSON.stringify(b)}`);
ok("her phone is a link and her email is a link",
   b[0].isLink && b[1].isLink, b);
ok("⚠️ mailto: on the email", /^mailto:mary@ex\.com$/.test(b[1].href || ""), b[1]);
await frame.click(".panel.on .contactbar .cbrow .inmline:nth-child(2) .inmpenbtn");
await frame.waitForSelector(".panel.on .contactbar .inmedit", { timeout: 10000 });
const scope2 = await frame.evaluate(() =>
  document.querySelector(".panel.on .contactbar .inmscope")?.textContent?.trim());
console.log(`  scope: ${JSON.stringify(scope2)}`);
ok("🔴 the pencil opens the editor — the link did not have to be sacrificed",
   !!scope2, scope2);
ok("🔴 and it counts her records: this shows on all 2 of them",
   /all 2 of their records/.test(scope2 || ""), scope2);

console.log("\n   a malformed address is refused in the panel, in words:");
await frame.evaluate(() => {
  const i = document.querySelector(".panel.on .contactbar .inminput");
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  set.call(i, "nonsense");
  i.dispatchEvent(new Event("input", { bubbles: true }));
});
await frame.click(".panel.on .contactbar .inmsave");
await page.waitForTimeout(1200);
const errText = await frame.evaluate(() =>
  document.querySelector(".panel.on .contactbar .inmedit")?.textContent || "");
ok("🔴 the editor STAYS OPEN on a refusal — the typing is not thrown away",
   !!(await frame.$(".panel.on .contactbar .inmedit")), "it closed");
ok("⚠️ and says what an address looks like", /is not an email address/.test(errText), errText.slice(0, 300));
ok("🔴 nothing was stored", B.contacts.c1.email === "mary@ex.com", B.contacts.c1.email);

await browser.close();
cleanup();
console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
