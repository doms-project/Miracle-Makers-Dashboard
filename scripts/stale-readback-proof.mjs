// ---------------------------------------------------------------------------
// ROUND 156 — A READ-BACK MAY CONFIRM A SUCCESS, NEVER ESTABLISH A FAILURE.
//
// 🔴 THE FINDING THAT FORCED THIS. Trimming 24 GoHighLevel seats' permissions,
// 17 of 27 read back UNCHANGED one second after a 200 — and all 27 were
// correct minutes later. GoHighLevel applies some writes asynchronously, like
// the delete endpoint's own "will take effect in a few minutes".
//
// So every read-after-write in this tree can see the PRE-write value, and the
// two places that treated disagreement as failure were reporting a working
// write as broken — which sends a rep to redo something that worked. The
// mirror of the bug round 151 fixed.
//
// ⚠️ WHAT IS UNDER TEST HERE IS THE ASYMMETRY, NOT THE READ-BACK. The write's
// own ECHO still throws — `addOpportunityFollowers` judges GoHighLevel's own
// response and that cannot be stale. Only the later READ is demoted.
//
//   the route          a disagreeing read-back is `confirmed:false`, not 502
//   setContactOwner    warns rather than throwing
//
// Run: node scripts/stale-readback-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import CryptoJS from "crypto-js";

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const PIPE = "pipe_oltl";
const OWNER = "u_owner", NEWF = "u_newfollower", OTHER = "u_other";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const BLOB = CryptoJS.AES.encrypt(JSON.stringify({
  userId: OWNER, role: "admin", type: "agency", activeLocation: LOC,
  userName: "Owner", email: "owner@mm.com", companyId: "co1",
}), SECRET).toString();

/** 🔴 THE WHOLE POINT: the GET lags the POST. */
let staleReadback = false;
let refuseEcho = false;
let contactOwner = OTHER;
let contactOwnerLags = false;
let opp;
const reset = () => {
  staleReadback = false; refuseEcho = false;
  contactOwner = OTHER; contactOwnerLags = false;
  opp = {
    id: "o1", name: "A Case", pipelineId: PIPE, pipelineStageId: "s1",
    status: "open", assignedTo: OWNER, contactId: "c1",
    updatedAt: "2026-09-01T10:00:00.000Z", followers: [], customFields: [],
  };
};
reset();

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : null;
    const [path] = req.url.split("?");
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (path.startsWith(`/locations/${LOC}/customFields`)) return send(200, { customFields: [] });
    if (path === "/users/")
      return send(200, { users: [OWNER, NEWF, OTHER].map((id) => ({ id, name: id })) });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [{ id: PIPE, name: "OLTL Enrollment",
        stages: [{ id: "s1", name: "NEW LEAD", position: 0 }] }] });
    if (path.startsWith(`/locations/${LOC}/customValues`))
      // 🔴 A REAL STORED CONFIG, NOT AN EMPTY LIST — ROUND 149's LESSON, THIRD
      // TIME. An empty `customValues` makes getPipelineConfig find nothing, try
      // to SEED the value, fail to read its own write back through a fake that
      // does not implement the write, and throw before falling back to the env
      // list. That took 3.0s per request, which is exactly what the wait loop
      // was timing out on — and it also means the route was exercising the env
      // fallback rather than the stored-config path production uses.
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({ seeded: true, folderNames: {},
          pipelines: { [PIPE]: { scope: "client", folders: [] } } }) }] });
    if (path.startsWith("/opportunities/search"))
      return send(200, { opportunities: [opp], meta: { total: 1 } });
    if (path === "/contacts/search") return send(200, { contacts: [], total: 0 });

    if (path === "/opportunities/o1/followers") {
      const ids = (j?.followers || []).filter(Boolean);
      if (req.method === "POST") {
        // 🔴 THE ECHO SAYS IT LANDED — and it really did. This is the case the
        // route must NOT report as a failure.
        if (!refuseEcho) opp.followers = [...new Set([...opp.followers, ...ids])];
        return send(200, refuseEcho
          ? { followers: [], followersAdded: [[]] }      // a real refusal
          : { followersAdded: [ids] });                   // the probed success
      }
      opp.followers = opp.followers.filter((f) => !ids.includes(f));
      return send(200, { followers: [], followersRemoved: ids });
    }
    if (path === "/opportunities/o1") {
      if (req.method === "PUT") return send(200, { opportunity: opp });
      // ⚠️ THE STALE READ: the record as it was before the follower write.
      if (staleReadback) return send(200, { opportunity: { ...opp, followers: [] } });
      return send(200, { opportunity: opp });
    }
    if (/^\/contacts\/[^/]+$/.test(path)) {
      if (req.method === "PUT") {
        // The write lands, but the next read lags behind it.
        if (!contactOwnerLags) contactOwner = String(j?.assignedTo || contactOwner);
        return send(200, { contact: { id: "c1" } });
      }
      return send(200, { contact: { id: "c1", assignedTo: contactOwner, customFields: [] } });
    }
    send(404, { message: `no fake handler for ${req.url}` });
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fp = fake.address().port;

// ── PART A · setContactOwner, by direct import ────────────────────────────
process.env.GHL_API_BASE = `http://127.0.0.1:${fp}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.PIPELINE_IDS = PIPE;
const ghl = await import("../lib/ghl.ts");

console.log("\n═══ 1 · 🔴 setContactOwner WARNS ON A LAGGING READ, IT DOES NOT THROW ═══");
reset();
contactOwnerLags = true;           // the PUT succeeds upstream; the GET lags
let threw = null;
try { await ghl.setContactOwner("c1", OWNER); } catch (e) { threw = e; }
console.log(`  read-back said: ${contactOwner}  (we wrote ${OWNER})`);
ok("🔴 it does NOT throw — the promote path stands", threw === null,
   threw instanceof Error ? threw.message : threw);
// ⚠️ THE CONTROL. Without it this passes on a function that has stopped doing
// anything at all, including the write.
reset();
await ghl.setContactOwner("c1", OWNER);
ok("🔴 THE CONTROL — when the read is current the owner really was written",
   contactOwner === OWNER, contactOwner);

// ── PART B · the followers route, through a dev server ────────────────────
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
         GHL_PIT: "pit_test", GHL_SSO_SECRET: SECRET, PIPELINE_IDS: PIPE },
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
// ⚠️ THE WAIT LOOP SAYS WHAT IT IS SEEING. The first version of this file was
// killed by its own timeout inside this loop having printed NOTHING — 400
// seconds that told me only that something was wrong, not what. A silent
// retry loop is the operator-side version of a proof with no tally.
let up = false;
let lastSeen = "no response at all";
for (let i = 0; i < 90 && !up; i++) {
  try {
    const r = await fetch(`${base}/api/opportunities`, { signal: AbortSignal.timeout(15000) });
    lastSeen = `HTTP ${r.status}`;
    if (r.status === 401 || r.ok) up = true;
    else if (i % 10 === 0) lastSeen += ` — ${(await r.text()).slice(0, 200)}`;
  } catch (e) {
    lastSeen = e instanceof Error ? e.message : String(e);
  }
  if (!up) {
    if (i % 10 === 0) console.log(`  …waiting for the dev server (attempt ${i}): ${lastSeen}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!up) {
  console.log(`dev server never usable on ${PORT}. Last: ${lastSeen}`);
  console.log(devLog.join("").slice(-2000));
  cleanup();
  process.exit(1);
}
console.log(`  dev server up on ${PORT}`);

const patchFollowers = async (add) => {
  const r = await fetch(`${base}/api/opportunities/o1/followers`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ssoKey: BLOB, add }),
    cache: "no-store",
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

console.log("\n═══ 2 · 🔴 A STALE READ-BACK IS `unconfirmed`, NOT A 502 ═══");
reset();
staleReadback = true;
let r = await patchFollowers([NEWF]);
console.log(`  -> ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
ok("🔴 NOT a 502 — the rep is not told their change failed", r.status === 200, r.status);
ok("🔴 and it says so rather than claiming certainty", r.body.confirmed === false, r.body);
ok("⚠️ naming the id it could not confirm",
   (r.body.unconfirmed || []).includes(NEWF), r.body.unconfirmed);
// 🔴 THE FOLLOWER IS IN THE ANSWER. The echo vouched for the write, so what we
// asked for is a better description of the record than a read that has not
// caught up — and the chip must not vanish, which was the original symptom.
ok("🔴 the follower is still listed — the chip does not vanish",
   (r.body.followers || []).includes(NEWF), r.body.followers);
ok("⚠️ and upstream it really did land", opp.followers.includes(NEWF), opp.followers);

console.log("\n═══ 3 · 🔴 THE CONTROL — A REAL REFUSAL STILL FAILS LOUDLY ═══");
// If everything became "unconfirmed" the change above would be indistinguishable
// from switching the defence off. The ECHO is what still throws, and it is not
// a read, so staleness cannot reach it.
reset();
refuseEcho = true;
r = await patchFollowers([NEWF]);
console.log(`  -> ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
ok("🔴 a write GoHighLevel really refused is still an error", r.status >= 400, r.status);
ok("🔴 and the message names the sharing setting",
   /shared with selected users/.test(JSON.stringify(r.body)), r.body);
ok("⚠️ nothing landed upstream, which is what made it a refusal",
   !opp.followers.includes(NEWF), opp.followers);

console.log("\n═══ 4 · ⚠️ AND A CURRENT READ STILL REPORTS CONFIRMED ═══");
reset();
r = await patchFollowers([NEWF]);
ok("confirmed is true when the read-back agrees", r.body.confirmed === true, r.body);
ok("⚠️ and `unconfirmed` is absent rather than empty",
   r.body.unconfirmed === undefined, r.body.unconfirmed);

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
cleanup();
process.exit(fail ? 1 : 0);
