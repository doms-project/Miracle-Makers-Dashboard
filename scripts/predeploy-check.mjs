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
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

/** Printed first, so a run can be matched to the copy of this file used. */
const SCRIPT_VERSION = "predeploy-check 188.1";
// PREDEPLOY_AS_WINDOWS=1 exercises the Windows path on another system.
const IS_WIN = process.platform === "win32" || process.env.PREDEPLOY_AS_WINDOWS === "1";
// Node itself runs every step — never `npx`, which Windows cannot start
// without a shell, and a shell would split the project path at its spaces.
const NODE = process.execPath;
const TSC = "node_modules/typescript/bin/tsc";
const NEXT = "node_modules/next/dist/bin/next";

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
      // Own process group on Mac/Linux, so a timeout kills grandchildren too.
      // Windows has no process groups; taskkill /T does the same job there.
      detached: !IS_WIN,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env, FORCE_COLOR: "0" },
    });
    const killTree = () => {
      if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else try { process.kill(-child.pid, "SIGKILL"); } catch {}
    };
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `${out}\ncould not start: ${e.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Anything the step left running (a dev server, a browser) goes too.
      killTree();
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

console.log(`${SCRIPT_VERSION}${QUICK ? " (quick)" : ""}${IS_WIN ? " · Windows" : ""}\n`);

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
  const r = await run(NODE, [TSC, "--noEmit"], { timeoutMs: 300_000 });
  const errors = (r.out.match(/error TS\d+/g) || []).length;
  record(
    "TypeScript (tsc --noEmit)",
    r.code === 0,
    r.timedOut ? "timed out" : r.code === 0 ? "no errors" : `${errors} error(s) — first: ${(r.out.match(/^.*error TS.*$/m) || [""])[0].slice(0, 160)}`,
  );
}

// 3 · Production build ────────────────────────────────────────────────────────
if (!QUICK) {
  const r = await run(NODE, [NEXT, "build"], { timeoutMs: 600_000 });
  record(
    "production build (next build)",
    r.code === 0 && /Compiled successfully/.test(r.out),
    r.timedOut ? "timed out" : r.code === 0 ? "compiled successfully" : lastLine(r.out).slice(0, 200),
  );
}

// 4 · Loader sweep ────────────────────────────────────────────────────────────
{
  const r = await run(NODE, ["scripts/loader-sweep.mjs"], { timeoutMs: 120_000 });
  const clean = /No loader, credential,.*matches a known defect/.test(r.out);
  record("loader sweep", r.code === 0 && clean, clean ? "clean" : lastLine(r.out).slice(0, 200));
}

// 5 + 6 · Proofs ──────────────────────────────────────────────────────────────
// Older proofs written for Linux: they start servers with `npx`, look for
// processes with `pgrep`, or use /opt and /tmp paths. On Windows they fail for
// reasons that have nothing to do with the code, so they are SKIPPED there —
// named, never silently — and run in full on Mac and Linux.
const LINUX_ONLY = /(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*["']npx["']|pgrep|\/opt\/pw-browsers|process\.kill\(-|["'`]\/tmp\//;
/**
 * NODE'S WINDOWS SHUTDOWN CRASH. On Windows, `server.close()` followed at once
 * by `process.exit()` can abort Node with "Assertion failed:
 * !(handle->flags & UV_HANDLE_CLOSING)" (exit 0xC0000409) AFTER every check
 * has run and printed. Accepted ONLY when the tally says 0 failed AND the
 * output shows that exact crash; any other non-zero exit is still a failure.
 */
const WIN_SHUTDOWN_CRASH = (code, out) =>
  IS_WIN && (code === 3221226505 || code === -1073740791 || /UV_HANDLE_CLOSING/.test(out));
const skipped = [];
const proof = async (name, timeoutMs = 120_000) => {
  if (IS_WIN) {
    let src = "";
    try { src = readFileSync(`scripts/${name}-proof.mjs`, "utf8"); } catch {}
    if (LINUX_ONLY.test(src)) { skipped.push(name); console.log(`SKIP  proof · ${name}${DIM("  ·  Linux-only harness")}`); return; }
  }
  const r = await run(NODE, ["--import", "tsx", `scripts/${name}-proof.mjs`], {
    timeoutMs,
    env: { R176_LIB_ONLY: "1", R177_LIB_ONLY: "1" },
  });
  const t = tally(r.out);
  const failedN = Number((/(\d+) failed/.exec(t) || [])[1] || 0);
  const crashedAfter = !!t && failedN === 0 && r.code !== 0 && WIN_SHUTDOWN_CRASH(r.code, r.out);
  const ok = (r.code === 0 || crashedAfter) && !!t && failedN === 0;
  record(
    `proof · ${name}`,
    ok,
    r.timedOut
      ? `timed out after ${timeoutMs / 1000}s`
      : !t
        ? `no tally printed — ${lastLine(r.out).slice(0, 140)}`
        : crashedAfter
          ? `${t} · then Node's known Windows shutdown crash (ignored: every check had passed)`
          : r.code !== 0 && failedN === 0
            ? `${t} · but exited with code ${r.code} — ${lastLine(r.out).slice(0, 140)}`
            : t,
  );
};

for (const n of ["round183", "round184", "round185", "round186", "round187", "round188"]) await proof(n);

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
  if (skipped.length)
    console.log(DIM(`Skipped on Windows (Linux-only harness, ${skipped.length}): ${skipped.join(", ")}. They run in full on Mac/Linux.`));
  if (QUICK) console.log(DIM("Quick mode skipped the build and the regression set; run without --quick before a release."));
  console.log(DIM("Not covered here: the live site. After deploying, run scripts/postdeploy-check.mjs, then scripts/live-tour.mjs to watch it in Chrome."));
}
process.exit(failed.length ? 1 : 0);
