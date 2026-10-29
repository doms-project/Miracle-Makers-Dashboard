// ---------------------------------------------------------------------------
// ROUND 190 PROOF — each tab keeps its own date range.
//
// Round 188 gave Clients and Recruiting separate Created filters but let
// Master read the Clients one; round 189 showed it on Master. The owner wants
// each tab independent: a range set on Clients must not narrow Master, and the
// reverse. Checked in Chrome too (V2-REPORT-190.md).
// Run: npx tsx scripts/round190-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}`); } };
const at = (start, len) => { const i = src.indexOf(start); return i < 0 ? "" : src.slice(i, i + len); };

const masterCols = at("const masterColumns = useMemo", 2500);
const preSrc = at("const preSrc = useMemo", 2000);
const cgPre = at("const cgPreStage = useMemo", 500);
const mToolbar = at('placeholder="Search by client name…"', 6000);

console.log("1 · Three ranges, three states");
ok("Clients has its own", /useState<CreatedRange>\("all"\);[\s\S]{0,40}createdFrom/.test(src) && /const \[createdRange, setCreatedRange\]/.test(src));
ok("Master has its own", /const \[masterCreatedRange, setMasterCreatedRange\]/.test(src));
ok("Recruiting has its own", /const \[cgCreatedRange, setCgCreatedRange\]/.test(src));

console.log("2 · Each board reads only its own");
ok("Clients reads clientWin", /inCreatedWindow\(r\.createdAt, clientWin\)/.test(preSrc));
ok("🔴 Master reads masterWin — and never clientWin", /inCreatedWindow\(r\.createdAt, masterWin\)/.test(masterCols) && !/clientWin/.test(masterCols));
ok("Recruiting reads cgWin", /inCreatedWindow\(r\.createdAt, cgWin\)/.test(cgPre));
ok("masterWin is built from Master's own state", /createdWindow\(masterCreatedRange, new Date\(\), masterCreatedFrom, masterCreatedTo\)/.test(src));

console.log("3 · Each toolbar drives only its own");
ok("Master's control is bound to Master's state", /id="mcreatedSel"\s+range=\{masterCreatedRange\}\s+onRange=\{setMasterCreatedRange\}/.test(mToolbar));
ok("Master's toolbar never sets the Clients range", !/setCreatedRange\(/.test(mToolbar));
ok("the Clients control is bound to the Clients state", /id="createdSel"\s+range=\{createdRange\}\s+onRange=\{setCreatedRange\}/.test(src));
ok("the Recruiting control is bound to its own", /id="cgCreatedSel"\s+range=\{cgCreatedRange\}\s+onRange=\{setCgCreatedRange\}/.test(src));

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
