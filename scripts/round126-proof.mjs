// ---------------------------------------------------------------------------
// ROUND 126 — "FILE IN" STILL READS TRANSFERRED IN.
//
// 🔴 THE FIXTURE RULE FOR THIS FILE, AND IT IS THE POINT OF THE ROUND:
// **the stage lists here do NOT all carry `position`.** Round 121 proved its
// ordering fix against a fake that supplies it on every stage, which is exactly
// the class of harness bug the owner named — a fake answering something the
// real API may not. Three shapes are driven instead:
//
//   A  position present, NEW LEAD lowest        (round 121's fixture)
//   B  🔴 NO position at all                    (cause (a): the sort is a no-op)
//   C  🔴 position present, TRANSFERRED IN = 0  (cause (c): the sort is RIGHT
//                                                and the answer is still wrong)
//
// A fix that only survives A is the fix we already had.
//
// ⚠️ AND THE WHOLE ROUTE IS DRIVEN, not just the helper: the picker's label and
// the stage the write actually uses must be the same stage, or the dialog
// promises one thing and files another.
//
// Run: npx tsx scripts/round126-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import CryptoJS from "crypto-js";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const RT = "F_RT", PDIV = "F_PDIV", REF = "F_REF";
const ADMIN = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Admin", email: "a@e.com", companyId: "co1",
}), SECRET).toString();

// ── THE THREE SHAPES ───────────────────────────────────────────────────────
// ⚠️ Same five stage NAMES on all three, so nothing can pass because one
// fixture happens to be easier.
const NAMES = ["TRANSFERRED IN", "NEW LEAD", "INITIAL CALL", "AUTH PENDING", "ACTIVE"];
const mk = (id, name, stages) => ({ id, name, stages });
const SHAPES = {
  // A · what round 121 assumed: position present, and NEW LEAD is lowest.
  A: NAMES.map((n, i) => ({ id: `s${i}`, name: n, position: n === "NEW LEAD" ? 0 : i + 1 })),
  // B · 🔴 NO POSITION AT ALL. firstStage() has nothing to sort by.
  B: NAMES.map((n, i) => ({ id: `s${i}`, name: n })),
  // C · 🔴 POSITION PRESENT AND TRANSFERRED IN IS 0. Sorting is correct and the
  //      answer is still wrong, because ordering was never the question.
  C: NAMES.map((n, i) => ({ id: `s${i}`, name: n, position: i })),
};
// 🔴 THE SHAPE THE ROUTE SEES IS FIXED FOR THE WHOLE PROCESS, and that is not
// a convenience — `getPipelines()` memoises the pipeline list in module state,
// so the SECOND shape would silently be answered from the FIRST one's cache.
// An assertion that passes because nothing was re-read is worse than no
// assertion. Section 4 therefore re-runs this file in a child process with the
// other shape rather than pretending one process can test both.
const SHAPE = process.env.PROOF_SHAPE || "B";
const CHILD = process.env.PROOF_CHILD === "1";

const opps = [];
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
        ? [{ id: REF, name: "Referring Partner", dataType: "TEXT" }]
        : [
            { id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS",
              picklistOptions: ["Referral Partner", "Event Attendee"] },
            { id: PDIV, name: "Partner Division", dataType: "SINGLE_OPTIONS",
              picklistOptions: ["Private Pay", "OLTL", "ODP", "All"] },
          ] });
    if (path.startsWith("/users/")) return json(res, 200, { users: [{ id: "u1", name: "Admin" }] });
    if (path === "/opportunities/pipelines")
      // 🔴 THE STAGES ARE SENT IN THE ORDER GOHIGHLEVEL SENDS THEM — TRANSFERRED
      // IN first — because that is what the account does. Round 121 measured it
      // on all five client pipelines.
      return json(res, 200, { pipelines: [mk("pipe_pp", "Private Pay Clients", SHAPES[SHAPE])] });
    if (path === `/locations/${LOC}/customValues`)
      return json(res, 200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({ seeded: true, folderNames: {},
          pipelines: { pipe_pp: { scope: "client", folders: [] } } }) }] });
    if (path === "/opportunities/search") return json(res, 200, { opportunities: [], meta: { total: 0 } });
    if (path === "/contacts/search") {
      const want = body?.filters?.[0]?.value;
      if (want === "Referral Partner")
        return json(res, 200, { contacts: [{ id: "p1", contactName: "Riddle Hospital",
          customFields: [{ id: RT, value: "Referral Partner" }, { id: PDIV, value: "Private Pay" }] }], total: 1 });
      return json(res, 200, { contacts: [], total: 0 });
    }
    if (path === "/contacts/upsert") return json(res, 200, { contact: { id: "c_new" }, new: true });
    if ((path === "/opportunities" || path === "/opportunities/") && req.method === "POST") {
      opps.push(body);
      return json(res, 200, { opportunity: { id: `o${opps.length}` } });
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

const G = await import("../lib/ghl.ts");
const referrals = await import("../app/api/referrals/route.ts");

// ═══ 1 · THE HELPER, UNDER ALL THREE SHAPES ═══════════════════════════════
console.log("\n1 · 🔴 THE FIX MUST NOT DEPEND ON `position` BEING SENT");
for (const [k, stages] of Object.entries(SHAPES)) {
  const p = { id: "x", name: "Private Pay Clients", stages };
  const first = G.firstStage(p);
  const entry = G.entryStage(p);
  const has = stages.some((s) => Number.isFinite(s.position));
  console.log(`  shape ${k} (position ${has ? "present" : "ABSENT"}): ` +
    `firstStage -> ${first.name.padEnd(15)} entryStage -> ${entry.name}`);
  ok(`🔴 shape ${k} · a new enquiry is NOT filed as a transfer`,
     !/transferred/i.test(entry.name), entry);
  ok(`shape ${k} · it lands on NEW LEAD`, entry.name === "NEW LEAD", entry);
  ok(`shape ${k} · and it does not report a fallback`, entry.fellBack === false, entry);
}
console.log("\n  …and what the OLD helper answered, which is the bug report:");
ok("🔴 firstStage answers TRANSFERRED IN when position is absent (cause a)",
   G.firstStage({ stages: SHAPES.B }).name === "TRANSFERRED IN", G.firstStage({ stages: SHAPES.B }));
ok("🔴 and ALSO when position is present but TRANSFERRED IN is 0 (cause c)",
   G.firstStage({ stages: SHAPES.C }).name === "TRANSFERRED IN", G.firstStage({ stages: SHAPES.C }));
console.log("  ⚠️ two different causes, one identical screen — which is why the");
console.log("     fallback hid the failure and round 121's proof stayed green.");

// ═══ 2 · WHAT THE PICKER IS TOLD ══════════════════════════════════════════
// ⚠️ NO REASSIGNMENT HERE. An earlier draft set SHAPE = "B" at this point and
// silently overrode the env the child process was started with, so the child
// re-ran shape B and the shape-C assertion passed on the wrong fixture. The
// process shape is decided once, at the top.
console.log(`\n2 · 🔴 THE PICKER SHOWS WHAT THE SERVER COMPUTED — UNDER SHAPE ${SHAPE}`);
const payload = async () => {
  const r = await referrals.GET(
    new Request("http://x/api/referrals", { headers: { "x-ghl-sso-key": ADMIN } }),
  );
  return r.json();
};
const p1 = await payload();
const choice = p1.clientPipelines[0];
console.log(`  clientPipelines[0]: ${JSON.stringify(choice)}`);
ok("🔴 the label the dialog draws is not TRANSFERRED IN",
   !/transferred/i.test(choice.stage), choice);
ok("it is NEW LEAD", choice.stage === "NEW LEAD", choice);
ok("⚠️ and the stageId matches that stage, not a different one",
   choice.stageId === SHAPES.B.find((s) => s.name === "NEW LEAD").id, choice);
ok("no fallback is claimed", choice.stageFellBack === false, choice);

// ═══ 3 · AND THE WRITE USES THE SAME STAGE ════════════════════════════════
console.log("\n3 · 🔴 THE DIALOG PROMISED ONE STAGE AND THE WRITE MUST USE IT");
opps.length = 0;
const r = await referrals.POST(new Request("http://x/api/referrals", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ssoKey: ADMIN, action: "log-referral", partnerId: "p1",
    firstName: "Test", lastName: "Referral", phone: "610-555-0000",
    pipelineId: "pipe_pp",
  }),
}));
const out = await r.json();
const wrote = opps[opps.length - 1];
console.log(`  -> ${r.status} stageName=${out.stageName}  wrote pipelineStageId=${wrote?.pipelineStageId}`);
ok("the referral was created", r.status === 200, out);
ok("🔴 it was filed at NEW LEAD, not TRANSFERRED IN",
   wrote?.pipelineStageId === SHAPES.B.find((s) => s.name === "NEW LEAD").id, wrote);
ok("⚠️ and the stage the response NAMES is the stage it USED",
   out.stageName === "NEW LEAD", out);

// ═══ 4 · SHAPE C THROUGH THE ROUTE, IN ITS OWN PROCESS ════════════════════
if (CHILD) {
  // The child exists to answer exactly one question, in a process whose
  // pipeline cache has only ever held shape C.
  console.log(`CHILD(${SHAPE}) stage=${choice.stage} stageId=${choice.stageId}`);
  server.close();
  process.exit(choice.stage === "NEW LEAD" ? 0 : 1);
}
console.log("\n4 · 🔴 POSITION SENT, TRANSFERRED IN AT 0 — THE SORT IS RIGHT AND WRONG");
console.log("  re-running this file with PROOF_SHAPE=C, because the pipeline list");
console.log("  is memoised per process and re-reading it here would be answered");
console.log("  from shape B's cache.");
let childOut = "";
let childOk = false;
try {
  childOut = execSync("npx tsx scripts/round126-proof.mjs", {
    encoding: "utf8",
    env: { ...process.env, PROOF_SHAPE: "C", PROOF_CHILD: "1" },
  });
  childOk = true;
} catch (e) {
  childOut = `${e.stdout || ""}${e.stderr || ""}`;
}
const line = (childOut.match(/CHILD\(C\)[^\n]*/) || ["(no child line)"])[0];
console.log(`  ${line}`);
ok("🔴 still NEW LEAD with TRANSFERRED IN at position 0 — the rule is meaning, not order",
   childOk && /CHILD\(C\) stage=NEW LEAD/.test(childOut), line);

// ═══ 5 · THE SIXTH SITE ROUND 121 MISSED ══════════════════════════════════
console.log("\n5 · 🔴 ROUND 121 FIXED 'ALL FIVE STAGE SITES' — THERE WERE MORE");
const cg = readFileSync("app/api/caregivers/route.ts", "utf8");
const cl = readFileSync("app/api/clients/route.ts", "utf8");
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
console.log("  ⚠️ comments stripped first — three rounds running a check has");
console.log("     matched my own prose about the bug instead of the bug.");
ok("🔴 the applicant intake no longer uses stages[0]",
   !/stages\?\.\[0\]|stages\[0\]/.test(strip(cg)), "stages[0] survives in /api/caregivers");
ok("it uses the same rule as a referral", /entryStage\(/.test(strip(cg)), "no entryStage");
ok("🔴 and the client route's last-resort fallback does not either",
   !/stages \|\| \[\]\)\[0\]/.test(strip(cl)), "stages[0] survives in /api/clients");
const all = ["app/api/referrals/route.ts", "app/api/caregivers/route.ts", "app/api/clients/route.ts"]
  .map((f) => strip(readFileSync(f, "utf8")));
ok("⚠️ and no route picks a stage by array index any more",
   !all.some((t) => /stages[^\n]{0,12}\[0\]/.test(t)), "an index-based pick survives");

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
