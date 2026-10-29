// ---------------------------------------------------------------------------
// ROUND 185 PROOF — empty client contact sections are tucked behind one link.
//
// A client record listed every client contact folder whether or not it held an
// answer, so one answered form was followed by a stack of bare headings (OLTL
// Waiver, ODP, Referral Partner, Event Attendance…) that read like clutter.
//
// Checked from source, plus the quiet-section rule itself on sample groups.
// Run: node scripts/round185-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
let pass = 0, failed = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}`); }
};

// 1. The rule, lifted from the source so the proof tests what ships.
const m = src.match(/const isQuietSection = useCallback\(\s*\(g[^)]*\)\s*=>\s*([\s\S]*?),\s*\[revealedFields\],\s*\);/);
ok("isQuietSection is defined from revealedFields", !!m);
const body = m ? m[1] : "false";
const quiet = (g, revealed) => new Function("g", "revealedFields", `return (${body});`)(g, revealed);
const none = new Set();
ok("a section with an answer is not quiet", quiet({ fields: [{ id: "a" }], hidden: [{ id: "b" }] }, none) === false);
ok("a client section with nothing answered is quiet", quiet({ fields: [], hidden: [{ id: "b" }, { id: "c" }] }, none) === true);
ok("…until one of its fields is revealed", quiet({ fields: [], hidden: [{ id: "b" }] }, new Set(["b"])) === false);
ok("a caregiver section (every field listed, no `hidden`) is never quiet", quiet({ fields: [{ id: "x" }] }, none) === false);

// 2. The panel skips quiet sections unless asked.
const mapStart = src.indexOf("{contactGroups.map((g, gi) => {");
const mapBody = mapStart > 0 ? src.slice(mapStart, mapStart + 3000) : "";
ok("the contact section loop skips quiet sections when hidden", /if \(!showEmptySections && isQuietSection\(g\)\) return null;/.test(mapBody));

// 3. One control brings them back, with the count.
ok("a 'Show N empty sections' control is rendered", /contactGroups\.filter\(isQuietSection\)\.length/.test(src) && /`Show \$\{quiet\} empty section/.test(src));
ok("the control can hide them again", /`Hide \$\{quiet\} empty section/.test(src));
ok("the control is absent when nothing is quiet", /if \(!quiet\) return null;/.test(src));

// 4. Per record, like revealed fields.
ok("opening another record hides them again", /setRevealedFields\(new Set\(\)\);\s*setAddFieldOpen\(""\);\s*setShowEmptySections\(false\);\s*\}, \[selId\]\);/.test(src));

// 5. Partner fields show the partner, not their contact id.
const pn = readFileSync(new URL("../components/PartnerName.tsx", import.meta.url), "utf8");
const rf = src.slice(src.indexOf("const renderField = ("), src.indexOf("const renderField = (") + 1500);
ok("renderField routes partner-id fields to PartnerName", /const partnerKind = partnerIdField\(def\);\s*if \(partnerKind\)\s*return \(\s*<div className="f"[^>]*>\s*<label[^>]*>\{def\.name\}<\/label>\s*<PartnerName/.test(rf));
ok("…so they get no editable FieldControl", rf.indexOf("<PartnerName") < rf.indexOf("<FieldControl"));
ok("Referring Partner is matched by its resolved field id", /def\.id === referringPartnerFieldId\) return "referrer"/.test(src));
ok("Event Host is ONE resolved field id, like the Referrals route", /def\.id === eventHostFieldId\) return "host"/.test(src));
// The resolution rule, lifted from source and run: first alias match, else id.
{
  const mm = src.match(/const eventHostFieldId = useMemo\(\(\) => \{([\s\S]*?)\}, \[fieldDefs\]\);/);
  ok("eventHostFieldId is resolved from fieldDefs", !!mm);
  const resolve = (fieldDefs) =>
    // Type annotations stripped: this runs the shipped logic as plain JS.
    new Function("fieldDefs", "EVENT_HOST_NAMES", "EVENT_HOST_FIELD_ID", mm[1].replace(/\(x: string\)/g, "(x)"))(
      fieldDefs, ["Event Host", "Hosted By", "Event Partner", "Host"], "PCbzK8AbUDYajq9Aja60");
  ok("…picks the Event Host field", resolve([{ id: "A", name: "Office" }, { id: "H", name: "Event Host" }]) === "H");
  ok("…and only that ONE when an unrelated \"Host\" field also exists", resolve([{ id: "H", name: "Event Host" }, { id: "X", name: "Host" }]) === "H");
  ok("…falls back to the known id", resolve([{ id: "PCbzK8AbUDYajq9Aja60", name: "Renamed" }]) === "PCbzK8AbUDYajq9Aja60");
  ok("…and is empty on an account without one", resolve([{ id: "A", name: "Office" }]) === "");
}
ok("PartnerName reads the same partner list as Referred by", pn.includes('"/api/referrals?only=partners"'));
ok("…once per page load (module-level cache)", /^let cached: Promise<Partner\[\]> \| null = null;/m.test(pn));
ok("…and a failed load is not cached", /cached = null; \/\/ a failure is not remembered/.test(pn));
// The raw id may appear only as a hover title, never as visible text.
const jsx = pn.slice(pn.indexOf("return (\n    <div"));
const bare = (jsx.match(/\{value\}/g) || []).length;
const asTitle = (jsx.match(/title=\{value\}/g) || []).length;
ok("the raw id is never rendered as text (only as a title)", bare > 0 && bare === asTitle);
ok("an unknown partner reads as words, not an id", jsx.includes("a partner not in your list"));

// 6. Unknown partner ids are re-asked once EACH, never in a loop.
ok("an unknown partner is re-asked once per id", /const refreshedFor = new Set<string>\(\);/.test(pn) && /if \(!p && !refreshedFor\.has\(value\)\) \{\s*refreshedFor\.add\(value\);/.test(pn));

// 7. Caregiver sections show filled / total; client sections keep their count.
ok("a caregiver section (no `hidden`) shows filled / total", /g\.hidden === undefined && g\.fields\.length \?[\s\S]*?hasValue\(cFields\?\.values\[d\.id\]\)[\s\S]*?\{done\} \/ \{g\.fields\.length\}/.test(src));
ok("a client section still shows its answered count", /\) : g\.fields\.length \? \(\s*<span className="seccount">\{g\.fields\.length\}<\/span>/.test(src));

console.log(`\n${pass} passed · ${failed} failed`);
process.exit(failed ? 1 : 0);
