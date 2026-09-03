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
//         node scripts/version-key-probe.mjs
//
// (No PIPELINE_IDS needed — the pipeline is taken from the record itself.)
//
// Read-only. Two GETs, writes nothing.

const BASE = "https://services.leadconnectorhq.com";
const PIT = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "").trim();
const OPP = (process.env.OPP_ID || "").trim();

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

// 2. the SEARCH listing — what the client's expectedVersion comes from.
//
// 🔴 FIXED FALSE NEGATIVE. This used to search only PIPELINE_IDS[0] — the FIRST
// configured pipeline — and read a single 100-row page. A record in any OTHER
// pipeline (Private Pay Clients is the fifth) was reported as "NOT in the search
// listing at all", which is a far more alarming verdict than the truth and sent
// the diagnosis somewhere it did not belong.
//
// Two corrections: take the pipeline FROM THE RECORD (we already fetched it, so
// there is nothing to guess or configure), and PAGE the way lib/ghl.ts's
// searchAll does instead of stopping at row 100.
const pipelineId = single?.pipelineId || "";
let fromSearch = null;
let scanned = 0, pages = 0;
{
  let startAfter, startAfterId;
  for (let page = 0; page < 50 && !fromSearch; page++) {
    const params = new URLSearchParams({ location_id: LOC, limit: "100" });
    if (pipelineId) params.set("pipeline_id", pipelineId);
    if (startAfter != null) params.set("startAfter", String(startAfter));
    if (startAfterId != null) params.set("startAfterId", String(startAfterId));
    const s = await fetch(`${BASE}/opportunities/search?${params}`, { headers: H });
    if (!s.ok) { console.error(`search -> HTTP ${s.status}`, (await s.text()).slice(0, 300)); process.exit(1); }
    const j = await s.json();
    const rows = j.opportunities || [];
    pages++; scanned += rows.length;
    fromSearch = rows.find((o) => o.id === OPP) || null;
    const meta = j.meta || {};
    if (fromSearch || !rows.length) break;
    if (meta.startAfterId == null && meta.startAfter == null) break;
    if (meta.startAfterId === startAfterId && meta.startAfter === startAfter) break; // no progress
    startAfter = meta.startAfter; startAfterId = meta.startAfterId;
  }
}
console.log(`(searched pipeline ${pipelineId || "(unknown)"} — ${scanned} row(s) over ${pages} page(s))`);

console.log(`\nrecord ${OPP}\n`);
console.log("SEARCH  (/opportunities/search)  <- the client's expectedVersion");
show("keys", fromSearch);
console.log("\nGET     (/opportunities/{id})    <- what versionGuard compares to");
show("keys", single);

const a = fromSearch ? String(fromSearch.updatedAt ?? fromSearch.dateUpdated ?? "") : "";
const b = single ? String(single.updatedAt ?? single.dateUpdated ?? "") : "";
console.log("\n──────── VERDICT ────────");
if (!fromSearch)
  console.log(
    `Record was not found in ${scanned} row(s) of pipeline ${pipelineId || "(unknown)"}.\n` +
    "  Before trusting that: confirm the pipeline id above is the record's own, and that the\n" +
    "  search endpoint is returning rows at all. A genuine absence means the client can never\n" +
    "  hold a correct version for this record.",
  );
else if (a === b) console.log(`MATCH (${a}) — the two sides agree, so the 409 is NOT a key mismatch. Look at timing/caching instead.`);
else {
  const keyA = fromSearch.updatedAt != null ? "updatedAt" : "dateUpdated";
  const keyB = single.updatedAt != null ? "updatedAt" : "dateUpdated";
  console.log(`MISMATCH:\n  search resolves via ${keyA} = ${a}\n  GET    resolves via ${keyB} = ${b}`);
  console.log(keyA !== keyB
    ? "  -> DIFFERENT KEYS. This is the bug: the two sides compare different fields, permanently."
    : "  -> SAME KEY, different values. The search index is stale; re-run in a minute and see whether it moves.");
}
