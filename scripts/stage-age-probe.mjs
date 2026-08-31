// Settles ONE open question from the Master-view brief: does GoHighLevel's
// opportunity search actually return a last-stage-change timestamp, and under
// which key?
//
// WHY THIS EXISTS. The brief said days-in-stage could come from
// `lastStageChangeAt`, "already in the API response". That is true of
// GoHighLevel's response; it was NOT true of ours — nothing in the codebase
// read it and RawOpportunity did not declare it. The dashboard now reads three
// plausible spellings and renders the badge ONLY when a usable timestamp comes
// back, so an absent value shows nothing rather than a confident "0 days".
//
// This probe tells you which of those spellings (if any) this account sends, so
// the guesswork can be deleted.
//
// Run:  GHL_PIT=… GHL_LOCATION_ID=… PIPELINE_IDS=… node scripts/stage-age-probe.mjs
//
// Read-only. It sends one GET and writes nothing.

const BASE = "https://services.leadconnectorhq.com";
const PIT = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "").trim();
const PIPE = (process.env.PIPELINE_IDS || "").split(/[,|\s]+/).filter(Boolean)[0];

if (!PIT || !LOC) {
  console.error("Set GHL_PIT and GHL_LOCATION_ID.");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${PIT}`,
  Version: "2021-07-28",
  Accept: "application/json",
};

const params = new URLSearchParams({ location_id: LOC, limit: "5" });
if (PIPE) params.set("pipeline_id", PIPE);

const url = `${BASE}/opportunities/search?${params}`;
console.log("GET " + url + "\n");

const res = await fetch(url, { headers });
const text = await res.text();
if (!res.ok) {
  console.error(`✗ ${res.status}\n${text.slice(0, 800)}`);
  process.exit(1);
}

const body = JSON.parse(text);
const opps = body.opportunities || [];
if (!opps.length) {
  console.error("No opportunities came back — nothing to inspect.");
  process.exit(1);
}

// Every key on a real record, so a differently-named timestamp can't hide.
console.log("KEYS ON THE FIRST RECORD:");
console.log("  " + Object.keys(opps[0]).sort().join(", ") + "\n");

const CANDIDATES = [
  "lastStageChangeAt",
  "lastStageChangedAt",
  "lastStatusChangeAt",
  "updatedAt",
  "createdAt",
];

console.log("TIMESTAMP CANDIDATES, PER RECORD:");
for (const o of opps) {
  console.log(`\n  ${o.id} — "${o.name || "(unnamed)"}"`);
  for (const k of CANDIDATES) {
    if (!(k in o)) continue;
    const v = o[k];
    const t = Date.parse(v);
    const age = Number.isFinite(t)
      ? `${Math.floor((Date.now() - t) / 86400000)} days ago`
      : "UNPARSEABLE";
    console.log(`    ${k.padEnd(20)} ${JSON.stringify(v)}  -> ${age}`);
  }
}

const found = CANDIDATES.slice(0, 3).filter((k) => k in opps[0]);
console.log(
  "\nVERDICT: " +
    (found.length
      ? `this account DOES send ${found.join(" and ")} — the days-in-stage badge will render. Keep only that key in lib/ghl.ts and drop the other guesses.`
      : "this account sends NONE of lastStageChangeAt / lastStageChangedAt / lastStatusChangeAt. The badge will correctly render nothing. If you want days-in-stage, it has to come from somewhere else — say so and we'll wire it, but we won't compute it from updatedAt, which changes on every edit and would report the wrong number.")
);
