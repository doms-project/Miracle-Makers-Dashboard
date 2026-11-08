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
//   7. the data rounds 188–195 rely on, read from the live boards: a phone on
//      each record (phone search), "last updated" (edited goes to the top),
//      created dates (the Created filter), "New lead" labels (pinned on top);
//      and the search itself, run on real records with the dashboard's own
//      code (lib/smartSearch.ts): a phone finds its lead, a sales rep's name
//      suggests that rep first
//   8. ONE PERSON, SEVERAL CASES — how many people hold cases in more than
//      one pipeline (an ODP case and an OLTL case, say), and whether anyone
//      holds two in the SAME pipeline (GoHighLevel allows one per pipeline
//      unless "Allow multiple opportunities per contact" is on)
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
//   LINKED_CLIENT="<name>"     a client you know has a caregiver linked, and
//   LINKED_CAREGIVER="<name>"  a caregiver you know has a client linked. The
//                         check otherwise samples only the first 180 people on
//                         each board, and may find no linked pair among them.
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

/** Printed first, so a run can be matched to the copy of this file used. */
const SCRIPT_VERSION = "postdeploy-check 196.1";

const L = await import("../lib/linkCounts.ts");
const F = await import("../lib/fieldFolders.ts");
const R = await import("../lib/referrals.ts");
const SS = await import("../lib/smartSearch.ts");
const OW = await import("../lib/owners.ts");

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

console.log(`${SCRIPT_VERSION} · ${URL_} · expecting v${EXPECT}\n`);

// 1 · Which build is live ─────────────────────────────────────────────────────
{
  const res = await fetch(URL_ + "/", { signal: AbortSignal.timeout(60_000) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }));
  const html = await res.text();
  // The footer renders the stamp as ">v185</div>"; matching that shape keeps
  // other text that merely looks like a version number out of the answer.
  const seen = [...new Set([...html.matchAll(/>v(\d{3}[a-z]?)</g)].map((m) => `v${m[1]}`))];
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
const named = {
  client: (process.env.LINKED_CLIENT || "").trim().toLowerCase(),
  caregiver: (process.env.LINKED_CAREGIVER || "").trim().toLowerCase(),
};
for (const kind of ["client", "caregiver"]) {
  const recs = boards[kind]?.records || [];
  if (!recs.length) continue;
  // A named record goes first, so it is checked whatever the sample holds.
  const pick = named[kind]
    ? recs.find((r) => `${r.oppName} ${r.contactName}`.toLowerCase().includes(named[kind]))
    : null;
  if (named[kind] && !pick) WARN(`${kind === "client" ? "LINKED_CLIENT" : "LINKED_CAREGIVER"} found on the board`, `no record matching "${named[kind]}"`);
  const ids = [...new Set([pick?.contactId, ...recs.map((r) => r.contactId)].filter(Boolean))].slice(0, 180);
  const label = kind === "client" ? "Clients" : "Recruiting";
  try {
    const counts = await countsFor(ids);
    const vals = Object.entries(counts);
    const unknown = vals.filter(([, v]) => v.unknown).length;
    const withLinks = vals.filter(([, v]) => !v.unknown && (v.caregivers || v.clients));
    if (unknown > vals.length / 4) WARN(`${label}: link badges readable`, `${unknown} of ${vals.length} came back "links unknown"`);
    else PASS(`${label}: link badges readable`, `${vals.length} checked · ${withLinks.length} linked${unknown ? ` · ${unknown} unknown` : ""}`);
    const hit = (pick && withLinks.find(([id]) => id === pick.contactId)) || withLinks[0];
    if (pick && !withLinks.some(([id]) => id === pick.contactId))
      WARN(`${recName(pick)} has links`, "the server counts none for this person — is the link in place?");
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
  // ONE field named "Referring Partner" is what the panel, "Referred by" and
  // the Referrals screen all assume: each picks the FIRST match. A second field
  // of the same name is shown as an ordinary box holding a raw id, and its
  // values are invisible to "Referred by".
  {
    const same = defs.filter((d) => nm(d.name) === nm("Referring Partner"));
    if (same.length > 1) {
      const fn = boards.client?.folderNames || {};
      const recs = [...(boards.client?.records || []), ...(boards.caregiver?.records || [])];
      const desc = same.map((d, i) => {
        const filled = recs.filter((r) => String(r.cf?.[d.id] ?? "").trim()).length;
        return `${i === 0 ? "USED" : "IGNORED"} ${d.id} in "${fn[d.parentId] || d.parentId || "no folder"}" · ${filled} record(s) hold a value`;
      });
      WARN(`exactly one "Referring Partner" field`, `${same.length} exist — ${desc.join(" | ")}`);
    } else if (same.length === 1) PASS(`exactly one "Referring Partner" field`, same[0].id);
  }
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


// 7 · The data rounds 188–195 rely on ──────────────────────────────────────
{
  const clientRecs = boards.client?.records || [];
  const cgRecs = boards.caregiver?.records || [];
  const all = [...clientRecs, ...cgRecs];
  if (all.length) {
    const of = (n) => `${n} of ${all.length}`;
    const phoneOf = (r) => String(r.contactPhone || "").replace(/\D/g, "");
    const withPhone = all.filter((r) => phoneOf(r).length >= 7).length;
    if (!withPhone)
      FAIL("records carry a phone (round 195: search by phone)", `none of ${all.length} do — searching a phone number will find nobody until the board payload includes contactPhone`);
    else if (withPhone < all.length / 2)
      WARN("records carry a phone (round 195: search by phone)", `${of(withPhone)} — the rest cannot be found by phone (no phone on the contact, or none in the payload)`);
    else PASS("records carry a phone (round 195: search by phone)", of(withPhone));

    const withUpd = all.filter((r) => r.updatedAt).length;
    if (!withUpd)
      WARN("records carry \"last updated\" (round 191: edited goes to the top)", "none do — new leads and stage moves go to the top today; a field edit or a returning form will too once the server sends updatedAt");
    else PASS("records carry \"last updated\" (round 191: edited goes to the top)", of(withUpd));

    const noCreated = all.filter((r) => !r.createdAt).length;
    if (noCreated) WARN("records carry a created date (round 188: Created filter)", `${noCreated} do not — a date range leaves them out and says how many`);
    else PASS("records carry a created date (round 188: Created filter)", `all ${all.length}`);

    const unopened = all.filter((r) => r.newLead === true).length;
    INFO(`${unopened} unopened "New lead" case(s) — these sit at the top of every board until opened (round 192)`);

    // The search, run on real records with the dashboard's own code.
    const ix = (r) =>
      SS.indexRecord([r.oppName, r.first, r.last, r.office, r.stage, r.harmony, r.cm, r.cg, r.rep, r.src], r.contactPhone, r.contactEmail);
    const sample = clientRecs.find((r) => phoneOf(r).length >= 10) || cgRecs.find((r) => phoneOf(r).length >= 10);
    if (sample) {
      const d = phoneOf(sample).slice(-10);
      const forms = [d.slice(-4), `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, `+1 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`];
      const missed = forms.filter((f) => !SS.matchesQuery(ix(sample), SS.parseQuery(f)));
      if (missed.length) FAIL("a phone finds its lead, in any format", `${recName(sample)}: not found by ${missed.join(" / ")}`);
      else PASS("a phone finds its lead, in any format", `${recName(sample)} by …${d.slice(-4)}, (${d.slice(0, 3)}) ${d.slice(3, 6)}-…, +1 …`);
    }
    const opts = OW.ownerOptions(clientRecs);
    const top = [...opts.owners].sort((a, b) => b.n - a.n)[0];
    if (top) {
      const first = top.name.split(/\s+/)[0];
      const sg = SS.suggest({
        query: first,
        ownerWord: "Sales rep",
        owners: opts.owners,
        unassigned: opts.unassigned,
        records: clientRecs.slice(0, 400).map((r) => ({ id: r.id, name: recName(r), detail: "", ix: ix(r), activity: 0 })),
      });
      const hit = sg.find((x) => x.kind === "owner" && x.value === top.id);
      if (!hit) FAIL("typing a sales rep's name suggests them", `"${first}" did not suggest ${top.name}`);
      else if (sg[0] !== hit) WARN("typing a sales rep's name suggests them first", `"${first}" suggests ${sg[0].label} (${sg[0].detail}) before ${top.name} — two people share the name; both are offered`);
      else PASS("typing a sales rep's name suggests them first", `"${first}" → ${hit.label} · ${hit.detail}`);
    }
  }
}

// 8 · One person, several cases ─────────────────────────────────────────────
{
  const all = [
    ...(boards.client?.records || []).map((r) => ({ ...r, _board: "Clients" })),
    ...(boards.caregiver?.records || []).map((r) => ({ ...r, _board: "Recruiting" })),
  ];
  const byPerson = new Map();
  for (const r of all) {
    if (!r.contactId) continue;
    const l = byPerson.get(r.contactId) || [];
    if (!l.some((x) => x.id === r.id)) l.push(r);
    byPerson.set(r.contactId, l);
  }
  const multi = [...byPerson.values()].filter((l) => l.length > 1);
  const samePipe = multi.filter((l) => new Set(l.map((x) => x.pipelineId)).size < l.length);
  const combos = new Map();
  for (const l of multi) {
    const k = [...new Set(l.map((x) => x.pipelineName || x.pipelineId))].sort().join(" + ");
    combos.set(k, (combos.get(k) || 0) + 1);
  }
  INFO(`${multi.length} person(s) hold more than one case on the boards you can see`);
  for (const [k, n] of [...combos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) INFO(`  ${n} × ${k}`);
  if (samePipe.length) {
    const ex = samePipe[0];
    WARN(
      "one case per person per pipeline",
      `${samePipe.length} person(s) hold two or more cases in the SAME pipeline — "Allow multiple opportunities per contact" is on, or a workflow creates instead of updating. e.g. ${recName(ex[0])}: ${ex.map((x) => `${x.pipelineName} (created ${String(x.createdAt || "?").slice(0, 10)})`).join(", ")}`,
    );
  } else if (multi.length)
    PASS("one case per person per pipeline", "a second form for a pipeline the person is already in updates their case; a form for another pipeline (ODP → OLTL) opens a new one");
  else INFO("nobody holds a second case among the records loaded");
}

// 9 · Optional write test ─────────────────────────────────────────────────────
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
