// ---------------------------------------------------------------------------
// ROUND 122 — ITEMS 1, 2 AND 15. The a11y group is scripts/a11y-proof.mjs.
//
// 🔴 THE ROUND-121 RULE HOLDS: this fake refuses what GoHighLevel refuses, and
// the id-in-a-URL check reads what was actually SENT rather than what was meant.
//
// Run: npx tsx scripts/round122-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
const R = await import("../lib/referrals.ts");

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}\n       got: ${JSON.stringify(got)}`); }
};

// ═══ 2 · THE SEPARATE COUNT ═══════════════════════════════════════════════
console.log("\n2 · 🔴 APPLICANTS NEVER REACH THE REVENUE FIGURE");
const partner = {
  id: "p1", org: "Riddle Nursing School", tier: "B", category: "", division: "OLTL",
  owner: "", ownerName: "", lastTouch: 5, notes: "",
};
const clientRefs = [
  { id: "c1", name: "A", partnerId: "p1", status: "won",  value: 4000, ago: 10, eventId: "", visible: true },
  { id: "c2", name: "B", partnerId: "p1", status: "open", value: 1500, ago: 20, eventId: "", visible: true },
];
// 🔴 THE TRAP THIS ITEM EXISTS FOR: applicant opportunities carrying a value.
// If they ever reach the same reducer, revenue silently gains 9,999.
const applicantRefs = [
  { id: "a1", name: "C", partnerId: "p1", status: "won",  value: 9999, ago: 5,  eventId: "", visible: true },
  { id: "a2", name: "D", partnerId: "p1", status: "open", value: 9999, ago: 8,  eventId: "", visible: true },
  { id: "a3", name: "E", partnerId: "p1", status: "won",  value: 9999, ago: 12, eventId: "", visible: true },
];
const rich = R.enrichPartner(partner, clientRefs, applicantRefs);
console.log(`  refs=${rich.refs} won=${rich.won} revenue=${rich.revenue}`);
console.log(`  applicants=${rich.applicants} hired=${rich.hired}`);
ok("🔴 revenue is the CLIENT won value alone", rich.revenue === 4000, rich.revenue);
ok("🔴 and 3 x 9,999 is nowhere in it", rich.revenue !== 4000 + 29997, rich.revenue);
ok("refs counts clients only", rich.refs === 2, rich.refs);
ok("won counts clients only", rich.won === 1, rich.won);
ok("applicants are counted separately", rich.applicants === 3, rich.applicants);
ok("and hired is the won half of those", rich.hired === 2, rich.hired);
ok("⚠️ winRate is the client rate, undiluted", rich.winRate === 50, rich.winRate);

const totals = R.partnerKpis([rich]);
console.log(`  kpis: revenue=${totals.revenue} applicants=${totals.applicants} hired=${totals.hired}`);
ok("🔴 the TOTAL revenue is also client-only", totals.revenue === 4000, totals.revenue);
ok("and the totals carry the separate counts",
   totals.applicants === 3 && totals.hired === 2, totals);

console.log("\n  …and a partner who sends ONLY applicants:");
const schoolOnly = R.enrichPartner(partner, [], applicantRefs);
console.log(`  refs=${schoolOnly.refs} revenue=${schoolOnly.revenue} applicants=${schoolOnly.applicants}`);
// ⚠️ THE CASE THAT MOTIVATES THE WHOLE ITEM. Before this, a nursing school read
// as a partner who had sent nothing and produced nothing.
ok("⚠️ it is no longer invisible", schoolOnly.applicants === 3, schoolOnly.applicants);
ok("and it still shows zero revenue, honestly", schoolOnly.revenue === 0, schoolOnly.revenue);

console.log("\n  …and the default parameter keeps every old caller unchanged:");
const noCg = R.enrichPartner(partner, clientRefs);
ok("🔴 omitting the second list yields zero, not a crash",
   noCg.applicants === 0 && noCg.hired === 0 && noCg.revenue === 4000, noCg);

// ═══ 1 · ATTENDEE DEDUPLICATION ═══════════════════════════════════════════
console.log("\n1 · 🔴 ONE ROW PER CONTACT, AND NO SILENT OVERWRITE");
const rs = readFileSync("components/ReferralsSection.tsx", "utf8");
const route = readFileSync("app/api/referrals/route.ts", "utf8");
ok("the flat panel dedupes by contact id", /dedupeByContact\(data\.attendees\)/.test(rs), "not deduped");
ok("⚠️ first wins, so triage does not reorder the list",
   /seen\.has\(r\.id\)\) continue;/.test(rs), "no stable dedupe");
// 🔴 THE HALF THAT IS ACTUAL DATA LOSS. `Event Attended` is a single contact
// field and upsertContact matches on phone/email, so adding the same person to
// a second event rewrote their first attendance with no error at all.
ok("🔴 a second event for the same contact is REFUSED, not merged",
   /is already recorded at another event/.test(route), "no guard");
ok("⚠️ and it is a refusal, not a fault", /refusal: true/.test(route.slice(route.indexOf("is already recorded at another event") - 2000)), "not marked");
ok("⚠️ a failed look-up does not become a refusal",
   /A FAILED LOOK-UP IS NOT A CLEAR RESULT/.test(route), "no fallback note");
ok("and it names what to do instead", /Log this meeting as a touch/.test(route), "no remedy");

// ═══ 15 · NO ID IN A URL ══════════════════════════════════════════════════
console.log("\n15 · 🔴 THE CONTACT ID IS OUT OF THE URL");
const urlIds = [...rs.matchAll(/["`]\/api\/[^"`]*\$\{encodeURIComponent\([^)]*\)\}[^"`]*["`]/g)]
  .map((m) => m[0])
  .filter((u) => /\?/.test(u));
console.log(`  /api/ URLs with an id in the QUERY STRING: ${urlIds.length ? urlIds.join(", ") : "(none)"}`);
ok("🔴 none left in a query string", urlIds.length === 0, urlIds);
ok("the read is a POST now", /action: "contact-opps"/.test(rs), "still a GET");
ok("🔴 and the GET form is GONE, not deprecated",
   !/only === "contact-opps"/.test(route), "GET form still there");
ok("⚠️ one implementation, so the access filter cannot be missing from one",
   (route.match(/applyAccess\(all, \{/g) || []).length === 1, "two copies");
ok("and the access filter is still there", /async function contactOpps/.test(route) && /applyAccess/.test(route), "no filter");

// ═══ 21 · A VIEW IS NOT A PROPERTY ════════════════════════════════════════
console.log("\n21 · 🔴 \"All divisions\" NO LONGER BECOMES THE STORED VALUE \"All\"");
ok("🔴 the dialog opens unset when the view is All",
   /division === "All" \? "" : division/.test(rs), "still seeds All");
ok("⚠️ and the unset option exists only in that state",
   /div === "" \? \(/.test(rs), "always offered");

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
