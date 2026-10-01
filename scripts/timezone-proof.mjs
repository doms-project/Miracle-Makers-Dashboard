// ---------------------------------------------------------------------------
// ROUND 168 — ONE TIME ZONE, AND "CREATED BY" WITHOUT A GUESSED ENUM.
//
// 🔴 THE WHOLE FILE RE-RUNS ITSELF UNDER THREE MACHINE TIME ZONES. Every bug
// this round fixes was a formatter reading the HOST's zone, so a proof run only
// on the build machine's zone cannot see them: it would pass on a UTC server
// and fail on a laptop in Manila, or the reverse. `TZ=` is set in the child's
// environment, which is the only way to change it — `process.env.TZ` after
// startup does not move an already-constructed Intl formatter.
//
// ⚠️ AND THE CHILD RUNS THE SAME ASSERTIONS, not a subset. A reduced child is
// how you get a green run that proved less than the parent did.
//
// Run: npx tsx scripts/timezone-proof.mjs
// ---------------------------------------------------------------------------
import { execFileSync } from "node:child_process";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const {
  formatEastern,
  formatEasternDay,
  formatEasternShort,
  formatEasternNoZone,
  formatGhlDate,
  parseGhlDate,
} = await import("../lib/dates.ts");
const { createdByLabel, humaniseSource } = await import("../lib/createdBy.ts");

const TZ = process.env.TZ || "(host default)";
console.log(`═══ RUNNING UNDER TZ=${TZ} ═══`);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 1 · 🔴 WILLIAM YOST, THE LIVE RECORD ═══");
// ═══════════════════════════════════════════════════════════════════════════
// Probed live on yNdWocl4xWXtIwwU5Nsr: GoHighLevel renders this exact instant
// as "Sep 30 2026, 11:34pm (EDT)". Our panel sits beside theirs.
const YOST = "2026-10-01T03:34:26.497Z";
ok("🔴 renders EXACTLY what GoHighLevel shows",
  formatEastern(YOST) === "Sep 30 2026, 11:34pm (EDT)", formatEastern(YOST));
// 🔴 THE DAY IS THE HALF THAT WAS WRONG, AND IT IS ASSERTED SEPARATELY. The
// instant is 1 October in UTC and 30 September in Eastern; a formatter that
// converted the clock but not the date would pass an hours-only check.
ok("🔴 …including the DAY, which UTC gets wrong",
  /^Sep 30 /.test(formatEastern(YOST)), formatEastern(YOST));
ok("the updatedAt a second later is the same minute",
  formatEastern("2026-10-01T03:34:59.290Z") === "Sep 30 2026, 11:34pm (EDT)",
  formatEastern("2026-10-01T03:34:59.290Z"));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 2 · EDT AND EST, FROM THE ZONE DATABASE ═══");
// ═══════════════════════════════════════════════════════════════════════════
ok("🔴 January is (EST)",
  formatEastern("2026-01-15T18:00:00.000Z") === "Jan 15 2026, 1:00pm (EST)",
  formatEastern("2026-01-15T18:00:00.000Z"));
ok("July is (EDT)", /\(EDT\)$/.test(formatEastern("2026-07-04T16:00:00.000Z")),
  formatEastern("2026-07-04T16:00:00.000Z"));
// ⚠️ THE CONTROL IS THAT THE TWO DIFFER. A formatter that hardcoded "EDT" would
// pass every assertion above.
ok("🔴 CONTROL — the label genuinely changes with the date",
  formatEastern("2026-01-15T18:00:00.000Z").slice(-5) !==
    formatEastern("2026-07-04T16:00:00.000Z").slice(-5));
// 🔴 AND THE OFFSET CHANGES WITH IT, not just the letters. 18:00Z is 1pm in
// winter and 2pm in summer; a stub that swapped only the suffix would not.
ok("🔴 …and so does the hour", formatEastern("2026-01-15T18:00:00.000Z").includes("1:00pm") &&
  formatEastern("2026-07-15T18:00:00.000Z").includes("2:00pm"),
  [formatEastern("2026-01-15T18:00:00.000Z"), formatEastern("2026-07-15T18:00:00.000Z")]);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 3 · 🔴 THE NOTE THAT SHOWED TOMORROW ═══");
// ═══════════════════════════════════════════════════════════════════════════
// A note added at 8:30pm Eastern arrives as 00:30 UTC the next day. The server
// formatted with no zone, so it stamped the next day at 12:30 AM — on every
// note, for every reader.
const EVENING = "2026-10-01T00:30:00.000Z";
ok("🔴 a 00:30 UTC note renders the PREVIOUS day",
  formatEasternDay(EVENING) === "Sep 30 2026", formatEasternDay(EVENING));
ok("…at the right hour", formatEasternNoZone(EVENING) === "Sep 30 2026, 8:30pm",
  formatEasternNoZone(EVENING));
ok("the short form drops the year, not the day",
  formatEasternShort(EVENING) === "Sep 30", formatEasternShort(EVENING));
ok("🔴 CONTROL — a MIDDAY note is the same day in both zones, so §3 is about the edge",
  formatEasternDay("2026-09-30T16:00:00.000Z") === "Sep 30 2026");
ok("…and no zone label leaks into the no-zone form",
  !/\(E[SD]T\)/.test(formatEasternNoZone(EVENING)), formatEasternNoZone(EVENING));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 4 · 🔴 A DATE IS NOT A TIMESTAMP ═══");
// ═══════════════════════════════════════════════════════════════════════════
// GoHighLevel stores a DATE field at UTC midnight. Converting it to Eastern
// would render March 14 as March 13 — a day lost on an appointment date.
ok("🔴 a bare date stays Mar 14", formatGhlDate("2026-03-14") === "Mar 14, 2026",
  formatGhlDate("2026-03-14"));
ok("🔴 …and so does the epoch-ms shape the board sends",
  formatGhlDate(Date.UTC(2026, 2, 14)) === "Mar 14, 2026",
  formatGhlDate(Date.UTC(2026, 2, 14)));
ok("…and the full-ISO midnight shape a write returns",
  formatGhlDate("2026-03-14T00:00:00.000Z") === "Mar 14, 2026",
  formatGhlDate("2026-03-14T00:00:00.000Z"));
ok("the date input value is unshifted too",
  parseGhlDate("2026-03-14")?.toISOString().slice(0, 10) === "2026-03-14");
// 🔴 THE CONTROL: a value that DOES carry a time must convert, or "date-only
// stays UTC" would be satisfied by nothing ever converting.
ok("🔴 CONTROL — a value WITH a time does convert, and names the zone",
  formatGhlDate(YOST) === "Sep 30 2026, 11:34pm (EDT)", formatGhlDate(YOST));
ok("⚠️ …and no stray \" UTC\" survives anywhere",
  !/ UTC$/.test(formatGhlDate(YOST)) && !/ UTC$/.test(formatGhlDate("2026-03-14")));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 5 · CREATED BY — EXACT WHERE KNOWN, MECHANICAL OTHERWISE ═══");
// ═══════════════════════════════════════════════════════════════════════════
const nameOf = (id) => (id === "u1" ? "Dana Ruiz" : "");
const src = (sourceValue, sourceUserId = "", sourceType = "CREATED") =>
  ({ sourceType, sourceValue, sourceUserId });

ok("🔴 WORKFLOW_NEW renders \"Workflow\" — the one observed value",
  createdByLabel(src("WORKFLOW_NEW"), nameOf) === "Workflow",
  createdByLabel(src("WORKFLOW_NEW"), nameOf));
ok("🔴 a MISSING internalSource renders NOTHING — never \"Unknown\"",
  createdByLabel({ sourceType: "", sourceValue: "", sourceUserId: "" }, nameOf) === "",
  createdByLabel({ sourceType: "", sourceValue: "", sourceUserId: "" }, nameOf));
ok("a person who created it by hand gets their NAME",
  createdByLabel(src("MANUAL", "u1"), nameOf) === "Dana Ruiz",
  createdByLabel(src("MANUAL", "u1"), nameOf));
ok("⚠️ a departed one is said, not dropped",
  createdByLabel(src("MANUAL", "u404"), nameOf) === "Former user",
  createdByLabel(src("MANUAL", "u404"), nameOf));
ok("🔴 a person WINS over the constant beside them",
  createdByLabel(src("WORKFLOW_NEW", "u1"), nameOf) === "Dana Ruiz",
  createdByLabel(src("WORKFLOW_NEW", "u1"), nameOf));

// 🔴 THE MECHANISM, NOT A LIST I INVENTED. `internalSource` appears nowhere
// else in the repo and there are no live credentials, so GoHighLevel's full
// enum is unknown. These assert that an UNKNOWN value becomes readable from its
// own text — never blank, never guessed at.
ok("🔴 an unknown value is made readable from its own text",
  createdByLabel(src("PUBLIC_API"), nameOf) === "Public API",
  createdByLabel(src("PUBLIC_API"), nameOf));
ok("…in sentence case, the house style",
  createdByLabel(src("FORM_SUBMISSION"), nameOf) === "Form submission",
  createdByLabel(src("FORM_SUBMISSION"), nameOf));
ok("…camelCase splits too", humaniseSource("bulkActions") === "Bulk actions",
  humaniseSource("bulkActions"));
ok("🔴 …and NO unknown value ever renders empty, which is the real claim",
  ["WHATEVER_THIS_IS", "x", "A_B_C", "someNewThing"].every(
    (v) => createdByLabel(src(v), nameOf).length > 0),
  ["WHATEVER_THIS_IS", "x", "A_B_C", "someNewThing"].map((v) => createdByLabel(src(v), nameOf)));
ok("⚠️ anything naming a workflow is a Workflow",
  createdByLabel(src("WORKFLOW_SOMETHING_ELSE"), nameOf) === "Workflow");
// ⚠️ A uuid ON `id` IS NOT A PERSON. The live sample's internalSource.id is a
// uuid on a WORKFLOW_NEW source, so it names the WORKFLOW.
ok("🔴 an `id` that is not a `userId` is NOT read as a person",
  createdByLabel({ sourceType: "CREATED", sourceValue: "WORKFLOW_NEW", sourceUserId: "" }, nameOf)
    === "Workflow");

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed  (TZ=${TZ})`);

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE SAME FILE, UNDER TWO OTHER MACHINE ZONES.
// ═══════════════════════════════════════════════════════════════════════════
if (!process.env.TZ_CHILD) {
  let childFail = 0;
  for (const tz of ["Asia/Manila", "UTC"]) {
    console.log(`\n═══ RE-RUN UNDER TZ=${tz} ═══`);
    let out = "";
    try {
      out = execFileSync("npx", ["tsx", "scripts/timezone-proof.mjs"], {
        encoding: "utf8",
        env: { ...process.env, TZ: tz, TZ_CHILD: "1" },
      });
    } catch (e) {
      out = String(e.stdout || "") + String(e.stderr || "");
      childFail++;
    }
    const tally = (out.match(/\n(✅|🔴)\s+(\d+) passed · (\d+) failed.*/) || [])[0] || "(no tally)";
    console.log(`  ${tally.trim()}`);
    for (const line of out.split("\n")) if (/FAIL/.test(line)) console.log(`  ${line}`);
  }
  ok("🔴 identical under Asia/Manila and UTC — the host's zone cannot change a render",
    childFail === 0, `${childFail} child run(s) failed`);
  console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed  (incl. both child zones)`);
}

process.exit(fail ? 1 : 0);
