#!/usr/bin/env node
/**
 * PHASE 2 · STEP 0 — prove writes against live GoHighLevel.
 *
 * This sandbox can't reach GHL, so run this on your machine (or anywhere the
 * PIT works). It:
 *   1. reads the opportunity custom-field DEFINITIONS (id, name, dataType, options),
 *   2. reads ONE opportunity (current values),
 *   3. does a PUT updating the Stage (native pipelineStageId) AND the
 *      "Road Blocker" custom field,
 *   4. AUTO-DISCOVERS the working customFields body shape by trying each
 *      variant and reading the record back to see which one actually persisted,
 *   5. prints the exact working request body to paste back.
 *
 * Nothing is destructive beyond changing those two fields on the ONE test
 * opportunity you name — use a throwaway/test record.
 *
 * Usage (PowerShell):
 *   $env:GHL_PIT="pit-...";  $env:OPP_ID="<opportunityId>"
 *   $env:STAGE_NAME="CAO";   $env:ROADBLOCKER_VALUE="Awaiting docs"
 *   node scripts/step0-write-test.mjs
 *
 * Optional: $env:GHL_LOCATION_ID (defaults to the Miracle Makers location).
 * Optional: $env:FIELDS_JSON='[{"name":"Some Text Field","value":"hello"}]'
 *           to also probe other field TYPES (text/date/number/dropdown).
 */

const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "YVPhIAECw9q1M9Jw6A8L").trim();
const OPP_ID = (process.env.OPP_ID || "").trim();
const STAGE_NAME = (process.env.STAGE_NAME || "").trim();
const ROADBLOCKER_VALUE = (process.env.ROADBLOCKER_VALUE || "Awaiting docs").trim();
const EXTRA_FIELDS = process.env.FIELDS_JSON ? JSON.parse(process.env.FIELDS_JSON) : [];

const H = {
  Authorization: `Bearer ${TOKEN}`,
  Version: "2021-07-28",
  "Content-Type": "application/json",
  Accept: "application/json",
};

function die(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}
if (!TOKEN) die("Set GHL_PIT.");
if (!OPP_ID) die("Set OPP_ID to a test opportunity id.");

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, ok: res.ok, json };
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Read the custom-field value off an opportunity, tolerating shape differences.
function readCfValue(opp, fieldId) {
  const arr = opp?.customFields || opp?.customField || [];
  const hit = arr.find((c) => c.id === fieldId || c.customFieldId === fieldId);
  if (!hit) return undefined;
  return hit.fieldValueString ?? hit.fieldValue ?? hit.value ?? hit.field_value ?? undefined;
}

async function main() {
  console.log("=== STEP 0 · GHL write probe ===\n");

  // 1) definitions
  const defsRes = await api("GET", `/locations/${LOC}/customFields?model=opportunity`);
  if (!defsRes.ok) die(`custom-field definitions failed: ${defsRes.status} ${JSON.stringify(defsRes.json).slice(0,300)}`);
  const defs = defsRes.json.customFields || [];
  console.log(`custom-field definitions: ${defs.length} fields`);
  const byName = new Map(defs.map((d) => [norm(d.name), d]));
  const rb = byName.get(norm("Road Blocker")) || byName.get(norm("Roadblocker"));
  if (!rb) {
    console.log("  fields:", defs.map((d) => `${d.name} [${d.dataType}]`).join(", "));
    die('No "Road Blocker" field found — check the exact name above.');
  }
  console.log(`  Road Blocker → id=${rb.id} dataType=${rb.dataType}`);
  if (rb.options) console.log(`  options: ${JSON.stringify(rb.options)}`);

  // 2) read the opportunity
  const oppRes = await api("GET", `/opportunities/${OPP_ID}`);
  if (!oppRes.ok) die(`GET opportunity failed: ${oppRes.status} ${JSON.stringify(oppRes.json).slice(0,300)}`);
  const opp = oppRes.json.opportunity || oppRes.json;
  console.log(`\nopportunity ${OPP_ID}:`);
  console.log(`  pipelineId=${opp.pipelineId} stageId=${opp.pipelineStageId} assignedTo=${opp.assignedTo ?? null}`);
  console.log(`  current Road Blocker = ${JSON.stringify(readCfValue(opp, rb.id))}`);

  // resolve target stage id
  let targetStageId = opp.pipelineStageId;
  if (STAGE_NAME) {
    const pl = await api("GET", `/opportunities/pipelines?locationId=${LOC}`);
    const pipe = (pl.json.pipelines || []).find((p) => p.id === opp.pipelineId);
    if (!pipe) die(`Opportunity's pipeline ${opp.pipelineId} not found.`);
    const key = norm(STAGE_NAME);
    // Forgiving match: exact-normalized, or the stage name contains your text
    // (so "CAO" matches "4  CAO", ignoring the leading number/spaces).
    const st =
      pipe.stages?.find((s) => norm(s.name) === key) ||
      pipe.stages?.find((s) => norm(s.name).includes(key));
    if (!st)
      die(
        `Stage "${STAGE_NAME}" not found in pipeline "${pipe.name}" (${opp.pipelineId}).\n` +
          `  This opp is in "${pipe.name}". For an OLTL test use a record in the OLTL Enrollments pipeline (rZbPGiWTSsZ3gaVLZOJl).\n` +
          `  Stages here: ${pipe.stages?.map((s) => s.name).join(" | ")}`,
      );
    targetStageId = st.id;
    console.log(`  target stage "${st.name}" → ${targetStageId}`);
  }

  // 3+4) try each customFields body variant and read back to see what persists
  const variants = [
    { label: "customFields:[{id,value}]",       cf: [{ id: rb.id, value: ROADBLOCKER_VALUE }] },
    { label: "customFields:[{id,field_value}]", cf: [{ id: rb.id, field_value: ROADBLOCKER_VALUE }] },
    { label: "customFields:[{id,fieldValue}]",  cf: [{ id: rb.id, fieldValue: ROADBLOCKER_VALUE }] },
    { label: "customFields:[{key,field_value}]",cf: [{ key: rb.fieldKey || rb.key, field_value: ROADBLOCKER_VALUE }] },
  ];

  let working = null;
  for (const v of variants) {
    const body = {
      pipelineId: opp.pipelineId,
      pipelineStageId: targetStageId,
      customFields: v.cf,
    };
    process.stdout.write(`\nPUT try → ${v.label} ... `);
    const put = await api("PUT", `/opportunities/${OPP_ID}`, body);
    if (!put.ok) { console.log(`HTTP ${put.status} ${JSON.stringify(put.json).slice(0,200)}`); continue; }
    // read back
    const check = await api("GET", `/opportunities/${OPP_ID}`);
    const back = check.json.opportunity || check.json;
    const got = readCfValue(back, rb.id);
    const stageOk = back.pipelineStageId === targetStageId;
    const cfOk = String(got) === String(ROADBLOCKER_VALUE);
    console.log(`HTTP ${put.status} | stage ${stageOk ? "OK" : "NO"} | roadblocker read-back=${JSON.stringify(got)} ${cfOk ? "✓ PERSISTED" : "✗"}`);
    if (cfOk && !working) { working = { ...v, body }; }
    if (cfOk) break;
  }

  // 5) probe extra field types if provided
  for (const f of EXTRA_FIELDS) {
    const def = byName.get(norm(f.name));
    if (!def) { console.log(`\n(extra) "${f.name}" not found — skipped`); continue; }
    const body = { customFields: [{ id: def.id, value: f.value }] };
    const put = await api("PUT", `/opportunities/${OPP_ID}`, body);
    const check = await api("GET", `/opportunities/${OPP_ID}`);
    const back = check.json.opportunity || check.json;
    const got = readCfValue(back, def.id);
    console.log(`\n(extra) ${f.name} [${def.dataType}] set=${JSON.stringify(f.value)} → read-back=${JSON.stringify(got)} ${String(got)===String(f.value)?"✓":"✗"} (HTTP ${put.status})`);
  }

  console.log("\n=== RESULT ===");
  if (working) {
    console.log("✓ Working custom-field body shape:", working.label);
    console.log("Exact PUT body that persisted:");
    console.log(JSON.stringify(working.body, null, 2));
  } else {
    console.log("✗ No custom-field variant persisted the Road Blocker value.");
    console.log("  Stage may still have updated — check the read-backs above.");
    console.log("  Paste the output here and we'll adjust.");
  }
}

main().catch((e) => die(e.stack || String(e)));
