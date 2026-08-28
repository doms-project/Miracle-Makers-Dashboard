#!/usr/bin/env node
/**
 * Round 23 — the checks I cannot run from here (no network egress to GHL).
 * READ-ONLY except section D, which is opt-in via CREATE_TEST=1.
 *
 *   $env:GHL_PIT="pit-..."
 *   $env:OPP_ID="<a test opportunity id>"     # for B and C
 *   node scripts/round23-probe.mjs
 *
 * A. SCOPES   — does the PIT hold users.readonly and contacts.write?
 *               (item 3 needs contacts.write; item 1's stamp needs users.readonly)
 * B. DATES    — read every DATE custom field on OPP_ID and show which key each
 *               value came back under (proves fieldValueDate end to end)
 * C. DUPES    — list the contact's cases per pipeline, which is exactly what the
 *               Move dialog and Add Client grey out (items 3 and 5)
 * D. CREATE   — opt-in: create a throwaway contact to prove contacts.write,
 *               then tell you the id so you can delete it in GHL.
 */
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
const OPP = (process.env.OPP_ID || "").trim();

if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }
const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };
const J = { ...H, "Content-Type": "application/json" };
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const get = (p) => fetch(`${BASE}${p}`, { headers: H });
const post = (p, b) => fetch(`${BASE}${p}`, { method: "POST", headers: J, body: JSON.stringify(b) });

// Which key did this value arrive under? That was the whole Transferred Date bug.
const cfKeyAndValue = (cf) => {
  for (const k of ["fieldValueArray", "fieldValueDate", "fieldValueString", "fieldValue", "value"])
    if (cf?.[k] !== undefined && cf?.[k] !== null && cf?.[k] !== "") return [k, cf[k]];
  for (const [k, v] of Object.entries(cf || {}))
    if (k.startsWith("fieldValue") && v !== undefined && v !== null && v !== "") return [`${k} (UNKNOWN)`, v];
  return ["(empty)", ""];
};

(async () => {
  // ---- A. scopes ----------------------------------------------------------
  console.log("=== A. PIT SCOPES ===");
  const users = await get(`/users/?locationId=${LOC}`);
  const ub = await j(users);
  console.log(
    users.status === 200
      ? `✓ users.readonly    — ${(ub.users || []).length} users. The access map validates, Move can verify owners, notes get an author.`
      : `✗ users.readonly    — HTTP ${users.status}. The access map is skipped (grants kept, not wiped), Move notes get no [DIVISION], transfers cannot verify the new owner.`,
  );
  const cf = await get(`/locations/${LOC}/customFields?model=opportunity`);
  const cfb = await j(cf);
  console.log(
    cf.status === 200
      ? `✓ customFields      — ${(cfb.customFields || []).length} opportunity fields.`
      : `✗ customFields      — HTTP ${cf.status}. No stamps, no Division, no panel editors.`,
  );
  const cvs = await get(`/locations/${LOC}/customValues`);
  console.log(
    cvs.status === 200
      ? `✓ customValues      — the pipeline access map is readable.`
      : `✗ customValues      — HTTP ${cvs.status}. Access falls back to PIPELINE_ACCESS_MAP.`,
  );
  // contacts.write can't be read-tested; the search endpoint at least proves
  // contacts.readonly, and section D proves write for real.
  const search = await post("/contacts/search", { locationId: LOC, page: 1, pageLimit: 1, query: "a" });
  console.log(
    search.status === 200
      ? `✓ contacts.readonly — search works, so Add Client's duplicate check works.`
      : `✗ contacts.readonly — HTTP ${search.status}. Add Client cannot warn about duplicates.`,
  );
  console.log(
    `· contacts.write    — not readable. Run with CREATE_TEST=1 to prove it (section D).\n` +
    `                      Note: Add Client uses the SAME POST /contacts/upsert the bulk\n` +
    `                      importer uses, so if Import has ever created a contact, it is there.`,
  );

  if (!OPP) { console.log("\nSet OPP_ID to run B and C."); return finish(); }

  // ---- B. dates -----------------------------------------------------------
  const ob = await j(await get(`/opportunities/${OPP}`));
  const opp = ob.opportunity ?? ob;
  const defs = cfb.customFields || [];
  const byId = new Map(defs.map((d) => [d.id, d]));
  console.log(`\n=== B. DATE FIELDS ON "${opp.name || OPP}" ===`);
  const dates = (opp.customFields || []).filter((c) => (byId.get(c.id)?.dataType || "").toUpperCase() === "DATE");
  if (!dates.length) console.log("(no DATE custom fields carry a value on this record)");
  for (const c of dates) {
    const [key, val] = cfKeyAndValue(c);
    console.log(`  ${(byId.get(c.id)?.name || c.id).padEnd(34)} ${String(val).padEnd(30)} under "${key}"`);
  }
  console.log(
    `\n  Every one of these should say "fieldValueDate". If any says UNKNOWN, tell me\n` +
    `  the key — it is the same class of bug and the reader needs it added.`,
  );

  // The open question from item 1: do the two "…Date and Time" fields actually
  // carry a time, or is GHL storing them as plain dates like the other eight?
  console.log(`\n=== B2. EVERY DATE FIELD DEFINED (not just the ones with a value) ===`);
  const valueById = new Map((opp.customFields || []).map((c) => [c.id, c]));
  for (const d of defs.filter((x) => (x.dataType || "").toUpperCase() === "DATE")) {
    const [key, val] = cfKeyAndValue(valueById.get(d.id));
    const t = val ? new Date(Number(val) || Date.parse(String(val))) : null;
    const time = t && !isNaN(t) ? t.toISOString().slice(11, 19) : "";
    console.log(
      `  ${d.name.padEnd(34)} ${String(val || "(unset)").padEnd(18)} ${key.padEnd(18)} ${
        time && time !== "00:00:00" && time !== "12:00:00" ? `TIME=${time}` : "(no time)"
      }`,
    );
  }
  console.log(
    `\n  ANSWERED — a real write settled this: PUT "2026-08-28T14:30:00.000Z" to\n` +
    `  AAA In Person Date and Time (ZP7MF2LO3ws4jzYbrTJx) reads back as "2026-08-28".\n` +
    `  A GHL DATE field CANNOT hold a time; the two field NAMES are misleading, not\n` +
    `  the code. Every DATE editor in the panel is date-only, and the two fields whose\n` +
    `  names promise a time now say so. Expect every row below to read (no time).`,
  );

  // ---- C. duplicates ------------------------------------------------------
  const contactId = opp.contactId || opp.contact?.id || "";
  if (contactId) {
    const pb = await j(await get(`/opportunities/pipelines?locationId=${LOC}`));
    const pname = new Map((pb.pipelines || []).map((p) => [p.id, p.name]));
    const sb = await j(await get(`/opportunities/search?location_id=${LOC}&contact_id=${contactId}&limit=100`));
    console.log(`\n=== C. THIS CONTACT'S CASES (drives the greyed-out pipelines) ===`);
    for (const o of sb.opportunities || [])
      console.log(`  ${o.id === OPP ? "→" : " "} ${(pname.get(o.pipelineId) || o.pipelineId).padEnd(24)} ${o.name || ""}`);
    console.log(
      `\n  Every pipeline listed above (except the one marked →) must appear DISABLED in\n` +
      `  the Move dialog, with "already has a case for this client" beside it.`,
    );
  }

  // ---- D. contacts.write --------------------------------------------------
  if (process.env.CREATE_TEST === "1") {
    console.log(`\n=== D. contacts.write ===`);
    const stamp = Date.now();
    const res = await post("/contacts/upsert", {
      locationId: LOC,
      firstName: "ZZTest",
      lastName: `Probe${stamp}`,
      email: `zztest.probe.${stamp}@example.invalid`,
      source: "round23-probe",
    });
    const body = await j(res);
    console.log(
      res.status < 300
        ? `✓ contacts.write — created contact ${body.contact?.id}. DELETE IT in GoHighLevel.`
        : `✗ contacts.write — HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}\n  Add Client will fail at step 1 without this scope.`,
    );
  }
  finish();
})();

function finish() {
  console.log(
    `\n--- then, in the app, one Move and one Add Client ---\n` +
    `  Move  : the response now carries "actorDivision". "OLTL" = the stamp works.\n` +
    `          "" = the admin case — decide what an admin's note should read.\n` +
    `          Watch that the panel CLOSES and Transferred Date now DISPLAYS.\n` +
    `  Panel : set IEB Phone Appointment Date, reload, confirm it holds.\n` +
    `  Add   : create a client into a pipeline the contact already occupies —\n` +
    `          the option must be greyed out BEFORE submit, not error after.\n`,
  );
}
