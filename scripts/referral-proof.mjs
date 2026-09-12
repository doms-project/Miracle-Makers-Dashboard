// ---------------------------------------------------------------------------
// ROUND 100 — PROOF, NOT A GREEN BUILD.
//
// Two halves, both real runs:
//
//   A. THE ARITHMETIC — lib/referrals.ts executed against the prototype's own
//      numbers. This is where a wrong answer would be invisible: the screen
//      would draw a confident figure and nothing would look broken.
//
//   B. ghlSearchContacts AGAINST A FAKE GoHighLevel — a real HTTP server
//      answering real requests, so the request body, the parse and both
//      failure modes are exercised end to end rather than mocked.
//
// Run: node --experimental-strip-types scripts/referral-proof.mjs
// ---------------------------------------------------------------------------
import http from "node:http";

let pass = 0;
let fail = 0;
const ok = (name, cond, got) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}   got: ${JSON.stringify(got)}`);
  }
};

// ── A. the arithmetic ──────────────────────────────────────────────────────
const R = await import("../lib/referrals.ts");
const NEVER = Number.MAX_SAFE_INTEGER;

console.log("\nA · THE ARITHMETIC");

// The prototype: CADENCE.A = 14, WEIGHT.A = 3. 20 days since a touch on an
// A-tier partner is 6 over, priority 18.
{
  const p = R.enrichPartner(
    { id: "1", org: "Riddle", email: "", phone: "", cat: "Hospital discharge", tier: "A", division: "OLTL", owner: "Chris", notes: "", lastTouch: 20 },
    [],
  );
  ok("A-tier, 20d since touch → 6 overdue", p.overdueBy === 6, p.overdueBy);
  ok("  priority = overdueBy * WEIGHT.A (3) = 18", p.priority === 18, p.priority);
}

// 🔴 THE ONE THE BRIEF WOULD HAVE GOT WRONG. The brief's WEIGHT omits Prospect;
// the prototype has it at 2. Without it this is `over * undefined` = NaN, and a
// NaN priority sorts unpredictably — every Prospect lands somewhere arbitrary
// with nothing on screen to say why.
{
  const p = R.enrichPartner(
    { id: "2", org: "Chamber", email: "", phone: "", cat: "Chamber / business network", tier: "Prospect", division: "All", owner: "", notes: "", lastTouch: 31 },
    [],
  );
  ok("Prospect cadence is 21 days", p.cadence === 21, p.cadence);
  ok("Prospect priority is a NUMBER, not NaN", Number.isFinite(p.priority), p.priority);
  ok("  = 10 over * WEIGHT.Prospect (2) = 20", p.priority === 20, p.priority);
}

// Never contacted outranks everyone. Unknown outranks nobody.
{
  const never = R.enrichPartner({ id: "3", org: "New", email: "", phone: "", cat: "", tier: "C", division: "", owner: "", notes: "", lastTouch: NEVER }, []);
  const unknown = R.enrichPartner({ id: "4", org: "Unmeasured", email: "", phone: "", cat: "", tier: "A", division: "", owner: "", notes: "", lastTouch: null }, []);
  const late = R.enrichPartner({ id: "5", org: "Late", email: "", phone: "", cat: "", tier: "A", division: "", owner: "", notes: "", lastTouch: 400 }, []);
  ok("never-contacted is overdue", never.isOverdue === true, never.isOverdue);
  ok("never-contacted outranks a 400-day-late A-tier", never.priority > late.priority, [never.priority, late.priority]);
  ok("unknown touch is NOT overdue", unknown.isOverdue === false, unknown.isOverdue);
  ok("unknown touch is flagged", unknown.unknownTouch === true, unknown.unknownTouch);
  ok("unknown sorts below everything actionable", unknown.priority < late.priority && unknown.priority < 0, unknown.priority);
}

// An UNDATED referral counts lifetime, never in a 90-day figure.
{
  const refs = [
    { id: "o1", partnerId: "9", status: "won", value: 6000, ago: 10 },
    { id: "o2", partnerId: "9", status: "open", value: 0, ago: null },
    { id: "o3", partnerId: "9", status: "lost", value: 0, ago: 200 },
  ];
  const p = R.enrichPartner({ id: "9", org: "Elder law", email: "", phone: "", cat: "Elder law", tier: "B", division: "", owner: "", notes: "", lastTouch: 5 }, refs);
  ok("refs counts all three", p.refs === 3, p.refs);
  ok("refs90 counts only the dated, recent one", p.refs90 === 1, p.refs90);
  ok("the undated one is COUNTED and stated", p.undated === 1, p.undated);
  ok("lastRefAgo ignores the undated one", p.lastRefAgo === 10, p.lastRefAgo);
  ok("winRate is over ALL referrals (1/3)", p.winRate === 33, p.winRate);
}

// "due this week" is the prototype's SEVEN days, not the brief's three.
{
  const list = [
    R.enrichPartner({ id: "a", org: "a", email: "", phone: "", cat: "", tier: "B", division: "", owner: "", notes: "", lastTouch: 25 }, []), // -5 → due soon
    R.enrichPartner({ id: "b", org: "b", email: "", phone: "", cat: "", tier: "B", division: "", owner: "", notes: "", lastTouch: 21 }, []), // -9 → later
    R.enrichPartner({ id: "c", org: "c", email: "", phone: "", cat: "", tier: "B", division: "", owner: "", notes: "", lastTouch: 44 }, []), // +14 → overdue
    R.enrichPartner({ id: "d", org: "d", email: "", phone: "", cat: "", tier: "B", division: "", owner: "", notes: "", lastTouch: null }, []),
  ];
  const k = R.partnerKpis(list);
  ok("DUE_SOON_DAYS is 7", R.DUE_SOON_DAYS === 7, R.DUE_SOON_DAYS);
  ok("overdue = 1", k.overdue === 1, k.overdue);
  ok("dueSoon = 1", k.dueSoon === 1, k.dueSoon);
  ok("later = 1", k.later === 1, k.later);
  ok("unknown = 1, and it is in NONE of the three", k.unknown === 1, k.unknown);
  ok("  the three buckets exclude it", k.overdue + k.dueSoon + k.later === 3, [k.overdue, k.dueSoon, k.later]);
}

// Division "All" appears under EVERY division — the brief's rule.
{
  ok('partner "All" shows under ODP', R.inDivision("All", "ODP") === true);
  ok('partner "OLTL" hidden under ODP', R.inDivision("OLTL", "ODP") === false);
  ok('a blank division shows everywhere', R.inDivision("", "ODP") === true);
  ok('viewing "All" shows an OLTL partner', R.inDivision("OLTL", "All") === true);
}

// Dangling referrals are counted, not dropped.
{
  const n = R.danglingReferrals(
    [{ id: "x", partnerId: "gone", status: "won", value: 1, ago: 1 }, { id: "y", partnerId: "here", status: "won", value: 1, ago: 1 }],
    [{ id: "here" }],
  );
  ok("one referral points at a deleted partner", n === 1, n);
}

// ── A2 · WHOLE NUMBERS, FILTERED DETAIL ────────────────────────────────────
//
// 🔴 THE POINT OF THE `visible` FLAG IS THAT THE ARITHMETIC IGNORES IT. If any
// aggregate honoured it, two people would see different win rates under one
// label — the exact failure the design exists to avoid. So this asserts that
// every total is unchanged by the flag, and that only `shown` moves.
console.log("\nA2 · WHOLE TOTALS, FILTERED DRILL-DOWN");
{
  const P = { id: "s1", org: "Riddle", email: "", phone: "", cat: "Hospital discharge",
              tier: "A", division: "OLTL", owner: "Chris", ownerId: "u1", notes: "",
              lastTouch: 20 };
  const refs = [
    { id: "o1", partnerId: "s1", status: "won",  value: 6000, ago: 10,  visible: true  },
    { id: "o2", partnerId: "s1", status: "won",  value: 3400, ago: 40,  visible: false },
    { id: "o3", partnerId: "s1", status: "lost", value: 0,    ago: 80,  visible: false },
    { id: "o4", partnerId: "s1", status: "open", value: 5000, ago: 200, visible: true  },
  ];
  const whole = R.enrichPartner(P, refs);
  // The same partner as seen by someone who may see everything.
  const asAdmin = R.enrichPartner(P, refs.map((o) => ({ ...o, visible: true })));

  ok("refs is whole", whole.refs === 4, whole.refs);
  ok("won is whole (2, one of them withheld)", whole.won === 2, whole.won);
  ok("revenue is whole ($9,400/mo)", whole.revenue === 9400, whole.revenue);
  ok("winRate is whole (2/4 = 50%)", whole.winRate === 50, whole.winRate);
  // ago 10, 40 and 80 are all inside 90 — only o4 (200) is outside it.
  ok("refs90 is whole (3 of 4 inside 90 days)", whole.refs90 === 3, whole.refs90);
  ok("lastRefAgo is whole", whole.lastRefAgo === 10, whole.lastRefAgo);
  ok(
    "🔴 EVERY aggregate is identical for a viewer who sees all of them",
    ["refs", "refs90", "won", "revenue", "winRate", "lastRefAgo", "priority", "cadence"].every(
      (k) => whole[k] === asAdmin[k],
    ),
    ["restricted", whole, "admin", asAdmin],
  );
  ok("only `shown` differs — 2 of 4", whole.shown === 2 && asAdmin.shown === 4,
     [whole.shown, asAdmin.shown]);

  // And the KPI roll-up across partners is equally blind to the flag.
  const kWhole = R.partnerKpis([whole]);
  const kAdmin = R.partnerKpis([asAdmin]);
  ok(
    "partnerKpis ignores the flag too",
    JSON.stringify(kWhole) === JSON.stringify(kAdmin),
    [kWhole, kAdmin],
  );
}

// ── B. ghlSearchContacts against a fake GoHighLevel ────────────────────────
console.log("\nB · ghlSearchContacts — A REAL REQUEST, A REAL REPLY");

let MODE = "good";
const seen = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const sent = body ? JSON.parse(body) : {};
    seen.push({ url: req.url, sent });
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.url === "/contacts/search") {
      if (MODE === "reject")
        return json(422, { message: "filters[0].field must be a valid field", traceId: "trace-xyz" });
      const partner = {
        id: "c1",
        contactName: "Riddle Hospital",
        email: "dp@riddle.test",
        phone: "+14845550142",
        assignedTo: "u1",
        customFields: [
          { id: "RT", value: "Referral Partner" },
          { id: "CAT", value: "Hospital discharge" },
        ],
      };
      const stranger = {
        id: "c2",
        contactName: "Someone Else",
        customFields: [{ id: "RT", value: "Client" }],
      };
      // MODE "ignored" = a 200 carrying every contact in the account, which is
      // what an ignored filter actually looks like from here.
      return json(200, {
        contacts: MODE === "ignored" ? [stranger] : [partner],
        total: 1,
      });
    }
    json(404, { message: "not found" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
process.env.GHL_API_BASE = `http://127.0.0.1:${port}`;
process.env.GHL_LOCATION_ID = process.env.GHL_LOCATION_ID || "loc_test";
process.env.GHL_API_KEY = process.env.GHL_API_KEY || "key_test";

const G = await import("../lib/ghl.ts");

// 1 — the happy path.
try {
  const r = await G.ghlSearchContacts("RT", "Referral Partner");
  ok("returns the matching contact", r.rows.length === 1 && r.rows[0].id === "c1", r.rows);
  ok("  name, email, phone and owner are carried", r.rows[0].name === "Riddle Hospital" && r.rows[0].email === "dp@riddle.test" && r.rows[0].assignedTo === "u1", r.rows[0]);
  ok("  custom fields become a map", r.rows[0].fields.CAT === "Hospital discharge", r.rows[0].fields);
  const sent = seen[seen.length - 1].sent;
  ok("  the request filtered on customFields.RT", sent.filters?.[0]?.field === "customFields.RT" && sent.filters[0].value === "Referral Partner", sent.filters);
  ok("  and did not silently page for ever", sent.pageLimit === 100, sent.pageLimit);
} catch (e) {
  ok("happy path does not throw", false, String(e));
}

// 2 — GoHighLevel REJECTS the filter shape. The error must name the request.
MODE = "reject";
try {
  await G.ghlSearchContacts("RT", "Referral Partner");
  ok("a 422 throws rather than returning []", false, "did not throw");
} catch (e) {
  const msg = `${e.message} ${e.detail || ""}`;
  ok("a 422 throws rather than returning []", true);
  ok("  the message says the search was refused", /refused the contact search/i.test(e.message), e.message);
  ok("  the exact request sent is in the detail", /customFields\.RT/.test(msg), msg.slice(0, 160));
  ok("  it names the one file to change", /ghlSearchContacts/.test(msg), msg.slice(0, 160));
}

// 3 — 🔴 THE DANGEROUS ONE. A 200 carrying every contact in the account,
// because the filter was ignored. Returning [] here would have drawn a
// believable, empty dashboard; returning the rows would have called every
// client a referral partner.
MODE = "ignored";
try {
  const r = await G.ghlSearchContacts("RT", "Referral Partner");
  ok("an ignored filter does NOT return rows", false, r.rows);
} catch (e) {
  const msg = `${e.message} ${e.detail || ""}`;
  ok("an ignored filter throws instead of returning []", true);
  ok("  it says the filter was not applied", /did not apply the filter/i.test(e.message), e.message);
  ok("  it reports what did come back", /RT/.test(msg) && /1 contact/.test(msg), msg.slice(0, 200));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
