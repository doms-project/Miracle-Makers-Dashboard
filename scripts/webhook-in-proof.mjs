// ---------------------------------------------------------------------------
// ROUND 150 — THE INBOUND WEBHOOK, AND THE THREE SHAPES THAT ARRIVE AT IT.
//
// 🔴 THE CONTROL IS THE WHOLE FILE, AND THE BRIEF NAMED IT: "a well-formed
// payload accepted, a malformed one 202'd with its reason named, AND the
// field-name-map shape specifically, all in the same run."
//
// "It refuses odd payloads" is satisfied by a handler that refuses everything,
// which is exactly what this used to be — five rounds of logging and no-oping.
// So every refusal below sits beside a payload that DOES act, in the same run,
// against the same fake.
//
// ⚠️ THE THREE SHAPES ARE REAL, captured from the live account:
//
//   workflow    contact_id · id · pipeline_id · pipleline_stage · user{} ·
//               owner · location{} · workflow{}          — and NO user id
//   native      type: "OpportunityStageUpdate" · locationId · assignedTo
//   field map   a flat map of custom-field display NAMES to empty strings,
//               with no standard key at all
//
// Run: npx tsx scripts/webhook-in-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
const SECRET = "hook_secret";
const CM_FIELD = "f_cm", CM_REC = "f_cmrec";
const ERN = "u_ern", CARLA = "u_carla", EDMARK = "u_edmark";
const PP = "pipe_pp", APPS = "pipe_apps";

/** Every request the fake saw, so "did it write" is read, not assumed. */
let seen = [];
let opp, contactOwner;
/** 🔴 ROUND 151 — GoHighLevel accepts the follower POST and stores nothing. */
let refuseFollowers = false;
/** 🔴 ROUND 151 — and the DELETE half, which does NOT throw: see 8c. */
let refuseRemoveFollowers = false;
const reset = () => {
  seen = [];
  refuseFollowers = false;
  refuseRemoveFollowers = false;
  contactOwner = ERN;
  opp = {
    id: "o1", name: "New Lead", pipelineId: PP, pipelineStageId: "pp_s1",
    status: "open", assignedTo: "", contactId: "c1",
    updatedAt: "2026-09-01T10:00:00.000Z", followers: [], customFields: [],
  };
};
reset();

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const j = raw ? JSON.parse(raw) : null;
    const [path, qs] = req.url.split("?");
    const q = new URLSearchParams(qs || "");
    seen.push({ method: req.method, path, body: j });
    const send = (code, o) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (path === `/locations/${LOC}/customFields`)
      return send(200, { customFields: q.get("model") === "opportunity"
        ? [{ id: CM_FIELD, name: "Case Manager", dataType: "TEXT" },
           { id: CM_REC, name: "Case Manager Followers", dataType: "TEXT" }]
        : [] });
    if (path === "/users/")
      return send(200, { users: [
        { id: ERN, name: "Ern Holden" }, { id: CARLA, name: "Carla Winnigan" },
        { id: EDMARK, name: "Edmark Villanueva" },
      ] });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        { id: PP, name: "Private Pay Clients", stages: [{ id: "pp_s1", name: "NEW ENQUIRY", position: 0 }] },
        { id: APPS, name: "Private Pay Caregiver Applicants", stages: [{ id: "ap_s1", name: "New Applicant", position: 0 }] },
      ] });
    if (path === `/locations/${LOC}/customValues`)
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Folders", value: JSON.stringify({
            seeded: true, folderNames: {},
            pipelines: { [PP]: { scope: "client", folders: [] },
                         [APPS]: { scope: "caregiver", folders: [], group: "caregiver" } },
          }) },
        { id: "cv2", name: "MM Pipeline Access", value: JSON.stringify({
            pipelines: {}, folders: {}, master: [],
            caseManagers: { [ERN]: [CARLA, EDMARK] },
          }) },
      ] });
    // 🔴 THE CONTACT CARRIES THE OWNER; THE OPPORTUNITY DOES NOT. That is the
    // live shape — the workflow's Assign step writes the contact owner and
    // leaves the opportunity unassigned — and a handler reading the opportunity
    // would find nothing on every form-created lead.
    if (/^\/contacts\/[^/]+$/.test(path))
      return send(200, { contact: { id: "c1", firstName: "New", lastName: "Lead",
        assignedTo: contactOwner, dateUpdated: "2026-09-01T10:00:00.000Z", customFields: [] } });
    if (path === "/opportunities/search")
      return send(200, { opportunities: [opp], meta: { total: 1 } });
    if (path === `/opportunities/${opp.id}/followers`) {
      const ids = (j?.followers || []).filter(Boolean);
      // 🔴 ROUND 151 — the live silent refusal: 200, and nothing stored. See
      // scripts/task1-apply-proof.mjs section 8 for the probe this came from.
      if (req.method === "POST" && refuseFollowers)
        return send(200, { followers: [], followersAdded: [[]] });
      if (req.method === "POST") {
        opp.followers = [...new Set([...opp.followers, ...ids])];
        return send(200, { followersAdded: [ids] });
      }
      if (refuseRemoveFollowers) return send(200, { followers: [], followersAdded: [[]] });
      opp.followers = opp.followers.filter((f) => !ids.includes(f));
      return send(200, { followers: opp.followers });
    }
    if (path === `/opportunities/${opp.id}`) {
      if (req.method === "PUT") {
        for (const f of j.customFields || []) {
          const at = opp.customFields.findIndex((x) => x.id === f.id);
          if (at >= 0) opp.customFields[at] = { id: f.id, fieldValue: f.value };
          else opp.customFields.push({ id: f.id, fieldValue: f.value });
        }
        return send(200, { opportunity: opp });
      }
      return send(200, { opportunity: opp });
    }
    send(404, { message: `no fake handler for ${req.method} ${path}` });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.PIPELINE_IDS = `${PP}`;
// ⚠️ `WEBHOOK_SECRET`, NOT a guessed name — verifyInbound reads config()?.secret
// or this env var (lib/webhooks.ts:151). A wrong name means "no secret
// configured", which verifyInbound refuses outright, and every assertion below
// would have gone red against a working handler. Same family as the
// GHL_SSO_SECRET mistake.
process.env.WEBHOOK_SECRET = SECRET;

const route = await import("../app/api/webhooks/ghl/route.ts");
const W = await import("../lib/webhooks.ts");

/** POST a payload with whatever credential lib/webhooks actually verifies. */
const post = async (payload, { secret = SECRET } = {}) => {
  const raw = JSON.stringify(payload);
  const res = await route.POST(
    new Request("http://x/api/webhooks/ghl", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mm-secret": secret },
      body: raw,
    }),
  );
  return { status: res.status, body: await res.json() };
};
const cf = (id) => opp.customFields.find((f) => f.id === id)?.fieldValue ?? null;

// ── THE THREE REAL PAYLOADS ───────────────────────────────────────────────
const WORKFLOW = {
  contact_id: "c1", id: "o1", pipeline_id: PP, pipeline_name: "Private Pay Clients",
  pipleline_stage: "NEW ENQUIRY",            // ⚠️ GHL's typo, matched deliberately
  contact_source: "Facebook", status: "open", opportunity_name: "New Lead",
  user: { firstName: "Ern", lastName: "Holden -Sale", email: "ern@mail.com" },
  owner: "Ern Holden -Sale",                  // 🔴 a display string; no user id
  location: { id: LOC, name: "Miracle Makers" },
  workflow: { id: "9df0db82", name: "Notification Workflow — OLTL" },
};
const NATIVE = {
  type: "OpportunityStageUpdate", id: "o1", locationId: LOC,
  pipelineId: PP, pipelineStageId: "pp_s1", assignedTo: ERN, contactId: "c1",
  status: "open",
};
const FIELD_MAP = {
  "Thursday End": "", "CG - FBI Check Required": "", "UTM Medium": "",
  "Partner Division": "", "Form Name": "", "Case Type": "",
};

console.log("\n═══ 1 · 🔴 THE CONTROL — A WELL-FORMED PAYLOAD ACTS ═══");
// Without this every refusal below is satisfied by a handler that refuses
// everything — which is precisely what this route was for five rounds.
reset();
let r = await post(WORKFLOW);
console.log(`  -> ${r.status} acted=${r.body.acted} "${r.body.reason}"`);
console.log(`  followers: ${JSON.stringify(opp.followers)}`);
ok("🔴 THE CONTROL — it ACTED", r.body.acted === true, r.body);
ok("🔴 both of Ern's case managers now follow the case",
   opp.followers.includes(CARLA) && opp.followers.includes(EDMARK), opp.followers);
ok("⚠️ the Case Manager field holds their names",
   cf(CM_FIELD) === "Carla Winnigan, Edmark Villanueva", cf(CM_FIELD));
ok("⚠️ and rule B's own record holds their ids", cf(CM_REC) === `${CARLA},${EDMARK}`, cf(CM_REC));
// 🔴 THE OWNER CAME FROM THE CONTACT. The payload carries no user id at all, so
// if this worked from the payload it would be working by accident.
ok("🔴 it read the CONTACT to find the owner — the payload has no user id",
   seen.some((s) => s.method === "GET" && /^\/contacts\/c1$/.test(s.path)),
   seen.map((s) => `${s.method} ${s.path}`));
ok("⚠️ 202, not 200 — GoHighLevel retries anything else", r.status === 202, r.status);

console.log("\n═══ 2 · 🔴 THE NATIVE STAGE EVENT — RECOGNISED, NOT ACTED ON ═══");
reset();
r = await post(NATIVE);
console.log(`  -> ${r.status} acted=${r.body.acted} "${r.body.reason}"`);
ok("🔴 it does NOT act — the recorder is not built", r.body.acted === false, r.body);
ok("🔴 and it is RECOGNISED, not lumped in with the unreadable ones",
   /OpportunityStageUpdate/.test(r.body.reason), r.body.reason);
ok("⚠️ the reason says why: there is nowhere to write a transition",
   /not recorded yet|single value, not a log/.test(r.body.reason), r.body.reason);
ok("🔴 and NOT ONE WRITE was sent", !seen.some((s) => s.method !== "GET"), seen.map((s) => `${s.method} ${s.path}`));
// ⚠️ IT HAS contactId AND assignedTo, so a handler that only looked for those
// would have applied case managers to a stage change. The branch is what stops
// that, and this assertion is what would notice if the branch were removed.
ok("🔴 it did not fall through to the case-manager path despite carrying contactId",
   !seen.some((s) => /^\/contacts\//.test(s.path)), seen.map((s) => s.path));

console.log("\n═══ 3 · 🔴 THE FIELD-NAME MAP — THE FOURTH LINE IN THE LOG ═══");
reset();
r = await post(FIELD_MAP);
console.log(`  -> ${r.status} "${r.body.reason}"`);
ok("202, not an error — a retry would not fix it", r.status === 202, r.status);
ok("🔴 it names the reason: no contact_id", /no contact_id/.test(r.body.reason), r.body.reason);
ok("⚠️ and how many keys it did have, so the shape is identifiable",
   /6 top-level key/.test(r.body.reason), r.body.reason);
ok("🔴 NOT ONE WRITE, and not even a contact read",
   seen.length === 0, seen.map((s) => `${s.method} ${s.path}`));

console.log("\n═══ 4 · 🔴 THE WRONG ACCOUNT IS REFUSED ═══");
// Two deployments share this code. A Webhook action pointed at the wrong URL
// would otherwise add one company's case managers to another company's record.
reset();
r = await post({ ...WORKFLOW, location: { id: "loc_other" } });
console.log(`  -> ${r.status} "${r.body.reason}"`);
ok("🔴 refused", r.body.acted === false, r.body);
ok("⚠️ naming both locations", /loc_other/.test(r.body.reason) && /loc_test/.test(r.body.reason), r.body.reason);
ok("🔴 and nothing was read or written", seen.length === 0, seen.map((s) => s.path));

console.log("\n═══ 5 · ⚠️ A CONTACT WITH NO OWNER — 202, NAMED, NO GUESS ═══");
reset();
contactOwner = "";
r = await post(WORKFLOW);
console.log(`  -> ${r.status} "${r.body.reason}"`);
ok("🔴 it does not guess an owner from `user` or `owner`",
   r.body.acted === false && /no owner/.test(r.body.reason), r.body);
ok("⚠️ and no follower write was attempted",
   !seen.some((s) => /followers/.test(s.path)), seen.map((s) => s.path));

console.log("\n═══ 6 · 🔴 ROUND 149 STILL DECIDES THE PIPELINE, NOT THE HANDLER ═══");
// The handler deliberately carries no pipeline test — a second copy would be a
// second thing to keep in step. So a caregiver-pipeline event must be declined
// by applyCaseManagers itself, reached through the webhook.
reset();
opp.pipelineId = APPS;
r = await post(WORKFLOW);
console.log(`  -> acted=${r.body.acted} "${r.body.reason}"`);
ok("🔴 a caregiver-pipeline event adds nobody", opp.followers.length === 0, opp.followers);
ok("🔴 and the reason comes from the RULE, naming the pipeline",
   /not client-scoped/.test(r.body.reason), r.body.reason);
// ⚠️ THE COST, ASSERTED SO IT IS A CHOICE AND NOT A SURPRISE: one contact GET
// before the decline. That is the price of having one copy of the test.
ok("⚠️ it cost one contact read to get there — the stated trade",
   seen.filter((s) => /^\/contacts\/c1$/.test(s.path)).length === 1,
   seen.map((s) => s.path));

console.log("\n═══ 7 · 🔴 A BAD SECRET IS 401, AND THAT IS NOT A 202 ═══");
reset();
r = await post(WORKFLOW, { secret: "wrong" });
console.log(`  -> ${r.status}`);
ok("🔴 401 — the one status that is NOT 202", r.status === 401, r.status);
ok("🔴 and nothing was read", seen.length === 0, seen.map((s) => s.path));
// ⚠️ THE CONTROL FOR THE CONTROL. If verifyInbound were a no-op, every
// assertion in this file would pass while the endpoint was open to anyone.
ok("🔴 THE CONTROL — the same payload with the right secret DOES act",
   (await (async () => { reset(); const g = await post(WORKFLOW); return g.body.acted; })()) === true,
   "the right secret was refused too — verifyInbound may be rejecting everything");

console.log("\n═══ 8 · 🔴 ROUND 151 — `ACTED` MUST NOT SURVIVE A SILENT REFUSAL ═══");
// 🔴 THE CONSUMER SIDE OF `mismatch`. The read-back has caught this since task
// 1, but only in the log: `applyCaseManagers` returned `skipped:false` with a
// full `added` array, so this handler printed `ACTED — +2 manager(s)` while
// GoHighLevel had stored none of them. That is the line under test.
reset();
refuseFollowers = true;
r = await post(WORKFLOW);
console.log(`  -> ${r.status} acted=${r.body.acted} "${String(r.body.reason).slice(0, 78)}…"`);
ok("🔴 it does NOT report ACTED", r.body.acted === false, r.body);
// ⚠️ THIS ASSERTION WAS WRONG FIRST TIME AND THE CODE WAS RIGHT. I looked for
// the `mismatch` wording; a refused ADD THROWS, so it takes the skipped path
// and carries the cause in `why` instead. The two arms are different on
// purpose — 8b is the throw, 8c below is the mismatch — and what matters for
// both is that the sharing setting is named rather than "nothing to do".
ok("🔴 and the reason names the CAUSE, not a bare 'nothing to do'",
   /shared with selected users/.test(r.body.reason || ""), r.body.reason);
ok("⚠️ still a 202 — a retry cannot fix a sharing setting", r.status === 202, r.status);
ok("nobody is following", !opp.followers.includes(CARLA), opp.followers);

console.log("\n8c · 🔴 THE REFUSED REMOVE — THE `mismatch` BRANCH ITSELF");
// The add throws; the remove does not, so this is the only path that reaches
// the handler's `if (r.mismatch)` arm. Two steps: apply normally, then take the
// owner off the map so the managers must come off, and refuse the DELETE.
reset();
r = await post(WORKFLOW);
console.log(`  step 1 · acted=${r.body.acted} followers=${JSON.stringify(opp.followers)}`);
contactOwner = "u_unmapped";       // rule A: no entry, but our record names two
refuseRemoveFollowers = true;
r = await post(WORKFLOW);
console.log(`  step 2 · acted=${r.body.acted} "${String(r.body.reason).slice(0, 72)}…"`);
ok("🔴 it does NOT report ACTED on a removal that did not take",
   r.body.acted === false, r.body);
ok("🔴 and the reason says the record DISAGREES — the mismatch arm",
   /disagrees|NOT applied/.test(r.body.reason || ""), r.body.reason);
ok("they are both still following, which is what made it a mismatch",
   opp.followers.includes(CARLA) && opp.followers.includes(EDMARK), opp.followers);
ok("🔴 AND THE RECORD STILL CLAIMS THEM — they stay removable next run",
   (cf(CM_REC) || "").includes(EDMARK), cf(CM_REC));
// ⚠️ THE CONTROL, in the same run: the refusal is what changed the answer, not
// a handler that has stopped acting on anything.
reset();
r = await post(WORKFLOW);
ok("🔴 THE CONTROL — the same payload without the refusal still ACTS",
   r.body.acted === true && opp.followers.includes(CARLA), r.body);

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
