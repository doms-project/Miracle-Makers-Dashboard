#!/usr/bin/env node
// ---------------------------------------------------------------------------
// ROUND 179 · DOES THE AGENCY OWNER GET THE SAME ACCESS AS AN ADMIN?
//
// Every access decision in this dashboard hangs off ONE string — the SSO
// `role` — through `isAdminSession(role)`. ROUND 180: "owner" counts as admin
// too (lib/adminRole.ts), after the live check found GoHighLevel sends the
// Agency Owner as "owner". Before that, only "admin" did. GoHighLevel's
// docs disagree about what an Agency Owner carries:
//
//   · marketplace "User Context" page   owner = role "admin" + isAgencyOwner
//   · help article "Agency Owner role"  backend role changed admin → "owner"
//
// If the second one reaches this app, the owner is treated as a REP: no admin
// screens, only records they own or follow. This probe answers it from real
// data, using the app's OWN permission functions rather than a copy of them.
//
// TWO SOURCES, BOTH OPTIONAL:
//
//   1. The SSO payload, per person. Set SSO_PROBE=1 on the deployment and
//      have each person open the dashboard inside GoHighLevel once.
//      /api/decrypt-sso then logs one `[sso-probe] {…}` line per load (the
//      decrypted payload, email masked — never the blob). Export or paste
//      those log lines into a file and pass it with --logs.
//
//   2. GET /users/?locationId — what the Users API says each person's role
//      is. This feeds two different places in the app: the reassign route's
//      "every admin follows" list and the Access tab's admin label. Needs
//      GHL_PIT and GHL_LOCATION_ID (read from the env, or from .env.local).
//
// Who to capture (one dashboard load each):
//   · the Agency Owner                 · an Agency Admin (not the owner)
//   · a Sub-account Admin              · a Sub-account User (a rep)
//   · an Agency Admin using "Login As" a rep — note the time you do it
//
// Run (repo convention — `npx tsx` runs .mjs that imports TypeScript):
//   npx tsx scripts/sso-roles-probe.mjs --logs sso-probe.log
//   npx tsx scripts/sso-roles-probe.mjs                 # Users API only
//   npx tsx scripts/sso-roles-probe.mjs --logs f --no-users
//   npx tsx scripts/sso-roles-probe.mjs --blobs blobs.txt   # raw blobs, needs GHL_SSO_SECRET
//   npx tsx scripts/sso-roles-probe.mjs --logs f --json report.json
//   npx tsx scripts/sso-roles-probe.mjs --selftest      # offline, no account needed
//
// ⚠️ READ-ONLY. One GET against GoHighLevel. Nothing is written anywhere
// except the optional --json file.
// ---------------------------------------------------------------------------
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const arg = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

// ── env: the real env wins; .env.local only fills gaps ─────────────────────
function loadEnvLocal() {
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

// ── the access questions, answered by the app's own functions ──────────────
//
// 🔴 NOT A RE-IMPLEMENTATION. Each row calls the function the routes call, so
// if visibility.ts changes, this probe changes with it.
//
// The test record is owned by somebody else, in a pipeline the viewer holds no
// grant on — the case that separates an admin from a rep. Grants are an EMPTY
// map (installed with runWithGrants), so PIPELINE_ACCESS_MAP in the env cannot
// leak in and make a rep look like an admin.
const ACCESS_ROWS = [
  ["serverAdmin", "Server treats them as admin (isAdminSession)"],
  ["adminScreens", "Pipelines + Access screens (admin-only route gate)"],
  ["seeOthersRecord", "Sees a record owned by someone else, ungranted pipeline"],
  ["editOthersRecord", "Edits that record's fields"],
  ["changeOwner", "Changes that record's owner"],
  ["manageFollowers", "Adds/removes that record's followers"],
  ["masterView", "Master view (no explicit grant)"],
  ["clientAdminUi", "Browser shows the admin UI (page.tsx: role === \"admin\")"],
];

function makeDecider(V, PA, AR) {
  const OTHER = "probe-someone-else";
  const UNGRANTED = "probe-ungranted-pipeline";
  const rec = { ownerId: OTHER, followerIds: [], pipelineId: UNGRANTED };
  return (p) => {
    const s = { userId: String(p.userId ?? ""), role: p.role, type: p.type };
    return PA.runWithGrants(new Map(), () => {
      const admin = V.isAdminSession(s.role, s.type);
      return {
        serverAdmin: admin,
        // Both admin routes gate on exactly this call — app/api/admin/*/route.ts.
        adminScreens: V.isAdminSession(s.role, s.type),
        seeOthersRecord: V.canSeeRecord(rec, s),
        editOthersRecord: V.canEditRecord(rec, s),
        changeOwner: V.canChangeOwner(rec, s),
        manageFollowers: V.canManageFollowers(rec, s),
        masterView: PA.hasMasterView(s.userId, admin),
        // page.tsx:2679 — a .tsx page cannot be imported here, so this one row
        // mirrors it. If that line changes, change this.
        clientAdminUi: AR.isAdminRole(s.role),
      };
    });
  };
}

// ── who is this? ────────────────────────────────────────────────────────────
//
// isAgencyOwner is the only owner signal GHL documents in the payload. Past
// that, the Users API's roles.type is the reliable User Type (agency/account);
// the SSO `type` is documented as BOTH "context" and "user type", so it is
// shown but only trusted when the API has nothing.
function classify(p, apiUser) {
  if (p.isAgencyOwner === true) return "Agency Owner";
  const role = String(p.role ?? "");
  const type = String(apiUser?.roles?.type ?? p.type ?? "");
  const r = role === "admin" ? "Admin" : role === "owner" ? "Owner" : role === "user" ? "User" : `role="${role}"`;
  const t = type === "agency" ? "Agency" : type === "account" ? "Sub-account" : `type="${type}"`;
  return `${t} ${r}`;
}

// ── report (pure: captures + users in, report out) ──────────────────────────
function buildReport({ captures, apiUsers, appUsers, loc, decide, isAdmin }) {
  const byId = new Map((apiUsers || []).map((u) => [String(u.id ?? ""), u]));
  const appById = new Map((appUsers || []).map((u) => [u.id, u]));

  // One row per distinct session SHAPE. The same person in agency view and in
  // the sub-account are different answers and both are kept.
  const seen = new Map();
  for (const c of captures) {
    const p = c.payload || {};
    const k = JSON.stringify([p.userId, p.role, p.type, p.isAgencyOwner, p.activeLocation ?? null]);
    seen.set(k, c); // latest wins
  }

  const people = [...seen.values()].map((c) => {
    const p = c.payload;
    const apiUser = byId.get(String(p.userId ?? ""));
    const appUser = appById.get(String(p.userId ?? ""));
    return {
      label: classify(p, apiUser),
      name: String(p.userName ?? apiUser?.name ?? "(no name)"),
      userId: String(p.userId ?? ""),
      at: c.at || null,
      source: c.source,
      sso: {
        role: p.role ?? null,
        type: p.type ?? null,
        isAgencyOwner: p.isAgencyOwner ?? null,
        activeLocation: p.activeLocation ?? null,
        companyId: p.companyId ?? null,
        keys: c.keys || Object.keys(p).sort(),
      },
      api: apiUser
        ? {
            role: apiUser.roles?.role ?? apiUser.role ?? null,
            type: apiUser.roles?.type ?? null,
            hasThisLocation: (apiUser.roles?.locationIds || []).includes(loc),
            restrictSubAccount: apiUser.roles?.restrictSubAccount ?? null,
            deleted: apiUser.deleted ?? null,
          }
        : null,
      appUserListAdmin: appUser ? isAdmin(appUser.role) : null,
      boundToThisLocation: p.activeLocation ? p.activeLocation === loc : null,
      access: decide(p),
    };
  });

  // The Users API table — independent of anyone having opened anything.
  const users = (apiUsers || []).map((u) => {
    const role = String(u.roles?.role ?? u.role ?? "");
    return {
      name: u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || "(unnamed)",
      id: String(u.id ?? ""),
      type: u.roles?.type ?? null,
      role,
      hasThisLocation: (u.roles?.locationIds || []).includes(loc),
      restrictSubAccount: u.roles?.restrictSubAccount ?? null,
      deleted: u.deleted ?? null,
      appTreatsAsAdmin: isAdmin(role),
      unknownRole: !isAdmin(role) && role !== "user",
    };
  });

  // ── the verdict ──
  const diff = (a, b) =>
    ACCESS_ROWS.filter(([k]) => a.access[k] !== b.access[k]).map(([k]) => k);
  const owners = people.filter((x) => x.label === "Agency Owner");
  const agencyAdmins = people.filter((x) => x.label === "Agency Admin");
  const subAdmins = people.filter((x) => x.label === "Sub-account Admin");
  const comparisons = [];
  for (const o of owners) {
    for (const [what, list] of [["Agency Admin", agencyAdmins], ["Sub-account Admin", subAdmins]]) {
      if (!list.length) {
        comparisons.push({ owner: o.name, against: what, result: "NOT CAPTURED", differs: [] });
        continue;
      }
      for (const a of list) {
        const d = diff(o, a);
        comparisons.push({ owner: o.name, against: `${what} (${a.name})`, result: d.length ? "DIFFERENT" : "SAME", differs: d });
      }
    }
  }

  // ── anything else worth saying, found in the same data ──
  const findings = [];
  for (const o of owners) {
    if (!isAdmin(o.sso.role))
      findings.push(`🔴 The Agency Owner (${o.name}) arrives with SSO role "${o.sso.role}", which the dashboard does not treat as admin, so the owner is treated as a rep.`);
    if (o.api && !isAdmin(o.api.role))
      findings.push(`🔴 The Users API reports the Agency Owner's role as "${o.api.role}". The reassign route's "every admin follows" list and the Access tab's admin label will both miss them.`);
    if (!o.api && apiUsers)
      findings.push(`⚠️ The Agency Owner (${o.name}, ${o.userId}) is NOT in GET /users?locationId for this sub-account. The reassign route never adds them as an admin follower, and the Access tab does not list them.`);
  }
  for (const x of people) {
    if (x.access.serverAdmin && x.boundToThisLocation === false)
      findings.push(`🔴 ${x.name} (${x.label}) is admin here while signed into a DIFFERENT sub-account (${x.sso.activeLocation}). The server never checks activeLocation, so this session gets full admin over this account's data.`);
    if (x.access.serverAdmin && x.boundToThisLocation === null)
      findings.push(`⚠️ ${x.name} (${x.label}) opened it from AGENCY view (no activeLocation) and is admin. Decide whether agency context should be allowed at all.`);
  }
  for (const u of users) {
    if (u.unknownRole)
      findings.push(`⚠️ Users API: ${u.name} has role "${u.role}" — neither "admin" nor "user". The app treats them as NOT admin.`);
    if (u.deleted === true)
      findings.push(`⚠️ Users API: ${u.name} is marked deleted but still returned; listLocationUsers does not filter deleted users.`);
  }
  const companies = new Set(people.map((x) => x.sso.companyId).filter(Boolean));
  if (companies.size > 1)
    findings.push(`🔴 Sessions from ${companies.size} different companyIds were accepted: ${[...companies].join(", ")}.`);

  return { loc, people, users, comparisons, findings };
}

// ── printing ────────────────────────────────────────────────────────────────
const yn = (b) => (b === true ? "yes" : b === false ? "no" : "—");
function printReport(r, { hadCaptures, hadUsers }) {
  const out = [];
  const w = (s = "") => out.push(s);
  w(`\nSSO ROLE PROBE · location ${r.loc}`);

  if (hadUsers) {
    w(`\n=== USERS API · GET /users/?locationId (${r.users.length}) ===`);
    w("  name                          type      role    this loc  restrict  deleted  app admin?");
    for (const u of [...r.users].sort((a, b) => a.name.localeCompare(b.name)))
      w(`  ${u.name.slice(0, 29).padEnd(30)}${String(u.type ?? "—").padEnd(10)}${u.role.padEnd(8)}${yn(u.hasThisLocation).padEnd(10)}${yn(u.restrictSubAccount).padEnd(10)}${yn(u.deleted).padEnd(9)}${u.appTreatsAsAdmin ? "ADMIN" : "rep"}${u.unknownRole ? "  ⚠️ unknown role" : ""}`);
  }

  if (hadCaptures) {
    w(`\n=== SSO SESSIONS CAPTURED (${r.people.length}) ===`);
    for (const x of r.people) {
      w(`\n  ${x.label} · ${x.name} · ${x.userId}${x.at ? ` · ${x.at}` : ""}`);
      w(`    SSO   role=${JSON.stringify(x.sso.role)} type=${JSON.stringify(x.sso.type)} isAgencyOwner=${JSON.stringify(x.sso.isAgencyOwner)} activeLocation=${JSON.stringify(x.sso.activeLocation)}${x.boundToThisLocation === false ? "  🔴 NOT this location" : ""}`);
      w(`    keys  ${x.sso.keys.join(", ")}`);
      if (x.api) w(`    API   role=${JSON.stringify(x.api.role)} type=${JSON.stringify(x.api.type)} this location=${yn(x.api.hasThisLocation)}`);
      else if (hadUsers) w(`    API   ⚠️ not in this sub-account's user list`);
    }

    w(`\n=== ACCESS, FROM THE APP'S OWN PERMISSION FUNCTIONS ===`);
    const cols = r.people.map((x) => `${x.label.split(" ").map((s) => s[0]).join("")}:${x.name.split(" ")[0]}`.slice(0, 13));
    w(`  ${"".padEnd(58)}${cols.map((c) => c.padEnd(14)).join("")}`);
    for (const [k, label] of ACCESS_ROWS)
      w(`  ${label.slice(0, 57).padEnd(58)}${r.people.map((x) => yn(x.access[k]).padEnd(14)).join("")}`);
    w(`  (column key: AO Agency Owner · AA Agency Admin · SA Sub-account Admin · SU Sub-account User)`);

    w(`\n=== VERDICT · does the Agency Owner get the same access? ===`);
    if (!r.comparisons.length)
      w("  No Agency Owner captured yet (no session with isAgencyOwner: true). Have the owner open the dashboard with SSO_PROBE=1 on.");
    for (const c of r.comparisons)
      w(`  Agency Owner (${c.owner}) vs ${c.against}: ${c.result}${c.differs.length ? ` — differs on ${c.differs.join(", ")}` : ""}`);
  }

  w(`\n=== FINDINGS ===`);
  if (!r.findings.length) w("  none");
  for (const f of r.findings) w(`  ${f}`);
  w("\n  Login As: find the capture made at the time you used it. If its userId is the");
  w("  rep's, everything done in the dashboard during impersonation is attributed to the rep.");
  console.log(out.join("\n"));
}

// ── inputs ──────────────────────────────────────────────────────────────────
function parseLogs(text, TAG) {
  const caps = [];
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(TAG);
    if (i < 0) continue;
    // Vercel and friends wrap lines in their own prefixes and sometimes quote
    // them; take from the first "{" after the tag to the last "}".
    const rest = line.slice(i + TAG.length);
    const a = rest.indexOf("{"), b = rest.lastIndexOf("}");
    if (a < 0 || b < a) continue;
    let raw = rest.slice(a, b + 1);
    try {
      caps.push({ ...JSON.parse(raw), source: "log" });
    } catch {
      try { caps.push({ ...JSON.parse(raw.replace(/\\"/g, '"')), source: "log" }); } catch { /* not ours */ }
    }
  }
  return caps;
}

async function fetchUsersRaw(loc, token) {
  const r = await fetch(`https://services.leadconnectorhq.com/users/?locationId=${encodeURIComponent(loc)}`, {
    headers: { Authorization: `Bearer ${token}`, Version: process.env.GHL_API_VERSION || "2021-07-28", Accept: "application/json" },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`GET /users → HTTP ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t).users || [];
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  loadEnvLocal();
  const loc = (process.env.GHL_LOCATION_ID || "").trim();
  if (!loc) { console.error("Set GHL_LOCATION_ID (env or .env.local)."); process.exit(1); }

  const V = await import("../lib/visibility.ts");
  const PA = await import("../lib/pipelineAccess.ts");
  const AR = await import("../lib/adminRole.ts");
  const { SSO_PROBE_TAG } = await import("../lib/ssoProbe.ts");
  const decide = makeDecider(V, PA, AR);

  const captures = [];
  const logsFile = arg("--logs");
  if (logsFile) {
    const c = parseLogs(readFileSync(logsFile, "utf8"), SSO_PROBE_TAG);
    if (!c.length) console.error(`⚠️ No ${SSO_PROBE_TAG} lines in ${logsFile}. Is SSO_PROBE=1 set on the deployment?`);
    captures.push(...c);
  }
  const blobsFile = arg("--blobs");
  if (blobsFile) {
    const { decryptSso } = await import("../lib/sso.ts");
    for (const line of readFileSync(blobsFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const blob = line.includes("\t") ? line.split("\t").pop() : line;
      try { captures.push({ payload: decryptSso(blob), source: "blob" }); }
      catch (e) { console.error(`⚠️ a blob did not decrypt: ${e.message}`); }
    }
  }

  let apiUsers = null, appUsers = null;
  if (!flag("--no-users")) {
    const token = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
    if (!token) console.error("⚠️ GHL_PIT not set — skipping the Users API half (or pass --no-users).");
    else {
      // ⚠️ THE USERS HALF IS OPTIONAL, SO ITS FAILURE IS NOT FATAL. A 401 from a
      // token without users.readonly must not throw away the SSO captures —
      // those are the half that answers the owner question.
      try {
        apiUsers = await fetchUsersRaw(loc, token);
        // The app's own reading of the same list — what the reassign route and
        // the Access tab actually get.
        const G = await import("../lib/ghl.ts");
        appUsers = await G.listLocationUsers();
      } catch (e) {
        const why = e?.cause?.code || e?.cause?.message || e?.message || String(e);
        console.error(`⚠️ Users API half skipped — ${why}. (Does the PIT have users.readonly? Is this machine online?)`);
        apiUsers = null;
        appUsers = null;
      }
    }
  }

  const report = buildReport({ captures, apiUsers, appUsers, loc, decide, isAdmin: (r) => V.isAdminSession(r) });
  printReport(report, { hadCaptures: captures.length > 0, hadUsers: !!apiUsers });
  const jsonOut = arg("--json");
  if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(report, null, 2)); console.log(`\nwrote ${jsonOut}`); }
}

// ── self-test: the whole pipeline, offline, against synthetic sessions ──────
async function selftest() {
  const SECRET = "probe-selftest-secret";
  const LOC = "LOC_SELFTEST";
  process.env.GHL_SSO_SECRET = SECRET;
  process.env.GHL_LOCATION_ID = LOC;
  process.env.PIPELINE_ACCESS_MAP = "rep1:probe-ungranted-pipeline"; // must NOT leak in
  delete process.env.SSO_PROBE;

  const { default: CryptoJS } = await import("crypto-js");
  const { decryptSso } = await import("../lib/sso.ts");
  const { ssoProbeLine, ssoProbeEnabled, SSO_PROBE_TAG, maskEmail } = await import("../lib/ssoProbe.ts");
  const V = await import("../lib/visibility.ts");
  const PA = await import("../lib/pipelineAccess.ts");
  const AR = await import("../lib/adminRole.ts");
  const decide = makeDecider(V, PA, AR);

  let pass = 0, fail = 0;
  const ok = (n, c, got) => {
    if (c) { pass++; console.log(`  ok   ${n}`); }
    else { fail++; console.log(`  FAIL ${n}${got !== undefined ? `\n       got: ${JSON.stringify(got)}` : ""}`); }
  };
  const base = { companyId: "CO1", region: "us", versionId: "v", appStatus: "live" };
  const S = {
    owner: { ...base, userId: "own1", role: "admin", type: "agency", isAgencyOwner: true, activeLocation: LOC, userName: "Olive Owner", email: "olive@mm.com" },
    agencyAdmin: { ...base, userId: "aa1", role: "admin", type: "agency", isAgencyOwner: false, activeLocation: LOC, userName: "Andy Agency", email: "andy@mm.com" },
    subAdmin: { ...base, userId: "sa1", role: "admin", type: "account", isAgencyOwner: false, activeLocation: LOC, userName: "Sam Sub", email: "sam@mm.com" },
    rep: { ...base, userId: "rep1", role: "user", type: "account", isAgencyOwner: false, activeLocation: LOC, userName: "Rita Rep", email: "rita@mm.com" },
  };
  const enc = (o) => CryptoJS.AES.encrypt(JSON.stringify(o), SECRET).toString();
  const asLog = (o) => `2026-10-26T10:00:00Z  info  ${ssoProbeLine(decryptSso(enc(o)))}`;

  console.log("\n1 · THE LOG LINE — what the deployment writes");
  ok("probe is OFF unless SSO_PROBE=1", ssoProbeEnabled() === false);
  const blob = enc(S.owner);
  const line = ssoProbeLine(decryptSso(blob));
  ok("🔴 the blob never appears in the line", !line.includes(blob));
  ok("email is masked", line.includes("ol***@mm.com") && !line.includes("olive@mm.com"), line);
  ok("isAgencyOwner survives (a key the app does not read today)", line.includes('"isAgencyOwner":true'));
  ok("maskEmail of nothing is empty", maskEmail("") === "" && maskEmail(undefined) === "");
  const parsed = parseLogs(`noise\n${asLog(S.owner)}\n"quoted ${SSO_PROBE_TAG} junk"\n`, SSO_PROBE_TAG);
  ok("a log file round-trips through --logs parsing", parsed.length === 1 && parsed[0].payload.userId === "own1", parsed.length);

  console.log("\n2 · TODAY'S BEHAVIOUR · owner arrives as role \"admin\" (what the SSO doc shows)");
  const users = [
    { id: "own1", name: "Olive Owner", roles: { type: "agency", role: "admin", locationIds: [LOC] } },
    { id: "aa1", name: "Andy Agency", roles: { type: "agency", role: "admin", locationIds: [LOC] } },
    { id: "sa1", name: "Sam Sub", roles: { type: "account", role: "admin", locationIds: [LOC] } },
    { id: "rep1", name: "Rita Rep", roles: { type: "account", role: "user", locationIds: [LOC] } },
  ];
  const appUsers = users.map((u) => ({ id: u.id, name: u.name, role: u.roles.role }));
  const caps = [S.owner, S.agencyAdmin, S.subAdmin, S.rep, S.owner].map((o) => parseLogs(asLog(o), SSO_PROBE_TAG)[0]);
  const r1 = buildReport({ captures: caps, apiUsers: users, appUsers, loc: LOC, decide, isAdmin: (x) => V.isAdminSession(x) });
  ok("duplicate loads collapse to one row per person", r1.people.length === 4, r1.people.length);
  ok("owner classified from isAgencyOwner", r1.people.some((x) => x.label === "Agency Owner"));
  const cmp = (a) => r1.comparisons.find((c) => c.against.startsWith(a));
  ok("Owner vs Agency Admin: SAME", cmp("Agency Admin")?.result === "SAME", cmp("Agency Admin"));
  ok("Owner vs Sub-account Admin: SAME", cmp("Sub-account Admin")?.result === "SAME", cmp("Sub-account Admin"));
  const rep = r1.people.find((x) => x.userId === "rep1");
  ok("control: the rep does NOT see someone else's record", rep.access.seeOthersRecord === false, rep.access);
  ok("control: PIPELINE_ACCESS_MAP from the env did not leak in", rep.access.seeOthersRecord === false);
  ok("control: the rep gets no admin screens", rep.access.adminScreens === false);
  ok("no findings on a clean account", r1.findings.length === 0, r1.findings);

  console.log("\n3 · ROUND 180 · the owner arrives as role \"owner\" — what GoHighLevel really sends");
  // 🔴 Confirmed live 26 Oct 2026: John Ratigan's own dashboard read
  // "Signed in · John Ratigan · owner". Before round 180 this case was a rep.
  const ownerAsOwner = { ...S.owner, role: "owner" };
  const users2 = users.map((u) => (u.id === "own1" ? { ...u, roles: { ...u.roles, role: "owner" } } : u));
  const r2 = buildReport({
    captures: [ownerAsOwner, S.agencyAdmin, S.subAdmin].map((o) => ({ payload: o, source: "blob" })),
    apiUsers: users2, appUsers: users2.map((u) => ({ id: u.id, name: u.name, role: u.roles.role })),
    loc: LOC, decide, isAdmin: (x) => V.isAdminSession(x),
  });
  const c2 = r2.comparisons.find((c) => c.against.startsWith("Agency Admin"));
  const c2s = r2.comparisons.find((c) => c.against.startsWith("Sub-account Admin"));
  ok("🔴 Owner (role \"owner\") vs Agency Admin: SAME", c2?.result === "SAME", c2);
  ok("🔴 Owner (role \"owner\") vs Sub-account Admin: SAME", c2s?.result === "SAME", c2s);
  const own = r2.people.find((x) => x.userId === "own1");
  ok("  server admin, admin screens and the browser's admin UI all yes",
    own.access.serverAdmin && own.access.adminScreens && own.access.clientAdminUi, own.access);
  ok("  sees a record owned by someone else in an ungranted pipeline", own.access.seeOthersRecord === true);
  ok("  no 'treated as a rep' finding any more", !r2.findings.some((f) => f.includes("treated as a rep")), r2.findings);
  ok("  the Users API's \"owner\" is an admin too (reassign followers, Access tab)", r2.users.find((u) => u.id === "own1").appTreatsAsAdmin === true);
  ok("  \"owner\" is not reported as an unknown role", !r2.findings.some((f) => f.includes('has role "owner"')), r2.findings);
  const r2b = buildReport({
    captures: [], appUsers: [], loc: LOC, decide, isAdmin: (x) => V.isAdminSession(x),
    apiUsers: [{ id: "x1", name: "Odd Role", roles: { type: "agency", role: "superuser", locationIds: [LOC] } }],
  });
  ok("control: a role that is neither admin, owner nor user is still flagged", r2b.findings.some((f) => f.includes('has role "superuser"')), r2b.findings);
  ok("control: and it is NOT an admin", r2b.users[0].appTreatsAsAdmin === false);
  const repAsAgency = decide({ userId: "r9", role: "user", type: "agency" });
  ok("control: an AGENCY-type user with role \"user\" is still a rep (type is not permission)", repAsAgency.serverAdmin === false && repAsAgency.seeOthersRecord === false, repAsAgency);

  console.log("\n4 · LOCATION BINDING AND OTHER EDGES");
  const foreign = { ...S.subAdmin, userId: "x9", userName: "Foreign Admin", activeLocation: "OTHER_LOC", companyId: "CO2" };
  const agencyView = { ...S.agencyAdmin, userId: "aa2", userName: "Agency View", activeLocation: undefined };
  const r3 = buildReport({
    captures: [S.owner, foreign, agencyView].map((o) => ({ payload: o, source: "blob" })),
    apiUsers: [...users, { id: "gone", name: "Gone User", deleted: true, roles: { type: "account", role: "user", locationIds: [LOC] } }],
    appUsers, loc: LOC, decide, isAdmin: (x) => V.isAdminSession(x),
  });
  ok("🔴 an admin from ANOTHER sub-account is flagged", r3.findings.some((f) => f.includes("DIFFERENT sub-account")), r3.findings);
  ok("  …and today it really is admin here (the gap the fix closes)", r3.people.find((x) => x.userId === "x9").access.serverAdmin === true);
  ok("⚠️ agency-view (no activeLocation) admin is flagged", r3.findings.some((f) => f.includes("AGENCY view")));
  ok("🔴 two companyIds accepted is flagged", r3.findings.some((f) => f.includes("different companyIds")));
  ok("⚠️ a deleted user still returned is flagged", r3.findings.some((f) => f.includes("marked deleted")));
  ok("owner missing from the location user list is flagged", buildReport({
    captures: [{ payload: S.owner }], apiUsers: users.filter((u) => u.id !== "own1"), appUsers: [], loc: LOC, decide, isAdmin: (x) => V.isAdminSession(x),
  }).findings.some((f) => f.includes("NOT in GET /users")));
  const r4 = buildReport({ captures: [{ payload: S.agencyAdmin }], apiUsers: null, appUsers: null, loc: LOC, decide, isAdmin: (x) => V.isAdminSession(x) });
  ok("no owner captured → no comparison, no crash", r4.comparisons.length === 0);

  console.log("\n5 · THE PRINTED REPORT (section 3's data)");
  printReport(r2, { hadCaptures: true, hadUsers: true });

  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

(flag("--selftest") ? selftest() : main()).catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
