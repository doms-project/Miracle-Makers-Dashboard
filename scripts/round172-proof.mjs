// ---------------------------------------------------------------------------
// ROUND 172 — THE CAREGIVERS PICKER, DELIBERATELY.
//
// 🔴 THE FIXTURE'S SHAPE IS THE LIVE SHAPE, AND IT IS WHAT MAKES THE OLD BUG
// REPRODUCIBLE. Probed 1 October: of 120 contacts holding a client case, 118
// carry NO Record Type. So the clients here carry none — and the old picker's
// fallback (`filtered.length ? filtered : contacts`) fired on exactly that,
// returning every match when none of them was a caregiver.
//
// ⚠️ A FIXTURE WHERE EVERY CLIENT WAS LABELLED "Client" WOULD PASS AGAINST THE
// BUG. The fallback only triggers when nothing matches, so a tidy fixture never
// reaches it: the filter would appear to work while the live account walked
// straight into the branch that shows everybody. Rule 3, and rule 2.
//
// 🔴 AND ONE CONTACT CARRIES "Caregiver" IN A FIELD THAT IS NOT Record Type.
// The old test scanned every custom field for the string; Attendee Profile is
// free text and "Caregiver" is an obvious thing to type in it. Without that
// contact in the fixture, "filters on Record Type specifically" cannot fail.
//
// Run: npx tsx scripts/round172-proof.mjs
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
const P_CLIENT = "pipe_oltl";       // client scope
const P_CG = "pipe_cg";             // caregiver scope
const RT = "F_RT";                  // Record Type
const PROFILE = "F_PROFILE";        // Attendee Profile — free text
const REP = "u_rep";                // holds the CLIENT pipeline and no applicant one
const ADMIN_ID = "u1";

const blob = (userId, role, type) => CryptoJS.AES.encrypt(JSON.stringify({
  userId, role, type, activeLocation: LOC,
  userName: userId, email: `${userId}@e.com`, companyId: "co1",
}), SECRET).toString();
const ADMIN = blob(ADMIN_ID, "admin", "agency");
const REP_SSO = blob(REP, "user", "location");

// ── the account ────────────────────────────────────────────────────────────
const contacts = {
  // 🔴 A CLIENT WITH NO RECORD TYPE — the 118-of-120 shape, and the input that
  // made the old fallback fire.
  c_clara: { id: "c_clara", firstName: "Clara", lastName: "Carewell",
             phone: "+14845550111", email: "clara@e.test", customFields: [] },
  // ⚠️ A CLIENT WHOSE *Attendee Profile* READS "Caregiver". The old scan
  // looked at every field's value, so this person passed as a caregiver.
  c_decoy: { id: "c_decoy", firstName: "Dana", lastName: "Carewell",
             phone: "+14845550112",
             customFields: [{ id: PROFILE, value: "Caregiver" }] },
  // A caregiver by LABEL, with no applicant case at all.
  c_label: { id: "c_label", firstName: "Lena", lastName: "Carewell",
             phone: "+14845550113", email: "lena@e.test",
             customFields: [{ id: RT, value: "Caregiver" }] },
  // 🔴 AN APPLICANT WITH A BLANK RECORD TYPE. Found only by their case.
  c_blank: { id: "c_blank", firstName: "Bruno", lastName: "Carewell",
             phone: "+14845550114", email: "bruno@e.test", customFields: [] },
  // ⚠️ "Staffer", NOT "Carewell", ON PURPOSE. §3's control needs an applicant
  // record the rep OWNS — owning one is what lets them edit it without a
  // pipeline grant — and if this person shared the surname they would join
  // every `ALL` query and quietly loosen §1's counts.
  c_repcg: { id: "c_repcg", firstName: "Rhea", lastName: "Staffer",
             phone: "+14845550115", customFields: [] },
};
const opps = {
  o_clara: { id: "o_clara", name: "Clara Carewell", pipelineId: P_CLIENT,
             pipelineStageId: "c_s1", contactId: "c_clara",
             // 🔴 OWNED BY THE REP, so the rep can edit it — which is what the
             // picker is gated on. Their grants hold the CLIENT pipeline only.
             assignedTo: REP, status: "open",
             createdAt: "2026-01-02T00:00:00.000Z", customFields: [] },
  o_decoy: { id: "o_decoy", name: "Dana Carewell", pipelineId: P_CLIENT,
             pipelineStageId: "c_s1", contactId: "c_decoy", assignedTo: ADMIN_ID,
             status: "open", createdAt: "2026-01-03T00:00:00.000Z", customFields: [] },
  o_blank: { id: "o_blank", name: "Bruno Carewell", pipelineId: P_CG,
             pipelineStageId: "g_s1", contactId: "c_blank", assignedTo: ADMIN_ID,
             status: "open", createdAt: "2026-01-04T00:00:00.000Z", customFields: [] },
  // An applicant the rep OWNS, in a pipeline they hold no grant for. They can
  // edit it (ownership beats the grant), so they can open its picker.
  o_repcg: { id: "o_repcg", name: "Rhea Staffer", pipelineId: P_CG,
             pipelineStageId: "g_s1", contactId: "c_repcg", assignedTo: REP,
             status: "open", createdAt: "2026-01-05T00:00:00.000Z", customFields: [] },
};
let relations = [];
let relSeq = 0;
/** 🔴 FLIPPED BY §4 — the account loses its Record Type field. */
let recordTypeFieldExists = true;

const cfg = JSON.stringify({
  seeded: true, folderNames: {},
  pipelines: {
    [P_CLIENT]: { scope: "client", folders: [] },
    [P_CG]: { scope: "caregiver", folders: [], group: "caregiver" },
  },
});
const access = JSON.stringify({
  // 🔴 THE REP HOLDS THE CLIENT PIPELINE AND NO APPLICANT ONE. That is the
  // whole of §3: a Private Pay rep staffing a case did not recruit anybody.
  pipelines: { [REP]: [P_CLIENT] },
  folders: {}, master: [], caseManagers: {}, referralAccess: {},
});

const cfOf = (c) => {
  const m = {};
  for (const f of c.customFields || []) m[f.id] = f.value ?? f.fieldValueString ?? "";
  return m;
};

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

    if (path === "/users/")
      return send(200, { users: [{ id: ADMIN_ID, name: "Admin" }, { id: REP, name: "Pat Rep" }] });
    if (path === `/locations/${LOC}/customValues`)
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Folders", value: cfg },
        { id: "cv2", name: "MM Pipeline Access", value: access },
      ] });
    if (path === `/locations/${LOC}/customFields`)
      return send(200, { customFields: /model=contact/.test(req.url)
        ? [
            ...(recordTypeFieldExists
              ? [{ id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS",
                   picklistOptions: ["Caregiver", "Client", "Referral Partner", "Event Attendee"] }]
              : []),
            { id: PROFILE, name: "Attendee Profile", dataType: "TEXT" },
          ]
        : [] });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        { id: P_CLIENT, name: "OLTL Enrollment", stages: [{ id: "c_s1", name: "NEW LEAD", position: 0 }] },
        { id: P_CG, name: "OLTL Caregiver Applicants", stages: [{ id: "g_s1", name: "SCREENING", position: 0 }] },
      ] });
    if (path === "/opportunities/search") {
      const pid = url.searchParams.get("pipeline_id") || "";
      const cid = url.searchParams.get("contact_id") || "";
      const rows = Object.values(opps).filter(
        (o) => (!pid || o.pipelineId === pid) && (!cid || o.contactId === cid));
      return send(200, {
        opportunities: rows.map((o) => ({ ...o, contact: contacts[o.contactId] })),
        meta: { total: rows.length },
      });
    }
    if (/^\/opportunities\/[^/]+$/.test(path) && req.method === "GET") {
      const o = opps[path.split("/")[2]];
      if (!o) return send(404, { message: "not found" });
      return send(200, { opportunity: { ...o, contact: contacts[o.contactId] } });
    }

    if (path === `/associations/${ASSOC}`)
      return send(200, { association: {
        id: ASSOC, firstObjectLabel: "Caregiver", secondObjectLabel: "Client" } });
    if (path === "/associations/relations" && req.method === "POST") {
      const id = `rel${++relSeq}`;
      relations.push({ id, associationId: j.associationId,
                       firstRecordId: j.firstRecordId, secondRecordId: j.secondRecordId });
      return send(200, { relation: { id } });
    }
    const relFor = /^\/associations\/relations\/([^/?]+)$/.exec(path);
    if (relFor && req.method === "GET")
      return send(200, { relations: relations.filter(
        (r) => r.firstRecordId === relFor[1] || r.secondRecordId === relFor[1]) });
    if (path === "/associations") return send(200, { associations: [] });

    if (path === "/contacts/search") {
      const filters = j?.filters || [];
      if (filters.length) {
        const f = filters[0];
        const fid = String(f.field || "").replace("customFields.", "");
        // ⚠️ GoHighLevel FILTERS ON THE FIELD IT WAS GIVEN, exactly. A fake
        // that matched the value in ANY field would make the old permissive
        // scan look correct — rule 1, pointed the other way.
        const rows = Object.values(contacts).filter((c) => cfOf(c)[fid] === f.value);
        return send(200, { contacts: rows, total: rows.length });
      }
      const q = String(j?.query || "").toLowerCase();
      const rows = Object.values(contacts).filter((c) =>
        `${c.firstName || ""} ${c.lastName || ""} ${c.phone || ""} ${c.email || ""}`
          .toLowerCase().includes(q));
      return send(200, { contacts: rows, total: rows.length });
    }
    if (/^\/contacts\/[^/]+$/.test(path)) {
      const c = contacts[path.split("/")[2]];
      if (!c) return send(404, { message: "not found" });
      return send(200, { contact: c });
    }
    return send(200, {});
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.GHL_SSO_SECRET = SECRET;
// ⚠️ NO `GHL_` PREFIX — lib/ghl.ts. Rule 7 cost round 170 a whole section.
process.env.CAREGIVER_ASSOCIATION_ID = ASSOC;
delete process.env.PIPELINE_ACCESS_MAP;
delete process.env.WEBHOOK_URL;

const G = await import("../lib/ghl.ts");
const searchRoute = await import("../app/api/opportunities/[id]/caregivers/search/route.ts");
const cgRoute = await import("../app/api/opportunities/[id]/caregivers/route.ts");
const ctx = (id) => ({ params: Promise.resolve({ id }) });

const pick = async (oppId, q, sso = ADMIN) => {
  G.resetCaregiverPickerCache();
  const r = await searchRoute.GET(
    new Request(`http://x/api/opportunities/${oppId}/caregivers/search?q=${encodeURIComponent(q)}`,
      { headers: { "x-ghl-sso-key": sso } }),
    ctx(oppId),
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const idsOf = (b) => (b.results || []).map((r) => r.id);

// ⚠️ ONE SURNAME ON EVERY CONTACT, DELIBERATELY. "Carewell" matches all four,
// so each assertion below is about WHO IS FILTERED OUT rather than about who
// the query happened to reach. A query that only matched one person would
// pass whatever the filter did.
const ALL = "Carewell";

// ═══════════════════════════════════════════════════════════════════════════
console.log("═══ 1 · 🔴 A CLIENT'S NAME RETURNS NO CLIENTS ═══");
// ═══════════════════════════════════════════════════════════════════════════
let v = await pick("o_clara", "Clara");
ok("the client's panel is still the caregiver side", v.body.role === "caregiver", v.body);
ok("🔴 typing a CLIENT's name returns nobody", idsOf(v.body).length === 0, v.body.results);
ok("…specifically, not the client themselves", !idsOf(v.body).includes("c_clara"), idsOf(v.body));

// 🔴 THE CONTROL. "returns nobody" is also what a picker that always returns
// nobody does, so the same query shape must find the real caregivers.
v = await pick("o_clara", ALL);
ok("🔴 CONTROL — the same surname DOES find the two caregivers",
  idsOf(v.body).sort().join("|") === "c_blank|c_label", idsOf(v.body));
ok("🔴 …and the two clients are the ones missing",
  !idsOf(v.body).includes("c_clara") && !idsOf(v.body).includes("c_decoy"), idsOf(v.body));

console.log("\n1b · ⚠️ Record Type SPECIFICALLY, not any field reading 'Caregiver'");
ok("🔴 the client whose Attendee Profile says 'Caregiver' is NOT offered",
  !idsOf(v.body).includes("c_decoy"), idsOf(v.body));
ok("…while the one whose RECORD TYPE says it is",
  idsOf(v.body).includes("c_label"), idsOf(v.body));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 2 · 🔴 A BLANK RECORD TYPE WITH AN APPLICANT CASE IS FOUND ═══");
// ═══════════════════════════════════════════════════════════════════════════
v = await pick("o_clara", "Bruno");
ok("🔴 Bruno is found by the case, with no label at all",
  idsOf(v.body).includes("c_blank"), v.body.results);
const bruno = (v.body.results || []).find((r) => r.id === "c_blank");
ok("…and the row names the applicant pipeline",
  bruno?.pipelineName === "OLTL Caregiver Applicants", bruno);
ok("…and the stage", bruno?.stage === "SCREENING", bruno);
// 🔴 THE CONTROL FOR THE OTHER HALF: a labelled caregiver with no case is
// still found, and shows no pipeline rather than a made-up one.
v = await pick("o_clara", "Lena");
const lena = (v.body.results || []).find((r) => r.id === "c_label");
ok("🔴 CONTROL — a labelled caregiver with NO case is found too", !!lena, v.body.results);
ok("…and shows no pipeline, because there is none",
  lena?.pipelineName === "" && lena?.stage === "", lena);

console.log("\n2b · 🔴 NAME, PIPELINE AND STAGE — NOTHING ELSE LEAVES THE SERVER");
v = await pick("o_clara", ALL);
const keys = [...new Set((v.body.results || []).flatMap((r) => Object.keys(r)))].sort();
ok("🔴 the payload carries no email and no phone",
  !keys.includes("email") && !keys.includes("phone"), keys);
ok("…and nothing beyond id, name, pipeline, stage and the overflow count",
  keys.join(",") === "id,more,name,pipelineName,stage", keys);
// ⚠️ THE CONTROL: both caregivers HAVE an email in the fixture, so "no email
// in the payload" is a thing that was removed rather than a thing absent.
ok("🔴 CONTROL — they do have emails; the server is withholding them",
  !!contacts.c_label.email && !!contacts.c_blank.email,
  { a: contacts.c_label.email, b: contacts.c_blank.email });

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 3 · 🔴 A REP WITH NO APPLICANT PIPELINES CAN STILL LINK ═══");
// ═══════════════════════════════════════════════════════════════════════════
// The rep owns o_clara and holds P_CLIENT only — no caregiver grant anywhere.
v = await pick("o_clara", ALL, REP_SSO);
ok("the rep may open the picker at all", v.status === 200, v);
ok("🔴 the rep finds the applicant they did not recruit",
  idsOf(v.body).includes("c_blank"), idsOf(v.body));
ok("…and the labelled caregiver too", idsOf(v.body).includes("c_label"), idsOf(v.body));
ok("🔴 nothing is withheld from this list, and it says so",
  v.body.withheld === 0, v.body.withheld);
// 🔴 THE CONTROL THAT PROVES THE REP REALLY IS SCOPED. If their grants were
// being ignored entirely, "a rep with no applicant pipelines" would be an
// empty phrase — so the CLIENT picker, which IS scoped, must withhold from
// them on the same account.
// ⚠️ OPENED FROM AN APPLICANT THE REP OWNS, which is the only way they can
// reach a caregiver-side panel at all — their grants hold no applicant
// pipeline, and ownership is what gets them in. The picker there is the
// CLIENT one, and it is scoped: the client owned by somebody else is withheld
// while their own is offered.
const scoped = await pick("o_repcg", ALL, REP_SSO);
ok("🔴 CONTROL — the rep IS genuinely scoped: the client picker withholds one",
  scoped.body.role === "client" && scoped.body.withheld === 1, scoped.body);
ok("…and the one it offers is the client they own",
  idsOf(scoped.body).join("|") === "c_clara", idsOf(scoped.body));

console.log("\n3b · …and the link actually goes through");
relations = [];
const linked = await cgRoute.POST(
  new Request("http://x/api/opportunities/o_clara/caregivers", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoKey: REP_SSO, caregiverContactId: "c_blank" }),
  }), ctx("o_clara"));
const lbody = await linked.json().catch(() => ({}));
ok("🔴 the rep links the caregiver", linked.status === 200 && !!lbody.relationId, lbody);
ok("…and the caregiver is in the caregiver slot",
  relations[0]?.firstRecordId === "c_blank", relations[0]);
const counts = await G.countCaregiverRelations("c_clara");
ok("…so the client reads 1 caregiver, 0 clients",
  counts.caregivers === 1 && counts.clients === 0, counts);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 4 · ⚠️ HALF AN ANSWER IS NOT 'NOBODY MATCHES' ═══");
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE LABEL HALF CAN FAIL ON ITS OWN — the Record Type field may be absent
// from the account, or GoHighLevel may refuse the filter. The case half still
// answers, so the picker is NARROWER rather than broken. Saying "No caregiver
// matches" in that state would be a claim nobody checked.
v = await pick("o_clara", ALL);
ok("with both halves running, nothing is flagged",
  v.body.labelsUnavailable === false, v.body.labelsUnavailable);

recordTypeFieldExists = false;
v = await pick("o_clara", ALL);
ok("🔴 with no Record Type field, the picker says the label half did not run",
  v.body.labelsUnavailable === true, v.body);
ok("🔴 …and it still answers from the cases — Bruno is there",
  idsOf(v.body).includes("c_blank"), idsOf(v.body));
ok("…while the label-only caregiver is the one lost",
  !idsOf(v.body).includes("c_label"), idsOf(v.body));
// 🔴 THE CONTROL. A degraded search must not start letting clients through:
// "narrower" has to mean narrower, not looser.
ok("🔴 CONTROL — degraded, it still returns NO clients",
  !idsOf(v.body).includes("c_clara") && !idsOf(v.body).includes("c_decoy"), idsOf(v.body));
recordTypeFieldExists = true;
v = await pick("o_clara", ALL);
ok("🔴 CONTROL — restoring the field brings the label half back",
  v.body.labelsUnavailable === false && idsOf(v.body).includes("c_label"), v.body);

// ═══════════════════════════════════════════════════════════════════════════
server.close();
const total = pass + fail;
console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
console.log(`assertions: ${total}`);
process.exit(fail ? 1 : 0);
