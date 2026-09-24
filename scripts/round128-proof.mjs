// ---------------------------------------------------------------------------
// ROUND 128 — THE DIVISION LIST COMES FROM THE FIELD.
//
// 🔴 THE FIXTURE IS AN ODP-ONLY ACCOUNT, which is the deployment the brief is
// about: `Partner Division` offers ODP and nothing else. A fixture carrying all
// four values would have been green on the bug — the hardcoded list and the
// live one would have agreed, and agreement is exactly what is missing live.
//
// ⚠️ AND `Event Division` IS A DIFFERENT FIELD WITH DIFFERENT OPTIONS here, on
// purpose. The event dialog was handed the CONTACT field's picklist for an
// OPPORTUNITY field's value; two lists that happen to match today hide that
// completely, so this fixture makes them disagree.
//
// Run: npx tsx scripts/round128-proof.mjs
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
const RT = "F_RT", PDIV = "F_PDIV", EVDIV = "F_EVDIV", REF = "F_REF";
const ADMIN = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Admin", email: "a@e.com", companyId: "co1",
}), SECRET).toString();

// 🔴 AN ODP-ONLY ACCOUNT. Private Pay and OLTL cannot exist here.
const PARTNER_DIVISION_OPTIONS = ["ODP", "All"];
// ⚠️ A DIFFERENT FIELD, DELIBERATELY DIFFERENT VALUES.
const EVENT_DIVISION_OPTIONS = ["ODP Waiver", "ODP Base"];

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
    if (path === `/locations/${LOC}/customFields`)
      return json(res, 200, { customFields: q.get("model") === "opportunity"
        ? [
            { id: REF, name: "Referring Partner", dataType: "TEXT" },
            { id: EVDIV, name: "Event Division", dataType: "SINGLE_OPTIONS",
              picklistOptions: EVENT_DIVISION_OPTIONS },
          ]
        : [
            { id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS",
              picklistOptions: ["Referral Partner", "Event Attendee"] },
            { id: PDIV, name: "Partner Division", dataType: "SINGLE_OPTIONS",
              picklistOptions: PARTNER_DIVISION_OPTIONS },
          ] });
    if (path.startsWith("/users/")) return json(res, 200, { users: [{ id: "u1", name: "Admin" }] });
    if (path === "/opportunities/pipelines")
      return json(res, 200, { pipelines: [{ id: "pipe_odp", name: "ODP Enrollment",
        stages: [{ id: "s1", name: "NEW LEAD", position: 0 }] }] });
    if (path === `/locations/${LOC}/customValues`)
      return json(res, 200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({ seeded: true, folderNames: {},
          pipelines: { pipe_odp: { scope: "client", folders: [] } } }) }] });
    if (path === "/opportunities/search") return json(res, 200, { opportunities: [], meta: { total: 0 } });
    if (path === "/contacts/search") {
      const want = body?.filters?.[0]?.value;
      if (want === "Referral Partner")
        return json(res, 200, { contacts: [{ id: "p1", contactName: "Elwyn",
          customFields: [{ id: RT, value: "Referral Partner" }, { id: PDIV, value: "ODP" }] }], total: 1 });
      return json(res, 200, { contacts: [], total: 0 });
    }
    if (/^\/contacts\/[^/]+\/notes/.test(path)) return json(res, 200, { notes: [] });
    if (/^\/contacts\/[^/]+$/.test(path)) return json(res, 200, { contact: { id: "p1" } });
    return json(res, 200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.GHL_SSO_SECRET = SECRET;
process.env.PIPELINE_IDS = "pipe_odp";

const R = await import("../lib/referrals.ts");
const referrals = await import("../app/api/referrals/route.ts");
const r = await referrals.GET(
  new Request("http://x/api/referrals", { headers: { "x-ghl-sso-key": ADMIN } }),
);
const body = await r.json();

console.log("\n1 · 🔴 THE FIELD'S OWN OPTIONS REACH THE PAYLOAD");
console.log(`  Partner Division -> ${JSON.stringify(body.divisionOptions)}`);
console.log(`  Event Division   -> ${JSON.stringify(body.eventDivisionOptions)}`);
ok("the partner list is the account's, not the code's",
   JSON.stringify(body.divisionOptions) === JSON.stringify(PARTNER_DIVISION_OPTIONS),
   body.divisionOptions);
ok("🔴 and it does NOT contain Private Pay or OLTL — the two that cannot exist here",
   !body.divisionOptions.includes("Private Pay") && !body.divisionOptions.includes("OLTL"),
   body.divisionOptions);
ok("🔴 the EVENT field's own options are sent separately",
   JSON.stringify(body.eventDivisionOptions) === JSON.stringify(EVENT_DIVISION_OPTIONS),
   body.eventDivisionOptions);
ok("⚠️ and they are different from the partner field's — two fields, two lists",
   JSON.stringify(body.eventDivisionOptions) !== JSON.stringify(body.divisionOptions),
   [body.divisionOptions, body.eventDivisionOptions]);

console.log("\n2 · 🔴 THE HARDCODED LIST IS A FALLBACK, NOT AN ANSWER");
console.log(`  lib/referrals.ts DIVISIONS = ${JSON.stringify([...R.DIVISIONS])}`);
ok("it still exists, for when the options cannot be read", R.DIVISIONS.length === 4, R.DIVISIONS);
ok("⚠️ and Division is no longer a union of those four",
   typeof R.ALL_DIVISIONS === "string" && R.ALL_DIVISIONS === "All", R.ALL_DIVISIONS);
// ⚠️ THE FILTER MUST STILL BEHAVE. Making the type a string is only safe if the
// meaning of "All" — on the RECORD and on the SWITCHER — is untouched.
ok("a record in ODP shows under ODP", R.inDivision("ODP", "ODP"), "no");
ok("a record in ODP does NOT show under another division", !R.inDivision("ODP", "ODP Base"), "leaked");
ok("🔴 a record marked All still shows under every division", R.inDivision("All", "ODP"), "no");
ok("🔴 and an unset record still shows everywhere", R.inDivision("", "ODP"), "no");
ok("the All view still shows everything", R.inDivision("ODP", R.ALL_DIVISIONS), "no");

console.log("\n3 · 🔴 THE SWITCHER READS THE LIVE LIST, THE DIALOGS READ THEIR OWN FIELD");
const rs = readFileSync("components/ReferralsSection.tsx", "utf8");
const code = rs.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
console.log("  ⚠️ comments stripped — this file's prose names DIVISIONS repeatedly.");
ok("🔴 the menu no longer maps the hardcoded list",
   !/DIVISIONS\.map\(/.test(code), "DIVISIONS.map survives in the menu");
// ⚠️ THE PROPERTY, NOT THE SPELLING. This read `/divisionChoices\.map\(/` and
// task 2 · §3 made the menu `[ALL_DIVISIONS, ...divisionChoices].map(` — the
// same claim, one character of syntax apart, and the assertion went red against
// working code. Pinned to a literal I later improved, which is the recurring
// one. What round 128 cares about is that the menu maps a DERIVED list and not
// the hardcoded `DIVISIONS`; both halves of that are still tested.
//
// 🔴 AND WHAT `divisionChoices` IS HAS CHANGED UNDER THIS ASSERTION. Round 128
// made it `Partner Division`'s option set; task 2 · §3 derives it from the
// partners and events actually in the payload, because a FILTER must not offer
// something that matches nothing. Round 128's own argument — that a list must
// not name a division the account cannot have — survives intact, and still owns
// the two create dialogs below.
ok("it maps a derived list instead", /divisionChoices[^\n]*\.map\(/.test(code), "no derived list");
ok("🔴 the event dialog is given the EVENT field's options",
   /<AddEventDialog[\s\S]{0,400}divisions=\{eventDivisions\}/.test(code), "still the partner list");
ok("and the partner dialog the partner field's",
   /<AddPartnerDialog[\s\S]{0,400}divisions=\{partnerDivisions\}/.test(code), "wrong list");
ok("⚠️ a choice that is no longer offered is clamped back to All",
   /!divisionChoices\.includes\(division\)\)\s*\n?\s*setDivision\(ALL_DIVISIONS\)/.test(code),
   "no clamp");
ok("⚠️ and the event dialog says when it is showing a different field's list",
   /divisionsAreEventsOwn === false/.test(code), "no disclosure");

console.log("\n4 · ⚠️ THE OTHER THREE HARDCODED ACCOUNT FACTS — WHERE THEY STAND");
const ghl = readFileSync("lib/ghl.ts", "utf8");
const ff = readFileSync("lib/fieldFolders.ts", "utf8");
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
const access = strip(readFileSync("app/api/admin/pipeline-access/route.ts", "utf8"));
ok("PIPELINE_IDS / CAREGIVER_PIPELINE_IDS — no live consumer (round 127)",
   !/caregiverPipelineIds\(|pipelineIds\(/.test(access), "the Access tab still reads them");
// 🔴 FOLDERS: the stored config wins whenever it is present. The code map is
// consulted only to SEED and only when the config has not loaded.
ok("🔴 FOLDERS — the stored config wins when present",
   /if \(stored\) \{[\s\S]{0,60}allowed = stored;/.test(strip(ff)) ||
   /if \(stored\) \{\s*allowed = stored;/.test(strip(ff)), "stored no longer wins");
ok("⚠️ and PIPELINE_FOLDERS is only reached when it has NOT loaded",
   /\} else if \(!loaded\) \{[\s\S]{0,300}PIPELINE_FOLDERS/.test(strip(ff)),
   "the code map is consulted on the live path");
ok("the seed still uses it — a fresh account must not start unmapped",
   /seedPipelineConfig[\s\S]{0,800}PIPELINE_FOLDERS/.test(strip(ghl)), "the seed lost it");

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
