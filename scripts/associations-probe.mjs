#!/usr/bin/env node
/**
 * STEP 0 (Task 4) — confirm the PIT can use the Associations/Relations API and
 * find the exact list/create/delete shapes + that contact search can filter to
 * Record Type = "Caregiver". Run where the PIT works.
 *
 *   $env:GHL_PIT="pit-..."
 *   $env:PROBE_CLIENT_CONTACT_ID="<a client contact id>"     # for the list test
 *   node scripts/associations-probe.mjs
 *
 * This is READ-ONLY except the contact search. It does NOT create/delete any
 * relation — it just probes which endpoints your PIT can reach and their shapes.
 */
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "YVPhIAECw9q1M9Jw6A8L").trim();
const ASSOC = (process.env.CAREGIVER_ASSOCIATION_ID || "6a6e26c9884def7a1438b965").trim();
const CLIENT = (process.env.PROBE_CLIENT_CONTACT_ID || "").trim();
if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }

const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };

async function hit(label, url, opts = {}) {
  const res = await fetch(url, { headers: H, ...opts });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  console.log(`\n=== ${label} ===`);
  console.log("HTTP", res.status, "→", url.replace(BASE, ""));
  if (res.status === 401 || res.status === 403)
    console.log("→ AUTH FAIL: this PIT likely can't use this API (may need an OAuth token / added scope).");
  console.log(typeof j === "string" ? j.slice(0, 500) : JSON.stringify(j, null, 2).slice(0, 900));
  return { status: res.status, j };
}

async function main() {
  // 1) List relations for a client contact — two candidate shapes.
  if (CLIENT) {
    const p = new URLSearchParams({ locationId: LOC, recordId: CLIENT, associationId: ASSOC });
    await hit("LIST relations (path form)", `${BASE}/associations/relations/${CLIENT}?${p}`);
    await hit("LIST relations (query form)", `${BASE}/associations/relations?${p}`);
  } else {
    console.log("\n(Skip list test — set PROBE_CLIENT_CONTACT_ID to a real client contact id to test relation listing.)");
  }

  // 2) Association definition — confirms the id is reachable + reveals object keys.
  await hit("GET association by id", `${BASE}/associations/${ASSOC}?locationId=${LOC}`);

  // 3) Contact search with Record Type filter — confirm caregiver filtering.
  await hit(
    "SEARCH contacts (query='a')",
    `${BASE}/contacts/search`,
    { method: "POST", headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ locationId: LOC, page: 1, pageLimit: 5, query: "a" }) },
  );

  console.log("\n>> Report back:");
  console.log(">>  • Which LIST form returned 200 and the relation object's field names (id, firstRecordId/secondRecordId).");
  console.log(">>  • Whether create/delete are reachable (auth ok on the GETs implies the PIT has associations access).");
  console.log(">>  • Whether a contact object carries a 'Record Type' = Caregiver value we can filter on (and under which key).");
}
main().catch((e) => { console.error(e); process.exit(1); });
