#!/usr/bin/env node
/**
 * PROOF that a move UPDATES the record rather than creating a duplicate.
 * Prints exactly the four things a green build cannot tell you:
 *   1. the record's pipelineId BEFORE
 *   2. the request method + path + body actually sent
 *   3. the record's pipelineId AFTER
 *   4. how many opportunities the CONTACT has across the configured pipelines
 *
 *   $env:GHL_PIT="pit-..."
 *   $env:OPP_ID="<opportunity id>"
 *   $env:TO_PIPELINE_ID="<destination pipeline id>"
 *   $env:TO_STAGE_ID="<destination stage id>"     # optional; defaults to TRANSFERRED IN
 *   node scripts/move-proof.mjs
 *
 * This performs a REAL move. Use a test record.
 */
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
const OPP = (process.env.OPP_ID || "").trim();
const TO_PIPE = (process.env.TO_PIPELINE_ID || "").trim();
let TO_STAGE = (process.env.TO_STAGE_ID || "").trim();
const PIPELINE_IDS = (process.env.PIPELINE_IDS ||
  "KGjdCMG4F8xILk0ineB9,74Pt3XX4hgBIqD10mW4G,a14NtTi18ACxs99bHPmL,PIs1iWVk0HqHZFNtmoTn,BJBWdRim6SOgjoMelVSZ")
  .split(/[\s,|]+/).filter(Boolean);

if (!TOKEN || !OPP || !TO_PIPE) {
  console.error("Set GHL_PIT, OPP_ID and TO_PIPELINE_ID.");
  process.exit(1);
}
const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };
const J = { ...H, "Content-Type": "application/json" };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

const getOpp = async (id) => {
  const r = await fetch(`${BASE}/opportunities/${id}`, { headers: H });
  const b = await j(r);
  return b.opportunity ?? b;
};

// Count this contact's opportunities across the configured pipelines.
async function contactOpps(contactId) {
  const found = [];
  for (const pid of PIPELINE_IDS) {
    const p = new URLSearchParams({ location_id: LOC, pipeline_id: pid, limit: "100" });
    const r = await fetch(`${BASE}/opportunities/search?${p}`, { headers: H });
    const b = await j(r);
    for (const o of b.opportunities || [])
      if ((o.contactId || o.contact?.id) === contactId)
        found.push({ id: o.id, pipelineId: o.pipelineId, stageId: o.pipelineStageId, name: o.name });
  }
  return found;
}

async function main() {
  // 1) BEFORE
  const before = await getOpp(OPP);
  const contactId = before.contactId || before.contact?.id || "";
  console.log("=== 1. BEFORE ===");
  console.log(`  opportunity : ${OPP}  "${before.name ?? ""}"`);
  console.log(`  pipelineId  : ${before.pipelineId}`);
  console.log(`  stageId     : ${before.pipelineStageId}`);
  console.log(`  contactId   : ${contactId}`);

  const beforeList = await contactOpps(contactId);
  console.log(`  contact currently has ${beforeList.length} opportunity(ies):`);
  beforeList.forEach((o) => console.log(`    - ${o.id}  pipeline=${o.pipelineId}`));

  // Resolve TRANSFERRED IN if no stage given
  if (!TO_STAGE) {
    const pr = await fetch(`${BASE}/opportunities/pipelines?locationId=${LOC}`, { headers: H });
    const pb = await j(pr);
    const dest = (pb.pipelines || []).find((p) => p.id === TO_PIPE);
    const ti = (dest?.stages || []).find((s) => (s.name || "").trim().toUpperCase() === "TRANSFERRED IN");
    if (!ti) { console.error(`No TRANSFERRED IN stage in ${TO_PIPE}; set TO_STAGE_ID.`); process.exit(1); }
    TO_STAGE = ti.id;
    console.log(`  (resolved TRANSFERRED IN -> ${TO_STAGE})`);
  }

  // 2) THE REQUEST — this is what the dashboard's Move sends
  const body = { pipelineId: TO_PIPE, pipelineStageId: TO_STAGE };
  console.log("\n=== 2. REQUEST SENT ===");
  console.log(`  PUT ${BASE}/opportunities/${OPP}`);
  console.log(`  body: ${JSON.stringify(body)}`);
  const res = await fetch(`${BASE}/opportunities/${OPP}`, {
    method: "PUT", headers: J, body: JSON.stringify(body),
  });
  const resBody = await j(res);
  console.log(`  -> HTTP ${res.status}`);
  if (!res.ok) console.log("  body:", JSON.stringify(resBody).slice(0, 500));

  // 3) AFTER
  const after = await getOpp(OPP);
  console.log("\n=== 3. AFTER ===");
  console.log(`  pipelineId  : ${after.pipelineId}   ${after.pipelineId === TO_PIPE ? "✅ moved" : "❌ NOT moved"}`);
  console.log(`  stageId     : ${after.pipelineStageId}`);

  // 4) DUPLICATE CHECK
  const afterList = await contactOpps(contactId);
  console.log("\n=== 4. CONTACT'S OPPORTUNITIES AFTER ===");
  afterList.forEach((o) => console.log(`    - ${o.id}  pipeline=${o.pipelineId}  "${o.name}"`));
  console.log(
    afterList.length === 1
      ? `\n✅ EXACTLY ONE opportunity — the record moved, nothing was created.`
      : `\n❌ ${afterList.length} opportunities — a duplicate exists. Same id as before? ${afterList.some((o) => o.id === OPP)}`,
  );
  if (afterList.length !== beforeList.length)
    console.log(`⚠️ count changed ${beforeList.length} -> ${afterList.length}: something CREATED a record during this move.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
