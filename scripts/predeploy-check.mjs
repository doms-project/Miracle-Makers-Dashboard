// ---------------------------------------------------------------------------
// PRE-DEPLOY CHECK — one command, one answer: GO or NO-GO.
//
// Runs, in order, everything this tree can check without a browser:
//   1. the build stamp matches the newest V2-REPORT
//   2. TypeScript                     (npx tsc --noEmit)
//   3. the production build           (npx next build)
//   4. the loader sweep
//   5. the newest round proofs        (183, 184, 185)
//   6. the standing regression set    (scripts/regression.txt)
//
// Run:   node scripts/predeploy-check.mjs
//        node scripts/predeploy-check.mjs --quick    (skips 3 and 6, ~1 min)
//
// ⚠️ EVERY STEP HAS A TIME LIMIT AND IS KILLED WITH ITS CHILDREN. A proof that
// starts `next dev` or a browser leaves processes behind when only its parent
// is killed, and a check that hangs is worse than one that fails: it looks
// like it is still working. Each step runs in its own process group, and the
// whole group is killed when time runs out.
//
// ⚠️ THE BROWSER HALVES OF round176 AND round177 ARE SKIPPED (R176_LIB_ONLY,
// R177_LIB_ONLY): they need a local Chrome. Everything else in the regression
// set runs in full. A proof that prints no "N passed" line counts as FAILED.
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const QUICK = process.argv.includes("--quick");
const results = [];
const t0 = Date.now();

const color = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const GREEN = (s) => color(32, s);
const RED = (s) => color(31, s);
const DIM = (s) => color(2, s);

function run(cmd, args, { timeoutMs, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      detached: true, // own process group, so a timeout kills grandchildren too
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env, FORCE_COLOR: "0" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      // Anything the step left running (a dev server, a browser) goes too.
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      resolve({ code: timedOut ? -1 : code, out, timedOut });
    });
  });
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? GREEN("PASS") : RED("FAIL")}  ${name}${detail ? DIM(`  ·  ${detail}`) : ""}`);
}

const lastLine = (out) => out.trim().split("\n").filter(Boolean).slice(-1)[0] || "";
const tally = (out) => (out.match(/[0-9]+ passed[^\n]*/g) || []).slice(-1)[0] || "";

console.log(`Pre-deploy check${QUICK ? " (quick)" : ""}\n`);

// 1 · Build stamp ─────────────────────────────────────────────────────────────
{
  const stamp = /round:\s*"(\d+)/.exec(readFileSync("lib/build.ts", "utf8"))?.[1] || "";
  const reports = readdirSync(".")
    .map((n) => /^V2-REPORT-(\d+)/.exec(n)?.[1])
    .filter(Boolean)
    .map(Number);
  const newest = reports.length ? Math.max(...reports) : 0;
  record(
    "build stamp matches the newest report",
    !!stamp && Number(stamp) === newest,
    `lib/build.ts says v${stamp || "?"}, newest report is ${newest}`,
  );
}

// 2 · TypeScript ──────────────────────────────────────────────────────────────
{
  const r = await run("npx", ["tsc", "--noEmit"], { timeoutMs: 300_000 });
  const errors = (r.out.match(/error TS\d+/g) || []).length;
  record(
    "TypeScript (tsc --noEmit)",
    r.code === 0,
    r.timedOut ? "timed out" : r.code === 0 ? "no errors" : `${errors} error(s) — first: ${(r.out.match(/^.*error TS.*$/m) || [""])[0].slice(0, 160)}`,
  );
}

// 3 · Production build ────────────────────────────────────────────────────────
if (!QUICK) {
  const r = await run("npx", ["next", "build"], { timeoutMs: 600_000 });
  record(
    "production build (next build)",
    r.code === 0 && /Compiled successfully/.test(r.out),
    r.timedOut ? "timed out" : r.code === 0 ? "compiled successfully" : lastLine(r.out).slice(0, 200),
  );
}

// 4 · Loader sweep ────────────────────────────────────────────────────────────
{
  const r = await run("node", ["scripts/loader-sweep.mjs"], { timeoutMs: 120_000 });
  const clean = /No loader, credential,.*matches a known defect/.test(r.out);
  record("loader sweep", r.code === 0 && clean, clean ? "clean" : lastLine(r.out).slice(0, 200));
}

// 5 + 6 · Proofs ──────────────────────────────────────────────────────────────
const proof = async (name, timeoutMs = 120_000) => {
  const r = await run("node", ["--import", "tsx", `scripts/${name}-proof.mjs`], {
    timeoutMs,
    env: { R176_LIB_ONLY: "1", R177_LIB_ONLY: "1" },
  });
  const t = tally(r.out);
  const failedN = Number((/(\d+) failed/.exec(t) || [])[1] || 0);
  const ok = r.code === 0 && !!t && failedN === 0;
  record(
    `proof · ${name}`,
    ok,
    r.timedOut ? `timed out after ${timeoutMs / 1000}s` : t || `no tally printed — ${lastLine(r.out).slice(0, 140)}`,
  );
};

for (const n of ["round183", "round184", "round185"]) await proof(n);

if (!QUICK) {
  const names = readFileSync("scripts/regression.txt", "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  console.log(DIM(`\nRegression set: ${names.length} proofs\n`));
  // referral-route starts a real `next dev`, whose first compile is slow.
  for (const n of names) await proof(n, n === "referral-route" ? 300_000 : 120_000);
}

// Verdict ─────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
const mins = ((Date.now() - t0) / 60000).toFixed(1);
console.log("");
if (failed.length) {
  console.log(RED(`NO-GO — ${failed.length} of ${results.length} checks failed (${mins} min):`));
  for (const f of failed) console.log(RED(`  · ${f.name}`) + DIM(`  ${f.detail}`));
} else {
  console.log(GREEN(`GO — all ${results.length} checks passed (${mins} min).`));
  if (QUICK) console.log(DIM("Quick mode skipped the build and the regression set; run without --quick before a release."));
  console.log(DIM("Not covered here: the live site. After deploying, run scripts/postdeploy-check.mjs, then scripts/live-tour.mjs to watch it in Chrome."));
}
process.exit(failed.length ? 1 : 0);
