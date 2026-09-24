// ---------------------------------------------------------------------------
// ROUND 138 — createCustomField WAS ON THE API THAT REFUSES IT.
//
// 🔴 THE CONTROL IS THE WHOLE PROOF, and it is the reason round 121 went green
// against this bug for four rounds.
//
// "The location endpoint works" passes against a fake that answers everything.
// What makes it mean something is that THE OLD ENDPOINT IS REFUSED IN THE SAME
// RUN, with GoHighLevel's own words:
//
//     POST /custom-fields/  ->  400
//     "Api does not support objectKey of type contact or opportunity"
//
// So if the code went back to it, the create would throw rather than pass. The
// fake below refuses it exactly as the account does — verified live through the
// real caller, `POST /api/admin/pipelines` → `createCustomField`.
//
// ⚠️ AND THE ADJACENT PATHS ARE DRIVEN TOO. If "add field" had never worked,
// something beside it might not either. Folder create, field move and the
// option append all go through this same fake, which refuses every wrong route.
//
// Run: npx tsx scripts/round138-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
/** Every request the fake saw, so "which endpoint" is read, not assumed. */
const seen = [];
let fields = [
  { id: "f_old", name: "Care Needs", dataType: "TEXT", parentId: "fold_a",
    picklistOptions: [] },
  { id: "f_opt", name: "Referral Type", dataType: "SINGLE_OPTIONS", parentId: "fold_a",
    picklistOptions: ["A", "B"] },
];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    const [path, qs] = req.url.split("?");
    const q = new URLSearchParams(qs || "");
    seen.push({ method: req.method, path, body });
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    // ═══ 🔴 THE THREE REAL REFUSALS. ALL VERIFIED LIVE ON THIS ACCOUNT. ═══
    // Anything that reaches these has gone back to the Custom Objects API.
    if (path === "/custom-fields/" && req.method === "POST")
      return json(400, { message: "Api does not support objectKey of type contact or opportunity" });
    if (path === "/custom-fields/folder" && req.method === "POST")
      return json(400, { message: "Api does not support objectKey of type contact or opportunity" });
    if (/^\/custom-fields\/[^/]+$/.test(path) && req.method === "PUT")
      return json(400, { message: "Fields with model opportunity is not supported on this route" });

    // ═══ THE LOCATION API — ONE ENDPOINT, TWO OPERATIONS ═════════════════════
    if (/^\/locations\/[^/]+\/customFields$/.test(path) && req.method === "POST") {
      // 🔴 `documentType` IS THE DISCRIMINATOR AND THE FAKE HONOURS IT. A field
      // create that omitted it would come back as a FOLDER here, exactly as it
      // would live — which is the mistake the key exists to prevent.
      if (body?.documentType === "folder")
        return json(200, { customFieldFolder: { id: "new_folder", name: body?.name } });
      if (body?.documentType === "field") {
        const f = {
          id: `new_${fields.length}`,
          name: body.name,
          dataType: body.dataType,
          parentId: body.parentId ?? "",
          picklistOptions: body.options ?? [],
        };
        fields = [...fields, f];
        return json(201, { customField: f });
      }
      // ⚠️ NEITHER: GoHighLevel has no third meaning for this call.
      return json(422, { message: "documentType is required" });
    }
    if (/^\/locations\/[^/]+\/customFields\/[^/]+$/.test(path) && req.method === "PUT") {
      const id = path.split("/").pop();
      const f = fields.find((x) => x.id === id);
      if (!f) return json(404, { message: "not found" });
      if (body?.parentId !== undefined) f.parentId = body.parentId;
      if (body?.options !== undefined) f.picklistOptions = body.options;
      return json(200, { customField: f });
    }
    if (/^\/locations\/[^/]+\/customFields$/.test(path) && req.method === "GET")
      return json(200, { customFields: q.get("model") === "contact" ? [] : fields });
    if (path === "/opportunities/pipelines") return json(200, { pipelines: [] });
    if (path === "/users/") return json(200, { users: [] });
    if (/customValues/.test(path)) return json(200, { customValues: [] });
    json(404, { message: `no fake handler for ${req.method} ${path}` });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;

const G = await import("../lib/ghl.ts");
const at = (m, p) => seen.filter((x) => x.method === m && new RegExp(p).test(x.path));

console.log("\n═══ 1 · 🔴 THE FIELD CREATE — AND THE OLD ENDPOINT IS LIVE AND REFUSING ═══");
// ⚠️ THE CONTROL, FIRST. If the fake did not refuse the old path, everything
// below would pass whether or not the code had moved.
const refusal = await fetch(`${process.env.GHL_API_BASE}/custom-fields/`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ objectKey: "opportunity", name: "x" }),
});
const refusalBody = await refusal.json();
console.log(`  control: POST /custom-fields/ -> ${refusal.status} "${refusalBody.message}"`);
ok("🔴 THE CONTROL — the old endpoint answers 400, as the account does",
   refusal.status === 400 && /does not support objectKey/.test(refusalBody.message), refusalBody);

seen.length = 0;
// ⚠️ CAUGHT, NOT LET THROW. Against the pre-fix code this call raises the live
// 400 and the script would die at the first assertion, saying nothing about the
// other eight — the same failure mode round 135's proof had. A proof must
// report the shape of a regression, not its first symptom.
let made = { id: "", name: "", parentId: "", parentIdHonoured: false };
let createErr = null;
try {
  made = await G.createCustomField({
    name: "Case Manager Followers",
    dataType: "TEXT",
    parentId: "fold_a",
    model: "opportunity",
  });
} catch (e) {
  createErr = e instanceof Error ? e.message : String(e);
  console.log(`  🔴 createCustomField THREW: ${createErr}`);
}
console.log(`  created: ${JSON.stringify(made)}`);
console.log(`  went to: ${seen.filter((x) => x.method === "POST").map((x) => x.path).join(", ")}`);
ok("🔴 it did NOT touch /custom-fields/ — which would have thrown",
   !seen.some((x) => x.path.startsWith("/custom-fields")), seen.map((x) => x.path));
ok("🔴 it posted to the LOCATION endpoint",
   at("POST", "^/locations/[^/]+/customFields$").length === 1,
   seen.filter((x) => x.method === "POST").map((x) => x.path));
ok("⚠️ and it did not throw", createErr === null, createErr);
const sent = at("POST", "^/locations/[^/]+/customFields$")[0]?.body ?? {};
console.log(`  body: ${JSON.stringify(sent)}`);
ok("🔴 with documentType 'field' — the discriminator", sent.documentType === "field", sent);
ok("🔴 and `model`, NOT `objectKey`", sent.model === "opportunity" && !("objectKey" in sent), sent);
ok("⚠️ no `fieldKey` — that belongs to the other API and GHL derives its own",
   !("fieldKey" in sent), sent);
ok("⚠️ parentId is sent", sent.parentId === "fold_a", sent);
ok("the id comes back", !!made.id, made);
ok("⚠️ and parentId is read back and confirmed rather than assumed",
   made.parentId === "fold_a" && made.parentIdHonoured === true, made);

console.log("\n═══ 2 · ⚠️ OMITTING documentType WOULD MAKE A FOLDER, SO IT IS NOT OMITTED ═══");
// The fake 422s a create with no documentType, the way the API does. This is
// the assertion that keeps the key from being quietly dropped later.
const noDoc = await fetch(`${process.env.GHL_API_BASE}/locations/${LOC}/customFields`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "x", dataType: "TEXT", model: "opportunity" }),
});
ok("🔴 a create with no documentType is refused by the fake, as by the API",
   noDoc.status === 422, noDoc.status);

console.log("\n═══ 3 · ⚠️ THE ADJACENT PATHS — WHAT ELSE MIGHT HAVE BEEN DEAD ═══");
seen.length = 0;
const folder = await G.createFieldFolder({ name: "A New Section", model: "opportunity" });
ok("folder create is on the location endpoint",
   at("POST", "^/locations/[^/]+/customFields$").length === 1 &&
   !seen.some((x) => x.path.startsWith("/custom-fields")), seen.map((x) => x.path));
ok("⚠️ and it sends documentType 'folder'",
   at("POST", "^/locations/[^/]+/customFields$")[0].body.documentType === "folder", folder);
ok("its id is read from `customFieldFolder`", folder.id === "new_folder", folder);

seen.length = 0;
const moved = await G.moveFieldToFolder("f_old", "fold_b");
ok("field move is on the location endpoint",
   at("PUT", "^/locations/[^/]+/customFields/").length === 1 &&
   !seen.some((x) => x.path.startsWith("/custom-fields")), seen.map((x) => x.path));
// ⚠️ `storedParent`, NOT `parentId` — read back from the response rather than
// echoed from the request, which is the point of the function. My assertion
// guessed the key and was wrong about the shape, not about the behaviour.
ok("⚠️ and it landed, read back from the response",
   moved.ok === true && moved.storedParent === "fold_b", moved);

seen.length = 0;
const opts = await G.addFieldOption("f_opt", "C");
ok("the option append is on the location endpoint",
   !seen.some((x) => x.path.startsWith("/custom-fields")), seen.map((x) => x.path));
ok("🔴 and it sends the WHOLE array — GHL replaces it",
   opts.join() === "A,B,C", opts);

console.log("\n═══ 4 · 🔴 NOTHING IN THE TREE CALLS THE REFUSED PATH ═══");
const src = readFileSync("lib/ghl.ts", "utf8")
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join("\n");
const stray = [...src.matchAll(/"(\/custom-fields\/[^"]*)"/g)].map((m) => m[1]);
console.log(`  remaining call sites: ${stray.join(", ") || "(none)"}`);
ok("🔴 no /custom-fields/ call site survives", stray.length === 0, stray);
ok("⚠️ and `fieldKeyFromName` is gone with it — the other API's vocabulary",
   !/function fieldKeyFromName/.test(src), "it survives");

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
