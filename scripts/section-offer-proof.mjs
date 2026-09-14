// ---------------------------------------------------------------------------
// ROUND 113 · ITEM P — IS A DRAWN SECTION STILL OFFERED IN "+ Add a section"?
//
// You gave two possible causes and said they need different fixes:
//   (a) Lost Reason itself     → a subtraction bug, available = ticked − drawn
//   (b) a DIFFERENT folder     → the available list ignores the pipeline's ticks
//
// 🔴 THIS TESTS WHICH, BY RUNNING THE REAL FUNCTION. `groupFieldsForPipeline`
// is pure and exported, so the question is answerable directly instead of
// reasoned about: feed it a caregiver-shaped config and look at both halves.
//
// Run: node --experimental-strip-types scripts/section-offer-proof.mjs
// ---------------------------------------------------------------------------
import { groupFieldsForPipeline, FOLDERS } from "../lib/fieldFolders.ts";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const CG = "EXVMveGzgDy9qf4wQR2H"; // PP Caregiver Applicants, per fieldFolders.ts:90
// ⚠️ REAL TOKENS, NOT INVENTED ONES. The folder map is keyed by GoHighLevel
// FOLDER IDS, and the lost-reason field is additionally gated per pipeline by
// LOST_REASON_OVERRIDES — so a made-up id is silently dropped and the fixture
// proves nothing. `AiuRVUF6UPcnLbZnHC7w` is Caregiver Rejection Reason, mapped
// to both applicant pipelines at fieldFolders.ts:108.
const LOST = FOLDERS.lostReason;
const OTHER = FOLDERS.shared;

const defs = [
  { id: "AiuRVUF6UPcnLbZnHC7w", name: "Caregiver Rejection Reason",
    dataType: "SINGLE_OPTIONS", parentId: LOST, editable: true, position: 0 },
  { id: "f_note", name: "Onboarding Note", dataType: "TEXT",
    parentId: OTHER, editable: true, position: 0 },
];

// ── 1 · ONE TICK, ONE ANSWERED FIELD ──────────────────────────────────────
console.log("\n1 · 🔴 ONE TICKED FOLDER, ITS FIELD ANSWERED");
const one = groupFieldsForPipeline(defs, CG, { [CG]: [LOST] },
  { values: { AiuRVUF6UPcnLbZnHC7w: "Failed background check" }, folderNames: {} });
console.log(`  drawn:     ${JSON.stringify(one.sections.map((s) => s.label))}`);
console.log(`  available: ${JSON.stringify(one.available.map((s) => s.label))}`);
ok("Lost Reason is DRAWN", one.sections.some((s) => /lost/i.test(s.label)),
   one.sections.map((s) => s.label));
ok("🔴 AND IT IS NOT ALSO OFFERED — available is empty",
   one.available.length === 0, one.available.map((s) => s.label));
ok("so (a) a subtraction bug is RULED OUT — the two halves are disjoint",
   !one.sections.some((s) => one.available.some((a) => a.key === s.key)), null);

// ── 2 · THE SAME TICK, NOTHING ANSWERED ───────────────────────────────────
console.log("\n2 · THE SAME SINGLE TICK WITH NO VALUE — IT MOVES, NOT COPIES");
const none = groupFieldsForPipeline(defs, CG, { [CG]: [LOST] },
  { values: {}, folderNames: {} });
console.log(`  drawn:     ${JSON.stringify(none.sections.map((s) => s.label))}`);
console.log(`  available: ${JSON.stringify(none.available.map((s) => s.label))}`);
ok("unanswered → offered, not drawn",
   none.available.length === 1 && none.sections.length === 0,
   { s: none.sections.length, a: none.available.length });

// ── 3 · 🔴 SO WHAT PRODUCES "(1 available)" BESIDE A DRAWN LOST REASON? ────
console.log("\n3 · 🔴 TWO TICKS — THE ONLY SHAPE THAT MATCHES THE LIVE SCREEN");
const two = groupFieldsForPipeline(defs, CG, { [CG]: [LOST, OTHER] },
  { values: { AiuRVUF6UPcnLbZnHC7w: "Failed background check" }, folderNames: {} });
console.log(`  drawn:     ${JSON.stringify(two.sections.map((s) => s.label))}`);
console.log(`  available: ${JSON.stringify(two.available.map((s) => s.label))}`);
ok("Lost Reason drawn AND exactly one other offered",
   two.sections.length === 1 && two.available.length === 1, {
     drawn: two.sections.map((s) => s.label),
     available: two.available.map((s) => s.label),
   });
ok("🔴 and the offered one is NOT Lost Reason",
   !/lost/i.test(two.available[0]?.label || ""), two.available.map((s) => s.label));

// ── 4 · (b) RULED OUT TOO — AN UNTICKED FOLDER IS NEVER OFFERED ───────────
console.log("\n4 · 🔴 DOES THE OFFER LIST HONOUR THE TICKS? (your cause (b))");
const ticked = groupFieldsForPipeline(defs, CG, { [CG]: [LOST] },
  { values: {}, folderNames: {} });
const offered = ticked.available.map((s) => s.key);
console.log(`  ticked:  ["${LOST}"]`);
console.log(`  offered: ${JSON.stringify(offered)}`);
ok("🔴 an UNTICKED folder is never offered — no client field can reach an applicant",
   !offered.includes(OTHER) && !offered.includes("shared"), offered);
ok("every offered key is one of the ticked keys",
   offered.every((k) => ["lostReason", LOST].includes(k)), offered);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(
  "\n⚠️ WHAT THIS MEANS FOR THE LIVE SCREEN: neither of the two causes holds.\n" +
  "   The halves are disjoint and the offer honours the ticks, so \"(1 available)\"\n" +
  "   beside a drawn Lost Reason means the STORED entry for that pipeline ticks\n" +
  "   TWO folders — and fieldFolders.ts:90's [lostReason] is only the FALLBACK,\n" +
  "   used when no stored entry exists (lib/fieldFolders.ts:288-303).",
);
process.exit(fail ? 1 : 0);
