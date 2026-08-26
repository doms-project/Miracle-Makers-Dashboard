#!/usr/bin/env node
/**
 * v2 STEP 0 — re-derive the two account-specific IDs for the NEW account
 * (anzcWt3S0tzpu2fEaS8X): RESOURCES_FOLDER_ID (media folder) and
 * CAREGIVER_ASSOCIATION_ID (caregiver_client association). The old account's
 * IDs do not exist here, so the Resources tab and Caregivers panel need these.
 *
 *   $env:GHL_PIT="pit-..."
 *   node scripts/rederive-ids-probe.mjs
 */
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }

const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

async function main() {
  // 1) Media FOLDERS — find the "OLTL Resources" (or equivalent) folder id.
  console.log("=== MEDIA FOLDERS (pick the resources folder id) ===");
  const fp = new URLSearchParams({ altType: "location", altId: LOC, type: "folder", limit: "100", offset: "0" });
  const fr = await fetch(`${BASE}/medias/files?${fp}`, { headers: H });
  const fj = await j(fr);
  console.log("HTTP", fr.status);
  const folders = (fj.files || fj.medias || []);
  for (const f of folders) console.log(`  ${f.id ?? f._id}  "${f.name ?? f.fileName}"`);
  if (!folders.length) console.log("  (no folders returned — check the type=folder param / scope)");

  // 2) ASSOCIATIONS — find the caregiver_client association id.
  console.log("\n=== ASSOCIATIONS (pick the caregiver_client id) ===");
  const ar = await fetch(`${BASE}/associations/?locationId=${LOC}&limit=100&skip=0`, { headers: H });
  const aj = await j(ar);
  console.log("HTTP", ar.status);
  const assocs = (aj.associations || aj.data || []);
  for (const a of assocs)
    console.log(`  ${a.id ?? a._id}  key="${a.key ?? a.associationKey ?? ""}"  "${a.firstObjectLabel ?? ""} <-> ${a.secondObjectLabel ?? ""}"`);

  const hasCaregiver = assocs.some((a) =>
    String(a.key ?? a.associationKey ?? "").toLowerCase().includes("caregiver"),
  );
  if (!assocs.length || !hasCaregiver) {
    console.log("\n  ⚠️ No caregiver_client association found. On the OLD account it was");
    console.log("     user-defined (6a6e26c9884def7a1438b965) — it likely needs CREATING here:");
    console.log("     POST /associations");
    console.log("     { locationId, key: \"caregiver_client\",");
    console.log("       firstObjectLabel: \"Caregiver\", firstObjectKey: \"contact\",");
    console.log("       secondObjectLabel: \"Client\",  secondObjectKey: \"contact\" }");
    console.log("     Then use the returned association id as CAREGIVER_ASSOCIATION_ID.");
  }
  if (typeof aj !== "object") console.log("raw:", String(aj).slice(0, 500));

  if (!folders.length) {
    console.log("\n  ⚠️ No media folders returned. RESOURCES_FOLDER_ID is a folder someone");
    console.log("     creates in the GHL Media Library — make it, then read its id back here.");
  }

  // 3) USERS — so PIPELINE_ACCESS_MAP can be rebuilt with THIS account's ids.
  console.log("\n=== USERS (rebuild PIPELINE_ACCESS_MAP from these ids) ===");
  const ur = await fetch(`${BASE}/users/?locationId=${LOC}`, { headers: H });
  const uj = await j(ur);
  console.log("HTTP", ur.status);
  const users = (uj.users || uj.data || []);
  const userIds = new Set();
  for (const u of users) {
    const id = u.id ?? u._id ?? "";
    userIds.add(String(id));
    const name = u.name || [u.firstName, u.lastName].filter(Boolean).join(" ");
    const role = u.roles?.role ?? u.role ?? "";
    console.log(`  ${id}  ${name}  <${u.email ?? ""}>  ${role}`);
  }
  if (!users.length) console.log("  (none returned — check the users.readonly scope)");

  // Cross-check the configured PIPELINE_ACCESS_MAP ids against real users.
  const mapRaw = (process.env.PIPELINE_ACCESS_MAP || "").trim();
  if (mapRaw) {
    console.log("\n=== PIPELINE_ACCESS_MAP id check ===");
    const mapIds = mapRaw
      .split(/[,;\n]+/)
      .map((e) => e.split(":")[0]?.trim())
      .filter(Boolean);
    let anyMissing = false;
    for (const id of mapIds) {
      const ok = userIds.has(id);
      if (!ok) anyMissing = true;
      console.log(`  ${ok ? "✅" : "❌ NOT IN THIS ACCOUNT"}  ${id}`);
    }
    if (anyMissing)
      console.log("  ⚠️ Unmatched ids mean those users see nothing but owned/followed. Rebuild the map from the USERS list above.");
  } else {
    console.log("\n(PIPELINE_ACCESS_MAP not set in this shell — set it to cross-check ids.)");
  }

  console.log("\n>> Set in the new account's env:");
  console.log(">>   GHL_LOCATION_ID          = anzcWt3S0tzpu2fEaS8X");
  console.log(">>   RESOURCES_FOLDER_ID      = the resources folder id above (create the folder if none)");
  console.log(">>   CAREGIVER_ASSOCIATION_ID = the caregiver_client association id above (create it if none)");
  console.log(">>   PIPELINE_ACCESS_MAP      = rebuilt from the USERS list above");
}
main().catch((e) => { console.error(e); process.exit(1); });
