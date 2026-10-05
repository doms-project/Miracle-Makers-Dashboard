// ---------------------------------------------------------------------------
// ROUND 173 · ITEM 1 — THE PROBE. WHAT DOES A DUPLICATE REFUSAL TELL US?
//
// 🔴 IT WRITES. Two contacts, deliberately, because the question cannot be
// asked without one existing — and it prints their ids so they can be deleted.
// Nothing else in this repo's scripts folder creates anything; this one must,
// and it refuses to run without `I_UNDERSTAND_THIS_CREATES_CONTACTS=yes`.
//
// THREE QUESTIONS, IN THE ORDER THE FIX DEPENDS ON THEM:
//
//   1. Does `POST /contacts/` refuse a duplicate phone AT ALL, one second
//      after the first contact was created? (If it merged instead, the whole
//      approach is wrong and the report has to say so.)
//   2. Does the refusal BODY name the colliding contact — a `meta.contactId`
//      or anything like it? If yes, the 409 can name them with no extra call.
//   3. If not: does `GET /contacts/search/duplicate?number=` see a contact
//      created one second earlier? That is the instant-match route.
//
//   4. And the control: does `POST /contacts/search` (the index the old check
//      used) see it at one second? It must NOT, or the live failure would not
//      reproduce and this probe is measuring the wrong thing.
//
// Run:
//   I_UNDERSTAND_THIS_CREATES_CONTACTS=yes \
//   GHL_PIT=… GHL_LOCATION_ID=… PROBE_PHONE=+1484555XXXX \
//   npx tsx scripts/duplicate-refusal-probe.mjs
// ---------------------------------------------------------------------------
const BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const PIT = process.env.GHL_PIT || "";
const LOC = process.env.GHL_LOCATION_ID || "";
const PHONE = process.env.PROBE_PHONE || "";
const CONSENT = process.env.I_UNDERSTAND_THIS_CREATES_CONTACTS === "yes";

if (!PIT || !LOC || !PHONE || !CONSENT) {
  console.error(
    "This probe CREATES CONTACTS on the live account. It needs:\n" +
      "  I_UNDERSTAND_THIS_CREATES_CONTACTS=yes\n" +
      "  GHL_PIT, GHL_LOCATION_ID\n" +
      "  PROBE_PHONE  — a number nobody on the account has. The probe will\n" +
      "                 create one contact on it and then try to create a\n" +
      "                 second. It prints both ids for deletion.",
  );
  process.exit(2);
}

const H = {
  Authorization: `Bearer ${PIT}`,
  Version: "2021-07-28",
  Accept: "application/json",
  "Content-Type": "application/json",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = null; }
  return { status: res.status, raw, json };
}

const STAMP = Date.now();
const made = [];

console.log("═══ 1 · create the first contact ═══");
const first = await call("POST", "/contacts/", {
  locationId: LOC,
  firstName: "PROBE173",
  lastName: `Delete-${STAMP}`,
  phone: PHONE,
});
console.log(`  status ${first.status}`);
const firstId = String(first.json?.contact?.id || first.json?.id || "");
if (!firstId) {
  console.error(`  🔴 could not create the first contact: ${first.raw.slice(0, 400)}`);
  process.exit(1);
}
made.push(firstId);
console.log(`  created ${firstId}`);

// 🔴 ONE SECOND. The live failure happened at seven and did not at twelve, so
// one second is comfortably inside the window and is the honest worst case.
await sleep(1000);

console.log("\n═══ 2 · one second later, create a SECOND on the same phone ═══");
const second = await call("POST", "/contacts/", {
  locationId: LOC,
  firstName: "PROBE173B",
  lastName: `Delete-${STAMP}`,
  phone: PHONE,
});
console.log(`  status ${second.status}`);
console.log(`  body   ${second.raw.slice(0, 600)}`);
const secondId = String(second.json?.contact?.id || second.json?.id || "");
if (secondId && secondId !== firstId) made.push(secondId);

const refused = second.status >= 400;
console.log(`\n  Q1 does the create REFUSE a duplicate at 1s?   ${refused ? "✅ YES" : "🔴 NO"}`);
if (!refused && secondId === firstId)
  console.log("      ⚠️  it returned the EXISTING id — that is a merge, not a create.");
if (!refused && secondId && secondId !== firstId)
  console.log("      🔴 it created a SECOND contact. This account allows duplicates;\n" +
              "         the fix cannot rely on the refusal and the report must say so.");

// Q2 — does the body name the colliding contact?
const j = second.json || {};
const metaObj = j.meta || {};
const candidates = {
  "meta.contactId": metaObj.contactId,
  "meta.contact_id": metaObj.contact_id,
  "meta.contact.id": metaObj.contact?.id,
  contactId: j.contactId,
  contact_id: j.contact_id,
  "contact.id": j.contact?.id,
};
const named = Object.entries(candidates).filter(([, v]) => typeof v === "string" && v);
console.log(`  Q2 does the refusal NAME the contact?          ${named.length ? "✅ YES" : "🔴 NO"}`);
for (const [k, v] of named) console.log(`      ${k} = ${v}${v === firstId ? "  ← the right one" : "  ⚠️ NOT the first contact"}`);
if (!named.length)
  console.log(`      keys present: ${Object.keys(j).join(", ") || "(none)"}` +
              `${metaObj && Object.keys(metaObj).length ? ` · meta: ${Object.keys(metaObj).join(", ")}` : ""}`);

console.log("\n═══ 3 · the instant-match route, at ~1s old ═══");
const dupParams = new URLSearchParams({ locationId: LOC, number: PHONE });
const dup = await call("GET", `/contacts/search/duplicate?${dupParams}`);
console.log(`  status ${dup.status}`);
console.log(`  body   ${dup.raw.slice(0, 400)}`);
const dupId = String(dup.json?.contact?.id || "");
console.log(`  Q3 does the duplicate lookup see it?           ${dupId === firstId ? "✅ YES" : dupId ? "⚠️ a DIFFERENT contact" : "🔴 NO"}`);

console.log("\n═══ 4 · 🔴 THE CONTROL — the search index must NOT see it yet ═══");
const idx = await call("POST", "/contacts/search", {
  locationId: LOC, page: 1, pageLimit: 20, query: PHONE,
});
const seen = (idx.json?.contacts || []).some((c) => String(c.id) === firstId);
console.log(`  status ${idx.status} · ${(idx.json?.contacts || []).length} hit(s)`);
console.log(`  Q4 does the lagging index see it at 1s?        ${seen ? "⚠️ YES" : "✅ NO (as expected)"}`);
if (seen)
  console.log("      ⚠️  THEN THIS PROBE IS NOT MEASURING THE LIVE FAILURE. The index\n" +
              "         was fast this time; re-run it, and do not conclude the lag is gone\n" +
              "         from one fast read — the live overwrite happened at 7 seconds.");

console.log("\n═══ CLEAN UP ═══");
console.log("  Delete these contacts in GoHighLevel (the probe does not):");
for (const id of made) console.log(`    ${id}`);
console.log(`  Both are named "PROBE173… Delete-${STAMP}".`);
