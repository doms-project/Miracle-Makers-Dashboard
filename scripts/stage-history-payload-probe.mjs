// ---------------------------------------------------------------------------
// ROUND 171 · ITEM 6 — DOES THE BOARD'S SEARCH CARRY THE WHOLE STAGE HISTORY?
//
// ✅ ANSWERED — 5 OCTOBER 2026, RUN TWICE ON THE LIVE ACCOUNT. The board's
// search payload and the single-record GET returned BYTE-IDENTICAL Stage
// History, three rows each, both times. The Moves screen is reading the whole
// log; no truncation, no reformatting, and none of the three mitigations below
// is needed.
//
// ⚠️ THE SCRIPT STAYS, AND NOT OUT OF SENTIMENT. "Search carries it" is true
// of a three-row log and says nothing about a thirty-row one — the cut-off, if
// there is one, is a length and these logs are young. Re-run it when a case
// has many more rows; that is the question this file still answers.
//
// 🔴 READ-ONLY. GETs and nothing else. There is no write path in this file.
//
// ⚠️ WHY IT CANNOT BE ANSWERED FROM A FAKE. The Moves screen reads the log out
// of `cf` on the board payload, which comes from `/opportunities/search`. If
// that endpoint truncates a long LARGE_TEXT value, or reformats its line
// breaks, every number on that screen is quietly computed from a shortened
// log — and a fake answers whatever it was written to answer, so only the live
// account can say. This is the one question in round 171 that a proof cannot
// settle.
//
// 🔴 AND A SILENT TRUNCATION IS THE DANGEROUS SHAPE, not an error. A log cut
// mid-row makes `parseStageHistory` skip that row, which the screen already
// counts as `skipped` — but a log cut cleanly at a row boundary loses moves
// with nothing anywhere to show it. So this compares BYTES, not just counts.
//
// It finds a case with 2+ rows by itself, then for each one:
//
//   search   POST-free GET /opportunities/search?pipeline_id=…   -> cf value
//   single   GET /opportunities/{id}                             -> cf value
//
// and reports identical / shorter / reformatted, with the first difference.
//
// Run: GHL_PIT=… GHL_LOCATION_ID=… [STAGE_HISTORY_FIELD_ID=…] \
//      npx tsx scripts/stage-history-payload-probe.mjs
// ---------------------------------------------------------------------------
const BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const PIT = process.env.GHL_PIT || "";
const LOC = process.env.GHL_LOCATION_ID || "";
const FIELD = process.env.STAGE_HISTORY_FIELD_ID || "";

if (!PIT || !LOC) {
  console.error(
    "Set GHL_PIT and GHL_LOCATION_ID.\n" +
      "This script only READS — it never writes anything.",
  );
  process.exit(2);
}

const H = {
  Authorization: `Bearer ${PIT}`,
  Version: "2021-07-28",
  Accept: "application/json",
};

// ⚠️ PACED. 100 requests per 10 seconds, and round 152 produced 13,851
// timeouts by ignoring it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
async function get(path) {
  if (++calls % 20 === 0) await sleep(2500);
  const res = await fetch(`${BASE}${path}`, { headers: H });
  if (!res.ok) throw new Error(`${res.status} ${path} — ${await res.text()}`);
  return res.json();
}

// ── find the Stage History field, unless we were told ─────────────────────
let fieldId = FIELD;
if (!fieldId) {
  const defs = await get(`/locations/${LOC}/customFields?model=opportunity`);
  const hit = (defs.customFields || []).find((d) =>
    /stage\s*history/i.test(String(d.name || "")),
  );
  if (!hit) {
    console.error(
      'No opportunity custom field whose name matches /stage history/i.\n' +
        "Pass STAGE_HISTORY_FIELD_ID explicitly.",
    );
    process.exit(2);
  }
  fieldId = hit.id;
  console.log(`field  "${hit.name}"  ${hit.id}  (${hit.dataType})\n`);
}

const valueOf = (o) => {
  for (const f of o?.customFields || []) {
    const id = String(f.id ?? f.customFieldId ?? "");
    if (id !== fieldId) continue;
    const v = f.fieldValueString ?? f.value ?? f.fieldValue ?? "";
    return Array.isArray(v) ? v.join("\n") : String(v ?? "");
  }
  return "";
};
const rowsIn = (s) => s.split(/\r?\n/).filter((l) => l.trim()).length;

// ── the pipelines, then every case with 2+ rows in the search payload ─────
const pipes = (await get(`/opportunities/pipelines?locationId=${LOC}`)).pipelines || [];
console.log(`pipelines ${pipes.length}\n`);

const candidates = [];
for (const p of pipes) {
  const params = new URLSearchParams({
    location_id: LOC,
    pipeline_id: p.id,
    limit: "100",
  });
  let data;
  try {
    data = await get(`/opportunities/search?${params}`);
  } catch (e) {
    console.log(`  ⚠️  ${p.name}: ${String(e).slice(0, 120)}`);
    continue;
  }
  for (const o of data.opportunities || []) {
    const v = valueOf(o);
    if (rowsIn(v) >= 2) candidates.push({ id: o.id, name: o.name, fromSearch: v });
  }
}

console.log(`cases with 2+ rows in the SEARCH payload: ${candidates.length}`);
if (!candidates.length) {
  console.log(
    "\n⚠️  NOTHING TO COMPARE, AND THAT IS ITSELF A FINDING. Either no case has\n" +
      "   two rows yet, or the search is not carrying this field at all. Check a\n" +
      "   case you know has moved twice; if its log is empty here and full in\n" +
      "   GoHighLevel, the search is dropping the field and the Moves screen is\n" +
      "   reading nothing.",
  );
  process.exit(0);
}

// ── compare each against the single-record GET ────────────────────────────
let same = 0;
let shorter = 0;
let reformatted = 0;
const worst = [];
for (const c of candidates.slice(0, 25)) {
  const one = await get(`/opportunities/${encodeURIComponent(c.id)}`);
  const full = valueOf(one.opportunity ?? one);
  if (full === c.fromSearch) {
    same += 1;
    continue;
  }
  const rs = rowsIn(c.fromSearch);
  const rf = rowsIn(full);
  if (rs < rf || c.fromSearch.length < full.length) shorter += 1;
  else reformatted += 1;
  if (worst.length < 3)
    worst.push({
      id: c.id,
      name: c.name,
      searchRows: rs,
      singleRows: rf,
      searchBytes: c.fromSearch.length,
      singleBytes: full.length,
      // ⚠️ THE FIRST DIFFERING CHARACTER, because "they differ" does not say
      // whether a line break became a space or the tail was cut off.
      firstDiffAt: [...full].findIndex((ch, i) => ch !== c.fromSearch[i]),
      searchTail: JSON.stringify(c.fromSearch.slice(-60)),
      singleTail: JSON.stringify(full.slice(-60)),
    });
}

console.log("\n═══ RESULT ═══");
console.log(`  compared              ${Math.min(candidates.length, 25)}`);
console.log(`  ✅ identical          ${same}`);
console.log(`  🔴 search is SHORTER  ${shorter}`);
console.log(`  ⚠️  reformatted        ${reformatted}`);
console.log(`  requests spent        ${calls}`);

if (worst.length) {
  console.log("\n═══ THE DIFFERENCES ═══");
  for (const w of worst) console.log(" ", JSON.stringify(w, null, 2).replace(/\n/g, "\n  "));
  console.log(
    "\n🔴 IF THE SEARCH IS SHORTER, THE MOVES SCREEN IS UNDERCOUNTING SILENTLY,\n" +
      "   and the fix is NOT a per-record GET — that is one request per case\n" +
      "   against a 100-per-10-second budget, which is the storm round 152\n" +
      "   already produced once. The options, in order of preference:\n" +
      "     1. keep the log SHORTER THAN THE CUT-OFF by trimming oldest rows in\n" +
      "        the recorder, and say on the screen how far back it reaches;\n" +
      "     2. detect the cut here and mark the screen's totals a lower bound,\n" +
      "        rather than printing them as if whole;\n" +
      "     3. a nightly roll-up into a second field, read instead of the log.\n" +
      "   ⚠️ NOTHING IS DECIDED BY THIS SCRIPT. It measures.",
  );
} else {
  console.log("\n✅ The search payload carries the log byte for byte.");
}
