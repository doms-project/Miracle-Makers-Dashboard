// ---------------------------------------------------------------------------
// ROUND 100 — /api/referrals AGAINST A FAKE GoHighLevel, IN THE REAL RUNTIME.
//
// ⚠️ A HARNESS THAT DOESN'T REPRODUCE THE PRODUCTION SHAPE PROVES NOTHING — so
// this is not a mocked module. It is `next dev`, serving the real route, whose
// lib/ghl.ts makes real HTTPS-shaped requests to a local server standing in for
// GoHighLevel. The request bodies it receives are printed, so what the route
// SENDS is evidence rather than assertion.
//
// Three runs:
//   1. a working account     — partners, referrals, events, touches
//   2. the filter REFUSED    — 422 from /contacts/search
//   3. the filter IGNORED    — 200 carrying contacts that do not match
//
// Run: node scripts/referral-route-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn } from "node:child_process";

const LOC = "loc_test";
const RT = "F_RECORD_TYPE";
const CAT = "F_CAT";
const TIER = "F_TIER";
const DIV = "F_DIV";
const REF = "F_REFERRING";
const EVDATE = "F_EVDATE";
const EVCOST = "F_EVCOST";

let MODE = "good";
let FAIL_OPP = false;
const sent = [];

const now = Date.now();
const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : null;
    sent.push({ method: req.method, url: req.url.split("?")[0], body: j });
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const u = req.url;

    // ── custom field definitions (read API) ───────────────────────────────
    if (u.startsWith(`/locations/${LOC}/customFields`)) {
      const opp = u.includes("model=opportunity");
      return send(200, {
        customFields: opp
          ? [
              { id: REF, name: "Referring Partner", dataType: "TEXT" },
              { id: EVDATE, name: "Event Date", dataType: "DATE" },
              { id: EVCOST, name: "Event Cost", dataType: "MONETORY" },
              { id: "F_EVHOST", name: "Event Host", dataType: "TEXT" },
            ]
          : [
              { id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS", picklistOptions: ["Referral Partner", "Event Attendee", "Client"] },
              { id: CAT, name: "Partner Category", dataType: "SINGLE_OPTIONS", picklistOptions: ["Hospital discharge"] },
              { id: TIER, name: "Partner Tier", dataType: "SINGLE_OPTIONS", picklistOptions: ["A", "B", "C", "Prospect"] },
              { id: DIV, name: "Partner Division", dataType: "SINGLE_OPTIONS", picklistOptions: ["Private Pay", "OLTL", "ODP", "All"] },
              { id: "F_PROF", name: "Attendee Profile", dataType: "TEXT" },
              { id: "F_OUT", name: "Event Outcome", dataType: "SINGLE_OPTIONS", picklistOptions: ["Legit lead", "Warm interest", "Referral partner prospect", "Not qualified", "Noise"] },
              { id: "F_EVATT", name: "Event Attended", dataType: "TEXT" },
            ],
      });
    }

    // ── users ─────────────────────────────────────────────────────────────
    if (u.startsWith("/users/"))
      return send(200, { users: [{ id: "u1", name: "Chris", email: "c@test" }] });

    // ── pipelines ─────────────────────────────────────────────────────────
    if (u.startsWith("/opportunities/pipelines"))
      return send(200, {
        pipelines: [
          { id: "pipe_oltl", name: "OLTL Enrollment", stages: [{ id: "s1", name: "INITIAL CALL" }] },
          { id: "pipe_events", name: "Events", stages: [{ id: "s9", name: "PLANNED" }] },
        ],
      });

    // ── location custom values (the stored pipeline config) ───────────────
    if (u.startsWith(`/locations/${LOC}/customValues`))
      return send(200, {
        customValues: [
          {
            id: "cv1",
            name: "MM Pipeline Folders",
            value: JSON.stringify({
              seeded: true,
              pipelines: {
                pipe_oltl: { scope: "client", folders: [] },
                pipe_events: { scope: "client", folders: [] },
              },
              folderNames: {},
            }),
          },
        ],
      });

    // ── contacts/search — THE UNVERIFIED CALL ─────────────────────────────
    if (u === "/contacts/search") {
      if (MODE === "reject")
        return send(422, { message: "filters[0].field is not supported", traceId: "tr-1" });
      const want = j?.filters?.[0]?.value;
      if (MODE === "ignored")
        return send(200, { contacts: [{ id: "cX", contactName: "A Client", customFields: [{ id: RT, value: "Client" }] }], total: 1 });
      const rows =
        want === "Referral Partner"
          ? [
              {
                id: "p1",
                contactName: "Riddle Hospital",
                email: "dp@riddle.test",
                phone: "+14845550142",
                assignedTo: "u1",
                customFields: [
                  { id: RT, value: "Referral Partner" },
                  { id: CAT, value: "Hospital discharge" },
                  { id: TIER, value: "A" },
                  { id: DIV, value: "OLTL" },
                ],
              },
              {
                id: "p2",
                contactName: "Main Line Chamber",
                customFields: [
                  { id: RT, value: "Referral Partner" },
                  { id: TIER, value: "Prospect" },
                  { id: DIV, value: "All" },
                ],
              },
            ]
          : [
              {
                id: "a1",
                contactName: "Jane Attendee",
                customFields: [{ id: RT, value: "Event Attendee" }],
              },
            ];
      return send(200, { contacts: rows, total: rows.length });
    }

    // ── opportunities ─────────────────────────────────────────────────────
    if (u.startsWith("/opportunities/search")) {
      // ⚠️ `pipeline_id`, NOT `pipelineId` (lib/ghl.ts:911). The first run of
      // this harness read the camelCase spelling, got null for every pipeline
      // and served the SAME three opportunities twice — which looked exactly
      // like a duplication bug in the route. The harness was wrong, and a
      // harness that does not reproduce the production shape proves nothing.
      const pid = new URL(`http://x${u}`).searchParams.get("pipeline_id");
      if (pid === "pipe_events")
        return send(200, {
          opportunities: [
            {
              id: "ev1",
              name: "Delco Senior Expo",
              pipelineId: "pipe_events",
              pipelineStageId: "s9",
              status: "open",
              createdAt: iso(12),
              customFields: [
                { id: EVDATE, fieldValue: "2026-05-04" },
                { id: EVCOST, fieldValue: 1800 },
                { id: "F_EVHOST", fieldValue: "p1" },
              ],
            },
          ],
          meta: { total: 1 },
        });
      return send(200, {
        opportunities: [
          {
            id: "o1",
            name: "Smith family",
            pipelineId: "pipe_oltl",
            pipelineStageId: "s1",
            status: "won",
            monetaryValue: 6000,
            createdAt: iso(20),
            customFields: [{ id: REF, fieldValue: "p1" }],
          },
          {
            // 🔴 NO createdAt — the UNDATED referral. It must be counted in
            // lifetime and excluded from every 90-day figure, and SAID.
            id: "o2",
            name: "Doe family",
            pipelineId: "pipe_oltl",
            pipelineStageId: "s1",
            status: "open",
            customFields: [{ id: REF, fieldValue: "p1" }],
          },
          {
            // Points at a partner that does not exist — the dangling case.
            id: "o3",
            name: "Ghost",
            pipelineId: "pipe_oltl",
            pipelineStageId: "s1",
            status: "won",
            monetaryValue: 1000,
            createdAt: iso(5),
            customFields: [{ id: REF, fieldValue: "deleted_partner" }],
          },
        ],
        meta: { total: 3 },
      });
    }

    // ── the write paths ──────────────────────────────────────────────────
    if (u === "/contacts/upsert")
      return send(200, { contact: { id: "newc1" }, new: true });
    if (u === "/opportunities/" || u === "/opportunities") {
      if (FAIL_OPP) return send(422, { message: "pipeline is archived" });
      return send(200, { opportunity: { id: "newo1" } });
    }

    // ── notes: p1 was touched 40 days ago; p2 has NEVER been touched ──────
    if (/^\/contacts\/[^/]+\/notes/.test(u)) {
      if (req.method === "POST")
        return send(200, { note: { id: "nn1", dateAdded: new Date().toISOString() } });
      const id = u.split("/")[2];
      return send(200, {
        notes: id === "p1" ? [{ id: "n1", body: "Called", userId: "u1", dateAdded: iso(40) }] : [],
      });
    }

    send(404, { message: `no fake handler for ${u}` });
  });
});

await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fakePort = fake.address().port;
console.log(`fake GoHighLevel on :${fakePort}`);

const PORT = 3488;
const dev = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  env: {
    ...process.env,
    GHL_API_BASE: `http://127.0.0.1:${fakePort}`,
    GHL_LOCATION_ID: LOC,
    GHL_PIT: "pit_test",
    PIPELINE_IDS: "pipe_oltl,pipe_events",
    NODE_ENV: "development",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
dev.stdout.on("data", () => {});
dev.stderr.on("data", (d) => {
  const s = String(d);
  if (/Error|error/.test(s) && !/Warning/.test(s)) process.stdout.write(`[dev] ${s}`);
});

const wait = async () => {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/referrals?only=touch`, {
        signal: AbortSignal.timeout(4000),
      });
      if (r.status) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};
if (!(await wait())) {
  console.log("dev server never came up");
  dev.kill();
  fake.close();
  process.exit(1);
}

const call = async (qs) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/referrals${qs}`, {
    signal: AbortSignal.timeout(50000),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

console.log("\n─── 1 · A WORKING ACCOUNT ─────────────────────────────────────");
sent.length = 0;
const good = await call("?touch=auto");
console.log(`HTTP ${good.status}`);
if (good.body.partners) {
  for (const p of good.body.partners)
    console.log(
      `  ${p.org.padEnd(20)} tier=${String(p.tier).padEnd(9)} div=${String(p.division).padEnd(11)} lastTouch=${p.lastTouch === 9007199254740991 ? "NEVER" : p.lastTouch}`,
    );
  console.log(`  referrals: ${JSON.stringify(good.body.referrals)}`);
  console.log(`  events:    ${good.body.events.map((e) => `${e.name} @ ${e.date} $${e.cost} stage=${e.stage}`).join(", ") || "(none)"}`);
  console.log(`  attendees: ${good.body.attendees.map((a) => a.name).join(", ") || "(none)"}`);
  console.log(`  meta:      ${JSON.stringify(good.body.meta)}`);
} else {
  console.log(JSON.stringify(good.body).slice(0, 500));
}
const search = sent.find((s) => s.url === "/contacts/search");
console.log(`\n  THE REQUEST IT ACTUALLY SENT to /contacts/search:\n  ${JSON.stringify(search?.body)}`);
console.log(`  notes read: ${sent.filter((s) => /\/notes$/.test(s.url)).length} (one per partner, as reported)`);

console.log("\n─── 2 · GoHighLevel REFUSES THE FILTER ────────────────────────");
MODE = "reject";
const bad = await call("?touch=auto");
console.log(`HTTP ${bad.status}`);
console.log(`  error:  ${bad.body.error}`);
console.log(`  detail: ${String(bad.body.detail).slice(0, 300)}`);

console.log("\n─── 3 · GoHighLevel IGNORES THE FILTER (a 200 of wrong rows) ──");
MODE = "ignored";
const ign = await call("?touch=auto");
console.log(`HTTP ${ign.status}`);
console.log(`  error:  ${ign.body.error}`);
console.log(`  detail: ${String(ign.body.detail).slice(0, 300)}`);
console.log(`  partners returned: ${ign.body.partners ? ign.body.partners.length : "none — it refused rather than showing a wrong list"}`);

console.log("\n─── 4 · LOG A REFERRAL — TWO WRITES, ATTRIBUTION ON THE CREATE ───");
MODE = "good";
sent.length = 0;
const post = async (body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/referrals`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(50000),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ref = await post({
  action: "log-referral",
  partnerId: "p1",
  firstName: "Ada",
  lastName: "Smith",
  phone: "4845550142",
  monthlyValue: 6000,
  division: "OLTL",
  text: "Discharge planner called.",
});
console.log(`HTTP ${ref.status} · ${JSON.stringify(ref.body)}`);
const oppPost = sent.filter((x) => x.url === "/opportunities/" || x.url === "/opportunities");
const upserts = sent.filter((x) => x.url === "/contacts/upsert");
console.log(`  writes: ${upserts.length} contact upsert · ${oppPost.length} opportunity create`);
console.log(`  the opportunity body actually sent:\n  ${JSON.stringify(oppPost[0]?.body)}`);
const ob = oppPost[0]?.body || {};
console.log(
  `  ${ob.monetaryValue === 6000 ? "ok  " : "FAIL"} monetaryValue reached GoHighLevel (the spread bug)`,
);
console.log(
  `  ${(ob.customFields || []).some((f) => f.value === "p1") ? "ok  " : "FAIL"} Referring Partner is in the SAME request`,
);
console.log(
  `  ${oppPost.length === 1 && upserts.length === 1 ? "ok  " : "FAIL"} exactly two writes, not three`,
);

console.log("\n─── 5 · THE SECOND WRITE FAILS — SAY WHAT SURVIVED ───────────");
FAIL_OPP = true;
const bad2 = await post({
  action: "log-referral",
  partnerId: "p1",
  firstName: "Bob",
  monthlyValue: 3000,
  division: "OLTL", // so a destination RESOLVES and write 2 is the one that fails
});
console.log(`HTTP ${bad2.status}`);
console.log(`  error:    ${bad2.body.error}`);
console.log(`  survived: ${bad2.body.survived}`);
console.log(`  detail:   ${String(bad2.body.detail).slice(0, 220)}`);
FAIL_OPP = false;

console.log("\n─── 5b · NO PIPELINE MATCHES — AND THE OLD MESSAGE WAS FALSE ──");
const nomatch = await post({
  action: "log-referral",
  partnerId: "p1",
  firstName: "Cara",
  division: "Private Pay", // the fake account has only an OLTL pipeline
});
console.log(`HTTP ${nomatch.status}`);
console.log(`  error:  ${nomatch.body.error}`);
console.log(`  detail: ${String(nomatch.body.detail).slice(0, 200)}`);

console.log("\n─── 6 · ADD PERSON MET — NAMELESS IS REFUSED ─────────────────");
const nameless = await post({ action: "add-attendee", eventId: "ev1", profile: "Adult daughter" });
console.log(`HTTP ${nameless.status} · ${nameless.body.error}`);
console.log(`  detail: ${String(nameless.body.detail).slice(0, 180)}`);
const named = await post({
  action: "add-attendee",
  eventId: "ev1",
  firstName: "Dana",
  profile: "Adult daughter, mother in Springfield",
  outcome: "Legit lead",
});
console.log(`  with a first name → HTTP ${named.status} · ${JSON.stringify(named.body)}`);

console.log("\n─── 7 · THE EVENT HOST JOIN ──────────────────────────────────");
const ev = await call("?touch=auto");
const e0 = (ev.body.events || [])[0] || {};
console.log(`  event "${e0.name}" host=${JSON.stringify(e0.host)} (expects "p1")`);
console.log(`  meta.eventHostField=${JSON.stringify(ev.body.meta?.eventHostField)}`);
console.log(`  categoryOptions from the live field: ${JSON.stringify(ev.body.categoryOptions)}`);
console.log(`  clientPipelines offered: ${JSON.stringify((ev.body.clientPipelines || []).map((p) => p.name))}`);

console.log("\n─── 8 · WHOLE TOTALS, FILTERED DRILL-DOWN (tagging wired) ────");
MODE = "good";
const vis = await call("?touch=auto");
const rr = vis.body.referrals || [];
console.log(`  viewer: ${JSON.stringify(vis.body.viewer)}`);
console.log(`  referrals: ${rr.map((o) => `${o.id}:${o.visible}`).join(" · ")}`);
console.log(
  `  ${rr.length && rr.every((o) => typeof o.visible === "boolean") ? "ok  " : "FAIL"} every referral carries a visible flag`,
);
// ⚠️ NO SSO SECRET IN THIS ENVIRONMENT, so ssoConfigured() is false, there is no
// viewer to scope to, and the documented posture is "everything visible". That
// is what this asserts. The NON-ADMIN filtered branch is applyAccess itself —
// existing, unchanged code, quoted in analysis 105 — and it cannot be exercised
// here without a real encrypted SSO blob.
console.log(
  `  ${vis.body.viewer?.isAdmin === true ? "ok  " : "FAIL"} no SSO configured → isAdmin, nothing withheld (documented posture)`,
);
console.log(
  `  ${rr.every((o) => o.visible === true) ? "ok  " : "FAIL"} so every referral is visible`,
);
const p1 = (vis.body.partners || []).find((x) => x.id === "p1");
console.log(
  `  ${p1 && p1.ownerId === "u1" ? "ok  " : "FAIL"} partner carries ownerId for the Mine/All filter (got ${JSON.stringify(p1?.ownerId)})`,
);

dev.kill("SIGTERM");
fake.close();
setTimeout(() => process.exit(0), 500);
