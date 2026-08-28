#!/usr/bin/env node
/**
 * ITEM 1 — settles the Transferred Date question with evidence, not theory.
 *
 * Three things a green build and a 200 response cannot tell you:
 *   A. how many opportunity custom fields are named "Transferred Date" /
 *      "Transferred From" (a NAME COLLISION makes every write land on the wrong
 *      field, which looks exactly like the value being dropped)
 *   B. what a DATE field actually stores for each candidate format, one write
 *      per format, read back each time
 *   C. whether a DATE entry survives when it rides the SAME customFields array
 *      as the other transfer stamps — the exact shape Move sends
 *
 *   $env:GHL_PIT="pit-..."
 *   $env:OPP_ID="<a TEST opportunity id>"
 *   node scripts/date-write-probe.mjs
 *
 * This performs REAL writes to the Transferred From / Transferred Date /
 * Transfer Reason fields on that opportunity. Use a test record.
 * It never changes the owner, pipeline or stage.
 */
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
const OPP = (process.env.OPP_ID || "").trim();

if (!TOKEN || !OPP) {
  console.error("Set GHL_PIT and OPP_ID.");
  process.exit(1);
}
const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };
const J = { ...H, "Content-Type": "application/json" };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Read a custom field's stored value under ANY key GHL might use for it.
const cfRaw = (cf) => {
  for (const k of ["fieldValueArray", "fieldValueString", "fieldValue", "value"])
    if (cf?.[k] !== undefined && cf?.[k] !== null) return cf[k];
  for (const [k, v] of Object.entries(cf || {}))
    if (k.startsWith("fieldValue") && v !== undefined && v !== null && v !== "")
      return `${v}   << under the unexpected key "${k}"`;
  return "";
};

const getOpp = async () => {
  const r = await fetch(`${BASE}/opportunities/${OPP}`, { headers: H });
  const b = await j(r);
  return b.opportunity ?? b;
};
const readField = async (id) => {
  const o = await getOpp();
  const hit = (o.customFields || []).find((c) => c.id === id);
  return hit ? cfRaw(hit) : "(field absent from the response entirely)";
};

const put = async (body) => {
  const r = await fetch(`${BASE}/opportunities/${OPP}`, {
    method: "PUT", headers: J, body: JSON.stringify(body),
  });
  return { status: r.status, body: await j(r) };
};

(async () => {
  // ---- A. name collisions --------------------------------------------------
  const defsRes = await fetch(
    `${BASE}/locations/${LOC}/customFields?model=opportunity`, { headers: H },
  );
  const defs = (await j(defsRes)).customFields || [];
  console.log(`\n=== A. FIELD DEFINITIONS (${defs.length} opportunity custom fields) ===`);
  for (const want of ["Transferred Date", "Transferred From", "Transfer Reason"]) {
    const hits = defs.filter((d) => norm(d.name) === norm(want));
    console.log(`\n"${want}" -> ${hits.length} match(es)${hits.length > 1 ? "   *** COLLISION — writes land on the FIRST ***" : ""}`);
    for (const h of hits)
      console.log(`   ${h.id}  dataType=${h.dataType}  folder=${h.parentId ?? "—"}  position=${h.position ?? "—"}`);
  }
  const dateDef = defs.find((d) => norm(d.name) === norm("Transferred Date"));
  const fromDef = defs.find((d) => norm(d.name) === norm("Transferred From"));
  const reasonDef = defs.find((d) => norm(d.name) === norm("Transfer Reason"));
  if (!dateDef) { console.error("\nNo 'Transferred Date' field — stopping."); process.exit(1); }

  const before = await readField(dateDef.id);
  console.log(`\nBEFORE  Transferred Date (${dateDef.id}) = ${JSON.stringify(before)}`);

  // ---- B. one format per write, read back each time ------------------------
  const now = new Date();
  const formats = [
    ["bare date      ", now.toISOString().slice(0, 10)],
    ["full ISO (Z)   ", now.toISOString()],
    ["ISO at midday  ", `${now.toISOString().slice(0, 10)}T12:00:00.000Z`],
    ["epoch millis   ", now.getTime()],
  ];
  console.log(`\n=== B. DATE FORMATS, ALONE ===`);
  for (const [label, value] of formats) {
    const res = await put({ customFields: [{ id: dateDef.id, value }] });
    await new Promise((r) => setTimeout(r, 800));
    const after = await readField(dateDef.id);
    console.log(
      `${label} sent ${JSON.stringify(value)}  ->  HTTP ${res.status}  ->  stored ${JSON.stringify(after)}` +
      (String(after) ? "" : "   *** DROPPED ***"),
    );
  }

  // ---- C. the exact array Move sends --------------------------------------
  console.log(`\n=== C. THE SAME ARRAY MOVE SENDS (From + Date + Reason together) ===`);
  const opts = (fromDef?.picklistOptions || fromDef?.options || [])
    .map((o) => (typeof o === "string" ? o : o?.value ?? o?.name ?? o?.label ?? ""))
    .filter(Boolean);
  const combined = [];
  if (fromDef && opts.length) combined.push({ id: fromDef.id, value: opts[0] });
  combined.push({ id: dateDef.id, value: new Date().toISOString() });
  if (reasonDef) combined.push({ id: reasonDef.id, value: `probe ${now.toISOString()}` });

  console.log(`SENT: ${JSON.stringify(combined, null, 2)}`);
  const res = await put({ customFields: combined });
  console.log(`HTTP ${res.status}`);
  const returned =
    res.body?.opportunity?.customFields ?? res.body?.customFields ?? null;
  console.log(
    returned
      ? `RESPONSE carried ${returned.length} customFields`
      : "RESPONSE carried NO customFields (nothing to verify against in-band)",
  );
  await new Promise((r) => setTimeout(r, 1000));
  console.log(`\nREAD BACK:`);
  for (const s of combined) {
    const name = defs.find((d) => d.id === s.id)?.name || s.id;
    const stored = await readField(s.id);
    const ok = String(stored).slice(0, 10) === String(s.value).slice(0, 10);
    console.log(`  ${ok ? "✓" : "✗"} ${name} (${s.id})\n      sent   ${JSON.stringify(s.value)}\n      stored ${JSON.stringify(stored)}`);
  }
  console.log(
    `\nIf B shows a format storing fine ALONE but C shows Date empty, GoHighLevel is\n` +
    `dropping the entry only when it rides with the others — that is the answer, and\n` +
    `Move must then write the date in its own PUT.\n`,
  );
})();
