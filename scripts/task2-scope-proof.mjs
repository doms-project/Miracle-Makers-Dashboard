// ---------------------------------------------------------------------------
// TASK 2 · SECTION 1 — THE CLIENT-PIPELINE LEAK, BOTH HALVES.
//
// 🔴 THE CONTROL IS THE WHOLE PROOF, AND THE BRIEF ASKED FOR IT BY NAME:
// "a granted pipeline accepted in the same run as an ungranted one rejected,
// or 'rejects everything' passes."
//
// So every refusal below is paired, IN THE SAME RUN, with the same viewer
// succeeding at the thing they ARE entitled to — and three viewers share one
// process, because the grants are read per request from the custom value and
// the SSO blob is the only thing that changes:
//
//   ADMIN        no grants needed, sees and files anywhere
//   PP REP       granted Private Pay only
//   UNGRANTED    in the map with nothing — the state EVERY non-admin on the
//                live account is in today
//
// ⚠️ THE GRANTS COME THROUGH THE REAL PLUMBING. Nothing here stubs
// getUserHomePipelines: the fake serves the "MM Pipeline Access" custom value,
// withGrants reads it, and AsyncLocalStorage carries it into the route — the
// same path the board uses. A stubbed grant would prove the filter runs, not
// that it is fed.
//
// Run: npx tsx scripts/task2-scope-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { execFileSync } from "node:child_process";
import CryptoJS from "crypto-js";

// 🔴 ONE PROCESS CAN ONLY TEST ONE PIPELINE CONFIG. `getPipelineConfig()` is
// memoised at module level, so the "no client pipeline configured at all" shape
// — the control for the third refusal message — has to be its own process with
// the fake shaped that way from the FIRST request. Same problem, same answer,
// as task1-apply-proof's no-record-field run and round 130's.
//
// ⚠️ THE VIEWERS DO NOT NEED THIS. Grants are read per request from the custom
// value and the SSO blob is the only thing that changes, so three viewers share
// one process quite honestly. It is the CONFIG that is sticky.
const SHAPE = process.env.SHAPE || "normal";
const NOPIPES = SHAPE === "nopipelines";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
const SECRET = "harness_shared_secret";
const RT = "F_RT", CAT = "F_CAT", TIER = "F_TIER", DIV = "F_DIV", REF = "F_REF";

const PP = "pipe_pp", OLTL = "pipe_oltl", ODP = "pipe_odp", EV = "pipe_events";
const U_ADMIN = "u_admin", U_PP = "u_pp", U_NONE = "u_none";

const blob = (userId, role) =>
  CryptoJS.AES.encrypt(JSON.stringify({
    userId, role, type: "location", activeLocation: LOC,
    userName: userId, email: `${userId}@test`, companyId: "co1",
  }), SECRET).toString();
const ADMIN = blob(U_ADMIN, "admin");
const REP_PP = blob(U_PP, "user");
const REP_NONE = blob(U_NONE, "user");

/** Every request the fake saw, so "did it write" is read, not assumed. */
let seen = [];
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const j = raw ? JSON.parse(raw) : null;
    const u = req.url;
    const path = u.split("?")[0];
    seen.push({ method: req.method, path, body: j });
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (path === `/locations/${LOC}/customFields`)
      return send(200, {
        customFields: u.includes("model=opportunity")
          ? [{ id: REF, name: "Referring Partner", dataType: "TEXT" }]
          : [
              { id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS",
                picklistOptions: ["Referral Partner", "Event Attendee"] },
              { id: CAT, name: "Partner Category", dataType: "SINGLE_OPTIONS", picklistOptions: ["Hospital discharge"] },
              { id: TIER, name: "Partner Tier", dataType: "SINGLE_OPTIONS", picklistOptions: ["A", "B", "C", "Prospect"] },
              { id: DIV, name: "Partner Division", dataType: "SINGLE_OPTIONS",
                picklistOptions: ["Private Pay", "OLTL", "ODP", "All"] },
            ],
      });

    if (path === "/users/")
      return send(200, { users: [
        { id: U_ADMIN, name: "An Admin" }, { id: U_PP, name: "A PP Rep" },
        { id: U_NONE, name: "An Ungranted Rep" },
      ] });

    // 🔴 THE THREE NAMES FROM THE BRIEF. The disclosure is that a Private Pay
    // rep could read "OLTL Enrollment" and "ODP Transfer" in a dropdown, so the
    // fake serves exactly those strings and the assertions hunt for them.
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        { id: PP, name: "Private Pay Clients", stages: [{ id: "pp_s1", name: "NEW ENQUIRY", position: 0 }] },
        { id: OLTL, name: "OLTL Enrollment", stages: [{ id: "ol_s1", name: "NEW LEAD", position: 0 }] },
        { id: ODP, name: "ODP Transfer", stages: [{ id: "od_s1", name: "NEW LEAD", position: 0 }] },
        { id: EV, name: "Events", stages: [{ id: "ev_s1", name: "PLANNED", position: 0 }] },
      ] });

    if (path === `/locations/${LOC}/customValues`)
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Folders", value: JSON.stringify({
            seeded: true,
            // 🔴 THE `nopipelines` SHAPE: the Events pipeline is the only one
            // with client scope, and it is excluded from the picker — so
            // `choices` is genuinely empty and the third message is reached by
            // the route rather than asserted about its source.
            pipelines: NOPIPES
              ? { [EV]: { scope: "client", folders: [], role: "events" } }
              : {
                  [PP]: { scope: "client", folders: [] },
                  [OLTL]: { scope: "client", folders: [] },
                  [ODP]: { scope: "client", folders: [] },
                  [EV]: { scope: "client", folders: [], role: "events" },
                },
            folderNames: {},
          }) },
        // 🔴 THE REAL GRANT SOURCE. `u_none` is PRESENT WITH AN EMPTY LIST on
        // purpose — "in the map, granted nothing" is a different state from
        // "not in the map", and buildGrants drops an entry with no pipelines,
        // so both arrive at getUserHomePipelines as an EMPTY SET. That is the
        // state every non-admin on the live account is in today.
        { id: "cv2", name: "MM Pipeline Access", value: JSON.stringify({
            pipelines: { [U_PP]: [PP] }, folders: {}, master: [], caseManagers: {},
          }) },
      ] });

    if (path === "/contacts/search")
      return send(200, { contacts: [{
        id: "p1", contactName: "Riddle Hospital", email: "dp@riddle.test",
        customFields: [
          { id: RT, value: j?.filters?.[0]?.value || "Referral Partner" },
          { id: TIER, value: "A" }, { id: DIV, value: "OLTL" },
        ],
      }], total: 1 });

    // ⚠️ KEYED ON `pipeline_id`, LIKE THE REAL ONE. Answering every pipeline
    // with the same record returned the one opportunity three times and made
    // the payload counts nonsense — round 100's harness note, met again.
    if (path === "/opportunities/search") {
      const pid = new URL(`http://x${u}`).searchParams.get("pipeline_id");
      if (pid !== OLTL) return send(200, { opportunities: [], meta: { total: 0 } });
      return send(200, { opportunities: [{
        id: "o1", name: "Smith family", pipelineId: OLTL, pipelineStageId: "ol_s1",
        status: "won", monetaryValue: 6000, createdAt: iso(10),
        assignedTo: U_PP, followers: [],
        customFields: [{ id: REF, fieldValue: "p1" }],
      }], meta: { total: 1 } });
    }

    if (path === "/contacts/upsert" || path === "/contacts/")
      return send(200, { contact: { id: "c_new" } });
    if (path === "/opportunities/" && req.method === "POST")
      return send(200, { opportunity: { id: "o_new", pipelineId: j?.pipelineId } });
    if (/^\/contacts\/[^/]+\/notes$/.test(path)) return send(200, { note: { id: "n1" } });
    if (/^\/contacts\/[^/]+$/.test(path)) return send(200, { contact: { id: "c_new" } });

    send(404, { message: `no fake handler for ${req.method} ${path}` });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
// ⚠️ `GHL_SSO_SECRET`, NOT `GHL_SSO_KEY`. The header is the key; this is the
// secret. With the wrong name `ssoConfigured()` is false, `session` is null,
// and `isAdmin` is TRUE for every viewer — so the first run of this harness
// showed all three pipelines to all three viewers and read like the filter had
// never been written. A harness that does not reproduce the production shape
// proves nothing; this one nearly disproved a working fix.
process.env.GHL_SSO_SECRET = SECRET;
process.env.PIPELINE_IDS = `${PP},${OLTL},${ODP}`;

const route = await import("../app/api/referrals/route.ts");

const get = async (sso) => {
  seen = [];
  const res = await route.GET(
    new Request("http://x/api/referrals", { headers: { "x-ghl-sso-key": sso } }),
  );
  return { status: res.status, body: await res.json() };
};
// ⚠️ THE POST TAKES THE BLOB IN THE BODY (`ssoKey`), NOT THE HEADER — the GET
// reads `x-ghl-sso-key` and the two halves of one route disagree. Sending the
// header alone got a 401 and the write assertions all went red against a
// working fix; three of them "passed" on that 401, which is the reason a status
// assertion sits beside each one.
const post = async (sso, body) => {
  seen = [];
  const res = await route.POST(
    new Request("http://x/api/referrals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, ssoKey: sso }),
    }),
  );
  return { status: res.status, body: await res.json() };
};
/** 🔴 DID IT WRITE? Read from the fake, never inferred from the status code. */
const wrote = () =>
  seen.filter((s) => s.method === "POST" && /^\/(contacts|opportunities)\//.test(s.path));
const names = (r) => (r.body.clientPipelines || []).map((p) => p.name).sort();

// ── THE CHILD SHAPE, FIRST, BECAUSE IT RETURNS EARLY ──────────────────────
if (NOPIPES) {
  console.log("\n2f · 🔴 NO CLIENT PIPELINE CONFIGURED AT ALL  (child process)");
  // 🔴 THE CONTROL FOR THE WHOLE MESSAGE SET. Without it, "it never says
  // configure a pipeline" passes against a route that deleted that branch —
  // and an account genuinely missing a client pipeline would then be told to
  // go and ask an admin for a grant that cannot exist.
  const rr = await post(ADMIN, {
    action: "log-referral", partnerId: "p1", firstName: "New", lastName: "Enquiry",
  });
  console.log(`  -> ${rr.status} "${rr.body.error}"`);
  ok("🔴 409, not 403 — nothing exists, so nothing is being withheld",
     rr.status === 409, rr);
  ok("🔴 AND THE CONFIGURE MESSAGE IS STILL REACHABLE — it is right here and nowhere else",
     /client scope in Admin → Pipelines/.test(rr.body.detail || ""), rr.body);
  ok("⚠️ and it does NOT blame a missing grant", !/grant/.test(JSON.stringify(rr.body)), rr.body);
  console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed  (no-pipelines shape)`);
  server.close();
  process.exit(fail ? 1 : 0);
}

console.log("\n═══ 1 · THE GET — THREE VIEWERS, ONE RUN ═══");

console.log("\n1a · 🔴 THE CONTROL — AN ADMIN STILL SEES EVERYTHING");
// Without this, every assertion below is satisfied by a route that returns an
// empty list to everybody.
const a = await get(ADMIN);
console.log(`  admin -> ${JSON.stringify(names(a))}`);
ok("🔴 THE CONTROL — the admin gets all three client pipelines",
   names(a).join("|") === "ODP Transfer|OLTL Enrollment|Private Pay Clients", names(a));
ok("⚠️ and Events is still excluded — an event is not a client",
   !names(a).includes("Events"), names(a));
ok("⚠️ nothing is withheld from an admin",
   a.body.meta.clientPipelinesWithheld === 0, a.body.meta.clientPipelinesWithheld);

console.log("\n1b · 🔴 A PRIVATE PAY REP GETS ONE, AND THE OTHER TWO ARE NOT NAMED");
const p = await get(REP_PP);
console.log(`  pp rep -> ${JSON.stringify(names(p))}  withheld=${p.body.meta.clientPipelinesWithheld}`);
ok("🔴 exactly the one they hold", names(p).join("|") === "Private Pay Clients", names(p));
// ⚠️ THE ASSERTION THAT MATTERS IS ABSENCE FROM THE WHOLE PAYLOAD, not from the
// picker array. A name that leaked through `meta`, a label or an error string
// would be just as readable to whoever opens the network tab.
const ppBody = JSON.stringify(p.body);
ok("🔴 THE DISCLOSURE IS CLOSED — \"OLTL Enrollment\" appears NOWHERE in the payload",
   !ppBody.includes("OLTL Enrollment"), ppBody.slice(0, 200));
ok("🔴 nor does \"ODP Transfer\"", !ppBody.includes("ODP Transfer"), "it leaked");
ok("⚠️ and the COUNT is sent, so an empty picker can say which kind of empty it is",
   p.body.meta.clientPipelinesWithheld === 2, p.body.meta.clientPipelinesWithheld);

console.log("\n1c · 🔴 AN UNGRANTED REP GETS NOTHING — AND THE ACCOUNT SAYS SO");
const n = await get(REP_NONE);
console.log(`  ungranted -> ${JSON.stringify(names(n))}  withheld=${n.body.meta.clientPipelinesWithheld}`);
ok("🔴 the picker is empty — which is CORRECT on a configured account",
   names(n).length === 0, names(n));
ok("🔴 and withheld is 3, so the screen can say \"a filter\" rather than \"an absence\"",
   n.body.meta.clientPipelinesWithheld === 3, n.body.meta.clientPipelinesWithheld);
ok("⚠️ no pipeline name reaches them at all",
   !JSON.stringify(n.body).includes("OLTL Enrollment"), "it leaked");
// ⚠️ THE AGGREGATES ARE UNTOUCHED. Section 1 is the PICKER; the case list is
// section 2 and is deliberately still whole here.
//
// 🔴 THIS ASSERTION USED TO READ `partners.length === 1` AND SECTION 4 MADE IT
// FALSE — correctly. The fixture's one partner is in OLTL and this viewer holds
// nothing, so §4 withholds them. A proof outliving its belief for the third
// time this task, caught by the regression set rather than by a reader.
//
// What it was really claiming is that section 1 did not break the REST of the
// payload, so that is what it now says — and it picks up §4's own rule beside
// it: a withheld partner is counted, never silently absent.
ok("⚠️ the case list still loads whole — that is section 2's, not section 1's",
   (n.body.referrals || []).length === 1, (n.body.referrals || []).length);
ok("🔴 and §4 withholds the OLTL partner from a viewer holding nothing — and COUNTS it",
   (n.body.partners || []).length === 0 && n.body.meta.partnersWithheld === 1,
   { partners: (n.body.partners || []).length, withheld: n.body.meta.partnersWithheld });

console.log("\n═══ 2 · 🔴 THE WRITE — THE CONTROL AND THE REFUSAL IN THE SAME RUN ═══");
const enquiry = (pipelineId, division) => ({
  action: "log-referral", partnerId: "p1", firstName: "New", lastName: "Enquiry",
  ...(pipelineId ? { pipelineId } : {}), ...(division ? { division } : {}),
});

console.log("\n2a · 🔴 THE CONTROL — THE PP REP FILES INTO THE PIPELINE THEY HOLD");
// The refusal below means nothing without this: "rejects everything" would pass.
let r = await post(REP_PP, enquiry(PP));
const created = wrote().find((s) => s.path === "/opportunities/");
console.log(`  -> ${r.status} · wrote ${wrote().length} record(s) · pipeline ${created?.body?.pipelineId}`);
ok("🔴 THE CONTROL — it is accepted", r.status === 200, r);
ok("🔴 and a case really was created, in Private Pay",
   created?.body?.pipelineId === PP, created?.body);

console.log("\n2b · 🔴 THE SAME REP NAMING OLTL IS REFUSED, AND NOTHING IS CREATED");
r = await post(REP_PP, enquiry(OLTL));
console.log(`  -> ${r.status} "${r.body.error}"`);
ok("🔴 403 — not a silent fallback into somewhere else", r.status === 403, r);
ok("🔴 AND NOT ONE WRITE WAS SENT. A refusal that half-creates a contact is worse than the leak.",
   wrote().length === 0, wrote().map((s) => s.path));
// ⚠️ IT NAMES THE PIPELINE THE CALLER ALREADY NAMED, and only that one. A 403
// that listed the alternatives would hand back the disclosure section 1 closes.
ok("⚠️ it names the pipeline they asked for", /OLTL Enrollment/.test(r.body.error), r.body.error);
ok("🔴 and does NOT list the others — the refusal must not re-leak the list",
   !/ODP Transfer/.test(JSON.stringify(r.body)), r.body);
ok("⚠️ and it says what to do about it", /Admin → Access/.test(r.body.detail || ""), r.body.detail);

console.log("\n2c · 🔴 NO PIPELINE NAMED, AN UNGRANTED DIVISION ASKED FOR");
// The quiet half of the same bug: the `||` fallback chain used to read the
// WHOLE list, so a rep who named nothing could be DEFAULTED into a pipeline
// they hold no grant for — the same unreachable record, reached by omission.
r = await post(REP_PP, enquiry("", "OLTL"));
const c2 = wrote().find((s) => s.path === "/opportunities/");
console.log(`  -> ${r.status} · landed in ${c2?.body?.pipelineId}`);
ok("🔴 it does NOT default into OLTL", c2?.body?.pipelineId !== OLTL, c2?.body);
ok("⚠️ it falls back to a pipeline they DO hold", c2?.body?.pipelineId === PP, c2?.body);

console.log("\n2d · 🔴 THE UNGRANTED REP — AND THERE ARE TWO WAYS THEY ARRIVE");
// ⚠️ MY FIRST VERSION CONFLATED THESE AND WENT RED AGAINST WORKING CODE. Naming
// a pipeline and naming none are different requests and they take different
// branches; only the second is what the screen can actually produce, because an
// empty picker has no id to send.
r = await post(REP_NONE, enquiry(PP));
console.log(`  (i)  named a pipeline -> ${r.status} "${r.body.error}"`);
ok("🔴 refused, and it names the one they asked for",
   r.status === 403 && /Private Pay Clients/.test(r.body.error), r);
ok("🔴 nothing created", wrote().length === 0, wrote().map((s) => s.path));
// 🔴 AND IT DOES NOT OFFER ADVICE THEY CANNOT TAKE. "…or file it in one of your
// own" is a sentence for somebody who has one. This assertion is here because
// the proof caught exactly that and the message was shortened.
ok("⚠️ it does NOT tell a viewer with no pipelines to use one of their own",
   !/one of your own/.test(r.body.detail || ""), r.body.detail);

r = await post(REP_NONE, enquiry(""));
console.log(`  (ii) named none      -> ${r.status} "${r.body.error}"`);
ok("🔴 refused — the state an empty picker actually produces", r.status === 403, r);
ok("🔴 nothing created", wrote().length === 0, wrote().map((s) => s.path));
// 🔴 THE OLD MESSAGE WOULD HAVE SENT THEM TO CONFIGURE SOMETHING ALREADY
// CONFIGURED. Three client pipelines exist; they hold none. "Give a pipeline
// client scope in Admin → Pipelines" is false in every word.
ok("🔴 it does NOT tell them to configure a pipeline that already exists",
   !/client scope in Admin → Pipelines/.test(JSON.stringify(r.body)), r.body);
ok("⚠️ it says the pipelines exist and the grant does not",
   /hold no grant/.test(r.body.detail || ""), r.body.detail);

console.log("\n2e · 🔴 THE ADMIN BYPASS IS UNTOUCHED");
// isAdminSession is role === "admin" only, and this proves the write half did
// not narrow it while narrowing everyone else.
r = await post(ADMIN, enquiry(OLTL));
const c3 = wrote().find((s) => s.path === "/opportunities/");
console.log(`  -> ${r.status} · landed in ${c3?.body?.pipelineId}`);
ok("🔴 an admin still files into OLTL", r.status === 200 && c3?.body?.pipelineId === OLTL,
   { status: r.status, body: c3?.body });

console.log("\n═══ 3 · ⚠️ THE SENTENCE — WHICH EMPTY STATE IS ON SCREEN ═══");
// The route half is proven above; this is the branch it feeds. Driven in a
// browser by scripts/task2-message-proof.mjs — here we assert only that the two
// states are DISTINGUISHABLE in the payload, which is the thing the route owes
// the screen.
ok("🔴 empty + withheld>0 (a filter) and empty + withheld=0 (an absence) differ",
   names(n).length === 0 && n.body.meta.clientPipelinesWithheld === 3, n.body.meta);

// ── THE CHILD, for the config shape this process cannot reach ─────────────
console.log("\n═══ 2f · IN A CHILD PROCESS, BECAUSE THE CONFIG IS MEMOISED ═══");
let childOut = "", childOk = true;
try {
  childOut = execFileSync("npx", ["tsx", "scripts/task2-scope-proof.mjs"], {
    env: { ...process.env, SHAPE: "nopipelines" }, encoding: "utf8",
  });
} catch (e) {
  childOut = String(e.stdout || "") + String(e.stderr || "");
  childOk = false;
}
for (const line of childOut.split("\n"))
  if (/^\s{2}(ok|FAIL)|no-pipelines shape|^2f ·/.test(line)) console.log(`  ${line.trim()}`);
ok("🔴 the no-client-pipeline shape passes in its own process", childOk, childOut.slice(-500));

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed  (+ the child's)`);
server.close();
process.exit(fail ? 1 : 0);
