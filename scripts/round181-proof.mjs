// ---------------------------------------------------------------------------
// ROUND 181 · "NEW LEAD" UNTIL SOMEBODY OPENS IT · THE SIDEBAR STARTS EXPANDED
//
// What must be true:
//   1  the rule        new = open · created on/after the cutoff · never opened;
//                      a missing createdAt is NOT new; the cutoff env is safe
//   2  the board       client AND Recruiting records carry `newLead`; the
//                      payload says tracking is on and from when
//   3  the open        POST /opened writes "First Opened" ONCE, as the SIGNED-IN
//                      person, only for someone who can see the case; a second
//                      open writes nothing and keeps the first opener
//   4  after it       the next board load no longer labels that case
//   5  no field       no "First Opened" field → tracking off, no label, no write
//                      (a child process, because field definitions are cached)
//   6  the field      hidden from the panel, refused by the field-edit route
//   7  the sidebar    the first-paint script, run for real: expanded unless
//                      somebody chose « or the screen is ≤640px — storage
//                      blocked included
//   8  the browser    the label on cards, Master cards, both list rows; the
//                      panel posts /opened for either board
//
// Run: npx tsx scripts/round181-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const NO_FIELD = process.env.R181_PART === "nofield";
let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${got !== undefined ? `\n       got: ${JSON.stringify(got)}` : ""}`); }
};

// ═══ a fake GoHighLevel ═══════════════════════════════════════════════════
const LOC = "LOC181", SECRET = "round181-secret";
const P1 = "pOLTL", P2 = "pODP", PG = "pPPCG";
const F_OPEN = "F_FIRST_OPENED", F_OTHER = "F_OFFICE";
const now = new Date().toISOString();
const OPPS = new Map();
const opp = (id, pipelineId, extra = {}) =>
  OPPS.set(id, { id, name: id, pipelineId, pipelineStageId: "s1", status: "open", assignedTo: "", followers: [],
    createdAt: now, contact: { id: `c_${id}`, firstName: "Case", lastName: id }, customFields: [], ...extra });
opp("o_new", P1);
opp("o_opened", P1, { customFields: [{ id: F_OPEN, fieldValueString: "2026-10-26T12:00:00.000Z|u_admin" }] });
opp("o_old", P1, { createdAt: "2026-09-01T12:00:00.000Z" });
opp("o_lost", P1, { status: "lost" });
opp("o_nodate", P1, { createdAt: "" });
opp("o_odp", P2);
opp("o_app", PG);
const PUTS = [];
const defs = NO_FIELD
  ? [] // ⚠️ EMPTY, not "everything but First Opened": an empty list is never cached
  : [{ id: F_OPEN, name: "First Opened", dataType: "TEXT", model: "opportunity" },
     { id: F_OTHER, name: "Office", dataType: "TEXT", model: "opportunity" }];
const access = JSON.stringify({ pipelines: { u_oltl: [P1], u_odp: [P2] }, folders: {}, master: [], caseManagers: {}, referralAccess: {} });
const cfg = JSON.stringify({ seeded: true, folderNames: {}, pipelines: {
  [P1]: { scope: "client", folders: [] }, [P2]: { scope: "client", folders: [] }, [PG]: { scope: "caregiver", folders: [], group: "caregiver" } } });

const server = http.createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x"), p = u.pathname;
    const send = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (p.startsWith("/users")) return send(200, { users: ["u_admin", "u_oltl", "u_odp", "u_owner"].map((id) => ({ id, name: id })) });
    if (p === `/locations/${LOC}/customValues`) return send(200, { customValues: [{ id: "cv1", name: "MM Pipeline Folders", value: cfg }, { id: "cv2", name: "MM Pipeline Access", value: access }] });
    if (p === `/locations/${LOC}/customFields`) return send(200, { customFields: u.searchParams.get("model") === "contact" ? [] : defs });
    if (p === "/opportunities/pipelines") return send(200, { pipelines: [
      { id: P1, name: "OLTL Enrollment", stages: [{ id: "s1", name: "NEW LEAD", position: 0 }] },
      { id: P2, name: "ODP Enrollment", stages: [{ id: "s1", name: "NEW LEAD", position: 0 }] },
      { id: PG, name: "PP Caregiver Applicants", stages: [{ id: "s1", name: "NEW", position: 0 }] }] });
    if (p === "/opportunities/search") {
      const pid = u.searchParams.get("pipeline_id");
      const rows = [...OPPS.values()].filter((o) => !pid || o.pipelineId === pid);
      return send(200, { opportunities: rows, meta: { total: rows.length } });
    }
    const m = p.match(/^\/opportunities\/([^/]+)$/);
    if (m && req.method === "GET") return OPPS.has(m[1]) ? send(200, { opportunity: OPPS.get(m[1]) }) : send(404, { message: "not found" });
    if (m && req.method === "PUT") {
      const body = JSON.parse(raw || "{}"); PUTS.push({ id: m[1], body });
      const o = OPPS.get(m[1]);
      for (const cf of body.customFields || []) {
        o.customFields = o.customFields.filter((x) => x.id !== cf.id).concat([{ id: cf.id, fieldValueString: cf.value }]);
      }
      return send(200, { opportunity: o });
    }
    return send(200, {});
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
Object.assign(process.env, {
  GHL_API_BASE: `http://127.0.0.1:${server.address().port}`, GHL_PIT: "pit_test", GHL_LOCATION_ID: LOC,
  GHL_SSO_SECRET: SECRET, PIPELINE_IDS: `${P1},${P2}`, CAREGIVER_PIPELINE_IDS: PG,
  NEW_LEAD_SINCE: "2026-10-25T00:00:00.000Z",
});
delete process.env.PIPELINE_ACCESS_MAP;

const { default: CryptoJS } = await import("crypto-js");
const blob = (userId, role = "user") => CryptoJS.AES.encrypt(JSON.stringify({ userId, role, type: "account", activeLocation: LOC, userName: userId }), SECRET).toString();
const board = await import("../app/api/opportunities/route.ts");
const opened = await import("../app/api/opportunities/[id]/opened/route.ts");
const loadBoard = async (who, role, scope = "") =>
  (await board.POST(new Request(`http://x/api/opportunities${scope ? `?scope=${scope}` : ""}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ssoKey: blob(who, role) }) }))).json();
const open = async (id, who, role) => {
  const headers = { "Content-Type": "application/json" };
  if (who) headers["x-ghl-sso-key"] = blob(who, role);
  const r = await opened.POST(new Request(`http://x/api/opportunities/${id}/opened`, { method: "POST", headers, body: "{}" }),
    { params: Promise.resolve({ id }) });
  return { status: r.status, json: await r.json() };
};
const flags = (j) => Object.fromEntries((j.records || []).map((r) => [r.id, r.newLead]));

// ═══ 5 · NO FIELD — the child process ═════════════════════════════════════
if (NO_FIELD) {
  console.log("\n5 · NO \"First Opened\" FIELD ON THE ACCOUNT");
  const j = await loadBoard("u_admin", "admin");
  ok("tracking is OFF in the payload", j.newLeads?.tracking === false, j.newLeads);
  ok("🔴 and NOT ONE record is labelled — a label nobody could clear is never shown",
    (j.records || []).length > 0 && j.records.every((r) => r.newLead === false), flags(j));
  const cg = await loadBoard("u_admin", "admin", "caregiver");
  ok("…on Recruiting either", (cg.records || []).every((r) => r.newLead === false), flags(cg));
  const o = await open("o_new", "u_admin", "admin");
  ok("an open answers 200 recorded:false and says why", o.status === 200 && o.json.recorded === false && /no "First Opened"/.test(o.json.why), o);
  ok("🔴 and writes NOTHING to GoHighLevel", PUTS.length === 0, PUTS);
  server.close();
  console.log(`\n${pass} passed · ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ═══ 1 · THE RULE ═════════════════════════════════════════════════════════
const NL = await import("../lib/newLead.ts");
console.log("\n1 · THE RULE");
const S = "2026-10-25T00:00:00.000Z";
ok("open · after the cutoff · never opened → NEW", NL.isNewLead({ createdAt: now, status: "open", firstOpened: "" }, S));
ok("opened → not new", !NL.isNewLead({ createdAt: now, status: "open", firstOpened: "2026-10-26T01:00:00Z|u1" }, S));
ok("created before the cutoff → not new", !NL.isNewLead({ createdAt: "2026-10-24T23:59:59Z", status: "open" }, S));
ok("created exactly at the cutoff → new", NL.isNewLead({ createdAt: S, status: "open" }, S));
for (const st of ["lost", "won", "abandoned"]) ok(`status ${st} → not new`, !NL.isNewLead({ createdAt: now, status: st }, S));
ok("🔴 a missing createdAt is NOT new", !NL.isNewLead({ createdAt: "", status: "open" }, S));
ok("🔴 an unreadable createdAt is NOT new", !NL.isNewLead({ createdAt: "not a date", status: "open" }, S));
ok("value round-trips", JSON.stringify(NL.parseFirstOpened(NL.encodeFirstOpened("2026-10-26T01:02:03Z", "u9"))) === JSON.stringify({ at: "2026-10-26T01:02:03Z", userId: "u9" }));
ok("an array value (GoHighLevel's shape) is read", NL.parseFirstOpened(["2026-10-26T01:00:00Z|u1"])?.userId === "u1");
ok("blank is never opened", NL.parseFirstOpened("  ") === null && NL.parseFirstOpened(undefined) === null);
ok("default cutoff is 00:00 Eastern, 26 Oct 2026", NL.newLeadSince("") === "2026-10-26T04:00:00.000Z");
ok("NEW_LEAD_SINCE overrides it", NL.newLeadSince("2026-11-01") === "2026-11-01T00:00:00.000Z");
ok("an unreadable NEW_LEAD_SINCE falls back, never breaks", NL.newLeadSince("soon") === "2026-10-26T04:00:00.000Z");

// ═══ 2 · THE BOARD ════════════════════════════════════════════════════════
console.log("\n2 · THE BOARD");
const j1 = await loadBoard("u_admin", "admin");
const f1 = flags(j1);
ok("tracking on, cutoff from NEW_LEAD_SINCE", j1.newLeads?.tracking === true && j1.newLeads?.since === S, j1.newLeads);
ok("🔴 the new client lead is labelled", f1.o_new === true, f1);
ok("…the ODP one too, for an admin", f1.o_odp === true, f1);
ok("an already-opened case is not", f1.o_opened === false, f1);
ok("an old case is not", f1.o_old === false, f1);
ok("a lost case is not", f1.o_lost === false, f1);
ok("a case with no createdAt is not", f1.o_nodate === false, f1);
const cg1 = await loadBoard("u_admin", "admin", "caregiver");
ok("🔴 RECRUITING: the new applicant is labelled", flags(cg1).o_app === true, flags(cg1));
ok("…and Recruiting reports tracking too", cg1.newLeads?.tracking === true, cg1.newLeads);
const rep1 = await loadBoard("u_oltl", "user");
ok("a rep sees the label on the unassigned lead in their division", flags(rep1).o_new === true, flags(rep1));

// ═══ 3 · THE OPEN ═════════════════════════════════════════════════════════
console.log("\n3 · THE OPEN");
const noSign = await open("o_new", null);
ok("no sign-in → 401", noSign.status === 401, noSign);
const other = await open("o_new", "u_odp", "user");
ok("🔴 an ODP rep cannot clear an OLTL lead they cannot see → 403", other.status === 403, other);
ok("  …and nothing was written", PUTS.length === 0, PUTS);
const first = await open("o_new", "u_oltl", "user");
ok("🔴 the OLTL rep opens it → recorded", first.status === 200 && first.json.recorded === true, first);
ok("exactly ONE write", PUTS.length === 1, PUTS.length);
ok("…to the First Opened field only", PUTS[0]?.body?.customFields?.length === 1 && PUTS[0].body.customFields[0].id === F_OPEN, PUTS[0]);
ok("🔴 naming the SIGNED-IN person", /\|u_oltl$/.test(PUTS[0]?.body?.customFields?.[0]?.value || ""), PUTS[0]);
const second = await open("o_new", "u_admin", "admin");
ok("a second open (an admin) → recorded:false, already opened", second.status === 200 && second.json.recorded === false && second.json.why === "already opened", second);
ok("🔴 still ONE write — the first opener is kept", PUTS.length === 1 && /\|u_oltl$/.test(second.json.value || ""), { puts: PUTS.length, v: second.json.value });
const app = await open("o_app", "u_owner", "owner");
ok("🔴 the Agency Owner (round 180) opens a Recruiting applicant → recorded", app.status === 200 && app.json.recorded === true, app);

// ═══ 4 · AFTER IT ═════════════════════════════════════════════════════════
console.log("\n4 · THE NEXT LOAD");
const f2 = flags(await loadBoard("u_admin", "admin"));
ok("🔴 the opened lead is no longer labelled, for anybody", f2.o_new === false, f2);
ok("the ODP lead nobody opened still is", f2.o_odp === true, f2);
ok("🔴 the opened applicant is no longer labelled on Recruiting", flags(await loadBoard("u_admin", "admin", "caregiver")).o_app === false);

// ═══ 5 · NO FIELD (child process) ═════════════════════════════════════════
let childOut = "";
try {
  childOut = execFileSync("npx", ["tsx", "scripts/round181-proof.mjs"], { encoding: "utf8", env: { ...process.env, R181_PART: "nofield" } });
} catch (e) { childOut = String(e.stdout || "") + String(e.stderr || ""); }
for (const line of childOut.split("\n")) if (/^\s{2}(ok|FAIL)\s|^\n?5 ·/.test(line) || line.startsWith("5 ·")) console.log(line);
const cm = childOut.match(/(\d+) passed · (\d+) failed/);
if (!cm) { fail++; console.log("  FAIL the no-field child printed no tally"); }
else { pass += +cm[1]; fail += +cm[2]; }

// ═══ 6 · THE FIELD IS NOT A FORM FIELD ════════════════════════════════════
console.log("\n6 · THE FIELD ITSELF");
const FF = await import("../lib/fieldFolders.ts");
const ED = await import("../lib/editable.ts");
ok("hidden from the record panel", FF.fieldIsAlwaysIntercepted("First Opened") === true);
ok("refused by the field-edit route (read-only list)", ED.READ_ONLY_FIELDS.includes("First Opened"));

// ═══ 7 · THE SIDEBAR'S FIRST-PAINT SCRIPT, RUN FOR REAL ════════════════════
console.log("\n7 · THE SIDEBAR STARTS EXPANDED");
const layout = readFileSync("app/layout.tsx", "utf8");
ok("🔴 the server HTML says expanded", /<html[^>]*data-rail="expanded"/.test(layout));
const script = (layout.match(/__html:\s*\n?\s*'([^']+)'/) || [])[1];
ok("the inline script was found", !!script, layout.slice(0, 80));
const run = ({ stored, narrow, blocked }) => {
  const attrs = { "data-rail": "expanded" };
  const ctx = {
    localStorage: { getItem: (k) => { if (blocked) throw new Error("blocked"); return k === "mm.rail" ? stored ?? null : null; } },
    matchMedia: (q) => ({ matches: q.includes("640px") && !!narrow }),
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } },
  };
  vm.runInNewContext(script, ctx);
  return attrs["data-rail"];
};
ok("🔴 nothing stored, wide → expanded", run({}) === "expanded");
ok("pressed « → collapsed", run({ stored: "collapsed" }) === "collapsed");
ok("pressed » under round 177 → still expanded", run({ stored: "expanded" }) === "expanded");
ok("≤640px → collapsed", run({ narrow: true }) === "collapsed");
ok("≤640px even for someone who chose expanded → collapsed", run({ stored: "expanded", narrow: true }) === "collapsed");
ok("🔴 storage blocked, wide → expanded (the default)", run({ blocked: true }) === "expanded");
ok("🔴 storage blocked, narrow → STILL collapsed (width check is outside the try)", run({ blocked: true, narrow: true }) === "collapsed");
const page = readFileSync("app/page.tsx", "utf8");
ok("the page's own state starts expanded (matches the server HTML)", page.includes('useState<"collapsed" | "expanded">("expanded")'));
ok("…and reads only \"collapsed\" as a choice to narrow", page.includes('if (window.localStorage.getItem(RAIL_KEY) === "collapsed") pref = "collapsed";'));

// ═══ 8 · THE BROWSER ══════════════════════════════════════════════════════
console.log("\n8 · THE BROWSER");
const tags = page.match(/\{r\.newLead \? \(\s*<span className="newlead-tag"/g) || [];
ok("the label renders in all four places (board card, Master card, client row, Recruiting row)", tags.length === 4, tags.length);
ok("the panel posts /opened", page.includes("/api/opportunities/${encodeURIComponent(id)}/opened"));
ok("🔴 …for EITHER board (client data or Recruiting cgData)", page.includes("const setList = inClients ? setData : setCgData;"));
ok("a failed save puts the label back", /\.catch\(\(\) => \{\s*markedOpen\.current\.delete\(id\);\s*setList\(\(prev\) => prev\.map\(\(x\) => \(x\.id === id \? \{ \.\.\.x, newLead: true \}/.test(page));

server.close();
console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
