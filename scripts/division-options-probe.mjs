// ---------------------------------------------------------------------------
// ROUND 130 — WHAT DOES `Partner Division` ACTUALLY HOLD ON THIS ACCOUNT?
//
// 🔴 THREE THINGS PRODUCE THE SAME SCREEN, and only the account can say which:
//
//   a  the field holds all four values (your script copied the main account's
//      options) → the switcher is CORRECT and the FIELD is what needs editing
//   b  the field is named something else → the name match misses, the list
//      comes back empty, and the built-in four are shown as a fallback
//   c  the field is not a dropdown → no options to read, same fallback
//
// ⚠️ (b) AND (c) ARE THE DANGEROUS ONES, because the fallback reproduces the
// bug exactly — the same shape as `firstStage` in round 126. v130 makes the
// switcher SAY which list it is showing; this says why.
//
// Run:  GHL_PIT=… GHL_LOCATION_ID=… node scripts/division-options-probe.mjs
//
// Read-only. One GET, nothing written.
// ---------------------------------------------------------------------------

const BASE = (process.env.GHL_API_BASE || "https://services.leadconnectorhq.com").replace(/\/$/, "");
const PIT = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "").trim();
if (!PIT || !LOC) {
  console.error("Set GHL_PIT and GHL_LOCATION_ID.");
  process.exit(1);
}

const res = await fetch(`${BASE}/locations/${encodeURIComponent(LOC)}/customFields?model=contact`, {
  headers: { Authorization: `Bearer ${PIT}`, Version: "2021-07-28", Accept: "application/json" },
});
if (!res.ok) {
  console.error(`GoHighLevel answered ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const all = (await res.json()).customFields || [];
console.log(`${all.length} contact custom field(s).\n`);

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const exact = all.find((f) => norm(f.name) === norm("Partner Division"));

console.log("── ANY FIELD WITH \"DIVISION\" IN ITS NAME ────────────────────────");
const near = all.filter((f) => /division/i.test(f.name || ""));
if (!near.length) console.log("   (none — that alone is the answer)");
for (const f of near) {
  const opts = f.picklistOptions || f.options || [];
  console.log(`   "${f.name}"  ${f.dataType}  id=${f.id}`);
  console.log(`      options: ${opts.length ? JSON.stringify(opts) : "(none — not a dropdown)"}`);
}

console.log("\n── WHAT THIS SETTLES ────────────────────────────────────────────");
if (!exact) {
  console.log("  🔴 CAUSE (b): no field is named exactly \"Partner Division\".");
  console.log("     The app matches by NAME, so the options list comes back empty");
  console.log("     and the switcher falls back to its built-in four.");
  if (near.length)
    console.log(`     Closest: ${near.map((f) => `"${f.name}"`).join(", ")} — rename it, or tell me`);
  console.log("     and I will widen the aliases the way the other fields have them.");
} else {
  const opts = exact.picklistOptions || exact.options || [];
  if (!opts.length) {
    console.log("  🔴 CAUSE (c): the field exists but is not a dropdown, so it has");
    console.log("     no options to read and the switcher falls back.");
    console.log(`     dataType is ${exact.dataType}; it needs to be a single-option field.`);
  } else {
    console.log(`  ✅ The field is a dropdown holding: ${JSON.stringify(opts)}`);
    const foreign = opts.filter((o) => !/^(odp|all)$/i.test(String(o)));
    if (foreign.length) {
      console.log(`  🔴 CAUSE (a): it genuinely contains ${JSON.stringify(foreign)}.`);
      console.log("     The switcher is showing exactly what the field says, which is");
      console.log("     correct behaviour — the FIELD is what needs editing, in");
      console.log("     GoHighLevel. Nothing in the app can or should second-guess it.");
    } else {
      console.log("  ✅ and it holds only this account's divisions, so a switcher");
      console.log("     still offering four is a build older than v128 — check the footer.");
    }
  }
}
