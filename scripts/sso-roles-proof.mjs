// ---------------------------------------------------------------------------
// ROUND 179 · THE SSO ROLE PROBE'S SELF-TEST, IN THE REGRESSION BATCH.
//
// The probe (scripts/sso-roles-probe.mjs) answers "does the Agency Owner get
// the same access as an admin?" by calling the app's own permission functions.
// This runs its offline self-test so a change to lib/visibility.ts, lib/sso.ts
// or lib/ssoProbe.ts that breaks the probe — or that changes what the owner
// gets — shows up here, not on the day someone needs the probe.
//
// Run: npx tsx scripts/sso-roles-proof.mjs
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";

let out = "", code = 0;
try {
  out = execFileSync("npx", ["tsx", "scripts/sso-roles-probe.mjs", "--selftest"], {
    encoding: "utf8", env: { ...process.env, SSO_PROBE: "" },
  });
} catch (e) {
  out = String(e.stdout || "") + String(e.stderr || "");
  code = typeof e.status === "number" ? e.status : 1;
}
process.stdout.write(out);
if (!/\d+ passed · \d+ failed/.test(out)) {
  console.log("0 passed · 1 failed   (the self-test printed no tally)");
  process.exit(1);
}
process.exit(code);
