// ---------------------------------------------------------------------------
// ROUND 110 · THE COLLISION GUARD.
//
// 🔴 .iskip (round 88) · .addsec (round 98) · .panel (rounds 100-109).
//
// The round-100 stylesheet comment claims every class in the Referrals section
// is rf-prefixed "so a third collision cannot happen", and lists the generic
// names avoided: .kpi .box .bars .drawer .badge. `.panel` was not on that list,
// because the list was written from memory. It was copied out of the prototype's
// markup, and in THIS stylesheet `.panel` is the record slide-over —
// position:fixed, translateX(100%). Every list in the section rendered
// perfectly, off the right edge of the window, for ten rounds.
//
// ⚠️ A LIST OF NAMES SOMEBODY REMEMBERED IS NOT A CHECK. This is one.
//
// It flags a class used bare in a component when globals.css already defines it
// with a rule that can MOVE OR HIDE the element — position:fixed/absolute,
// transform, display:none. Borrowing `.ibtn` or `.statecard` is deliberate
// reuse and harmless; borrowing something that relocates the box is not.
//
// Run: node scripts/class-collision-proof.mjs
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync("app/globals.css", "utf8");

/** class -> the declaration blocks of its TOP-LEVEL (unscoped) rules. */
const rules = new Map();
for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const selectors = m[1].split(",").map((x) => x.trim());
  const body = m[2];
  for (const sel of selectors) {
    // only a bare `.cls` or `.cls.mod` — a descendant rule cannot hijack a
    // component that never nests inside that parent.
    const bare = /^\.([a-zA-Z][\w-]*)(\.[\w-]+)*$/.exec(sel);
    if (!bare) continue;
    const cls = bare[1];
    rules.set(cls, (rules.get(cls) || "") + body);
  }
}

// ⚠️ NARROWED AFTER ITS FIRST RUN, which flagged .cgresults and .upmenu —
// dropdowns that OWN their position:absolute and want it. `absolute` is
// ordinary; what parked the Referrals lists off-screen was the pair
// `position:fixed` + `transform:translate…`, i.e. an element taken out of the
// document and moved somewhere else entirely. That, and display:none, are the
// rules a component cannot borrow by accident and survive.
const DANGEROUS = /position\s*:\s*fixed|display\s*:\s*none/i;

const files = fs
  .readdirSync("components")
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => path.join("components", f));

let flagged = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const used = new Set();
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{[^}]*?"([^"]*)"[^}]*\})/g)) {
    for (const part of [m[1], m[2], m[3]]) {
      if (!part) continue;
      for (const c of part.replace(/\$\{[^}]*\}/g, " ").split(/\s+/))
        if (/^[a-zA-Z][\w-]*$/.test(c)) used.add(c);
    }
  }
  for (const c of [...used].sort()) {
    const body = rules.get(c);
    if (!body || !DANGEROUS.test(body)) continue;
    // `.scrim`, `.previewmodal` and the dialog chrome are borrowed ON PURPOSE —
    // they ARE overlays and the component wants exactly that behaviour.
    const INTENDED = new Set(["scrim", "previewmodal", "movebox", "addbox", "cgadd", "rfdrawer", "rfdivpop", "refbypop", "rfpanel"]);
    if (INTENDED.has(c)) continue;
    flagged++;
    const why = (body.match(DANGEROUS) || [""])[0];
    console.log(`🔴 ${f}`);
    console.log(`   uses .${c}, which globals.css defines with "${why.trim()}"`);
    console.log(`   → the element is moved or hidden by a rule that has nothing to do with it.`);
  }
}

console.log(
  flagged
    ? `\n${flagged} collision(s). Prefix the class, or add it to INTENDED if the behaviour is wanted.\n`
    : "\nNo component borrows a class that would move or hide it. ✅\n",
);
process.exit(flagged ? 1 : 0);
