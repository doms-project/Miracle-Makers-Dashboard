// ---------------------------------------------------------------------------
// ROUND 111 · THE 401 CARD THAT SAT BESIDE 595 RECORDS.
//
// 🔴 THE REPORTED SHAPE, REPRODUCED — not approximated:
//
//   · the dashboard INSIDE AN IFRAME, with a parent that answers REQUEST_USER_DATA
//     with a real encrypted blob (so `sso.blob` exists and `embedded` is true);
//   · a decrypt that is SLOW, so there is a real window in which the blob has
//     arrived and `status` is still "loading" — the exact window in which the
//     old code fell through to an UNAUTHENTICATED GET;
//   · records loaded and drawn;
//   · then a 401 whose body is byte-for-byte the one /api/opportunities really
//     sends, arriving AFTER the successful load.
//
// It asserts on what is ON SCREEN — bounding boxes and body text — because the
// bug was never arithmetic. Two true statements were rendered at once:
// "595 shown · 595 in All pipelines" above, "no SSO session was provided" below.
//
// Run: node scripts/stale-error-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { chromium } from "playwright-core";
import CryptoJS from "crypto-js";

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const PIPE = "pipe_oltl";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

// The blob the parent frame hands over. Same cipher lib and same passphrase the
// server decrypts with, so this is a REAL credential, not a stub.
const SESSION = {
  userId: "u1",
  role: "admin",
  type: "agency",
  activeLocation: LOC,
  userName: "Chris Tester",
  email: "chris@example.com",
  companyId: "co1",
};
const BLOB = CryptoJS.AES.encrypt(JSON.stringify(SESSION), SECRET).toString();

// 12 client records — enough that "the rows are still drawn" is a visible fact.
const OPPS = Array.from({ length: 12 }, (_, i) => ({
  id: `o${i + 1}`,
  name: `Family ${i + 1}`,
  pipelineId: PIPE,
  pipelineStageId: "s1",
  status: "open",
  monetaryValue: 1000 * (i + 1),
  createdAt: new Date(Date.now() - i * 86400000).toISOString(),
  contact: { id: `c${i + 1}`, firstName: "First", lastName: `Last${i + 1}` },
}));

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = req.url;
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.startsWith(`/locations/${LOC}/customFields`))
      return send(200, { customFields: [] });
    if (u.startsWith("/users/"))
      return send(200, { users: [{ id: "u1", name: "Chris Tester" }] });
    if (u.startsWith("/opportunities/pipelines"))
      return send(200, {
        pipelines: [{ id: PIPE, name: "OLTL Enrollment", stages: [{ id: "s1", name: "INITIAL CALL" }] }],
      });
    if (u.startsWith(`/locations/${LOC}/customValues`))
      return send(200, {
        customValues: [{ id: "cv1", name: "MM Pipeline Folders", value: JSON.stringify({
          seeded: true, pipelines: { [PIPE]: { scope: "client", folders: [] } }, folderNames: {},
        })}],
      });
    if (u.startsWith("/opportunities/search"))
      return send(200, { opportunities: OPPS, meta: { total: OPPS.length } });
    if (u === "/contacts/search") return send(200, { contacts: [], total: 0 });
    send(404, { message: `no fake handler for ${u}` });
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fp = fake.address().port;

// 🔴 NEXT 16 ALLOWS ONE DEV SERVER PER DIRECTORY, not per port — and it records
// the owner in .next/dev/lock. A run killed by `timeout` leaves that server
// alive, and EVERY later run then dies with "Another next dev server is already
// running" no matter which port it picks. Worse, the process retitles itself to
// `next-server`, so `pkill -f "next dev"` never finds it. Clear both before
// spawning; this is the difference between a harness you can re-run and one
// that works exactly once.
try {
  const stale = execSync("pgrep -f '^next-server' || true").toString().trim();
  for (const pid of stale.split("\n").filter(Boolean)) {
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* already gone */ }
  }
  if (stale) console.log(`  cleared stale next-server: ${stale.replace(/\n/g, ", ")}`);
} catch { /* pgrep absent */ }
try { rmSync(".next/dev/lock", { force: true }); } catch { /* nothing to clear */ }

// ⚠️ A FRESH PORT EVERY RUN, AND A DEV SERVER THAT CANNOT OUTLIVE THE HARNESS.
// A fixed port plus a kill on the happy path only meant that any run ended by
// `timeout` left `next dev` holding the port — and the NEXT run then sat in the
// wait-for-server loop until it too timed out, looking like a hang. Own process
// group, killed from an exit hook, on a port nobody else has.
const PORT = 3700 + Math.floor(Math.random() * 250);
const dev = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  detached: true,
  env: {
    ...process.env,
    GHL_API_BASE: `http://127.0.0.1:${fp}`,
    GHL_LOCATION_ID: LOC,
    GHL_PIT: "pit_test",
    GHL_SSO_SECRET: SECRET,
    PIPELINE_IDS: PIPE,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
// Keep the dev server's own output — swallowing it meant a server that refused
// to start looked identical to one that was merely slow.
const devLog = [];
dev.stdout.on("data", (d) => devLog.push(String(d)));
dev.stderr.on("data", (d) => devLog.push(String(d)));

let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { process.kill(-dev.pid, "SIGKILL"); } catch { /* already gone */ }
  try { fake.close(); } catch { /* already closed */ }
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(sig, () => { cleanup(); process.exit(130); });
process.on("uncaughtException", (e) => { console.log(`\n🔴 ${e.message}`); cleanup(); process.exit(1); });

// localhost, NOT 127.0.0.1 — Next 16 answers 403 to cross-origin dev assets, so
// a browser on the other spelling gets no client JS at all. See report 110.
const base = `http://localhost:${PORT}`;
let up = false;
for (let i = 0; i < 120 && !up; i++) {
  try {
    const r = await fetch(`${base}/api/opportunities`, { signal: AbortSignal.timeout(4000) });
    // 401 is a perfectly good "the server is answering" — SSO is configured.
    if (r.status === 401 || r.ok) up = true;
  } catch { /* not listening yet */ }
  // ⚠️ SLEEP ON EVERY PATH. It only slept in the catch, so while the server was
  // listening but still compiling (500s, not 401s) the loop span through all its
  // attempts in a couple of seconds and declared the server dead.
  if (!up) await new Promise((r) => setTimeout(r, 1000));
}
if (!up) {
  console.log(`dev server never came up on ${PORT}. Its output:`);
  console.log(devLog.join("").slice(-2500) || "(nothing at all)");
  process.exit(1);
}
console.log(`  dev server up on ${PORT}`);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-proxy-server", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));

// ── the observation log ────────────────────────────────────────────────────
const oppReqs = [];
const t0 = Date.now();
let decryptHeldAt = null;
let decryptDoneAt = null;
/** Flipped to make the NEXT /api/opportunities answer the real 401 body. */
let failNext = false;

// 🔴 THE SLOW DECRYPT. This is the whole point of the harness: it holds the
// window open in which the blob exists and `status` is still "loading".
page.on("request", (r) => {
  if (r.url().includes("/api/decrypt-sso"))
    console.log(`  [decrypt-sso requested at t+${Date.now() - t0}ms]`);
});
await page.route(
  (u) => u.pathname === "/api/decrypt-sso",
  async (route) => {
    if (decryptHeldAt === null) decryptHeldAt = Date.now() - t0;
    console.log(`  [decrypt-sso HELD at t+${Date.now() - t0}ms]`);
    await new Promise((r) => setTimeout(r, 2500));
    decryptDoneAt = Date.now() - t0;
    console.log(`  [decrypt-sso RELEASED at t+${decryptDoneAt}ms]`);
    await route.continue();
  },
);

await page.route("**/api/opportunities**", async (route) => {
  const req = route.request();
  const post = req.postData() || "";
  oppReqs.push({
    at: Date.now() - t0,
    method: req.method(),
    hasSsoKey: post.includes("ssoKey"),
    hasHeader: !!req.headers()["x-ghl-sso-key"],
    // 🔴 THE FACT THE WHOLE ROUND TURNS ON, recorded at the instant the request
    // is issued rather than inferred afterwards: the decrypt had been asked for
    // and had NOT come back, so `sso.status` was still "loading" and only
    // `sso.blob` existed. That is the window the old code answered with an
    // unauthenticated GET.
    decryptStillPending: decryptHeldAt !== null && decryptDoneAt === null,
  });
  if (failNext) {
    failNext = false;
    // ⚠️ THE REAL BODY. Copied from app/api/opportunities/route.ts:113-119 —
    // if that text ever changes, this proof should be updated with it, not
    // around it.
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Sign-in required.",
        detail: "Open this dashboard inside GoHighLevel — no SSO session was provided.",
        status: 401,
      }),
    });
  }
  await route.continue();
});

// The parent frame: a real GHL-shaped responder, served on the SAME origin so
// Next's dev-asset check is satisfied inside the iframe.
await page.route(`${base}/__parent`, (route) =>
  route.fulfill({
    status: 200,
    contentType: "text/html",
    body: `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0}iframe{border:0;width:1440px;height:950px}</style>
<script>
  window.addEventListener("message", (e) => {
    if (e.data && e.data.message === "REQUEST_USER_DATA") {
      e.source.postMessage({ message: "REQUEST_USER_DATA_RESPONSE",
                             payload: ${JSON.stringify(BLOB)} }, "*");
    }
  });
</script>
<iframe src="${base}/"></iframe>`,
  }),
);

await page.goto(`${base}/__parent`, { waitUntil: "domcontentloaded" });
const frame = await (await page.waitForSelector("iframe")).contentFrame();

// ── 1 · THE CREDENTIAL ─────────────────────────────────────────────────────
console.log("\n1 · 🔴 DOES THE REQUEST CARRY THE BLOB BEFORE THE DECRYPT LANDS?");
// ⚠️ THE DEFAULT VIEW IS THE KANBAN, NOT THE LIST — `useState("board")`. The
// first version of this harness waited for `table tbody tr` and timed out on a
// page that had loaded all 12 records perfectly. The count line said so
// ("12 shown · 12 in All pipelines") while the row count said 0. That is the
// harness being wrong about the app, and it is exactly the mistake round 110
// warned about: assert on what the screen actually draws.
await frame.waitForSelector(".seg button", { timeout: 90000 });
await frame.waitForFunction(
  () => (document.querySelector(".count")?.textContent || "").includes("shown"),
  { timeout: 90000 },
);
for (let i = 0; i < 10; i++) {
  await frame.click('.seg button:has-text("List")');
  await page.waitForTimeout(400);
  if (await frame.$("table tbody tr")) break;
}
await frame.waitForSelector("table tbody tr", { timeout: 30000 });
await frame.waitForFunction(
  () => !document.querySelector(".statewrap .spinner"),
  { timeout: 90000 },
);
console.log(`  decrypt-sso first held at t+${decryptHeldAt}ms, released at t+${decryptDoneAt}ms`);
console.log(`  /api/opportunities requests: ${JSON.stringify(oppReqs)}`);
const first = oppReqs[0];
// ⚠️ Asserted from a flag stamped ON the request, not from comparing against a
// release time that has not happened yet — the first version of this check
// compared `first.at < decryptDoneAt` while decryptDoneAt was still null, and
// failed for its own reason on a run where the code was doing the right thing.
ok("🔴 a load fired while the decrypt was STILL PENDING — status was 'loading'",
   !!first && first.decryptStillPending, { first, decryptHeldAt, decryptDoneAt });
ok("🔴 and it carried the credential — POST with ssoKey",
   !!first && first.method === "POST" && first.hasSsoKey, first);
ok("no unauthenticated request was made at all",
   oppReqs.every((r) => r.hasSsoKey || r.hasHeader), oppReqs);

// ── 2 · THE RECORDS ARE DRAWN ──────────────────────────────────────────────
console.log("\n2 · THE RECORDS LOAD AND DRAW");
const boxes = (sel) =>
  frame.$$eval(sel, (els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x),
               onScreen: r.width > 0 && r.height > 0 && r.x < window.innerWidth && r.x + r.width > 0 };
    }),
  );
const before = await boxes("table tbody tr");
const countBefore = (await frame.textContent(".count"))?.trim().replace(/\s+/g, " ");
console.log(`  rows on screen: ${before.length}   first box: ${JSON.stringify(before[0] || null)}`);
console.log(`  count line: "${countBefore}"`);
ok("twelve rows are drawn", before.length === 12, before.length);
ok("every row is ON SCREEN", before.length > 0 && before.every((r) => r.onScreen), before);
ok("no error card while the load succeeded",
   !(await frame.$(".statecard")), await frame.textContent("body").then((t) => t.slice(0, 120)));

// ── 3 · THE 401 AFTER A SUCCESSFUL LOAD — THE REPORTED SYMPTOM ─────────────
console.log("\n3 · 🔴 A 401 ARRIVES AFTER THE RECORDS ARE ON SCREEN");
failNext = true;
await frame.click('button[title="Re-read everything from GoHighLevel"]');
await frame.waitForSelector(".loadwarn", { timeout: 30000 });
await frame.waitForFunction(
  () => !document.querySelector(".statewrap .spinner"),
  { timeout: 30000 },
);
const after = await boxes("table tbody tr");
const countAfter = (await frame.textContent(".count"))?.trim().replace(/\s+/g, " ");
const bodyText = (await frame.textContent("body")).replace(/\s+/g, " ");
const strip = (await frame.textContent(".loadwarn"))?.trim().replace(/\s+/g, " ");
console.log(`  rows on screen: ${after.length}   count line: "${countAfter}"`);
console.log(`  strip: "${strip?.slice(0, 190)}"`);
ok("🔴 THE RECORDS ARE STILL ON SCREEN — a failed refresh is not a lost dashboard",
   after.length === 12 && after.every((r) => r.onScreen), after.length);
ok("the count line is unchanged", countAfter === countBefore, { countBefore, countAfter });
ok("🔴 NO full-screen error card beside them",
   !(await frame.$(".statecard")), strip);
ok("a strip says the REFRESH failed", /Couldn.t refresh/.test(strip || ""), strip);
ok("🔴 the false sentence is NOWHERE on the page",
   !/no SSO session was provided/.test(bodyText),
   bodyText.match(/.{0,80}no SSO session was provided.{0,40}/)?.[0]);
ok("and it is replaced by one that is true of a page holding a blob",
   /didn.t accept this session/.test(strip || ""), strip);

await page.screenshot({ path: "scripts/stale-error.png", fullPage: false });

// ── 4 · A SUCCESSFUL REFRESH CLEARS IT, AND NEVER BLANKS THE SCREEN ────────
//
// 🔴 THIS ASSERTION FOUND A SECOND BUG, and it is the same one wearing a
// different hat: pressing Refresh over loaded records replaced every one of
// them with a full-screen "Loading opportunities…" until the request came back.
// A transient fact about the REQUEST taking the slot that belongs to the DATA.
// So the check is not "are the rows back afterwards" — it is "did they ever
// leave", sampled while the request is in flight.
console.log("\n4 · THE NEXT SUCCESS CLEARS THE STRIP — WITHOUT BLANKING IT FIRST");
let lowest = 12;
const watch = setInterval(async () => {
  const n = await frame.$$eval("table tbody tr", (e) => e.length).catch(() => 12);
  if (n < lowest) lowest = n;
}, 40);
await frame.click('button[title="Re-read everything from GoHighLevel"]');
await frame.waitForFunction(() => !document.querySelector(".loadwarn"), { timeout: 30000 });
await frame.waitForFunction(
  () => !/Refreshing/.test(document.body.textContent || ""),
  { timeout: 30000 },
);
clearInterval(watch);
const rowsEnd = await boxes("table tbody tr");
console.log(`  fewest rows seen at any point during the refresh: ${lowest}`);
ok("the strip is gone after a success", !(await frame.$(".loadwarn")), null);
ok("the rows are still there", rowsEnd.length === 12, rowsEnd.length);
ok("🔴 and they never went away mid-refresh", lowest === 12, lowest);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
