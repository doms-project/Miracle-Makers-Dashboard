// ---------------------------------------------------------------------------
// ROUND 166 — A CONTACT THAT HAS ONLY A NAME.
//
// 🔴 THE FAKE ANSWERS EXACTLY AS GOHIGHLEVEL DOES, PROBED LIVE ON 1 OCTOBER,
// AND THE TWO ENDPOINTS HAVE DIFFERENT RULES:
//
//   POST /contacts/upsert  needs a DEDUPLICATION KEY
//                          -> 400 "Pass at least one of number, email query parameter"
//   POST /contacts/        needs ONE OF FOUR IDENTIFYING FIELDS
//                          -> 422 "Contacts without email, phone, firstName
//                                  and lastName are not allowed."
//   POST /contacts/  { firstName }  -> created
//
// ⚠️ `name` COUNTS FOR NEITHER, and that is the whole bug. Round 124 made the
// event's VENUE a contact and created it with `upsertContact({ name })`, so
// "Add an event" has failed for every new venue since the day it shipped.
//
// 🔴 AND THE HARNESS IS WHY NOBODY SAW IT. round124-proof's fake accepted a
// name-only upsert and answered 200 — rule 1, in the file whose own banner
// quotes rule 1. The correct refusal had existed in round133-proof and
// round134-proof since round 133 and was never swept across.
//
// Run: npx tsx scripts/contact-create-proof.mjs
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
const EV = "pipe_events";
const CLIENT = "pipe_oltl";
/** The stored pipeline config, mutated by the route's own writes. */
let cfg = JSON.stringify({
  seeded: true, folderNames: {},
  pipelines: {
    [CLIENT]: { scope: "client", folders: [] },
    [EV]: { scope: "client", folders: [], role: "events" },
  },
});
const RT = "F_RT", EVATT = "F_EVATT", EVOUT = "F_EVOUT";
const EVDATE = "F_EVDATE", EVCOST = "F_EVCOST", EVVEN = "F_EVVEN", EVDIV = "F_EVDIV";
const HOST = "F_HOST", CAT = "F_CAT", TIER = "F_TIER", PDIV = "F_PDIV";

const ADMIN = CryptoJS.AES.encrypt(
  JSON.stringify({
    userId: "u_admin", role: "admin", type: "agency", activeLocation: LOC,
    userName: "Admin", email: "a@e.com", companyId: "co1",
  }),
  SECRET,
).toString();

// ── the account ────────────────────────────────────────────────────────────
// 🔴 "Riddle Hospital" IS A PARTNER *AND* A PLAUSIBLE VENUE NAME. That overlap
// is the reason the venue path carries an exclusion list, so the fixture has to
// contain it or §3 proves nothing.
let contacts = [
  { id: "p_riddle", contactName: "Riddle Hospital", email: "d@riddle.org", phone: "",
    customFields: [{ id: RT, value: "Referral Partner" }] },
  // An existing venue contact, for the reuse path.
  { id: "v_delco", contactName: "Delco Expo Centre", email: "", phone: "",
    customFields: [] },
];
let opps = [];
/** Every contact write the route made, in order, with the endpoint it used. */
const writes = [];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const j = raw ? JSON.parse(raw) : null;
    const [path] = req.url.split("?");
    const send = (code, o) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };

    if (path === "/users/") return send(200, { users: [{ id: "u_admin", name: "Admin" }] });
    // 🔴 A REAL STORED CONFIG, AND MY FOURTH TIME LEARNING THIS. `customValues:
    // []` makes the route try to SEED one, write it, fail to read its own write
    // back, and throw a 502 that has nothing to do with contacts — so every
    // assertion downstream measures the fixture instead of the feature. Rule 3:
    // a fixture that stops reaching the feature is green on nothing. Rounds
    // 149, 155 and 163 each cost a cycle to this exact shape.
    if (path === `/locations/${LOC}/customValues` && req.method === "GET")
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders", value: cfg }] });
    if (/^\/locations\/[^/]+\/customValues\/[^/]+$/.test(path) && req.method === "PUT") {
      if (j?.value) cfg = j.value;
      return send(200, { customValue: { id: "cv1" } });
    }
    if (path === `/locations/${LOC}/customFields`) {
      const model = /model=contact/.test(req.url) ? "contact" : "opportunity";
      return send(200, {
        customFields: model === "contact"
          ? [{ id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS", picklistOptions: ["Referral Partner", "Event Attendee"] },
             { id: CAT, name: "Partner Category", dataType: "TEXT" },
             { id: TIER, name: "Partner Tier", dataType: "TEXT" },
             { id: PDIV, name: "Partner Division", dataType: "TEXT" },
             { id: EVATT, name: "Event Attended", dataType: "TEXT" },
             { id: EVOUT, name: "Event Outcome", dataType: "TEXT" }]
          : [{ id: HOST, name: "Event Host", dataType: "TEXT" },
             { id: EVDATE, name: "Event Date", dataType: "DATE" },
             { id: EVCOST, name: "Event Cost", dataType: "MONETORY" },
             { id: EVVEN, name: "Event Venue", dataType: "TEXT" },
             { id: EVDIV, name: "Event Division", dataType: "SINGLE_OPTIONS", picklistOptions: ["ODP", "OLTL"] }],
      });
    }
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        // ⚠️ A CLIENT PIPELINE TOO. §4 files a real referral, and without one
        // the route refuses for want of a pipeline — a refusal that looks
        // exactly like the contact refusal it is meant to be distinguishing.
        { id: CLIENT, name: "OLTL Enrollment", stages: [{ id: "c_s1", name: "NEW LEAD", position: 0 }] },
        { id: EV, name: "Events", stages: [{ id: "s1", name: "Held", position: 0 }] },
      ] });
    if (path === "/opportunities/search") {
      const pid = new URL(req.url, "http://x").searchParams.get("pipeline_id") || "";
      const rows = pid ? opps.filter((o) => o.pipelineId === pid) : opps;
      return send(200, { opportunities: rows, meta: { total: rows.length } });
    }
    if ((path === "/opportunities" || path === "/opportunities/") && req.method === "POST") {
      // ⚠️ THE ONE-PER-CONTACT-PER-PIPELINE RULE, as round 124 established it.
      if (opps.some((o) => o.contactId === j.contactId && o.pipelineId === j.pipelineId))
        return send(400, { message: "Opportunity already exists for this contact in this pipeline" });
      const id = `o${opps.length + 1}`;
      opps.push({ id, ...j, customFields: j.customFields || [] });
      return send(200, { opportunity: { id } });
    }

    if (path === "/contacts/search") {
      if (j?.query) {
        const needle = String(j.query).toLowerCase();
        const hits = contacts.filter((c) => c.contactName.toLowerCase().includes(needle));
        return send(200, { contacts: hits, total: hits.length });
      }
      const want = j?.filters?.[0]?.value;
      const hits = contacts.filter((c) =>
        (c.customFields || []).some((f) => f.id === RT && f.value === want));
      return send(200, { contacts: hits, total: hits.length });
    }

    // ═══ GOHIGHLEVEL'S TWO CONTACT RULES ════════════════════════════════════
    if (path === "/contacts/upsert" && req.method === "POST") {
      writes.push({ endpoint: "upsert", body: j });
      // 🔴 A DEDUPLICATION KEY OR NOTHING. `name` does not count.
      if (!j?.email && !j?.phone)
        return send(400, { message: "Pass at least one of number, email query parameter" });
      const hit = contacts.find(
        (c) => (j.email && c.email === j.email) || (j.phone && c.phone === j.phone));
      const id = hit?.id || `c_up${contacts.length + 1}`;
      if (!hit)
        contacts.push({ id, contactName: j.name || "", email: j.email || "",
                        phone: j.phone || "", customFields: j.customFields || [] });
      return send(200, { contact: { id }, new: !hit });
    }
    if (path === "/contacts/" && req.method === "POST") {
      writes.push({ endpoint: "create", body: j });
      // 🔴 ONE OF FOUR. `name` is not one of them — that is the live finding.
      if (!j?.email && !j?.phone && !j?.firstName && !j?.lastName)
        return send(422, {
          message: "Contacts without email, phone, firstName and lastName are not allowed.",
        });
      const id = `c_made${contacts.length + 1}`;
      contacts.push({
        id,
        contactName: [j.firstName, j.lastName].filter(Boolean).join(" ") || j.name || "",
        email: j.email || "", phone: j.phone || "", customFields: j.customFields || [],
      });
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
process.env.PIPELINE_ROLES = JSON.stringify({ [EV]: "events" });
delete process.env.WEBHOOK_URL;

const referrals = await import("../app/api/referrals/route.ts");
const G = await import("../lib/ghl.ts");

const post = async (payload) => {
  writes.length = 0;
  const r = await referrals.POST(
    new Request("http://x/api/referrals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ssoKey: ADMIN, ...payload }),
    }),
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ═══════════════════════════════════════════════════════════════════════════
console.log("═══ 1 · THE FAKE REFUSES WHAT GOHIGHLEVEL REFUSES ═══");
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE HARNESS IS ASSERTED BEFORE ANYTHING ELSE. Every assertion below rests
// on these three answers being GoHighLevel's, and a fake that quietly accepted
// a keyless contact would make the whole file green on a broken product — which
// is precisely what happened for forty-two rounds.
let threw = null;
try { await G.upsertContact({ name: "Nameless Place" }); } catch (e) { threw = e; }
ok("🔴 upsert with a name only is REFUSED 400",
  threw?.status === 400 && /number, email query parameter/.test(threw?.detail || ""), threw?.detail);

threw = null;
try { await G.createContact({ firstName: "", lastName: "", name: "" }); } catch (e) { threw = e; }
ok("create with nothing at all is refused before it is sent",
  threw?.status === 400 && /none of firstName/.test(threw?.detail || ""), threw?.detail);

const made = await G.createContact({ name: "Brand New Venue" });
ok("🔴 create with the name sent as firstName SUCCEEDS", !!made.id, made);
ok("…and it really went to /contacts/, not to the upsert",
  writes.at(-1)?.endpoint === "create", writes.at(-1));
ok("🔴 …carrying firstName, which is the field that counts",
  writes.at(-1)?.body?.firstName === "Brand New Venue", writes.at(-1)?.body);
ok("⚠️ and the name is NOT split across firstName/lastName",
  !writes.at(-1)?.body?.lastName, writes.at(-1)?.body);

// 🔴 THE CONTROL FOR THE 422 ITSELF. createContact refuses locally, so the
// fake's 422 branch would never be reached — and an unreached branch is not a
// proven one. This drives the endpoint directly.
const direct = await fetch(`${process.env.GHL_API_BASE}/contacts/`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ locationId: LOC, name: "Only A Name" }),
});
ok("🔴 CONTROL — /contacts/ with `name` alone really does 422", direct.status === 422, direct.status);
ok("…with GoHighLevel's wording",
  /Contacts without email, phone, firstName and lastName/.test(JSON.stringify(await direct.json())));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 2 · PATH 1 — THE VENUE (add-event) ═══");
// ═══════════════════════════════════════════════════════════════════════════
const ev = await post({
  action: "add-event", org: "Spring Fair", venue: "Brandywine Hall",
  partnerId: "p_riddle", eventDate: "2027-03-14", cost: 650, division: "OLTL",
});
ok("🔴 a NEW venue with no phone and no email is accepted", ev.status === 200, ev);
ok("…the event was created", !!ev.body.eventId, ev.body);
ok("🔴 …and the contact came from /contacts/, not the upsert",
  writes.some((w) => w.endpoint === "create") && !writes.some((w) => w.endpoint === "upsert"),
  writes.map((w) => w.endpoint));
ok("the route says which path it took", ev.body.venueContact === "created", ev.body);

// ⚠️ THE REUSE PATH, IN THE SAME RUN. "created" above is only meaningful if
// "reused" is reachable — otherwise the field is a constant.
const ev2 = await post({
  action: "add-event", org: "Autumn Fair", venue: "Delco Expo Centre",
  eventDate: "2027-10-01", division: "OLTL",
});
ok("⚠️ an EXISTING venue contact is reused, not duplicated",
  ev2.status === 200 && ev2.body.venueContact === "reused", ev2.body);
ok("…and nothing was written to either contact endpoint", writes.length === 0, writes);

// 🔴 NEVER REUSE A PARTNER. "Riddle Hospital" is a partner; as a venue it must
// get its own contact.
const ev3 = await post({
  action: "add-event", org: "Discharge Day", venue: "Riddle Hospital",
  eventDate: "2027-05-02", division: "OLTL",
});
ok("🔴 a venue named like a PARTNER gets its own contact, never the partner's",
  ev3.status === 200 && ev3.body.venueContactId !== "p_riddle", ev3.body);
ok("…which means it was created", ev3.body.venueContact === "created", ev3.body);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 3 · PATH 2 — ADD PARTNER · PATH 3 — PERSON MET ═══");
// ═══════════════════════════════════════════════════════════════════════════
const p = await post({
  action: "add-partner", org: "Main Line Health", category: "Hospital discharge",
  // ⚠️ ROUND 167 — A DIVISION IS NOW REQUIRED SERVER-SIDE. Round 143 required
  // it in the dialog only, so the route still accepted a blank and a direct
  // call could create the visible-to-everyone partner the rule exists to stop.
  // These assertions are about the CONTACT endpoint; without a division they
  // would measure the division rule instead.
  division: "ODP",
});
ok("🔴 a partner org with a name only is accepted", p.status === 200, p);
ok("…via /contacts/", writes.at(-1)?.endpoint === "create", writes.map((w) => w.endpoint));
ok("…with the org in firstName", writes.at(-1)?.body?.firstName === "Main Line Health",
  writes.at(-1)?.body);

// 🔴 ROUND 173 — THIS CONTROL ASSERTED THE BUG, AND IT WAS RIGHT UNTIL IT WAS
// NOT. It read "with an email it upserts instead, so duplicates still merge" —
// and merging is exactly what renamed a contact created seconds earlier,
// because the pre-check that was supposed to prevent it read a search index
// lagging by up to a minute. The dedup now comes from the create's own
// duplicate refusal, which is instant.
//
// ⚠️ THE CONTROL'S JOB IS UNCHANGED: a key must take a DIFFERENT path from a
// name-only add, or "via /contacts/" above would be satisfied by every add
// going the same way. It still does — the difference is now the refusal, not
// the endpoint — so this asserts the endpoint is never the merging one.
const p2 = await post({
  action: "add-partner", org: "Bryn Mawr Rehab", email: "refer@bmr.org", division: "ODP",
});
ok("🔴 ROUND 173 — with an email it creates and NEVER upserts",
  p2.status === 200 && writes.at(-1)?.endpoint === "create" &&
  !writes.some((w) => w.endpoint === "upsert"), writes.map((w) => w.endpoint));

const a = await post({
  action: "add-attendee", eventId: "ev1", firstName: "Nina", outcome: "Warm",
});
ok("🔴 someone met at an event, name only, is accepted", a.status === 200, a);
ok("…via /contacts/", writes.at(-1)?.endpoint === "create", writes.map((w) => w.endpoint));

const a2 = await post({
  action: "add-attendee", eventId: "ev1", firstName: "Omar", phone: "610-555-7777",
});
// 🔴 ROUND 173 — same correction, attendee side. A phone no longer sends this
// through the merging endpoint; the create's refusal is what deduplicates.
ok("🔴 ROUND 173 — with a phone the attendee creates, and never upserts",
  a2.status === 200 && writes.at(-1)?.endpoint === "create" &&
  !writes.some((w) => w.endpoint === "upsert"), writes.map((w) => w.endpoint));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 3b · 🔴 A PERSON'S NAME IS NOT AN IDENTITY ═══");
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 TWO PEOPLE CALLED NINA ARE TWO PEOPLE. Reusing on a first-name match would
// file the second one's outcome onto the first one's record — a wrong merge,
// which is worse than a visible duplicate. The attendee added in §3 is already
// in the account under that name, so this second add is the real collision.
const a3 = await post({
  action: "add-attendee", eventId: "ev2", firstName: "Nina", outcome: "Cold",
});
ok("🔴 a second attendee with the SAME first name gets a NEW contact",
  a3.status === 200 && writes.at(-1)?.endpoint === "create", writes.map((w) => w.endpoint));
ok("…and it is a different contact id from the first Nina",
  a3.body.contactId && a3.body.contactId !== a.body.contactId,
  { first: a.body.contactId, second: a3.body.contactId });

// ⚠️ THE PAIRED CONTROL, IN THE SAME RUN. "never reuse" is satisfied by a
// `nameIdentifies` that is false everywhere — which would silently bring back
// one venue contact per event. The same repeated name on a VENUE must reuse.
const ev4 = await post({
  action: "add-event", org: "Winter Fair", venue: "Brandywine Hall",
  eventDate: "2027-12-01", division: "OLTL",
});
ok("🔴 CONTROL — a repeated VENUE name DOES reuse, so the flag is not false everywhere",
  ev4.body.venueContact === "reused" || /already hosts an event/.test(ev4.body.error || ""),
  ev4.body);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 4 · ⚠️ LOG A REFERRAL IS DELIBERATELY UNCHANGED ═══");
// ═══════════════════════════════════════════════════════════════════════════
// ═══ ROUND 167 — THE DECISION IS MADE, AND THIS ASSERTION CHANGES WITH IT ════
//
// 🔴 ROUND 166 PINNED THIS AS AN OPEN QUESTION: it asserted only that a keyless
// referral "still fails", through GoHighLevel's refusal, because whether a
// CLIENT may exist with no way to contact them was the owner's call. The answer
// is no — someone we will ring or email needs a number or an address.
//
// ⚠️ SO THE CLAIM IS STRONGER NOW, NOT MERELY DIFFERENT. It is no longer "GHL
// happens to reject it" but "we refuse it ourselves, by name, before any call
// is made" — which is what makes the message readable instead of being about a
// query parameter the dialog does not have.
const noKey = await post({
  action: "log-referral", partnerId: "p_riddle", firstName: "Keyless", division: "OLTL",
});
ok("🔴 a client referral with no phone and no email is REFUSED", noKey.status === 400, noKey);
ok("…with the sentence that names what is missing",
  /way to reach them/i.test(noKey.body.error || ""), noKey.body);
ok("…and it says nothing was created",
  /Nothing was created/i.test(noKey.body.detail || ""), noKey.body);
ok("🔴 …BEFORE ANY GOHIGHLEVEL CONTACT CALL — the refusal is ours, not theirs",
  writes.length === 0, writes.map((w) => w.endpoint));

const withKey = await post({
  action: "log-referral", partnerId: "p_riddle", firstName: "Reachable",
  phone: "610-555-0199", division: "OLTL",
});
ok("🔴 CONTROL — the same referral WITH a phone is accepted, so the fixture reaches the feature",
  withKey.status === 200, withKey);

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
