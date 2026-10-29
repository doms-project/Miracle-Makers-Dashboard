// ---------------------------------------------------------------------------
// ROUND 189 PROOF — the Master view shows every filter it applies.
//
// Master reads the Clients board's Created filter (round 188) but had no
// Created control, so "Today" set on Clients left Master quietly showing only
// today's cases. Master now shows the control, says "Showing X of Y records ·
// filtered by …" and offers Clear filters.
// The behaviour was also checked in Chrome (see V2-REPORT-189.md); this proof
// keeps the wiring from coming undone.
// Run: npx tsx scripts/round189-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };

// Anchored on Master's own search box: another screen uses the same toolbar class.
const mt = src.indexOf('placeholder="Search by client name…"');
const toolbar = src.slice(mt, mt + 6000);
const master = src.slice(src.indexOf("const masterColumns = useMemo"), src.indexOf("const masterColumns = useMemo") + 2500);

console.log("1 · Master applies the Created filter (round 188)");
// ROUND 190 — Master's window is its own; round 189's point (shown, named, clearable) still holds.
ok("its columns filter by a created window (Master's own since round 190)", /inCreatedWindow\(r\.createdAt, masterWin\)/.test(master));

console.log("2 · …and now shows it");
ok("🔴 the Master toolbar renders the Created control", /<CreatedFilter\s+id="mcreatedSel"/.test(toolbar));
ok("bound to the SAME state Master filters by", /id="mcreatedSel"\s+range=\{masterCreatedRange\}\s+onRange=\{setMasterCreatedRange\}/.test(toolbar));

console.log("3 · Master says when it is not showing everything");
ok("'Showing X of Y records' against all the client records", /Showing \$\{shown\} of \$\{total\} records/.test(toolbar) && /const total = data\.length/.test(toolbar));
ok("it names search, office, created and a clicked tile", /search “/.test(toolbar) && /office \$\{office\}/.test(toolbar) && /describeWindow\(masterCreatedRange, masterWin\)/.test(toolbar) && /focusLabel\(masterFocus\)/.test(toolbar));
ok("Clear filters resets all four", /setQ\(""\);[\s\S]{0,80}setOffice\("all"\);[\s\S]{0,80}setMasterCreatedRange\("all"\);[\s\S]{0,160}setMasterFocus\(null\)/.test(toolbar));

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
