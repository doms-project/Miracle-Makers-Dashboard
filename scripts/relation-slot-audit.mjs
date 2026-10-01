// ---------------------------------------------------------------------------
// ROUND 170 — HOW MANY EXISTING CAREGIVER LINKS ARE REVERSED.
//
// 🔴 READ-ONLY. It makes GET requests and nothing else. There is no write path
// in this file, deliberately: the owner's instruction is "report how many, and
// propose how to correct them; don't change existing links without approval",
// and a script that COULD write is a script somebody runs with the wrong flag.
//
// ⚠️ WHAT "REVERSED" MEANS HERE. The association has two slots, labelled by
// GoHighLevel itself (`getAssociationDirection` reads them). A link is reversed
// when the contact sitting in the CAREGIVER slot is not a caregiver — decided by
// that contact's own `Record Type` field, which is the same test
// `searchCaregiverContacts` uses to populate the picker.
//
// 🔴 AND A CONTACT WHOSE Record Type CANNOT BE READ IS COUNTED SEPARATELY, NOT
// GUESSED. "Unknown" is its own bucket. A contact with no Record Type at all is
// neither evidence of a reversed link nor of a correct one, and folding it into
// either number is how an audit becomes a number nobody can act on.
//
// Run:  GHL_PIT=… GHL_LOCATION_ID=… CAREGIVER_ASSOCIATION_ID=… \
//       npx tsx scripts/relation-slot-audit.mjs
// ---------------------------------------------------------------------------
const BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";
const PIT = process.env.GHL_PIT || "";
const LOC = process.env.GHL_LOCATION_ID || "";
const ASSOC = process.env.CAREGIVER_ASSOCIATION_ID || "";

if (!PIT || !LOC || !ASSOC) {
  console.error(
    "Set GHL_PIT, GHL_LOCATION_ID and CAREGIVER_ASSOCIATION_ID.\n" +
      "This script only READS — it never writes a relation.",
  );
  process.exit(2);
}

const H = {
  Authorization: `Bearer ${PIT}`,
  Version: "2021-07-28",
  Accept: "application/json",
};

// ⚠️ ONE AT A TIME, WITH A PAUSE. The budget on this account is 100 requests
// per 10 seconds and round 152 produced 13,851 timeouts by ignoring it. An
// audit that takes two minutes is fine; one that trips the limit is not.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
async function get(path) {
  if (++calls % 20 === 0) await sleep(2500);
  const res = await fetch(`${BASE}${path}`, { headers: H });
  if (!res.ok) throw new Error(`${res.status} ${path} — ${await res.text()}`);
  return res.json();
}

// ── which slot is the caregiver? GoHighLevel's own labels ──────────────────
const assoc = await get(`/associations/${encodeURIComponent(ASSOC)}`);
const a = assoc.association ?? assoc;
const firstLabel = String(a.firstObjectLabel ?? "");
const secondLabel = String(a.secondObjectLabel ?? "");
const firstIsCaregiver = /caregiver/i.test(firstLabel)
  ? true
  : /caregiver/i.test(secondLabel)
    ? false
    : true;
console.log(`association  first="${firstLabel}" second="${secondLabel}"`);
console.log(`             caregiver slot = ${firstIsCaregiver ? "FIRST" : "SECOND"}\n`);

// ── every caregiver contact, so we know who IS one ─────────────────────────
// 🔴 BUILT FROM THE CONTACTS, NOT FROM THE RELATIONS. Asking "is the contact in
// the caregiver slot a caregiver" requires an independent answer to "who is a
// caregiver", and the relation cannot supply it — that is the thing under test.
const caregiverIds = new Set();
const recordTypeOf = new Map();
let page = 1;
for (;;) {
  const body = {
    locationId: LOC,
    page,
    pageLimit: 100,
    filters: [],
  };
  const res = await fetch(`${BASE}/contacts/search`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} /contacts/search — ${await res.text()}`);
  const data = await res.json();
  const rows = data.contacts || [];
  for (const c of rows) {
    const id = String(c.id ?? c.contactId ?? "");
    if (!id) continue;
    let rt = "";
    for (const f of Array.isArray(c.customFields) ? c.customFields : []) {
      const v = String(f?.value ?? f?.fieldValueString ?? "");
      if (/^(caregiver|referral partner|event attendee)$/i.test(v)) { rt = v; break; }
    }
    recordTypeOf.set(id, rt);
    if (/caregiver/i.test(rt)) caregiverIds.add(id);
  }
  if (rows.length < 100) break;
  page += 1;
  if (page > 30) break; // 3,000 contacts is far past this account's size
}
console.log(`contacts read ${recordTypeOf.size} · Record Type "Caregiver" on ${caregiverIds.size}\n`);

// ── every relation, from the caregiver side ────────────────────────────────
const seen = new Set();
let ok = 0;
let reversed = 0;
let unknown = 0;
const reversedPairs = [];

for (const id of recordTypeOf.keys()) {
  let rels = [];
  try {
    const params = new URLSearchParams({ locationId: LOC, skip: "0", limit: "100" });
    const data = await get(`/associations/relations/${encodeURIComponent(id)}?${params}`);
    rels = data.relations || [];
  } catch {
    continue; // a contact with no relations 404s on some tenants
  }
  for (const r of rels) {
    if (String(r.associationId ?? "") !== ASSOC) continue;
    const rid = String(r.id ?? "");
    if (rid && seen.has(rid)) continue;
    if (rid) seen.add(rid);
    const first = String(r.firstRecordId ?? "");
    const second = String(r.secondRecordId ?? "");
    const inCaregiverSlot = firstIsCaregiver ? first : second;
    const inClientSlot = firstIsCaregiver ? second : first;
    const rtSlot = recordTypeOf.get(inCaregiverSlot);
    if (rtSlot === undefined || rtSlot === "") { unknown += 1; continue; }
    if (caregiverIds.has(inCaregiverSlot)) ok += 1;
    else {
      reversed += 1;
      reversedPairs.push({ relationId: rid, inCaregiverSlot, inClientSlot });
    }
  }
}

console.log("═══ RESULT ═══");
console.log(`  links read            ${seen.size}`);
console.log(`  ✅ correct            ${ok}   (a caregiver is in the caregiver slot)`);
console.log(`  🔴 reversed           ${reversed}   (a non-caregiver is in the caregiver slot)`);
console.log(`  ⚠️  Record Type unknown ${unknown}   (not counted either way — see the banner)`);
console.log(`  requests spent        ${calls}`);

if (reversedPairs.length) {
  console.log("\n═══ THE REVERSED ONES ═══");
  for (const p of reversedPairs)
    console.log(`  ${p.relationId}  caregiver-slot=${p.inCaregiverSlot}  client-slot=${p.inClientSlot}`);
  console.log(
    "\n🔴 HOW TO CORRECT THEM, AND WHY IT IS A DELETE-AND-RECREATE:\n" +
      "   GoHighLevel's relations API has no PUT — a relation's slots cannot be\n" +
      "   edited. Each of the above has to be DELETEd and POSTed back with the\n" +
      "   two ids swapped.\n" +
      "\n" +
      "   ⚠️ WHICH MEANS IT IS NOT ATOMIC, and that is the whole risk: between\n" +
      "   the delete and the create the link does not exist, and a failure in\n" +
      "   between loses it. So any correction run must\n" +
      "     1. write this list to a file FIRST, before touching anything;\n" +
      "     2. do one link at a time, recreating before moving on;\n" +
      "     3. re-read each new relation and confirm the slots before the next;\n" +
      "     4. stop on the first failure, leaving the list as the record of what\n" +
      "        is done and what is not.\n" +
      "\n" +
      "   ⚠️ AND NOTHING HERE DOES ANY OF THAT. This script only reads. The\n" +
      "   correction needs the owner's approval and its own round.",
  );
} else {
  console.log("\n✅ Nothing to correct.");
}
