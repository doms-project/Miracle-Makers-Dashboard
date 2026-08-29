#!/usr/bin/env node
/**
 * SETTLES ONE QUESTION, WITH ONE WRITE:
 *
 *   When you POST a relation with firstRecordId = A and secondRecordId = B,
 *   does GoHighLevel store it that way — or does it reorder the slots itself?
 *
 * That is the whole disagreement. The dashboard's create path puts the
 * OPPORTUNITY'S CONTACT in firstRecordId, which the association labels
 * "Caregiver". In the intended flow (open a client's case, add their caregiver)
 * that would store the client in the caregiver slot. But the one real relation
 * in the account audits as OK, which has two possible explanations that demand
 * OPPOSITE fixes:
 *
 *   A. GHL normalises the slots on create -> the code is fine, leave it alone.
 *   B. GHL stores exactly what you send, and that link happened to be made from
 *      the CAREGIVER's record, so the roles were reversed by the user's action
 *      and landed correctly by accident -> the code IS inverted for the normal
 *      flow and must be fixed.
 *
 * This tells you which, without interpretation.
 *
 *   $env:GHL_PIT="pit-..."
 *   $env:CAREGIVER_ASSOCIATION_ID="6a90455aa6611a60576d1ecc"
 *   $env:FIRST_ID="<contact A>"      # sent as firstRecordId
 *   $env:SECOND_ID="<contact B>"     # sent as secondRecordId
 *   node scripts/relation-slot-order-probe.mjs
 *
 * Use TWO THROWAWAY TEST CONTACTS that are not already linked. The probe
 * creates one relation and DELETES it again (set KEEP=1 to leave it).
 */
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
const ASSOC = (process.env.CAREGIVER_ASSOCIATION_ID || "").trim();
const A = (process.env.FIRST_ID || "").trim();
const B = (process.env.SECOND_ID || "").trim();
const KEEP = process.env.KEEP === "1";

if (!TOKEN || !ASSOC || !A || !B) {
  console.error("Set GHL_PIT, CAREGIVER_ASSOCIATION_ID, FIRST_ID and SECOND_ID.");
  process.exit(1);
}
if (A === B) { console.error("FIRST_ID and SECOND_ID must differ."); process.exit(1); }

const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };
const J = { ...H, "Content-Type": "application/json" };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const nameOf = async (id) => {
  try {
    const b = await j(await fetch(`${BASE}/contacts/${id}`, { headers: H }));
    const c = b.contact || {};
    return (c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || id).trim();
  } catch { return id; }
};

(async () => {
  const def = await j(await fetch(`${BASE}/associations/${ASSOC}`, { headers: H }));
  const a = def.association ?? def;
  console.log(`\n=== DEFINITION ===`);
  console.log(`  firstRecordId  -> "${a.firstObjectLabel ?? "?"}"`);
  console.log(`  secondRecordId -> "${a.secondObjectLabel ?? "?"}"`);

  const [an, bn] = await Promise.all([nameOf(A), nameOf(B)]);
  console.log(`\n=== SENDING ===`);
  console.log(`  firstRecordId  = ${A}  (${an})`);
  console.log(`  secondRecordId = ${B}  (${bn})`);

  const res = await fetch(`${BASE}/associations/relations`, {
    method: "POST", headers: J,
    body: JSON.stringify({ locationId: LOC, associationId: ASSOC, firstRecordId: A, secondRecordId: B }),
  });
  const created = await j(res);
  if (!res.ok) {
    console.error(`\n✗ create failed (${res.status}): ${JSON.stringify(created).slice(0, 400)}`);
    process.exit(1);
  }
  const rid = String(created.relation?.id ?? created.id ?? "");
  console.log(`\n  created relation ${rid}`);

  // Read it back from the record's own relations list — the same endpoint the
  // dashboard reads, so this reflects what the app will actually see.
  await new Promise((r) => setTimeout(r, 800));
  const params = new URLSearchParams({ locationId: LOC, skip: "0", limit: "100" });
  const back = await j(await fetch(`${BASE}/associations/relations/${A}?${params}`, { headers: H }));
  const row = (back.relations || []).find(
    (r) => String(r.id ?? r._id ?? r.relationId ?? "") === rid,
  );

  console.log(`\n=== STORED ===`);
  if (!row) {
    console.log("  could not read the relation back — inconclusive.");
  } else {
    const sf = String(row.firstRecordId ?? "");
    const ss = String(row.secondRecordId ?? "");
    console.log(`  firstRecordId  = ${sf}  (${sf === A ? an : bn})`);
    console.log(`  secondRecordId = ${ss}  (${ss === A ? an : bn})`);
    console.log(`\n=== ANSWER ===`);
    if (sf === A && ss === B) {
      console.log(
        `  PRESERVED. GoHighLevel stores exactly what you send.\n` +
        `  => Explanation B. The dashboard puts the OPPORTUNITY'S CONTACT in the\n` +
        `     "${a.firstObjectLabel ?? "first"}" slot, so opening a CLIENT's case and adding their\n` +
        `     caregiver stores the client in the caregiver slot. The one relation that\n` +
        `     audits OK was made from the CAREGIVER's record and landed right by accident.\n` +
        `     THE WRITE NEEDS FIXING. Re-apply the swap in createCaregiverRelation.`,
      );
    } else if (sf === B && ss === A) {
      console.log(
        `  REORDERED. GoHighLevel normalised the slots itself.\n` +
        `  => Explanation A. What the dashboard sends does not decide what is stored,\n` +
        `     the existing data is correct, and report 29's inversion claim was WRONG.\n` +
        `     LEAVE createCaregiverRelation ALONE.`,
      );
    } else {
      console.log(`  Unexpected: neither order matches. Send me this output.`);
    }
  }

  if (rid && !KEEP) {
    const del = await fetch(`${BASE}/associations/relations/${rid}?locationId=${LOC}`, { method: "DELETE", headers: H });
    console.log(`\n  cleanup: ${del.ok ? `deleted ${rid}` : `DELETE failed (${del.status}) — remove ${rid} by hand`}`);
  } else if (KEEP) {
    console.log(`\n  KEEP=1 — relation ${rid} left in place. Delete it yourself.`);
  }
})();
