// probe.mjs — GHL opportunity write-back probe (standalone)
// Run:  node probe.mjs
// Needs env vars set first (PowerShell examples below the script).

const PIT = process.env.GHL_PIT;
const LOC = process.env.GHL_LOCATION_ID || "YVPhIAECw9q1M9Jw6A8L";
const OPP_ID = process.env.OPP_ID;
const STAGE_ID = process.env.STAGE_ID || null;        // optional: set stage by ID
const FIELDS_JSON = process.env.FIELDS_JSON || "[]";  // [{name,value}, ...] to test
const BASE = "https://services.leadconnectorhq.com";
const H = { Authorization: `Bearer ${PIT}`, Version: "2021-07-28", "Content-Type": "application/json" };

if (!PIT || !OPP_ID) {
  console.error("Set GHL_PIT and OPP_ID env vars first."); process.exit(1);
}

const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

// 1) field definitions (opportunity)
const defsRes = await fetch(`${BASE}/locations/${LOC}/customFields?model=opportunity`, { headers: H });
const defsBody = await j(defsRes);
const defs = defsBody.customFields || defsBody.customField || [];
console.log(`=== field definitions: ${defs.length} ===`);
const byName = {};
for (const d of defs) byName[(d.name || "").trim()] = d;

// 2) read current opportunity
const oppRes = await fetch(`${BASE}/opportunities/${OPP_ID}`, { headers: H });
const opp = (await j(oppRes)).opportunity || (await j(oppRes));
console.log(`opportunity ${OPP_ID}: pipeline=${opp.pipelineId} stage=${opp.pipelineStageId} assignedTo=${opp.assignedTo}`);

// 3) build the test write body
const fieldsToTest = JSON.parse(FIELDS_JSON);
const customFields = [];
for (const f of fieldsToTest) {
  const def = byName[f.name.trim()];
  if (!def) { console.log(`  ✗ field "${f.name}" not found in definitions`); continue; }
  console.log(`  testing "${f.name}" (${def.dataType}) id=${def.id} value=${JSON.stringify(f.value)}`);
  customFields.push({ id: def.id, value: f.value });
}

const body = {};
if (STAGE_ID) body.pipelineStageId = STAGE_ID;
if (customFields.length) body.customFields = customFields;

if (!Object.keys(body).length) { console.log("Nothing to write. Set STAGE_ID or FIELDS_JSON."); process.exit(0); }

console.log("\nPUT body:\n", JSON.stringify(body, null, 2));

// 4) write
const putRes = await fetch(`${BASE}/opportunities/${OPP_ID}`, { method: "PUT", headers: H, body: JSON.stringify(body) });
console.log(`\nPUT status: ${putRes.status}`);
console.log("PUT response:", JSON.stringify(await j(putRes)).slice(0, 400));

// 5) read back and confirm each field persisted
await new Promise(r => setTimeout(r, 1500));
const backRes = await fetch(`${BASE}/opportunities/${OPP_ID}`, { headers: H });
const back = (await j(backRes)).opportunity || (await j(backRes));
const backCF = {};
for (const c of (back.customFields || [])) backCF[c.id] = c.fieldValue ?? c.value ?? c.fieldValueString ?? c.fieldValueArray;

console.log("\n=== READ-BACK ===");
if (STAGE_ID) console.log(`  stage → ${back.pipelineStageId === STAGE_ID ? "✓ PERSISTED" : "✗ did not persist ("+back.pipelineStageId+")"}`);
for (const f of fieldsToTest) {
  const def = byName[f.name.trim()]; if (!def) continue;
  const got = backCF[def.id];
  const ok = JSON.stringify(got) === JSON.stringify(f.value) || String(got) === String(f.value);
  console.log(`  ${f.name} (${def.dataType}) → ${ok ? "✓ PERSISTED" : "✗ MISMATCH"}  got=${JSON.stringify(got)}`);
}
console.log("\nIf a type shows ✗ MISMATCH, its value format differs — note what 'got' shows and we adjust.");
