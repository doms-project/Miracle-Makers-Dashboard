// ---------------------------------------------------------------------------
// TASK 2 · SECTIONS 3 + 4 — PARTNER ROWS GET AN ACCESS TEST.
//
// 🔴 THE CONTROL PATTERN, AND THIS TIME IT IS THREE VIEWERS DEEP. "A scoped
// viewer sees less" passes against a route that returns nothing to anybody, so
// every withholding below is measured against TWO others in the same run:
//
//   ADMIN      sees all five partners                    ← nothing is withheld
//   PP REP     sees four — one is withheld by division   ← the scoping works
//   RECRUITER  sees two — and NOT because of a bug       ← the divisionLabel
//                                                          divergence, stated
//
// ⚠️ THE RECRUITER IS THE POINT OF THIS FILE. They hold only
// "OLTL Caregiver Applicants"; divisionLabel strips " Applicants" and leaves
// "OLTL Caregiver", which is not a Partner Division value on any account. So
// they match NO partner by division, and an empty table is indistinguishable
// from an account with no partners — unless the route says how many it kept
// back. That is the same fault section 1 fixed one screen over.
//
// Run: npx tsx scripts/task2-partners-proof.mjs
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
const RT = "F_RT", CAT = "F_CAT", TIER = "F_TIER", DIV = "F_DIV", REF = "F_REF";

const PP = "pipe_pp", OLTL = "pipe_oltl", ODP = "pipe_odp", APPS = "pipe_apps";
const U_ADMIN = "u_admin", U_PP = "u_pp", U_REC = "u_rec";

const blob = (userId, role) =>
  CryptoJS.AES.encrypt(JSON.stringify({
    userId, role, type: "location", activeLocation: LOC,
    userName: userId, email: `${userId}@test`, companyId: "co1",
  }), SECRET).toString();
const ADMIN = blob(U_ADMIN, "admin");
const REP_PP = blob(U_PP, "user");
const REP_REC = blob(U_REC, "user");

// ── THE FIXTURE, AND EVERY ROW IS A DIFFERENT RULE ─────────────────────────
// ⚠️ THE NAME AND THE ID ARE DIFFERENT STRINGS, AND THEY HAVE TO BE. The first
// version used the id as the contactName, so "does the withheld partner's name
// leak" could not be distinguished from "does their id appear" — and the id
// legitimately does, on the cases they sent. A fixture that cannot tell two
// things apart cannot assert about either.
const PARTNERS = [
  // id         name                  division       owner
  ["p_pp",    "Bryn Mawr Hospital",   "Private Pay", ""],    // the PP rep's own division
  ["p_oltl",  "Riddle Memorial",      "OLTL",        ""],    // 🔴 must be withheld
  ["p_odp",   "Delco Elder Law",      "ODP",         U_PP],  // 🔴 owned outside it — SHARED
  ["p_blank", "Uncategorised Clinic", "",            ""],    // ⚠️ the labelled leak
  ["p_all",   "Main Line Chamber",    "All",         ""],    // "every division"
];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const j = raw ? JSON.parse(raw) : null;
    const u = req.url, path = u.split("?")[0];
    const send = (code, o) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };

    if (path === `/locations/${LOC}/customFields`)
      return send(200, { customFields: u.includes("model=opportunity")
        ? [{ id: REF, name: "Referring Partner", dataType: "TEXT" }]
        : [
            { id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS",
              picklistOptions: ["Referral Partner", "Event Attendee"] },
            { id: CAT, name: "Partner Category", dataType: "SINGLE_OPTIONS", picklistOptions: ["Hospital discharge"] },
            { id: TIER, name: "Partner Tier", dataType: "SINGLE_OPTIONS", picklistOptions: ["A", "B", "C", "Prospect"] },
            { id: DIV, name: "Partner Division", dataType: "SINGLE_OPTIONS",
              picklistOptions: ["Private Pay", "OLTL", "ODP", "All"] },
          ] });

    if (path === "/users/")
      return send(200, { users: [
        { id: U_ADMIN, name: "An Admin" }, { id: U_PP, name: "A PP Rep" },
        { id: U_REC, name: "A Recruiter" },
      ] });

    // 🔴 "OLTL Caregiver Applicants" IS IN THE LIST ON PURPOSE. It is the name
    // divisionLabel mangles, and the recruiter's whole case depends on it.
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        { id: PP, name: "Private Pay Clients", stages: [{ id: "pp_s1", name: "NEW ENQUIRY", position: 0 }] },
        { id: OLTL, name: "OLTL Enrollment", stages: [{ id: "ol_s1", name: "NEW LEAD", position: 0 }] },
        { id: ODP, name: "ODP Transfer", stages: [{ id: "od_s1", name: "NEW LEAD", position: 0 }] },
        { id: APPS, name: "OLTL Caregiver Applicants", stages: [{ id: "ap_s1", name: "APPLIED", position: 0 }] },
      ] });

    if (path === `/locations/${LOC}/customValues`)
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Folders", value: JSON.stringify({
            seeded: true,
            pipelines: {
              [PP]: { scope: "client", folders: [] },
              [OLTL]: { scope: "client", folders: [] },
              [ODP]: { scope: "client", folders: [] },
              [APPS]: { scope: "caregiver", folders: [] },
            }, folderNames: {},
          }) },
        { id: "cv2", name: "MM Pipeline Access", value: JSON.stringify({
            pipelines: { [U_PP]: [PP], [U_REC]: [APPS] },
            folders: {}, master: [], caseManagers: {},
          }) },
      ] });

    if (path === "/contacts/search") {
      const want = j?.filters?.[0]?.value;
      if (want !== "Referral Partner") return send(200, { contacts: [], total: 0 });
      return send(200, {
        contacts: PARTNERS.map(([id, name, division, owner]) => ({
          id, contactName: name, email: `${id}@test.example`, phone: "610-555-0100",
          assignedTo: owner,
          customFields: [
            { id: RT, value: "Referral Partner" },
            { id: TIER, value: "A" },
            ...(division ? [{ id: DIV, value: division }] : []),
          ],
        })),
        total: PARTNERS.length,
      });
    }

    // ═══ 🔴 THE CASES, AND THEY ARE THE WHOLE POINT OF ROUND 145 ═══════════
    //
    // THIS ANSWERED `{ opportunities: [] }` AND THAT IS WHY THE DEFECT SHIPPED.
    // Section 4 filters PARTNERS; the bug lives where the partner list meets
    // the CASE list, and with no cases that meeting does not happen. The proof
    // was green on nothing — a fixture that stops reaching the feature.
    //
    // Three cases, three different relationships to the partner list:
    //   o_pp     partner VISIBLE to the PP rep      → never dangling
    //   o_oltl   partner WITHHELD from the PP rep   → 🔴 must NOT be dangling
    //   o_ghost  partner does not exist at all      → IS dangling, for everyone
    if (path === "/opportunities/search") {
      const pid = new URL(`http://x${u}`).searchParams.get("pipeline_id");
      if (pid !== PP) return send(200, { opportunities: [], meta: { total: 0 } });
      const opp = (id, partnerId) => ({
        id, name: id, pipelineId: PP, pipelineStageId: "pp_s1",
        status: "won", monetaryValue: 1000,
        createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
        assignedTo: "", followers: [],
        customFields: [{ id: REF, fieldValue: partnerId }],
      });
      return send(200, {
        opportunities: [opp("o_pp", "p_pp"), opp("o_oltl", "p_oltl"), opp("o_ghost", "p_deleted")],
        meta: { total: 3 },
      });
    }
    if (/^\/contacts\/[^/]+\/notes/.test(path)) return send(200, { notes: [] });
    if (/^\/contacts\/[^/]+$/.test(path)) return send(200, { contact: { id: "p_pp" } });
    send(404, { message: `no fake handler for ${path}` });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.GHL_SSO_SECRET = SECRET;
process.env.PIPELINE_IDS = `${PP},${OLTL},${ODP}`;

const route = await import("../app/api/referrals/route.ts");
const get = async (sso, qs = "") => {
  const res = await route.GET(
    new Request(`http://x/api/referrals${qs}`, { headers: { "x-ghl-sso-key": sso } }),
  );
  return { status: res.status, body: await res.json() };
};
const orgs = (r) => (r.body.partners || []).map((p) => p.id).sort();

console.log("\n═══ 1 · 🔴 THREE VIEWERS, ONE RUN ═══");

console.log("\n1a · 🔴 THE CONTROL — AN ADMIN SEES EVERY PARTNER");
const a = await get(ADMIN);
console.log(`  admin -> ${JSON.stringify(orgs(a))}  withheld=${a.body.meta.partnersWithheld}`);
ok("🔴 THE CONTROL — all five", orgs(a).length === 5, orgs(a));
ok("⚠️ and nothing is withheld from them", a.body.meta.partnersWithheld === 0, a.body.meta);
ok("⚠️ none is flagged shared — an admin is outside nothing",
   (a.body.partners || []).every((p) => p.shared === false), a.body.partners?.map((p) => [p.id, p.shared]));

console.log("\n1b · 🔴 THE PRIVATE PAY REP — ONE IS WITHHELD, AND IT IS THE RIGHT ONE");
const p = await get(REP_PP);
console.log(`  pp rep -> ${JSON.stringify(orgs(p))}  withheld=${p.body.meta.partnersWithheld}`);
ok("🔴 the OLTL partner is GONE", !orgs(p).includes("p_oltl"), orgs(p));
ok("🔴 their own division stays", orgs(p).includes("p_pp"), orgs(p));
ok("⚠️ and the count says one was kept back", p.body.meta.partnersWithheld === 1, p.body.meta);
// 🔴 NOT JUST ABSENT FROM THE LIST — their NAME, EMAIL AND PHONE are absent
// from the whole payload. Those are the disclosure; a key elsewhere carrying
// any of them would be the same leak by another route.
const ppBody = JSON.stringify(p.body);
ok("🔴 the withheld partner's NAME is nowhere in the response",
   !ppBody.includes("Riddle Memorial"), "the name leaked");
ok("🔴 nor their email or phone",
   !ppBody.includes("p_oltl@test.example"), "contact details leaked");
// ⚠️ THEIR ID DOES REMAIN, ON THE CASES THEY SENT, AND THAT IS KNOWN.
// `RawReferral.partnerId` is the join key; §4 withholds the partner ROW, not
// every reference to them. The consequence is bounded: with no partner row to
// attach to, enrichPartner never picks those cases up, so they reach no
// aggregate — and section 2 scopes the case array itself, which removes most
// of them. Asserted rather than left as an accident, so if it ever stops being
// true somebody chose that.
ok("⚠️ their opaque ID does remain on the case they sent — known, and bounded",
   ppBody.includes("p_oltl"), "the join key is gone, which is a different change");

console.log("\n1c · 🔴 THE SHARED HALF — OWNED OUTSIDE YOUR DIVISION");
const odp = (p.body.partners || []).find((x) => x.id === "p_odp");
console.log(`  p_odp -> ${JSON.stringify(odp && { id: odp.id, division: odp.division, shared: odp.shared })}`);
ok("🔴 an ODP partner assigned to a Private Pay rep is STILL VISIBLE", !!odp, orgs(p));
ok("🔴 and flagged `shared` — the parallel to applyAccess's owned-anywhere rule",
   odp?.shared === true, odp);
ok("⚠️ while a partner in their OWN division is not flagged shared",
   (p.body.partners || []).find((x) => x.id === "p_pp")?.shared === false, p.body.partners);

console.log("\n1d · ⚠️ BLANK AND \"All\" REACH EVERYONE — THE DECISION, NOT AN OVERSIGHT");
ok("blank is visible to the PP rep", orgs(p).includes("p_blank"), orgs(p));
ok('"All" is visible to the PP rep', orgs(p).includes("p_all"), orgs(p));
ok("🔴 and the blank one is COUNTED, so the leak is labelled rather than silent",
   p.body.meta.partnersNoDivision === 1, p.body.meta);
// ⚠️ THE CONTROL FOR THAT COUNT: it is account-wide, so every viewer reports
// the same number. A per-viewer count would make it a filter, not a data fault.
ok("⚠️ the admin reports the same count — it is a data fault, not a view",
   a.body.meta.partnersNoDivision === 1, a.body.meta);

console.log("\n═══ 2 · 🔴 THE RECRUITER — divisionLabel's DIVERGENCE, AND IT IS SAID ═══");
// "OLTL Caregiver Applicants" -> "OLTL Caregiver", which is not a Partner
// Division value. This viewer matches nothing by division and it is NOT a bug.
const r = await get(REP_REC);
console.log(`  recruiter -> ${JSON.stringify(orgs(r))}  withheld=${r.body.meta.partnersWithheld}`);
ok("🔴 they match NO partner by division — only blank and All reach them",
   orgs(r).join() === "p_all,p_blank", orgs(r));
ok("🔴 AND THE ROUTE SAYS SO: three withheld, not an empty account",
   r.body.meta.partnersWithheld === 3, r.body.meta);
// 🔴 THE CONTROL. Without the admin's 0 beside it, "withheld=3" could be a
// constant, and without the PP rep's 1 it could be "withhold everything".
ok("🔴 THE THREE COUNTS DIFFER — 0 · 1 · 3, so the number is measuring something",
   a.body.meta.partnersWithheld === 0 && p.body.meta.partnersWithheld === 1 &&
   r.body.meta.partnersWithheld === 3,
   [a.body.meta.partnersWithheld, p.body.meta.partnersWithheld, r.body.meta.partnersWithheld]);

console.log("\n═══ 3 · 🔴 THE SECOND LIST AGREES WITH THE FIRST ═══");
// `only=partners` feeds the "Referred by" picker on a client record. Two lists
// disagreeing about who may be seen is a second source of truth — and the
// picker names partners, so a disagreement is the disclosure itself.
const pick = await get(REP_PP, "?only=partners");
const pickIds = (pick.body.partners || []).map((x) => x.id).sort();
console.log(`  picker -> ${JSON.stringify(pickIds)}  withheld=${pick.body.withheld}`);
ok("🔴 the picker withholds the same OLTL partner", !pickIds.includes("p_oltl"), pickIds);
ok("🔴 AND IT MATCHES THE FULL LIST EXACTLY", pickIds.join() === orgs(p).join(),
   { picker: pickIds, full: orgs(p) });
// ⚠️ `assignedTo` was NOT in this projection before, so the ownership arm could
// not run here at all — the two lists would have agreed on division and
// differed on ownership, which is the same disagreement one field smaller.
ok("🔴 including the owned-outside-your-division one, which needs assignedTo",
   pickIds.includes("p_odp"), pickIds);
ok("⚠️ and it reports its own withheld count", pick.body.withheld === 1, pick.body.withheld);

const pickAdmin = await get(ADMIN, "?only=partners");
ok("🔴 THE CONTROL — the admin's picker still offers all five",
   (pickAdmin.body.partners || []).length === 5, pickAdmin.body.partners?.length);

console.log("\n═══ 4 · 🔴 ROUND 145 — A WITHHELD PARTNER IS NOT A DELETED ONE ═══");
// 🔴 THE DEFECT ROUND 143 SHIPPED. `danglingReferrals` counts cases whose
// partner is absent from the list, and §4 started withholding partners — so a
// partner a viewer may not see read as one that had been deleted, under the
// sentence "their revenue is attributed to nobody".
//
// ⚠️ AND IT IS TESTABLE ONLY BECAUSE BOTH LISTS ARE POPULATED NOW. The fixture
// answered /opportunities/search with an empty array, so the count was
// structurally zero and the interaction did not exist in the run.
console.log(`  admin     -> dangling=${a.body.meta.danglingReferrals} · partners=${orgs(a).length} · refs=${(a.body.referrals || []).length}`);
console.log(`  pp rep    -> dangling=${p.body.meta.danglingReferrals} · partners=${orgs(p).length} · refs=${(p.body.referrals || []).length}`);
console.log(`  recruiter -> dangling=${r.body.meta.danglingReferrals} · partners=${orgs(r).length}`);

// 🔴 THE CONTROL, AND IT IS WHAT STOPS "ALWAYS ZERO" PASSING. `o_ghost` points
// at a partner that genuinely is not on the account, and it must STILL be
// counted — for every viewer, because a deletion is a fact about the data and
// not about who is looking.
ok("🔴 THE CONTROL — a genuinely deleted partner IS counted, for the admin",
   a.body.meta.danglingReferrals === 1, a.body.meta.danglingReferrals);
ok("🔴 THE CLAIM — and the scoped viewer counts the SAME one, not three",
   p.body.meta.danglingReferrals === 1, p.body.meta.danglingReferrals);
ok("🔴 the withheld partner's case is NOT called deleted — this was the defect",
   p.body.meta.danglingReferrals === a.body.meta.danglingReferrals,
   { admin: a.body.meta.danglingReferrals, rep: p.body.meta.danglingReferrals });
// ⚠️ THE HARSHEST VIEWER. The recruiter is withheld THREE partners, so the
// pre-fix arithmetic would have read every one of their cases as orphaned.
ok("🔴 and the recruiter — withheld three — still counts one",
   r.body.meta.danglingReferrals === 1, r.body.meta.danglingReferrals);
// ⚠️ AND THE CASE ARRAY IS STILL WHOLE. Scoping it is section 2; if this
// changes before then, something scoped the cases by accident.
ok("⚠️ the case list is still unscoped — that is section 2, not this fix",
   (p.body.referrals || []).length === 3 && (a.body.referrals || []).length === 3,
   { rep: (p.body.referrals || []).length, admin: (a.body.referrals || []).length });

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
