// ---------------------------------------------------------------------------
// ROUND 173 — THE LAGGING INDEX, AND THE CREATION WINDOW.
//
// 🔴 THE FAKE IS DELIBERATELY UNTIDY, AND THAT IS THE WHOLE POINT. Every
// earlier fake's `/contacts/search` saw a write the instant it landed, so round
// 171's guard could not fail — the check and the write agreed because the
// harness made them agree. The live account does not:
//
//     /contacts/search    an INDEX. Lags a new contact by up to ~60 seconds.
//     /contacts/upsert    matches on phone INSTANTLY.
//     POST /contacts/     refuses a duplicate phone INSTANTLY.
//
// So this fake hides anything younger than SEARCH_LAG_MS from the search while
// answering the phone match immediately. Rule 2, in the direction nobody
// checks: a harness tidier than the real thing is green on a live bug.
//
// Run: npx tsx scripts/round173-proof.mjs
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
const P_CLIENT = "pipe_oltl";
const P_CG = "pipe_cg";
const P_EVENTS = "pipe_events";
const RT = "F_RT";
const EV = "F_EVENT";
const DIV = "F_PDIV";
const OUT = "F_OUTCOME";
const PROF = "F_PROFILE";

const ADMIN = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Admin", email: "a@e.com", companyId: "co1",
}), SECRET).toString();

// 🔴 THE LAG, AND THE CLOCK THE PROOF CONTROLS. Real time would make this test
// take a minute; `now` is moved by hand so "7 seconds later" is exact rather
// than approximate.
const SEARCH_LAG_MS = 60_000;
let now = Date.parse("2026-10-05T12:00:00.000Z");

const contacts = {};
let seq = 0;
/**
 * 🔴 EVERY CHANGE THE FAKE ACTUALLY APPLIED — not every request it received.
 *
 * ⚠️ MY FIRST VERSION LOGGED THE REQUESTS AND WENT RED AGAINST WORKING CODE. A
 * refused `POST /contacts/` IS a request and is NOT a write: GoHighLevel looked
 * at it and changed nothing. "Nothing was written" is a claim about STATE, and
 * asserting it against a request log is rule 14 — a count that can be satisfied
 * (or broken) by something other than the thing being measured.
 *
 * ✅ AND THE STATE VERSION IS STRICTLY STRONGER: it would also catch a path
 * that created the contact and only then noticed the clash.
 */
const mutations = [];
const touched = (what, id) => mutations.push({ what, id });
/** 🔴 FLIPPED BY §1d — does the refusal body name the colliding contact? */
let refusalNamesContact = true;
/** 🔴 FLIPPED BY §1e — does the duplicate lookup route exist on this tenant? */
let duplicateLookupWorks = true;

const add = (c) => {
  const id = c.id || `c_new${++seq}`;
  contacts[id] = { createdAtMs: now, customFields: [], ...c, id };
  return contacts[id];
};
// Seeded contacts are OLD, so the index sees them — only the ones the test
// creates are young enough to be hidden.
now -= 10 * 60 * 1000;
add({ id: "c_mary", firstName: "Mary", lastName: "Ann Smith",
      phone: "+14845550199", email: "mary@e.test",
      customFields: [{ id: RT, value: "Caregiver" }] });
add({ id: "c_host", firstName: "Riddle Hospital", phone: "+14845550114",
      customFields: [{ id: RT, value: "Referral Partner" }, { id: DIV, value: "OLTL" }] });
now += 10 * 60 * 1000;

const opps = {
  o_event: { id: "o_event", name: "Delco Expo", pipelineId: P_EVENTS,
             pipelineStageId: "e_s1", contactId: "c_host", assignedTo: "u1",
             status: "open", createdAt: "2026-02-01T00:00:00.000Z", customFields: [] },
};

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
const phoneKey = (p) => String(p || "").replace(/\D/g, "").slice(-10);
/** 🔴 INSTANT. The same matching the real upsert and create do. */
const matchByKey = (phone, email) =>
  Object.values(contacts).find(
    (c) => (phone && phoneKey(c.phone) === phoneKey(phone)) ||
           (email && c.email && c.email.toLowerCase() === String(email).toLowerCase()));
/** ⚠️ LAGGING. What the index can see at the current clock. */
const indexed = () =>
  Object.values(contacts).filter((c) => now - c.createdAtMs >= SEARCH_LAG_MS);

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
        ? [
            { id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS",
              picklistOptions: ["Caregiver", "Client", "Referral Partner", "Event Attendee"] },
            { id: EV, name: "Event Attended", dataType: "TEXT" },
            { id: OUT, name: "Event Outcome", dataType: "SINGLE_OPTIONS", picklistOptions: ["Warm"] },
            { id: PROF, name: "Attendee Profile", dataType: "TEXT" },
            { id: DIV, name: "Partner Division", dataType: "SINGLE_OPTIONS", picklistOptions: ["OLTL", "ODP"] },
          ]
        : [] });
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
        (o) => (!pid || o.pipelineId === pid) && (!cid || o.contactId === cid));
      return send(200, {
        opportunities: rows.map((o) => ({ ...o, contact: contacts[o.contactId] })),
        meta: { total: rows.length } });
    }
    if (/^\/opportunities\/[^/]+$/.test(path) && req.method === "GET") {
      const o = opps[path.split("/")[2]];
      return o ? send(200, { opportunity: { ...o, contact: contacts[o.contactId] } })
               : send(404, { message: "not found" });
    }
    if (path === "/opportunities/" && req.method === "POST") {
      const oid = `o_new${++seq}`;
      touched("opportunity", oid);
      return send(200, { opportunity: { id: oid } });
    }

    // ── the duplicate lookup: INSTANT, and optional per tenant ─────────────
    if (path === "/contacts/search/duplicate") {
      if (!duplicateLookupWorks) return send(404, { message: "Not Found" });
      const hit = matchByKey(url.searchParams.get("number"), url.searchParams.get("email"));
      return hit ? send(200, { contact: hit }) : send(200, {});
    }

    // ── the INDEX: lags ────────────────────────────────────────────────────
    if (path === "/contacts/search") {
      const filters = j?.filters || [];
      if (filters.length) {
        const f = filters[0];
        const fid = String(f.field || "").replace("customFields.", "");
        const rows = indexed().filter((c) =>
          f.operator === "exists" ? !!cfOf(c)[fid] : cfOf(c)[fid] === f.value);
        return send(200, { contacts: rows, total: rows.length });
      }
      const q = String(j?.query || "").toLowerCase();
      const rows = indexed().filter((c) =>
        `${c.firstName || ""} ${c.lastName || ""} ${c.phone || ""} ${c.email || ""}`
          .toLowerCase().includes(q));
      return send(200, { contacts: rows, total: rows.length });
    }

    // ── POST /contacts/ — refuses a duplicate key, INSTANTLY ───────────────
    if (path === "/contacts/" && req.method === "POST") {
      const clash = matchByKey(j.phone, j.email);
      if (clash)
        return send(400, {
          message: "This location does not allow duplicated contacts.",
          traceId: "tr-dup",
          // ✅ ROUND 174 — THE LIVE SHAPE, PROBED 5 OCT: the refusal carries
          // meta.contactId, meta.matchingField and meta.contactName. A fake
          // sending only the id would leave the "which detail matched" half
          // untested — rule 2, in the direction nobody checks.
          ...(refusalNamesContact
            ? {
                meta: {
                  contactId: clash.id,
                  matchingField: j.phone && phoneKey(clash.phone) === phoneKey(j.phone)
                    ? "phone"
                    : "email",
                  contactName: `${clash.firstName || ""} ${clash.lastName || ""}`.trim(),
                },
              }
            : {}),
        });
      const fresh = add({
        firstName: j.firstName || "", lastName: j.lastName || "",
        phone: j.phone || "", email: j.email || "",
        customFields: (j.customFields || []).map((f) => ({ ...f })),
      });
      touched("create", fresh.id);
      return send(200, { contact: { id: fresh.id } });
    }
    // ── POST /contacts/upsert — MERGES onto the match, instantly ───────────
    // 🔴 KEPT IN THE FAKE EVEN THOUGH NO "new person" PATH MAY CALL IT, so the
    // revert can put it back and this proof can go red.
    if (path === "/contacts/upsert" && req.method === "POST") {
      const hit = matchByKey(j.phone, j.email);
      if (hit) {
        hit.firstName = j.firstName ?? hit.firstName;
        hit.lastName = j.lastName ?? hit.lastName;
        for (const f of j.customFields || []) {
          const cur = hit.customFields.find((x) => x.id === f.id);
          if (cur) cur.value = f.value; else hit.customFields.push({ id: f.id, value: f.value });
        }
        touched("upsert-merge", hit.id);
        return send(200, { contact: { id: hit.id }, new: false });
      }
      const up = add({
        firstName: j.firstName || j.name || "", lastName: j.lastName || "",
        phone: j.phone || "", email: j.email || "",
        customFields: (j.customFields || []).map((f) => ({ ...f })),
      });
      touched("upsert-create", up.id);
      return send(200, { contact: { id: up.id }, new: true });
    }
    if (/^\/contacts\/[^/]+\/notes/.test(path)) {
      if (req.method !== "POST") return send(200, { notes: [] });
      touched("note", path.split("/")[2]);
      return send(200, { note: { id: "n1" } });
    }
    if (/^\/contacts\/[^/]+\/tags/.test(path)) return send(200, { tags: [] });
    if (/^\/contacts\/[^/]+$/.test(path)) {
      const c = contacts[path.split("/")[2]];
      if (!c) return send(404, { message: "not found" });
      if (req.method === "PUT") {
        for (const f of j.customFields || []) {
          const cur = c.customFields.find((x) => x.id === f.id);
          if (cur) cur.value = f.value; else c.customFields.push({ id: f.id, value: f.value });
        }
        if (j.firstName !== undefined) c.firstName = j.firstName;
        if (j.lastName !== undefined) c.lastName = j.lastName;
        touched("contact-put", c.id);
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
process.env.CAREGIVER_ASSOCIATION_ID = "assoc_cg";
delete process.env.PIPELINE_ACCESS_MAP;
delete process.env.WEBHOOK_URL;

const { stageKpi, CREATION_WINDOW_MS } = await import("../lib/stageKpi.ts");
const refRoute = await import("../app/api/referrals/route.ts");
const clientsRoute = await import("../app/api/clients/route.ts");
const applicantsRoute = await import("../app/api/caregivers/route.ts");

const post = async (mod, url, body) => {
  const r = await mod.POST(new Request(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoKey: ADMIN, ...body }),
  }));
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const nameOf = (id) => `${contacts[id].firstName} ${contacts[id].lastName}`.trim();
const rtOf = (id) => cfOf(contacts[id])[RT] || "";

// ═══════════════════════════════════════════════════════════════════════════
console.log("═══ 1 · 🔴 THE 7-SECOND WINDOW — THE LIVE v172 FAILURE ═══");
// ═══════════════════════════════════════════════════════════════════════════
// Step one: an applicant is created, exactly as Add Applicant does it.
const SHARED = "+14845550777";
let made = await post(applicantsRoute, "http://x/api/caregivers", {
  firstName: "Gavin", lastName: "Giver", phone: SHARED, division: "OLTL_CHC",
});
ok("Add Applicant creates the caregiver", made.status === 200 && !!made.body.contactId, made.body);
const gavin = made.body.contactId;
ok("…and they are a Caregiver", rtOf(gavin) === "Caregiver", rtOf(gavin));

// 🔴 SEVEN SECONDS. The index still cannot see them; the phone match can.
now += 7_000;
const indexSees = indexed().some((c) => c.id === gavin);
ok("🔴 CONTROL — at 7s the search index CANNOT see them (the live shape)",
  !indexSees, { indexSees, lag: SEARCH_LAG_MS });

const before = mutations.length;
const second = await post(refRoute, "http://x/api/referrals", {
  action: "add-attendee", eventId: "o_event",
  firstName: "Nina", lastName: "Novak", phone: SHARED,
});
ok("🔴 the second person is STOPPED with the 409", second.status === 409,
  { s: second.status, b: second.body });
ok("🔴 …and NOTHING CHANGED", mutations.length === before, mutations.slice(before));
ok("🔴 Gavin is still called Gavin Giver", nameOf(gavin) === "Gavin Giver", nameOf(gavin));
ok("🔴 …and is still a Caregiver, not an Event Attendee",
  rtOf(gavin) === "Caregiver", rtOf(gavin));
ok("the refusal names him, from the create's own answer",
  /Gavin Giver/.test(second.body.error || ""), second.body.error);
ok("…and says which link identified him", second.body.existing?.via === "refusal",
  second.body.existing);
// ✅ ROUND 174 — THE MESSAGE NAMES THE DETAIL, FROM GOHIGHLEVEL'S OWN
// matchingField rather than from which fields happened to be sent.
ok("🔴 ROUND 174 — the message names the PHONE specifically",
  /This phone number belongs to/.test(second.body.error || ""), second.body.error);
ok("…and GoHighLevel's matchingField is what said so",
  second.body.existing?.matchedOn === "phone", second.body.existing);

console.log("\n1b · 🔴 THE OWNER'S CASE — two family members, 30 seconds apart");
const FAMILY = "+14845550888";
let a = await post(clientsRoute, "http://x/api/clients", {
  firstName: "Ana", lastName: "Ortiz", phone: FAMILY,
  pipelineId: P_CLIENT, stageId: "c_s1",
});
ok("the first family member is created", a.status === 200, a.body);
const ana = a.body.contactId;
now += 30_000;
const b4 = mutations.length;
let b = await post(clientsRoute, "http://x/api/clients", {
  firstName: "Juan", lastName: "Ortiz", phone: FAMILY,
  pipelineId: P_CLIENT, stageId: "c_s1",
});
ok("🔴 the second is stopped at 30 seconds", b.status === 409, { s: b.status, b: b.body });
ok("🔴 …Ana is still Ana", nameOf(ana) === "Ana Ortiz", nameOf(ana));
ok("…and nothing changed", mutations.length === b4, mutations.slice(b4));

console.log("\n1c · ⚠️ ALL FIVE PATHS, same window");
const paths = [
  ["Add person met", refRoute, "http://x/api/referrals",
    { action: "add-attendee", eventId: "o_event", firstName: "X", phone: FAMILY }],
  ["Log a referral → New enquiry", refRoute, "http://x/api/referrals",
    { action: "log-referral", firstName: "X", lastName: "Y", phone: FAMILY,
      partnerId: "c_host", pipelineId: P_CLIENT }],
  ["Add partner → New organisation", refRoute, "http://x/api/referrals",
    { action: "add-partner", org: "Ortiz Home Care", phone: FAMILY, division: "OLTL" }],
  ["Add Lead", clientsRoute, "http://x/api/clients",
    { firstName: "X", lastName: "Y", phone: FAMILY, pipelineId: P_CLIENT, stageId: "c_s1" }],
  ["Add Applicant", applicantsRoute, "http://x/api/caregivers",
    { firstName: "X", lastName: "Y", phone: FAMILY, division: "OLTL_CHC" }],
];
for (const [label, mod, url, body] of paths) {
  const w = mutations.length;
  const r = await post(mod, url, body);
  ok(`${label} — 409, nothing changed`,
    r.status === 409 && mutations.length === w, { s: r.status, w: mutations.slice(w) });
}
ok("🔴 after all five, Ana's name is untouched", nameOf(ana) === "Ana Ortiz", nameOf(ana));

console.log("\n1c2 · 🔴 BOTH SENT, AND THE EMAIL IS THE ONE THAT COLLIDES");
// 🔴 THE CONTROL FOR `matchingField` — AND REVERT L CAUGHT MY FIRST VERSION
// PASSING FOR THE WRONG REASON. It collided with a SEEDED contact, which the
// index can see, so the pre-check answered and the refusal was never reached:
// the assertion was green with `matchingField` ignored entirely. Rule 12 — an
// assertion that can pass for reasons unrelated to the code is corrosive.
//
// ✅ SO IT COLLIDES WITH SOMEBODY CREATED SECONDS AGO, invisible to the index,
// where the create's refusal is the only possible source of the answer.
{
  const fresh = await post(applicantsRoute, "http://x/api/caregivers", {
    firstName: "Esme", lastName: "Early",
    email: "esme@e.test", phone: "+14845550654", division: "OLTL_CHC",
  });
  ok("a contact is created with both a phone and an email", fresh.status === 200, fresh.body);
  now += 3_000;
  ok("🔴 CONTROL — the index cannot see them at 3 seconds",
    !indexed().some((c) => c.id === fresh.body.contactId), fresh.body.contactId);
  const w2 = mutations.length;
  const r2 = await post(clientsRoute, "http://x/api/clients", {
    firstName: "Zed", lastName: "Quill",
    phone: "+14845550123", email: "esme@e.test",
    pipelineId: P_CLIENT, stageId: "c_s1",
  });
  ok("refused on the email", r2.status === 409, { s: r2.status, b: r2.body });
  ok("🔴 …and the message says EMAIL, not phone",
    /This email belongs to/.test(r2.body.error || ""), r2.body.error);
  ok("…naming the person the refusal body named",
    /Esme Early/.test(r2.body.error || ""), r2.body.error);
  ok("…and it was the REFUSAL that identified them, not the index",
    r2.body.existing?.via === "refusal", r2.body.existing);
  ok("…matchedOn is email", r2.body.existing?.matchedOn === "email", r2.body.existing);
  ok("…nothing changed", mutations.length === w2, mutations.slice(w2));
}

console.log("\n1d · ⚠️ WHEN THE REFUSAL DOES NOT NAME THE CONTACT");
// 🔴 THE PROBE MAY COME BACK "no". The duplicate lookup is then the instant
// link, and the refusal must still hold.
refusalNamesContact = false;
let w = mutations.length;
let r = await post(clientsRoute, "http://x/api/clients", {
  firstName: "Z", lastName: "Q", phone: FAMILY, pipelineId: P_CLIENT, stageId: "c_s1" });
ok("🔴 still a 409, from the duplicate lookup", r.status === 409, { s: r.status, b: r.body });
ok("…and it says so", r.body.existing?.via === "lookup", r.body.existing);
ok("…nothing changed", mutations.length === w, mutations.slice(w));
ok("…and it still names Ana", /Ana Ortiz/.test(r.body.error || ""), r.body.error);

console.log("\n1e · 🔴 AND WHEN NEITHER IDENTIFIES THEM — refuse anyway");
duplicateLookupWorks = false;
w = mutations.length;
r = await post(clientsRoute, "http://x/api/clients", {
  firstName: "Z", lastName: "Q", phone: FAMILY, pipelineId: P_CLIENT, stageId: "c_s1" });
ok("🔴 STILL a 409 with no way to identify the match", r.status === 409, { s: r.status, b: r.body });
ok("🔴 …and still nothing changed", mutations.length === w, mutations.slice(w));
ok("…Ana survives", nameOf(ana) === "Ana Ortiz", nameOf(ana));
ok("⚠️ the message admits it cannot name them",
  /could not be looked up/i.test(r.body.detail || ""), r.body.detail);
ok("…and sends no empty id pretending to be one",
  !r.body.existing?.id, r.body.existing);
refusalNamesContact = true;
duplicateLookupWorks = true;

console.log("\n1f · 🔴 CONTROL — a genuinely free number still creates");
w = mutations.length;
r = await post(clientsRoute, "http://x/api/clients", {
  firstName: "Opal", lastName: "New", phone: "+14845550999",
  pipelineId: P_CLIENT, stageId: "c_s1" });
ok("a free number creates the lead", r.status === 200 && !!r.body.contactId, r.body);
ok("…and really changed something", mutations.length > w, mutations.length - w);
ok("🔴 …even though the index cannot see them either",
  !indexed().some((c) => c.id === r.body.contactId), r.body.contactId);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 2 · THE CREATION WINDOW IS FIVE MINUTES ═══");
// ═══════════════════════════════════════════════════════════════════════════
const FID = "169kLJWuSzuEiagrAmKo";
const krec = (id, stageId, rows, createdAt) => ({
  id, stageId, createdAt, cf: { [FID]: rows.join("\n") } });
const born = "2026-10-05T10:00:00.000Z";

ok("the constant is 5 minutes", CREATION_WINDOW_MS === 300_000, CREATION_WINDOW_MS);
// ✅ MEASURED LIVE TWICE: the creation row lands ~60s after createdAt. At the
// old 2 minutes that was inside; this proves the measured case and the asked-for
// 3-minute case both read as creation.
let k = stageKpi([krec("M1", "A", ["2026-10-05T10:01:00.000Z|A|u_hay|"], born)], FID);
ok("the measured ~60s creation row is not counted",
  k.moves === 0 && k.creationRows === 1, k);
k = stageKpi([krec("M2", "A", ["2026-10-05T10:03:00.000Z|A|u_hay|"], born)], FID);
ok("🔴 a creation row 3 MINUTES after createdAt is not counted",
  k.moves === 0 && k.creationRows === 1, k);
// 🔴 THE CONTROL. "not counted" is satisfied by counting nothing ever.
k = stageKpi([krec("M3", "A", ["2026-10-05T10:06:00.000Z|A|u_hay|"], born)], FID);
ok("🔴 CONTROL — a row 6 MINUTES after createdAt IS a move",
  k.moves === 1 && k.unknownOrigin === 1 && k.creationRows === 0, k);
k = stageKpi([krec("M4", "B", [
  "2026-10-05T10:01:00.000Z|A|u_hay|",
  "2026-10-05T10:40:00.000Z|B|u_hay|",
], born)], FID);
ok("created-then-moved still counts exactly one move",
  k.moves === 1 && k.creationRows === 1, k);

// ═══════════════════════════════════════════════════════════════════════════
server.close();
const total = pass + fail;
console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
console.log(`assertions: ${total}`);
process.exit(fail ? 1 : 0);
