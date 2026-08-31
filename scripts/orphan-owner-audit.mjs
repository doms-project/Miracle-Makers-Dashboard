// ITEM 1 — WHICH RECORDS ARE OWNED BY SOMEONE WITHOUT ACCESS TO THEIR PIPELINE?
//
// The live example was njumOfcXVvBtP3vyh6DR: a Private Pay case assigned to Bill
// Lockfeld, who is mapped to ODP only. Bill sees it through the OWNER path;
// Jackie — whose home pipeline it is — does NOT, because she is not the owner,
// not a follower, and the record is not unassigned. It fails all three branches
// of the visibility rule, so it is invisible to the division that owns the work.
//
// This finds every record in that state. READ-ONLY: it sends GETs and writes
// nothing.
//
// Run:
//   GHL_PIT=… GHL_LOCATION_ID=… PIPELINE_IDS=id1,id2,… node scripts/orphan-owner-audit.mjs
//
// The access map is read from the SAME place the dashboard reads it — the
// "MM Pipeline Access" custom value — so this reports on what is actually in
// force, not on a copy that could have drifted. If that value is missing it
// falls back to PIPELINE_ACCESS_MAP, exactly as the app does.

const BASE = "https://services.leadconnectorhq.com";
const PIT = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "").trim();
const PIPES = (process.env.PIPELINE_IDS || "").split(/[,|\s]+/).filter(Boolean);
const ACCESS_CUSTOM_VALUE_NAME = "MM Pipeline Access";

if (!PIT || !LOC) {
  console.error("Set GHL_PIT and GHL_LOCATION_ID.");
  process.exit(1);
}
const H = { Authorization: `Bearer ${PIT}`, Version: "2021-07-28", Accept: "application/json" };

async function get(path) {
  const res = await fetch(BASE + path, { headers: H });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}\n${text.slice(0, 400)}`);
  return JSON.parse(text);
}

// ---- who is mapped to what -------------------------------------------------
let grants = {};
let source = "";
try {
  const cv = await get(`/locations/${LOC}/customValues`);
  const hit = (cv.customValues || []).find(
    (c) => (c.name || "").trim().toLowerCase() === ACCESS_CUSTOM_VALUE_NAME.toLowerCase(),
  );
  if (hit?.value) {
    const parsed = JSON.parse(hit.value);
    // v2 keeps pipelines under its own key; a legacy value is the flat map.
    grants = parsed.pipelines || parsed.folders !== undefined ? parsed.pipelines || {} : parsed;
    source = `the "${ACCESS_CUSTOM_VALUE_NAME}" custom value`;
  }
} catch (e) {
  console.error("Couldn't read the access custom value:", e.message);
}
if (!Object.keys(grants).length && process.env.PIPELINE_ACCESS_MAP) {
  try {
    grants = JSON.parse(process.env.PIPELINE_ACCESS_MAP);
    source = "the PIPELINE_ACCESS_MAP env var (nothing stored yet)";
  } catch { /* reported below */ }
}
if (!Object.keys(grants).length) {
  console.error(
    "No access map found. Every owned record would be reported, which is noise, not a finding. Stopping.",
  );
  process.exit(1);
}

const users = new Map(
  ((await get(`/users/?locationId=${LOC}`)).users || []).map((u) => [
    u.id,
    { name: `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email || u.id, role: u.roles?.role || "" },
  ]),
);
const pipelines = new Map(
  ((await get(`/opportunities/pipelines?locationId=${LOC}`)).pipelines || []).map((p) => [p.id, p.name]),
);
const wanted = PIPES.length ? PIPES : [...pipelines.keys()];

console.log(`Access map read from ${source}: ${Object.keys(grants).length} user(s) mapped.`);
console.log(`Auditing ${wanted.length} pipeline(s), ${users.size} users.\n`);

// ---- walk every opportunity ------------------------------------------------
const orphans = [];
let total = 0;
for (const pid of wanted) {
  let page = 1;
  for (;;) {
    const q = new URLSearchParams({ location_id: LOC, pipeline_id: pid, limit: "100", page: String(page) });
    const body = await get(`/opportunities/search?${q}`);
    const opps = body.opportunities || [];
    if (!opps.length) break;
    for (const o of opps) {
      total++;
      const owner = o.assignedTo;
      if (!owner) continue; // unassigned is a different state, and is claimable
      const held = grants[owner] || [];
      if (held.includes(pid)) continue; // owner has access — fine
      const u = users.get(owner);
      // An ADMIN sees every pipeline regardless of the map, so they are never
      // an orphan. Reporting them would bury the real ones.
      if (u?.role === "admin") continue;
      // ⚠️ A FOLLOWER WITH ACCESS MEANS IT IS NOT AN ORPHAN.
      //
      // This is exactly what a transfer with "Keep me on this lead" produces:
      // the owner sits outside the map and the previous owner stays on as a
      // follower. Somebody with that pipeline can still see the record, so
      // nothing is hidden and nothing needs fixing. Reporting it alongside the
      // real ones made three findings look equal when only two were.
      const coveredBy = (o.followers || []).filter((f) =>
        (grants[f] || []).includes(pid),
      );
      orphans.push({
        id: o.id,
        name: o.name || "(unnamed)",
        pipeline: pipelines.get(pid) || pid,
        stage: o.pipelineStageId,
        owner: u?.name || `unknown user ${owner}`,
        ownerId: owner,
        ownerHolds: held.map((h) => pipelines.get(h) || h),
        followers: (o.followers || []).length,
        coveredBy: coveredBy.map((f) => users.get(f)?.name || f),
      });
    }
    if (opps.length < 100) break;
    page++;
  }
}

// ---- report ----------------------------------------------------------------
// Split before reporting: covered records are a note, not a finding.
const covered = orphans.filter((o) => o.coveredBy.length);
const real = orphans.filter((o) => !o.coveredBy.length);

console.log(`Scanned ${total} opportunit${total === 1 ? "y" : "ies"}.\n`);
if (covered.length) {
  console.log(
    `✓ ${covered.length} record(s) have an owner outside the map but a FOLLOWER who holds that pipeline.\n` +
    `  Not orphans — this is what a transfer with "Keep me on this lead" produces, and\n` +
    `  somebody with access can still see them. Listed for completeness only:\n`,
  );
  for (const o of covered)
    console.log(`    ${o.id}  ${o.name}  →  ${o.pipeline}  (owner ${o.owner}; visible to ${o.coveredBy.join(", ")})`);
  console.log();
}
orphans.length = 0;
orphans.push(...real);
if (!orphans.length) {
  console.log("✓ No orphaned records: every record is visible to somebody who holds its pipeline.");
  process.exit(0);
}
console.log(`🔴 ${orphans.length} record(s) owned by someone WITHOUT access to that pipeline, and with NO follower who has it.\n`);
console.log(
  "These are visible to their owner (the owner path), but INVISIBLE to the division\n" +
  "that the pipeline belongs to — not owner, not follower, not unassigned.\n",
);
const byOwner = new Map();
for (const o of orphans) {
  if (!byOwner.has(o.ownerId)) byOwner.set(o.ownerId, []);
  byOwner.get(o.ownerId).push(o);
}
for (const [ownerId, rows] of [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const o0 = rows[0];
  console.log(`${o0.owner}  (${rows.length} record${rows.length === 1 ? "" : "s"})`);
  console.log(`  has access to: ${o0.ownerHolds.length ? o0.ownerHolds.join(", ") : "NOTHING — unmapped"}`);
  for (const r of rows)
    console.log(`    ${r.id}  ${r.name}  →  ${r.pipeline}${r.followers ? `  (${r.followers} follower(s))` : ""}`);
  console.log();
}
console.log(
  "FIXES, in order of least surprise:\n" +
  "  1. grant that user the pipeline in the Access tab — if the assignment was right;\n" +
  "  2. reassign the record to someone in that division — if it was not;\n" +
  "  3. add a division member as a FOLLOWER — if it must stay where it is.\n" +
  "Records already covered by a follower are listed above and need nothing.",
);
