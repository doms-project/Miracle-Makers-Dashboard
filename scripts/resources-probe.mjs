#!/usr/bin/env node
/**
 * STEP 0 — confirm the GHL media list shape + folder scoping.
 * Run where the PIT works (this sandbox can't reach GHL).
 *
 *   $env:GHL_PIT="pit-..."
 *   node scripts/resources-probe.mjs
 *
 * Optional: $env:RESOURCES_FOLDER_ID (defaults to the OLTL Resources folder).
 */
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "YVPhIAECw9q1M9Jw6A8L").trim();
const FOLDER = (process.env.RESOURCES_FOLDER_ID || "6a75ea609994d35aa0c66e9a").trim();
if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }

const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };

async function main() {
  const p = new URLSearchParams({
    altType: "location", altId: LOC, type: "file",
    sortBy: "createdAt", sortOrder: "desc", limit: "100", offset: "0",
  });
  const res = await fetch(`${BASE}/medias/files?${p}`, { headers: H });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  console.log("HTTP", res.status);
  if (!res.ok) { console.log("Body:", String(text).slice(0, 500));
    if (res.status === 401) console.log("→ 401: PIT likely missing the medias/media scope. Add it to the Private Integration.");
    return; }
  const files = j.files || j.medias || [];
  console.log(`Top-level keys: ${Object.keys(j).join(", ")}`);
  console.log(`Total files returned: ${files.length}`);
  if (files[0]) {
    console.log("First file keys:", Object.keys(files[0]).join(", "));
    console.log("First file (trimmed):", JSON.stringify(files[0], null, 2).slice(0, 800));
  }
  const inFolder = files.filter((f) => String(f.parentId ?? f.folderId ?? "") === FOLDER);
  console.log(`\nFiles in OLTL Resources folder (${FOLDER}): ${inFolder.length}`);
  for (const f of inFolder) console.log(`  • ${f.name ?? f.fileName} — url? ${!!(f.url ?? f.fileUrl)}`);
  console.log("\nConfirm: field names for name / url / parentId match what /api/resources reads.");
}
main().catch((e) => { console.error(e); process.exit(1); });
