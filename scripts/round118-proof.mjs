// ---------------------------------------------------------------------------
// ROUND 118 — ONE PROOF, FOUR ITEMS. Budget: no browser, no dev server.
//
// 🔴 A FAKE GOHIGHLEVEL THAT REPRODUCES THE EXACT FAILURE, then the real route
// handlers imported and invoked. Items 1-4 are LOGIC, not layout: a browser
// pass here would cost twenty times as much and prove less.
//
//   1  DELETE that answers 400 "…is deleted" must SUCCEED, and the stored
//      config entry must go with it
//   2  the three contact folders render, and "both" renders on both kinds
//   3  the attribution move: folder created, fields moved, pipelines ticked,
//      every step reported — and running it twice changes nothing
//   4  /api/clients sends NO assignedTo, and the owner read-back answers
//
// Run: npx tsx scripts/round118-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

// ── THE FAKE ACCOUNT ──────────────────────────────────────────────────────
const seen = [];                 // every request, in order
let pipelinesLive = [
  { id: "pipe_oltl", name: "OLTL Enrollment", stages: [{ id: "s1", name: "NEW" }] },
  { id: "pipe_pp", name: "Private Pay Clients", stages: [{ id: "s2", name: "NEW" }] },
  { id: "pipe_test", name: "test", stages: [{ id: "s0", name: "NEW" }] },
];
// 🔴 THE REAL FIELD NAMES. Referring Partner and Event Source sit in Referral
// Detail beside the three waiver fields — which is the whole of item 3.
let fields = [
  { id: "f_ref", name: "Referring Partner", parentId: "9OZdxXFfJsdNGR7qsQKQ", dataType: "TEXT", position: 50 },
  { id: "f_evsrc", name: "Event Source", parentId: "9OZdxXFfJsdNGR7qsQKQ", dataType: "TEXT", position: 100 },
  { id: "f_waiver", name: "Waiver Type", parentId: "9OZdxXFfJsdNGR7qsQKQ", dataType: "TEXT", position: 150 },
  { id: "f_units", name: "Authorized Units", parentId: "9OZdxXFfJsdNGR7qsQKQ", dataType: "TEXT", position: 200 },
  { id: "f_decl", name: "Referral Decline Reason", parentId: "9OZdxXFfJsdNGR7qsQKQ", dataType: "TEXT", position: 250 },
];
let customValue = {
  id: "cv1",
  name: "MM Pipeline Folders",
  value: JSON.stringify({
    seeded: true,
    folderNames: {},
    pipelines: {
      pipe_oltl: { scope: "client", folders: ["shared"] },
      pipe_pp: { scope: "client", folders: ["shared"] },
      pipe_test: { scope: "caregiver", folders: ["shared"] },
    },
  }),
};
let folderSeq = 0;
let opportunity = { id: "opp1", name: "A B", assignedTo: "", pipelineId: "pipe_oltl", pipelineStageId: "s1" };

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  const path = req.url.split("?")[0];
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method, path, body });

    if (path === "/opportunities/pipelines" && req.method === "GET")
      return json(res, 200, { pipelines: pipelinesLive });

    // 🔴 ITEM 1, REPRODUCED EXACTLY. GoHighLevel answered the delete of "test"
    // with 400 and the words "Pipeline with id … is deleted" — its own message
    // saying the thing is gone, while the screen reported a failure.
    if (path.startsWith("/opportunities/pipelines/") && req.method === "DELETE") {
      const id = path.split("/").pop();
      pipelinesLive = pipelinesLive.filter((p) => p.id !== id);
      return json(res, 400, { message: `Pipeline with id ${id} is deleted` });
    }

    if (path === "/opportunities/search")
      return json(res, 200, { opportunities: [], meta: { total: 0 } });

    if (path.startsWith("/opportunities/") && req.method === "GET")
      return json(res, 200, { opportunity });

    if (path === "/opportunities/" && req.method === "POST") {
      opportunity = { ...opportunity, ...(body || {}), id: "opp1" };
      return json(res, 200, { opportunity: { id: "opp1" } });
    }

    // ⚠️ GET ONLY. Without the method guard this caught the folder-create POST
    // that round 119 moved here and answered it with a field LIST — which is
    // how "Reply keys: customFields" ended up in the failure.
    if (path.startsWith("/locations/") && path.includes("/customFields") && req.method === "GET")
      return json(res, 200, { customFields: fields });

    // ⚠️ ROUND 119 MOVED createFieldFolder TO THE LOCATION ENDPOINT — the write
    // API refuses folders for opportunity/contact objects. This fake answered
    // only the old path, so after the fix it fell through to the customFields
    // stub and returned no id. The harness was outdated by a correct change,
    // not broken by a regression.
    if (path === "/custom-fields/folder" && req.method === "POST")
      return json(res, 400, {
        message: "Api does not support objectKey of type contact or opportunity",
      });
    if (path.startsWith("/locations/") && path.endsWith("/customFields") && req.method === "POST")
      return json(res, 200, {
        customFieldFolder: { id: `new_folder_${++folderSeq}`, name: body?.name },
      });
    if (path.startsWith("/custom-fields/") && req.method === "PUT") {
      const id = path.split("/").pop();
      const f = fields.find((x) => x.id === id);
      if (f && body?.parentId) f.parentId = body.parentId;
      return json(res, 200, { customField: f });
    }

    if (path.includes("/customValues")) {
      if (req.method === "GET") return json(res, 200, { customValues: [customValue] });
      if (req.method === "PUT" || req.method === "POST") {
        customValue = { ...customValue, value: body?.value ?? customValue.value };
        return json(res, 200, { customValue });
      }
    }
    if (path.startsWith("/users")) return json(res, 200, { users: [{ id: "u9", name: "Chris Miracle" }] });
    if (path.startsWith("/contacts")) return json(res, 200, { contact: { id: "c1" } });
    return json(res, 200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = "loc_test";
// ⚠️ SSO DELIBERATELY UNCONFIGURED. `gate()` returns null when there is no
// shared secret, which is the documented "initial setup" path — it lets the
// handlers be driven directly without forging a blob, and the admin gate itself
// is already proven by sso-gate-proof.
delete process.env.GHL_SSO_SECRET;

const post = async (mod, payload, url = "http://x/api") =>
  mod.POST(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }));

const G = await import("../lib/ghl.ts");
const F = await import("../lib/fieldFolders.ts");
const PIPES = await import("../app/api/admin/pipelines/route.ts");

// ═══ 1 · DELETE REPORTS 400 ON SUCCESS ════════════════════════════════════
console.log("\n1 · 🔴 A DELETE THAT ANSWERS 400 “is deleted”");
console.log("  GoHighLevel's own message says the pipeline is gone.");
let threw = null;
try { await G.deletePipeline("pipe_test"); } catch (e) { threw = e; }
ok("🔴 it does NOT throw — the outcome is what was asked for", !threw, threw?.message);
ok("and the pipeline really is gone from the fake account",
   !pipelinesLive.some((p) => p.id === "pipe_test"), pipelinesLive.map((p) => p.id));

console.log("\n  …and the stored entry, which 117 left behind:");
// Restore it so the ROUTE can be driven over the same failure.
pipelinesLive.push({ id: "pipe_test", name: "test", stages: [{ id: "s0", name: "NEW" }] });
const delRes = await post(PIPES, { action: "delete-pipeline", pipelineId: "pipe_test" });
const delJson = await delRes.json();
console.log(`  route answered ${delRes.status}`);
ok("🔴 the route reports SUCCESS", delRes.status === 200, delJson);
const afterCfg = JSON.parse(customValue.value);
console.log(`  stored pipelines now: ${Object.keys(afterCfg.pipelines).join(", ")}`);
ok("🔴 AND THE CONFIG ENTRY IS GONE — no stale key",
   !("pipe_test" in afterCfg.pipelines), Object.keys(afterCfg.pipelines));

console.log("\n  …and the doubled prefix:");
const e = new G.GhlError("GoHighLevel returned 400 deleting the pipeline.", 400,
                         "Pipeline with id u4 is deleted");
const explained = await G.explainGhlError(e);
console.log(`  message: "${e.message}"`);
console.log(`  detail : "${explained}"`);
ok("⚠️ the detail no longer repeats the message",
   !explained.includes("GoHighLevel returned 400"), explained);
ok("and it still carries GoHighLevel's own words",
   /is deleted/.test(explained), explained);

// ═══ 2 · THE THREE CONTACT FOLDERS ════════════════════════════════════════
console.log("\n2 · 🔴 THREE UNMAPPED CONTACT FOLDERS ARE OURS");
const contactDefs = [
  { id: "cf1", name: "Partner Category", parentId: "SjOstzm64Ur7tBkQxhUg", dataType: "TEXT", position: 50 },
  { id: "cf2", name: "Partner Tier", parentId: "SjOstzm64Ur7tBkQxhUg", dataType: "TEXT", position: 100 },
  { id: "cf3", name: "Attended", parentId: "7ygQ0GymjbM5l8kTXrkX", dataType: "CHECKBOX", position: 50 },
  { id: "cf4", name: "UTM Medium", parentId: "HeEHQZGk9fMUP7HeGYLU", dataType: "TEXT", position: 50 },
  { id: "cf5", name: "Meta Campaign ID", parentId: "HeEHQZGk9fMUP7HeGYLU", dataType: "TEXT", position: 100 },
  { id: "cf6", name: "CG - Work State", parentId: "EeU1n8FZZ4WziJwsgwpX", dataType: "TEXT", position: 50 },
];
const vals = Object.fromEntries(contactDefs.map((d) => [d.id, "x"]));
const asClient = F.groupContactFields(contactDefs, "client", vals);
const asCg = F.groupContactFields(contactDefs, "caregiver", vals);
const labels = (g) => g.map((s) => s.label);
console.log(`  on a client:    ${labels(asClient).join(" · ")}`);
console.log(`  on an applicant: ${labels(asCg).join(" · ")}`);
ok("🔴 Referral Partner renders on a client", labels(asClient).includes("Referral Partner"), labels(asClient));
ok("🔴 Event Attendance renders on a client", labels(asClient).includes("Event Attendance"), labels(asClient));
ok("🔴 Attribution renders on a client", labels(asClient).includes("Attribution"), labels(asClient));
ok("🔴 and Attribution ALSO renders on an applicant — “both”",
   labels(asCg).includes("Attribution"), labels(asCg));
ok("⚠️ but Referral Partner does NOT reach an applicant panel",
   !labels(asCg).includes("Referral Partner"), labels(asCg));
const partner = asClient.find((s) => s.label === "Referral Partner");
ok("its fields come with it", partner?.fields.length === 2, partner?.fields.map((f) => f.name));

// ═══ 3 · THE ATTRIBUTION FOLDER MOVE ══════════════════════════════════════
console.log("\n3 · 🔴 CREATE Referral Attribution, MOVE THE FIELDS, TICK IT ON");
// ⚠️ THREE REQUESTS NOW, not one — round 119, item 1. Returning every step at
// the end is what made a slow run indistinguishable from a hang.
const runAttrib = async () => {
  const steps = [];
  let folderId = "";
  let lastStatus = 200;
  for (const step of ["folder", "fields", "tick"]) {
    const r = await post(PIPES, { action: "attribution-folder", step, folderId: folderId || undefined });
    lastStatus = r.status;
    const j = await r.json();
    if (j.folderId) folderId = j.folderId;
    if (Array.isArray(j.results)) for (const x of j.results) steps.push({ step, ...x });
    else steps.push({ step, ok: j.ok !== false, detail: j.detail || j.error || "" });
    if (!r.ok) break;
  }
  return { steps, folderId, status: lastStatus };
};
const attrib = await runAttrib();
const attribRes = { status: attrib.status };
for (const s of attrib.steps || [])
  console.log(`  ${s.ok ? "ok  " : "FAIL"} [${s.step}] ${s.detail}`);
ok("the run succeeded", attribRes.status === 200, attrib);
ok("🔴 a folder was created", !!attrib.folderId, attrib.folderId);
ok("🔴 Referring Partner moved into it",
   fields.find((f) => f.id === "f_ref")?.parentId === attrib.folderId, fields[0]);
ok("🔴 Event Source moved into it",
   fields.find((f) => f.id === "f_evsrc")?.parentId === attrib.folderId, fields[1]);
// ⚠️ THE THREE WAIVER FIELDS MUST NOT MOVE. That is the whole reason for a
// second folder — Waiver Type is not attribution.
ok("⚠️ Waiver Type stayed in Referral Detail",
   fields.find((f) => f.id === "f_waiver")?.parentId === "9OZdxXFfJsdNGR7qsQKQ", fields[2]);
const cfg3 = JSON.parse(customValue.value);
console.log(`  ticked on: ${Object.entries(cfg3.pipelines)
  .filter(([, e2]) => e2.folders.includes(attrib.folderId))
  .map(([k]) => k).join(", ") || "(none)"}`);
ok("🔴 ticked onto BOTH client pipelines",
   cfg3.pipelines.pipe_oltl.folders.includes(attrib.folderId) &&
   cfg3.pipelines.pipe_pp.folders.includes(attrib.folderId), cfg3.pipelines);

console.log("\n  …and running it a second time:");
const madeBefore = folderSeq;
const again = await runAttrib();
for (const s of again.steps || []) console.log(`  ${s.ok ? "ok  " : "FAIL"} [${s.step}] ${s.detail}`);
ok("🔴 NO second folder was created — round 93's orphan cannot recur",
   folderSeq === madeBefore, { madeBefore, now: folderSeq });
ok("and it says so rather than pretending it did the work",
   (again.steps || []).some((s) => /Reused|already/i.test(s.detail)), again.steps);

// ═══ 4 · OWNERSHIP DECIDED ONCE ═══════════════════════════════════════════
console.log("\n4 · 🔴 /api/clients SENDS NO OWNER; THE WORKFLOW DOES");
const CLIENTS = await import("../app/api/clients/route.ts");
seen.length = 0;
const created = await post(CLIENTS, {
  firstName: "Ada", lastName: "Tester", pipelineId: "pipe_oltl", stageId: "s1",
}, "http://x/api/clients");
const cj = await created.json();
const oppPost = seen.find((r) => r.method === "POST" && r.path === "/opportunities/");
console.log(`  route answered ${created.status} · ownerAuthor=${cj.ownerAuthor}`);
console.log(`  body sent to GoHighLevel: ${JSON.stringify(oppPost?.body)}`);
ok("the lead was created", created.status === 200 && cj.ok, cj);
ok("🔴 NO assignedTo was sent — the workflow is the only author",
   oppPost && !("assignedTo" in (oppPost.body || {})), oppPost?.body);
ok("🔴 and the response says WHO decides, so the caller knows to look",
   cj.ownerAuthor === "workflow", cj);

console.log("\n  …and the read-back, both answers:");
const OWNER = await import("../app/api/opportunities/[id]/owner/route.ts");
const ask = async () =>
  (await OWNER.GET(new Request("http://x/api/opportunities/opp1/owner"), {
    params: Promise.resolve({ id: "opp1" }),
  })).json();
opportunity.assignedTo = "";
const unassigned = await ask();
console.log(`  before the workflow runs: ${JSON.stringify(unassigned)}`);
ok("🔴 it reports NOBODY rather than staying silent", unassigned.ownerId === "", unassigned);
// The workflow assigns.
opportunity.assignedTo = "u9";
const assigned = await ask();
console.log(`  after the workflow runs:  ${JSON.stringify(assigned)}`);
ok("🔴 and it sees the change — the read is uncached", assigned.ownerId === "u9", assigned);
ok("with the person's name, not an id", assigned.ownerName === "Chris Miracle", assigned);

console.log(`\n${pass} passed, ${fail} failed.`);
server.close();
process.exit(fail ? 1 : 0);
