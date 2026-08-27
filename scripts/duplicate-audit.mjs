#!/usr/bin/env node
/**
 * Find contacts that have MORE THAN ONE opportunity across the configured
 * pipelines — i.e. duplicates left behind by any earlier Move run.
 *
 *   $env:GHL_PIT="pit-..."
 *   node scripts/duplicate-audit.mjs
 *
 * Read-only by default. To delete a specific orphan once you've decided which
 * one to keep:
 *   $env:DELETE_OPP_ID="<opportunity id>"
 *   node scripts/duplicate-audit.mjs
 * It refuses to delete unless the id is one it actually found as a duplicate.
 */
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
const DELETE_ID = (process.env.DELETE_OPP_ID || "").trim();
const PIPELINE_IDS = (process.env.PIPELINE_IDS ||
  "KGjdCMG4F8xILk0ineB9,74Pt3XX4hgBIqD10mW4G,a14NtTi18ACxs99bHPmL,PIs1iWVk0HqHZFNtmoTn,BJBWdRim6SOgjoMelVSZ")
  .split(/[\s,|]+/).filter(Boolean);
if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }

const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

async function allOpps(pipelineId) {
  const out = [];
  let startAfter, startAfterId;
  for (let page = 0; page < 50; page++) {
    const p = new URLSearchParams({ location_id: LOC, pipeline_id: pipelineId, limit: "100" });
    if (startAfter != null) p.set("startAfter", String(startAfter));
    if (startAfterId != null) p.set("startAfterId", startAfterId);
    const r = await fetch(`${BASE}/opportunities/search?${p}`, { headers: H });
    const b = await j(r);
    const batch = b.opportunities || [];
    out.push(...batch);
    const meta = b.meta;
    if (!meta || batch.length < 100) break;
    if (meta.startAfterId === startAfterId && meta.startAfter === startAfter) break;
    startAfter = meta.startAfter; startAfterId = meta.startAfterId;
  }
  return out;
}

async function main() {
  const pr = await fetch(`${BASE}/opportunities/pipelines?locationId=${LOC}`, { headers: H });
  const pipelines = ((await j(pr)).pipelines || []);
  const pname = (id) => pipelines.find((p) => p.id === id)?.name || id;
  const sname = (pid, sid) =>
    (pipelines.find((p) => p.id === pid)?.stages || []).find((s) => s.id === sid)?.name || sid;

  const byContact = new Map();
  let total = 0;
  for (const pid of PIPELINE_IDS) {
    const opps = await allOpps(pid);
    total += opps.length;
    console.log(`  scanned ${String(opps.length).padStart(4)}  ${pname(pid)}`);
    for (const o of opps) {
      const cid = o.contactId || o.contact?.id || "";
      if (!cid) continue;
      const arr = byContact.get(cid) || [];
      arr.push({
        id: o.id, name: o.name, contactName: o.contact?.name,
        pipelineId: o.pipelineId, stageId: o.pipelineStageId,
        assignedTo: o.assignedTo, updatedAt: o.updatedAt || o.dateUpdated,
      });
      byContact.set(cid, arr);
    }
  }

  const dupes = [...byContact.entries()].filter(([, v]) => v.length > 1);
  console.log(`\n=== ${total} opportunities scanned · ${byContact.size} contacts · ${dupes.length} with MORE THAN ONE ===\n`);
  if (!dupes.length) console.log("✅ No contact has more than one opportunity across these pipelines.");

  const dupIds = new Set();
  for (const [cid, list] of dupes) {
    console.log(`contact ${cid}  "${list[0].contactName || list[0].name || ""}"  — ${list.length} opportunities:`);
    for (const o of list) {
      dupIds.add(o.id);
      console.log(`   ${o.id}  ${pname(o.pipelineId)} / ${sname(o.pipelineId, o.stageId)}  owner=${o.assignedTo || "-"}  updated=${o.updatedAt || "-"}`);
    }
    console.log("");
  }

  if (DELETE_ID) {
    if (!dupIds.has(DELETE_ID)) {
      console.error(`REFUSING to delete ${DELETE_ID}: it is not one of the duplicates found above.`);
      process.exit(1);
    }
    const r = await fetch(`${BASE}/opportunities/${DELETE_ID}`, { method: "DELETE", headers: H });
    console.log(`DELETE /opportunities/${DELETE_ID} -> HTTP ${r.status}`);
    if (!r.ok) console.log(JSON.stringify(await j(r)).slice(0, 400));
    else console.log("✅ deleted. Re-run without DELETE_OPP_ID to confirm.");
  } else if (dupes.length) {
    console.log("To remove one:  $env:DELETE_OPP_ID=\"<id>\"; node scripts/duplicate-audit.mjs");
    console.log("Keep the one in the DESTINATION pipeline with the newer updated timestamp.");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
