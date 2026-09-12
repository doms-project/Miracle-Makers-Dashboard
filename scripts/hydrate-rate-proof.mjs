// ---------------------------------------------------------------------------
// ROUND 107 · FINDING 14 — THE MEASURED REQUEST RATE, BEFORE AND AFTER.
//
// 🔴 Round 89 established the arithmetic: a loop at concurrency C against a
// server with latency L issues `C × 10000/L` requests per 10 seconds. This
// MEASURES it instead of asserting it — a fake GoHighLevel that sleeps 100ms
// per request (a realistic round trip) records every arrival timestamp, and the
// peak is computed as the largest count inside any sliding 10-second window.
//
// GoHighLevel's ceiling is 100 requests / 10 seconds.
//
// ⚠️ It runs BOTH loops in the same process against the same server, so the
// before/after numbers are comparable rather than two separate anecdotes.
//
// Run: node scripts/hydrate-rate-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";

const LATENCY_MS = 100; // a realistic GHL round trip
const N = 250; // CF_HYDRATE_CAP
const stamps = [];

const server = http.createServer((req, res) => {
  stamps.push(Date.now());
  setTimeout(() => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ contact: { id: "c", customFields: [] } }));
  }, LATENCY_MS);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/contacts/x`;

/** Largest number of requests inside any sliding 10-second window. */
function peakPer10s(ts) {
  if (!ts.length) return 0;
  const a = [...ts].sort((x, y) => x - y);
  let peak = 0;
  for (let i = 0, j = 0; i < a.length; i++) {
    while (a[i] - a[j] > 10_000) j++;
    peak = Math.max(peak, i - j + 1);
  }
  return peak;
}

// A local copy of mapLimit — the same worker-pool shape as lib/concurrency.ts.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        try {
          out[i] = { ok: true, value: await fn(items[i]) };
        } catch (error) {
          out[i] = { ok: false, error };
        }
      }
    }),
  );
  return out;
}

const hit = () => fetch(url).then((r) => r.json());
const targets = Array.from({ length: N }, (_, i) => i);

// ── BEFORE — what lib/ghl.ts did until this round ──────────────────────────
stamps.length = 0;
let t0 = Date.now();
await mapLimit(targets, 5, hit);
const beforeMs = Date.now() - t0;
const beforePeak = peakPer10s(stamps);

// ── AFTER — CF_CHUNK 12, CF_CONCURRENCY 4, CF_PAUSE_MS 1500 ────────────────
stamps.length = 0;
t0 = Date.now();
for (let i = 0; i < targets.length; i += 12) {
  await mapLimit(targets.slice(i, i + 12), 4, hit);
  if (i + 12 < targets.length) await new Promise((r) => setTimeout(r, 1500));
}
const afterMs = Date.now() - t0;
const afterPeak = peakPer10s(stamps);

const CEILING = 100;
const row = (label, peak, ms) =>
  `  ${label.padEnd(28)} ${String(peak).padStart(4)} req / 10s   ${
    peak > CEILING ? "🔴 OVER" : "✅ under"
  } the ${CEILING} ceiling   (${(ms / 1000).toFixed(1)}s total)`;

console.log(`\n${N} contact reads, ${LATENCY_MS}ms latency, peak in any 10s window\n`);
console.log(row("BEFORE  concurrency 5, no pause", beforePeak, beforeMs));
console.log(row("AFTER   12 × conc 4, 1.5s pause", afterPeak, afterMs));
console.log(
  `\n  headroom after the fix: ${CEILING - afterPeak} requests per 10s for everything` +
    ` else sharing the ceiling.\n`,
);
server.close();
process.exit(afterPeak > CEILING ? 1 : 0);
