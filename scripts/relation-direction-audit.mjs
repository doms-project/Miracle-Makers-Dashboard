#!/usr/bin/env node
/**
 * Lists every caregiver_client relation for the contacts you name and judges the
 * stored direction against each contact's Record Type. Repairs nothing unless
 * you ask.
 *
 * ⚠️ THE WRITE PATH IS NOT KNOWN TO BE INVERTED. An earlier report claimed it
 * was; the first real audit contradicted that (a dashboard-created relation came
 * back OK). Run scripts/relation-slot-order-probe.mjs FIRST — it settles whether
 * GoHighLevel stores the slots as sent or reorders them. Until that is answered,
 * an INVERTED verdict here means "this row disagrees with the Record Types",
 * not "the dashboard wrote it backwards".
 *
 *   $env:GHL_PIT="pit-..."
 *   $env:CAREGIVER_ASSOCIATION_ID="6a90455aa6611a60576d1ecc"
 *   $env:CONTACT_IDS="id1,id2,..."     # contacts to inspect (clients and/or caregivers)
 *   node scripts/relation-direction-audit.mjs
 *
 * Add REPAIR=1 to fix the inverted ones. A relation cannot be edited in place,
 * so a repair is DELETE + re-CREATE the other way round: the relation id
 * changes, and anything referencing the old id stops matching. Read the report
 * first. These are HIPAA-scoped case records — nothing is rewritten by default.
 */
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
const ASSOC = (process.env.CAREGIVER_ASSOCIATION_ID || "").trim();
const IDS = (process.env.CONTACT_IDS || "").split(/[\s,]+/).filter(Boolean);
const REPAIR = process.env.REPAIR === "1";

if (!TOKEN || !ASSOC || !IDS.length) {
  console.error("Set GHL_PIT, CAREGIVER_ASSOCIATION_ID and CONTACT_IDS.");
  process.exit(1);
}
const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };
const J = { ...H, "Content-Type": "application/json" };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

const contactName = async (id) => {
  try {
    const b = await j(await fetch(`${BASE}/contacts/${id}`, { headers: H }));
    const c = b.contact || {};
    return (c.name || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || id).trim();
  } catch { return id; }
};
// Record Type is a contact custom field on this tenant; it's the only signal we
// have for what a contact actually IS, so it's how we judge a stored direction.
const recordType = async (id) => {
  try {
    const b = await j(await fetch(`${BASE}/contacts/${id}`, { headers: H }));
    const cf = b.contact?.customFields || [];
    for (const f of cf) {
      const v = String(f.value ?? f.fieldValue ?? f.fieldValueString ?? "");
      if (/caregiver/i.test(v)) return "caregiver";
      if (/client/i.test(v)) return "client";
    }
  } catch { /* unknown */ }
  return "";
};

(async () => {
  // 1. What the definition actually says.
  const def = await j(await fetch(`${BASE}/associations/${ASSOC}`, { headers: H }));
  const a = def.association ?? def;
  const first = String(a.firstObjectLabel ?? "?");
  const second = String(a.secondObjectLabel ?? "?");
  console.log(`\n=== ASSOCIATION ${ASSOC} ===`);
  console.log(`  firstRecordId  -> "${first}"`);
  console.log(`  secondRecordId -> "${second}"`);
  const firstIsCaregiver = /caregiver/i.test(first);
  if (!firstIsCaregiver && !/caregiver/i.test(second)) {
    console.error("  Neither label mentions 'caregiver' — stopping rather than guessing.");
    process.exit(1);
  }
  console.log(`  => the CAREGIVER belongs in ${firstIsCaregiver ? "firstRecordId" : "secondRecordId"}\n`);

  // 2. Every relation these contacts are in.
  const seen = new Set();
  const rows = [];
  for (const id of IDS) {
    const params = new URLSearchParams({ locationId: LOC, skip: "0", limit: "100" });
    const b = await j(await fetch(`${BASE}/associations/relations/${id}?${params}`, { headers: H }));
    for (const r of b.relations || []) {
      if (String(r.associationId ?? "") !== ASSOC) continue;
      const rid = String(r.id ?? r._id ?? r.relationId ?? "");
      if (seen.has(rid)) continue;
      seen.add(rid);
      rows.push({ rid, firstId: String(r.firstRecordId ?? ""), secondId: String(r.secondRecordId ?? "") });
    }
  }
  if (!rows.length) { console.log("No caregiver_client relations found for those contacts."); return; }

  // 3. Judge each stored direction against what the contacts actually are.
  console.log(`=== ${rows.length} RELATION(S) ===\n`);
  const inverted = [];
  for (const r of rows) {
    const [fn, sn, ft, st] = await Promise.all([
      contactName(r.firstId), contactName(r.secondId),
      recordType(r.firstId), recordType(r.secondId),
    ]);
    // Who SHOULD be in the caregiver slot, per Record Type.
    const caregiverSlotHolder = firstIsCaregiver ? ft : st;
    const clientSlotHolder = firstIsCaregiver ? st : ft;
    let verdict = "unknown (Record Type not set on one or both)";
    if (caregiverSlotHolder && clientSlotHolder) {
      if (caregiverSlotHolder === "caregiver" && clientSlotHolder === "client") verdict = "OK";
      else if (caregiverSlotHolder === "client" && clientSlotHolder === "caregiver") {
        verdict = "INVERTED";
        inverted.push(r);
      } else verdict = `odd (${caregiverSlotHolder} / ${clientSlotHolder})`;
    }
    console.log(`  ${verdict.padEnd(46)} relation ${r.rid}`);
    console.log(`     first  ${r.firstId}  ${fn}  [${ft || "type unknown"}]`);
    console.log(`     second ${r.secondId}  ${sn}  [${st || "type unknown"}]\n`);
  }

  console.log(`${inverted.length} of ${rows.length} stored backwards.`);
  if (!inverted.length) return;
  if (!REPAIR) {
    console.log(
      `\nRe-run with REPAIR=1 to fix them. A relation cannot be edited in place, so\n` +
      `each repair is DELETE + re-CREATE reversed — the relation id CHANGES.\n` +
      `Read the list above first.`,
    );
    return;
  }

  console.log("\nREPAIRING…");
  for (const r of inverted) {
    const del = await fetch(`${BASE}/associations/relations/${r.rid}?locationId=${LOC}`, { method: "DELETE", headers: H });
    if (!del.ok) { console.log(`  ✗ ${r.rid} delete failed (${del.status}) — left as is`); continue; }
    const res = await fetch(`${BASE}/associations/relations`, {
      method: "POST", headers: J,
      body: JSON.stringify({
        locationId: LOC, associationId: ASSOC,
        firstRecordId: r.secondId, secondRecordId: r.firstId,
      }),
    });
    const b = await j(res);
    console.log(
      res.ok
        ? `  ✓ ${r.rid} -> ${b.relation?.id ?? b.id ?? "(new id)"}`
        : `  ✗✗ ${r.rid} DELETED BUT NOT RECREATED (${res.status}): ${JSON.stringify(b).slice(0, 200)}\n       Re-link ${r.firstId} <-> ${r.secondId} by hand in GoHighLevel.`,
    );
  }
})();
