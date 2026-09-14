// ---------------------------------------------------------------------------
// ROUND 117 · ITEM 2 — A 429 IS NOT AN ERROR. RETRY IT SILENTLY.
//
// 🔴 A FAKE GOHIGHLEVEL THAT ACTUALLY RETURNS 429s, with the REAL headers the
// owner measured live against this account on a PIT:
//
//   x-ratelimit-max 100 · x-ratelimit-remaining 99
//   x-ratelimit-interval-milliseconds 10000
//   x-ratelimit-limit-daily 200000 · x-ratelimit-daily-remaining 198091
//
// ⚠️ AND IT COUNTS THE REQUESTS IT RECEIVES, because "retried silently" and
// "failed silently" look identical from the outside. Every assertion below is
// about what the SERVER saw.
//
// Run: GHL_PIT=pit_test GHL_LOCATION_ID=loc_test npx tsx scripts/ratelimit-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

// How many 429s each path should emit before succeeding, and what it saw.
const plan = new Map();
const seen = new Map();

const RL = (remaining) => ({
  "x-ratelimit-max": "100",
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-interval-milliseconds": "10000",
  "x-ratelimit-limit-daily": "200000",
  "x-ratelimit-daily-remaining": "198091",
});

const server = http.createServer((req, res) => {
  const key = `${req.method} ${req.url.split("?")[0]}`;
  seen.set(key, (seen.get(key) || 0) + 1);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const left = plan.get(key) ?? 0;
    if (left > 0) {
      plan.set(key, left - 1);
      // ⚠️ THE HEADERS COME BACK ON THE 429 TOO. That is the point — a 429 is
      // the most informative response there is, and code that only reads
      // headers on success throws away the one that mattered.
      res.writeHead(429, { "content-type": "application/json", ...RL(0) });
      res.end(JSON.stringify({ message: "Too Many Requests" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json", ...RL(97) });
    res.end(JSON.stringify({ opportunities: [], pipelines: [], id: "ok", contact: { id: "c1" } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
process.env.GHL_API_BASE = `http://127.0.0.1:${PORT}`;
process.env.GHL_PIT = process.env.GHL_PIT || "pit_test";
process.env.GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "loc_test";

const G = await import("../lib/ghl.ts");

const errOf = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ── 1 · A GET IS RETRIED, SILENTLY, AND SUCCEEDS ──────────────────────────
console.log("\n1 · 🔴 A GET THAT IS 429'd TWICE STILL SUCCEEDS");
plan.set("GET /opportunities/pipelines", 2);
seen.clear();
const t0 = Date.now();
const pipes = await G.listPipelines();
const ms = Date.now() - t0;
const got = seen.get("GET /opportunities/pipelines");
console.log(`  requests the server saw: ${got} · elapsed ${ms}ms`);
ok("🔴 it did not throw — the caller never saw a 429", Array.isArray(pipes), pipes);
ok("three attempts: the original plus two retries", got === 3, got);
// 1/5 then 2/5 of the 10,000ms window = 2000 + 4000.
console.log(`  backoff came from x-ratelimit-interval-milliseconds, not a guess`);
// 2000 + 4000 of backoff, plus the sub-second pauses `pauseIfNearLimit` adds
// after each 429 reports remaining=0. Anything near 2 x 1200 would mean the
// flat guess was still in use.
ok("🔴 it waited ~6s of backoff, which is 1/5 + 2/5 of the 10s window",
   ms >= 5500 && ms < 10500, ms);

// ── 2 · THE HEADERS ARE READ, INCLUDING FROM THE 429 ──────────────────────
console.log("\n2 · ✅ THE HEADERS ARE READ AND KEPT");
const snap = G.getRateLimitSnapshot();
console.log(`  ${JSON.stringify(snap)}`);
ok("max is 100", snap?.max === 100, snap);
ok("the interval is the header's 10000, not an assumption", snap?.intervalMs === 10000, snap);
ok("the daily ceiling is visible", snap?.dailyLimit === 200000, snap);
ok("🔴 and the daily remaining shows it is a non-issue",
   snap?.dailyRemaining === 198091, snap);

// ── 3 · A PUT IS RETRIED — IT SETS A DESIRED STATE ────────────────────────
console.log("\n3 · ✅ A PUT IS RETRIED — APPLYING IT TWICE REACHES THE SAME PLACE");
plan.set("PUT /opportunities/o1", 1);
seen.clear();
await G.updateOpportunity("o1", { name: "X" });
const putSeen = seen.get("PUT /opportunities/o1");
console.log(`  requests the server saw: ${putSeen}`);
ok("retried once and succeeded", putSeen === 2, putSeen);

// ── 4 · 🔴 A CREATING POST IS **NOT** RETRIED ─────────────────────────────
console.log("\n4 · 🔴 A POST THAT CREATES IS NOT RETRIED — THAT IS THE WHOLE ITEM");
console.log("  (a 429 whose request LANDED server-side is indistinguishable from");
console.log("   one that did not; a retry would make a second partner)");
plan.set("POST /opportunities/pipelines", 1);
seen.clear();
const e1 = await errOf(() => G.createPipeline({ name: "T", stages: ["A"] }));
const postSeen = seen.get("POST /opportunities/pipelines");
console.log(`  requests the server saw: ${postSeen}`);
console.log(`  surfaced as: "${e1?.message}"`);
ok("🔴 EXACTLY ONE request — no duplicate could have been created",
   postSeen === 1, postSeen);
ok("it is reported, not swallowed", !!e1, e1);
ok("🔴 and NOT as a raw 429", !/^GoHighLevel returned 429/.test(e1?.message || ""), e1?.message);
ok("it says what it is and what to do",
   /rate-limiting us/i.test(e1?.message || "") && /few seconds/i.test(e1?.message || ""),
   e1?.message);
ok("the status is still 429 for anything that switches on it", e1?.status === 429, e1?.status);
ok("⚠️ and the numbers are in the detail, for the log",
   /200000|10000ms window/.test(e1?.detail || ""), e1?.detail);

// ── 5 · A GET THAT NEVER RECOVERS ─────────────────────────────────────────
console.log("\n5 · ✅ AND WHEN THE RETRIES ARE SPENT, IT SAYS SO HONESTLY");
// ⚠️ NOT listPipelines() — IT IS MEMOIZED, so after section 1 succeeded a
// second call never reaches the server and this measured zero requests while
// claiming to measure three. `/opportunities/search` is uncached.
plan.set("GET /opportunities/search", 99);
seen.clear();
const e2 = await errOf(() => G.countOpportunitiesInPipeline("pipe_x"));
const tries = seen.get("GET /opportunities/search");
console.log(`  requests the server saw: ${tries}`);
console.log(`  surfaced as: "${e2?.message}"`);
ok("🔴 it stops at three — it does not retry forever", tries === 3, tries);
ok("and the message is the honest one", /rate-limiting us/i.test(e2?.message || ""), e2?.message);
ok("⚠️ and it says the account is fine",
   /nothing is wrong with the account/i.test(e2?.detail || ""), e2?.detail);

console.log(`\n${pass} passed, ${fail} failed.`);
server.close();
process.exit(fail ? 1 : 0);
