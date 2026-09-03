// Settles ONE question behind "every write on this record 409s with the same
// pair of timestamps forever":
//
//   Does /opportunities/search and GET /opportunities/{id} report the record's
//   version under the SAME KEY, with the SAME VALUE?
//
// WHY THIS EXISTS. `version` is derived in exactly one place (lib/ghl.ts,
// normalizeOpportunity):
//
//     version: String(opp.updatedAt ?? opp.dateUpdated ?? "")
//
// Both sides run that same expression — but `??` picks whichever key the
// endpoint actually SENT. The client's expectedVersion comes from the LIST
// (/opportunities/search); the PATCH route compares against GET
// /opportunities/{id}. If search sends `updatedAt` and the GET sends only
// `dateUpdated` (or the reverse), the two sides are comparing DIFFERENT FIELDS
// and every write fails permanently — surviving reloads, because a reload just
// re-reads the same disagreeing pair.
//
// The reported evidence is consistent with that: Expected …14:38:42.025Z vs
// Actual …14:40:10.000Z — 88 seconds apart, and one with millisecond precision
// and one without. This probe prints the raw keys so it is a fact, not a guess.
//
// It also distinguishes the OTHER candidate: a search index that is simply
// stale. Run it twice a minute apart — if the search value MOVES, it is lag;
// if it is frozen while the GET value differs, it is the key mismatch.
//
// Run:  GHL_PIT=… GHL_LOCATION_ID=… OPP_ID=7KDpWgHLS0EfNPEBbJMa \
//         PIPELINE_IDS=… node scripts/version-key-probe.mjs
//
// Read-only. Two GETs, writes nothing.

const BASE = "https://services.leadconnectorhq.com";
const PIT = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "").trim();
const OPP = (process.env.OPP_ID || "").trim();
const PIPE = (process.env.PIPELINE_IDS || "").split(/[,|\s]+/).filter(Boolean)[0];

if (!PIT || !LOC || !OPP) {
  console.error("Set GHL_PIT, GHL_LOCATION_ID and OPP_ID.");
  process.exit(1);
}
const H = { Authorization: `Bearer ${PIT}`, Version: "2021-07-28", Accept: "application/json" };
const TS = ["updatedAt", "dateUpdated", "dateAdded", "lastStatusChangeAt", "lastStageChangeAt"];

const show = (label, o) => {
  if (!o) return console.log(`  ${label}: (record not found)`);
  console.log(`  ${label}:`);
  for (const k of TS) console.log(`      ${k.padEnd(20)} ${k in o ? JSON.stringify(o[k]) : "— absent —"}`);
  // what normalizeOpportunity would compute
  const v = String(o.updatedAt ?? o.dateUpdated ?? "");
  console.log(`      => version resolves to  ${JSON.stringify(v)}  (via ${"updatedAt" in o && o.updatedAt != null ? "updatedAt" : ("dateUpdated" in o && o.dateUpdated != null ? "dateUpdated" : "NOTHING")})`);
};

// 1. the single-record GET — what the PATCH route compares against
const g = await fetch(`${BASE}/opportunities/${encodeURIComponent(OPP)}`, { headers: H });
if (!g.ok) { console.error(`GET /opportunities/${OPP} -> HTTP ${g.status}`, (await g.text()).slice(0, 300)); process.exit(1); }
const single = (await g.json()).opportunity;

// 2. the SEARCH listing — what the client's expectedVersion comes from
const params = new URLSearchParams({ location_id: LOC, limit: "100" });
if (PIPE) params.set("pipeline_id", PIPE);
const s = await fetch(`${BASE}/opportunities/search?${params}`, { headers: H });
if (!s.ok) { console.error(`search -> HTTP ${s.status}`, (await s.text()).slice(0, 300)); process.exit(1); }
const fromSearch = ((await s.json()).opportunities || []).find((o) => o.id === OPP);

console.log(`\nrecord ${OPP}\n`);
console.log("SEARCH  (/opportunities/search)  <- the client's expectedVersion");
show("keys", fromSearch);
console.log("\nGET     (/opportunities/{id})    <- what versionGuard compares to");
show("keys", single);

const a = fromSearch ? String(fromSearch.updatedAt ?? fromSearch.dateUpdated ?? "") : "";
const b = single ? String(single.updatedAt ?? single.dateUpdated ?? "") : "";
console.log("\n──────── VERDICT ────────");
if (!fromSearch) console.log("Record is NOT in the search listing at all — the client can never hold a correct version for it.");
else if (a === b) console.log(`MATCH (${a}) — the two sides agree, so the 409 is NOT a key mismatch. Look at timing/caching instead.`);
else {
  const keyA = fromSearch.updatedAt != null ? "updatedAt" : "dateUpdated";
  const keyB = single.updatedAt != null ? "updatedAt" : "dateUpdated";
  console.log(`MISMATCH:\n  search resolves via ${keyA} = ${a}\n  GET    resolves via ${keyB} = ${b}`);
  console.log(keyA !== keyB
    ? "  -> DIFFERENT KEYS. This is the bug: the two sides compare different fields, permanently."
    : "  -> SAME KEY, different values. The search index is stale; re-run in a minute and see whether it moves.");
}
