// ---------------------------------------------------------------------------
// ROUND 167 — REFERRAL ACCESS, COMPLETE.
//
// 🔴 THE FIXTURE IS BILL'S SHAPE, AND IT IS BUILT TO MAKE THE OLD BUG VISIBLE.
// An ODP-only viewer, ONE OLTL event with TWO attendees, and NO ODP partner or
// event at all. Before this round that viewer's Referrals heading read "OLTL" —
// off the one unscoped event — and reading "Referral partners" the moment it
// was deleted. Both of those require the fixture to hold nothing in ODP; a
// fixture with an ODP partner in it would pass either way.
//
// ⚠️ EVERY SECTION PAIRS THE SCOPED VIEWER WITH AN ADMIN ON THE SAME DATA. A
// withholding assertion is satisfied by the data not existing, so the admin run
// is what proves there was something to withhold. Rule 14.
//
// Run: npx tsx scripts/referral-scope-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import CryptoJS from "crypto-js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const EV = "pipe_events", P_ODP = "pipe_odp", P_OLTL = "pipe_oltl";
const RT = "F_RT", PDIV = "F_PDIV", CAT = "F_CAT", TIER = "F_TIER", NOTES = "F_NOTES";
const EVATT = "F_EVATT", EVOUT = "F_EVOUT", EVPROF = "F_EVPROF";
const EVDATE = "F_EVDATE", EVCOST = "F_EVCOST", EVVEN = "F_EVVEN", EVDIV = "F_EVDIV";
const HOST = "F_HOST", REF = "F_REF";

const BILL = "u_bill";        // ODP pipelines only
const BOTH = "u_both";        // ODP + OLTL
const ADMIN_ID = "u_admin";

const blob = (userId, role) =>
  CryptoJS.AES.encrypt(
    JSON.stringify({
      userId, role, type: role === "admin" ? "agency" : "location",
      activeLocation: LOC, userName: userId, email: "x@e.com", companyId: "co1",
    }),
    SECRET,
  ).toString();
const BILL_SSO = blob(BILL, "user");
const BOTH_SSO = blob(BOTH, "user");
const ADMIN_SSO = blob(ADMIN_ID, "admin");

// ── the account ────────────────────────────────────────────────────────────
// 🔴 THE THREE PARTNERS ARE THE THREE LABELS §3 HAS TO TELL APART.
let contacts = [
  { id: "p_odp", contactName: "ODP Partner", email: "a@odp.org", phone: "",
    customFields: [{ id: RT, value: "Referral Partner" }, { id: PDIV, value: "ODP" }] },
  { id: "p_blank", contactName: "Uncategorised Partner", email: "b@x.org", phone: "",
    customFields: [{ id: RT, value: "Referral Partner" }] },
  // OWNED BY BILL, division OLTL — the `shared` case. Withholding it would
  // hide his own work; labelling it "OLTL" with no qualifier would read as a leak.
  { id: "p_mine", contactName: "My OLTL Partner", email: "c@oltl.org", phone: "",
    assignedTo: BILL,
    customFields: [{ id: RT, value: "Referral Partner" }, { id: PDIV, value: "OLTL" }] },
  // 🔴 ANOTHER OLTL PARTNER, OWNED BY NOBODY — so `partnersWithheld` can be
  // non-zero. Without it "withheld" would be 0 and the assertion unfalsifiable.
  { id: "p_other", contactName: "Someone Else's OLTL Partner", email: "d@oltl.org", phone: "",
    customFields: [{ id: RT, value: "Referral Partner" }, { id: PDIV, value: "OLTL" }] },
  { id: "a_one", contactName: "Attendee One", email: "", phone: "610-555-0001",
    customFields: [{ id: RT, value: "Event Attendee" }, { id: EVATT, value: "ev_oltl" }] },
  { id: "a_two", contactName: "Attendee Two", email: "", phone: "610-555-0002",
    customFields: [{ id: RT, value: "Event Attendee" }, { id: EVATT, value: "ev_oltl" }] },
  // 🔴 POINTS AT AN EVENT THAT DOES NOT EXIST — dangling, for §2.
  { id: "a_dangle", contactName: "Attendee Dangling", email: "", phone: "610-555-0003",
    customFields: [{ id: RT, value: "Event Attendee" }, { id: EVATT, value: "ev_deleted" }] },
];
let opps = [
  { id: "ev_oltl", name: "OLTL Expo", pipelineId: EV, pipelineStageId: "s1",
    contactId: "v_hall", customFields: [
      { id: EVDIV, value: "OLTL" }, { id: EVDATE, value: "2026-05-01" },
      { id: EVCOST, value: 500 }, { id: EVVEN, value: "Hall" }] },
];

let cfg = JSON.stringify({
  seeded: true, folderNames: {},
  pipelines: {
    [P_ODP]: { scope: "client", folders: [] },
    [P_OLTL]: { scope: "client", folders: [] },
    [EV]: { scope: "client", folders: [], role: "events" },
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

    if (path === "/users/")
      return send(200, { users: [BILL, BOTH, ADMIN_ID].map((id) => ({ id, name: id })) });
    if (path === `/locations/${LOC}/customValues` && req.method === "GET")
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Folders", value: cfg },
        { id: "cv2", name: "MM Pipeline Access", value: JSON.stringify({
          // 🔴 BILL HOLDS ODP PIPELINES AND NO REFERRAL OVERRIDE — so his
          // divisions are DERIVED, which is the default and the live shape.
          pipelines: { [BILL]: [P_ODP], [BOTH]: [P_ODP, P_OLTL] },
          folders: {}, master: [], caseManagers: {}, referralAccess: {},
        }) },
      ] });
    if (/^\/locations\/[^/]+\/customValues\/[^/]+$/.test(path) && req.method === "PUT") {
      if (j?.value) cfg = j.value;
      return send(200, { customValue: { id: "cv1" } });
    }
    if (path === `/locations/${LOC}/customFields`) {
      const contact = /model=contact/.test(req.url);
      return send(200, { customFields: contact
        ? [{ id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS", picklistOptions: ["Referral Partner", "Event Attendee"] },
           { id: PDIV, name: "Partner Division", dataType: "SINGLE_OPTIONS", picklistOptions: ["ODP", "OLTL", "Private Pay", "All"] },
           { id: CAT, name: "Partner Category", dataType: "TEXT" },
           { id: TIER, name: "Partner Tier", dataType: "TEXT" },
           { id: NOTES, name: "Partner Notes", dataType: "LARGE_TEXT" },
           { id: EVATT, name: "Event Attended", dataType: "TEXT" },
           { id: EVOUT, name: "Event Outcome", dataType: "TEXT" },
           { id: EVPROF, name: "Event Profile", dataType: "TEXT" }]
        : [{ id: HOST, name: "Event Host", dataType: "TEXT" },
           { id: EVDATE, name: "Event Date", dataType: "DATE" },
           { id: EVCOST, name: "Event Cost", dataType: "MONETORY" },
           { id: EVVEN, name: "Event Venue", dataType: "TEXT" },
           { id: EVDIV, name: "Event Division", dataType: "SINGLE_OPTIONS", picklistOptions: ["ODP", "OLTL", "All"] },
           { id: REF, name: "Referring Partner", dataType: "TEXT" }] });
    }
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        { id: P_ODP, name: "ODP Enrollment", stages: [{ id: "o_s1", name: "NEW LEAD", position: 0 }] },
        { id: P_OLTL, name: "OLTL Enrollment", stages: [{ id: "l_s1", name: "NEW LEAD", position: 0 }] },
        { id: EV, name: "Events", stages: [{ id: "s1", name: "Held", position: 0 }] },
      ] });
    if (path === "/opportunities/search") {
      const pid = url.searchParams.get("pipeline_id") || "";
      const rows = pid ? opps.filter((o) => o.pipelineId === pid) : opps;
      return send(200, { opportunities: rows, meta: { total: rows.length } });
    }
    if ((path === "/opportunities" || path === "/opportunities/") && req.method === "POST") {
      const id = `o${opps.length + 1}`;
      opps.push({ id, ...j, customFields: j.customFields || [] });
      return send(200, { opportunity: { id } });
    }
    if (path === "/contacts/search") {
      if (j?.query) {
        const n = String(j.query).toLowerCase();
        const hits = contacts.filter((c) => c.contactName.toLowerCase().includes(n));
        return send(200, { contacts: hits, total: hits.length });
      }
      const want = j?.filters?.[0]?.value;
      const hits = contacts.filter((c) =>
        (c.customFields || []).some((f) => f.id === RT && f.value === want));
      return send(200, { contacts: hits, total: hits.length });
    }
    // GoHighLevel's two contact rules — round 166.
    if (path === "/contacts/upsert" && req.method === "POST") {
      if (!j?.email && !j?.phone)
        return send(400, { message: "Pass at least one of number, email query parameter" });
      const id = `c_up${contacts.length + 1}`;
      contacts.push({ id, contactName: j.name || "", email: j.email || "", phone: j.phone || "", customFields: [] });
      return send(200, { contact: { id }, new: true });
    }
    if (path === "/contacts/" && req.method === "POST") {
      if (!j?.email && !j?.phone && !j?.firstName && !j?.lastName)
        return send(422, { message: "Contacts without email, phone, firstName and lastName are not allowed." });
      const id = `c_made${contacts.length + 1}`;
      contacts.push({ id, contactName: [j.firstName, j.lastName].filter(Boolean).join(" "),
                      email: j.email || "", phone: j.phone || "", customFields: [] });
      return send(200, { contact: { id } });
    }
    if (/^\/contacts\/[^/]+\/notes/.test(path)) return send(200, { notes: [] });
    if (/^\/contacts\/[^/]+$/.test(path)) {
      const c = contacts.find((x) => x.id === path.split("/")[2]);
      return c ? send(200, { contact: c }) : send(404, { message: "not found" });
    }
    return send(200, {});
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.GHL_SSO_SECRET = SECRET;
delete process.env.PIPELINE_ACCESS_MAP;
delete process.env.WEBHOOK_URL;

const referrals = await import("../app/api/referrals/route.ts");
const get = async (sso) => {
  const r = await referrals.GET(
    new Request("http://x/api/referrals", { headers: { "x-ghl-sso-key": sso } }),
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const post = async (sso, payload) => {
  const r = await referrals.POST(
    new Request("http://x/api/referrals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ssoKey: sso, ...payload }),
    }),
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ═══════════════════════════════════════════════════════════════════════════
console.log("═══ 1 · BILL'S SHAPE — ODP ONLY, ONE OLTL EVENT ═══");
// ═══════════════════════════════════════════════════════════════════════════
const bill = await get(BILL_SSO);
ok("the payload loads", bill.status === 200, bill.status);
ok("🔴 the heading comes from ACCESS — ODP, with no ODP data at all",
  JSON.stringify(bill.body.meta.viewerReferralDivisions) === '["ODP"]',
  bill.body.meta.viewerReferralDivisions);
ok("🔴 the OLTL event is withheld", bill.body.events.length === 0, bill.body.events);
ok("…and counted", bill.body.meta.eventsWithheld === 1, bill.body.meta.eventsWithheld);

// 🔴 THE WHOLE RESPONSE TEXT, NOT JUST THE ARRAYS. A name can leak through an
// aggregate, a label, a tooltip or a sort key, and a test that checks only
// `events` would miss every one of them.
const billText = JSON.stringify(bill.body);
ok("🔴 the OLTL event's NAME is nowhere in the response", !/OLTL Expo/.test(billText));
ok("🔴 neither attendee's name is anywhere in the response",
  !/Attendee One|Attendee Two/.test(billText));
ok("…and the withheld attendees are counted",
  bill.body.meta.attendeesWithheld === 2, bill.body.meta.attendeesWithheld);
ok("⚠️ the OTHER OLTL partner is withheld and counted",
  !/Someone Else/.test(billText) && bill.body.meta.partnersWithheld === 1,
  bill.body.meta.partnersWithheld);
ok("🔴 his OWN OLTL partner is NOT withheld — that would hide his work",
  bill.body.partners.some((p) => p.id === "p_mine" && p.shared === true),
  bill.body.partners.map((p) => [p.id, p.shared]));
ok("the scope kind is derived, not explicit or none",
  bill.body.meta.referralScopeKind === "derived", bill.body.meta.referralScopeKind);

// ── the control ───────────────────────────────────────────────────────────
const adm = await get(ADMIN_SSO);
const admText = JSON.stringify(adm.body);
ok("🔴 CONTROL — the admin SEES the event", adm.body.events.length === 1, adm.body.events.length);
ok("🔴 CONTROL — and both attendees",
  /Attendee One/.test(admText) && /Attendee Two/.test(admText));
ok("🔴 CONTROL — so there really was something to withhold",
  adm.body.meta.eventsWithheld === 0 && adm.body.meta.attendeesWithheld === 0,
  { e: adm.body.meta.eventsWithheld, a: adm.body.meta.attendeesWithheld });
ok("🔴 CONTROL — the admin gets the switcher, not a division name",
  adm.body.meta.viewerReferralDivisions === null, adm.body.meta.viewerReferralDivisions);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 1b · 🔴 THE HEADING ITSELF, NOT JUST THE FIELD IT READS ═══");
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THIS SECTION EXISTS BECAUSE A REVERT CAME BACK GREEN. Everything above
// asserts `meta.viewerReferralDivisions` — a SERVER field — so reverting the
// CLIENT derivation that reads it changed nothing any assertion could see.
// Rule 10: a revert that changes nothing is a proof not reaching the code.
// `headingDivisions` was pulled out of the component for exactly this, and it
// is driven here with literals.
const { headingDivisions } = await import("../lib/referrals.ts");

ok("🔴 an ODP-only viewer reads ODP with NO ODP data at all — the live bug",
  JSON.stringify(headingDivisions(["ODP"], [], [])) === '["ODP"]',
  headingDivisions(["ODP"], [], []));
// 🔴 THE EXACT REPRODUCTION, AS THE TWO HALVES THAT CAUSED IT.
//
// ⚠️ THE FIRST ATTEMPT AT THIS ASSERTION WAS A MUDDLE — a ternary comparing one
// thing and reporting another, because I tried to make ONE assertion carry both
// halves of a two-part fix. The server withholds the event (§1 proves that);
// this proves the client no longer DEPENDS on it having done so.
//
// Before round 167 the derivation ignored access entirely, so an ODP-only
// viewer handed one OLTL event answered ["OLTL"] — and [] once it was deleted.
// Both of those are now impossible for a different reason each.
ok("🔴 access alone already answers ODP, so no event can set the heading",
  JSON.stringify(headingDivisions(["ODP"], [], [])) === '["ODP"]');
ok("⚠️ …and deleting the account's only event cannot empty it",
  headingDivisions(["ODP"], [], []).length === 1);
// 🔴 AND IF AN OLTL EVENT SOMEHOW REACHED THEM, THE HEADING WOULD SAY SO rather
// than hide it. That is deliberate: a record on screen must be switchable to,
// or it is visible and unreachable. The withholding is the server's job.
ok("🔴 a division present in the DATA is still offered — visible means reachable",
  JSON.stringify(headingDivisions(["ODP"], [], [{ division: "OLTL" }])) === '["ODP","OLTL"]',
  headingDivisions(["ODP"], [], [{ division: "OLTL" }]));
ok("🔴 an ADMIN (null) still gets everything the data holds",
  JSON.stringify(headingDivisions(null, [{ division: "OLTL" }], [{ division: "ODP" }])) ===
    '["ODP","OLTL"]',
  headingDivisions(null, [{ division: "OLTL" }], [{ division: "ODP" }]));
ok("🔴 CONTROL — so access alone is not the whole answer either",
  headingDivisions(null, [{ division: "OLTL" }], []).length === 1);
ok("a two-division viewer gets both, with nothing in the data",
  JSON.stringify(headingDivisions(["ODP", "OLTL"], [], [])) === '["ODP","OLTL"]');
ok("a viewer with none gets none — \"Referral partners\", not \"All\"",
  headingDivisions([], [], []).length === 0);
ok('⚠️ "All" is never offered as an entry',
  headingDivisions(["ODP"], [{ division: "All" }], [{ division: "All" }]).join() === "ODP");

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 2 · 🔴 DANGLING IS NOT WITHHELD ═══");
// ═══════════════════════════════════════════════════════════════════════════
// Round 124 · item 4: deleting an event must not erase the evidence that those
// people were met. Round 145: a withheld thing must never read as a deleted one.
ok("🔴 the dangling attendee survives for the SCOPED viewer",
  /Attendee Dangling/.test(billText), bill.body.attendees.map((a) => a.name));
ok("…and for the admin", /Attendee Dangling/.test(admText));
ok("🔴 counted the same for BOTH — it is a fact about the account, not the viewer",
  bill.body.meta.danglingAttendees === 1 && adm.body.meta.danglingAttendees === 1,
  { bill: bill.body.meta.danglingAttendees, admin: adm.body.meta.danglingAttendees });
ok("⚠️ and it is NOT counted as withheld — the two numbers mean different things",
  bill.body.meta.attendeesWithheld === 2, bill.body.meta.attendeesWithheld);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 3 · LABELS — THREE PARTNERS, THREE REASONS ═══");
// ═══════════════════════════════════════════════════════════════════════════
const byId = (b, id) => b.partners.find((p) => p.id === id);
ok("the ODP partner carries its division",
  byId(bill.body, "p_odp")?.division === "ODP", byId(bill.body, "p_odp"));
ok("🔴 the blank partner carries a BLANK, not a guess",
  byId(bill.body, "p_blank")?.division === "", byId(bill.body, "p_blank"));
ok("🔴 the owned OLTL partner is flagged `shared` — the label reads \"Yours\"",
  byId(bill.body, "p_mine")?.shared === true, byId(bill.body, "p_mine"));
ok("…and the ODP one is not",
  byId(bill.body, "p_odp")?.shared !== true, byId(bill.body, "p_odp"));
ok("🔴 CONTROL — the admin sees the same three, none of them `shared`",
  ["p_odp", "p_blank", "p_mine"].every((id) => byId(adm.body, id)) &&
    !["p_odp", "p_blank", "p_mine"].some((id) => byId(adm.body, id).shared),
  adm.body.partners.map((p) => [p.id, p.shared]));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 4 · TWO DIVISIONS — \"ODP + OLTL\", NOT \"ALL\" ═══");
// ═══════════════════════════════════════════════════════════════════════════
const both = await get(BOTH_SSO);
ok("the two-division viewer gets both names",
  JSON.stringify(both.body.meta.viewerReferralDivisions) === '["ODP","OLTL"]',
  both.body.meta.viewerReferralDivisions);
ok("🔴 …which is what the combined option and every total are labelled with",
  (both.body.meta.viewerReferralDivisions || []).join(" + ") === "ODP + OLTL");
ok("they see the OLTL event", both.body.events.length === 1, both.body.events.length);
ok("…and nothing is withheld from them",
  both.body.meta.eventsWithheld === 0 && both.body.meta.partnersWithheld === 0,
  both.body.meta);
ok("🔴 CONTROL — the admin gets null, which is the ONLY case \"All divisions\" is true",
  adm.body.meta.viewerReferralDivisions === null);
ok("🔴 …so the two are distinguishable, which is the whole point",
  JSON.stringify(both.body.meta.viewerReferralDivisions) !==
    JSON.stringify(adm.body.meta.viewerReferralDivisions));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 5 · WRITES — NOBODY CREATES WHAT THEY CANNOT SEE ═══");
// ═══════════════════════════════════════════════════════════════════════════
const oppsBefore = opps.length, contactsBefore = contacts.length;
const badEv = await post(BILL_SSO, {
  action: "add-event", org: "Sneaky", venue: "Sneaky Hall", division: "OLTL",
});
ok("🔴 Bill creating an OLTL event is REFUSED 403", badEv.status === 403, badEv.body);
ok("…it is a refusal, not a fault", badEv.body.refusal === true, badEv.body);
ok("…and it names his actual access", /ODP/.test(badEv.body.detail || ""), badEv.body.detail);
ok("🔴 NO GOHIGHLEVEL CALL WAS MADE — nothing was created",
  opps.length === oppsBefore && contacts.length === contactsBefore,
  { opps: opps.length - oppsBefore, contacts: contacts.length - contactsBefore });

const badP = await post(BILL_SSO, { action: "add-partner", org: "Sneaky Org", division: "OLTL" });
ok("🔴 and an OLTL partner likewise", badP.status === 403, badP.body);
ok("…with nothing created", contacts.length === contactsBefore, contacts.length - contactsBefore);

const goodEv = await post(BILL_SSO, {
  action: "add-event", org: "ODP Day", venue: "ODP Hall", division: "ODP",
});
ok("🔴 CONTROL — an ODP event SUCCEEDS, so the refusal is about the division",
  goodEv.status === 200, goodEv.body);
const goodP = await post(BILL_SSO, { action: "add-partner", org: "ODP Org", division: "ODP" });
ok("🔴 CONTROL — and an ODP partner", goodP.status === 200, goodP.body);

// ⚠️ ROUND 167 — the division is required, not merely checked.
const noDivEv = await post(BILL_SSO, { action: "add-event", org: "X", venue: "Y", division: "" });
ok("⚠️ an event with NO division is refused too", noDivEv.status === 400, noDivEv.body);
ok("…saying it would be shown to everybody",
  /shown to everybody/i.test(noDivEv.body.detail || ""), noDivEv.body.detail);
const noDivP = await post(BILL_SSO, { action: "add-partner", org: "X" });
ok("⚠️ and a partner with no division — round 143's dialog rule, now on the server",
  noDivP.status === 400, noDivP.body);

// 🔴 CONTROL — the admin may write any division.
const admEv = await post(ADMIN_SSO, {
  action: "add-event", org: "Admin OLTL Day", venue: "Admin Hall", division: "OLTL",
});
ok("🔴 CONTROL — an admin CAN file under OLTL, so the gate is access and not a blanket ban",
  admEv.status === 200, admEv.body);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 6 · THE REACHABILITY RULE ═══");
// ═══════════════════════════════════════════════════════════════════════════
const before = contacts.length;
const noReach = await post(ADMIN_SSO, {
  action: "log-referral", partnerId: "p_odp", firstName: "Unreachable", division: "ODP",
  pipelineId: P_ODP,
});
ok("🔴 a referral with no phone and no email is refused", noReach.status === 400, noReach.body);
ok("…with the sentence that names what is missing",
  /way to reach them/i.test(noReach.body.error || ""), noReach.body.error);
ok("…and nothing was created", contacts.length === before, contacts.length - before);
const reach = await post(ADMIN_SSO, {
  action: "log-referral", partnerId: "p_odp", firstName: "Reachable", division: "ODP",
  pipelineId: P_ODP, phone: "610-555-1234",
});
ok("🔴 CONTROL — the same referral WITH a phone is accepted", reach.status === 200, reach.body);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 7 · D12 — THE ACCESS TAB'S CHOICES ═══");
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 IT OFFERED DIVISIONS NO PARTNER CAN CARRY. The checklist was derived from
// PIPELINE NAMES, so it listed "Events", "ODP Enrollment" → ODP, "OLTL
// Enrollment" → OLTL and anything else a pipeline is named after. An admin
// could tick one, save it, see it stored, and grant nothing — because
// `referralDivisions` compares the stored value against a PARTNER's division.
// A control that stores a value and changes nothing reports success.
const admin = await import("../app/api/admin/pipeline-access/route.ts");
const tab = await admin.GET(
  new Request("http://x/api/admin/pipeline-access", { headers: { "x-ghl-sso-key": ADMIN_SSO } }),
);
const tabBody = await tab.json().catch(() => ({}));
ok("the admin payload loads", tab.status === 200, tab.status);
ok("🔴 it carries Partner Division's options, EXACTLY",
  JSON.stringify(tabBody.divisionOptions) === JSON.stringify(["ODP", "OLTL", "Private Pay", "All"]),
  tabBody.divisionOptions);
// 🔴 THE CONTROL IS THE DIFFERENCE BETWEEN THE TWO LISTS. If the pipeline
// derivation and the field's options happened to match, this whole item would
// be unfalsifiable — so the fixture names a pipeline "Events" and gives the
// field a "Private Pay" option neither pipeline implies.
const fromPipelines = ["ODP", "OLTL", "Events"];
ok("🔴 CONTROL — the two lists genuinely differ, so the fixture can tell them apart",
  JSON.stringify(tabBody.divisionOptions) !== JSON.stringify(fromPipelines.sort()),
  { field: tabBody.divisionOptions, pipelines: fromPipelines });
ok("⚠️ \"Events\" — a pipeline name that is not a division — is NOT offered",
  !(tabBody.divisionOptions || []).includes("Events"), tabBody.divisionOptions);
ok("…and \"Private Pay\", which no pipeline here implies, IS",
  (tabBody.divisionOptions || []).includes("Private Pay"), tabBody.divisionOptions);

// ⚠️ A SOURCE ASSERTION, AND IT IS NAMED AS ONE. The tab's preference is two
// lines inside a component; this checks it reads the field's options BEFORE the
// pipeline derivation, which is weaker than driving it, and round 160's lesson
// is that a source scan can be blind to a form it did not imagine. The route
// assertions above are the real evidence.
const tabSrc = readFileSync("components/PipelineAccessTab.tsx", "utf8");
ok("the tab prefers the field's options over the pipeline derivation (source)",
  /partnerDivisionOptions\?\.length\)\s*return/.test(tabSrc), "no preference found");
ok("…and says which list it is showing when it falls back (source)",
  /referralChoicesAreLive/.test(tabSrc), "no disclosure");

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
