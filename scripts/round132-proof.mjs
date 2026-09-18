// ---------------------------------------------------------------------------
// ROUND 132 — CROSS-ACCOUNT TRANSFER.
//
// 🔴 ONE FAKE HOST, TWO TOKENS — BECAUSE THAT IS WHAT PRODUCTION IS.
//
// Both accounts live at services.leadconnectorhq.com and differ ONLY by token
// and locationId. A harness with two servers would prove the code can talk to
// two URLs, which is not the risk. The risk is a call addressed to the wrong
// COMPANY down the right URL — the whole reason `lib/peer.ts` exists as its own
// module — and only a fake that routes by TOKEN can catch it.
//
// ⚠️ AND THE FAKE ENFORCES WHAT GOHIGHLEVEL ENFORCES. A token scoped to one
// location genuinely cannot read another's records: those requests 401 and 404
// here exactly as they would live. Section C1 is that property, asserted.
// (Round 121's rule: a fake that answers something GoHighLevel would refuse is
// a harness bug, whether or not a test is red.)
//
// Run: npx tsx scripts/round132-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import CryptoJS from "crypto-js";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

// ═══════════════════════════════════════════════════════════════════════════
// PART A — translate(). PURE: no server is running yet, on purpose.
// ═══════════════════════════════════════════════════════════════════════════
const T = await import("../lib/transfer.ts");

const def = (id, name, dataType = "TEXT", options = []) => ({
  id, name, dataType, options, editable: true, parentId: "f1", position: 0,
});
const pdef = (id, name, dataType = "TEXT", options = []) => ({ id, name, dataType, options });

console.log("\n═══ PART A · TRANSLATE — THE HALF WITH NO CREDENTIAL IN SCOPE ═══");
console.log("\nA1 · 🔴 THE FOUR BUCKETS THE PROBE MEASURED, APPLIED TO ONE RECORD");

const selfDefs = [
  def("s_care", "Care Needs"),                                   // carries
  def("s_oltl", "OLTL Waiver Number"),                           // LOST — none there
  def("s_dupe", "FB Private Pay Form"),                           // AMBIGUOUS here
  def("s_dupe2", "FB Private Pay Form"),
  def("s_type", "Referral Type", "SINGLE_OPTIONS", ["A", "B"]),   // RETYPE there
  def("s_pay", "Pay Basis", "SINGLE_OPTIONS", ["PAID", "UNPAID", "STIPEND"]),
  def("s_live", "Living", "SINGLE_OPTIONS", ["LIVE_IN", "LIVE_OUT"]),
  def("s_empty", "Never Answered"),                               // held nothing
  def("s_amb2", "Shared Name"),                                   // AMBIGUOUS there
];
const peerDefs = [
  pdef("p_care", "care  needs"),                     // ⚠️ same name, different spacing/case
  pdef("p_type", "Referral Type", "TEXT"),           // a different KIND of field
  pdef("p_pay", "Pay Basis", "SINGLE_OPTIONS", ["PAID", "UNPAID"]),   // missing STIPEND
  pdef("p_live", "Living", "SINGLE_OPTIONS", ["LIVE_OUT"]),          // missing LIVE_IN
  pdef("p_amb2a", "Shared Name"),
  pdef("p_amb2b", "shared name"),
];
const values = {
  s_care: "Two visits a day",
  s_oltl: "W-99812",
  s_dupe: "yes",
  s_type: "A",
  s_pay: "PAID",        // 🔴 held value IS offered there, though STIPEND is not
  s_live: "LIVE_IN",    // 🔴 held value is NOT offered there
  s_empty: "",
  s_amb2: "x",
};
const r = T.translateFields({ model: "contact", values, selfDefs, peerDefs });
const why = (n) => r.skipped.find((s) => s.name === n)?.why;
console.log(`  carried: ${JSON.stringify(r.carried.map((c) => c.name))}`);
for (const s of r.skipped) console.log(`  skipped: ${s.name} — ${s.why}${s.detail ? ` (${s.detail})` : ""}`);

ok("a matching field carries, and carries the PEER's id",
   r.customFields.some((f) => f.id === "p_care" && f.value === "Two visits a day"), r.customFields);
ok("⚠️ matched across spacing and case — “Care Needs” to “care  needs”",
   r.carried.some((c) => c.name === "Care Needs" && c.to === "p_care"), r.carried);
ok("🔴 a field with no counterpart is SKIPPED AND NAMED, never a failure",
   why("OLTL Waiver Number") === "no counterpart", r.skipped);
ok("🔴 a name that is not unique HERE is skipped — a match there is a coin toss",
   why("FB Private Pay Form") === "the name is not unique", r.skipped);
ok("🔴 a name that is not unique THERE is skipped too",
   why("Shared Name") === "the name is not unique", r.skipped);
ok("⚠️ same name, different kind of field — skipped",
   why("Referral Type") === "a different kind of field", r.skipped);

console.log("\nA2 · 🔴 THE OPTIONS CHECK IS PER VALUE, NOT PER FIELD");
ok("🔴 “Pay Basis” CARRIES: the peer is missing STIPEND, but this record holds PAID",
   r.customFields.some((f) => f.id === "p_pay" && f.value === "PAID"), r.customFields);
ok("🔴 “Living” is SKIPPED: this record holds LIVE_IN and that code has no home there",
   why("Living") === "the value is not offered there", r.skipped);
ok("⚠️ and the message names the code and what IS offered",
   /LIVE_IN/.test(r.skipped.find((s) => s.name === "Living")?.detail || "") &&
   /LIVE_OUT/.test(r.skipped.find((s) => s.name === "Living")?.detail || ""),
   r.skipped.find((s) => s.name === "Living"));
ok("⚠️ a field this record never answered is not counted either way",
   !r.carried.some((c) => c.name === "Never Answered") &&
   !r.skipped.some((s) => s.name === "Never Answered"), r);

console.log("\nA3 · ⚠️ WHERE IT LANDS, AND WHERE IT REFUSES TO GUESS");
const peerPipes = [
  { id: "pp_wrong", name: "OLTL Enrollments", stages: [{ id: "w1", name: "TRANSFERRED IN", position: 0 }] },
  { id: "pp_nostage", name: "Private Pay Enrollment", stages: [{ id: "n1", name: "NEW LEAD", position: 0 }] },
  // 🔴 TRANSFERRED IN IS LAST IN THE ARRAY AND FIRST BY POSITION. If this were
  // found by array order the assertion would pass for the wrong reason.
  { id: "pp_right", name: "OLTL Enrollment", stages: [
    { id: "r2", name: "WAITING FOR DOCS", position: 2 },
    { id: "r1", name: "NEW LEAD", position: 1 },
    { id: "r0", name: "TRANSFERRED IN", position: 0 },
  ] },
];
const land = T.arrivalIn("OLTL Enrollment", peerPipes);
ok("the same pipeline BY NAME", !T.isRefusal(land) && land.pipelineId === "pp_right", land);
ok("🔴 at TRANSFERRED IN — not the stage it left, and not by array order",
   !T.isRefusal(land) && land.stageId === "r0", land);
const noPipe = T.arrivalIn("ODP Enrollment", peerPipes);
ok("🔴 a pipeline that does not exist there REFUSES — it does not pick the nearest",
   T.isRefusal(noPipe), noPipe);
ok("⚠️ and it says which pipelines that account has",
   T.isRefusal(noPipe) && /OLTL Enrollments/.test(noPipe.detail), noPipe);
const noStage = T.arrivalIn("Private Pay Enrollment", peerPipes);
ok("🔴 a pipeline with no arrival stage refuses rather than falling back",
   T.isRefusal(noStage) && /arrival stage/.test(noStage.error), noStage);
ok("⚠️ naming the stages it does have", T.isRefusal(noStage) && /NEW LEAD/.test(noStage.detail), noStage);

const selfPipes = [
  { id: "sp1", name: "OLTL Enrollment", stages: [{ id: "a", name: "NEW LEAD", position: 0 }] },
  { id: "sp_out", name: "Transferred Out", stages: [
    { id: "o2", name: "Gone", position: 1 }, { id: "o1", name: "Sent", position: 0 }] },
];
const out = T.departureFrom(selfPipes, "sp1");
ok("the source closes into a Transferred Out PIPELINE, at its first stage by position",
   !T.isRefusal(out) && out.pipelineId === "sp_out" && out.stageId === "o1", out);
const stageOnly = T.departureFrom(
  [{ id: "sp1", name: "OLTL Enrollment", stages: [
    { id: "a", name: "NEW LEAD", position: 0 }, { id: "b", name: "TRANSFERRED OUT", position: 9 }] }],
  "sp1",
);
ok("⚠️ or a Transferred Out STAGE, when that is how the account was set up",
   !T.isRefusal(stageOnly) && stageOnly.stageId === "b", stageOnly);
ok("🔴 and neither one means REFUSE — a transfer never deletes the source",
   T.isRefusal(T.departureFrom([{ id: "sp1", name: "X", stages: [] }], "sp1")), "it proceeded");

// ═══════════════════════════════════════════════════════════════════════════
// PART B/C — THE ROUTE, AGAINST TWO ACCOUNTS ON ONE HOST
// ═══════════════════════════════════════════════════════════════════════════
const SECRET = "harness_shared_secret";
const SELF_LOC = "loc_self", PEER_LOC = "loc_peer";
const SELF_TOK = "pit_self", PEER_TOK = "pit_peer";
const sso = (over) => CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: SELF_LOC,
  userName: "Chris Tester", email: "c@e.com", companyId: "co1", ...over,
}), SECRET).toString();
const ADMIN = sso();
const REP = sso({ userId: "u9", role: "user", type: "account", userName: "Rep" });

const HARM = "sf_harm", CARE = "sf_care", OLTL = "sf_oltl", LIVE = "sf_live";
const PEERID = "sf_peerid";
const PCARE = "pf_care", PLIVE = "pf_live";

let S;
/** Every request, with the account its token addresses. The call order IS a claim. */
let calls;
const reset = () => {
  calls = [];
  S = {
    fail: {},                       // { peerOpp: true } etc — the failure paths
    self: {
      loc: SELF_LOC,
      contactFields: [
        { id: CARE, name: "Care Needs", dataType: "TEXT" },
        { id: OLTL, name: "OLTL Waiver Number", dataType: "TEXT" },
        { id: LIVE, name: "Living", dataType: "SINGLE_OPTIONS", picklistOptions: ["LIVE_IN", "LIVE_OUT"] },
      ],
      oppFields: [
        { id: HARM, name: "Harmony ID", dataType: "TEXT" },
        { id: PEERID, name: "Peer Record Id", dataType: "TEXT" },
      ],
      pipelines: [
        { id: "sp_oltl", name: "OLTL Enrollment", stages: [
          { id: "sp_oltl_s0", name: "TRANSFERRED IN", position: 0 },
          { id: "sp_oltl_s2", name: "WAITING FOR DOCS", position: 2 }] },
        { id: "sp_out", name: "Transferred Out", stages: [{ id: "sp_out_s0", name: "Sent", position: 0 }] },
      ],
      contacts: { c1: { id: "c1", firstName: "Mary", lastName: "Malone", name: "Mary Malone",
        email: "mary@ex.com", phone: "610-555-0101", dateUpdated: "2026-09-01T10:00:00.000Z",
        customFields: [
          { id: CARE, value: "Two visits a day" },
          { id: OLTL, value: "W-99812" },
          { id: LIVE, value: "LIVE_IN" },
        ] } },
      opps: { o1: { id: "o1", name: "Mary Malone", pipelineId: "sp_oltl",
        pipelineStageId: "sp_oltl_s2", status: "open", assignedTo: "u1", monetaryValue: 4200,
        updatedAt: "2026-09-01T10:00:00.000Z", customFields: [{ id: HARM, fieldValue: "HRM-4821" }] } },
      contactOf: { o1: "c1" },
      notes: { c1: [{ id: "n1", body: "Called the discharge planner.", dateAdded: "2026-08-02T09:00:00.000Z" }] },
    },
    peer: {
      loc: PEER_LOC,
      contactFields: [
        { id: PCARE, name: "Care  Needs", dataType: "TEXT" },
        // ⚠️ LIVE_IN IS NOT OFFERED THERE. The value-level skip, end to end.
        { id: PLIVE, name: "Living", dataType: "SINGLE_OPTIONS", picklistOptions: ["LIVE_OUT"] },
      ],
      oppFields: [{ id: "pf_harm", name: "Harmony ID", dataType: "TEXT" }],
      pipelines: [
        { id: "pp_oltl", name: "OLTL Enrollment", stages: [
          { id: "pp_oltl_s2", name: "WAITING FOR DOCS", position: 2 },
          { id: "pp_oltl_s0", name: "TRANSFERRED IN", position: 0 }] },
      ],
      contacts: {},
      opps: {},
      contactOf: {},
      notes: {},
    },
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
    // ── WHICH ACCOUNT IS THIS TOKEN? ──────────────────────────────────────
    const tok = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const which = tok === SELF_TOK ? "self" : tok === PEER_TOK ? "peer" : null;
    if (!which) return send(401, { message: "invalid jwt" });
    const A = S[which];
    calls.push({ acct: which, method: req.method, path });

    // 🔴 A TOKEN CANNOT REACH THE OTHER LOCATION. GoHighLevel enforces this and
    // so does the fake: a call addressed to the wrong company must FAIL here,
    // or this harness could not tell a correct transfer from a catastrophic one.
    const named = q.get("locationId") || q.get("location_id") || j?.locationId ||
      (/^\/locations\/([^/]+)/.exec(path) || [])[1] || (/^\/users\/$/.test(path) ? A.loc : "");
    if (named && named !== A.loc)
      return send(401, { message: `token for ${A.loc} cannot access ${named}` });

    if (/^\/locations\/[^/]+\/customFields$/.test(path))
      return send(200, { customFields: q.get("model") === "opportunity" ? A.oppFields : A.contactFields });
    if (path === `/locations/${A.loc}/customValues`)
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({ seeded: true, folderNames: {},
          pipelines: Object.fromEntries(A.pipelines.map((p) => [p.id, { scope: "client", folders: [] }])) }) }] });
    if (path === "/users/") return send(200, { users: [{ id: "u1", name: "Chris Tester" }] });
    if (path === "/opportunities/pipelines") return send(200, { pipelines: A.pipelines });

    const withC = (o) => ({ ...o, contactId: A.contactOf[o.id], contact: A.contacts[A.contactOf[o.id]] });
    if (path === "/opportunities/search") {
      const pid = q.get("pipeline_id") || "", cid = q.get("contact_id") || "";
      let list = Object.values(A.opps);
      if (pid) list = list.filter((o) => o.pipelineId === pid);
      if (cid) list = list.filter((o) => A.contactOf[o.id] === cid);
      return send(200, { opportunities: list.map(withC), meta: { total: list.length } });
    }
    if (path === "/opportunities/" && req.method === "POST") {
      if (S.fail.peerOpp) return send(400, { message: "pipeline is not enabled for this user" });
      const id = `p_o${Object.keys(A.opps).length + 1}`;
      A.opps[id] = { id, ...j, updatedAt: new Date().toISOString() };
      A.contactOf[id] = j.contactId;
      return send(200, { opportunity: { id } });
    }
    if (/^\/opportunities\/[^/]+$/.test(path)) {
      const id = path.split("/")[2];
      const o = A.opps[id];
      if (!o) return send(404, { message: "not found" });   // the other account's record
      if (req.method === "PUT") {
        if (S.fail.selfClose && j.pipelineId) return send(400, { message: "pipeline permission denied" });
        A.opps[id] = { ...o, ...j, updatedAt: new Date().toISOString() };
        return send(200, { opportunity: withC(A.opps[id]) });
      }
      return send(200, { opportunity: withC(o) });
    }
    if (path === "/contacts/upsert" && req.method === "POST") {
      const hit = Object.values(A.contacts).find(
        (c) => (j.email && c.email === j.email) || (j.phone && c.phone === j.phone));
      const id = hit?.id || `p_c${Object.keys(A.contacts).length + 1}`;
      A.contacts[id] = { ...(hit || {}), id, ...j };
      return send(200, { contact: { id }, new: !hit });
    }
    // 🔴 THE ENDPOINT THE APP ACTUALLY USES. `GET /contacts/?query=` is a real
    // GoHighLevel route and is deliberately NOT handled here: the first version
    // of `peerFindContact` called it, this fake answered it, and the proof went
    // green on a shape nothing in this codebase has ever run live. A fake that
    // answers an invented call is worse than one that answers nothing.
    if (path === "/contacts/search" && req.method === "POST") {
      const needle = String(j?.query || "").toLowerCase();
      const hits = Object.values(A.contacts).filter((c) =>
        [c.email, c.phone, c.name].some((v) => String(v || "").toLowerCase() === needle));
      return send(200, { contacts: hits, total: hits.length });
    }
    if (/^\/contacts\/[^/]+\/notes$/.test(path)) {
      const id = path.split("/")[2];
      if (req.method === "POST") {
        (A.notes[id] ||= []).push({ id: `n${Date.now()}`, body: j.body, dateAdded: new Date().toISOString() });
        return send(200, { note: { id: "n_new" } });
      }
      return send(200, { notes: A.notes[id] || [] });
    }
    if (/^\/contacts\/[^/]+$/.test(path)) {
      const id = path.split("/")[2];
      const c = A.contacts[id];
      if (!c) return send(404, { message: "not found" });
      if (req.method === "PUT") { A.contacts[id] = { ...c, ...j }; return send(200, { contact: A.contacts[id] }); }
      return send(200, { contact: c });
    }
    send(404, { message: `no fake handler for ${req.url}` });
  });
});
reset();
await new Promise((r2) => server.listen(0, "127.0.0.1", r2));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = SELF_TOK;
process.env.GHL_LOCATION_ID = SELF_LOC;
process.env.GHL_SSO_SECRET = SECRET;
process.env.PIPELINE_IDS = "sp_oltl,sp_out";
process.env.PEER_PIT = PEER_TOK;
process.env.PEER_LOCATION_ID = PEER_LOC;
process.env.PEER_LABEL = "ODP Care";

const route = await import("../app/api/opportunities/[id]/transfer/route.ts");
const ghl = await import("../lib/ghl.ts");
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const pre = async (id, key = ADMIN) => {
  const res = await route.GET(new Request(`http://x/t/${id}`, {
    headers: { "x-ghl-sso-key": key } }), ctx(id));
  return { status: res.status, body: await res.json() };
};
const go = async (id, key = ADMIN) => {
  const res = await route.POST(new Request(`http://x/t/${id}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoKey: key, confirm: true }) }), ctx(id));
  return { status: res.status, body: await res.json() };
};
/**
 * Writes only — the question "what did this change" never includes a read.
 *
 * 🔴 AND A SEARCH IS A READ EVEN THOUGH IT IS A POST. GoHighLevel's contact and
 * opportunity searches take a body, so filtering on the HTTP verb alone would
 * call the preflight's lookups "writes" and make "the preflight wrote nothing"
 * fail for a reason that has nothing to do with writing. The property being
 * asserted is MUTATION, so that is what this matches.
 */
const writes = () => calls.filter((c) => c.method !== "GET" && !/\/search$/.test(c.path));

console.log("\n═══ PART B · THE PREFLIGHT ═══");
let p = await pre("o1");
console.log(`  lands: ${p.body.destination?.pipelineName} · ${p.body.destination?.stageName}`);
console.log(`  closes: ${p.body.closeTo?.label}`);
console.log(`  carried: ${JSON.stringify(p.body.parcel?.carried.map((c) => c.name))}`);
for (const s of p.body.parcel?.skipped || []) console.log(`  skipped: ${s.name} — ${s.why}`);
ok("the preflight answers", p.status === 200 && p.body.canTransfer === true, p);
ok("🔴 AND IT WROTE NOTHING — to either account", writes().length === 0, writes());
ok("⚠️ it read BOTH accounts", calls.some((c) => c.acct === "self") && calls.some((c) => c.acct === "peer"),
   [...new Set(calls.map((c) => c.acct))]);
ok("it lands at the peer's TRANSFERRED IN",
   p.body.destination?.pipelineName === "OLTL Enrollment" &&
   p.body.destination?.stageName === "TRANSFERRED IN", p.body.destination);
ok("and closes into this account's Transferred Out",
   /Transferred Out/.test(p.body.closeTo?.label || ""), p.body.closeTo);
ok("🔴 Care Needs carries and the OLTL field is named as skipped",
   p.body.parcel.carried.some((c) => c.name === "Care Needs") &&
   p.body.parcel.skipped.some((s) => s.name === "OLTL Waiver Number" && s.why === "no counterpart"),
   p.body.parcel);
ok("🔴 Living is skipped BY VALUE — LIVE_IN has no home there",
   p.body.parcel.skipped.some((s) => s.name === "Living" && s.why === "the value is not offered there"),
   p.body.parcel.skipped);
ok("⚠️ and the four things that can never follow are on the answer",
   (p.body.cannotFollow || []).length >= 4 &&
   p.body.cannotFollow.some((c) => /Conversation history/.test(c)) &&
   p.body.cannotFollow.some((c) => /attachments/i.test(c)), p.body.cannotFollow);

console.log("\n═══ PART C · THE WRITES ═══");
console.log("\nC1 · 🔴 NO CALL IS ADDRESSED TO THE WRONG COMPANY");
calls = [];
const done = await go("o1");
const seq = writes().map((c) => `${c.acct} ${c.method} ${c.path}`);
for (const s of done.body.steps || []) console.log(`  ${s}`);
ok("the transfer completes", done.status === 200 && done.body.ok === true, done.body);
ok("🔴 not one request 401'd — no token ever reached the other location",
   !JSON.stringify(done.body).includes("cannot access"), done.body);
ok("⚠️ the peer's record was created with the PEER token",
   writes().some((c) => c.acct === "peer" && c.path === "/opportunities/"), seq);
ok("⚠️ and this side's close used the SELF token",
   writes().some((c) => c.acct === "self" && /^\/opportunities\/o1$/.test(c.path)), seq);

console.log("\nC2 · 🔴 THE ORDER IS THE SAFETY PROPERTY");
console.log(`  ${seq.join("\n  ")}`);
const iUpsert = seq.findIndex((s) => s.includes("peer POST /contacts/upsert"));
const iOpp = seq.findIndex((s) => s === "peer POST /opportunities/");
const iClose = seq.findIndex((s) => s.startsWith("self PUT /opportunities/o1"));
ok("the person is created on the peer first", iUpsert >= 0 && iUpsert < iOpp, seq);
ok("then the case", iOpp >= 0 && iOpp < iClose, seq);
ok("🔴 AND THIS SIDE IS CLOSED LAST — never before the peer confirms",
   iClose === Math.max(iUpsert, iOpp, iClose), seq);

console.log("\nC3 · ⚠️ WHAT LANDED, AND WHAT WAS LEFT BEHIND");
const newOpp = Object.values(S.peer.opps)[0];
const newCon = Object.values(S.peer.contacts)[0];
ok("the case is on the peer at TRANSFERRED IN, not at the stage it left",
   newOpp?.pipelineStageId === "pp_oltl_s0", newOpp);
ok("⚠️ its value came across — native, so the field map could not have caught it",
   newOpp?.monetaryValue === 4200, newOpp);
ok("🔴 the source is in Transferred Out and STILL EXISTS — never deleted",
   S.self.opps.o1.pipelineId === "sp_out" && !!S.self.opps.o1, S.self.opps.o1);
ok("Care Needs arrived under the PEER's field id",
   (newCon?.customFields || []).some((f) => f.id === PCARE && f.value === "Two visits a day"),
   newCon?.customFields);
ok("🔴 Living did NOT arrive — writing LIVE_IN there would break their workflows with a 200",
   !(newCon?.customFields || []).some((f) => f.id === PLIVE), newCon?.customFields);
ok("⚠️ and no field kept a SELF id — every one was translated",
   !(newCon?.customFields || []).some((f) => [CARE, OLTL, LIVE].includes(f.id)),
   newCon?.customFields);
ok("the source note copied across", (S.peer.notes[newCon.id] || []).some((n) => /discharge planner/.test(n.body)),
   S.peer.notes[newCon.id]);
ok("🔴 a trail note on the peer names this side's id and what was NOT sent",
   (S.peer.notes[newCon.id] || []).some((n) => n.body.includes("o1") && /OLTL Waiver Number/.test(n.body)),
   S.peer.notes[newCon.id]);
ok("🔴 a trail note HERE names the peer's id",
   (S.self.notes.c1 || []).some((n) => n.body.includes(newOpp.id)), S.self.notes.c1);
ok("⚠️ and both notes say the conversation history did not follow",
   (S.peer.notes[newCon.id] || []).some((n) => /Conversation history/.test(n.body)) &&
   (S.self.notes.c1 || []).some((n) => /Conversation history/.test(n.body)), "one of them is silent");
ok("the peer's id is stored in “Peer Record Id” on this side",
   (S.self.opps.o1.customFields || []).some(
     (f) => (f.id === PEERID) && String(f.value ?? f.field_value) === newOpp.id),
   S.self.opps.o1.customFields);

console.log("\nC4 · 🔴 SENDING THE SAME PERSON TWICE — REFUSED, IN WORDS");
ghl.invalidateOpportunity?.("o1");
S.self.opps.o1.pipelineId = "sp_oltl";   // as if it had been moved back by hand
S.self.opps.o1.pipelineStageId = "sp_oltl_s2";
calls = [];
const again = await go("o1");
console.log(`  -> ${again.status} · ${again.body.error}`);
ok("it is refused, not 400'd as a fault", again.status === 409 && again.body.refusal === true, again.body);
ok("🔴 and the sentence says WHY — one case per person per pipeline",
   /one case per person per pipeline/i.test(again.body.detail || ""), again.body.detail);
ok("⚠️ naming their record over there", (again.body.detail || "").includes(newOpp.id), again.body.detail);
ok("🔴 NOTHING WAS WRITTEN — not even the contact upsert", writes().length === 0, writes());

console.log("\nC5 · 🔴 THE WORST CASE: THE PERSON LANDS, THE CASE DOES NOT");
reset();
S.fail.peerOpp = true;
ghl.invalidateOpportunity?.("o1");
calls = [];
const half = await go("o1");
for (const s of half.body.steps || []) console.log(`  ${s}`);
ok("it fails rather than reporting a save", half.status === 502, half.status);
ok("⚠️ marked partial, which is a different thing from a refusal",
   half.body.partial === true && !half.body.refusal, half.body);
ok("🔴 it names the contact now sitting over there with no case",
   !!half.body.peerContactId && (half.body.detail || "").includes(half.body.peerContactId), half.body);
ok("🔴 AND THIS SIDE IS UNTOUCHED — nothing has been lost",
   S.self.opps.o1.pipelineId === "sp_oltl" &&
   !writes().some((c) => c.acct === "self"), { pipe: S.self.opps.o1.pipelineId, w: writes() });
ok("⚠️ and it says the retry will update that person rather than duplicate them",
   /update that contact rather than duplicating/i.test(half.body.detail || ""), half.body.detail);

console.log("\nC6 · 🔴 BOTH LANDED, THIS SIDE WOULD NOT CLOSE");
reset();
S.fail.selfClose = true;
ghl.invalidateOpportunity?.("o1");
const stuck = await go("o1");
for (const s of stuck.body.steps || []) console.log(`  ${s}`);
const madeOpp = Object.values(S.peer.opps)[0];
ok("it fails, loudly", stuck.status === 502 && stuck.body.partial === true, stuck.status);
ok("🔴 it says the case now exists twice", /exists twice/i.test(stuck.body.error || ""), stuck.body.error);
ok("🔴 and names BOTH ids so somebody can go and fix it",
   (stuck.body.detail || "").includes("o1") && (stuck.body.detail || "").includes(madeOpp.id),
   stuck.body.detail);
ok("⚠️ and tells them where to move this one to", /Transferred Out/.test(stuck.body.detail || ""), stuck.body.detail);

console.log("\nC7 · ⚠️ WHO CAN, AND WHAT HAPPENS WITH NO PEER AT ALL");
reset();
ghl.invalidateOpportunity?.("o1");
calls = [];
const repTry = await go("o1", REP);
ok("a rep is refused", repTry.status === 403 && repTry.body.refusal === true, repTry.body);
// ⚠️ THE FIRST VERSION OF THIS ASSERTED `calls.length === 0` AND WAS WRONG
// ABOUT THE APP, not the app wrong. `withGrants` loads this account's own
// pipeline-access custom value before any handler runs — one GET, on THIS
// account, of THIS account's config, on every route in the app. The property
// that actually matters is the one below, and the loose version would have
// failed on a refactor that changed nothing about who may transfer.
ok("🔴 the OTHER COMPANY was never touched at all — not one read",
   !calls.some((c) => c.acct === "peer"), calls);
ok("🔴 and nothing anywhere was written", writes().length === 0, writes());
const savedPit = process.env.PEER_PIT;
delete process.env.PEER_PIT;
const noPeer = await pre("o1");
process.env.PEER_PIT = savedPit;
ok("with no peer configured it refuses in plain words, not a crash",
   noPeer.status === 503 && noPeer.body.refusal === true, noPeer.body);

console.log("\nC8 · 🔴 A PIPELINE THE OTHER ACCOUNT DOES NOT HAVE");
reset();
S.self.opps.o1.pipelineId = "sp_out";        // "Transferred Out" — no counterpart there
S.self.opps.o1.pipelineStageId = "sp_out_s0";
ghl.invalidateOpportunity?.("o1");
calls = [];
const nowhere = await go("o1");
console.log(`  -> ${nowhere.status} · ${nowhere.body.error}`);
ok("refused", nowhere.status === 409 && nowhere.body.refusal === true, nowhere.body);
ok("🔴 naming the pipeline and refusing to pick the nearest",
   /no “Transferred Out” pipeline over there/.test(nowhere.body.error || "") ||
   /Transferred Out/.test(nowhere.body.error || ""), nowhere.body.error);
ok("⚠️ and NOTHING was written", writes().length === 0, writes());

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
