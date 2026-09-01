// Settles ONE open question from item #10: does GoHighLevel's OPPORTUNITY
// SEARCH response embed the contact's TAGS?
//
// WHY THIS EXISTS. The Sent out card now says "Reassigned from X" instead of
// "Transferred from X" when the contact carries a `reassigned-from-*` tag. That
// tag is written by the reassign path (lib/ghl.ts, moveOpportunity), and the
// card reads it off `record.tags`, which is filled from `opp.contact.tags`.
//
// GoHighLevel's documented contact shape includes `tags`, but RawOpportunity
// never declared it and nothing in this codebase had ever read it — the same
// trap as lastStageChangeAt in report 42, where the brief said a value was
// "already in the API response" and it was true of GHL's response but not ours.
//
// If this account does NOT send contact tags on the search endpoint, the card
// degrades to the neutral "Transferred from" for every record (today's
// behaviour, no regression) and the tag has to be fetched another way.
//
// Run:  GHL_PIT=… GHL_LOCATION_ID=… PIPELINE_IDS=… node scripts/contact-tags-probe.mjs
//
// Read-only. It sends one GET and writes nothing.

const BASE = "https://services.leadconnectorhq.com";
const PIT = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "").trim();
const PIPE = (process.env.PIPELINE_IDS || "").split(/[,|\s]+/).filter(Boolean)[0];

if (!PIT || !LOC) {
  console.error("Set GHL_PIT and GHL_LOCATION_ID.");
  process.exit(1);
}

const params = new URLSearchParams({ location_id: LOC, limit: "100" });
if (PIPE) params.set("pipeline_id", PIPE);

const res = await fetch(`${BASE}/opportunities/search?${params}`, {
  headers: { Authorization: `Bearer ${PIT}`, Version: "2021-07-28", Accept: "application/json" },
});
if (!res.ok) {
  console.error(`HTTP ${res.status}`, (await res.text()).slice(0, 400));
  process.exit(1);
}
const body = await res.json();
const opps = body.opportunities || [];
console.log(`opportunities returned: ${opps.length}\n`);

const withContact = opps.filter((o) => o.contact);
const withTagsKey = withContact.filter((o) => "tags" in o.contact);
const withTags = withContact.filter((o) => Array.isArray(o.contact.tags) && o.contact.tags.length);

console.log(`have a contact object      : ${withContact.length}`);
console.log(`contact HAS a "tags" key   : ${withTagsKey.length}   <-- 0 means the card can never work this way`);
console.log(`contact has NON-EMPTY tags : ${withTags.length}\n`);

if (withContact[0]) console.log("contact keys present:", Object.keys(withContact[0].contact).join(", "), "\n");

const seen = new Map();
for (const o of withTags) for (const t of o.contact.tags) seen.set(t, (seen.get(t) || 0) + 1);
const move = [...seen.entries()].filter(([t]) => /^(transferred-to|reassigned-from)-/i.test(t));
console.log("MOVE-RELATED TAGS ON THIS ACCOUNT:");
console.log(move.length ? move.map(([t, n]) => `  ${t}  x${n}`).join("\n") : "  (none yet — expected until a reassign runs after this build ships)");

const both = withTags.filter((o) => {
  const t = o.contact.tags.map(String);
  return t.some((x) => /^transferred-to-/i.test(x)) && t.some((x) => /^reassigned-from-/i.test(x));
});
console.log(`\ncontacts carrying BOTH tag families: ${both.length}`);
console.log("(these are the ones the contact-scoped limit affects — a later plain");
console.log(" transfer of such a contact will still read as a reassign)");
