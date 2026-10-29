// ---------------------------------------------------------------------------
// ROUND 186 PROOF — a partner is listed under its ORGANISATION, not its person.
//
// Found by scripts/referrals-tour.mjs on its first run. "+ Add partner" with an
// organisation, a contact person's name and an email saved the person's name
// as the contact's name and the organisation nowhere, so the partner list, an
// event's "Run by", "Referred by" and the Referring Partner field all showed
// the person. The organisation is now the contact's Company Name, and every
// partner row reads it first.
//
// In-process: the real route against a fake GoHighLevel that keeps what it is
// sent, so the list is read back from what was written.
// Run: npx tsx scripts/round186-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import CryptoJS from "crypto-js";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc186", SECRET = "secret186";
const CLIENT = "pipe_oltl", EV = "pipe_events";
const RT = "F_RT", CAT = "F_CAT", TIER = "F_TIER", PDIV = "F_PDIV";
const cfg = JSON.stringify({
  seeded: true, folderNames: {},
  pipelines: { [CLIENT]: { scope: "client", folders: [] }, [EV]: { scope: "client", folders: [], role: "events" } },
});
const ADMIN = CryptoJS.AES.encrypt(
  JSON.stringify({ userId: "u_admin", role: "admin", type: "agency", activeLocation: LOC }), SECRET,
).toString();

// A partner saved BEFORE this round: no company name, the org is the name.
let contacts = [
  { id: "p_legacy", firstName: "Riddle Hospital", contactName: "Riddle Hospital", email: "d@riddle.org",
    customFields: [{ id: RT, value: "Referral Partner" }, { id: PDIV, value: "OLTL" }] },
];
const writes = [];
let n = 0;

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const j = raw ? JSON.parse(raw) : null;
    const [path] = req.url.split("?");
    const send = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (path === "/users/" || path === "/users") return send(200, { users: [{ id: "u_admin", name: "Admin" }] });
    if (path === `/locations/${LOC}/customValues`) return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders", value: cfg }] });
    if (path === `/locations/${LOC}/customFields`) {
      const contact = /model=contact/.test(req.url);
      return send(200, { customFields: contact
        ? [{ id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS", picklistOptions: ["Referral Partner", "Event Attendee"] },
           { id: CAT, name: "Partner Category", dataType: "TEXT" },
           { id: TIER, name: "Partner Tier", dataType: "TEXT" },
           { id: PDIV, name: "Partner Division", dataType: "SINGLE_OPTIONS", picklistOptions: ["OLTL", "ODP"] }]
        : [] });
    }
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        { id: CLIENT, name: "OLTL Enrollment", stages: [{ id: "s1", name: "NEW LEAD", position: 0 }] },
        { id: EV, name: "Events", stages: [{ id: "e1", name: "Held", position: 0 }] },
      ] });
    if (path === "/opportunities/search") return send(200, { opportunities: [], meta: { total: 0 } });
    if (path === "/contacts/search") {
      let rows = contacts;
      for (const f of j?.filters || [])
        if (String(f.field).startsWith("customFields."))
          rows = rows.filter((c) => (c.customFields || []).some((x) => x.id === f.field.slice(13) && String(x.value) === String(f.value)));
      if (j?.query) rows = rows.filter((c) => JSON.stringify(c).toLowerCase().includes(String(j.query).toLowerCase()));
      return send(200, { contacts: rows, total: rows.length });
    }
    if (path === "/contacts/search/duplicate") return send(200, { contact: null });
    if ((path === "/contacts" || path === "/contacts/" || path === "/contacts/upsert") && req.method === "POST") {
      writes.push({ endpoint: path.includes("upsert") ? "upsert" : "create", body: j });
      const id = `c${++n}`;
      contacts.push({
        id, firstName: j.firstName || "", lastName: j.lastName || "", companyName: j.companyName,
        contactName: [j.firstName, j.lastName].filter(Boolean).join(" "),
        email: j.email || "", customFields: j.customFields || [],
      });
      return send(200, { contact: { id }, new: true });
    }
    const m = path.match(/^\/contacts\/([^/]+)$/);
    if (m) { const c = contacts.find((x) => x.id === m[1]); return send(c ? 200 : 404, c ? { contact: c } : {}); }
    return send(200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
Object.assign(process.env, {
  GHL_API_BASE: `http://127.0.0.1:${server.address().port}`, GHL_PIT: "pit_test",
  GHL_LOCATION_ID: LOC, GHL_SSO_SECRET: SECRET, PIPELINE_IDS: `${CLIENT},${EV}`,
});

const route = await import("../app/api/referrals/route.ts");
const post = async (body) => {
  const r = await route.POST(new Request("http://x/api/referrals", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ssoKey: ADMIN, ...body }),
  }));
  return { status: r.status, body: await r.json() };
};
const partners = async (qs) => {
  const r = await route.GET(new Request(`http://x/api/referrals${qs}`, { headers: { "x-ghl-sso-key": ADMIN } }));
  const b = await r.json();
  return b.partners || [];
};
const orgOf = (list, id) => list.find((p) => p.id === id)?.org;

console.log("1 · organisation + contact person + email (the case that lost the organisation)");
const a = await post({ action: "add-partner", org: "Main Line Health", firstName: "Jane", lastName: "Doe", email: "jane@mlh.test", division: "OLTL" });
ok("saved", a.status === 200, a);
const wa = writes.at(-1)?.body || {};
ok("the person stays the contact's name (Jane Doe)", wa.firstName === "Jane" && wa.lastName === "Doe", wa);
ok("🔴 the organisation is sent as the Company Name", wa.companyName === "Main Line Health", wa);
const listA = await partners("?only=partners");
ok("🔴 the partner picker lists it as Main Line Health", orgOf(listA, a.body.contactId) === "Main Line Health", listA);
const fullA = await partners("");
ok("🔴 the Referrals screen lists it as Main Line Health", orgOf(fullA, a.body.contactId) === "Main Line Health", fullA.map((p) => p.org));

console.log("2 · organisation only, with an email");
const b = await post({ action: "add-partner", org: "Bryn Mawr Rehab", email: "refer@bmr.test", division: "OLTL" });
const wb = writes.at(-1)?.body || {};
ok("the organisation is the name, as before", wb.firstName === "Bryn Mawr Rehab", wb);
ok("…and the Company Name", wb.companyName === "Bryn Mawr Rehab", wb);
ok("listed as Bryn Mawr Rehab", orgOf(await partners("?only=partners"), b.body.contactId) === "Bryn Mawr Rehab");

console.log("3 · organisation + contact person, no email or phone");
const c = await post({ action: "add-partner", org: "Delco Senior Center", firstName: "Sam", lastName: "Lee", division: "OLTL" });
ok("saved", c.status === 200, c);
const wc = writes.at(-1)?.body || {};
ok("🔴 the Company Name is sent here too", wc.companyName === "Delco Senior Center", wc);
ok("listed as Delco Senior Center", orgOf(await partners("?only=partners"), c.body.contactId) === "Delco Senior Center");

console.log("4 · a partner saved before this round (no Company Name)");
ok("still listed under its name, unchanged", orgOf(await partners("?only=partners"), "p_legacy") === "Riddle Hospital");
ok("…on the Referrals screen too", orgOf(await partners(""), "p_legacy") === "Riddle Hospital");

server.close();
console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
