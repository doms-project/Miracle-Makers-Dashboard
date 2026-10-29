// ---------------------------------------------------------------------------
// POST-DEPLOY CHECK — is the live dashboard running round 185, and does it work?
//
// READ-ONLY BY DEFAULT. It signs in the way GoHighLevel does (an SSO payload
// encrypted with the dashboard's own secret) and reads, as an admin:
//
//   1. the build the site is serving            (the footer stamp, v185)
//   2. both boards load                          (Clients and Recruiting)
//   3. link badges are readable on both boards   (rounds 183/184)
//   4. a linked client's and a linked caregiver's badge equals the list their
//      panel shows — on REAL records          (rounds 183/184)
//   5. Referring Partner / Event Host ids resolve to partner names (round 185)
//   6. a client's contact sections: how many show, how many are tucked away;
//      a caregiver's sections as filled / total (round 185)
//
// It judges what it reads with the dashboard's OWN code (lib/linkCounts.ts,
// lib/fieldFolders.ts), so it cannot pass on a rule the screen does not use.
//
// Run (from the project folder):
//   DASHBOARD_URL=https://your-dashboard.vercel.app \
//   GHL_SSO_SECRET=<same value as in Vercel> \
//   GHL_LOCATION_ID=<location id> \
//   npx tsx scripts/postdeploy-check.mjs
//
// Optional:
//   EXPECT_ROUND=185      default: the round in lib/build.ts
//   CHECK_USER_ID=<id>    a real GoHighLevel user id to sign in as (admin role);
//                         default "postdeploy-check"
//
// OPTIONAL WRITE TEST — links two TEST records, checks both badges and the
// panel, then unlinks and checks they return. Use test records only:
//   WRITE_TEST=1 TEST_CLIENT_OPP_ID=<a test client's case id> \
//   TEST_CAREGIVER_CONTACT_ID=<a test caregiver's contact id>
//
// ⚠️ NEVER PRINTS THE SECRET OR THE SIGN-IN BLOB.
// ⚠️ NOT CHECKED: how anything renders. That needs a browser.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import CryptoJS from "crypto-js";

const L = await import("../lib/linkCounts.ts");
const F = await import("../lib/fieldFolders.ts");
const R = await import("../lib/referrals.ts");

const URL_ = (process.env.DASHBOARD_URL || "").trim().replace(/\/+$/, "");
const SECRET = (process.env.GHL_SSO_SECRET || "").trim();
const LOC = (process.env.GHL_LOCATION_ID || "").trim();
const USER = (process.env.CHECK_USER_ID || "postdeploy-check").trim();
const EXPECT =
  (process.env.EXPECT_ROUND || "").trim() ||
  /round:\s*"(\d+[a-z]?)/.exec(readFileSync(new URL("../lib/build.ts", import.meta.url), "utf8"))?.[1] ||
  "";

const tty = process.stdout.isTTY;
const c = (n, s) => (tty ? `\x1b[${n}m${s}\x1b[0m` : s);
let fails = 0, warns = 0;
const PASS = (s, d = "") => console.log(`${c(32, "PASS")}  ${s}${d ? c(2, `  ·  ${d}`) : ""}`);
const FAIL = (s, d = "") => { fails++; console.log(`${c(31, "FAIL")}  ${s}${d ? c(2, `  ·  ${d}`) : ""}`); };
const WARN = (s, d = "") => { warns++; console.log(`${c(33, "WARN")}  ${s}${d ? c(2, `  ·  ${d}`) : ""}`); };
const INFO = (s) => console.log(c(2, `      ${s}`));

const missing = [
  !URL_ && "DASHBOARD_URL",
  !SECRET && "GHL_SSO_SECRET",
  !LOC && "GHL_LOCATION_ID",
].filter(Boolean);
if (missing.length) {
  console.log(c(31, `Set ${missing.join(", ")} — see the top of this file.`));
  process.exit(1);
}

const blob = CryptoJS.AES.encrypt(
  JSON.stringify({ userId: USER, role: "admin", type: "agency", activeLocation: LOC }),
  SECRET,
).toString();

async function api(path, init = {}) {
  const res = await fetch(URL_ + path, {
    ...init,
    headers: {
      "x-ghl-sso-key": blob,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}
const errOf = (r) => r.json?.error || r.json?.detail || r.text.slice(0, 160);
const nm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** How a record is named on screen: the case name, else the person. */
const recName = (rec) => rec?.oppName || rec?.contactName || [rec?.first, rec?.last].filter(Boolean).join(" ") || rec?.id || "?";

console.log(`Post-deploy check · ${URL_} · expecting v${EXPECT}\n`);

// 1 · Which build is live ─────────────────────────────────────────────────────
{
  const res = await fetch(URL_ + "/", { signal: AbortSignal.timeout(60_000) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
  const html = await res.text();
  const seen = [...new Set(html.match(/\bv\d{3}[a-z]?\b/g) || [])];
  if (!res.ok) FAIL("the dashboard page loads", `HTTP ${res.status}`);
  else if (seen.includes(`v${EXPECT}`)) PASS(`the live build is v${EXPECT}`);
  else
    FAIL(
      `the live build is v${EXPECT}`,
      seen.length ? `the page says ${seen.join(", ")} — the deploy has not finished, or a CDN is serving the old page` : "no build stamp found in the page",
    );
}

// 2 · Sign-in and both boards ─────────────────────────────────────────────────
const boards = {};
for (const [key, path, label] of [
  ["client", "/api/opportunities", "Clients board"],
  ["caregiver", "/api/opportunities?scope=caregiver", "Recruiting board"],
]) {
  // The page loads a board by POST with the sign-in in the body; a GET is the
  // signed-out view and always answers 401 once SSO is configured.
  const r = await api(path, { method: "POST", body: JSON.stringify({ ssoKey: blob }) });
  if (r.status === 401 || r.status === 403) {
    FAIL(`${label} loads`, `sign-in refused (${r.status}): ${errOf(r)} — check GHL_SSO_SECRET and GHL_LOCATION_ID`);
    continue;
  }
  if (!r.ok) { FAIL(`${label} loads`, `HTTP ${r.status}: ${errOf(r)}`); continue; }
  const recs = r.json?.records || [];
  const failedP = r.json?.failedPipelines || [];
  boards[key] = r.json;
  if (!recs.length) WARN(`${label} loads`, "0 records");
  else PASS(`${label} loads`, `${recs.length} records${failedP.length ? ` · ${failedP.length} pipeline(s) failed: ${failedP.map((p) => p.name).join(", ")}` : ""}`);
}
if (!boards.client && !boards.caregiver) {
  console.log(c(31, "\nCannot continue without a board."));
  process.exit(1);
}

// 3 · Badge counts on both boards ─────────────────────────────────────────────
async function countsFor(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 60) {
    const r = await api("/api/relations/counts", {
      method: "POST",
      body: JSON.stringify({ ssoKey: blob, contactIds: ids.slice(i, i + 60) }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${errOf(r)}`);
    const unknown = new Set(r.json?.unknown || []);
    for (const id of ids.slice(i, i + 60))
      out[id] = unknown.has(id) || !r.json?.counts?.[id] ? { unknown: true } : r.json.counts[id];
  }
  return out;
}
const linked = {};
for (const kind of ["client", "caregiver"]) {
  const recs = boards[kind]?.records || [];
  if (!recs.length) continue;
  const ids = [...new Set(recs.map((r) => r.contactId).filter(Boolean))].slice(0, 180);
  const label = kind === "client" ? "Clients" : "Recruiting";
  try {
    const counts = await countsFor(ids);
    const vals = Object.entries(counts);
    const unknown = vals.filter(([, v]) => v.unknown).length;
    const withLinks = vals.filter(([, v]) => !v.unknown && (v.caregivers || v.clients));
    if (unknown > vals.length / 4) WARN(`${label}: link badges readable`, `${unknown} of ${vals.length} came back "links unknown"`);
    else PASS(`${label}: link badges readable`, `${vals.length} checked · ${withLinks.length} linked${unknown ? ` · ${unknown} unknown` : ""}`);
    const hit = withLinks[0];
    if (hit) linked[kind] = { rec: recs.find((r) => r.contactId === hit[0]), count: hit[1] };
  } catch (e) {
    FAIL(`${label}: link badges readable`, String(e.message || e));
  }
}

// 4 · Badge == panel, on real linked records ──────────────────────────────────
for (const kind of ["client", "caregiver"]) {
  const l = linked[kind];
  const label = kind === "client" ? "a linked client" : "a linked caregiver";
  if (!l) { WARN(`badge matches panel for ${label}`, "none found among the records checked"); continue; }
  const r = await api(`/api/opportunities/${encodeURIComponent(l.rec.id)}/caregivers`);
  if (!r.ok) { FAIL(`badge matches panel for ${label}`, `panel list: HTTP ${r.status}: ${errOf(r)}`); continue; }
  const list = r.json?.caregivers || [];
  const panel = L.countFromLinks(list);
  const same = panel.caregivers === l.count.caregivers && panel.clients === l.count.clients;
  const who = recName(l.rec);
  const fmt = (x) => `${x.caregivers} caregiver(s), ${x.clients} client(s)`;
  if (same) PASS(`badge matches panel for ${label}`, `${who}: ${fmt(panel)}`);
  else FAIL(`badge matches panel for ${label}`, `${who}: badge ${fmt(l.count)}, panel ${fmt(panel)}`);
  if (kind === "caregiver" && panel.clients === 0 && panel.caregivers > 0)
    WARN("caregiver's links point the right way", `${who} lists ${panel.caregivers} CAREGIVER(s), no clients — likely links stored backwards before round 170`);
}

// 5 · Partner names ───────────────────────────────────────────────────────────
{
  const defs = boards.client?.fieldDefs || [];
  const refId =
    defs.find((d) => nm(d.name) === nm("Referring Partner"))?.id ||
    (defs.some((d) => d.id === R.REFERRING_PARTNER_FIELD) ? R.REFERRING_PARTNER_FIELD : "");
  const hostId =
    defs.find((d) => R.EVENT_HOST_FIELD_NAMES.some((x) => nm(x) === nm(d.name)))?.id ||
    (defs.some((d) => d.id === R.EVENT_HOST_FIELD_ID) ? R.EVENT_HOST_FIELD_ID : "");
  const all = [...(boards.client?.records || []), ...(boards.caregiver?.records || [])];
  const wanted = new Map();
  for (const rec of all)
    for (const fid of [refId, hostId].filter(Boolean)) {
      const v = String(rec.cf?.[fid] ?? "").trim();
      if (v) wanted.set(`${rec.id}:${fid}`, { rec, v, field: fid === refId ? "Referring Partner" : "Event Host" });
    }
  if (!refId && !hostId) WARN("partner names resolve", "neither Referring Partner nor Event Host exists on this account");
  else if (!wanted.size) WARN("partner names resolve", "no loaded record has a Referring Partner or Event Host set");
  else {
    const r = await api("/api/referrals?only=partners");
    if (!r.ok) FAIL("partner names resolve", `partner list: HTTP ${r.status}: ${errOf(r)} — the panel would show "couldn't load"`);
    else {
      const byId = new Map((r.json?.partners || []).map((p) => [p.id, p.org]));
      const items = [...wanted.values()];
      const bad = items.filter((x) => !byId.has(x.v));
      const good = items.length - bad.length;
      const sample = items.find((x) => byId.has(x.v));
      if (!bad.length) PASS("partner names resolve", `${good} of ${items.length}${sample ? ` · e.g. ${recName(sample.rec)} → ${byId.get(sample.v)}` : ""}`);
      else
        WARN(
          "partner names resolve",
          `${good} of ${items.length} resolve; ${bad.length} show "a partner not in your list" (deleted partner or a mistyped id) — e.g. ${recName(bad[0].rec)} · ${bad[0].field}`,
        );
    }
  }
}

// 6 · Contact sections ────────────────────────────────────────────────────────
const folderNames = boards.client?.folderNames || boards.caregiver?.folderNames || {};
async function sections(kind, rec) {
  const r = await api(`/api/contacts/${encodeURIComponent(rec.id)}/fields`);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${errOf(r)}`);
  return F.groupContactFields(r.json?.fieldDefs || [], kind, r.json?.values || {}, folderNames).map((g) => ({
    ...g,
    values: r.json?.values || {},
  }));
}
{
  const rec = linked.client?.rec || boards.client?.records?.[0];
  if (rec) {
    try {
      const gs = await sections("client", rec);
      const quiet = gs.filter((g) => g.fields.length === 0);
      PASS(
        "client contact sections",
        `${recName(rec)}: ${gs.length - quiet.length} shown, ${quiet.length} behind "Show ${quiet.length} empty section${quiet.length === 1 ? "" : "s"}"`,
      );
      if (quiet.length) INFO(`tucked away: ${quiet.map((g) => g.label).join(", ")}`);
    } catch (e) { FAIL("client contact sections", String(e.message || e)); }
  }
  const cg = linked.caregiver?.rec || boards.caregiver?.records?.[0];
  if (cg) {
    try {
      const gs = await sections("caregiver", cg);
      const empty = gs.filter((g) => g.hidden !== undefined || !g.fields.length);
      if (empty.length) FAIL("caregiver sections list every field", `${empty.map((g) => g.label).join(", ")} would be hidden — caregiver intake depends on every field showing`);
      else
        PASS(
          "caregiver sections show filled / total",
          `${recName(cg)}: ${gs.map((g) => `${g.label} ${g.fields.filter((d) => F.hasValue(g.values[d.id])).length}/${g.fields.length}`).join(" · ")}`,
        );
    } catch (e) { FAIL("caregiver sections", String(e.message || e)); }
  }
}

// 7 · Optional write test ─────────────────────────────────────────────────────
if (process.env.WRITE_TEST === "1") {
  const oppId = (process.env.TEST_CLIENT_OPP_ID || "").trim();
  const cgContact = (process.env.TEST_CAREGIVER_CONTACT_ID || "").trim();
  if (!oppId || !cgContact) FAIL("write test", "set TEST_CLIENT_OPP_ID and TEST_CAREGIVER_CONTACT_ID (test records only)");
  else {
    const rec = (boards.client?.records || []).find((r) => r.id === oppId);
    const clientContact = rec?.contactId;
    if (!clientContact) FAIL("write test", "TEST_CLIENT_OPP_ID is not on the Clients board");
    else {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const read = async () => (await countsFor([clientContact, cgContact]));
      const settle = async (pred) => { for (let i = 0; i < 8; i++) { const v = await read(); if (pred(v)) return v; await sleep(2000); } return read(); };
      const before = await read();
      const b = (id) => before[id];
      const add = await api(`/api/opportunities/${encodeURIComponent(oppId)}/caregivers`, {
        method: "POST",
        body: JSON.stringify({ ssoKey: blob, caregiverContactId: cgContact }),
      });
      if (!add.ok) FAIL("write test · link", `HTTP ${add.status}: ${errOf(add)}`);
      else {
        const rel = (add.json?.caregivers || []).find((x) => x.contactId === cgContact);
        const after = await settle((v) => v[clientContact]?.caregivers === (b(clientContact).caregivers || 0) + 1);
        const okClient = after[clientContact]?.caregivers === (b(clientContact).caregivers || 0) + 1;
        const okCg = after[cgContact]?.clients === (b(cgContact).clients || 0) + 1;
        if (rel && okClient && okCg) PASS("write test · link", "client +1 caregiver, caregiver +1 client, panel lists it");
        else FAIL("write test · link", `panel lists it: ${!!rel} · client badge +1: ${okClient} · caregiver badge +1: ${okCg}`);
        if (rel) {
          const del = await api(`/api/opportunities/${encodeURIComponent(oppId)}/caregivers`, {
            method: "DELETE",
            body: JSON.stringify({ ssoKey: blob, relationId: rel.relationId }),
          });
          const back = await settle((v) => v[clientContact]?.caregivers === b(clientContact).caregivers);
          const restored = back[clientContact]?.caregivers === b(clientContact).caregivers && back[cgContact]?.clients === b(cgContact).clients;
          if (del.ok && restored) PASS("write test · unlink", "both badges back to where they started");
          else FAIL("write test · unlink", `HTTP ${del.status}${restored ? "" : " · badges did not return — check the two test records by hand"}`);
        }
      }
    }
  }
}

console.log("");
if (fails) console.log(c(31, `${fails} check(s) FAILED${warns ? `, ${warns} warning(s)` : ""}. Do not tell anyone it is fixed yet.`));
else console.log(c(32, `All checks passed${warns ? ` (${warns} warning(s) — read them)` : ""}.`));
console.log(c(2, "Not checked: how the screens render. Open one client and one caregiver once to see them."));
process.exit(fails ? 1 : 0);
