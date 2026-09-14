// ---------------------------------------------------------------------------
// ROUND 123 — THE RECRUITING LABEL, THE CAVEAT BOX'S TWO SCOPES, AND THE FOUR
// POLISH ITEMS FROM ANALYSIS 104.
//
// 🔴 EVERY ASSERTION HERE READS WHAT IS DRAWN OR WHAT IS SENT. Not one of them
// reads a source file. Four rounds running I have written a check that matched
// my own comment or a regex that could not match the shape it was policing —
// the `touchFor` finding in section 6 is the latest, and it is the reason this
// file drives a browser instead of grepping.
//
// ⚠️ THE FIXTURE MAKES EVERY EXPECTED NUMBER UNIQUE, so nothing can pass by
// coincidence:
//
//   Recruiting   pipelines offered 2 · 2 · 4, and the drawn pipeline 4 · 2 · 4
//                ⚠️ MY FIRST VERSION EXPECTED 7 · 3 · 10 AND WAS WRONG ABOUT
//                THE SCREEN. The recruiting board draws ONE pipeline at a time
//                — there is no "all pipelines" option — so the switcher widens
//                the PICKER, not the list. The count was right and the harness
//                was not, which is the fourth time this class of error has been
//                mine, so it is written down rather than quietly corrected.
//   Attendees    Private Pay 2 · OLTL 1 · all 4
//   Partners     Private Pay 2 · OLTL 2 · ODP 1
//   Measured     p1 (3 days) and p5 (40 days); p2, p3, p4 fail to read
//
// ⚠️ AND THE FAKE ONLY ANSWERS WHAT GOHIGHLEVEL ANSWERS. /opportunities/search
// honours `pipeline_id` because GoHighLevel does — a fake returning every
// record to every pipeline query would have made the group counts meaningless.
// The note reads that fail are a real failure mode (a 500 from GHL), not a
// refusal invented to make a number come out.
//
// Run: node scripts/round123-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import { spawn, execSync } from "node:child_process";
import { rmSync } from "node:fs";
import { chromium } from "playwright-core";
import CryptoJS from "crypto-js";

const LOC = "loc_test";
const SECRET = "harness_shared_secret";

const RT = "F_RT", CAT = "F_CAT", TIER = "F_TIER", PDIV = "F_PDIV", PNOTES = "F_PNOTES";
const EVATT = "F_EVATT", EVOUT = "F_EVOUT", EVPROF = "F_EVPROF";
const REF = "F_REF", EVDATE = "F_EVDATE", EVCOST = "F_EVCOST", EVVEN = "F_EVVEN", EVDIV = "F_EVDIV";

const PIPES = [
  { id: "pipe_oltl", name: "OLTL Enrollment", scope: "client" },
  { id: "pipe_ev", name: "Events", scope: "client" },
  { id: "cg1", name: "PP Caregiver Applicants", scope: "caregiver" },
  { id: "cg2", name: "ODP DSP Applicant", scope: "caregiver" },
  { id: "st1", name: "PP Staff Applicants", scope: "caregiver", group: "staff" },
  { id: "st2", name: "ODP Staff Applicants", scope: "caregiver", group: "staff" },
];
/** How many applicant records each recruiting pipeline holds. 4+3=7, 2+1=3. */
const CG_N = { cg1: 4, cg2: 3, st1: 2, st2: 1 };

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

const BLOB = CryptoJS.AES.encrypt(JSON.stringify({
  userId: "u1", role: "admin", type: "agency", activeLocation: LOC,
  userName: "Chris Tester", email: "chris@example.com", companyId: "co1",
}), SECRET).toString();

// id, org, division — two Private Pay, two OLTL, one ODP.
const PARTNERS = [
  ["p1", "Riddle Hospital", "Private Pay"],
  ["p2", "Crozer SNF", "Private Pay"],
  ["p3", "Mercy Home Care", "OLTL"],
  ["p4", "Bryn Mawr Rehab", "OLTL"],
  ["p5", "Lankenau Discharge", "ODP"],
];
/** Only these two have a readable note. The rest 500 — unmeasured, and said so. */
const NOTE_DAYS = { p1: 3, p5: 40 };
/** id, name, eventId — a4 was met but its record does not say where. */
const ATTENDEES = [
  ["a1", "Dana Ruiz", "ev1"],
  // 🔴 THE SAME CONTACT TWICE, which is how round 122's duplicate arose: the
  // contact search returns the person once per matching record, and `a.id` is
  // the CONTACT id. Four people, five rows — so "people met" and the badge can
  // be told apart from a row count.
  ["a1", "Dana Ruiz", "ev1"],
  ["a2", "Ivy Chen", "ev1"],
  ["a3", "Sam Abara", "ev2"],
  ["a4", "Jo Fairweather", ""],
];

/** Every contact whose notes the fake was asked for, in order. */
const noteReads = [];
const days = (n) => new Date(Date.now() - n * 86400000).toISOString();

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = body ? JSON.parse(body) : null;
    const u = req.url;
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.startsWith(`/locations/${LOC}/customFields`)) {
      const opp = u.includes("model=opportunity");
      return send(200, {
        customFields: opp
          ? [
              { id: REF, name: "Referring Partner", dataType: "TEXT" },
              { id: EVDATE, name: "Event Date", dataType: "DATE" },
              { id: EVCOST, name: "Event Cost", dataType: "NUMERICAL" },
              { id: EVVEN, name: "Event Venue", dataType: "TEXT" },
              { id: EVDIV, name: "Event Division", dataType: "TEXT" },
            ]
          : [
              { id: RT, name: "Record Type", dataType: "SINGLE_OPTIONS",
                picklistOptions: ["Referral Partner", "Event Attendee"] },
              { id: CAT, name: "Partner Category", dataType: "SINGLE_OPTIONS",
                picklistOptions: ["Hospital discharge", "SNF / rehab"] },
              { id: TIER, name: "Partner Tier", dataType: "SINGLE_OPTIONS",
                picklistOptions: ["A", "B", "C", "Prospect"] },
              { id: PDIV, name: "Partner Division", dataType: "SINGLE_OPTIONS",
                picklistOptions: ["Private Pay", "OLTL", "ODP", "All"] },
              { id: PNOTES, name: "Partner Notes", dataType: "LARGE_TEXT" },
              { id: EVATT, name: "Event Attended", dataType: "TEXT" },
              { id: EVOUT, name: "Event Outcome", dataType: "SINGLE_OPTIONS",
                picklistOptions: ["Legit lead", "Referral partner prospect"] },
              { id: EVPROF, name: "Attendee Profile", dataType: "TEXT" },
            ],
      });
    }
    if (u.startsWith("/users/")) return send(200, { users: [{ id: "u1", name: "Chris Tester" }] });
    if (u.startsWith("/opportunities/pipelines"))
      return send(200, { pipelines: PIPES.map((p) => ({ id: p.id, name: p.name,
        stages: [{ id: `${p.id}_s1`, name: "INITIAL CALL", position: 0 }] })) });
    if (u.startsWith(`/locations/${LOC}/customValues`))
      return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders",
        value: JSON.stringify({
          seeded: true,
          pipelines: Object.fromEntries(PIPES.map((p) => [p.id,
            { scope: p.scope, folders: [], ...(p.group ? { group: p.group } : {}) }])),
          folderNames: {},
        }) }] });
    if (u.startsWith("/opportunities/search")) {
      // 🔴 GOHIGHLEVEL HONOURS pipeline_id, SO THE FAKE MUST TOO. Returning
      // every record to every pipeline query would make "7 in Caregivers"
      // arithmetic the app never did.
      const pid = new URL(`http://x${u}`).searchParams.get("pipeline_id") || "";
      const mk = (id, name, extra = {}) => ({
        id, name, pipelineId: pid, pipelineStageId: `${pid}_s1`, status: "open",
        createdAt: days(5), contact: { id: `c_${id}`, firstName: name, lastName: "" },
        ...extra,
      });
      if (CG_N[pid] !== undefined)
        return send(200, { opportunities: Array.from({ length: CG_N[pid] }, (_, i) =>
          mk(`${pid}_o${i + 1}`, `Applicant ${pid}-${i + 1}`)), meta: { total: CG_N[pid] } });
      if (pid === "pipe_ev")
        return send(200, { opportunities: [
          mk("ev1", "Spring Expo", { customFields: [
            { id: EVDIV, fieldValue: "Private Pay" }, { id: EVCOST, fieldValue: 1200 }] }),
          mk("ev2", "OLTL Open House", { customFields: [
            { id: EVDIV, fieldValue: "OLTL" }, { id: EVCOST, fieldValue: 800 }] }),
        ], meta: { total: 2 } });
      if (pid === "pipe_oltl")
        return send(200, { opportunities: [
          mk("r1", "Alvarez family", { customFields: [{ id: REF, fieldValue: "p1" }] }),
          mk("r2", "Okonkwo case", { customFields: [{ id: REF, fieldValue: "p3" }] }),
          // 🔴 THE DANGLING ONE. Points at a partner that does not exist, so it
          // has no division — which is exactly why its caveat cannot be cut by
          // division and has to sit under the second heading.
          mk("r3", "Whitfield case", { customFields: [{ id: REF, fieldValue: "ghost" }] }),
        ], meta: { total: 3 } });
      return send(200, { opportunities: [], meta: { total: 0 } });
    }
    if (u === "/contacts/search") {
      const want = j?.filters?.[0]?.value;
      if (want === "Referral Partner")
        return send(200, { contacts: PARTNERS.map(([id, org, div]) => ({
          id, contactName: org, email: `${id}@ex.com`, phone: "",
          customFields: [
            { id: RT, value: "Referral Partner" },
            { id: CAT, value: "Hospital discharge" },
            { id: TIER, value: "B" },
            { id: PDIV, value: div },
          ],
        })), total: PARTNERS.length });
      if (want === "Event Attendee")
        return send(200, { contacts: ATTENDEES.map(([id, name, ev]) => ({
          id, contactName: name, email: "", phone: "",
          customFields: [
            { id: RT, value: "Event Attendee" },
            ...(ev ? [{ id: EVATT, value: ev }] : []),
          ],
        })), total: ATTENDEES.length });
      return send(200, { contacts: [], total: 0 });
    }
    if (/^\/contacts\/[^/]+\/notes/.test(u)) {
      const id = u.split("/")[2];
      if (req.method === "POST") return send(200, { note: { id: "n_new" } });
      noteReads.push(id);
      // ⚠️ A REAL FAILURE MODE, NOT AN INVENTED REFUSAL. GoHighLevel does 500
      // on a note read, and an unreadable note is precisely what "not measured"
      // means — see resolveTouches, which counts it as failed and leaves the
      // partner absent rather than guessing a date.
      if (NOTE_DAYS[id] === undefined) return send(500, { message: "upstream error" });
      return send(200, { notes: [{ id: `n_${id}`, body: "Called them.",
        dateAdded: days(NOTE_DAYS[id]) }] });
    }
    if (/^\/contacts\/[^/]+$/.test(u)) return send(200, { contact: { id: u.split("/")[2] } });
    send(404, { message: `no fake handler for ${u}` });
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const fp = fake.address().port;

try {
  const stale = execSync("pgrep -f '^next-server' || true").toString().trim();
  for (const pid of stale.split("\n").filter(Boolean))
    try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
} catch { /* no pgrep */ }
try { rmSync(".next/dev/lock", { force: true }); } catch { /* nothing */ }

const PORT = 3700 + Math.floor(Math.random() * 250);
const dev = spawn("npx", ["next", "dev", "-p", String(PORT)], {
  detached: true,
  env: { ...process.env, GHL_API_BASE: `http://127.0.0.1:${fp}`, GHL_LOCATION_ID: LOC,
         GHL_PIT: "pit_test", GHL_SSO_SECRET: SECRET,
         PIPELINE_IDS: PIPES.map((p) => p.id).join(",") },
  stdio: ["ignore", "pipe", "pipe"],
});
const devLog = [];
dev.stdout.on("data", (d) => devLog.push(String(d)));
dev.stderr.on("data", (d) => devLog.push(String(d)));

let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  try { process.kill(-dev.pid, "SIGKILL"); } catch { /* gone */ }
  try { fake.close(); } catch { /* closed */ }
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(sig, () => { cleanup(); process.exit(130); });
process.on("uncaughtException", (e) => {
  console.log(`\n🔴 ${e.message}`); cleanup(); process.exit(1);
});

const base = `http://localhost:${PORT}`;
let up = false;
for (let i = 0; i < 150 && !up; i++) {
  try {
    const r = await fetch(`${base}/api/opportunities`, { signal: AbortSignal.timeout(4000) });
    if (r.status > 0) up = true;
  } catch { /* not listening */ }
  if (!up) await new Promise((r) => setTimeout(r, 1000));
}
if (!up) { console.log(devLog.join("").slice(-1500)); process.exit(1); }
console.log(`  dev server up on ${PORT}`);

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-proxy-server", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
page.on("pageerror", (e) => console.log(`  [page error] ${e.message}`));

/** Every request the APP made, so "what is sent" is observable. */
const appCalls = [];
page.on("request", (r) => {
  const u = r.url();
  if (u.includes("/api/")) appCalls.push({ url: u, method: r.method(), post: r.postData() || "" });
});

await page.route(`${base}/__parent`, (route) => route.fulfill({
  status: 200, contentType: "text/html",
  body: `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0}iframe{border:0;width:1440px;height:980px}</style>
<script>window.addEventListener("message",(e)=>{if(e.data&&e.data.message==="REQUEST_USER_DATA")
e.source.postMessage({message:"REQUEST_USER_DATA_RESPONSE",payload:${JSON.stringify(BLOB)}},"*");});</script>
<iframe src="${base}/"></iframe>`,
}));
await page.goto(`${base}/__parent`, { waitUntil: "domcontentloaded" });
const frame = await (await page.waitForSelector("iframe")).contentFrame();
await frame.waitForFunction(
  () => !/Checking session/.test(document.querySelector(".viewas")?.textContent || ""),
  { timeout: 90000 },
);

const txt = (sel) => frame.evaluate(
  (s) => document.querySelector(s)?.textContent?.trim().replace(/\s+/g, " ") || null, sel);
const rail = async (name) => {
  await frame.evaluate((n) => {
    const b = [...document.querySelectorAll(".railsec")]
      .find((x) => x.textContent.trim() === n);
    if (!b) throw new Error(`no rail section "${n}"`);
    b.click();
  }, name);
  await page.waitForTimeout(700);
};

// ═══ 1 · THE RECRUITING LABEL FOLLOWS THE CHOICE ══════════════════════════
console.log("\n1 · 🔴 THE HEADING WAS THE STALE HALF — AND SO WAS EVERYTHING COUNTING");
await rail("Recruiting");
await frame.waitForSelector(".rechead-h", { timeout: 60000 });
await frame.waitForFunction(
  () => /\d/.test(document.querySelector(".count")?.textContent || ""), { timeout: 60000 });

const pickGroup = async (label) => {
  await frame.click(".rechead-h .rfdiv");
  await page.waitForTimeout(250);
  await frame.evaluate((t) => {
    const b = [...document.querySelectorAll(".rfdivpop li button")]
      .find((x) => x.querySelector("span")?.firstChild?.textContent?.trim() === t);
    if (!b) throw new Error(`no switcher entry "${t}"`);
    b.click();
  }, label);
  await page.waitForTimeout(600);
};
const recruitingState = () => frame.evaluate(() => ({
  head: document.querySelector(".rechead-h .rfdivname")?.textContent?.trim()
    .replace(/\s+/g, " ") || null,
  sub: document.querySelector(".rfhead.rechead > small")?.textContent?.trim() || null,
  count: document.querySelector(".count")?.textContent?.trim().replace(/\s+/g, " ") || null,
  placeholder: document.querySelector(".toolbar.mtoolbar .search input")?.placeholder || null,
  agedSub: document.querySelector(".stats .stat.blk .sub")?.textContent?.trim() || null,
  // ⚠️ THE PIPELINE PICKER IS WHAT THE SWITCHER ACTUALLY NARROWS. The board
  // draws ONE pipeline at a time (there is no "all pipelines" option), so the
  // count is that pipeline's — my first version of this file expected 7 and 10
  // and was wrong about the screen, not the other way round.
  pipes: [...document.querySelectorAll("#cgPipeSel option")].map((o) => o.textContent.trim()),
}));

const cgSeen = {};
for (const [label, expectHead, expectN, expectPipes] of [
  ["Caregivers", "Recruiting · Caregivers", 4, 2],
  ["Staff", "Recruiting · Staff", 2, 2],
  ["All", "Recruiting · All", 4, 4],
]) {
  if (label !== "Caregivers") await pickGroup(label);
  const s = await recruitingState();
  cgSeen[label] = s;
  console.log(`  ${label.padEnd(10)} head="${s.head}"  count="${s.count}"  pipes=${s.pipes.length}`);
  console.log(`             sub="${s.sub}"`);
  ok(`🔴 the heading names the choice · ${label}`, s.head === expectHead, s.head);
  ok(`the count is the shown pipeline's ${expectN} · ${label}`,
     new RegExp(`^${expectN}\\b`).test(s.count || ""), s.count);
  ok(`🔴 the switcher narrows the pipelines at source · ${label} offers ${expectPipes}`,
     s.pipes.length === expectPipes, s.pipes);
}
ok("🔴 three choices, three different headings",
   new Set(Object.values(cgSeen).map((s) => s.head)).size === 3,
   Object.values(cgSeen).map((s) => s.head));
ok("🔴 and the list moved — Staff draws a different set from Caregivers",
   cgSeen.Caregivers.count !== cgSeen.Staff.count,
   [cgSeen.Caregivers.count, cgSeen.Staff.count]);
// ⚠️ NOT ASSERTED: that "All" shows a DIFFERENT COUNT from Caregivers. It does
// not and should not — the board draws one pipeline and "All" simply widens the
// picker, which is what the two/two/four above proves. Asserting a difference
// would have been an assertion about a screen this app does not have.
ok("⚠️ the subtitle stopped calling staff APPLICANTS a hire",
   /staff applicants/i.test(cgSeen.Staff.sub || "") && !/hire/i.test(cgSeen.Staff.sub || ""),
   cgSeen.Staff.sub);
ok("the count line says STAFF applicants under Staff",
   /staff applicant/i.test(cgSeen.Staff.count || ""), cgSeen.Staff.count);
ok("the search placeholder follows it too",
   /staff applicants/i.test(cgSeen.Staff.placeholder || ""), cgSeen.Staff.placeholder);
ok("and so does the tile underneath",
   /staff applicants/i.test(cgSeen.Staff.agedSub || ""), cgSeen.Staff.agedSub);
ok("⚠️ while Caregivers keeps the plain word",
   /(^|[^f] )applicants/i.test(cgSeen.Caregivers.agedSub || "")
   && !/staff/i.test(cgSeen.Caregivers.agedSub || ""), cgSeen.Caregivers.agedSub);

// ═══ 20 · TWO SCOPES, TOLD APART ══════════════════════════════════════════
console.log("\n20 · 🔴 ONE BOX, TWO SCOPES — AND THE BUTTON WAS MEASURING THE WRONG SET");
await rail("Referrals");
await frame.waitForSelector(".rfcaveat", { timeout: 90000 });

const caveatShape = () => frame.evaluate(() => {
  const box = document.querySelector(".rfcaveat");
  if (!box) return null;
  const heads = [...box.querySelectorAll("b")].map((b) => b.textContent.trim());
  const lists = [...box.querySelectorAll("ul")].map((ul) =>
    [...ul.querySelectorAll("li")].map((li) => li.textContent.trim()));
  return { heads, lists, btn: box.querySelector(".rfcavacts button")?.textContent?.trim() || null };
});
const pickDivision = async (label) => {
  await frame.click(".rfhead .rfdiv");
  await page.waitForTimeout(250);
  await frame.evaluate((t) => {
    const b = [...document.querySelectorAll(".rfdivpop li button")]
      .find((x) => x.textContent.trim().startsWith(t));
    if (!b) throw new Error(`no division "${t}"`);
    b.click();
  }, label);
  await page.waitForTimeout(700);
};

const allScope = await caveatShape();
console.log(`  All divisions · heads: ${JSON.stringify(allScope.heads)}`);
ok("under All divisions there is ONE heading — no narrower scope to contrast",
   allScope.heads.length === 1, allScope.heads);
ok("and both kinds of line are in it",
   allScope.lists.flat().some((l) => /not been measured/.test(l))
   && allScope.lists.flat().some((l) => /no longer exists/.test(l)), allScope.lists);

await pickDivision("Private Pay");
const ppScope = await caveatShape();
console.log(`  Private Pay   · heads: ${JSON.stringify(ppScope.heads)}`);
console.log(`                · button: ${ppScope.btn}`);
ok("🔴 under a division the box splits in two", ppScope.heads.length === 2, ppScope.heads);
ok("the first heading names the division", /Private Pay/.test(ppScope.heads[0]), ppScope.heads[0]);
ok("🔴 the second says the lines under it are NOT the division",
   /every division/i.test(ppScope.heads[1]), ppScope.heads[1]);
ok("the unmeasured line is division-scoped, so it is above",
   /not been measured/.test((ppScope.lists[0] || []).join(" ")), ppScope.lists[0]);
ok("🔴 the dangling referral is below — a deleted partner has no division left",
   /no longer exists/.test((ppScope.lists[1] || []).join(" ")), ppScope.lists[1]);
ok("⚠️ and the unplaceable attendee is stated, not dropped",
   /does not say which event/.test((ppScope.lists[0] || []).join(" ")), ppScope.lists[0]);
ok("the button offers the DIVISION's unmeasured count", /next 1\b/.test(ppScope.btn || ""),
   ppScope.btn);

// The decisive one: whose notes does the server actually read?
noteReads.length = 0;
await frame.click(".rfcavacts button");
await frame.waitForFunction(
  () => !/Measuring/.test(document.querySelector(".rfcavacts button")?.textContent || ""),
  { timeout: 60000 });
await page.waitForTimeout(400);
const measured = [...new Set(noteReads)].sort();
console.log(`  notes actually read: ${JSON.stringify(measured)}`);
ok("🔴 it measured the DIVISION's unmeasured partner, and only that one",
   measured.length === 1 && measured[0] === "p2", measured);
ok("🔴 not the four unmeasured partners on the account",
   !measured.includes("p3") && !measured.includes("p4"), measured);

// ═══ 15 · THE ID EXPOSURE ROUND 122 REPORTED AS GONE ══════════════════════
console.log("\n15 · 🔴 A CORRECTION — SIXTY CONTACT IDS WERE STILL IN A URL");
const withIds = appCalls.filter((c) => /[?&](touchFor|contactId)=/.test(c.url));
console.log(`  /api/ URLs carrying a contact id: ${withIds.length}`);
ok("🔴 no request the browser SENT carries a contact id in its URL",
   withIds.length === 0, withIds.map((c) => c.url));
ok("the measure batch is a POST body now",
   appCalls.some((c) => c.method === "POST" && /"action":"touch"/.test(c.post)),
   appCalls.filter((c) => c.method === "POST").map((c) => c.post.slice(0, 60)));

// ═══ 6 · THE COLUMN SORTS BY WHAT IT IS CALLED ════════════════════════════
console.log("\n6 · ⚠️ \"Last touch\" SORTED BY A TIER-WEIGHTED PRIORITY");
await pickDivision("All divisions");
await frame.waitForSelector('tr[aria-label^="Open "]', { timeout: 30000 });
const touchCol = () => frame.evaluate(() => [...document.querySelectorAll('tr[aria-label^="Open "]')]
  .map((tr) => ({ org: tr.querySelector(".rforg")?.textContent?.trim() || "",
                  touch: tr.querySelector("td.num")?.textContent?.trim() || "" })));
const order = await touchCol();
console.log(`  ${order.map((r) => `${r.org}=${r.touch}`).join(" · ")}`);
ok("the header claims the sort it performs",
   await frame.evaluate(() => {
     const th = [...document.querySelectorAll("th")].find((t) => /Last touch/.test(t.textContent));
     return th?.getAttribute("aria-sort") === "descending";
   }), "aria-sort not set");
ok("🔴 longest since contact first — 40d above 3d",
   order.findIndex((r) => /Lankenau/.test(r.org)) < order.findIndex((r) => /Riddle/.test(r.org)),
   order.map((r) => r.org));
ok("🔴 and unmeasured sorts LAST, not as 'touched today'",
   order.slice(-3).every((r) => r.touch === "—")
   && order.slice(0, 2).every((r) => r.touch !== "—"), order);

// ═══ 3 · THE DIVISION SWITCH REACHES THE ATTENDEES ════════════════════════
console.log("\n3 · ⚠️ TWO OF THE FOUR EVENTS KPIs IGNORED THE SWITCH ABOVE THEM");
const evTab = async () => {
  await frame.evaluate(() => {
    const b = [...document.querySelectorAll(".rftab")]
      .find((x) => /^Events/.test(x.textContent.trim()));
    if (!b) throw new Error("no Events tab");
    b.click();
  });
  await page.waitForTimeout(600);
};
await evTab();
const metCount = () => frame.evaluate(() => {
  const k = [...document.querySelectorAll(".rfkpis .kpi, .rfkpis > div")]
    .find((d) => /(person|people) met/.test(d.textContent));
  return k?.textContent?.trim().replace(/\s+/g, " ") || null;
});
const metAll = await metCount();
console.log(`  All divisions · ${metAll}`);
ok("All divisions counts every attendee — 4", /of 4 people met/.test(metAll || ""), metAll);
await pickDivision("Private Pay");
await evTab();
const metPP = await metCount();
console.log(`  Private Pay   · ${metPP}`);
ok("🔴 Private Pay counts only its own event's attendees — 2",
   /of 2 people met/.test(metPP || ""), metPP);
await pickDivision("OLTL");
await evTab();
const metOl = await metCount();
console.log(`  OLTL          · ${metOl}`);
ok("🔴 and OLTL is 1 — three divisions, three numbers", /of 1 person met/.test(metOl || ""),
   metOl);

// ⚠️ AND THE COUNT IS OF PEOPLE, NOT ROWS. The fixture sends Dana Ruiz twice.
await pickDivision("All divisions");
await evTab();
const panel = await frame.evaluate(() => ({
  badge: document.querySelector(".rfn")?.textContent?.trim() || null,
  rows: document.querySelectorAll(".rfatt tr, .rfattend tr, table tbody tr").length,
  names: [...document.querySelectorAll("table tbody tr")]
    .map((tr) => tr.textContent.trim().slice(0, 20)),
}));
console.log(`  attendee panel · badge=${panel.badge} rows=${panel.rows}`);
ok("🔴 five rows arrive from GoHighLevel and four people are drawn",
   panel.names.filter((n) => /Dana Ruiz/.test(n)).length === 1, panel.names);
ok("⚠️ and the badge counts people too — it was counting rows",
   panel.badge === "4", panel.badge);
ok("🔴 so does the KPI: a person met twice is one person met",
   /of 4 people met/.test((await metCount()) || ""), await metCount());

// ═══ 5 · THE DRAWER'S NOTES AFTER A LOGGED TOUCH ══════════════════════════
console.log("\n5 · ⚠️ CADENCE MOVED AND THE TOUCH HISTORY DID NOT");
await pickDivision("All divisions");
await frame.evaluate(() => {
  const b = [...document.querySelectorAll(".rftab")]
    .find((x) => /^Sources/.test(x.textContent.trim()));
  if (b) b.click();
});
await page.waitForTimeout(500);
const notesCalls = () => appCalls.filter((c) => /"action":"partner-notes"/.test(c.post)).length;
await frame.click('tr[aria-label="Open Riddle Hospital"]');
await frame.waitForSelector(".rfdrawer", { timeout: 30000 });
await page.waitForTimeout(700);
const beforeNotes = notesCalls();
ok("the drawer reads the partner's notes on open", beforeNotes >= 1, beforeNotes);
await frame.evaluate(() => {
  const b = [...document.querySelectorAll(".rfdrawer button")]
    .find((x) => /Log a touch/i.test(x.textContent));
  if (!b) throw new Error("no Log a touch button in the drawer");
  b.click();
});
await page.waitForTimeout(500);
await frame.fill(".rfmodal textarea", "Called the discharge planner.");
await frame.evaluate(() => {
  const b = [...document.querySelectorAll(".rfmodal button")]
    .find((x) => /^(Log|Save|Log touch)/i.test(x.textContent.trim()));
  if (!b) throw new Error("no save button in the touch dialog");
  b.click();
});
await page.waitForTimeout(1600);
const afterNotes = notesCalls();
console.log(`  partner-notes reads · before=${beforeNotes} after=${afterNotes}`);
ok("🔴 logging a touch makes the open drawer re-read its notes",
   afterNotes > beforeNotes, { beforeNotes, afterNotes });

// ═══ 13 · LEAVING AND COMING BACK ═════════════════════════════════════════
console.log("\n13 · ⚠️ EVERY VISIT WAS A FULL LOAD AND UP TO 60 NOTE READS");
const fullLoads = () => appCalls.filter((c) => /\/api\/referrals\?touch=auto/.test(c.url)).length;
const before13 = fullLoads();
await rail("Clients");
await page.waitForTimeout(600);
await rail("Referrals");
await frame.waitForSelector('tr[aria-label^="Open "]', { timeout: 30000 });
await page.waitForTimeout(800);
const after13 = fullLoads();
console.log(`  full referral loads · before=${before13} after=${after13}`);
ok("🔴 the second visit re-reads nothing", after13 === before13, { before13, after13 });
ok("⚠️ and it still draws — the payload survived the unmount",
   (await frame.evaluate(() => document.querySelectorAll('tr[aria-label^="Open "]').length)) === 5,
   "rows missing");
// The one that proves it is a CACHE and not a second owner of the data.
const rowsNow = await touchCol();
ok("🔴 including the touch logged a moment ago — the mirror keeps edits",
   rowsNow.find((r) => /Riddle/.test(r.org))?.touch === "0d",
   rowsNow.find((r) => /Riddle/.test(r.org)));

console.log(`\n${fail ? "🔴" : "✅"}  ${pass} passed · ${fail} failed`);
await browser.close();
cleanup();
process.exit(fail ? 1 : 0);
