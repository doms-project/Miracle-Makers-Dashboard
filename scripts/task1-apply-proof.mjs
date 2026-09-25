// ---------------------------------------------------------------------------
// TASK 1 · STEP 2 — applyCaseManagers.
//
// 🔴 THE CONTROL ASSERTION IS THE POINT, AND THE BRIEF ASKED FOR IT BY NAME.
// "An empty map changes nothing" passes just as well when the whole function is
// broken. So every no-op section here is paired, IN THE SAME RUN, with a
// populated case that DOES change something — the same shape as the picker
// check's live-picker control, and the same reasoning as the rule about a fake
// answering something GoHighLevel would refuse.
//
// ⚠️ AND THE FAKE ENFORCES WHAT GOHIGHLEVEL ENFORCES on the two write shapes
// this depends on: followers are a DELTA (a POST adds the ids sent, a DELETE
// removes the ids sent — neither replaces the array), and a PUT of one custom
// field updates rather than replacing the others. A fake that replaced would
// make rule B untestable.
//
// Run: npx tsx scripts/task1-apply-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { execFileSync } from "node:child_process";

// 🔴 ONE PROCESS CAN ONLY TEST ONE FIELD LIST. `getFieldDefinitions()` is
// memoised at module level and `bustFieldCaches()` is private, so changing the
// fake's fields mid-run does nothing — section 2c first reported
// `noRecordField=false` for exactly that reason, and the APP was right. The
// no-field shape therefore runs in a CHILD PROCESS with the fake configured
// that way from the start. Same problem and same answer as round 130.
const SHAPE = process.env.SHAPE || "normal";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
const CM_FIELD = "f_cm", CM_REC = "f_cmrec", OTHER = "f_other";
// The real ids from the brief, so the map under test is the one that ships.
const ERN = "VkvEW5dTHant8jOXAU4r";
const CARLA = "V0gYK3HpF1Tan7Uv0Jcp", EDMARK = "WiFUXs6SShLwFB0Z5enR";
const HAYDEE = "RZZ8IkAYgUzawNDgvcj4", ROI = "hptqeBiFG307OqRQBWWF";
const UNMAPPED = "u_nobody";
const HUMAN_ADDED = "u_corep";

const REAL_MAP = {
  [ERN]: [CARLA, EDMARK],
  RBgFWgr3hpff8ejCQ3zS: [CARLA, EDMARK],
  [HAYDEE]: [ROI],
  "9HN9EobwrCV9V7F0lzV7": ["ZcQ068JfdPGp9hhFhyeB"],
  UjNG7eBJbdy9BXcvyWvl: ["E3nlUhAxGjoVHsKdhu2J"],
};

let S;
const reset = (over = {}) => {
  S = {
    // 🔴 SHAPE DECIDES THIS FROM THE FIRST REQUEST, not at section 2c. The field
    // list is memoised on the FIRST read, so a later `reset` cannot change it —
    // which is what made the child fail too, until the whole run was shaped.
    hasRecordField: SHAPE !== "norecordfield",
    hasNameField: true,
    opps: {
      o1: {
        id: "o1", name: "Mary Malone", pipelineId: "p1", pipelineStageId: "p1_s1",
        status: "open", assignedTo: ERN, contactId: "c1",
        updatedAt: "2026-09-01T10:00:00.000Z",
        followers: [HUMAN_ADDED],          // ⚠️ a co-rep a HUMAN added
        customFields: [],
      },
    },
    writes: [],
    ...over,
  };
};

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const j = raw ? JSON.parse(raw) : null;
    const [path, qs] = req.url.split("?");
    const q = new URLSearchParams(qs || "");
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (path === `/locations/${LOC}/customFields`) {
      if (q.get("model") === "opportunity") {
        const f = [{ id: OTHER, name: "Care Needs", dataType: "TEXT" }];
        if (S.hasNameField) f.push({ id: CM_FIELD, name: "Case Manager", dataType: "TEXT" });
        if (S.hasRecordField) f.push({ id: CM_REC, name: "Case Manager Followers", dataType: "TEXT" });
        return send(200, { customFields: f });
      }
      return send(200, { customFields: [] });
    }
    if (path === "/users/")
      return send(200, { users: [
        { id: ERN, name: "Ern Holden" }, { id: CARLA, name: "Carla Winnigan" },
        { id: EDMARK, name: "Edmark Villanueva" }, { id: HAYDEE, name: "Haydee Ortiz" },
        { id: ROI, name: "Roi Navarte" }, { id: UNMAPPED, name: "Nobody Mapped" },
        { id: HUMAN_ADDED, name: "A Co-Rep" },
      ] });
    // ⚠️ TWO PIPELINES, p1 CLIENT-SCOPED AND p2 CAREGIVER — exactly the
    // distinction round 149 turns on. p2's name is also the one divisionLabel
    // mangles ("OLTL Caregiver Applicants" → "OLTL Caregiver"), which is why
    // scope and not divisionLabel is the test.
    //
    // 🔴 AND THE SCOPE COMES FROM THE STORED CONFIG BELOW, NOT THE ENV LIST.
    // This fake served no customValues, so getSelectedPipelines fell through to
    // its PIPELINE_IDS fallback and the proof exercised the fallback path while
    // the live account uses the stored one. Green on the wrong road — the
    // production-shape rule, met in my own fixture.
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        { id: "p1", name: "OLTL Enrollment",
          stages: [{ id: "p1_s1", name: "NEW LEAD", position: 0 }] },
        { id: "p2", name: "OLTL Caregiver Applicants",
          stages: [{ id: "p2_s1", name: "APPLIED", position: 0 }] },
      ] });
    if (path === `/locations/${LOC}/customValues`)
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({
          seeded: true, folderNames: {},
          pipelines: {
            p1: { scope: "client", folders: [] },
            p2: { scope: "caregiver", folders: [], group: "caregiver" },
          },
        }) }] });
    if (path === "/opportunities/search")
      return send(200, { opportunities: Object.values(S.opps), meta: { total: 1 } });

    const oppId = (/^\/opportunities\/([^/]+)/.exec(path) || [])[1];
    if (oppId && /\/followers$/.test(path)) {
      const o = S.opps[oppId];
      const ids = (j?.followers || []).filter(Boolean);
      S.writes.push({ what: "followers", method: req.method, ids });
      // 🔴 A DELTA, BOTH WAYS. Neither verb replaces the array.
      if (req.method === "POST") o.followers = [...new Set([...o.followers, ...ids])];
      else if (req.method === "DELETE") o.followers = o.followers.filter((f) => !ids.includes(f));
      return send(200, { followers: o.followers });
    }
    if (oppId && path === `/opportunities/${oppId}`) {
      const o = S.opps[oppId];
      if (!o) return send(404, { message: "not found" });
      if (req.method === "PUT") {
        S.writes.push({ what: "put", body: j });
        // ✅ A PARTIAL customFields ARRAY UPDATES, it does not replace —
        // verified live and written down in updateContactCustomFields.
        for (const f of j.customFields || []) {
          const at = o.customFields.findIndex((x) => x.id === f.id);
          if (at >= 0) o.customFields[at] = { id: f.id, fieldValue: f.value };
          else o.customFields.push({ id: f.id, fieldValue: f.value });
        }
        for (const [k, v] of Object.entries(j)) if (k !== "customFields") o[k] = v;
        return send(200, { opportunity: o });
      }
      return send(200, { opportunity: o });
    }
    if (/^\/contacts\/[^/]+$/.test(path)) return send(200, { contact: { id: "c1" } });
    send(404, { message: `no fake handler for ${req.url}` });
  });
});
reset();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.PIPELINE_IDS = "p1";

const ghl = await import("../lib/ghl.ts");
const pa = await import("../lib/pipelineAccess.ts");

/** Run `fn` with a case-manager map in the request-scoped store. */
const withMap = (map, fn) => pa.runWithCaseManagers(pa.buildIdMap(map), fn);
const cf = (id) => S.opps.o1.customFields.find((f) => f.id === id)?.fieldValue ?? null;
const followers = () => [...S.opps.o1.followers].sort();
const fresh = () => { ghl.invalidateOpportunity?.("o1"); S.writes = []; };

// Hoisted: sections 3-6 sit outside the `normal` block that first declared it.
let r;

if (SHAPE === "normal") {
console.log("\n═══ 1 · 🔴 RULE A — AND ITS CONTROL, IN THE SAME RUN ═══");
console.log("\n1a · THE EMPTY MAP CHANGES NOTHING");
reset(); fresh();
r = await withMap({}, () => ghl.applyCaseManagers("o1", ERN));
console.log(`  -> skipped=${r.skipped} "${r.why}"`);
ok("it skips", r.skipped === true, r);
// ⚠️ THE PROPERTY, NOT THE SENTENCE. This read `/no entry in the case-manager
// map/` — the exact wording — and the rule-A resolution rephrased it. Pinned to
// a literal I then improved, for the fifth time; what must hold is that it says
// there is no entry, not how it says it.
ok("⚠️ saying why, rather than reporting a silent success",
   /no entry/.test(r.why || ""), r.why);
ok("🔴 no follower was added or removed", followers().join() === HUMAN_ADDED, followers());
ok("🔴 the Case Manager field was NOT touched — not written, not cleared",
   cf(CM_FIELD) === null, cf(CM_FIELD));
ok("🔴 and NOTHING was sent to GoHighLevel at all", S.writes.length === 0, S.writes);

console.log("\n1b · 🔴 THE CONTROL — A POPULATED MAP DOES CHANGE SOMETHING");
// Without this, 1a passes just as well when the whole function is broken.
reset(); fresh();
r = await withMap(REAL_MAP, () => ghl.applyCaseManagers("o1", ERN));
console.log(`  -> added=${JSON.stringify(r.added)} field="${r.fieldValue}"`);
console.log(`  -> ${r.steps.join(" · ")}`);
ok("🔴 it did NOT skip", r.skipped === false, r);
ok("🔴 both of Ern's managers now follow the case",
   followers().includes(CARLA) && followers().includes(EDMARK), followers());
ok("⚠️ and the human-added co-rep is still there, untouched",
   followers().includes(HUMAN_ADDED), followers());
ok("the Case Manager field holds both names, comma-separated",
   cf(CM_FIELD) === "Carla Winnigan, Edmark Villanueva", cf(CM_FIELD));
ok("🔴 rule B's own record stores the two ids it added",
   cf(CM_REC) === `${CARLA},${EDMARK}`, cf(CM_REC));
ok("⚠️ and the read-back confirmed it rather than trusting the 200",
   r.steps.some((x) => /read-back confirms/.test(x)), r.steps);

console.log("\n1c · 🔴 AN UNMAPPED OWNER ON A CASE WE HAVE A RECORD FOR");
// 🔴 THE LEAK THE FIRST VERSION OF THIS PROOF EXPOSED. Ern's case is reassigned
// to somebody with no entry. The first implementation returned immediately and
// left Carla and Edmark following it forever. The test is now the STORED
// RECORD, not the map: we put them there, so we take them away.
fresh();
r = await withMap(REAL_MAP, () => ghl.applyCaseManagers("o1", UNMAPPED));
console.log(`  -> skipped=${r.skipped} removed=${JSON.stringify(r.removed)} field=${JSON.stringify(cf(CM_FIELD))}`);
ok("🔴 it does NOT skip — we hold a record for this case", r.skipped === false, r);
ok("🔴 THE MANAGERS GO. Removing what our own field names is reading, not inferring.",
   !followers().includes(CARLA) && !followers().includes(EDMARK), followers());
ok("🔴 and the human-added co-rep is STILL untouched — the rule that was being protected",
   followers().includes(HUMAN_ADDED), followers());
ok("the Case Manager field is cleared", cf(CM_FIELD) === "", cf(CM_FIELD));
ok("⚠️ and our own record is emptied with it", cf(CM_REC) === "", cf(CM_REC));

console.log("\n1d · 🔴 TRUE RULE A — UNMAPPED, AND NOTHING OF OURS ON THE RECORD");
// The state 21 of the 26 users are in. Nothing to add, nothing we may remove.
reset(); fresh();
r = await withMap(REAL_MAP, () => ghl.applyCaseManagers("o1", UNMAPPED));
console.log(`  -> skipped=${r.skipped} "${r.why}"`);
ok("it skips", r.skipped === true, r);
ok("⚠️ saying both halves of why", /no entry in the map and this function added nothing/.test(r.why), r.why);
ok("🔴 the co-rep is untouched and the field is never written",
   followers().join() === HUMAN_ADDED && cf(CM_FIELD) === null, { f: followers(), cm: cf(CM_FIELD) });
ok("🔴 and NOT ONE WRITE was sent", !S.writes.some((w) => w.what === "followers" || w.what === "put"), S.writes);

console.log("\n═══ 2 · 🔴 RULE B — REMOVAL IS SURGICAL ═══");
console.log("\n2a · A MAPPING CHANGE REMOVES ONLY WHAT THIS FUNCTION ADDED");
fresh();
// Ern's mapping changes: Edmark is dropped, Carla stays.
r = await withMap({ ...REAL_MAP, [ERN]: [CARLA] }, () => ghl.applyCaseManagers("o1", ERN));
console.log(`  -> removed=${JSON.stringify(r.removed)} followers=${JSON.stringify(followers())}`);
ok("Edmark is removed", !followers().includes(EDMARK), followers());
ok("Carla stays", followers().includes(CARLA), followers());
ok("🔴 AND THE HUMAN-ADDED CO-REP IS UNTOUCHED — never inferred from the live list",
   followers().includes(HUMAN_ADDED), followers());
ok("the field is rewritten to the one name", cf(CM_FIELD) === "Carla Winnigan", cf(CM_FIELD));
ok("⚠️ and the stored record now names only Carla", cf(CM_REC) === CARLA, cf(CM_REC));

console.log("\n2b · 🔴 AN ENTRY THAT IS DELIBERATELY EMPTY CLEARS — `[]` IS NOT `null`");
fresh();
r = await withMap({ ...REAL_MAP, [ERN]: [] }, () => ghl.applyCaseManagers("o1", ERN));
console.log(`  -> skipped=${r.skipped} removed=${JSON.stringify(r.removed)} field=${JSON.stringify(cf(CM_FIELD))}`);
ok("🔴 it does NOT skip — an empty entry is an instruction, not an absence",
   r.skipped === false, r);
ok("Carla is removed", !followers().includes(CARLA), followers());
ok("🔴 the co-rep is STILL untouched", followers().includes(HUMAN_ADDED), followers());
ok("the Case Manager field is cleared", cf(CM_FIELD) === "", cf(CM_FIELD));

console.log("\n2d · 🔴 A HUMAN-ADDED FOLLOWER WHO IS ALSO MAPPED — THE RECORD MUST NOT CLAIM THEM");
// 🔴 THE HOLE RULE B HAD, AND IT WAS REACHED THROUGH THE RECORD RATHER THAN
// THROUGH THE LIVE LIST — the one door rule B does not watch.
//
// The record used to store `want`: what the MAP says, not what this function
// ADDED. Those differ in exactly one case, and it takes three ordinary steps:
//
//   a human adds Carla to a case          she is following, and not ours
//   the mapping later GAINS Carla         `added` is empty (already following)
//                                         but `want` names her → recorded OURS
//   the mapping later DROPS Carla         `removed` reads that record …
//                                         🔴 … and takes away a human's follower
//
// ⚠️ The damage lands ONE RUN LATER THAN THE MISTAKE, when nothing on the case
// still shows who put Carla there. That is why it is proven across three applies
// rather than asserted on one.
reset(); fresh();
S.opps.o1.followers = [HUMAN_ADDED, CARLA];     // 🔴 a HUMAN put Carla on this case

// ── step one · Ern is mapped to Edmark alone. We add him; he is ours. ──────
r = await withMap({ [ERN]: [EDMARK] }, () => ghl.applyCaseManagers("o1", ERN));
console.log(`  step 1 · mapped [Edmark] -> added=${JSON.stringify(r.added)} record=${JSON.stringify(cf(CM_REC))}`);
ok("(setup) Edmark is added, and recorded as ours",
   r.added.join() === EDMARK && cf(CM_REC) === EDMARK, { added: r.added, rec: cf(CM_REC) });

// ── step two · THE MAPPING GAINS CARLA, who is already following. ─────────
fresh();
r = await withMap({ [ERN]: [CARLA, EDMARK] }, () => ghl.applyCaseManagers("o1", ERN));
console.log(`  step 2 · mapped [Carla,Edmark] -> added=${JSON.stringify(r.added)} record=${JSON.stringify(cf(CM_REC))}`);
ok("🔴 nothing is added — Carla is already following, by a human's hand",
   r.added.length === 0, r.added);
ok("🔴 SO THE RECORD MUST NOT NAME HER — it stores what we added, never what the map says",
   cf(CM_REC) === EDMARK, cf(CM_REC));
// ⚠️ THE TWO FIELDS DISAGREE ON PURPOSE, and somebody will one day try to make
// them match. The name field REPORTS THE MAP for a human to read; the record is
// this function's RECEIPT for what it may take back. Merging them re-opens the
// hole from the other side.
ok("⚠️ while the Case Manager NAME field DOES name her — that one reports the map",
   cf(CM_FIELD) === "Carla Winnigan, Edmark Villanueva", cf(CM_FIELD));

// ── step three · THE MAPPING DROPS HER AGAIN. The claim and its control. ──
fresh();
r = await withMap({ [ERN]: [ROI] }, () => ghl.applyCaseManagers("o1", ERN));
console.log(`  step 3 · mapped [Roi] -> removed=${JSON.stringify(r.removed)} followers=${JSON.stringify(followers())}`);
// 🔴 THE CONTROL FIRST, AND IT MUST PASS IN BOTH WORLDS. Without it "Carla
// survives" passes just as well when removal is broken outright and nobody is
// ever removed at all.
//
// ⚠️ AND IT IS DELIBERATELY ONLY "EDMARK GOES". My first version asserted
// `removed.join() === EDMARK` — "and nobody else" — which made the control FAIL
// against the pre-fix code too. A control that fails beside the claim proves
// nothing: in the broken run it left no evidence that removal worked at all,
// which is the one job it had. The "and nobody else" half is the CLAIM, below.
ok("🔴 THE CONTROL — Edmark, whom this function really did add, IS removed in the same call",
   !followers().includes(EDMARK) && r.removed.includes(EDMARK),
   { followers: followers(), removed: r.removed });
ok("🔴 THE CLAIM — Carla SURVIVES the mapping change. A human added her; she was never ours to take.",
   followers().includes(CARLA), followers());
ok("🔴 and she was never even a CANDIDATE for removal — not merely spared",
   !r.removed.includes(CARLA), r.removed);
ok("⚠️ Roi is added in his place", followers().includes(ROI), followers());
ok("⚠️ and the record now names Roi alone", cf(CM_REC) === ROI, cf(CM_REC));
ok("⚠️ the co-rep is untouched throughout, as in every other section",
   followers().includes(HUMAN_ADDED), followers());

}

if (SHAPE === "norecordfield") {
console.log("\n2c · 🔴 NO RECORD FIELD → ADD, BUT REMOVE NOTHING  (child process)");
reset(); fresh();
S.opps.o1.followers = [HUMAN_ADDED, EDMARK];   // as if a previous apply had added Edmark
r = await withMap({ ...REAL_MAP, [ERN]: [CARLA] }, () => ghl.applyCaseManagers("o1", ERN));
console.log(`  -> noRecordField=${r.noRecordField} added=${JSON.stringify(r.added)} removed=${JSON.stringify(r.removed)}`);
ok("it reports the missing field", r.noRecordField === true, r);
ok("Carla is still added — the add half does not need the record",
   followers().includes(CARLA), followers());
ok("🔴 and NOTHING is removed rather than guessing from the live followers",
   r.removed.length === 0 && followers().includes(EDMARK), { removed: r.removed, followers: followers() });
ok("⚠️ and it says so, rather than reporting a clean apply",
   r.steps.some((x) => /nothing was removed/.test(x)), r.steps);
console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed  (no-record-field shape)`);
server.close();
process.exit(fail ? 1 : 0);
}

console.log("\n═══ 3 · ⚠️ THE OWNER IS NEVER ADDED AS THEIR OWN FOLLOWER ═══");
reset(); fresh();
// A rep who is also somebody's manager, owning their own case.
r = await withMap({ [CARLA]: [CARLA, ROI] }, () => ghl.applyCaseManagers("o1", ERN));
ok("(control) Ern is unmapped here, so nothing happens", r.skipped === true, r);
reset(); fresh();
S.opps.o1.assignedTo = CARLA;
r = await withMap({ [CARLA]: [CARLA, ROI] }, () => ghl.applyCaseManagers("o1", CARLA));
console.log(`  -> added=${JSON.stringify(r.added)}`);
ok("🔴 Carla owns it and is her own manager — she is not added as a follower",
   !r.added.includes(CARLA), r.added);
ok("⚠️ but Roi still is", r.added.includes(ROI), r.added);
ok("⚠️ and the field still names both — the MAP is what it reports",
   cf(CM_FIELD) === "Carla Winnigan, Roi Navarte", cf(CM_FIELD));

console.log("\n═══ 4 · ⚠️ IT NEVER THROWS — A FAILED APPLY LEAVES THE OWNER CHANGE STANDING ═══");
reset(); fresh();
const realOpps = S.opps;
S.opps = {};                                   // the record vanishes mid-apply
r = await withMap(REAL_MAP, () => ghl.applyCaseManagers("o1", ERN));
S.opps = realOpps;
ok("🔴 it returns rather than throwing", r.skipped === true && !!r.why, r);
ok("⚠️ naming the failure", /could not be read back|failed/.test(r.why), r.why);

console.log("\n═══ 5 · 🔴 THE HOOK FIRES ONLY ON AN OWNER CHANGE ═══");
reset(); fresh();
await withMap(REAL_MAP, () => ghl.updateOpportunity("o1", { customFields: [{ id: OTHER, value: "Days" }] }));
console.log(`  a field save -> ${S.writes.length} write(s), followers ${JSON.stringify(followers())}`);
ok("🔴 an ordinary field save does NOT run the mapping",
   !S.writes.some((w) => w.what === "followers"), S.writes);
ok("⚠️ and the Case Manager field was not written either", cf(CM_FIELD) === null, cf(CM_FIELD));
fresh();
await withMap(REAL_MAP, () => ghl.updateOpportunity("o1", { assignedTo: ERN }));
console.log(`  an owner save -> followers ${JSON.stringify(followers())}`);
ok("🔴 THE CONTROL: an owner save DOES run it",
   followers().includes(CARLA) && followers().includes(EDMARK), followers());
ok("⚠️ through the panel's own write path, not a route", cf(CM_FIELD) === "Carla Winnigan, Edmark Villanueva", cf(CM_FIELD));

console.log("\n═══ 6 · ⚠️ AND WITH NO STORE AT ALL, NOTHING HAPPENS ═══");
// No `runWithCaseManagers` wrapper — what a route outside withGrants sees.
reset(); fresh();
r = await ghl.applyCaseManagers("o1", ERN);
ok("🔴 an unfilled store reads as unmapped — the feature is simply inert",
   r.skipped === true && S.writes.length === 0, { r, writes: S.writes });

console.log("\n═══ 7 · 🔴 ROUND 149 — CLIENT PIPELINES ONLY, AND THE MOVED CASE ═══");
// 🔴 THE CASE AN EARLY RETURN WOULD STRAND FOR EVER. A record gains managers on
// a client pipeline, is later moved to a caregiver one, and must LOSE them on
// arrival. `if (!client) return;` leaves them following a job applicant; routing
// through `mapped = null` removes them, because that is already what rule A
// means.

console.log("\n7a · (setup) A CLIENT CASE STILL GETS ITS MANAGERS");
// ⚠️ ALSO THE CONTROL FOR EVERYTHING BELOW. "Nothing is added on a caregiver
// pipeline" passes just as well when the whole rule is switched off.
reset(); fresh();
r = await withMap(REAL_MAP, () => ghl.applyCaseManagers("o1", ERN));
console.log(`  p1 (client) -> added=${JSON.stringify(r.added)} record=${JSON.stringify(cf(CM_REC))}`);
ok("🔴 THE CONTROL — on a client pipeline both managers are still added",
   followers().includes(CARLA) && followers().includes(EDMARK), followers());
ok("⚠️ and recorded as ours", cf(CM_REC) === `${CARLA},${EDMARK}`, cf(CM_REC));

console.log("\n7b · 🔴 THE MOVE — SAME RECORD, SAME OWNER, CAREGIVER PIPELINE");
fresh();
S.opps.o1.pipelineId = "p2";          // moved; the owner has not changed
r = await withMap(REAL_MAP, () => ghl.applyCaseManagers("o1", ERN));
console.log(`  p2 (caregiver) -> skipped=${r.skipped} removed=${JSON.stringify(r.removed)} followers=${JSON.stringify(followers())}`);
ok("🔴 THE CLAIM — the managers are REMOVED on arrival, not stranded",
   !followers().includes(CARLA) && !followers().includes(EDMARK), followers());
ok("🔴 it does NOT skip — there is a record of ours to undo",
   r.skipped === false, r);
ok("⚠️ and the human-added co-rep is untouched, as everywhere else",
   followers().includes(HUMAN_ADDED), followers());
ok("⚠️ our own record is cleared with them", cf(CM_REC) === "", cf(CM_REC));
ok("⚠️ and the Case Manager name field too", cf(CM_FIELD) === "", cf(CM_FIELD));

console.log("\n7c · 🔴 A CASE THAT WAS NEVER ON A CLIENT PIPELINE — NOT ONE WRITE");
// The common case once this ships: every applicant, every day. It must cost
// nothing and say why.
reset(); fresh();
S.opps.o1.pipelineId = "p2";
r = await withMap(REAL_MAP, () => ghl.applyCaseManagers("o1", ERN));
console.log(`  -> skipped=${r.skipped} "${r.why}"`);
ok("🔴 it skips", r.skipped === true, r);
ok("🔴 AND NOT ONE WRITE WAS SENT", !S.writes.some((w) => w.what === "followers" || w.what === "put"), S.writes);
// ⚠️ THE REASON IS DISTINGUISHABLE FROM "unmapped". Both arrive as
// `mapped === null`; one is 21 of 26 users and the other is a setting.
ok("🔴 and the reason names the PIPELINE, not the map",
   /not client-scoped/.test(r.why), r.why);
ok("⚠️ the co-rep is untouched and no field is written",
   followers().join() === HUMAN_ADDED && cf(CM_FIELD) === null,
   { f: followers(), cm: cf(CM_FIELD) });

console.log("\n7d · ⚠️ AND AN UNMAPPED OWNER ON A CLIENT PIPELINE STILL SAYS SO");
// The control for 7c's wording: if every skip said "not client-scoped" the
// assertion above would pass while the message had stopped meaning anything.
reset(); fresh();
r = await withMap(REAL_MAP, () => ghl.applyCaseManagers("o1", UNMAPPED));
console.log(`  -> "${r.why}"`);
ok("🔴 THE CONTROL — a client pipeline with an unmapped owner blames the MAP",
   /no entry in the map/.test(r.why) && !/client-scoped/.test(r.why), r.why);

// ── THE CHILD, for the shape this process cannot reach ────────────────────
console.log("\n═══ 2c · IN A CHILD PROCESS, BECAUSE THE FIELD LIST IS MEMOISED ═══");
let childOut = "";
let childOk = true;
try {
  childOut = execFileSync("npx", ["tsx", "scripts/task1-apply-proof.mjs"], {
    env: { ...process.env, SHAPE: "norecordfield" }, encoding: "utf8",
  });
} catch (e) {
  childOut = String(e.stdout || "") + String(e.stderr || "");
  childOk = false;
}
for (const line of childOut.split("\n"))
  if (/^\s{2}(ok|FAIL)|no-record-field shape|^2c ·/.test(line)) console.log(`  ${line.trim()}`);
ok("🔴 the no-record-field shape passes in its own process", childOk, childOut.slice(-600));

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed  (+ the child's)`);
server.close();
process.exit(fail ? 1 : 0);
