// ---------------------------------------------------------------------------
// ROUND 158 — THE BACKFILL DRIVER.
//
// 🔴 THIS IS THE ONE SCRIPT IN THE TREE THAT WRITES TO SIX HUNDRED LIVE
// RECORDS. Everything else either reads, or writes one record a person is
// looking at. So the things under test are not the mapping — `task1-apply`
// owns that — but the DRIVER's promises:
//
//   a dry run writes NOTHING            not "almost nothing"
//   skipped and failed never merge      a skip is correct, a failure is not
//   a departed owner is its own bucket  and is never acted on
//   it resumes                          settled records are not redone
//   it retries what is unsettled        `unconfirmed` and `failed` are
//   it is idempotent                    a second pass adds no followers
//
// ⚠️ DRIVEN AS A CHILD PROCESS, deliberately — the thing that will be run at
// the terminal is the thing that is tested, argument parsing and all. Asserting
// against an imported function would prove a function nobody runs.
//
// Run: node scripts/backfill-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { execFile } from "node:child_process";
import { rmSync, readFileSync, existsSync } from "node:fs";

const LOC = "loc_test";
const STATE = "/tmp/mm-backfill-proof.jsonl";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const ERN = "u_ern", UNMAPPED = "u_nobody", GONE = "u_departed";
const CARLA = "u_carla", EDMARK = "u_edmark";
const PIPE = "pipe_client";
const CM = "f_cm", CMREC = "f_cmrec";

/** Every write the driver sent, so "a dry run writes nothing" is checkable. */
let writes = [];
let refuseFollowersFor = null;   // an opp id whose follower POST is refused
let staleFor = null;             // an opp id whose read-back lags
let opps;

const reset = () => {
  writes = [];
  refuseFollowersFor = null;
  staleFor = null;
  opps = {
    // mapped owner, nothing done yet — the ordinary backfill case
    o1: { id: "o1", name: "Client One", assignedTo: ERN },
    // unmapped owner — rule A, a CORRECT skip
    o2: { id: "o2", name: "Client Two", assignedTo: UNMAPPED },
    // owner who has left the account — counted, never acted on
    o3: { id: "o3", name: "Client Three", assignedTo: GONE },
    // mapped owner, but GoHighLevel refuses the follower write
    o4: { id: "o4", name: "Client Four", assignedTo: ERN },
    // mapped owner, write lands, read-back lags behind it
    o5: { id: "o5", name: "Client Five", assignedTo: ERN },
  };
  for (const o of Object.values(opps)) {
    o.pipelineId = PIPE; o.pipelineStageId = "s1"; o.status = "open";
    o.contactId = `c_${o.id}`; o.followers = []; o.customFields = [];
    o.updatedAt = "2026-09-01T10:00:00.000Z";
  }
};
reset();

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : null;
    const [path] = req.url.split("?");
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== "GET") writes.push({ method: req.method, path });

    if (path.startsWith(`/locations/${LOC}/customFields`))
      return send(200, { customFields: [
        { id: CM, name: "Case Manager", dataType: "TEXT" },
        { id: CMREC, name: "Case Manager Followers", dataType: "TEXT" },
      ] });
    if (path === "/users/")
      // 🔴 GONE IS NOT HERE. That absence is the whole departed-owner test, and
      // it is an observable fact rather than an inference about a role.
      return send(200, { users: [ERN, UNMAPPED, CARLA, EDMARK].map((id) => ({ id, name: id })) });
    if (path === "/opportunities/pipelines")
      return send(200, { pipelines: [{ id: PIPE, name: "OLTL Enrollment",
        stages: [{ id: "s1", name: "NEW LEAD", position: 0 }] }] });
    if (path.startsWith(`/locations/${LOC}/customValues`))
      return send(200, { customValues: [
        { id: "cv1", name: "MM Pipeline Access", value: JSON.stringify({
          pipelines: {}, folders: {}, master: [], caseManagers: { [ERN]: [CARLA, EDMARK] } }) },
        { id: "cv2", name: "MM Pipeline Folders", value: JSON.stringify({
          seeded: true, folderNames: {}, pipelines: { [PIPE]: { scope: "client", folders: [] } } }) },
      ] });
    if (path.startsWith("/opportunities/search"))
      return send(200, { opportunities: Object.values(opps), meta: { total: Object.keys(opps).length } });
    if (path === "/contacts/search") return send(200, { contacts: [], total: 0 });

    const m = /^\/opportunities\/([^/]+)(\/followers)?$/.exec(path);
    if (m) {
      const o = opps[m[1]];
      if (!o) return send(404, { message: "not found" });
      if (m[2]) {
        const ids = (j?.followers || []).filter(Boolean);
        if (req.method === "POST") {
          if (refuseFollowersFor === o.id) return send(200, { followers: [], followersAdded: [[]] });
          o.followers = [...new Set([...o.followers, ...ids])];
          return send(200, { followersAdded: [ids] });
        }
        o.followers = o.followers.filter((f) => !ids.includes(f));
        return send(200, { followers: [], followersRemoved: ids });
      }
      if (req.method === "PUT") {
        for (const f of j?.customFields || []) {
          const e = o.customFields.find((x) => x.id === f.id);
          if (e) e.fieldValue = f.value;
          else o.customFields.push({ id: f.id, fieldValue: f.value });
        }
        return send(200, { opportunity: o });
      }
      if (staleFor === o.id) return send(200, { opportunity: { ...o, followers: [] } });
      return send(200, { opportunity: o });
    }
    if (/^\/contacts\/[^/]+$/.test(path)) return send(200, { contact: { id: "c1" } });
    send(404, { message: `no fake handler for ${req.url}` });
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fp = fake.address().port;

/**
 * 🔴 ASYNC, AND THAT IS NOT A STYLE CHOICE — `execFileSync` DEADLOCKS THIS FILE.
 *
 * The fake GoHighLevel runs in THIS process. `execFileSync` blocks the event
 * loop until the child exits, so while it waits the fake cannot answer a single
 * request — and the child is waiting on exactly those requests. Neither side
 * can move. The first version sat there until its own timeout killed it, twice,
 * and looked like a slow `npx`.
 *
 * ⚠️ `task1-apply-proof` gets away with execFileSync because its child starts
 * its OWN server; copying that shape without noticing why it worked is what put
 * this here.
 */
const run = (extra = []) =>
  new Promise((resolve) => {
    const env = { ...process.env, GHL_API_BASE: `http://127.0.0.1:${fp}`, GHL_PIT: "pit_test",
                  GHL_LOCATION_ID: LOC, PIPELINE_IDS: PIPE };
    execFile("npx", ["tsx", "scripts/backfill-case-managers.mjs",
      `--state=${STATE}`, "--rate=600", ...extra],
      { env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      // A non-zero exit is expected whenever there is a failure bucket, so the
      // error is not a failure here — only its output matters.
      (_err, stdout, stderr) => resolve(String(stdout || "") + String(stderr || "")));
  });
const num = (out, label) => {
  const m = new RegExp(`${label}\\s+(\\d+)`).exec(out);
  return m ? Number(m[1]) : null;
};
const stateLines = () => existsSync(STATE)
  ? readFileSync(STATE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];

console.log("═══ 1 · 🔴 A DRY RUN WRITES NOTHING ═══");
rmSync(STATE, { force: true });
reset();
let out = await run();
console.log(`  writes the fake saw: ${JSON.stringify(writes.map((w) => `${w.method} ${w.path}`))}`);
ok("🔴 NOT ONE non-GET request reached GoHighLevel", writes.length === 0, writes);
ok("🔴 and no state file was written either — a dry run leaves no resume point",
   !existsSync(STATE), stateLines().length);
ok("it says so, loudly", /DRY RUN/.test(out) && /Nothing was written/.test(out), out.slice(-200));
// ⚠️ THE CONTROL. Without it, "writes nothing" passes on a script that read
// nothing, found nothing and exited — which is what a broken enumerator does.
ok("🔴 THE CONTROL — it did enumerate the records", /5 client records/.test(out), out.slice(0, 400));
ok("⚠️ and its 'would apply' is declared an upper bound rather than a count",
   /upper bound/.test(out), out);

console.log("\n═══ 2 · 🔴 FOUR OUTCOMES, FOUR BUCKETS ═══");
rmSync(STATE, { force: true });
reset();
refuseFollowersFor = "o4";
staleFor = "o5";
out = await run(["--apply"]);
console.log(out.split("\n").filter((l) => /applied|unconfirmed|skipped|failed|departed/.test(l)).join("\n"));
ok("🔴 o1 applied", num(out, "applied") === 1, num(out, "applied"));
ok("🔴 o2 skipped — an unmapped owner is a CORRECT no-op", num(out, "skipped") === 1, num(out, "skipped"));
ok("🔴 o4 failed — a refused write is NOT a skip", num(out, "failed") === 1, num(out, "failed"));
ok("🔴 o5 unconfirmed — the echo vouched for it, the read-back had not caught up",
   num(out, "unconfirmed") === 1, num(out, "unconfirmed"));
ok("🔴 o3 departed — and counted apart from every other outcome",
   num(out, "departed") === 1, num(out, "departed"));
// 🔴 THE ONE THAT MATTERS MOST. If these ever merge, a refused write reads as
// "nothing to do" and six hundred records look finished when some are not.
ok("🔴 the failure is NAMED, not folded into the skip total",
   /failure\(s\) — these are NOT skips/.test(out) && /o4/.test(out), out.slice(-600));
ok("⚠️ the departed owner is named so a person can decide", /u_departed\s+1 record/.test(out), out.slice(-600));
ok("⚠️ and a non-zero exit, because there was a failure", /🔴 done/.test(out), out.slice(-120));

console.log("\n═══ 3 · 🔴 THE DEPARTED RECORD WAS NOT TOUCHED ═══");
ok("no followers were added to o3", opps.o3.followers.length === 0, opps.o3.followers);
ok("🔴 and no field was written on it either", opps.o3.customFields.length === 0, opps.o3.customFields);
// ⚠️ THE CONTROL: the ordinary record in the same run DID get both.
ok("🔴 THE CONTROL — o1 in the same run got its followers",
   opps.o1.followers.includes(CARLA) && opps.o1.followers.includes(EDMARK), opps.o1.followers);
ok("⚠️ and its Case Manager field", !!opps.o1.customFields.find((f) => f.id === CM), opps.o1.customFields);

console.log("\n═══ 4 · 🔴 RESUME — SETTLED RECORDS ARE NOT REDONE, UNSETTLED ONES ARE ═══");
const before = stateLines();
console.log(`  state: ${JSON.stringify(before.map((l) => `${l.id}:${l.outcome}`))}`);
ok("every record has a line", before.length === 5, before.length);
const writesBefore = writes.length;
refuseFollowersFor = null;   // the refusal clears, as it would once a pipeline is re-shared
staleFor = null;
out = await run(["--apply"]);
ok("🔴 applied and skipped were NOT redone", num(out, "resumed") === 2, num(out, "resumed"));
// 🔴 BOTH UNSETTLED STATES ARE RETRIED, and o4 now succeeds because the cause
// was fixed — which is exactly the re-run this script exists to support.
ok("🔴 the failed record was retried and is now applied", num(out, "failed") === 0, num(out, "failed"));
ok("🔴 the unconfirmed one was retried too", num(out, "unconfirmed") === 0, num(out, "unconfirmed"));
ok("⚠️ o4 really did get its followers on the second pass",
   opps.o4.followers.includes(CARLA), opps.o4.followers);
ok("⚠️ and the departed record is still not touched", opps.o3.followers.length === 0, opps.o3.followers);

console.log("\n═══ 5 · 🔴 IDEMPOTENT — A THIRD PASS ADDS NOTHING ═══");
// `applyCaseManagers` is idempotent and the driver must not undo that by
// re-adding what is already there. Run it again with the state file removed,
// so every record is reconsidered from scratch.
rmSync(STATE, { force: true });
const followersBefore = JSON.stringify(Object.fromEntries(
  Object.entries(opps).map(([k, o]) => [k, [...o.followers].sort()])));
writes = [];
out = await run(["--apply"]);
const followersAfter = JSON.stringify(Object.fromEntries(
  Object.entries(opps).map(([k, o]) => [k, [...o.followers].sort()])));
console.log(`  before: ${followersBefore}`);
console.log(`  after:  ${followersAfter}`);
ok("🔴 not one follower changed on a full re-run", followersBefore === followersAfter, { followersBefore, followersAfter });
ok("🔴 and NO follower write was sent at all — rule A saw nothing to do",
   !writes.some((w) => w.path.endsWith("/followers")), writes.map((w) => `${w.method} ${w.path}`));

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
rmSync(STATE, { force: true });
fake.close();
process.exit(fail ? 1 : 0);
