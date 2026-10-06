// ---------------------------------------------------------------------------
// ROUND 175 — ONE OWNER PER CASE, ODP WORDING, AND A SAVE YOU CAN SEE.
//
// 🔴 THE FAKE GIVES ONE FAMILY TWO LIVE CASES IN TWO PIPELINES, because that is
// the shape the live failure needed. A fixture with one case per contact cannot
// fail the "never touch the family's other case" assertion — there would be no
// other case to touch. Rule 3.
//
// ⚠️ AND THE CONTACT'S OWNER DIFFERS FROM BOTH CASES' OWNERS. With one owner
// everywhere, "uses the case's owner" and "uses the contact's owner" produce the
// same answer and the round's whole point is untestable. Rule 4: no value does
// two jobs here.
//
// Run: npx tsx scripts/round175-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import crypto from "node:crypto";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const LOC = "loc_test";
// 🔴 `WEBHOOK_SECRET`, NOT `MM_WEBHOOK_SECRET`. lib/webhooks.ts:62 and :151.
// Rule 7 for the FOURTH time this project (GHL_SSO_KEY · MM_WEBHOOK_SECRET ·
// CAREGIVER_ASSOCIATION_ID · and now the same one again): an env var name in a
// harness is a guess until it is read from the code that consumes it. The route
// answered 401 for every section until this was corrected.
const SECRET = "webhook_secret_test";
const P_OLTL = "pipe_oltl";
const P_ODP = "pipe_odp";
const P_DSP = "pipe_odp_dsp";          // an applicant pipeline — managers must NOT apply
const CMF = "F_CASEMGR";               // the field applyCaseManagers records into
const ERN = "u_ern";
const CHRIS = "u_chris";
const DARIUS = "u_darius";             // has no access to the DSP pipeline

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

// ── the account ────────────────────────────────────────────────────────────
// 🔴 THE FAMILY: one contact, two live cases, three different owners in play.
const contacts = {
  c_family: { id: "c_family", firstName: "Hay", lastName: "Ortiz", assignedTo: CHRIS,
              customFields: [] },
  c_dsp: { id: "c_dsp", firstName: "Dee", lastName: "Esspee", assignedTo: DARIUS,
           customFields: [] },
};
let opps = {};
const resetOpps = () => {
  opps = {
    // the family's OLTL case — OLD, owned by Ern. Must never be touched.
    o_oltl: { id: "o_oltl", name: "Hay Ortiz", pipelineId: P_OLTL, pipelineStageId: "s1",
              contactId: "c_family", assignedTo: ERN, status: "open",
              createdAt: iso(40 * 86400000), customFields: [] },
    // the family's new ODP case — created a minute ago, owned by Ern too (the
    // pre-setting sync is what made it Ern's).
    o_odp: { id: "o_odp", name: "Hay Ortiz", pipelineId: P_ODP, pipelineStageId: "s1",
             contactId: "c_family", assignedTo: ERN, status: "open",
             createdAt: iso(60000), customFields: [] },
    // a case with NO owner at all, for the fallback.
    o_none: { id: "o_none", name: "Hay Ortiz", pipelineId: P_ODP, pipelineStageId: "s1",
              contactId: "c_family", assignedTo: "", status: "open",
              createdAt: iso(90000), customFields: [] },
    // an APPLICANT case — owner yes, managers no (round 149).
    o_dsp: { id: "o_dsp", name: "Dee Esspee", pipelineId: P_DSP, pipelineStageId: "s1",
             contactId: "c_dsp", assignedTo: "", status: "open",
             createdAt: iso(45000), customFields: [] },
  };
};
resetOpps();

/** Every PUT the fake applied, so "never touched" is checkable as STATE. */
let puts = [];
/**
 * 🔴 GOHIGHLEVEL ACCEPTS A WRITE IT DOES NOT STORE — round 151 found exactly
 * this on the followers endpoint, and revert C showed my fake had no such case
 * for the OWNER write: it always stored, so the read-back always agreed and
 * deleting the read-back changed nothing. A fake that is tidier than the real
 * thing is green on a live bug (rule 2, in the direction nobody checks).
 */
let ownerWriteSilentlyDrops = false;

const cfg = JSON.stringify({
  seeded: true, folderNames: {},
  pipelines: {
    [P_OLTL]: { scope: "client", folders: [] },
    [P_ODP]: { scope: "client", folders: [] },
    [P_DSP]: { scope: "caregiver", folders: [], group: "caregiver" },
  },
});
const access = JSON.stringify({
  pipelines: {},
  folders: {},
  master: [],
  // Ern and chris b have DIFFERENT managers, which is the whole of the
  // "+3 manager(s) from the wrong rep" failure.
  caseManagers: { [ERN]: ["u_m1", "u_m2", "u_m3"], [CHRIS]: ["u_m9"] },
  referralAccess: {},
});

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const j = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    const send = (code, o) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(o));
    };

    if (path === "/users/")
      return send(200, { users: [
        { id: ERN, name: "Ern Holden" }, { id: CHRIS, name: "chris b" },
        { id: DARIUS, name: "Darius Boyce" },
        { id: "u_m1", name: "M One" }, { id: "u_m2", name: "M Two" },
        { id: "u_m3", name: "M Three" }, { id: "u_m9", name: "M Nine" },
      ] });
    if (path === `/locations/${LOC}/customValues`)
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Folders", value: cfg },
        { id: "cv2", name: "MM Pipeline Access", value: access },
      ] });
    if (path === `/locations/${LOC}/customFields`)
      return send(200, { customFields: /model=contact/.test(req.url)
        ? []
        : [{ id: CMF, name: "Case Manager Followers", dataType: "TEXT" }] });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [
        { id: P_OLTL, name: "OLTL Enrollment", stages: [{ id: "s1", name: "NEW LEAD", position: 0 }] },
        { id: P_ODP, name: "ODP Enrollment", stages: [{ id: "s1", name: "NEW LEAD", position: 0 }] },
        { id: P_DSP, name: "ODP DSP Applicant", stages: [{ id: "s1", name: "NEW", position: 0 }] },
      ] });
    if (path === "/opportunities/search") {
      const cid = url.searchParams.get("contact_id") || "";
      const pid = url.searchParams.get("pipeline_id") || "";
      const rows = Object.values(opps).filter(
        (o) => (!cid || o.contactId === cid) && (!pid || o.pipelineId === pid));
      return send(200, { opportunities: rows, meta: { total: rows.length } });
    }
    const oneOpp = /^\/opportunities\/([^/]+)$/.exec(path);
    if (oneOpp) {
      const o = opps[oneOpp[1]];
      if (!o) return send(404, { message: "Opportunity not found" });
      if (req.method === "PUT") {
        // 🔴 GOHIGHLEVEL'S OWN REFUSAL, WORD FOR WORD (round 151). Darius has no
        // access to the DSP pipeline, and the 400 names ids rather than people —
        // which is what explainGhlError exists to rewrite.
        if (j.assignedTo === DARIUS && o.pipelineId === P_DSP)
          return send(400, {
            message: `Can not make this user ${DARIUS} owner as User does not have permission to access this pipeline ${P_DSP}.`,
          });
        if (j.assignedTo !== undefined && !ownerWriteSilentlyDrops)
          o.assignedTo = j.assignedTo || "";
        for (const f of j.customFields || []) {
          const cur = (o.customFields ||= []).find((x) => x.id === f.id);
          if (cur) cur.field_value = f.field_value ?? f.value;
          else o.customFields.push({ id: f.id, field_value: f.field_value ?? f.value });
        }
        puts.push({ id: o.id, body: j });
        return send(200, { opportunity: o });
      }
      return send(200, { opportunity: o });
    }
    const oneContact = /^\/contacts\/([^/]+)$/.exec(path);
    if (oneContact) {
      const c = contacts[oneContact[1]];
      if (!c) return send(404, { message: "not found" });
      return send(200, { contact: c });
    }
    // 🔴 THE FAKE STORES FOLLOWERS, because applyCaseManagers READS THEM BACK
    // off the opportunity (round 151's mismatch check) and a fake that only
    // echoes them makes every section report "accepted the write and the record
    // disagrees" — which is the harness failing, not the code.
    const fol = /^\/opportunities\/([^/]+)\/followers/.exec(path);
    if (fol) {
      const o = opps[fol[1]];
      if (!o) return send(404, { message: "not found" });
      const want = Array.isArray(j?.followers) ? j.followers : [];
      o.followers ||= [];
      if (req.method === "POST") {
        for (const u of want) if (!o.followers.includes(u)) o.followers.push(u);
        return send(200, { followers: want, followersAdded: [want] });
      }
      // DELETE — the shape round 156's probe recorded.
      o.followers = o.followers.filter((u) => !want.includes(u));
      return send(200, { followers: [], followersRemoved: want });
    }
    return send(200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.GHL_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.GHL_PIT = "pit_test";
process.env.GHL_LOCATION_ID = LOC;
process.env.WEBHOOK_SECRET = SECRET;
delete process.env.PIPELINE_ACCESS_MAP;
delete process.env.WEBHOOK_URL;

const hook = await import("../app/api/webhooks/ghl/route.ts");
const { resolveCase, RECENT_CASE_MS } = await import("../lib/webhookCase.ts");
const RL = await import("../lib/recruitingLabels.ts");
const { withPending } = await import("../lib/referrals.ts");

const fire = async (body, qs = "") => {
  const raw = JSON.stringify(body);
  // ⚠️ `sha256=` PREFIXED — lib/webhooks.ts builds `sha256=${hmac}` and compares
  // the whole string in constant time, so a bare hex digest is a length mismatch
  // and fails before any byte is compared.
  const sig = `sha256=${crypto.createHmac("sha256", SECRET).update(raw).digest("hex")}`;
  const r = await hook.POST(
    new Request(`http://x/api/webhooks/ghl${qs}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mm-secret": SECRET, "x-mm-signature": sig },
      body: raw,
    }),
  );
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const ownerOf = (id) => opps[id].assignedTo;

// ═══════════════════════════════════════════════════════════════════════════
console.log("═══ 1 · 🔴 setOwner=1 — THE ROTATION'S PICK BECOMES THE CASE OWNER ═══");
// ═══════════════════════════════════════════════════════════════════════════
resetOpps(); puts = [];
let r = await fire(
  { contact_id: "c_family", id: "o_odp", pipeline_id: P_ODP, location: { id: LOC } },
  "?setOwner=1",
);
console.log(`  ${r.body.reason}`);
ok("the ODP case becomes chris b's", ownerOf("o_odp") === CHRIS, ownerOf("o_odp"));
ok("🔴 the family's OLTL case is UNTOUCHED", ownerOf("o_oltl") === ERN, ownerOf("o_oltl"));
ok("🔴 …and nothing was PUT to it at all",
  !puts.some((p) => p.id === "o_oltl"), puts.map((p) => p.id));
ok("the reason names the owner and the rotation",
  /owner set to chris b from the rotation/.test(r.body.reason), r.body.reason);
ok("it acted", r.body.acted === true, r.body);
// 🔴 chris b's managers, not Ern's three — the live "+3 manager(s)" bug.
const fv = () => String((opps.o_odp.customFields || [])
  .find((f) => f.id === CMF)?.field_value ?? "");
ok("🔴 chris b's ONE manager is applied, not Ern's three",
  /u_m9/.test(fv()) && !/u_m1/.test(fv()), fv());
// ⚠️ THE FORMAT IS `+1 −0 manager(s)`, NOT `+1 manager`. The owner's example
// reason was illustrative; round 150 put the REMOVAL count there deliberately,
// and dropping it to match a sample sentence would lose a number that matters.
// Asserting the property — it says how many were added — rather than the exact
// phrase, which is round 128's trap.
ok("…and the reason says how many were added", /\+1\b/.test(r.body.reason), r.body.reason);

console.log("\n1c · 🔴 A 200 IS NOT A SUCCESS — READ IT BACK");
// 🔴 ROUND 151'S FINDING, APPLIED TO THE OWNER WRITE. GoHighLevel returns 200
// and stores nothing when the record's pipeline is shared with selected users
// only. Without the read-back the route would report the owner as set, and then
// apply the NEW owner's managers to a case the OLD owner still holds — which is
// worse than doing nothing, because it looks correct.
resetOpps(); puts = [];
ownerWriteSilentlyDrops = true;
r = await fire(
  { contact_id: "c_family", id: "o_odp", pipeline_id: P_ODP, location: { id: LOC } },
  "?setOwner=1",
);
console.log(`  ${r.body.reason}`);
ok("🔴 the route catches the silent drop", /NOT stored/.test(r.body.reason), r.body.reason);
ok("…and names what it asked for and what it got",
  /chris b/.test(r.body.reason) && /Ern Holden/.test(r.body.reason), r.body.reason);
ok("🔴 …and applies NO managers on a case whose owner did not change",
  !String((opps.o_odp.customFields || []).find((f) => f.id === CMF)?.field_value ?? "")
    .includes("u_m9"),
  opps.o_odp.customFields);
ok("…and does not claim to have acted", r.body.acted === false, r.body);
ownerWriteSilentlyDrops = false;

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 2 · 🔴 WITHOUT THE FLAG — THE OWNER NEVER CHANGES ═══");
// ═══════════════════════════════════════════════════════════════════════════
resetOpps(); puts = [];
// The ODP case is owned by chris b; the CONTACT is owned by Ern's… no: the
// contact is chris b and the case is Ern. Flip the case so the two differ the
// other way round, which is the owner's exact sentence.
opps.o_odp.assignedTo = CHRIS;
contacts.c_family.assignedTo = ERN;
r = await fire({ contact_id: "c_family", id: "o_odp", pipeline_id: P_ODP, location: { id: LOC } });
console.log(`  ${r.body.reason}`);
ok("🔴 the case owner is NOT changed", ownerOf("o_odp") === CHRIS, ownerOf("o_odp"));
ok("🔴 …no owner was written at all",
  !puts.some((p) => p.body.assignedTo !== undefined), puts.map((p) => p.body));
ok("🔴 chris b's managers are applied, NOT Ern's",
  /u_m9/.test(fv()) && !/u_m1/.test(fv()), fv());
ok("the reason names the case's own owner",
  /case owner chris b/.test(r.body.reason), r.body.reason);
contacts.c_family.assignedTo = CHRIS;

// 🔴 THE CONTROL. "the owner never changes" is also what a route that does
// nothing at all produces — so §1 above must have changed it, and it did.

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 3 · A CASE WITH NO OWNER FALLS BACK TO THE CONTACT'S ═══");
// ═══════════════════════════════════════════════════════════════════════════
resetOpps(); puts = [];
r = await fire({ contact_id: "c_family", id: "o_none", pipeline_id: P_ODP, location: { id: LOC } });
console.log(`  ${r.body.reason}`);
ok("the fallback is used and named",
  /case had no owner, using the contact's \(chris b\)/.test(r.body.reason), r.body.reason);
ok("🔴 …and the case's owner is STILL not written",
  ownerOf("o_none") === "" && !puts.some((p) => p.body.assignedTo !== undefined),
  { owner: ownerOf("o_none"), puts: puts.map((p) => p.body) });
const fvNone = String((opps.o_none.customFields || [])
  .find((f) => f.id === CMF)?.field_value ?? "");
ok("chris b's manager is applied through the fallback", /u_m9/.test(fvNone), fvNone);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 4 · 🔴 AN `id` THAT IS A CONTACT, NOT A CASE ═══");
// ═══════════════════════════════════════════════════════════════════════════
resetOpps(); puts = [];
// CAREGIVER APPLICATION ROUTING creates the case inside the workflow, so `id`
// can be the contact. The newest ODP case is o_none (90s) vs o_odp (60s) — so
// o_odp must win, and the 40-day-old OLTL case must not be considered at all.
r = await fire(
  { contact_id: "c_family", id: "c_family", pipeline_id: P_ODP, location: { id: LOC } },
  "?setOwner=1",
);
console.log(`  ${r.body.reason}`);
ok("🔴 it resolves to the newest case in that pipeline",
  /o_odp/.test(r.body.reason) && ownerOf("o_odp") === CHRIS, r.body.reason);
ok("…and says it had to look it up",
  /found by newest in pipeline/.test(r.body.reason), r.body.reason);
ok("🔴 the OLTL case is untouched", ownerOf("o_oltl") === ERN, ownerOf("o_oltl"));
ok("…and the other ODP case is untouched too", ownerOf("o_none") === "", ownerOf("o_none"));

console.log("\n4b · 🔴 AND WHEN IT CANNOT BE IDENTIFIED, NOTHING CHANGES");
resetOpps(); puts = [];
r = await fire({ contact_id: "c_family", id: "c_family", location: { id: LOC } }, "?setOwner=1");
console.log(`  ${r.body.reason}`);
ok("no pipeline_id → refuses to guess", /cannot identify the case/.test(r.body.reason), r.body.reason);
ok("🔴 …and wrote nothing", puts.length === 0, puts);
ok("it did not claim to act", r.body.acted === false, r.body);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 5 · 🔴 A REFUSED OWNER WRITE LEAVES THE CASE ALONE ═══");
// ═══════════════════════════════════════════════════════════════════════════
resetOpps(); puts = [];
r = await fire(
  { contact_id: "c_dsp", id: "o_dsp", pipeline_id: P_DSP, location: { id: LOC } },
  "?setOwner=1",
);
console.log(`  ${r.body.reason}`);
ok("the refusal is reported, not swallowed",
  /setOwner refused/.test(r.body.reason), r.body.reason);
ok("🔴 …naming the PERSON and the PIPELINE, not ids",
  /Darius Boyce/.test(r.body.reason) && /ODP DSP Applicant/.test(r.body.reason),
  r.body.reason);
ok("🔴 the case is unchanged", ownerOf("o_dsp") === "", ownerOf("o_dsp"));
ok("…and it did not claim to act", r.body.acted === false, r.body);
// ⚠️ NEVER RETRIED: exactly one PUT was attempted.
ok("🔴 exactly ONE write was attempted — no retry loop",
  puts.length === 0, puts.length);

console.log("\n5b · ⚠️ AN APPLICANT CASE GETS ITS OWNER AND NO MANAGERS (round 149)");
resetOpps(); puts = [];
contacts.c_dsp.assignedTo = CHRIS;   // chris b CAN own a DSP case in this fake
r = await fire(
  { contact_id: "c_dsp", id: "o_dsp", pipeline_id: P_DSP, location: { id: LOC } },
  "?setOwner=1",
);
console.log(`  ${r.body.reason}`);
ok("the applicant case's owner IS set", ownerOf("o_dsp") === CHRIS, ownerOf("o_dsp"));
ok("🔴 …and no case managers are applied",
  !String((opps.o_dsp.customFields || []).find((f) => f.id === CMF)?.field_value ?? "")
    .includes("u_m9"),
  opps.o_dsp.customFields);
ok("…and the reason says why nothing happened for managers",
  /nothing to do for managers/.test(r.body.reason), r.body.reason);
contacts.c_dsp.assignedTo = DARIUS;

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 6 · THE CASE RESOLVER, DIRECTLY ═══");
// ═══════════════════════════════════════════════════════════════════════════
const cases = [
  { id: "a", pipelineId: P_ODP, createdAt: iso(30000) },
  { id: "b", pipelineId: P_ODP, createdAt: iso(120000) },
  { id: "c", pipelineId: P_OLTL, createdAt: iso(10000) },
  { id: "d", pipelineId: P_ODP, createdAt: iso(40 * 86400000) },
];
ok("a confirmed opportunity id wins with no lookup",
  resolveCase("o1", true, P_ODP, cases, NOW).id === "o1",
  resolveCase("o1", true, P_ODP, cases, NOW));
ok("🔴 the newest IN THAT PIPELINE, inside the window",
  resolveCase("c_x", false, P_ODP, cases, NOW).id === "a",
  resolveCase("c_x", false, P_ODP, cases, NOW));
ok("🔴 CONTROL — the other pipeline's newer case is NOT chosen",
  resolveCase("c_x", false, P_ODP, cases, NOW).id !== "c",
  resolveCase("c_x", false, P_ODP, cases, NOW));
ok("🔴 the 40-day-old case is outside the window",
  resolveCase("c_x", false, P_ODP, [cases[3]], NOW).ok === false,
  resolveCase("c_x", false, P_ODP, [cases[3]], NOW));
ok("no pipeline_id → no answer",
  resolveCase("c_x", false, "", cases, NOW).ok === false,
  resolveCase("c_x", false, "", cases, NOW));
ok("⚠️ an undateable case is not 'recent'",
  resolveCase("c_x", false, P_ODP, [{ id: "z", pipelineId: P_ODP }], NOW).ok === false,
  resolveCase("c_x", false, P_ODP, [{ id: "z", pipelineId: P_ODP }], NOW));
ok("the window is ten minutes", RECENT_CASE_MS === 600000, RECENT_CASE_MS);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 7 · ODP CALLS THEM DSPs ═══");
// ═══════════════════════════════════════════════════════════════════════════
ok("🔴 an ODP-only viewer reads DSPs",
  RL.recruitingNouns("caregiver", true).group === "DSPs",
  RL.recruitingNouns("caregiver", true));
ok("🔴 CONTROL — an OLTL viewer reads Caregivers",
  RL.recruitingNouns("caregiver", false).group === "Caregivers",
  RL.recruitingNouns("caregiver", false));
ok("the record noun is 'applicant' either way",
  RL.recruitingNouns("caregiver", true).many === "applicants" &&
  RL.recruitingNouns("caregiver", false).many === "applicants", "applicants");
ok("the menu says DSP applicants for ODP",
  RL.recruitingGroupOptions(true)[0].label === "DSP applicants",
  RL.recruitingGroupOptions(true)[0]);
ok("🔴 CONTROL — and Caregiver applicants otherwise",
  RL.recruitingGroupOptions(false)[0].label === "Caregiver applicants",
  RL.recruitingGroupOptions(false)[0]);
ok("the other two labels are the asked-for ones",
  RL.recruitingGroupOptions(true)[1].label === "Office staff applicants" &&
  RL.recruitingGroupOptions(true)[2].label === "All applicants",
  RL.recruitingGroupOptions(true).map((o) => o.label));
ok("staff wording does not change with ODP",
  RL.recruitingNouns("staff", true).group === RL.recruitingNouns("staff", false).group,
  RL.recruitingNouns("staff", true));

console.log("\n7b · 🔴 ODP-ONLY IS DERIVED FROM THE PIPELINES HELD");
ok("ODP pipelines only → true",
  RL.isOdpOnlyRecruiting(["ODP DSP Applicant", "ODP Staff Applicants"]), true);
ok("🔴 CONTROL — a mixed viewer is NOT ODP-only",
  !RL.isOdpOnlyRecruiting(["ODP DSP Applicant", "OLTL Caregiver Applicants"]), false);
ok("🔴 CONTROL — NO pipelines is not ODP-only either (every() on [] is true)",
  !RL.isOdpOnlyRecruiting([]), false);
ok("OLTL only → false", !RL.isOdpOnlyRecruiting(["OLTL Caregiver Applicants"]), false);

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n═══ 8 · A SAVE IS ON THE LIST BEFORE SEARCH CATCHES UP ═══");
// ═══════════════════════════════════════════════════════════════════════════
const saved = { id: "p_new", org: "Main Line Health" };
// 🔴 THE LIVE SHAPE: the save succeeded and the search returns NOTHING.
let m = withPending([], [saved]);
ok("🔴 the saved partner is listed although search returns none",
  m.rows.length === 1 && m.rows[0].id === "p_new", m.rows);
ok("…and it is still held, because the server has not caught up",
  m.stillPending.length === 1, m.stillPending);
// ⚠️ AND IT GOES FIRST. Somebody who just saved is looking for it.
m = withPending([{ id: "p_old", org: "Aaa" }], [saved]);
ok("🔴 it is first, not sorted into the middle", m.rows[0].id === "p_new", m.rows);
// 🔴 THE CONTROL: dropped the moment the server agrees, not on a timer.
m = withPending([{ id: "p_new", org: "Main Line Health" }], [saved]);
ok("🔴 once search returns it, it is no longer pending",
  m.stillPending.length === 0, m.stillPending);
ok("…and it is not listed twice", m.rows.filter((x) => x.id === "p_new").length === 1, m.rows);
ok("⚠️ a row with no id is never held", withPending([], [{ id: "" }]).stillPending.length === 0,
  withPending([], [{ id: "" }]));

// ═══════════════════════════════════════════════════════════════════════════
server.close();
const total = pass + fail;
console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
console.log(`assertions: ${total}`);
process.exit(fail ? 1 : 0);
