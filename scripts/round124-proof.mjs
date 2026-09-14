// ---------------------------------------------------------------------------
// ROUND 124 — THE EVENT MODEL, THE EMPTY EVENTS TAB, AND TWO DELETES.
//
// 🔴 THE FAKE ENFORCES THE CONSTRAINT THE WHOLE ROUND IS ABOUT: one opportunity
// per contact per pipeline. If it did not, item 1 would "pass" while proving
// nothing at all — the second event would be created in the harness and refused
// in production. That is the rule the owner named in round 121:
//
//   "a fake that answers something GoHighLevel would refuse is a harness bug,
//    whether or not a test is red."
//
// It also refuses a second DELETE the way GoHighLevel does — 400 with "is
// deleted" in the message, the shape round 118 measured on pipelines.
//
// ⚠️ AND THE EVENTS PIPELINE IS DELIBERATELY HOSTILE TO THE OLD LOOKUP:
// it is named "Events & Outreach" (so `/^events?$/i` cannot match it) and
// scoped CAREGIVER (so neither the client nor the "none" picker lists it).
// Only the stored role can find it. A fixture that left it named "Events" and
// scoped client would have proved the fallback, not the fix.
//
// Run: npx tsx scripts/round124-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { readFileSync } from "node:fs";
import CryptoJS from "crypto-js";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const EV = "pipe_events";
const RT = "F_RT", CAT = "F_CAT", TIER = "F_TIER", PDIV = "F_PDIV";
const EVATT = "F_EVATT", EVOUT = "F_EVOUT";
const REF = "F_REF", EVDATE = "F_EVDATE", EVCOST = "F_EVCOST", EVVEN = "F_EVVEN", EVDIV = "F_EVDIV";
const HOST = "F_HOST";

const blobFor = (role, type) =>
  CryptoJS.AES.encrypt(
    JSON.stringify({
      userId: role === "admin" ? "u_admin" : "u_rep",
      role, type, activeLocation: LOC,
      userName: role === "admin" ? "Admin" : "Rep", email: "x@e.com", companyId: "co1",
    }),
    SECRET,
  ).toString();
const ADMIN = blobFor("admin", "agency");
const REP = blobFor("user", "location");

// ── the account ────────────────────────────────────────────────────────────
let contacts = [
  { id: "p_riddle", contactName: "Riddle Hospital", email: "d@riddle.org", phone: "",
    customFields: [{ id: RT, value: "Referral Partner" }, { id: CAT, value: "Hospital discharge" },
                   { id: TIER, value: "A" }, { id: PDIV, value: "Private Pay" }] },
  { id: "a_dana", contactName: "Dana Ruiz", email: "", phone: "610-555-0001",
    customFields: [{ id: RT, value: "Event Attendee" }, { id: EVATT, value: "ev_spring" }] },
  { id: "a_ivy", contactName: "Ivy Chen", email: "", phone: "610-555-0002",
    customFields: [{ id: RT, value: "Event Attendee" }, { id: EVATT, value: "ev_spring" }] },
];
let opps = [
  { id: "ev_spring", name: "Spring Expo", pipelineId: EV, pipelineStageId: "ev_s1", status: "open",
    contact: { id: "c_delco", firstName: "Delco Expo Centre", lastName: "" }, contactId: "c_delco",
    createdAt: new Date().toISOString(),
    customFields: [{ id: EVVEN, fieldValue: "Delco Expo Centre" }, { id: EVCOST, fieldValue: 1200 },
                   { id: EVDIV, fieldValue: "Private Pay" }, { id: HOST, fieldValue: "p_riddle" }] },
];
contacts.push({ id: "c_delco", contactName: "Delco Expo Centre", email: "", phone: "", customFields: [] });

const seen = [];
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const [path, qs] = req.url.split("?");
  const q = new URLSearchParams(qs || "");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method, path, body, q: Object.fromEntries(q) });

    if (path === `/locations/${LOC}/customFields`) {
      const opp = q.get("model") === "opportunity";
      return json(res, 200, { customFields: opp ? [
        { id: REF, name: "Referring Partner", dataType: "TEXT" },
        { id: EVDATE, name: "Event Date", dataType: "DATE" },
        { id: EVCOST, name: "Event Cost", dataType: "NUMERICAL" },
        { id: EVVEN, name: "Event Venue", dataType: "TEXT" },
        { id: EVDIV, name: "Event Division", dataType: "TEXT" },
        { id: HOST, name: "Event Host", dataType: "TEXT" },
      ] : [
        { id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS",
          picklistOptions: ["Referral Partner", "Event Attendee"] },
        { id: CAT, name: "Partner Category", dataType: "SINGLE_OPTIONS", picklistOptions: ["Hospital discharge"] },
        { id: TIER, name: "Partner Tier", dataType: "SINGLE_OPTIONS", picklistOptions: ["A", "B", "C"] },
        { id: PDIV, name: "Partner Division", dataType: "SINGLE_OPTIONS",
          picklistOptions: ["Private Pay", "OLTL", "ODP", "All"] },
        { id: EVATT, name: "Event Attended", dataType: "TEXT" },
        { id: EVOUT, name: "Event Outcome", dataType: "SINGLE_OPTIONS", picklistOptions: ["Legit lead"] },
      ] });
    }
    if (path.startsWith("/users/")) return json(res, 200, { users: [{ id: "u_admin", name: "Admin" }] });

    // 🔴 THE EVENTS PIPELINE IS NAMED WRONG AND SCOPED WRONG, ON PURPOSE.
    if (path === "/opportunities/pipelines")
      return json(res, 200, { pipelines: [
        { id: "pipe_pp", name: "Private Pay Clients",
          stages: [{ id: "pp_s1", name: "NEW LEAD", position: 0 }] },
        { id: EV, name: "Events & Outreach",
          stages: [{ id: "ev_s1", name: "PLANNED", position: 0 }] },
      ] });

    if (path === `/locations/${LOC}/customValues`)
      return json(res, 200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({ seeded: true, folderNames: {}, pipelines: {
          pipe_pp: { scope: "client", folders: [] },
          // ⚠️ caregiver scope AND a non-matching name. Only `role` can find it.
          [EV]: { scope: "caregiver", folders: [], role: "events" },
        } }) }] });

    if (path === "/opportunities/search") {
      const pid = q.get("pipeline_id") || "";
      const rows = opps.filter((o) => o.pipelineId === pid);
      return json(res, 200, { opportunities: rows, meta: { total: rows.length } });
    }

    // 🔴 THE CONSTRAINT THIS WHOLE ROUND IS ABOUT, ENFORCED.
    if ((path === "/opportunities" || path === "/opportunities/") && req.method === "POST") {
      const clash = opps.find(
        (o) => o.pipelineId === body.pipelineId && o.contactId === body.contactId,
      );
      if (clash)
        return json(res, 400, {
          message: "Duplicate opportunity: a contact can only have one opportunity per pipeline",
        });
      const id = `opp_${opps.length + 1}`;
      opps.push({
        id, name: body.name, pipelineId: body.pipelineId, pipelineStageId: body.pipelineStageId,
        status: "open", contactId: body.contactId,
        contact: { id: body.contactId, firstName: body.name, lastName: "" },
        createdAt: new Date().toISOString(),
        customFields: (body.customFields || []).map((c) => ({ id: c.id, fieldValue: c.value })),
      });
      return json(res, 200, { opportunity: { id } });
    }
    if (/^\/opportunities\/[^/]+$/.test(path) && req.method === "GET") {
      const o = opps.find((x) => x.id === path.split("/")[2]);
      return o ? json(res, 200, { opportunity: o }) : json(res, 404, { message: "not found" });
    }
    if (/^\/opportunities\/[^/]+$/.test(path) && req.method === "DELETE") {
      const id = path.split("/")[2];
      const i = opps.findIndex((x) => x.id === id);
      // ⚠️ THE SECOND DELETE ANSWERS THE WAY ROUND 118 MEASURED ON PIPELINES:
      // 400, not 404, with "is deleted" in the message.
      if (i < 0) return json(res, 400, { message: `Opportunity with id ${id} is deleted` });
      opps.splice(i, 1);
      return json(res, 200, { succeded: true });
    }

    if (path === "/contacts/search") {
      if (body?.query) {
        const needle = String(body.query).toLowerCase();
        const hits = contacts.filter((c) => c.contactName.toLowerCase().includes(needle));
        return json(res, 200, { contacts: hits, total: hits.length });
      }
      const want = body?.filters?.[0]?.value;
      const hits = contacts.filter((c) =>
        (c.customFields || []).some((f) => f.id === RT && f.value === want));
      return json(res, 200, { contacts: hits, total: hits.length });
    }
    if (path === "/contacts/upsert" && req.method === "POST") {
      const id = `c_new${contacts.length + 1}`;
      contacts.push({ id, contactName: body.name || "", email: body.email || "",
                      phone: body.phone || "", source: body.source || "", customFields: [] });
      return json(res, 200, { contact: { id }, new: true });
    }
    if (/^\/contacts\/[^/]+\/notes/.test(path)) return json(res, 200, { notes: [] });
    if (/^\/contacts\/[^/]+$/.test(path)) {
      const id = path.split("/")[2];
      const c = contacts.find((x) => x.id === id);
      if (req.method === "PUT") {
        if (c && Array.isArray(body?.customFields))
          for (const f of body.customFields) {
            const cur = (c.customFields || []).find((x) => x.id === f.id);
            if (cur) cur.value = f.value;
            else c.customFields.push({ id: f.id, value: f.value });
          }
        return json(res, 200, { contact: c });
      }
      return c
        ? json(res, 200, { contact: { ...c, customFields: c.customFields, dateUpdated: "2026-01-01" } })
        : json(res, 404, { message: "not found" });
    }
    return json(res, 200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.GHL_SSO_SECRET = SECRET;
delete process.env.WEBHOOK_URL;

const referrals = await import("../app/api/referrals/route.ts");
const oppRoute = await import("../app/api/opportunities/[id]/route.ts");

const post = async (payload) => {
  const r = await referrals.POST(
    new Request("http://x/api/referrals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ssoKey: ADMIN, ...payload }),
    }),
  );
  return { status: r.status, body: await r.json() };
};
const payload = async () => {
  const r = await referrals.GET(
    new Request("http://x/api/referrals", { headers: { "x-ghl-sso-key": ADMIN } }),
  );
  return { status: r.status, body: await r.json() };
};
const del = async (id, blob) => {
  const r = await oppRoute.DELETE(
    new Request(`http://x/api/opportunities/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ssoKey: blob }),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: r.status, body: await r.json() };
};

// ═══ 2 · THE EVENTS TAB READ NOTHING ══════════════════════════════════════
console.log("\n2 · 🔴 FOUND BY NAME, AND THE RECORDS FETCHED FROM A DIFFERENT LIST");
console.log('  fixture: the pipeline is named "Events & Outreach" and scoped CAREGIVER.');
const p0 = await payload();
console.log(`  eventsPipelineConfigured=${p0.body.meta.eventsPipelineConfigured} via=${p0.body.meta.eventsPipelineVia} events=${p0.body.events.length}`);
ok("🔴 the stored role finds it — a rename cannot break this",
   p0.body.meta.eventsPipelineVia === "role", p0.body.meta);
ok("⚠️ and the old name match could not have: /^events?$/i vs \"Events & Outreach\"",
   !/^events?$/i.test("Events & Outreach"), "the fixture name is too easy");
ok("🔴 and its records actually arrive — the half that was not a rename",
   p0.body.events.length === 1, p0.body.events);
console.log("  ⚠️ the pipeline is CAREGIVER-scoped, so getOltlOpportunities() —");
console.log("     which defaults to scope:\"client\" — never fetched it. The lookup");
console.log("     said configured and the list came back empty.");
ok("the event carries its venue and host", p0.body.events[0]?.venue === "Delco Expo Centre"
   && p0.body.events[0]?.host === "p_riddle", p0.body.events[0]);

// ═══ 1 · THE EVENT MODEL ══════════════════════════════════════════════════
console.log("\n1 · 🔴 ONE OPPORTUNITY PER CONTACT PER PIPELINE — THE VENUE IS THE CONTACT");
console.log("  Riddle Hospital already hosts Spring Expo. Under the old model its");
console.log("  contact WAS the event's contact, so a second event was impossible.");
const second = await post({
  action: "add-event", org: "Autumn Fair", partnerId: "p_riddle",
  venue: "Havertown Community Hall", eventDate: "2026-10-02", cost: 800, division: "Private Pay",
});
console.log(`  -> ${second.status} ${JSON.stringify(second.body).slice(0, 110)}`);
ok("🔴 a SECOND event for the same partner is created", second.status === 200, second.body);
const made = opps.find((o) => o.name === "Autumn Fair");
ok("🔴 and its contact is the VENUE, not the partner",
   made && made.contactId !== "p_riddle", made);
const venueContact = contacts.find((c) => c.id === made?.contactId);
ok("⚠️ which is a real record named after the place",
   venueContact?.contactName === "Havertown Community Hall", venueContact);
ok("⚠️ marked as a venue, and NOT given a Record Type it has no picklist option for",
   venueContact?.source === "Event venue" &&
   !(venueContact?.customFields || []).some((f) => f.id === RT), venueContact);
ok("the partner is still recorded as the host",
   (made?.customFields || []).some((f) => f.id === HOST && f.fieldValue === "p_riddle"),
   made?.customFields);

console.log("\n  …a THIRD event, same partner, to show it is not a one-off allowance:");
const third = await post({
  action: "add-event", org: "Winter Open House", partnerId: "p_riddle",
  venue: "Media Library", cost: 200, division: "Private Pay",
});
ok("🔴 also created — the partner is no longer the limit", third.status === 200, third.body);

console.log("\n  …and the collision that REMAINS, refused honestly (option a):");
const clash = await post({
  action: "add-event", org: "Autumn Fair 2", partnerId: "p_riddle",
  venue: "havertown community hall", cost: 100, division: "Private Pay",
});
console.log(`  -> ${clash.status} ${clash.body.error}`);
console.log(`     ${String(clash.body.detail || "").slice(0, 120)}…`);
ok("🔴 a second event at the same venue is REFUSED", clash.status === 409, clash.body);
ok("⚠️ case- and space-insensitively — \"havertown community hall\" is the same place",
   /already hosts an event/i.test(clash.body.error || ""), clash.body.error);
ok("⚠️ it is a refusal, not a fault", clash.body.refusal === true, clash.body);
ok("it names the event already there", /Autumn Fair/.test(clash.body.detail || ""), clash.body.detail);
ok("and it says what to do instead", /Rename the venue/i.test(clash.body.detail || ""), clash.body.detail);
ok("🔴 nothing was created", !opps.some((o) => o.name === "Autumn Fair 2"), opps.map((o) => o.name));

console.log("\n  …and a venue is required, because it IS the contact:");
const noVenue = await post({ action: "add-event", org: "Nowhere", partnerId: "p_riddle", venue: "" });
ok("an event with no venue is refused", noVenue.status === 400, noVenue.body);
ok("and it explains why the venue matters", /becomes a contact/i.test(noVenue.body.detail || ""),
   noVenue.body.detail);

console.log("\n  …and a venue named like a PARTNER never reuses the partner's contact:");
const risky = await post({
  action: "add-event", org: "At the hospital", partnerId: "p_riddle",
  venue: "Riddle Hospital", cost: 0, division: "Private Pay",
});
const riskyOpp = opps.find((o) => o.name === "At the hospital");
ok("🔴 created", risky.status === 200, risky.body);
ok("🔴 and NOT attached to the Riddle Hospital PARTNER contact",
   riskyOpp && riskyOpp.contactId !== "p_riddle", riskyOpp);
console.log("     ⚠️ that is the exact bug this item removes, reintroduced by a name match.");

// ═══ 3 · DELETE A CASE ════════════════════════════════════════════════════
console.log("\n3 · 🔴 A RECORD HAD NO DELETE — AND IT IS ADMIN ONLY");
const repTry = await del("ev_spring", REP);
console.log(`  as a rep -> ${repTry.status} ${repTry.body.error}`);
ok("🔴 a rep is refused", repTry.status === 403, repTry.body);
ok("⚠️ as a refusal, not a fault", repTry.body.refusal === true, repTry.body);
ok("and it points at Mark lost, with the reason", /lost with a reason/i.test(repTry.body.detail || ""),
   repTry.body.detail);
ok("🔴 and nothing was deleted", opps.some((o) => o.id === "ev_spring"), opps.map((o) => o.id));

const before = opps.length;
const gone = await del("ev_spring", ADMIN);
console.log(`  as an admin -> ${gone.status} ${JSON.stringify(gone.body)}`);
ok("an admin's delete succeeds", gone.status === 200 && gone.body.ok === true, gone.body);
ok("it names what went", gone.body.name === "Spring Expo", gone.body);
ok("the opportunity is gone", opps.length === before - 1, opps.map((o) => o.id));
ok("🔴 and the CONTACT is untouched — the case, not the person",
   contacts.some((c) => c.id === "c_delco"), contacts.map((c) => c.id));

const again = await del("ev_spring", ADMIN);
console.log(`  deleted twice -> ${again.status} ${again.body.error || "ok"}`);
ok("⚠️ a second delete does not report a failure about a record that is gone",
   again.status === 404, again.body);
ok("and it says so plainly", /no longer exists/i.test(again.body.error || ""), again.body.error);

// ⚠️ THE `is deleted` SHAPE ITSELF, driven at the library so the 400-as-success
// path is exercised rather than only the 404 above.
const G = await import("../lib/ghl.ts");
let threw = null;
try { await G.deleteOpportunity("ev_never"); } catch (e) { threw = e; }
ok("🔴 GoHighLevel's 400 \"is deleted\" is treated as success, as round 118 measured",
   threw === null, threw && String(threw.message));

// ═══ 4 · DELETING AN EVENT LEAVES ITS ATTENDEES ═══════════════════════════
console.log("\n4 · 🔴 THE ATTENDEES ARE NOT DELETED — AND THEY ARE COUNTED");
const p1 = await payload();
const orphans = p1.body.attendees.filter(
  (a) => a.eventId && !p1.body.events.some((e) => e.id === a.eventId));
console.log(`  attendees still pointing at the deleted Spring Expo: ${orphans.length}`);
ok("🔴 both attendees survive the event's deletion",
   p1.body.attendees.filter((a) => ["a_dana", "a_ivy"].includes(a.id)).length === 2,
   p1.body.attendees);
ok("⚠️ their Event Attended still names the deleted event — dangling, not erased",
   orphans.length === 2, orphans);
console.log("     ⚠️ clearing it would be a write to every attendee that can half-fail,");
console.log("     and it would erase the only evidence they were met at all. So the");
console.log("     screen COUNTS them, the way a referral whose partner was deleted is.");
const rs = readFileSync("components/ReferralsSection.tsx", "utf8");
ok("and the caveat box counts them", /recorded at an event that no longer exists/.test(rs),
   "no orphan caveat");

// ═══ ATTENDEE REMOVE ══════════════════════════════════════════════════════
console.log("\n+ · 🔴 A ROW ADDED IN ERROR COULD NOT BE TAKEN OFF");
// 🔴 AND THE ROUTE IT USED TO CALL COULD NEVER HAVE WORKED. `[id]` there is
// an OPPORTUNITY id — gate() reads getOpportunityById(id) and borrows that
// record's permission — and an attendee is a contact with no opportunity. So
// the Event Outcome dropdown answered 404 on every change, and had since it
// shipped. Proven by calling it the old way first:
const contactsRoute = await import("../app/api/contacts/[id]/fields/route.ts");
const oldWay = await contactsRoute.PATCH(
  new Request("http://x/api/contacts/a_dana/fields", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoKey: ADMIN, fields: [{ id: EVATT, value: "" }] }),
  }),
  { params: Promise.resolve({ id: "a_dana" }) },
);
console.log(`  the OLD call (/api/contacts/{contactId}/fields) -> ${oldWay.status}`);
ok("🔴 the route the outcome dropdown used answers 404 for an attendee",
   oldWay.status === 404, oldWay.status);
const patch = await post({
  action: "attendee-field", contactId: "a_dana", field: "event", value: "",
});
const dana = contacts.find((c) => c.id === "a_dana");
console.log(`  -> ${patch.status} · Dana's Event Attended is now ${JSON.stringify(
  (dana.customFields || []).find((f) => f.id === EVATT)?.value)}`);
ok("clearing Event Attended succeeds", patch.status === 200, patch.body);
ok("⚠️ and a contact that is NOT an attendee is refused — this is not a way to write any contact",
   (await post({ action: "attendee-field", contactId: "p_riddle", field: "outcome", value: "Legit lead" })).status === 409,
   "a partner was writable");
ok("🔴 the field is empty", ((dana.customFields || []).find((f) => f.id === EVATT)?.value ?? "") === "",
   dana.customFields);
ok("🔴 and the CONTACT is intact — name, record type, everything else",
   dana.contactName === "Dana Ruiz" &&
   (dana.customFields || []).some((f) => f.id === RT && f.value === "Event Attendee"), dana);

// ═══ 5 · THE ATTRIBUTION BUTTON ═══════════════════════════════════════════
console.log("\n5 · ⚠️ A FINISHED MIGRATION IS NOT A CONTROL");
const admin = await import("../app/api/admin/pipelines/route.ts");
const stillThere = await admin.POST(
  new Request("http://x/api/admin/pipelines", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoKey: ADMIN, action: "attribution-folder", step: "folder" }),
  }),
);
console.log(`  POST action:"attribution-folder" -> ${stillThere.status}`);
ok("🔴 the endpoint no longer performs it", stillThere.status >= 400, stillThere.status);
const pa = readFileSync("components/PipelineAdmin.tsx", "utf8");
ok("the button is gone", !/Create Referral Attribution and move the fields/.test(pa), "still there");
ok("⚠️ and so is its dead code — an unused migration is the same hazard, one layer down",
   !/runAttribution/.test(pa.replace(/\/\*[\s\S]*?\*\//g, "")), "runAttribution survives");
ok("🔴 but the REASONING is kept, which is the part that stops somebody undoing it",
   /so attribution can be shown on a client record without/.test(pa), "the sentence is gone");

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
