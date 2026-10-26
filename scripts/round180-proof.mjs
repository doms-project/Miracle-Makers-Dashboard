// ---------------------------------------------------------------------------
// ROUND 180 · THE AGENCY OWNER IS AN ADMIN.
//
// 🔴 FOUND LIVE, 26 OCT 2026: GoHighLevel's sign-in sends the Agency Owner as
// role "owner" ("Signed in · John Ratigan · owner"). The dashboard accepted
// only "admin", so the owner got the rep view — no pipelines, no admin
// screens, 0 of 1,382 records — while an Agency Admin got everything.
//
// What must now be true, at every layer that decides it:
//   1  the rule      isAdminRole: admin + owner yes; user, "", undefined, others no
//   2  the server    isAdminSession and the record/owner/follower rules
//   3  the routes    the three admin-only routes let an owner through, still
//                    refuse a rep (called as real route handlers, not mocks)
//   4  the browser   decrypt-sso hands the browser "owner" unchanged, and
//                    page.tsx / PipelineAccessTab.tsx use the SAME rule —
//                    no private `role === "admin"` left anywhere
//   5  controls      type is still not permission; a rep is still a rep
//
// Run: npx tsx scripts/round180-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${got !== undefined ? `\n       got: ${JSON.stringify(got)}` : ""}`); }
};

// A GoHighLevel that answers every call at once with a plain 400 — so a route
// that PASSES its gate fails fast on the first GoHighLevel read (no retries,
// no backoff), and a route that is REFUSED never reaches it at all.
let ghlCalls = 0;
const server = http.createServer((req, res) => { ghlCalls++; res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"message":"proof: no GoHighLevel here"}'); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const LOC = "LOC180";
const SECRET = "round180-secret";
Object.assign(process.env, {
  GHL_API_BASE: `http://127.0.0.1:${server.address().port}`,
  GHL_PIT: "pit_test", GHL_LOCATION_ID: LOC, GHL_SSO_SECRET: SECRET,
});
delete process.env.PIPELINE_ACCESS_MAP;

const { default: CryptoJS } = await import("crypto-js");
const { isAdminRole, ADMIN_ROLES } = await import("../lib/adminRole.ts");
const V = await import("../lib/visibility.ts");
const PA = await import("../lib/pipelineAccess.ts");
const blob = (role, type = "agency", extra = {}) =>
  CryptoJS.AES.encrypt(JSON.stringify({ userId: `u_${role}`, role, type, activeLocation: LOC, companyId: "co1", userName: role, ...extra }), SECRET).toString();

console.log("\n1 · THE RULE");
ok("\"admin\" is an admin", isAdminRole("admin") === true);
ok("🔴 \"owner\" is an admin", isAdminRole("owner") === true);
ok("\"user\" is not", isAdminRole("user") === false);
for (const v of ["", undefined, null, "Admin", "OWNER", "superuser", 1, {}]) ok(`${JSON.stringify(v) ?? "undefined"} is not`, isAdminRole(v) === false);
ok("exactly two admin roles", ADMIN_ROLES.length === 2, ADMIN_ROLES);

console.log("\n2 · THE SERVER RULES");
const rec = { ownerId: "someone-else", followerIds: [], pipelineId: "ungranted" };
const as = (role, type = "agency") => ({ userId: `u_${role}`, role, type });
PA.runWithGrants(new Map(), () => {
  ok("🔴 isAdminSession(\"owner\")", V.isAdminSession("owner", "agency") === true);
  ok("🔴 the owner sees someone else's record in an ungranted pipeline", V.canSeeRecord(rec, as("owner")) === true);
  ok("🔴 …edits it", V.canEditRecord(rec, as("owner")) === true);
  ok("🔴 …changes its owner", V.canChangeOwner(rec, as("owner")) === true);
  ok("🔴 …manages its followers", V.canManageFollowers(rec, as("owner")) === true);
  ok("🔴 the owner holds the Master view", PA.hasMasterView("u_owner", V.isAdminSession("owner")) === true);
  ok("control: a rep does not see that record", V.canSeeRecord(rec, as("user", "account")) === false);
  ok("control: an AGENCY-type rep does not either (type is not permission)", V.canSeeRecord(rec, as("user", "agency")) === false);
  ok("control: a rep cannot change its owner", V.canChangeOwner(rec, as("user")) === false);
});

console.log("\n3 · THE ADMIN-ONLY ROUTES, CALLED AS REAL HANDLERS");
const routes = [
  ["Access", "../app/api/admin/pipeline-access/route.ts", "/api/admin/pipeline-access"],
  ["Pipelines", "../app/api/admin/pipelines/route.ts", "/api/admin/pipelines"],
  ["Import", "../app/api/import/meta/route.ts", "/api/import/meta"],
];
for (const [name, mod, url] of routes) {
  const { GET } = await import(mod);
  const call = async (role, type) => (await GET(new Request(`http://x${url}`, { headers: { "x-ghl-sso-key": blob(role, type) } }))).status;
  const before = ghlCalls;
  const rep = await call("user", "account");
  ok(`control: ${name} refuses a rep (403)`, rep === 403, rep);
  ok(`  …before asking GoHighLevel anything`, ghlCalls === before, ghlCalls - before);
  const owner = await call("owner", "agency");
  ok(`🔴 ${name} lets the OWNER through (got ${owner}, not 401/403)`, owner !== 401 && owner !== 403, owner);
  const admin = await call("admin", "agency");
  ok(`  ${name} still lets an admin through`, admin !== 401 && admin !== 403, admin);
}

console.log("\n4 · THE BROWSER");
const { POST: decryptPost } = await import("../app/api/decrypt-sso/route.ts");
const d = await (await decryptPost(new Request("http://x/api/decrypt-sso", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ key: blob("owner", "agency", { isAgencyOwner: true }) }),
}))).json();
ok("decrypt-sso hands the browser role \"owner\" unchanged", d.role === "owner", d);
ok("🔴 …and the browser's rule makes that an admin", isAdminRole(d.role) === true);

const page = readFileSync("app/page.tsx", "utf8");
ok("page.tsx decides isAdminViewer with isAdminRole", /isAdminViewer\s*=[\s\S]{0,120}isAdminRole\(sso\.session\.role\)/.test(page));
ok("page.tsx imports it from lib/adminRole", page.includes('import { isAdminRole } from "@/lib/adminRole";'));
const tab = readFileSync("components/PipelineAccessTab.tsx", "utf8");
ok("the Access tab labels admins with isAdminRole", tab.includes("const isAdmin = (u: User) => isAdminRole(u.role);"));

// 🔴 THE SWEEP. A private `role === "admin"` anywhere is a fourth copy of the
// rule waiting to disagree with the other three. Comments are exempt.
const offenders = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    if (!/\.(ts|tsx)$/.test(f) || p.endsWith(join("lib", "adminRole.ts"))) continue;
    readFileSync(p, "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "").trim();
      if (code.startsWith("*") || code.startsWith("/*")) return;
      if (/\brole\s*[!=]==?\s*["']admin["']|["']admin["']\s*[!=]==?\s*\w*\.?role\b/.test(code)) offenders.push(`${p}:${i + 1}`);
    });
  }
};
for (const d of ["app", "components", "lib"]) walk(d);
ok("no other `role === \"admin\"` in app/, components/ or lib/", offenders.length === 0, offenders);

server.close();
console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
