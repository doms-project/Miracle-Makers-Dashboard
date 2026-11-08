// ---------------------------------------------------------------------------
// ROUND 195 PROOF — smart search (no dropdowns), and spacing.
//
//   1. lib/smartSearch.ts — what a search matches: any word order, phone in
//      any format, part of an email, a Harmony ID; nothing else.
//   2. lib/smartSearch.ts — what it suggests, and in what order.
//   3. app/page.tsx — all three boards use it; a person is picked in the
//      search box and shows exactly their cases; a lead opens from it even
//      when the filters hide it; round 193's dropdowns are gone.
//   4. app/spacing.css — tiles top-aligned, Master's tiles compact, the Moves
//      tables' columns line up. (The look was measured in Chrome too.)
//
// Run: npx tsx scripts/round195-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
const S = await import("../lib/smartSearch.ts");

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${got === undefined ? "" : `\n       got: ${JSON.stringify(got)}`}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("1 · What a search matches");
{
  const ix = S.indexRecord(["John Smith", "Northeast", "NEW LEAD", "448812"], "+1 (717) 692-1647", "J.Smith@Gmail.com");
  const m = (q) => S.matchesQuery(ix, S.parseQuery(q));
  ok("any word order: 'smith john', 'John Smith', 'smi jo'", m("smith john") && m("John Smith") && m("smi jo"));
  ok("capitals and accents ignored: 'JÕHN'", m("JÕHN"));
  ok("🔴 a phone in any format", m("(717) 692-1647") && m("717.692.1647") && m("+1 717 692 1647") && m("7176921647") && m("717-692"));
  ok("the last four digits of a phone", m("1647"));
  ok("part of an email", m("j.smith@gm") && m("gmail"));
  ok("🔴 a Harmony ID (all digits) is not mistaken for a phone and lost", m("448812"));
  ok("every word must match: 'john jones' does not", !m("john jones"));
  ok("an empty search keeps everything", S.matchesQuery(ix, S.parseQuery("  ")));
  ok("a record with no phone is not matched by a number", !S.matchesQuery(S.indexRecord(["Ann"], ""), S.parseQuery("1647")));
}

console.log("2 · What it suggests");
{
  ok("whole word > start of a word > inside a word", S.nameScore("Darius Boyce", ["darius"]) > S.nameScore("Darius Boyce", ["dar"]) && S.nameScore("Darius Boyce", ["dar"]) > S.nameScore("Dario Kaldarius", ["ari"]));
  ok("one typo forgiven in a longer word: 'darus' → Darius, 'boyse' → Boyce", S.nameScore("Darius Boyce", ["darus"]) > 0 && S.nameScore("Darius Boyce", ["boyse"]) > 0);
  ok("but not in a short one, and not two typos", S.nameScore("Ern Holden", ["erm"]) === 0 && S.nameScore("Darius", ["dxrxus"]) === 0);
  const owners = [
    { id: "U_DARIUS", name: "Darius Boyce - Sale", n: 235 },
    { id: "U_ERN", name: "Ern Holden -Sale", n: 232 },
    { id: "U_ME", name: "Musa Flazy", n: 12, me: true },
  ];
  const recs = [
    { id: "r1", name: "Darius Wright", detail: "OLTL Enrollment", ix: S.indexRecord(["Darius Wright"], "4125550101"), activity: 2 },
    { id: "r2", name: "Mary Dariana", detail: "OLTL Transfer", ix: S.indexRecord(["Mary Dariana"], "4125559999"), activity: 9 },
    { id: "r3", name: "Ann Lee", detail: "Private Pay", ix: S.indexRecord(["Ann Lee"], "7176921647", "ann@x.com"), activity: 1 },
  ];
  const sg = (query, extra = {}) => S.suggest({ query, ownerWord: "Sales rep", owners, unassigned: 40, caseManagers: [{ name: "Lamarr Wesley", n: 92 }], offices: [{ name: "Northeast", n: 1 }], records: recs, ...extra });
  const dari = sg("dari");
  ok("🔴 'dari' → the sales rep Darius first, with his case count", dari[0].kind === "owner" && dari[0].value === "U_DARIUS" && dari[0].detail === "Sales rep · 235 cases", dari[0]);
  ok("…then the leads whose name matches; equally good matches, the newer lead first", eq(dari.filter((x) => x.kind === "record").map((x) => x.value), ["r2", "r1"]), dari.map((x) => x.value));
  const ann = S.suggest({ query: "ann", ownerWord: "Sales rep", owners: [], records: [
    { id: "newer", name: "Annabel Cruz", detail: "", ix: S.indexRecord(["Annabel Cruz"], ""), activity: 99 },
    { id: "older", name: "Ann Lee", detail: "", ix: S.indexRecord(["Ann Lee"], ""), activity: 1 },
  ] }).map((x) => x.value);
  ok("a whole-word match beats a newer start-of-word match ('ann' → Ann Lee before Annabel)", eq(ann, ["older", "newer"]), ann);
  ok("a phone number suggests the lead it belongs to, and no people", eq(sg("717 692 1647").map((x) => x.value), ["r3"]), sg("717 692 1647"));
  ok("'unas' → Unassigned", sg("unas").some((x) => x.kind === "unassigned" && x.detail === "no sales rep · 40 cases"));
  ok('"me" → the person signed in', sg("me")[0]?.value === "U_ME", sg("me"));
  ok("a case manager is suggested as one", sg("lamarr").some((x) => x.kind === "cm" && x.value === "Lamarr Wesley"));
  ok("an office is suggested as one", sg("north").some((x) => x.kind === "office" && x.value === "Northeast"));
  ok("people are capped at 5, leads at 6", S.suggest({ query: "a", ownerWord: "Sales rep", owners: Array.from({ length: 9 }, (_, i) => ({ id: `u${i}`, name: `Anna ${i}`, n: i })), records: Array.from({ length: 9 }, (_, i) => ({ id: `r${i}`, name: `Alan ${i}`, detail: "", ix: S.indexRecord([`Alan ${i}`], ""), activity: i })) }).reduce((a, x) => (a[x.kind] = (a[x.kind] || 0) + 1, a), {}).owner === 5);
  ok("equal names: the person with more cases first", S.suggest({ query: "chris", ownerWord: "Sales rep", owners: [{ id: "a", name: "Chris", n: 3 }, { id: "b", name: "Chris", n: 30 }], records: [] })[0].value === "b");
  ok("nothing typed, nothing suggested", sg("").length === 0);
  ok("case-manager lists split into names", eq(S.splitNames("Carla Case Manager, Edmark Case Manager"), ["Carla Case Manager", "Edmark Case Manager"]) && eq(S.splitNames("Andrew Sanders"), ["Andrew Sanders"]));
}

const src = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const at = (start, len) => { const i = src.indexOf(start); return i < 0 ? "" : src.slice(i, i + len); };

console.log("3 · Wired into the three boards");
{
  ok("🔴 round 193's Owner / Recruiter dropdowns are gone", !/<OwnerFilter/.test(src) && !/function OwnerFilter/.test(src));
  ok("the search index is built once per load, with phone and email", /const clientIx = useMemo\(/.test(src) && /r\.contactPhone,\s*r\.contactEmail,?\s*\)/.test(at("const clientIx = useMemo(", 600)) && /\}, \[data\]\);/.test(at("const clientIx = useMemo(", 600)));
  ok("Clients filters with it", /matchesQuery\(clientIx\.get\(r\.id\), qParsed\)/.test(at("const clientPreOwner = useMemo", 1800)));
  ok("Master filters with it (columns and the no-date count)", /matchesQuery\(masterIx\.get\(r\.id\), qParsed\)/.test(at("const masterColumns = useMemo", 500)) && /matchesQuery\(masterIx\.get\(r\.id\), qParsed\)/.test(at("const masterUndated = useMemo", 500)));
  ok("Recruiting filters with it", /matchesQuery\(cgIx\.get\(r\.id\), cgParsed\)/.test(at("const cgPreOwner = useMemo", 600)));
  ok("🔴 a person's count ignores the search text (the suggestion is found BY the text)", !/matchesQuery/.test(at("const clientPeopleBase = useMemo", 700)) && !/matchesQuery/.test(at("const masterPeopleBase = useMemo", 500)) && /ownerOptions\(clientPeopleBase/.test(src) && /ownerOptions\(masterPeopleBase/.test(src));
  ok("🔴 leads are suggested from EVERY record, so one the filters hide still opens", /dataByActivity\.map\(\(r\) => \(\{/.test(at("const clientSuggestRecords = useMemo", 300)) && /cgByActivity\.map\(\(r\) => \(\{/.test(at("const cgSuggestRecords = useMemo", 300)));
  const pk = at("const pickClientSuggestion = ", 500);
  ok("picking: a lead opens, a sales rep / case manager / office narrows, and the text clears", /record"\) return setSelId\(sg\.value\)/.test(pk) && /pickOwner\(sg\.value\)/.test(pk) && /setCmF\(sg\.value\)/.test(pk) && /setOffice\(sg\.value\)/.test(pk) && /setQ\(""\)/.test(pk));
  ok("Recruiting picks the same way", /record"\) return setSelId\(sg\.value\)/.test(at("const pickCgSuggestion = ", 300)) && /setCgQuery\(""\)/.test(at("const pickCgSuggestion = ", 300)));
  ok('the words: "Sales rep" on the client boards, "Recruiter" on Recruiting', /ownerWord: "Sales rep"/.test(at("const clientSuggestions = useMemo", 400)) && /ownerWord: "Sales rep"/.test(at("const masterSuggestions = useMemo", 400)) && /ownerWord: "Recruiter"/.test(at("const cgSuggestions = useMemo", 400)));
  ok("the three boxes carry their tags and suggestions", /which="clients"[\s\S]{0,300}suggestions=\{clientSuggestions\}/.test(src) && /which="master"[\s\S]{0,300}suggestions=\{masterSuggestions\}/.test(src) && /which="recruiting"[\s\S]{0,300}suggestions=\{cgSuggestions\}/.test(src));
  ok("a case manager narrows Clients and Master", /matchesOwner\(r, ownerF\) && hasCm\(r\)/.test(src) && /hasCm\(r\) &&/.test(at("const masterColumns = useMemo", 500)));
  ok("…and is named, and cleared by Clear filters", /case manager \$\{cmF\}/.test(at("Nothing matches the filters in use.", 1500)) && /setCmF\(""\);/.test(at('placeholder="Search by client name…"', 7000)));
  const fn = at("function SearchBox(", 6000);
  ok("keys: ↑ ↓ move, Enter picks, Esc closes the list then clears, Backspace drops the last tag", /ArrowDown/.test(fn) && /ArrowUp/.test(fn) && /e\.key === "Enter" && show && active >= 0/.test(fn) && /e\.key === "Escape" && show[\s\S]{0,60}setOpen\(false\)/.test(fn) && /Backspace" && !value && chips\.length/.test(fn));
  ok("a suggestion is picked on mousedown, so the box keeps focus", /onMouseDown=\{\(e\) => \{\s*e\.preventDefault\(\);\s*pick\(sg\);/.test(fn));
  ok("it is a real combobox for screen readers", /role="combobox"/.test(fn) && /role="listbox"/.test(fn) && /role="option"/.test(fn) && /aria-activedescendant/.test(fn));
}

console.log("4 · Spacing — app/spacing.css");
{
  const css = readFileSync(new URL("../app/spacing.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  ok("imported by the page", /import "\.\/spacing\.css";/.test(src));
  ok("🔴 clickable tiles lay out from the top like the rest", /\.stats \.statbtn\{display:flex;flex-direction:column;justify-content:flex-start/.test(css));
  ok("Master's tiles: a grid, the owner tile two columns wide", /\.stats\.mstats\{display:grid/.test(css) && /\.mstats \.stat\.wide \.mini\{display:grid;grid-template-columns:repeat\(2/.test(css) && /className="stat gold wide"/.test(src));
  ok("long names end in … rather than wrapping the tile taller", /\.mstats \.mini \.srcpick\{[^}]*text-overflow:ellipsis/.test(css));
  ok("🔴 the Moves tables share one set of column widths", /\.kpiblock \.kpitable\{table-layout:fixed;\}/.test(css) && /\.kpiblock \.kpitable th:first-child\{width:46%;\}/.test(css));
  const sel = css.split("}").map((r) => r.trim()).filter(Boolean).map((r) => r.split("{")[0].trim()).filter((x) => !x.startsWith("@media"));
  ok("every rule is scoped to these tiles, the note or the Moves tables", sel.every((x) => x.split(",").every((p) => /^(\.stats|\.mstats|\.mnote|\.kpiblock)/.test(p.trim()))), sel.filter((x) => !/^(\.stats|\.mstats|\.mnote|\.kpiblock)/.test(x)));
}

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
