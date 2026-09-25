// ---------------------------------------------------------------------------
// THE BATCH RUNNER — AND ITS ONE REAL JOB IS TO REFUSE TO BE SILENT.
//
// 🔴 A PROOF THAT PRODUCES NO OUTPUT MUST NOT COUNT AS A PROOF THAT PASSED.
//
// Round 148's regression batch printed this:
//
//     referral-route ::
//
// An empty result, between twelve green ones, in a list I then read as "all
// green". The cause was mine and trivial — the batch tried `node` before
// `npx tsx`, and that file imports TypeScript, so the first attempt wrote
// nothing and the fallback was swallowed. The proof itself was fine: 16/16 when
// run alone.
//
// ⚠️ BUT THE SHAPE IS THE ONE THIS WHOLE TASK HAS BEEN ABOUT — a blank that
// looks like an answer. Silence read as green is exactly "0 of 2 meant a filter,
// not an absence" in the harness instead of the product, and the next runner
// change would hide a real red the same way.
//
// So this runner is mechanical about it, the way loader-sweep's rule 12 is
// mechanical about the build stamp:
//
//   · every proof named must produce a "N passed" line, or it FAILS
//   · N proofs in, N results out, or the run fails on the count alone
//   · a non-zero exit from a proof fails it even if it printed a tally
//
// Usage:  node scripts/run-proofs.mjs round138 task2-partners a11y
//         node scripts/run-proofs.mjs --file scripts/regression.txt
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";

const argv = process.argv.slice(2);
let names = [];
const fileAt = argv.indexOf("--file");
if (fileAt >= 0) {
  names = readFileSync(argv[fileAt + 1], "utf8")
    .split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
} else {
  names = argv.filter((a) => !a.startsWith("-"));
}
if (!names.length) {
  console.log("usage: node scripts/run-proofs.mjs <proof> [<proof>…]  |  --file <list>");
  process.exit(2);
}

/** "N passed · M failed" and "N passed, M failed" are both in use. */
const TALLY = /(\d+)\s+passed\s*[·,]\s*(\d+)\s+failed/;

const rows = [];
for (const name of names) {
  const script = `scripts/${name}-proof.mjs`;
  if (!existsSync(script)) {
    rows.push({ name, ok: false, why: "no such proof file", pass: 0, fail: 0 });
    continue;
  }
  // ⚠️ `npx tsx` FOR EVERYTHING. It runs plain .mjs as well as files importing
  // TypeScript, so there is no per-file choice to get wrong — which is the
  // mistake this runner exists to stop repeating.
  //
  // 🔴 AND THE DEV-SERVER LOCK IS CLEARED BETWEEN PROOFS. Next permits one dev
  // server per directory; a browser proof that dies leaves the lock behind and
  // every later one fails on it, reporting as "the code broke".
  try { rmSync(".next/dev/lock", { force: true }); } catch {}
  let out = "", code = 0;
  const started = Date.now();
  try {
    out = execFileSync("npx", ["tsx", script], {
      encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env },
    });
  } catch (e) {
    out = String(e.stdout || "") + String(e.stderr || "");
    code = typeof e.status === "number" ? e.status : 1;
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const m = [...out.matchAll(new RegExp(TALLY, "g"))].pop();
  if (!m) {
    // 🔴 THE WHOLE POINT. No tally is a FAILURE, never a pass — and the tail is
    // printed so the reason is on screen rather than in a file nobody opens.
    rows.push({
      name, ok: false, pass: 0, fail: 0, secs,
      why: `NO RESULT LINE (exit ${code}) — ${out.trim().split("\n").slice(-3).join(" / ").slice(0, 200) || "no output at all"}`,
    });
    continue;
  }
  const pass = Number(m[1]), fail = Number(m[2]);
  rows.push({
    name, pass, fail, secs, code,
    ok: fail === 0 && code === 0,
    why: fail ? `${fail} assertion(s) failed` : code ? `exit ${code} despite a clean tally` : "",
  });
}

console.log("");
for (const r of rows)
  console.log(
    `  ${r.ok ? "✅" : "🔴"} ${r.name.padEnd(22)} ${String(r.pass).padStart(3)} passed · ${String(r.fail).padStart(2)} failed  ${r.secs ? `${r.secs}s` : ""}${r.why ? `  ← ${r.why}` : ""}`,
  );

const bad = rows.filter((r) => !r.ok);
// ⚠️ THE COUNT IS ITS OWN CHECK. Even if every row that ran was green, N in and
// fewer than N out is a failed run — that is the case round 148 read as green.
console.log(
  `\n${bad.length ? "🔴" : "✅"}  ${rows.length - bad.length}/${names.length} proofs green` +
  (rows.length !== names.length ? `  🔴 ${names.length - rows.length} NEVER RAN` : ""),
);
process.exit(bad.length || rows.length !== names.length ? 1 : 0);
