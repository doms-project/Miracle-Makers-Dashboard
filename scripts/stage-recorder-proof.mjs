// ---------------------------------------------------------------------------
// ROUND 163 — THE STAGE RECORDER.
//
// 🔴 WHAT THIS HAS TO GET RIGHT, AND WHY EACH ONE BITES:
//
//   append, never replace      the log is the KPI; overwriting loses a month
//   managers FROZEN            the map changes — resolving at read time credits
//                              a manager with moves they were not watching
//   the stage from the RECORD  the payload sends `pipleline_stage`, a NAME
//   idempotent                 GoHighLevel retries; a redelivery must not
//                              invent a second move
//   `from: null` on row one    the case was already somewhere. "No origin" is
//                              an answer, not a blank
//
// ⚠️ AND A BULK EDIT IS NOT DECIDED HERE. Fourteen rows one second apart is
// spottable by whoever reads them — round 150 §3: store the before/after, not a
// verdict, so the rule for excluding them can change without re-recording.
//
// Run: npx tsx scripts/stage-recorder-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { execFileSync } from "node:child_process";

// 🔴 ONE PROCESS CAN ONLY TEST ONE FIELD LIST. `getFieldDefinitions()` is
// memoised at module level, so flipping the fake's field list mid-run changes
// nothing — the defs were cached on the first read. Section 5 was written that
// way and failed for a reason that had nothing to do with the code: the
// FIXTURE could not reach the feature.
//
// ⚠️ Same problem and same answer as task1-apply-proof's `norecordfield` child:
// the no-field shape runs in its own process, configured that way from startup.
// The child starts its OWN server, which is why execFileSync is safe here — see
// backfill-proof for the case where it is not.
const SHAPE = process.env.SHAPE || "normal";

const LOC = "loc_test";
let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const ERN = "u_ern", CARLA = "u_carla", EDMARK = "u_edmark", LAMARR = "u_lamarr";
const PIPE = "pipe_client", SH = "f_stagehistory";
const S1 = "stg_newlead", S2 = "stg_cao", S3 = "stg_mco";

let opp, writes, hasField;
const reset = () => {
  writes = [];
  hasField = SHAPE !== "nofield";
  opp = {
    id: "o1", name: "A Client", pipelineId: PIPE, pipelineStageId: S1,
    status: "open", assignedTo: ERN, contactId: "c1",
    updatedAt: "2026-09-01T10:00:00.000Z", followers: [], customFields: [],
  };
};
reset();

/** The case-manager map, so "frozen at write time" can be tested by changing it. */
let managerMap = { [ERN]: [CARLA, EDMARK] };

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : null;
    const [path] = req.url.split("?");
    const send = (code, o) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (path.startsWith(`/locations/${LOC}/customFields`))
      return send(200, { customFields: hasField
        ? [{ id: SH, name: "Stage History", dataType: "LARGE_TEXT" }] : [] });
    if (path === "/users/")
      return send(200, { users: [ERN, CARLA, EDMARK, LAMARR].map((id) => ({ id, name: id })) });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [{ id: PIPE, name: "OLTL Enrollment", stages: [
        { id: S1, name: "NEW LEAD", position: 0 },
        { id: S2, name: "CAO", position: 1 },
        { id: S3, name: "MCO", position: 2 }] }] });
    if (path.startsWith(`/locations/${LOC}/customValues`))
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Access", value: JSON.stringify({
          pipelines: {}, folders: {}, master: [], caseManagers: managerMap }) },
        { id: "cv2", name: "MM Pipeline Folders", value: JSON.stringify({
          seeded: true, folderNames: {}, pipelines: { [PIPE]: { scope: "client", folders: [] } } }) },
      ] });
    if (path.startsWith("/opportunities/search"))
      return send(200, { opportunities: [opp], meta: { total: 1 } });
    if (path === "/contacts/search") return send(200, { contacts: [], total: 0 });
    if (path === "/opportunities/o1") {
      if (req.method === "PUT") {
        writes.push(j);
        for (const f of j?.customFields || []) {
          const e = opp.customFields.find((x) => x.id === f.id);
          if (e) e.fieldValue = f.value;
          else opp.customFields.push({ id: f.id, fieldValue: f.value });
        }
        return send(200, { opportunity: opp });
      }
      return send(200, { opportunity: opp });
    }
    send(404, { message: `no fake handler for ${path}` });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.PIPELINE_IDS = PIPE;

const ghl = await import("../lib/ghl.ts");
const pa = await import("../lib/pipelineAccess.ts");
const withMap = (fn) => pa.runWithCaseManagers(pa.buildIdMap(managerMap), fn);
const stored = () => opp.customFields.find((f) => f.id === SH)?.fieldValue ?? null;
const move = async (to) => {
  opp.pipelineStageId = to;
  ghl.invalidateOpportunity("o1");
  return withMap(() => ghl.appendStageHistory("o1"));
};

if (SHAPE === "normal") {
console.log("═══ 1 · 🔴 IT APPENDS — THE SECOND MOVE DOES NOT REPLACE THE FIRST ═══");
reset();
let r = await move(S2);
console.log(`  after move 1: ${JSON.stringify(stored())}`);
ok("the first move is recorded", r.recorded && stored().includes(S2), { r, stored: stored() });
r = await move(S3);
console.log(`  after move 2: ${JSON.stringify(stored())}`);
// 🔴 THE WHOLE POINT. A replace would lose the month, and "the field has a
// value" is true in both worlds — so the assertion is on BOTH stages.
ok("🔴 BOTH stages are in the log — it appended, it did not overwrite",
   stored().includes(S2) && stored().includes(S3), stored());
ok("⚠️ two rows, one per line", stored().split("\n").length === 2, stored().split("\n"));
// 🔴 THE **STORED** COUNT, NOT THE REPORTED ONE. `r.rows` is what the function
// says it wrote; with a replace it still says 2 while one row is on the record.
// A count assertion satisfied by the behaviour stopping — rule 14, in my own
// proof, caught by the revert below.
ok("and the record really holds two rows", ghl.parseStageHistory(stored()).length === 2,
   { reported: r.rows, stored: ghl.parseStageHistory(stored()).length });

console.log("\n═══ 2 · 🔴 `from` IS DERIVED, AND row 1 HAS NO ORIGIN ═══");
const rows = ghl.parseStageHistory(stored());
console.log(`  ${JSON.stringify(rows.map((x) => ({ from: x.from, to: x.to })))}`);
ok("🔴 row 1's origin is null — the case was already somewhere and nothing knows where",
   rows[0].from === null, rows[0]);
// ⚠️ THE CONTROL. If `from` were null everywhere the line above would pass
// while the field had stopped meaning anything.
ok("🔴 THE CONTROL — row 2's origin IS row 1's destination",
   rows[1].from === S2 && rows[1].to === S3, rows);
ok("⚠️ null is not the empty string — a reader can tell them apart",
   rows[0].from !== "", rows[0].from);

console.log("\n═══ 3 · 🔴 MANAGERS ARE FROZEN AT THE MOMENT OF THE MOVE ═══");
// Lamarr joins the map AFTER the two moves above. Resolving at read time would
// credit him with both; the rows must not change.
managerMap = { [ERN]: [CARLA, EDMARK, LAMARR] };
const after = ghl.parseStageHistory(stored());
console.log(`  row 1 managers: ${JSON.stringify(after[0].managerIds)}`);
ok("🔴 the OLD rows still name only the two managers who were watching then",
   !after[0].managerIds.includes(LAMARR) && after[0].managerIds.length === 2, after[0].managerIds);
// 🔴 THE CONTROL: the map really did change, so the line above is not passing
// because nothing happened.
r = await move(S1);
const now = ghl.parseStageHistory(stored());
console.log(`  row 3 managers: ${JSON.stringify(now[2].managerIds)}`);
ok("🔴 THE CONTROL — the NEXT move records all three, so the map really changed",
   now[2].managerIds.includes(LAMARR) && now[2].managerIds.length === 3, now[2].managerIds);
// 🔴 AND ROW 1 IS RE-CHECKED **AFTER** THAT WRITE. Checking it before proves
// nothing: re-resolution would happen during the next append, rewriting the
// earlier rows. The first version of this section looked only at the old rows
// beforehand and at the new row afterwards — so it could not see the failure it
// was written for, and the revert came back green.
console.log(`  row 1 after a later write: ${JSON.stringify(now[0].managerIds)}`);
ok("🔴 row 1 STILL names two after a later move rewrote the field",
   !now[0].managerIds.includes(LAMARR) && now[0].managerIds.length === 2, now[0].managerIds);

console.log("\n═══ 4 · 🔴 IDEMPOTENT — A REDELIVERY INVENTS NOTHING ═══");
const before4 = stored();
const w = writes.length;
r = await withMap(() => ghl.appendStageHistory("o1"));   // same stage, no move
console.log(`  -> recorded=${r.recorded} "${r.why}"`);
ok("🔴 a repeat of the same stage records NOTHING", r.recorded === false, r);
ok("🔴 and not one write was sent", writes.length === w, writes.length - w);
ok("the log is byte-identical", stored() === before4, { before4, after: stored() });
// ⚠️ THE CONTROL: A→B→A must still record, or "idempotent" would mean "ignores
// real moves back to a stage it has seen".
r = await move(S2);
ok("🔴 THE CONTROL — a genuine move back to an earlier stage IS recorded",
   r.recorded && ghl.parseStageHistory(stored()).length === 4, r);

}

if (SHAPE === "nofield") {
console.log("═══ 5 · ⚠️ NO FIELD ON THE ACCOUNT — NAMED, NOT SILENT  (child process) ═══");
reset();
let r = await withMap(() => ghl.appendStageHistory("o1"));
console.log(`  -> "${r.why}"`);
ok("it does not record", r.recorded === false, r);
ok("🔴 and says the field is missing, with how to create it",
   /Stage History.*LARGE_TEXT/.test(r.why), r.why);
ok("⚠️ nothing was written", writes.length === 0, writes);

}

if (SHAPE === "normal") {
console.log("\n═══ 6 · 🔴 A BULK EDIT IS VISIBLE IN THE ROWS, NOT JUDGED AT WRITE TIME ═══");
// Fourteen records moving in one second is not human. The recorder stores the
// timestamp and stage and nothing else — the cluster is the reader's to spot,
// so the rule for excluding it can change without re-recording anything.
reset();
await move(S2);
const one = ghl.parseStageHistory(stored())[0];
ok("every row carries its timestamp", /^\d{4}-\d{2}-\d{2}T/.test(one.at), one.at);
ok("⚠️ and its owner, so a move can be attributed without a second lookup",
   one.ownerId === ERN, one);
// 🔴 THE POINT: no verdict field. Nothing in the row says "bulk" or "human",
// because that judgement would be frozen at write time and is the one thing
// most likely to be revised.
ok("🔴 the row stores facts, not a verdict — no 'bulk' flag to be wrong later",
   !/bulk|auto|human/i.test(stored()), stored());

}

if (SHAPE === "normal") {
  console.log("\n═══ 5 · IN A CHILD PROCESS, BECAUSE THE FIELD LIST IS MEMOISED ═══");
  let childOut = "", childOk = true;
  try {
    childOut = execFileSync("npx", ["tsx", "scripts/stage-recorder-proof.mjs"], {
      env: { ...process.env, SHAPE: "nofield" }, encoding: "utf8",
    });
  } catch (e) {
    childOut = String(e.stdout || "") + String(e.stderr || "");
    childOk = false;
  }
  for (const line of childOut.split("\n"))
    if (/^\s{2}(ok|FAIL)|no-field/.test(line)) console.log(`  ${line.trim()}`);
  ok("🔴 the no-field shape passes in its own process", childOk, childOut.slice(-500));
}

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed${SHAPE === "normal" ? "  (+ the child's)" : "  (no-field shape)"}`);
server.close();
process.exit(fail ? 1 : 0);
