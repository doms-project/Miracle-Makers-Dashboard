// ---------------------------------------------------------------------------
// ROUND 119 — ONE PROOF, FOUR ITEMS. Budget: no browser, no dev server.
//
// 🔴 A FAKE GOHIGHLEVEL THAT REPRODUCES EACH FAILURE FIRST:
//   1  /custom-fields/ answers the real refusal — "Api does not support
//      objectKey of type contact or opportunity" — and the location endpoint
//      works, exactly as the account does
//   2  the customValues read-back lags by one request, as a settling store does
//   3  a refusal is marked and carries its sentence alone
//   4  (a render concern; the disabled attributes are asserted by reading the
//      component, not guessed — see the note at the bottom)
//
// Run: npx tsx scripts/round119-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const seen = [];
let folderSeq = 0;
// 🔴 THE READ-BACK LAG. `served` is what a GET returns; `stored` is what the
// last PUT wrote. They converge after ONE further read — which is exactly the
// shape that produced a false "truncated" and then worked on a second click.
let stored = JSON.stringify({
  seeded: true, folderNames: {},
  pipelines: { pipe_oltl: { scope: "client", folders: ["shared"] } },
});
let served = stored;
let lagReads = 0;

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

    // 🔴 ITEM 1's ROOT CAUSE, AS THE ACCOUNT ACTUALLY BEHAVES. Round 90 wrote
    // the distinction down and round 93 moved createCustomField; createFieldFolder
    // was left on the write API, which refuses these objects outright.
    if (path === "/custom-fields/folder" && req.method === "POST")
      return json(res, 400, {
        message: "Api does not support objectKey of type contact or opportunity",
      });

    if (path.startsWith("/locations/") && path.endsWith("/customFields") && req.method === "POST") {
      if (body?.documentType !== "folder")
        return json(res, 400, { message: "documentType must be folder" });
      // ⚠️ THE RESPONSE KEY IS customFieldFolder, NOT customField.
      return json(res, 200, {
        customFieldFolder: { id: `fold_${++folderSeq}`, name: body.name },
      });
    }

    if (path.includes("/customValues")) {
      if (req.method === "GET") {
        // Serve the stale value for the first `lagReads` reads after a write.
        if (lagReads > 0) { lagReads -= 1; return json(res, 200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders", value: served }] }); }
        served = stored;
        return json(res, 200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders", value: stored }] });
      }
      if (req.method === "PUT" || req.method === "POST") {
        stored = body?.value ?? stored;
        lagReads = 1;                 // one stale read, then it settles
        return json(res, 200, { customValue: { id: "cv1" } });
      }
    }

    if (path.startsWith("/locations/") && path.includes("/customFields"))
      return json(res, 200, { customFields: [] });
    if (path === "/opportunities/pipelines") return json(res, 200, { pipelines: [] });
    return json(res, 200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = "loc_test";
delete process.env.GHL_SSO_SECRET;

const G = await import("../lib/ghl.ts");
const A = await import("../lib/apiFetch.ts");

// ═══ 1 · THE FOLDER ENDPOINT ══════════════════════════════════════════════
console.log("\n1 · 🔴 createFieldFolder WAS CALLING THE WRONG API");
console.log("  /custom-fields/ answers: \"Api does not support objectKey of type");
console.log("  contact or opportunity\" — so the button could never have worked.");
seen.length = 0;
const made = await G.createFieldFolder({ name: "Referral Attribution" });
const paths = seen.filter((r) => r.method === "POST").map((r) => r.path);
console.log(`  POSTs made: ${paths.join(", ")}`);
console.log(`  folder: ${JSON.stringify(made)}`);
ok("🔴 it uses the LOCATION endpoint, which works",
   paths.some((p) => /\/locations\/.*\/customFields$/.test(p)), paths);
ok("🔴 and never touches /custom-fields/folder",
   !paths.includes("/custom-fields/folder"), paths);
const sent = seen.find((r) => r.method === "POST" && /customFields$/.test(r.path))?.body;
console.log(`  body: ${JSON.stringify(sent)}`);
ok("⚠️ with THIS endpoint's vocabulary: documentType, not objectKey",
   sent?.documentType === "folder" && !("objectKey" in (sent || {})), sent);
ok("and model, which is how it names the object", sent?.model === "opportunity", sent);
ok("🔴 the id is read from customFieldFolder", made.id === "fold_1", made);

// ═══ 2 · THE FALSE "TRUNCATED" ════════════════════════════════════════════
console.log("\n2 · 🔴 A READ-BACK THAT LAGS MUST NOT REPORT TRUNCATION");
console.log("  The fake store serves ONE stale read after every write.");
seen.length = 0;
let saveErr = null;
let saved = null;
try {
  saved = await G.savePipelineConfig({
    seeded: true, folderNames: {},
    pipelines: {
      pipe_oltl: { scope: "client", folders: ["shared", "transfer"] },
      pipe_cg: { scope: "caregiver", folders: ["shared"] },
    },
  });
} catch (e) { saveErr = e; }
const reads = seen.filter((r) => r.method === "GET" && r.path.includes("customValues")).length;
console.log(`  customValues GETs: ${reads}`);
ok("🔴 it did NOT report a failure", !saveErr, saveErr?.message);
ok("🔴 it RE-READ rather than re-writing",
   seen.filter((r) => r.method === "PUT" || r.method === "POST").length === 1,
   seen.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`));
ok("and the save returned the stored config", !!saved?.pipelines?.pipe_cg, saved);

console.log("\n  …and normalisation is no longer read as truncation:");
// 🔴 `exclude: []` IS DROPPED BY THE PARSER ON PURPOSE (round 116). The old
// guard compared raw strings against what was sent, so this alone would have
// reported "it may have been truncated" about a perfect save.
lagReads = 0;
const withEmpty = await G.savePipelineConfig({
  seeded: true, folderNames: {},
  pipelines: { pipe_oltl: { scope: "client", folders: ["shared"], exclude: [] } },
});
ok("🔴 an empty `exclude` the parser drops does not fail the guard",
   !!withEmpty, withEmpty);
ok("and it came back without the empty key",
   withEmpty.pipelines.pipe_oltl.exclude === undefined, withEmpty.pipelines.pipe_oltl);

// ═══ 3 · A REFUSAL IS NOT AN ERROR ════════════════════════════════════════
console.log("\n3 · 🔴 A REFUSAL CARRIES ITS SENTENCE, NOT A FAULT WRAPPER");
const refusalBody = {
  error: "12 records are in this pipeline. Move or close them in GoHighLevel first.",
  status: 409, refusal: true,
};
const faultBody = {
  error: "GoHighLevel returned 400 deleting the pipeline.",
  detail: "Pipeline with id u4 is deleted", status: 400,
};
const mk = (b, status) =>
  A.apiError(new Response(null, { status }), b);
const r1 = mk(refusalBody, 409);
const r2 = mk(faultBody, 400);
console.log(`  refusal → "${r1.message}"  refusal=${r1.refusal}`);
console.log(`  fault   → "${r2.message}"  refusal=${r2.refusal}`);
ok("🔴 the refusal is marked", r1.refusal === true, r1.refusal);
ok("🔴 and its message is the sentence ALONE, with no em-dash detail appended",
   r1.message === refusalBody.error, r1.message);
ok("⚠️ a fault is NOT marked", r2.refusal === false || !r2.refusal, r2.refusal);
ok("and a fault still gets its detail", /is deleted/.test(r2.message), r2.message);

// ═══ 4 · NO SILENT WRITES ═════════════════════════════════════════════════
// ⚠️ READ FROM THE SOURCE, NOT GUESSED. This is the one item that is about
// rendering, and a browser pass for four `disabled` attributes is not what the
// budget is for — but "I added it" is not evidence either. The assertions below
// read the component and check every WRITE control carries a disable.
console.log("\n4 · 🔴 EVERY WRITE CONTROL IS DISABLED WHILE ONE IS IN FLIGHT");
const src = readFileSync("components/PipelineAdmin.tsx", "utf8");
const checks = [
  ["the section tickbox", /<input\s+type="checkbox"\s+checked=\{checked\}\s+disabled=\{busy\}/],
  ["the per-field tickbox", /className="pffbox"[\s\S]{0,500}?disabled=\{busy\s*\|\|/],
  ["the scope dropdown", /id=\{`pfscope-\$\{p\.id\}`\}[\s\S]{0,120}?disabled=\{busy\}/],
  ["the delete button", /className="pfdangerbtn"\s*\n\s*disabled=\{busy\}/],
];
for (const [what, re] of checks) ok(`${what} is disabled while busy`, re.test(src), what);
ok("🔴 and the row in flight says so", /busyRow === p\.id/.test(src) && /pfspin/.test(src), "no row spinner");
ok("⚠️ the refusal renders directly, not through ErrorMessage",
   /rowMsg\.refusal \?[\s\S]{0,200}savemsg warn/.test(src), "refusal not rendered directly");
ok("🔴 and it focuses the control that fixes it",
   /getElementById\(`pfscope-\$\{p\.id\}`\)\?\.focus\(\)/.test(src), "no focus");
// ⬜ ROUND 124 RETIRED THE THREE ATTRIBUTION ASSERTIONS HERE — the button, its
// step name and its three-request loop. That run was a ONE-TIME MIGRATION, it
// is complete, and leaving it on the screen meant somebody could re-run it in
// six months and silently move two fields back. Replaced rather than deleted,
// so a missing section is never mistaken for one that went red.
ok("🔴 the attribution control is gone",
   !/attribNow/.test(src) && !/pfattrib/.test(src), "it survives");
ok("⚠️ and every REMAINING write control still carries its disable",
   checks.every(([, re]) => re.test(src)), "a control lost its disable");

console.log(`\n${pass} passed, ${fail} failed.`);
server.close();
process.exit(fail ? 1 : 0);
