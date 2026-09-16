// ---------------------------------------------------------------------------
// ROUND 130 — THE CONTACT SECTIONS BECOME CONFIGURABLE, END TO END.
//
// 🔴 THIS DRIVES THE ADMIN ROUTE, NOT THE HELPER. Round 129 proved the resolver
// and the second account's screen was unchanged, because the screen asks its
// own question of its own source. So this one does the whole loop:
//
//   GET   → ten sections, every one empty, six unknown folders   (the screen)
//   POST  → name one of them at a section                        (the new control)
//   GET   → that section now resolves and holds its fields       (the fix)
//
// ⚠️ AND IT RUNS THE SAME LOOP ON THE MAIN ACCOUNT'S SHAPE, asserting the
// sections come back identical — the no-op condition, applied to the screen
// this round changes rather than only to the panel round 129 changed.
//
// Run: npx tsx scripts/round130-proof.mjs
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
const ADMIN = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Admin", email: "a@e.com", companyId: "co1",
}), SECRET).toString();

const FF = await import("../lib/fieldFolders.ts");
const { CONTACT_FOLDERS } = FF;

// 🔴 THE SECOND ACCOUNT'S REAL FOLDER IDS, from the brief.
const ODP = [
  ["mH8jBHSyYjyExCVfCJDN", "Caregiver Application", 22],
  ["gmLObr45Qs0wBSZnMWxz", "Caregiver Availability", 20],
  ["shTJKlO7xOFbW84ZMsLT", "Attribution", 19],
  ["6VFpXWVkHES4phGbGH0j", "Caregiver Compliance", 16],
  ["gp00Da6NoddygQiLzyrv", "Referral Partner", 4],
  ["njz27nPFIOmMYKUn3jLn", "Event Attendance", 3],
];
const ACCOUNT = process.env.PROOF_ACCOUNT || "odp";
const contactFields =
  ACCOUNT === "mm"
    ? CONTACT_FOLDERS.flatMap((f, i) => [
        { id: `c${i}a`, name: `${f.label} One`, parentId: f.id, dataType: "TEXT" },
        { id: `c${i}b`, name: `${f.label} Two`, parentId: f.id, dataType: "TEXT" },
      ])
    : ODP.flatMap(([id, name]) =>
        [0, 1, 2].map((i) => ({ id: `${id}_${i}`, name: `${name} ${i}`, parentId: id, dataType: "TEXT" })),
      );

/** The stored config, mutated by the route's own writes — as GoHighLevel would. */
let stored = {
  seeded: true,
  folderNames: {},
  pipelines: { pipe_a: { scope: "client", folders: [] } },
};
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
      return json(res, 200, {
        customFields: q.get("model") === "opportunity" ? [] : contactFields,
      });
    if (path === "/opportunities/pipelines")
      return json(res, 200, { pipelines: [{ id: "pipe_a", name: "ODP Enrollments",
        stages: [{ id: "s1", name: "NEW LEAD", position: 0 }] }] });
    if (path === `/locations/${LOC}/customValues`) {
      if (req.method === "PUT" || req.method === "POST") {
        // The route writes the whole value back; keep it, as GHL does.
        const v = body?.value ?? body?.customValue?.value;
        if (v) stored = JSON.parse(v);
        return json(res, 200, { customValue: { id: "cv1", name: "MM Pipeline Folders", value: JSON.stringify(stored) } });
      }
      return json(res, 200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify(stored) }] });
    }
    if (/^\/locations\/[^/]+\/customValues\/[^/]+$/.test(path) && req.method === "PUT") {
      if (body?.value) stored = JSON.parse(body.value);
      return json(res, 200, { customValue: { id: "cv1", value: JSON.stringify(stored) } });
    }
    return json(res, 200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.GHL_SSO_SECRET = SECRET;
process.env.PIPELINE_IDS = "pipe_a";

const admin = await import("../app/api/admin/pipelines/route.ts");
const get = async () => {
  const r = await admin.GET(
    new Request("http://x/api/admin/pipelines", { headers: { "x-ghl-sso-key": ADMIN } }),
  );
  return r.json();
};
const post = async (payload) => {
  const r = await admin.POST(new Request("http://x/api/admin/pipelines", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoKey: ADMIN, ...payload }),
  }));
  return { status: r.status, body: await r.json() };
};
const shape = (secs) => secs.map((s) => `${s.label}::${s.fields.map((f) => f.id).join(",")}`);

console.log(`\nACCOUNT SHAPE: ${ACCOUNT === "mm" ? "MAIN (built-in ids)" : "SECOND (ODP ids)"}`);

const a = await get();
console.log(`  builtInFoldersForeign = ${a.builtInFoldersForeign}`);
console.log(`  sections with fields: ${shape(a.contactSections).filter((x) => /::.+/.test(x)).length} of ${a.contactSections.length}`);
console.log(`  unknown contact folders: ${a.unknownContactFolders.length}`);

if (ACCOUNT === "mm") {
  // ═══ THE NO-OP, ON THE SCREEN THIS ROUND CHANGES ════════════════════════
  console.log("\n🔴 THE MAIN ACCOUNT — THE SCREEN MUST NOT MOVE");
  for (const s of shape(a.contactSections)) console.log(`     ${s}`);
  ok("🔴 the built-in map is NOT reported foreign here",
     a.builtInFoldersForeign === false, a.builtInFoldersForeign);
  ok("🔴 every section resolves to its built-in id",
     a.contactSections.every((s) => s.resolvedId === s.id),
     a.contactSections.filter((s) => s.resolvedId !== s.id));
  ok("🔴 and every one holds its two fields",
     a.contactSections.every((s) => s.fields.length === 2),
     a.contactSections.map((s) => [s.label, s.fields.length]));
  ok("⚠️ nothing is listed as unknown", a.unknownContactFolders.length === 0,
     a.unknownContactFolders);
} else {
  // ═══ THE SECOND ACCOUNT — THE WHOLE LOOP ════════════════════════════════
  console.log("\n1 · 🔴 THE REPORTED SCREEN, REPRODUCED FROM THE ROUTE");
  ok("🔴 the built-in map is reported foreign", a.builtInFoldersForeign === true, a);
  ok("🔴 every section is empty", a.contactSections.every((s) => s.fields.length === 0),
     a.contactSections.map((s) => [s.label, s.fields.length]));
  ok("🔴 and none of them resolves to anything",
     a.contactSections.every((s) => !s.resolvedId), a.contactSections.map((s) => s.resolvedId));
  ok("⚠️ while the account's six real folders are listed as unknown",
     a.unknownContactFolders.length === 6, a.unknownContactFolders.map((u) => u.id));

  console.log("\n2 · 🔴 NAME ONE AT A SECTION — THE CONTROL THAT DID NOT EXIST");
  const target = CONTACT_FOLDERS.find((f) => f.label === "Caregiver Application");
  const r = await post({ action: "name-folder", folderId: "mH8jBHSyYjyExCVfCJDN", name: target.name });
  console.log(`  -> ${r.status}`);
  ok("the name is accepted", r.status === 200, r.body);
  ok("⚠️ and it is stored against the ACCOUNT'S id, not the built-in one",
     stored.folderNames["mH8jBHSyYjyExCVfCJDN"] === target.name, stored.folderNames);

  const b = await get();
  const app = b.contactSections.find((s) => s.label === "Caregiver Application");
  console.log(`  Caregiver Application -> resolvedId=${app.resolvedId} fields=${app.fields.length}`);
  ok("🔴 the section now resolves to this account's folder",
     app.resolvedId === "mH8jBHSyYjyExCVfCJDN", app);
  ok("🔴 and it holds that folder's fields", app.fields.length === 3, app.fields);
  ok("⚠️ the folder leaves the unknown list",
     !b.unknownContactFolders.some((u) => u.id === "mH8jBHSyYjyExCVfCJDN"),
     b.unknownContactFolders.map((u) => u.id));
  ok("⚠️ and the other five are untouched — one at a time, nothing inferred",
     b.contactSections.filter((s) => s.resolvedId).length === 1,
     b.contactSections.filter((s) => s.resolvedId).map((s) => s.label));

  console.log("\n3 · ⚠️ THE CONTROL ONLY OFFERS SECTIONS THAT RESOLVE TO NOTHING");
  const pa = readFileSync("components/PipelineAdmin.tsx", "utf8");
  ok("🔴 the select filters out sections that already have a folder",
     /\.filter\(\(sec\) => !sec\.resolvedId\)/.test(pa), "two folders could claim one section");
  // ⚠️ THE PROPERTY, NOT A WINDOW SIZE. My first version allowed 200 characters
  // between the id and the first <option> and the onChange handler is longer
  // than that — an assertion that fails on formatting rather than on behaviour.
  const unkBlock = pa.slice(pa.indexOf("pfcunk-"), pa.indexOf("pfcunk-") + 1600);
  ok("⚠️ it is a select, not free text — a typo would silently do nothing",
     /<select/.test(unkBlock) && !/<input/.test(unkBlock), "still free text");
  ok("🔴 and the screen no longer says adding one needs a code change",
     !/Adding one needs a code\s*\n?\s*change today/.test(pa), "the old sentence survives");
  ok("⚠️ the foreign-map banner is wired", /data\.builtInFoldersForeign \?/.test(pa), "unwired");
}

console.log("\n4 · ⚠️ AND THE DIVISION SWITCHER SAYS WHICH LIST IT IS SHOWING");
const rs = readFileSync("components/ReferralsSection.tsx", "utf8");
ok("🔴 a fallback list is labelled as built-in, not shown as though it were live",
   /!divisionsAreLive \?/.test(rs) && /built-in divisions/.test(rs), "silent fallback");
ok("⚠️ and it names the three things to check on the field",
   /named exactly\{" "\}/.test(rs) && /is a dropdown/.test(rs), "no remedy named");

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
