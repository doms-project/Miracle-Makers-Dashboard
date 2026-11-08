// ---------------------------------------------------------------------------
// ROUND 196 PROOF — the live checks cover rounds 188–195, and no token is left
// in a script.
//
// live-tour.mjs and postdeploy-check.mjs run against the LIVE dashboard, so
// they cannot run here. This checks the other half: everything they look for
// exists in this tree — every selector the tour's new steps use, and every
// function postdeploy-check imports — so renaming a class fails HERE, not
// silently on the live run.
// Run: npx tsx scripts/round196-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${got === undefined ? "" : `\n       got: ${JSON.stringify(got)}`}`); }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const page = read("../app/page.tsx");
const css = read("../app/filterbar.css") + read("../app/spacing.css");
const tour = read("./live-tour.mjs");
const post = read("./postdeploy-check.mjs");
const find = read("./find-lead.mjs");

console.log("1 · What the tour's new steps look for exists");
// A class rendered in a className: a plain string, a template, or a string
// inside a condition (`x ? "railsec active" : "railsec"`).
const cls = (c) =>
  new RegExp(`className=(?:"[^"]*\\b${c}\\b[^"]*"|\\{[^\\n]{0,120}?["\`][^"\`\\n]*?(?<![\\w-])${c}(?![\\w-])[^"\`\\n]*?["\`])`).test(page);
for (const c of ["filterbar", "search", "officefilter", "dirbtn", "stats", "mstats", "stat", "k", "srcpick", "col", "colhead", "card", "newlead-tag", "sugg", "suggrow", "sugglabel", "suggdetail", "searchchip", "railsec", "count"])
  ok(`class "${c}" is rendered`, cls(c));
ok('the three search boxes carry data-search ("clients" for the tour)', /data-search=\{which\}/.test(page) && /which="clients"/.test(page));
ok("Clients' Created control is #createdSel, Master's #mcreatedSel", /id="createdSel"/.test(page) && /id="mcreatedSel"/.test(page));
ok('"Last month" is the value "lastMonth"', /\["lastMonth", "Last month"\]/.test(read("../lib/createdRange.ts")));
ok("the Master button's title is the one the tour clicks", page.includes('title="Every pipeline you can access, side by side"') && tour.includes('title="Every pipeline you can access, side by side"'));
ok("a sales-rep suggestion's detail starts with \"Sales rep\"", /ownerWord: "Sales rep"/.test(page) && /\$\{inp\.ownerWord\} · \$\{plural/.test(read("../lib/smartSearch.ts")) && tour.includes('text-matches("^Sales rep")'));
ok("a tag's remove button is the button inside .searchchip", /<span key=\{c\.key\} className="searchchip">[\s\S]{0,80}<button/.test(page));
ok("the toolbar heights the tour compares are set in the CSS", /\.filterbar > \.search\{[^}]*height:34px/.test(css) && /\.filterbar \.officefilter select\{[^}]*height:34px/.test(css));
ok("the Clients 'By rep' tile the tour reads a name from", /<div className="k">By rep/i.test(page));

console.log("2 · What postdeploy-check imports exists");
const ss = read("../lib/smartSearch.ts"), ow = read("../lib/owners.ts");
for (const f of ["indexRecord", "matchesQuery", "parseQuery", "suggest"]) ok(`lib/smartSearch.ts exports ${f}`, new RegExp(`export function ${f}\\b`).test(ss));
ok("lib/owners.ts exports ownerOptions", /export function ownerOptions\b/.test(ow));
ok("postdeploy-check indexes a record with the same fields as the Clients search", post.includes("[r.oppName, r.first, r.last, r.office, r.stage, r.harmony, r.cm, r.cg, r.rep, r.src], r.contactPhone, r.contactEmail") && page.includes("[r.oppName, r.first, r.last, r.office, r.stage, r.harmony, r.cm, r.cg, r.rep, r.src],"));

console.log("3 · Versions and secrets");
ok("each script says which version it is", /SCRIPT_VERSION = "postdeploy-check 196\.1"/.test(post) && /SCRIPT_VERSION = "live-tour 196\.1"/.test(tour) && /SCRIPT_VERSION = "find-lead 196\.1"/.test(find));
const tokenish = /pit-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
ok("🔴 no GoHighLevel token in find-lead.mjs", !tokenish.test(find));
ok("🔴 …nor in any other script here", ![post, tour, read("./predeploy-check.mjs")].some((t) => tokenish.test(t)));
ok("find-lead reads its tokens from the environment only", /process\.env\.MAIN_PIT \|\| MAIN\.pit/.test(find) && /const MAIN = \{ pit: ""/.test(find) && /const ODP = \{ pit: ""/.test(find));

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
