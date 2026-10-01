// ---------------------------------------------------------------------------
// ROUND 170 — THREE BUGS FROM THE LIVE FULL TEST.
//
// 🔴 THE FAKE STORES THE SLOTS EXACTLY AS GIVEN, AND THAT IS THE LIVE FINDING.
// The comment that stood in `createCaregiverRelation` for forty rounds named two
// explanations that demanded opposite fixes — (a) GoHighLevel normalises the
// slots on create, or (b) the one correct-looking relation had been made from
// the caregiver's record. It is (b): linking from a CLIENT's panel produced
// `{"caregivers":0,"clients":1}` for that client. GoHighLevel normalises
// nothing.
//
// ⚠️ SO A FAKE THAT TIDIED THE SLOTS WOULD BE RULE 1 AGAIN — answering something
// GoHighLevel does not — and round 169 found the same shape one object over
// (round134's fake stored a name exactly as handed to it, where the real thing
// re-splits). A harness is wrong in both directions.
//
// Run: npx tsx scripts/round170-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import CryptoJS from "crypto-js";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const ASSOC = "assoc_cg";
const P_CLIENT = "pipe_oltl";
const P_CG = "pipe_oltl_cg";
const P_STAFF = "pipe_oltl_staff";
const RT = "F_RT";

const ADMIN = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Admin", email: "a@e.com", companyId: "co1",
}), SECRET).toString();

// ── the account ────────────────────────────────────────────────────────────
const contacts = {
  c_client: { id: "c_client", firstName: "Clara", lastName: "Client", customFields: [] },
  c_cg: { id: "c_cg", firstName: "Gavin", lastName: "Giver",
          customFields: [{ id: RT, value: "Caregiver" }] },
};
const opps = {
  // A CLIENT's case, and the caregiver applicant's own case — so the link can be
  // made from either panel and the proof can check both directions.
  o_client: { id: "o_client", name: "Clara Client", pipelineId: P_CLIENT,
              pipelineStageId: "c_s1", contactId: "c_client", assignedTo: "u1",
              status: "open", customFields: [] },
  o_cg: { id: "o_cg", name: "Gavin Giver", pipelineId: P_CG,
          pipelineStageId: "g_s1", contactId: "c_cg", assignedTo: "u1",
          status: "open", customFields: [] },
};
/** Relations, stored EXACTLY as posted. */
let relations = [];
let relSeq = 0;
let dupNext = false;   // make the next contact PUT collide, for §3

const cfg = JSON.stringify({
  seeded: true, folderNames: {},
  pipelines: {
    [P_CLIENT]: { scope: "client", folders: [] },
    [P_CG]: { scope: "caregiver", folders: [], group: "caregiver" },
    // 🔴 THE STAFF PIPELINE, AND ITS NAME MATCHES /oltl|chc/i TOO. Without it in
    // the fixture item 2 cannot fail, because there would be nothing wrong to
    // choose. It is caregiver-SCOPED and staff-GROUPED, which is exactly the
    // live shape: scope decides which picker lists it, group decides what kind
    // of recruit it holds.
    [P_STAFF]: { scope: "caregiver", folders: [], group: "staff" },
  },
});

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const j = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const send = (code, o) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };

    if (path === "/users/") return send(200, { users: [{ id: "u1", name: "Dana Ruiz" }] });
    if (path === `/locations/${LOC}/customValues`)
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders", value: cfg }] });
    if (path === `/locations/${LOC}/customFields`)
      return send(200, { customFields: /model=contact/.test(req.url)
        ? [{ id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS", picklistOptions: ["Caregiver"] }]
        : [] });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        { id: P_CLIENT, name: "OLTL Enrollment", stages: [{ id: "c_s1", name: "NEW LEAD", position: 0 }] },
        { id: P_CG, name: "OLTL Caregiver Applicants", stages: [{ id: "g_s1", name: "NEW", position: 0 }] },
        { id: P_STAFF, name: "OLTL Staff Applicants", stages: [{ id: "s_s1", name: "NEW", position: 0 }] },
      ] });
    if (path === "/opportunities/search") {
      const pid = url.searchParams.get("pipeline_id") || "";
      const rows = Object.values(opps).filter((o) => !pid || o.pipelineId === pid);
      return send(200, {
        opportunities: rows.map((o) => ({ ...o, contact: contacts[o.contactId] })),
        meta: { total: rows.length },
      });
    }
    if (/^\/opportunities\/[^/]+$/.test(path)) {
      const o = opps[path.split("/")[2]];
      if (!o) return send(404, { message: "not found" });
      return send(200, { opportunity: { ...o, contact: contacts[o.contactId] } });
    }

    // ── the association definition: GoHighLevel's own labels ───────────────
    if (path === `/associations/${ASSOC}`)
      return send(200, { association: {
        id: ASSOC, firstObjectLabel: "Caregiver", secondObjectLabel: "Client",
      } });

    // 🔴 STORED EXACTLY AS POSTED — no normalising. See the banner.
    if (path === "/associations/relations" && req.method === "POST") {
      const id = `rel${++relSeq}`;
      relations.push({
        id, associationId: j.associationId,
        firstRecordId: j.firstRecordId, secondRecordId: j.secondRecordId,
      });
      return send(200, { relation: { id } });
    }
    const relFor = /^\/associations\/relations\/([^/?]+)$/.exec(path);
    if (relFor && req.method === "GET") {
      const id = relFor[1];
      return send(200, {
        relations: relations.filter((r) => r.firstRecordId === id || r.secondRecordId === id),
      });
    }
    if (path === "/associations") return send(200, { associations: [] });

    if (/^\/contacts\/[^/]+$/.test(path)) {
      const id = path.split("/")[2];
      const c = contacts[id];
      if (!c) return send(404, { message: "not found" });
      if (req.method === "PUT") {
        // 🔴 GOHIGHLEVEL'S OWN 400, WORD FOR WORD FROM THE LIVE FAILURE.
        if (dupNext) {
          dupNext = false;
          return send(400, { message: "This location does not allow duplicated contacts." });
        }
        contacts[id] = { ...c, ...j };
        return send(200, { contact: contacts[id] });
      }
      return send(200, { contact: c });
    }
    if (/^\/contacts\/[^/]+\/notes/.test(path)) return send(200, { notes: [] });
    if (path === "/contacts/search") return send(200, { contacts: Object.values(contacts), total: 2 });
    return send(200, {});
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.GHL_SSO_SECRET = SECRET;
// ⚠️ `CAREGIVER_ASSOCIATION_ID`, WITH NO `GHL_` PREFIX. My first version wrote
// `GHL_CAREGIVER_ASSOCIATION_ID` by analogy with GHL_PIT and GHL_LOCATION_ID,
// and the route answered "Server is not configured" — rule 7 for the third time
// (GHL_SSO_KEY, MM_WEBHOOK_SECRET, and now this). An env var name in a harness
// is a guess until it is read from the code that consumes it: lib/ghl.ts:247.
process.env.CAREGIVER_ASSOCIATION_ID = ASSOC;
delete process.env.PIPELINE_ACCESS_MAP;
delete process.env.WEBHOOK_URL;

const G = await import("../lib/ghl.ts");
const cgRoute = await import("../app/api/opportunities/[id]/caregivers/route.ts");
const ctx = (id) => ({ params: Promise.resolve({ id }) });
const link = async (oppId, pickedContactId) => {
  const r = await cgRoute.POST(
    new Request(`http://x/api/opportunities/${oppId}/caregivers`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ssoKey: ADMIN, caregiverContactId: pickedContactId }),
    }),
    ctx(oppId),
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ═══════════════════════════════════════════════════════════════════════════
console.log("═══ 1 · 🔴 THE CAREGIVER GOES IN THE CAREGIVER SLOT ═══");
// ═══════════════════════════════════════════════════════════════════════════
console.log("\n1a · FROM THE CLIENT'S PANEL — the live failure");
const fromClient = await link("o_client", "c_cg");
ok("the link is created", fromClient.status === 200 && !!fromClient.body.relationId, fromClient.body);
ok("🔴 the CAREGIVER is in the caregiver slot (first, per the labels)",
  relations[0]?.firstRecordId === "c_cg", relations[0]);
ok("…and the CLIENT is in the client slot", relations[0]?.secondRecordId === "c_client", relations[0]);

// 🔴 THE ROUND TRIP, FROM BOTH SIDES. This is the assertion the live bug failed:
// the client's badge read {caregivers:0, clients:1}.
let clientCounts = await G.countCaregiverRelations("c_client");
let cgCounts = await G.countCaregiverRelations("c_cg");
console.log(`  client ${JSON.stringify(clientCounts)} · caregiver ${JSON.stringify(cgCounts)}`);
ok("🔴 the CLIENT's badge counts 1 caregiver and 0 clients",
  clientCounts.caregivers === 1 && clientCounts.clients === 0, clientCounts);
ok("🔴 the CAREGIVER's badge counts 1 client and 0 caregivers",
  cgCounts.clients === 1 && cgCounts.caregivers === 0, cgCounts);

console.log("\n1b · 🔴 FROM THE CAREGIVER'S PANEL — the other direction");
// ⚠️ THE OPEN RECORD IS THE CAREGIVER HERE, so the route's own argument naming
// used to be a lie: `a.contactId` is the caregiver, not the client. The side is
// decided from the PIPELINE, server-side, not from anything the browser sends.
relations = [];
const fromCg = await link("o_cg", "c_client");
ok("the link is created", fromCg.status === 200 && !!fromCg.body.relationId, fromCg.body);
ok("🔴 the caregiver is STILL in the caregiver slot",
  relations[0]?.firstRecordId === "c_cg", relations[0]);
ok("…and the client still in the client slot",
  relations[0]?.secondRecordId === "c_client", relations[0]);
clientCounts = await G.countCaregiverRelations("c_client");
cgCounts = await G.countCaregiverRelations("c_cg");
ok("🔴 both badges read the same as from the other panel",
  clientCounts.caregivers === 1 && clientCounts.clients === 0 &&
    cgCounts.clients === 1 && cgCounts.caregivers === 0,
  { client: clientCounts, caregiver: cgCounts });

// ⚠️ THE CONTROL FOR THE DIRECTION SOURCE. `createCaregiverRelation` places by
// `getAssociationDirection`, so an association whose labels are the other way
// round must place the other way round — otherwise "uses the labels" is
// satisfied by a hardcoded order that happens to match this fixture.
console.log("\n1c · 🔴 CONTROL — the labels decide, not a hardcoded order");
ok("the fixture's caregiver slot really is FIRST",
  (await G.getAssociationDirection()).firstIsCaregiver === true);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 2 · 🔴 OLTL APPLICANTS DO NOT LAND IN STAFF ═══");
// ═══════════════════════════════════════════════════════════════════════════
const { pipelineForDivision } = await import("../lib/caregiverIntake.ts");
const ALL = [
  { id: P_CG, name: "OLTL Caregiver Applicants", group: "caregiver" },
  { id: P_STAFF, name: "OLTL Staff Applicants", group: "staff" },
];
// ⚠️ STAFF FIRST IN THE LIST, DELIBERATELY. The old code took the first regex
// hit in config order, so a fixture listing the caregiver pipeline first would
// pass against the bug.
const STAFF_FIRST = [ALL[1], ALL[0]];

let r170 = pipelineForDivision("OLTL_CHC", STAFF_FIRST);
console.log(`  OLTL_CHC -> ${JSON.stringify(r170.pipelines.map((p) => p.name))}`);
ok("🔴 OLTL_CHC lands in OLTL Caregiver Applicants",
  r170.pipelines.length === 1 && r170.pipelines[0].id === P_CG,
  r170.pipelines.map((p) => p.name));
ok("🔴 …even with the STAFF pipeline listed first",
  !r170.pipelines.some((p) => p.id === P_STAFF), r170.pipelines.map((p) => p.name));

// 🔴 NO DIVISION MAY EVER CHOOSE A STAFF PIPELINE. Stated over every division
// rather than for the one that broke — the rule is about the group, not OLTL.
ok("🔴 no division chooses a staff pipeline, for any division",
  ["PRIVATE_PAY", "ODP", "OLTL_CHC"].every((d) =>
    !pipelineForDivision(d, [
      { id: P_STAFF, name: "OLTL Staff Applicants", group: "staff" },
      { id: "pp_staff", name: "PP Staff Applicants", group: "staff" },
      { id: "odp_staff", name: "ODP Staff Applicants", group: "staff" },
    ]).pipelines.length));

// ⚠️ AND IT SAYS WHY, rather than "no pipeline matches" on an account that
// visibly has an OLTL pipeline.
const staffOnly = pipelineForDivision("OLTL_CHC", [
  { id: P_STAFF, name: "OLTL Staff Applicants", group: "staff" },
]);
ok("⚠️ when only a staff pipeline matches, the reason names it",
  /STAFF pipeline/.test(staffOnly.why) && /OLTL Staff Applicants/.test(staffOnly.why),
  staffOnly.why);

// 🔴 THE CONTROL: group absent means caregiver, which is the pre-round-120
// default. Without this, "excludes staff" would be satisfied by excluding
// everything that does not say "caregiver".
ok("🔴 CONTROL — a pipeline with NO group is still eligible",
  pipelineForDivision("ODP", [{ id: "x", name: "ODP Caregiver Applicants" }]).pipelines.length === 1);
ok("🔴 CONTROL — a caregiver-grouped pipeline is still chosen",
  pipelineForDivision("ODP", [{ id: "y", name: "ODP Caregiver Applicants", group: "caregiver" }])
    .pipelines.length === 1);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 3 · 🔴 A PHONE THAT BELONGS TO SOMEBODY ELSE ═══");
// ═══════════════════════════════════════════════════════════════════════════
const cfRoute = await import("../app/api/contacts/[id]/fields/route.ts");
const patch = async (oppId, body) => {
  const r = await cfRoute.PATCH(
    new Request(`http://x/api/contacts/${oppId}/fields`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ssoKey: ADMIN, ...body }),
    }),
    ctx(oppId),
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

dupNext = true;
let dup = await patch("o_client", { phone: "610-555-0199" });
console.log(`  -> ${dup.status} · ${dup.body.error}`);
ok("🔴 the phone collision names the PHONE",
  /That phone number already belongs to another person/.test(dup.body.error || ""), dup.body.error);
ok("…and says nothing was changed",
  /Nothing was changed/.test(dup.body.error || ""), dup.body.error);
ok("🔴 GoHighLevel's raw wording is NOT what the rep reads",
  !/PUT|location does not allow|400/.test(dup.body.error || ""), dup.body.error);
ok("⚠️ …but it is kept as the detail, for whoever they forward it to",
  /does not allow duplicated contacts/.test(dup.body.detail || ""), dup.body.detail);
ok("a collision is a 409, not a 502 — it is the account's rule, not a fault",
  dup.status === 409, dup.status);

dupNext = true;
dup = await patch("o_client", { email: "taken@example.com" });
ok("🔴 the same for an EMAIL, naming the email",
  /That email address already belongs to another person/.test(dup.body.error || ""), dup.body.error);

// 🔴 THE CONTROL. "Names the phone" is satisfied by always saying phone.
dupNext = true;
dup = await patch("o_client", { phone: "610-555-0111", email: "both@example.com" });
ok("🔴 CONTROL — with BOTH sent it names both, because GoHighLevel does not say which",
  /phone number or email address/.test(dup.body.error || ""), dup.body.error);

// ⚠️ AND THE GENERIC MAPPING, for every other route that hits the same rule.
const genericE = new G.GhlError("GoHighLevel returned 400 for POST /contacts/", 400,
  "This location does not allow duplicated contacts.");
const generic = await G.explainGhlError(genericE);
ok("⚠️ explainGhlError covers every OTHER caller too",
  /already belongs to another person/.test(generic) && /Nothing was changed/.test(generic),
  generic);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 4 · THE WEBHOOK NAMES THE OWNER ═══");
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ 21 OF 26 USERS ARE UNMAPPED, so this is the most common line in the
// webhook log. It said "that owner has no entry in the map" — nothing anybody
// could act on. The NAME is who to ask; the ID is what the map is keyed on.
const { runWithGrants } = await import("../lib/pipelineAccess.ts").then((m) => ({
  runWithGrants: m.runWithCaseManagers,
})).catch(() => ({ runWithGrants: null }));
let why = "";
if (runWithGrants) {
  await runWithGrants(new Map(), async () => {
    const res = await G.applyCaseManagers("o_client", "u1");
    why = res.why;
  });
} else {
  const res = await G.applyCaseManagers("o_client", "u1");
  why = res.why;
}
console.log(`  why: ${why}`);
ok("🔴 the owner's NAME is in the message", /Dana Ruiz/.test(why), why);
ok("🔴 …and their ID beside it", /u1/.test(why), why);
ok("…and it still says nothing was added", /added nothing/.test(why), why);

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
