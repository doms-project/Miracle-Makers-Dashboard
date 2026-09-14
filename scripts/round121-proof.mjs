// ---------------------------------------------------------------------------
// ROUND 121 — ONE PROOF, AND A FAKE THAT REFUSES WHAT GOHIGHLEVEL REFUSES.
//
// 🔴 THE PATTERN THE OWNER NAMED, AND IT IS THE RULE THIS FILE FOLLOWS:
//
//   "a fake that answers something GoHighLevel would refuse is a harness bug,
//    whether or not a test is red."
//
// Four rounds running, a proof passed against a fake that accepted a call the
// real thing rejects: 118's Number(null), 119's missing method guard, 115c's
// PUT-to-a-PATCH-route, and now moveFieldToFolder. So this fake:
//   · 400s /custom-fields/{id} with the REAL message
//   · 400s a POST to /custom-fields/ for these objects, as 119 established
//   · answers ONLY the location endpoint, and only with the right vocabulary
//   · returns stages OUT of position order, as the account does
//
// Run: npx tsx scripts/round121-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const seen = [];
let fields = [
  { id: "f_ref", name: "Referring Partner", parentId: "old_folder", dataType: "TEXT", position: 50 },
];
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

    // 🔴 THE REAL REFUSALS. Verified live by the owner, both of them.
    if (path === "/custom-fields/folder" && req.method === "POST")
      return json(res, 400, { message: "Api does not support objectKey of type contact or opportunity" });
    if (/^\/custom-fields\/[^/]+$/.test(path) && req.method === "PUT")
      return json(res, 400, { message: "Fields with model opportunity is not supported on this route" });

    if (/^\/locations\/[^/]+\/customFields\/[^/]+$/.test(path) && req.method === "PUT") {
      const id = path.split("/").pop();
      const f = fields.find((x) => x.id === id);
      if (f && body?.parentId) f.parentId = body.parentId;
      return json(res, 200, { customField: f });
    }
    if (/^\/locations\/[^/]+\/customFields$/.test(path) && req.method === "POST")
      return json(res, 200, { customFieldFolder: { id: "new_folder", name: body?.name } });
    if (/^\/locations\/[^/]+\/customFields$/.test(path) && req.method === "GET")
      return json(res, 200, { customFields: fields });

    // 🔴 STAGES OUT OF POSITION ORDER — exactly what the account returns. Every
    // client pipeline answered "TRANSFERRED IN" from stages[0].
    if (path === "/opportunities/pipelines")
      return json(res, 200, { pipelines: [
        { id: "pipe_oltl", name: "OLTL Enrollment", stages: [
          { id: "s_ti", name: "TRANSFERRED IN", position: 4 },
          { id: "s_new", name: "NEW LEAD", position: 0 },
          { id: "s_call", name: "INITIAL CALL", position: 1 },
        ] },
        { id: "pipe_pp", name: "Private Pay Clients", stages: [
          { id: "p_ti", name: "TRANSFERRED IN", position: 6 },
          { id: "p_new", name: "NEW LEAD", position: 0 },
        ] },
      ] });
    return json(res, 200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = "loc_test";
delete process.env.GHL_SSO_SECRET;

const G = await import("../lib/ghl.ts");

// ═══ 1 · moveFieldToFolder ════════════════════════════════════════════════
console.log("\n1 · 🔴 THE FIELD MOVE WAS ON THE ROUTE THAT REFUSES IT");
console.log('  PUT /custom-fields/{id} -> "Fields with model opportunity is not');
console.log('  supported on this route" — the fake answers exactly that.');
seen.length = 0;
const moved = await G.moveFieldToFolder("f_ref", "new_folder");
const puts = seen.filter((r) => r.method === "PUT").map((r) => r.path);
console.log(`  PUTs made: ${puts.join(", ")}`);
console.log(`  body: ${JSON.stringify(seen.find((r) => r.method === "PUT")?.body)}`);
ok("🔴 it uses the LOCATION endpoint", puts.some((p) => /^\/locations\/.*\/customFields\//.test(p)), puts);
ok("🔴 and never touches /custom-fields/{id}", !puts.some((p) => /^\/custom-fields\//.test(p)), puts);
ok("⚠️ the body is { parentId } — no locationId, which that route takes in the path",
   seen.find((r) => r.method === "PUT")?.body?.parentId === "new_folder" &&
   !("locationId" in (seen.find((r) => r.method === "PUT")?.body || {})),
   seen.find((r) => r.method === "PUT")?.body);
ok("the field actually moved", fields[0].parentId === "new_folder", fields[0]);
ok("and it reports success", moved.ok, moved);

console.log("\n  …and nothing else is left on that route:");
const ghl = readFileSync("lib/ghl.ts", "utf8");
// ⚠️ STRIP THE COMMENTS FIRST. Matching string literals over the raw file
// found this file's OWN prose about the two APIs — the third time in three
// rounds a regex has read my explanation as evidence. A sweep that quotes a
// comment back at you is worse than no sweep.
const code = ghl
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join("\n");
// ⚠️ A GENERIC CONTAINS ">" — `ghlSend<Record<string, unknown>>` — so
// `ghlSend<[^>]*>` could never match it. Look for the PATH literal in code.
const stray = [...code.matchAll(/"(\/custom-fields\/[^"]*)"/g)].map((m) => m[1]);
console.log(`  /custom-fields/ CALL SITES remaining: ${stray.join(", ") || "(none)"}`);
// ⚠️ ONE REMAINS AND IT IS CORRECT: POST /custom-fields/ creates a FIELD, which
// round 93 verified works. What that route refuses is folders and field
// UPDATES for these objects — two different operations on one path.
ok("⚠️ only the field CREATE remains, which round 93 proved works",
   stray.length === 1 && stray[0] === "/custom-fields/", stray);

// ═══ 2 · THE FIRST STAGE ══════════════════════════════════════════════════
console.log("\n2 · 🔴 THE FIRST STAGE IS BY POSITION, NOT ARRAY ORDER");
const pipes = await G.listPipelines();
for (const p of pipes) {
  const arr0 = p.stages[0];
  const first = G.firstStage(p);
  console.log(`  ${p.name.padEnd(22)} stages[0]="${arr0.name}"  firstStage="${first.name}"`);
  ok(`${p.name}: NOT TRANSFERRED IN`, first.name !== "TRANSFERRED IN", first);
  ok(`${p.name}: it is the position-0 stage`, first.name === "NEW LEAD", first);
}
ok("🔴 and array order really would have been wrong — the fake proves it",
   pipes.every((p) => p.stages[0].name === "TRANSFERRED IN"), pipes.map((p) => p.stages[0].name));
ok("⚠️ an empty pipeline answers blank, not a crash",
   G.firstStage({ stages: [] }).id === "" && G.firstStage(null).id === "", "threw");
ok("⚠️ and with no positions at all it falls back to array order",
   G.firstStage({ stages: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }).name === "A", "wrong fallback");

// ═══ 3 · THE METHOD MISMATCH ══════════════════════════════════════════════
console.log("\n3 · 🔴 THE CLIENT NO LONGER CALLS ITS OWN API THE WRONG WAY");
const rs = readFileSync("components/ReferralsSection.tsx", "utf8");
const route = readFileSync("app/api/opportunities/[id]/route.ts", "utf8");
const exported = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) =>
  new RegExp(`export\\s+async\\s+function\\s+${m}\\b`).test(route),
);
console.log(`  /api/opportunities/[id] exports: ${exported.join(", ")}`);
const calls = [...rs.matchAll(/api\/opportunities\/\$\{encodeURIComponent\([^)]+\)\}`?,?\s*\{\s*(?:\/\/[^\n]*\n\s*)*method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
console.log(`  ReferralsSection sends: ${calls.join(", ") || "(none matched)"}`);
ok("the route exports PATCH only", exported.length === 1 && exported[0] === "PATCH", exported);
ok("🔴 and NO call sends PUT any more", !/method: "PUT"/.test(rs), "a PUT remains");
ok("⚠️ both of them were wrong, not one", calls.length >= 1 && calls.every((m) => m === "PATCH"), calls);

const api = readFileSync("lib/apiFetch.ts", "utf8");
ok("🔴 and a 405 now says what it is", /called its own API the wrong way/.test(api), "no 405 message");
ok("⚠️ without blaming GoHighLevel", /Nothing was sent to GoHighLevel/.test(api), "still blames GHL");

// ═══ 4 · THE DEPENDENT STEP ═══════════════════════════════════════════════
console.log("\n4 · 🔴 THE TICK DOES NOT RUN WHEN NEITHER FIELD MOVED");
const admin = readFileSync("components/PipelineAdmin.tsx", "utf8");
ok("🔴 a step whose prerequisite failed is skipped",
   /j\.results\.every\(\(r: \{ ok\?: boolean \}\) => r\.ok === false\)/.test(admin), "no guard");
ok("⚠️ and it SAYS it skipped, rather than going quiet",
   /ticking it onto every client pipeline would add a section with/.test(admin), "silent skip");

// ═══ 5 · THE EVENT MESSAGE ════════════════════════════════════════════════
console.log("\n5 · 🔴 THE DUPLICATE MESSAGE STOPS TALKING ABOUT CLIENTS AND MOVES");
const ev = await G.explainGhlError(
  new G.GhlError("Could not save.", 400,
    "This location does not allow duplicate opportunity for the contact in Events pipeline"),
);
const cl = await G.explainGhlError(
  new G.GhlError("Could not save.", 400,
    "OPPORTUNITY_NO_DUPLICATE in OLTL Enrollment"),
);
console.log(`  event: ${ev.slice(0, 120)}…`);
ok("🔴 no \"this client\"", !/this client/i.test(ev), ev);
ok("🔴 no \"moved\"", !/moved/i.test(ev), ev);
ok("⚠️ and it names the real constraint", /ONE opportunity per contact per pipeline/.test(ev), ev);
ok("⚠️ saying it is GoHighLevel's limit, not ours", /not a rule this dashboard chose/.test(ev), ev);
ok("the MOVE wording is untouched for a client", /can't be moved there/.test(cl), cl);

// ═══ 6 · THE LISTING COLLAPSES ════════════════════════════════════════════
console.log("\n6 · ✅ THE CONTACT LISTING IS COLLAPSED, WITH THE COUNT IN THE HEADER");
const css = readFileSync("app/globals.css", "utf8");
ok("it is a <details>", /<details className="pfcontacts-wrap">/.test(admin), "not collapsed");
ok("🔴 with the round-119 guard, so it actually closes",
   /\.pfcontacts-wrap:not\(\[open\]\) > :not\(summary\)\{display:none;\}/.test(css), "no guard");
ok("the count is in the header", /mapped[\s\S]{0,120}not known about/.test(admin), "no count");
ok("🔴 the unmapped three stay OUTSIDE the collapse",
   admin.indexOf("</details>") < admin.indexOf("unknownContactFolders?.length ? ("), "inside");
ok("⚠️ and \"same name in GoHighLevel\" no longer repeats", !/pfcsame/.test(admin), "still there");

console.log(`\n${pass} passed, ${fail} failed.`);
server.close();
process.exit(fail ? 1 : 0);
