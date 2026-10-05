// ---------------------------------------------------------------------------
// ROUND 171 — ROLES FROM FACTS, NEVER OVERWRITING SOMEONE, AND THE MOVES SCREEN.
//
// 🔴 THE FAKE'S RECORD TYPES ARE THE LIVE DISTRIBUTION, NOT A TIDY ONE. Probed
// 1 October: of 120 contacts holding a client case, 118 have NO Record Type,
// two say "Caregiver", and none says "Client". A fixture where every client is
// labelled "Client" would make item 1 pass against the bug — the picker would
// find them by a label that does not exist on the real account. So the client
// here carries NOTHING, and the one contact with a client case AND a Record
// Type carries "Caregiver", because that is what the probe found.
//
// 🔴 AND THE UPSERT RENAMES, BECAUSE GOHIGHLEVEL DOES. `/contacts/upsert`
// matches on phone or email and writes the name it is given. A fake that
// merged politely would be rule 1 — answering something GoHighLevel refuses to
// — and item 4 would be green against the bug it exists to catch.
//
// Run: npx tsx scripts/round171-proof.mjs
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
const P_CG = "pipe_cg";
const P_EVENTS = "pipe_events";
const RT = "F_RT";          // Record Type
const EV = "F_EVENT";       // Event Attended
const OUT = "F_OUTCOME";
const PROF = "F_PROFILE";
const DIV = "F_PDIV";
const CAT = "F_PCAT";
const TIER = "F_PTIER";
const PNOTES = "F_PNOTES";
const EVDATE = "F_EVDATE";
const EVDIV = "F_EVDIV";

const ADMIN = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Admin", email: "a@e.com", companyId: "co1",
}), SECRET).toString();

// ── the account ────────────────────────────────────────────────────────────
// 🔴 EVERY PHONE HERE IS DISTINCT EXCEPT ONE SHARED PAIR, and that pair is the
// whole of item 4. Reusing one value for two roles is rule 4.
const contacts = {
  // 118-of-120 shape: a client with a case and NO Record Type.
  c_clara: { id: "c_clara", firstName: "Clara", lastName: "Client",
             phone: "+14845550111", email: "clara@e.test", customFields: [] },
  // the 2-of-120 shape: holds a client case AND says "Caregiver".
  c_mixed: { id: "c_mixed", firstName: "Morgan", lastName: "Mixed",
             phone: "+14845550112", customFields: [{ id: RT, value: "Caregiver" }] },
  // a caregiver with no client case — must NEVER appear in the Clients picker.
  c_gavin: { id: "c_gavin", firstName: "Gavin", lastName: "Giver",
             phone: "+14845550113", customFields: [{ id: RT, value: "Caregiver" }] },
  // a partner.
  c_riddle: { id: "c_riddle", firstName: "Riddle Hospital",
              phone: "+14845550114",
              customFields: [{ id: RT, value: "Referral Partner" }, { id: DIV, value: "OLTL" }] },
  // 🔴 AN ATTENDEE WHO LATER BECAME A CAREGIVER. Record Type says Caregiver,
  // Event Attended still points at the event. The whole of item 2.
  c_nina: { id: "c_nina", firstName: "Nina", lastName: "Novak",
            phone: "+14845550115",
            customFields: [{ id: RT, value: "Caregiver" }, { id: EV, value: "o_event" }] },
  // a plain attendee, so the Record Type half of the union still earns its place.
  c_pat: { id: "c_pat", firstName: "Pat", lastName: "Plain",
           phone: "+14845550116",
           customFields: [{ id: RT, value: "Event Attendee" }] },
  // 🔴 THE SHARED FAMILY PHONE. Mary Ann is who gets renamed if item 4 fails.
  c_mary: { id: "c_mary", firstName: "Mary", lastName: "Ann Smith",
            phone: "+14845550199", email: "mary@e.test",
            customFields: [{ id: RT, value: "Caregiver" }] },
};
const opps = {
  o_clara: { id: "o_clara", name: "Clara Client", pipelineId: P_CLIENT,
             pipelineStageId: "c_s1", contactId: "c_clara", assignedTo: "u1",
             status: "open", createdAt: "2026-01-02T00:00:00.000Z", customFields: [] },
  o_mixed: { id: "o_mixed", name: "Morgan Mixed", pipelineId: P_CLIENT,
             pipelineStageId: "c_s1", contactId: "c_mixed", assignedTo: "u1",
             status: "open", createdAt: "2026-01-03T00:00:00.000Z", customFields: [] },
  o_gavin: { id: "o_gavin", name: "Gavin Giver", pipelineId: P_CG,
             pipelineStageId: "g_s1", contactId: "c_gavin", assignedTo: "u1",
             status: "open", createdAt: "2026-01-04T00:00:00.000Z", customFields: [] },
  o_event: { id: "o_event", name: "Delco Expo", pipelineId: P_EVENTS,
             pipelineStageId: "e_s1", contactId: "c_riddle", assignedTo: "u1",
             status: "open", createdAt: "2026-02-01T00:00:00.000Z",
             customFields: [{ id: EVDATE, fieldValueString: "2026-02-10" },
                            { id: EVDIV, fieldValueString: "OLTL" }] },
};
let relations = [];
let relSeq = 0;
/** 🔴 THE PROBE'S ANSWER, FLIPPED BY THE PROOF. See §2b. */
let existsSupported = true;
/** Every write the fake received, so "nothing was written" is checkable. */
const writes = [];

const cfg = JSON.stringify({
  seeded: true, folderNames: {},
  pipelines: {
    [P_CLIENT]: { scope: "client", folders: [] },
    [P_CG]: { scope: "caregiver", folders: [], group: "caregiver" },
    [P_EVENTS]: { scope: "none", folders: [], role: "events" },
  },
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
    if (req.method !== "GET" && path !== "/contacts/search")
      writes.push({ method: req.method, path, body: j });

    if (path === "/users/") return send(200, { users: [{ id: "u1", name: "Dana Ruiz" }] });
    if (path === `/locations/${LOC}/customValues`)
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders", value: cfg }] });
    if (path === `/locations/${LOC}/customFields`)
      return send(200, { customFields: /model=contact/.test(req.url)
        ? [
            { id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS",
              picklistOptions: ["Caregiver", "Client", "Referral Partner", "Event Attendee"] },
            { id: EV, name: "Event Attended", dataType: "TEXT" },
            { id: OUT, name: "Event Outcome", dataType: "SINGLE_OPTIONS", picklistOptions: ["Warm"] },
            { id: PROF, name: "Attendee Profile", dataType: "TEXT" },
            { id: DIV, name: "Partner Division", dataType: "SINGLE_OPTIONS", picklistOptions: ["OLTL", "ODP"] },
            { id: CAT, name: "Partner Category", dataType: "SINGLE_OPTIONS", picklistOptions: ["Hospital discharge"] },
            { id: TIER, name: "Partner Tier", dataType: "SINGLE_OPTIONS", picklistOptions: ["A", "Prospect"] },
            { id: PNOTES, name: "Partner Notes", dataType: "LARGE_TEXT" },
          ]
        : [
            { id: EVDATE, name: "Event Date", dataType: "DATE" },
            { id: EVDIV, name: "Event Division", dataType: "SINGLE_OPTIONS", picklistOptions: ["OLTL", "ODP"] },
          ] });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        { id: P_CLIENT, name: "OLTL Enrollment", stages: [{ id: "c_s1", name: "NEW LEAD", position: 0 }] },
        { id: P_CG, name: "OLTL Caregiver Applicants", stages: [{ id: "g_s1", name: "NEW", position: 0 }] },
        { id: P_EVENTS, name: "Events", stages: [{ id: "e_s1", name: "PLANNED", position: 0 }] },
      ] });
    if (path === "/opportunities/search") {
      const pid = url.searchParams.get("pipeline_id") || "";
      const cid = url.searchParams.get("contact_id") || "";
      const rows = Object.values(opps).filter(
        (o) => (!pid || o.pipelineId === pid) && (!cid || o.contactId === cid),
      );
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
    if (path === "/opportunities/" && req.method === "POST")
      return send(200, { opportunity: { id: `o_new${++relSeq}` } });

    if (path === `/associations/${ASSOC}`)
      return send(200, { association: {
        id: ASSOC, firstObjectLabel: "Caregiver", secondObjectLabel: "Client",
      } });
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

    // ── contacts ───────────────────────────────────────────────────────────
    if (path === "/contacts/search") {
      const filters = j?.filters || [];
      if (filters.length) {
        const f = filters[0];
        const fid = String(f.field || "").replace("customFields.", "");
        // 🔴 THE `exists` OPERATOR — AND THE FAKE REFUSES IT ON DEMAND. This
        // codebase has only ever sent `eq`; whether GoHighLevel takes `exists`
        // is UNPROVEN, so the proof runs both answers rather than picking one.
        if (f.operator === "exists") {
          if (!existsSupported)
            return send(400, { message: "filters[0].operator is not supported" });
          const rows = Object.values(contacts).filter((c) => cfOf(c)[fid]);
          return send(200, { contacts: rows, total: rows.length });
        }
        const rows = Object.values(contacts).filter((c) => cfOf(c)[fid] === f.value);
        return send(200, { contacts: rows, total: rows.length });
      }
      const q = String(j?.query || "").toLowerCase();
      // ⚠️ A CANDIDATE GENERATOR, LIKE THE REAL ONE: it matches substrings of
      // the name, the phone and the email, and it is the caller's job to
      // decide whether a hit is the same person.
      const rows = Object.values(contacts).filter((c) =>
        `${c.firstName || ""} ${c.lastName || ""} ${c.phone || ""} ${c.email || ""}`
          .toLowerCase().includes(q));
      return send(200, { contacts: rows, total: rows.length });
    }
    if (path === "/contacts/upsert" && req.method === "POST") {
      // 🔴 MATCHES ON PHONE OR EMAIL AND WRITES THE NAME IT IS GIVEN. This is
      // the behaviour item 4 is about; a fake that refused to rename would
      // make the fix untestable.
      const hit = Object.values(contacts).find(
        (c) => (j.phone && c.phone === j.phone) || (j.email && c.email === j.email));
      if (hit) {
        Object.assign(hit, {
          firstName: j.firstName ?? hit.firstName,
          lastName: j.lastName ?? hit.lastName,
        });
        for (const f of j.customFields || []) {
          const cur = hit.customFields.find((x) => x.id === f.id);
          if (cur) cur.value = f.value; else hit.customFields.push({ id: f.id, value: f.value });
        }
        return send(200, { contact: { id: hit.id }, new: false });
      }
      const id = `c_new${++relSeq}`;
      contacts[id] = { id, firstName: j.firstName || j.name || "", lastName: j.lastName || "",
                       phone: j.phone || "", email: j.email || "",
                       customFields: (j.customFields || []).map((f) => ({ ...f })) };
      return send(200, { contact: { id }, new: true });
    }
    if (path === "/contacts/" && req.method === "POST") {
      const id = `c_new${++relSeq}`;
      contacts[id] = { id, firstName: j.firstName || "", lastName: j.lastName || "",
                       phone: j.phone || "", email: j.email || "",
                       customFields: (j.customFields || []).map((f) => ({ ...f })) };
      return send(200, { contact: { id } });
    }
    if (/^\/contacts\/[^/]+\/notes/.test(path)) {
      if (req.method === "POST") return send(200, { note: { id: "n1" } });
      return send(200, { notes: [] });
    }
    if (/^\/contacts\/[^/]+\/tags/.test(path)) return send(200, { tags: [] });
    if (/^\/contacts\/[^/]+$/.test(path)) {
      const id = path.split("/")[2];
      const c = contacts[id];
      if (!c) return send(404, { message: "not found" });
      if (req.method === "PUT") {
        for (const f of j.customFields || []) {
          const cur = c.customFields.find((x) => x.id === f.id);
          if (cur) cur.value = f.value; else c.customFields.push({ id: f.id, value: f.value });
        }
        if (j.firstName !== undefined) c.firstName = j.firstName;
        if (j.lastName !== undefined) c.lastName = j.lastName;
        return send(200, { contact: c });
      }
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
// ⚠️ NO `GHL_` PREFIX — lib/ghl.ts:247. Rule 7 cost round 170 a whole section.
process.env.CAREGIVER_ASSOCIATION_ID = ASSOC;
delete process.env.PIPELINE_ACCESS_MAP;
delete process.env.WEBHOOK_URL;

const G = await import("../lib/ghl.ts");
const { stageKpi, CREATION_WINDOW_MS } = await import("../lib/stageKpi.ts");
const refRoute = await import("../app/api/referrals/route.ts");
const cgRoute = await import("../app/api/opportunities/[id]/caregivers/route.ts");
const searchRoute = await import("../app/api/opportunities/[id]/caregivers/search/route.ts");
const clientsRoute = await import("../app/api/clients/route.ts");
const applicantsRoute = await import("../app/api/caregivers/route.ts");

const ctx = (id) => ({ params: Promise.resolve({ id }) });
const nameOf = (id) => `${contacts[id].firstName} ${contacts[id].lastName}`.trim();
const rtOf = (id) => cfOf(contacts[id])[RT] || "";
const post = async (mod, url, body) => {
  const r = await mod.POST(new Request(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoKey: ADMIN, ...body }),
  }));
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ═══════════════════════════════════════════════════════════════════════════
console.log("═══ 1 · 🔴 THE CLIENTS PICKER FINDS A CASE, NOT A LABEL ═══");
// ═══════════════════════════════════════════════════════════════════════════
const pick = async (oppId, q) => {
  const r = await searchRoute.GET(
    new Request(`http://x/api/opportunities/${oppId}/caregivers/search?q=${encodeURIComponent(q)}`,
      { headers: { "x-ghl-sso-key": ADMIN } }),
    ctx(oppId),
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ⚠️ ON THE CAREGIVER'S OWN RECORD. This is the panel that read "Clients" and
// searched caregivers.
const cl = await pick("o_gavin", "Clara");
ok("the caregiver's panel searches the CLIENT side", cl.body.role === "client", cl.body);
ok("🔴 it finds Clara, who has NO Record Type at all",
  cl.body.results?.some((r) => r.id === "c_clara"), cl.body.results);
ok("…and says which case puts her there",
  cl.body.results?.[0]?.pipelineName === "OLTL Enrollment" &&
  cl.body.results?.[0]?.stage === "NEW LEAD", cl.body.results?.[0]);

// 🔴 THE CONTROL, AND IT IS THE HALF THE OLD ROUTE FAILED. A picker that
// returned everyone would satisfy "finds Clara" perfectly.
const cgHit = await pick("o_gavin", "Gavin");
ok("🔴 a CAREGIVER with no client case is never offered",
  !(cgHit.body.results || []).some((r) => r.id === "c_gavin"), cgHit.body.results);
const selfHit = await pick("o_gavin", "Giver");
ok("🔴 …and the caregiver can never be offered THEMSELVES",
  !(selfHit.body.results || []).some((r) => r.id === "c_gavin"), selfHit.body.results);

// ⚠️ THE 2-OF-120 CASE: a client case AND Record Type "Caregiver". A picker
// that filtered on Record Type would drop them; this one must not.
const mixed = await pick("o_gavin", "Morgan");
ok("🔴 somebody labelled Caregiver who HOLDS a client case is offered",
  mixed.body.results?.some((r) => r.id === "c_mixed"), mixed.body.results);

// The other side is unchanged: a client's panel still searches caregivers.
const cgSide = await pick("o_clara", "Gavin");
ok("a client's panel still searches CAREGIVERS", cgSide.body.role === "caregiver", cgSide.body);
ok("…and finds the caregiver", cgSide.body.results?.some((r) => r.id === "c_gavin"), cgSide.body);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 2 · 🔴 PEOPLE MET ARE FOUND BY THE EVENT ═══");
// ═══════════════════════════════════════════════════════════════════════════
const load = async () => {
  const r = await refRoute.GET(new Request("http://x/api/referrals?touch=none",
    { headers: { "x-ghl-sso-key": ADMIN } }));
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

console.log("\n2a · with `exists` supported");
let page = await load();
const ids = (page.body.attendees || []).map((a) => a.id);
ok("🔴 Nina, now a CAREGIVER, is still in People met", ids.includes("c_nina"), ids);
ok("…attached to the event she was met at",
  page.body.attendees?.find((a) => a.id === "c_nina")?.eventId === "o_event", page.body.attendees);
ok("🔴 CONTROL — the plain attendee is still there too (the union keeps both halves)",
  ids.includes("c_pat"), ids);
ok("🔴 CONTROL — a caregiver who was NEVER met is not in People met",
  !ids.includes("c_gavin"), ids);
ok("the screen is told how the list was built", page.body.attendeeSource === "exists",
  page.body.attendeeSource);

console.log("\n2b · 🔴 with `exists` REFUSED — the fallback, and it must find her too");
existsSupported = false;
G.resetExistsProbe();
page = await load();
const ids2 = (page.body.attendees || []).map((a) => a.id);
ok("🔴 Nina is STILL in People met when GoHighLevel will not answer 'is it set'",
  ids2.includes("c_nina"), ids2);
ok("…and the plain attendee survives the fallback too", ids2.includes("c_pat"), ids2);
ok("the screen is told it was the per-event route", page.body.attendeeSource === "per-event",
  page.body.attendeeSource);
existsSupported = true;
G.resetExistsProbe();

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 3 · 🔴 RECORDING SOMEBODY MUST NOT RELABEL THEM ═══");
// ═══════════════════════════════════════════════════════════════════════════
const metExisting = await post(refRoute, "http://x/api/referrals", {
  action: "add-attendee", eventId: "o_event", contactId: "c_gavin",
  profile: "Came to recruit", outcome: "Warm",
});
ok("an existing caregiver is recorded at the event", metExisting.status === 200, metExisting.body);
ok("🔴 …and is STILL a Caregiver", rtOf("c_gavin") === "Caregiver", rtOf("c_gavin"));
ok("…with the event written", cfOf(contacts.c_gavin)[EV] === "o_event", cfOf(contacts.c_gavin));
ok("…and their name untouched", nameOf("c_gavin") === "Gavin Giver", nameOf("c_gavin"));
ok("🔴 CONTROL — the response says an existing person was used",
  metExisting.body.usedExisting === true, metExisting.body);

const metPartner = await post(refRoute, "http://x/api/referrals", {
  action: "add-attendee", eventId: "o_event", contactId: "c_riddle", outcome: "Warm",
});
ok("an existing partner can be recorded at an event", metPartner.status === 200, metPartner.body);
ok("🔴 …and is STILL a Referral Partner", rtOf("c_riddle") === "Referral Partner", rtOf("c_riddle"));

// 🔴 THE POSITIVE CONTROL. "Only when blank" is satisfied by never writing it
// at all, so somebody WITH no Record Type must come out as an Event Attendee.
contacts.c_blank = { id: "c_blank", firstName: "Blanca", lastName: "Blank",
                     phone: "+14845550117", customFields: [] };
const metBlank = await post(refRoute, "http://x/api/referrals", {
  action: "add-attendee", eventId: "o_event", contactId: "c_blank", outcome: "Warm",
});
ok("🔴 CONTROL — somebody with NO Record Type is given one",
  metBlank.status === 200 && rtOf("c_blank") === "Event Attendee", rtOf("c_blank"));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 4 · 🔴 A SHARED PHONE MUST NOT RENAME ANYBODY ═══");
// ═══════════════════════════════════════════════════════════════════════════
const MARY_BEFORE = { name: nameOf("c_mary"), email: contacts.c_mary.email, rt: rtOf("c_mary") };
const SHARED = "+14845550199";

const paths = [
  ["Add person met", refRoute, "http://x/api/referrals",
    { action: "add-attendee", eventId: "o_event", firstName: "John", lastName: "Ortiz", phone: SHARED }],
  ["Log a referral → New enquiry", refRoute, "http://x/api/referrals",
    { action: "log-referral", firstName: "John", lastName: "Ortiz", phone: SHARED,
      partnerId: "c_riddle", pipelineId: P_CLIENT }],
  ["Add partner → New organisation", refRoute, "http://x/api/referrals",
    { action: "add-partner", org: "Ortiz Home Care", phone: SHARED, division: "OLTL" }],
  ["Add Lead", clientsRoute, "http://x/api/clients",
    { firstName: "John", lastName: "Ortiz", phone: SHARED, pipelineId: P_CLIENT, stageId: "c_s1" }],
  ["Add Applicant", applicantsRoute, "http://x/api/caregivers",
    { firstName: "John", lastName: "Ortiz", phone: SHARED, division: "OLTL_CHC" }],
];

for (const [label, mod, url, body] of paths) {
  const before = writes.length;
  const r = await post(mod, url, body);
  const after = writes.slice(before);
  ok(`${label} — refuses with the confirmation`, r.status === 409, { s: r.status, b: r.body });
  ok(`${label} — 🔴 the sentence names Mary Ann and her role`,
    /Mary Ann Smith/.test(r.body.error || "") && /\(Caregiver\)/.test(r.body.error || ""),
    r.body.error);
  ok(`${label} — 🔴 NOTHING WAS WRITTEN while it asked`, after.length === 0, after);
  ok(`${label} — it offers her id so the caller can record her instead`,
    r.body.existing?.id === "c_mary", r.body.existing);
}
ok("🔴 after five refusals Mary Ann's name is untouched",
  nameOf("c_mary") === MARY_BEFORE.name, nameOf("c_mary"));
ok("…her email is untouched", contacts.c_mary.email === MARY_BEFORE.email, contacts.c_mary.email);
ok("…and her Record Type is untouched", rtOf("c_mary") === MARY_BEFORE.rt, rtOf("c_mary"));

console.log("\n4b · 🔴 CONTROL — a genuinely new phone still creates a person");
const fresh = writes.length;
const made = await post(refRoute, "http://x/api/referrals", {
  action: "add-attendee", eventId: "o_event", firstName: "Opal", lastName: "New",
  phone: "+14845550888",
});
ok("a new number creates a new contact", made.status === 200 && !!made.body.contactId, made.body);
ok("…and it really wrote something", writes.length > fresh, writes.length - fresh);
ok("🔴 …and the new person IS labelled an Event Attendee",
  rtOf(made.body.contactId) === "Event Attendee", rtOf(made.body.contactId));

console.log("\n4c · 🔴 CONTROL — confirming records her WITHOUT touching her");
const confirmed = await post(refRoute, "http://x/api/referrals", {
  action: "add-attendee", eventId: "o_event", contactId: "c_mary", outcome: "Warm",
});
ok("recording the existing person succeeds", confirmed.status === 200, confirmed.body);
ok("🔴 her name survived", nameOf("c_mary") === MARY_BEFORE.name, nameOf("c_mary"));
ok("🔴 her Record Type survived", rtOf("c_mary") === "Caregiver", rtOf("c_mary"));
ok("…and the event was written onto her", cfOf(contacts.c_mary)[EV] === "o_event",
  cfOf(contacts.c_mary));

console.log("\n4d · ⚠️ IMPORT IS UNCHANGED — its modes are deliberate");
const importRoute = await import("../app/api/import/route.ts");
const impBefore = { name: nameOf("c_mary"), rt: rtOf("c_mary") };
const imp = await post(importRoute, "http://x/api/import", {
  mode: "commit", dupMode: "update", pipelineId: P_CLIENT, stageId: "c_s1",
  rows: [{ firstName: "John", lastName: "Ortiz", phone: SHARED }],
  mapping: { firstName: "firstName", lastName: "lastName", phone: "phone" },
});
ok("🔴 import does NOT emit the 409 — it decides for itself",
  imp.status !== 409, { s: imp.status });
ok("…and it did not rename her either (it never wrote a name to a match)",
  nameOf("c_mary") === impBefore.name, nameOf("c_mary"));

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 5 · A LINK MADE FROM EITHER SIDE READS CORRECTLY ═══");
// ═══════════════════════════════════════════════════════════════════════════
relations = [];
// A route with a dynamic segment needs its ctx, so this does not go through
// the `post` helper above.
const linkFrom = async (oppId, picked) => {
  const r = await cgRoute.POST(new Request(`http://x/api/opportunities/${oppId}/caregivers`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoKey: ADMIN, caregiverContactId: picked }),
  }), ctx(oppId));
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const a = await linkFrom("o_clara", "c_gavin");   // from the CLIENT's panel
ok("linking from the client's panel works", a.status === 200, a.body);
let counts = await G.countCaregiverRelations("c_clara");
ok("🔴 the client reads 1 caregiver, 0 clients",
  counts.caregivers === 1 && counts.clients === 0, counts);
counts = await G.countCaregiverRelations("c_gavin");
ok("🔴 the caregiver reads 0 caregivers, 1 client",
  counts.caregivers === 0 && counts.clients === 1, counts);

relations = [];
const b = await linkFrom("o_gavin", "c_clara");   // from the CAREGIVER's panel
ok("linking from the caregiver's panel works", b.status === 200, b.body);
counts = await G.countCaregiverRelations("c_clara");
ok("🔴 …and the client still reads 1 caregiver, 0 clients",
  counts.caregivers === 1 && counts.clients === 0, counts);
counts = await G.countCaregiverRelations("c_gavin");
ok("🔴 …and the caregiver still reads 0 caregivers, 1 client",
  counts.caregivers === 0 && counts.clients === 1, counts);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 6 · 🔴 THE MOVES SCREEN COUNTS AGAIN ═══");
// ═══════════════════════════════════════════════════════════════════════════
const FID = "169kLJWuSzuEiagrAmKo";
const krec = (id, stageId, rows, createdAt) => ({
  id, stageId, createdAt, cf: { [FID]: rows.join("\n") },
});

// ⚠️ THE LIVE SHAPE, build 169: sixteen records, one row each, none of them at
// the record's creation time. The screen read "Counting 0 moves across 16
// records — 16 first sightings not counted."
const live = [];
for (let i = 0; i < 16; i++)
  live.push(krec(`L${i}`, "NEW_LEAD",
    [`2026-09-28T09:53:2${i % 10}.000Z|NEW_LEAD|u_hay|u_roi,u_lamarr`],
    "2026-03-01T00:00:00.000Z"));
let k = stageKpi(live, FID);
ok("🔴 sixteen one-row cases count SIXTEEN moves", k.moves === 16, k.moves);
ok("…all with an unknown starting stage", k.unknownOrigin === 16, k.unknownOrigin);
ok("…and none of them a creation row", k.creationRows === 0, k.creationRows);
ok("🔴 each is credited to the owner in its row",
  k.perRep.length === 1 && k.perRep[0].id === "u_hay" && k.perRep[0].moves === 16, k.perRep);
ok("…and to both managers watching", k.perManager.length === 2 &&
  k.perManager.every((m) => m.moves === 16), k.perManager);

// ⚠️ THE 26 ODP CASES MOVED IN BULK ON 28 SEPTEMBER. They were counted as
// nothing; they are a cluster now. (The sixteen above share a minute too, so
// `clusterMin` is set above sixteen to keep the two apart.)
const bulk26 = [];
for (let i = 0; i < 26; i++)
  bulk26.push(krec(`B${i}`, "NEW_LEAD",
    [`2026-09-28T14:05:${String(i % 60).padStart(2, "0")}.000Z|NEW_LEAD|u_hay|`],
    "2026-04-01T00:00:00.000Z"));
k = stageKpi(bulk26, FID, { clusterMin: 20 });
ok("🔴 the 26 ODP bulk moves are COUNTED", k.moves === 26, k.moves);
ok("🔴 …and surfaced as one cluster of 26",
  k.clusters.length === 1 && k.clusters[0].records === 26, k.clusters);

// Created-then-moved: row 1 is the creation, row 2 is the move.
const born = "2026-09-01T10:00:00.000Z";
k = stageKpi([krec("N1", "B", [
  "2026-09-01T10:00:30.000Z|A|u_hay|",   // 30s after creation — the workflow firing
  "2026-09-05T09:00:00.000Z|B|u_hay|",   // the actual move
], born)], FID);
ok("🔴 a created-then-moved case counts ONE move", k.moves === 1, k.moves);
ok("…and one creation row", k.creationRows === 1, k.creationRows);
ok("…with no unknown origin, because the move has one", k.unknownOrigin === 0, k.unknownOrigin);

// Creation only.
k = stageKpi([krec("N2", "A", ["2026-09-01T10:00:15.000Z|A|u_hay|"], born)], FID);
ok("🔴 a creation-only case counts ZERO moves", k.moves === 0, k.moves);
ok("…and says so as a creation row", k.creationRows === 1, k.creationRows);

// 🔴 THE EDGE OF THE WINDOW, BOTH SIDES. A constant nobody tests is a constant
// that can be changed to zero without a proof noticing.
// 🔴 ROUND 173 — DERIVED FROM THE CONSTANT NOW, NOT HARD-CODED AT 2 MINUTES.
// These read "119 seconds" and "121 seconds" and went red when the window was
// widened to five minutes on live measurement — a proof asserting a number
// whose value is a judgement call, which is the trap round 128 set twice with
// message wording.
//
// ⚠️ AND THE LITERAL VALUES DID NOT JUST VANISH. round173-proof asserts a
// 3-minute row is creation and a 6-minute row is a move, in whole minutes and
// independent of the constant — so the constant being wrong is still caught
// somewhere. What this pair tests is that the BOUNDARY IS SHARP, wherever it
// sits, which is the property that cannot go stale.
const W = CREATION_WINDOW_MS;
const atMs = (ms) => new Date(Date.parse(born) + ms).toISOString();
k = stageKpi([krec("N3", "A", [`${atMs(W - 1000)}|A|u_hay|`], born)], FID);
ok("a second INSIDE the window is still the creation",
  k.creationRows === 1 && k.moves === 0, k);
k = stageKpi([krec("N4", "A", [`${atMs(W + 1000)}|A|u_hay|`], born)], FID);
ok("🔴 CONTROL — a second OUTSIDE the window is a MOVE",
  k.moves === 1 && k.unknownOrigin === 1 && k.creationRows === 0, k);

// 🔴 A MISSING createdAt COUNTS, rather than being quietly dropped.
k = stageKpi([{ id: "N5", stageId: "A", cf: { [FID]: "2026-09-01T10:00:00.000Z|A|u_hay|" } }], FID);
ok("🔴 a record with no createdAt counts its first row as a move",
  k.moves === 1 && k.creationRows === 0, k);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 7 · 🔴 THE CASE-MANAGER LIST SAYS WHICH WAY IT RUNS ═══");
// ═══════════════════════════════════════════════════════════════════════════
const PA = await import("../lib/caseManagerLabels.ts");
const mv = PA.caseManagerColumns("manager");
const rv = PA.caseManagerColumns("rep");
ok("manager-first names the manager column", mv.who === "Case manager", mv);
ok("🔴 …and says the chips are who they FOLLOW",
  mv.what === "Follows cases owned by", mv);
// 🔴 THE CONTROL. Two headings that never change are two headings that are
// wrong in one of the two views, which is the bug.
ok("🔴 CONTROL — rep-first says the OPPOSITE on both columns",
  rv.who !== mv.who && rv.what !== mv.what, { mv, rv });
ok("owner-first reads as their cases being followed",
  rv.who === "Case owner" && rv.what === "Their cases are followed by", rv);
// 🔴 ROUND 137'S RULE STILL HOLDS, AND task1-tab CAUGHT ME BREAKING IT. The
// system cannot know who is a rep, so neither heading may say so.
ok("🔴 neither heading infers a role from a name",
  !/\brep\b/i.test(`${mv.who} ${mv.what} ${rv.who} ${rv.what}`), { mv, rv });

const prev = PA.caseManagerPreview("chris b", "Bill Lockfeld");
ok("🔴 the preview is the owner's sentence, word for word",
  prev === "When chris b owns a case, Bill Lockfeld is added.", prev);
// 🔴 THE DIRECTION CONTROL. "names both people" is satisfied by a sentence
// that has them the wrong way round, which is the thing being prevented.
ok("🔴 CONTROL — swapping the two produces a DIFFERENT sentence",
  PA.caseManagerPreview("Bill Lockfeld", "chris b") !== prev,
  PA.caseManagerPreview("Bill Lockfeld", "chris b"));
ok("…and the owner is named before the manager",
  prev.indexOf("chris b") < prev.indexOf("Bill Lockfeld"), prev);
ok("a half-made row has no sentence at all", PA.caseManagerPreview("chris b", "") === "");

// ═══════════════════════════════════════════════════════════════════════════
server.close();
const total = pass + fail;
console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
console.log(`assertions: ${total}`);
process.exit(fail ? 1 : 0);
