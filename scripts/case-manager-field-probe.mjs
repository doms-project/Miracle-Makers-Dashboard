// ---------------------------------------------------------------------------
// TASK 1 — WHAT IS THE "Case Manager" FIELD, ACTUALLY?
//
// 🔴 FOUR ANSWERS, NONE OF WHICH ARE IN THE REPOSITORY. The field is resolved
// by NAME everywhere (lib/ghl.ts:1427 — `cm: ["casemanager", "casemgr"]`), so
// its id, its dataType, its picklist and its folder are account data. The build
// changes shape depending on all four, so none of them may be guessed.
//
//   1  its id
//   2  its dataType        — the task asserts SINGLE_OPTIONS. HybridPicker's
//                            own header says these four fields are "SINGLE_OPTIONS
//                            (or MULTIPLE_OPTIONS)", so the code does not commit.
//   3  its picklist        — MM-STATE suggests it may hold only "TBD"
//   4  which pipelines show it
//
// ⚠️ ON (4) — AND THIS CORRECTS THE BRIEF. A GoHighLevel opportunity custom
// field is LOCATION-WIDE. It is not "ticked onto" a pipeline and a write to it
// does not depend on one. What IS per-pipeline is this dashboard's own stored
// config: `groupFieldsForPipeline` shows a pipeline only the FOLDERS its entry
// in "MM Pipeline Folders" lists. So the tick decides whether anybody SEES the
// value, not whether it STORES. Both matter, for different reasons, and this
// probe reports them separately rather than as one answer.
//
// 🔴 THE THING THAT REALLY DOES STORE NOTHING WITH A 200 is writing a value a
// SINGLE_OPTIONS picklist does not offer. That is answer (3).
//
// Run:  GHL_PIT=… GHL_LOCATION_ID=… node scripts/case-manager-field-probe.mjs
//
// Read-only. Two GETs. Nothing is written.
// ---------------------------------------------------------------------------

const BASE = (process.env.GHL_API_BASE || "https://services.leadconnectorhq.com").replace(/\/$/, "");
const PIT = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "").trim();
if (!PIT || !LOC) {
  console.error("Set GHL_PIT and GHL_LOCATION_ID.");
  process.exit(1);
}

/** The two the task names. Reported by id AND by name, so neither is assumed. */
const WANT_PIPELINES = ["KGjdCMG4F8xILk0ineB9", "74Pt3XX4hgBIqD10mW4G"];
/** The five names the map implies, to check against the picklist. */
const MANAGERS = [
  "Carla Winnigan",
  "Edmark Villanueva",
  "Roi Navarte",
  "Kimberly Bowen",
  "Mahagony Stewart",
];
/** Ern and Darius each hold both — SINGLE_OPTIONS stores ONE string. */
const COMBOS = ["Carla Winnigan, Edmark Villanueva"];

const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${PIT}`, Version: "2021-07-28", Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`GoHighLevel answered ${res.status} for ${path}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  return res.json();
};
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const fields = (await get(`/locations/${encodeURIComponent(LOC)}/customFields?model=opportunity`)).customFields || [];
console.log(`${fields.length} opportunity custom field(s) on ${LOC}.\n`);

// ⚠️ THE SAME ALIASES lib/ghl.ts:1427 USES, not a new spelling invented here.
const ALIASES = ["casemanager", "casemgr"];
const hits = fields.filter((f) => ALIASES.includes(norm(f.name)));
const near = fields.filter(
  (f) => !hits.includes(f) && /case|manager|\bcm\b/i.test(f.name || ""),
);

console.log("── 1 · THE FIELD ────────────────────────────────────────────────");
if (!hits.length) {
  console.log("  🔴 NO FIELD MATCHES `casemanager` OR `casemgr`.");
  console.log("     Nothing in the app can write it, and `record.cm` is empty for");
  console.log("     every record on this account. STOP — the design changes.");
  if (near.length) {
    console.log("\n     Fields whose names are close:");
    for (const f of near) console.log(`       "${f.name}"  ${f.dataType}  id=${f.id}`);
  }
  process.exit(0);
}
if (hits.length > 1) {
  // 🔴 findDefByName takes the FIRST match. Two fields normalising the same
  // means every write lands on whichever GoHighLevel happened to return first.
  console.log(`  🔴 ${hits.length} FIELDS MATCH. \`findDefByName\` takes the first,`);
  console.log("     so writes would land on an arbitrary one. STOP.");
  for (const f of hits) console.log(`       "${f.name}"  ${f.dataType}  id=${f.id}  folder=${f.parentId ?? "(none)"}`);
  process.exit(0);
}
const cm = hits[0];
const opts = (cm.picklistOptions || cm.options || []).map((o) =>
  typeof o === "string" ? o : String(o?.value ?? o ?? ""),
);
console.log(`  name      "${cm.name}"`);
console.log(`  id        ${cm.id}`);
console.log(`  dataType  ${cm.dataType}`);
console.log(`  folder    ${cm.parentId || "(none)"}${cm.parentName ? ` "${cm.parentName}"` : ""}`);

console.log("\n── 2 · THE DATATYPE ─────────────────────────────────────────────");
if (/^SINGLE_OPTIONS$/i.test(cm.dataType)) {
  console.log("  ✅ SINGLE_OPTIONS, as the task assumed. One string, from a picklist.");
} else if (/OPTION|RADIO|CHECKBOX/i.test(cm.dataType)) {
  console.log(`  ⚠️ ${cm.dataType} — an option field, but NOT SINGLE_OPTIONS.`);
  console.log("     If it takes an ARRAY, the two-manager problem disappears and");
  console.log("     the comma-separated decision is moot. Report before building.");
} else {
  console.log(`  🔴 ${cm.dataType} — NOT an option field at all.`);
  console.log("     Then there is no picklist to maintain and `addFieldOption` is");
  console.log("     unnecessary: any string stores. That is SIMPLER than the plan,");
  console.log("     but the plan says SINGLE_OPTIONS, so stop and confirm.");
}

console.log("\n── 3 · THE PICKLIST ─────────────────────────────────────────────");
console.log(`  ${opts.length} option(s): ${opts.length ? JSON.stringify(opts) : "(none)"}`);
if (/OPTION|RADIO|CHECKBOX/i.test(cm.dataType)) {
  const missingNames = MANAGERS.filter((m) => !opts.some((o) => norm(o) === norm(m)));
  const missingCombos = COMBOS.filter((c) => !opts.some((o) => norm(o) === norm(c)));
  console.log(`\n  missing manager names  ${missingNames.length ? JSON.stringify(missingNames) : "none"}`);
  console.log(`  missing combinations   ${missingCombos.length ? JSON.stringify(missingCombos) : "none"}`);
  // 🔴 addFieldOption PUTs the WHOLE array back, so this is what must be sent.
  const complete = [...opts, ...missingNames, ...missingCombos];
  console.log("\n  🔴 `addFieldOption` REPLACES THE WHOLE ARRAY. The complete list to");
  console.log("     send, existing options first so nothing is destroyed:");
  console.log(`     ${JSON.stringify(complete)}`);
  if (opts.length === 1 && /^tbd$/i.test(opts[0]))
    console.log('\n  ⚠️ The picklist holds only "TBD" — MM-STATE was right.');
}

console.log("\n── 4 · WHICH PIPELINES RENDER IT ────────────────────────────────");
console.log("  ⚠️ DISPLAY, NOT STORAGE. A location-wide field stores from any");
console.log("     pipeline; this only says who would SEE it.");
const cvs = (await get(`/locations/${encodeURIComponent(LOC)}/customValues`)).customValues || [];
const cfg = cvs.find((v) => /MM Pipeline Folders/i.test(v.name || ""));
if (!cfg?.value) {
  console.log("  🔴 No 'MM Pipeline Folders' custom value — cannot answer.");
} else {
  let parsed = null;
  try { parsed = JSON.parse(cfg.value); } catch { /* reported below */ }
  if (!parsed?.pipelines) {
    console.log("  🔴 The stored config did not parse, or holds no `pipelines`.");
  } else {
    const folderNames = parsed.folderNames || {};
    for (const pid of WANT_PIPELINES) {
      const entry = parsed.pipelines[pid];
      if (!entry) { console.log(`  ${pid}  🔴 NO ENTRY in the stored config.`); continue; }
      const listed = entry.folders || [];
      // ⚠️ A folder is listed by KEY or by RAW ID (rounds 129/130). Both count.
      const byId = listed.includes(cm.parentId);
      const byName = Object.entries(folderNames).some(
        ([fid, nm]) => fid === cm.parentId && listed.includes(nm),
      );
      const shown = byId || byName || listed.some((k) => norm(k) === norm(cm.parentName || ""));
      console.log(`  ${pid}  scope=${entry.scope}  folders=${listed.length}  → ${
        shown ? "✅ WOULD RENDER" : "🔴 WOULD NOT RENDER"}`);
      if (!shown)
        console.log(`       (its folder ${cm.parentId} is not in that pipeline's list)`);
    }
  }
}

console.log("\n── WHAT THIS SETTLES ────────────────────────────────────────────");
console.log("  Write id        ", cm.id);
console.log("  Write dataType  ", cm.dataType);
console.log("  🔴 A value outside the picklist stores NOTHING and returns 200.");
console.log("     Append the names above BEFORE the first applyCaseManagers write.\n");
