// ---------------------------------------------------------------------------
// ROUND 198 PROOF — the New Leads redesign, the "Sorted" stats, source logos,
// the empty pipeline board, the waiting pill, the rename box and the font.
//
// Drives the PURE stats rules in lib/sorting.ts with literals and checks the
// server, the page, the tab and the stylesheet are wired to them.
// (The on-screen checks live in round176-proof: list by default, 4 tiles,
// search width, 264px columns, no empty lane, rename focus/caret/Esc.)
// Run: npx tsx scripts/round198-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import * as S from "../lib/sorting.ts";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${got === undefined ? "" : `\n       got: ${JSON.stringify(got)}`}`); }
};
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

console.log("1 · The stamp written when a lead leaves New Leads");
const st = { at: "2026-11-14T15:02:11.000Z", kind: "pipeline", pipelineId: "pOE", userId: "kim" };
ok("encode → parse round-trips", JSON.stringify(S.parseSorted(S.encodeSorted(st))) === JSON.stringify(st), S.encodeSorted(st));
ok("staffing stamps parse too", S.parseSorted("2026-11-14T15:02:11.000Z|staffing|pOT|kim")?.kind === "staffing");
for (const bad of ["", "nonsense", "notadate|pipeline|p|u", "2026-11-14T15:02:11Z|moved|p|u", "2026-11-14T15:02:11Z|pipeline||u", null, undefined])
  ok(`malformed (${JSON.stringify(bad)}) is "no stamp", never a throw`, S.parseSorted(bad) === null);
ok("the field's name is fixed", S.SORTED_FIELD === "Sorted From New Leads");

console.log("2 · The counts come from the records ON the dashboard");
const F = "fSorted";
const now = Date.parse("2026-11-14T18:00:00.000Z");
const day = 86_400_000;
const rec = (id, at, kind, pipe) => ({ id, cf: { [F]: S.encodeSorted({ at: new Date(at).toISOString(), kind, pipelineId: pipe, userId: "u" }) } });
const recs = [
  rec("a", now - 1 * 3600_000, "pipeline", "pOE"),
  rec("b", now - 2 * 3600_000, "pipeline", "pOE"),
  rec("c", now - 3 * day, "pipeline", "pOT"),
  rec("d", now - 20 * day, "staffing", "pOE"),
  rec("e", now - 60 * day, "pipeline", "pPP"),
  { id: "f", cf: {} },                       // never sorted
  { id: "g", cf: { [F]: "garbage" } },       // malformed: not counted
];
const all = S.sortStats(recs, F, 0);
ok("all time: 5 sorted (4 to pipelines, 1 to Staffing)", all.total === 5 && all.staffing === 1, all);
ok("per pipeline: OLTL Enrollment 2, Transfer 1, Private Pay 1",
  all.byPipeline.get("pOE") === 2 && all.byPipeline.get("pOT") === 1 && all.byPipeline.get("pPP") === 1);
ok("newest first", JSON.stringify(all.ids) === '["a","b","c","d","e"]', all.ids);
const deleted = S.sortStats(recs.filter((r) => r.id !== "a"), F, 0);
ok("🔴 a lead deleted from the dashboard drops out of the count by itself", deleted.total === 4 && deleted.byPipeline.get("pOE") === 1, deleted);
ok("7 days: 3", S.sortStats(recs, F, S.windowStart("7d", now)).total === 3);
ok("30 days: 4 (Staffing included)", (() => { const x = S.sortStats(recs, F, S.windowStart("30d", now)); return x.total === 4 && x.staffing === 1; })());
const t0 = S.windowStart("today", now);
ok("today starts at midnight New York (18:00Z = 13:00 EST → 05:00Z)", new Date(t0).toISOString() === "2026-11-14T05:00:00.000Z", new Date(t0).toISOString());
ok("today: 2", S.sortStats(recs, F, t0).total === 2);
ok("no field on the account → zeros, never a guess", S.sortStats(recs, null, 0).total === 0);

console.log("3 · The server writes the stamp, best-effort, only when the lead LEFT New Leads");
const ghl = read("../lib/ghl.ts");
const fn = ghl.slice(ghl.indexOf("export async function stampSortedFromNewLeads"), ghl.indexOf("export const REASSIGN_FOLLOWERS_FIELD"));
ok("stampSortedFromNewLeads exists and never throws (returns stamped / no field / failed)",
  /"stamped" \| "no field" \| "failed"/.test(fn) && /catch \(e\)/.test(fn) && /return "failed";/.test(fn));
ok("no field → no write, a warning naming the field", /if \(!def\)/.test(fn) && /return "no field";/.test(fn));
const so = ghl.slice(ghl.indexOf("export async function sortOpportunity"), ghl.indexOf("export async function moveOpportunity"));
ok("sort stamps only when the chosen stage is not NEW LEAD (an unowned re-route is still waiting)",
  /args\.mode === "sort" && \(stages\.find\(\(st\) => st\.id === destStageId\)\?\.name \|\| ""\)\.trim\(\)\.toUpperCase\(\) !== "NEW LEAD"/.test(so));
ok("…and only AFTER the sort itself was written", so.indexOf("stampSortedFromNewLeads") > so.indexOf("putOpportunityVerified("));
ok("assign never stamps (it is not a New Leads sort)", (so.match(/stampSortedFromNewLeads/g) || []).length === 1);
const mv = read("../app/api/opportunities/[id]/move/route.ts");
ok("Send to Staffing from NEW LEAD stamps \"staffing\" — judged on what happened",
  /if \(isNewLeadStage\(target\.stage\) && record && isStaffingStage\(record\.stage\)\)/.test(mv) && /stampSortedFromNewLeads\(id, "staffing"/.test(mv));
ok("the field is hidden from the panel and blocked from hand edits",
  /"Sorted From New Leads"/.test(read("../lib/fieldFolders.ts")) && /"Sorted From New Leads"/.test(read("../lib/editable.ts")));

console.log("4 · The New Leads tab");
const tab = read("../components/SortingTab.tsx");
const page = read("../app/page.tsx");
ok("the page finds the field by name and hands it to the tab", /=== "sortedfromnewleads"/.test(page) && /sortedFieldId=\{sortedFieldId\}/.test(page));
ok("stats count EVERY record on the dashboard, not only the waiting ones", /allRecords=\{data\}/.test(page) && /sortStats\(allRecords, sortedFieldId/.test(tab));
ok("the Sorted tile says a deleted lead drops out", /A lead deleted from the dashboard drops out of this count\./.test(tab));
ok("no field: admins are told which field to create", /Create the GoHighLevel field “Sorted From New Leads” \(Text, Opportunity\)/.test(tab));
ok("Today / 7 / 30 days / All time", ["today", "7d", "30d", "all"].every((w) => tab.includes(`<option value="${w}">`)));
ok("the boards' search box, scoped to this tab", /<SearchBox\s+which="sorting"/.test(tab) && /SearchBox=\{SearchBox\}/.test(page));
ok("it suggests pipelines and sources too", /kind: "pipeline"/.test(tab) && /kind: "source"/.test(tab) && /"pipeline" \| "source"/.test(read("../lib/smartSearch.ts")));
ok("Show, Sort and Group; Group only in the list", /sel\(\s*"Show"/.test(tab) && /sel\(\s*"Sort"/.test(tab) && /view === "list"\s*\? sel\(\s*"Group"/.test(tab));
ok("no empty lane is drawn", /if \(!inLane\.length\) return null;/.test(tab));
ok("filters on and nothing left → Clear filters", /Nothing matches these filters\./.test(tab) && /Clear filters/.test(tab));

console.log("5 · Source logos, icon only");
ok("the tab draws the boards' logo, with an initial when a source has none",
  /SourceMark=\{SourceMarkOrInitial\}/.test(page) && /if \(sourceIcon\(t\)\) return <SourceMark src=\{t\} small=\{small\} \/>;/.test(page) && /className=\{small \? "srcmark srcunk sm" : "srcmark srcunk"\}/.test(page));
const srcCell = tab.slice(tab.indexOf('<span className="sortsrc">'), tab.indexOf('<span className="sortsrc">') + 260);
ok("🔴 the list's Source column is the icon alone — no source text", /<SourceMark src=\{r\.src\} \/>/.test(srcCell) && !/\{r\.src \|\| "—"\}/.test(srcCell), srcCell);
ok("the raw source is in the icon's tooltip", /title=\{`Source: \$\{t\}`\}/.test(page));
ok("cards: logo on the name line, no source word in the meta line", !/r\.src \|\| "no source"/.test(tab));
ok("By source tile: logo + count, click to filter", /data-tile="source"/.test(tab) && /setSourceTag\(sourceTag === k \? null : k\)/.test(tab));

console.log("6 · Page");
ok("the sorting tabs have their own List/Kanban, List by default", /useState<"list" \| "board">\("list"\)/.test(page) && /"mm\.sortView"/.test(page) && /view=\{sortView\}/.test(page));
ok("the toolbar switch drives it on a sorting tab", /if \(sortingOn\) setSortView\("list"\);/.test(page) && /if \(sortingOn\) setSortView\("board"\);/.test(page));
ok("no + Add Lead on Staffing needed lead", /!\(sortingOn && sortTab === "staffing"\)/.test(page));
ok("an empty pipeline board: one message, no columns", /!boardFocused\.length \? \(\s*<div className="board boardempty">/.test(page));
ok("waiting leads: a pill with a pulsing dot", /className="sortwait new"/.test(page) && /<i className="pulse"/.test(page));

console.log("6b · Tab names: double-click in the sidebar AND the Pipelines screen");
const pa = read("../components/PipelineAdmin.tsx");
ok("double-click renames a sidebar tab (admins only) — the only way to reach New Leads from the sidebar",
  (page.match(/onDoubleClick=\{\s*isAdminViewer \?/g) || []).length === 2 && /startRename\(key, name\)/.test(page));
ok("rename: Esc cancels from anywhere (document, capture phase, only while renaming)",
  /if \(!renaming\) return;[\s\S]{0,260}document\.addEventListener\("keydown", onKey, true\)/.test(page));
ok("rename: focus and select on open", /el\.focus\(\);\s*el\.select\(\);/.test(page));
ok("one stored name: the Pipelines screen reads the page's names once they are known",
  /labels=\{tabLabelsKnown \? tabLabelsRaw : undefined\}/.test(page) && /\(liveLabels \?\? data\.config\.labels\)/.test(pa));
ok("the Pipelines screen names the two sorting tabs and the stage label",
  ['"newLeads"', '"staffingTab"', '"staffingStage"'].every((k) => pa.includes(`renameTab(${k}`)));
ok("each CLIENT pipeline's row has \"Name in the sidebar\"",
  /entry\?\.scope === "client" \? \(\s*<NameEditor[\s\S]{0,120}label="Name in the sidebar"/.test(pa) && /renameTab\(`pipeline:\$\{p\.id\}`, n, p\.id\)/.test(pa));
ok("the row shows the sidebar name, and the GoHighLevel name beside it when renamed",
  /<b>\{\(liveLabels \?\? data\.config\.labels\)\?\.\[`pipeline:\$\{p\.id\}`\] \|\| p\.name\}<\/b>/.test(pa) && /in GoHighLevel/.test(pa));
ok("Enter saves, Esc puts back what is saved, typing the default clears the override",
  /e\.key === "Enter"[\s\S]{0,80}void save\(\)/.test(pa) && /e\.key === "Escape"[\s\S]{0,120}setV\(current\)/.test(pa) && /v\.trim\(\) === fallback\.trim\(\) \? "" : v/.test(pa));
ok("saved through the same admin-only action, and handed to the sidebar without a reload",
  /post\(\{ action: "rename-tab", key, name \}, rowId\)/.test(pa) && /onLabelsSaved\?\.\(/.test(pa) && /onLabelsSaved=\{\(labels\) => setTabLabelsRaw\(labels\)\}/.test(page));
ok("the server still refuses a non-admin, a duplicate or an over-long name",
  /case "rename-tab"/.test(read("../app/api/admin/pipelines/route.ts")) && /labelProblem\(name, taken\)/.test(read("../app/api/admin/pipelines/route.ts")));

console.log("7 · Styles and font");
const css = read("../app/sorting.css");
const gcss = read("../app/globals.css");
ok("Kanban column = every other board's (.col 264px)", /\.col\{flex:0 0 264px/.test(gcss) && /\.sortlane\{flex:0 0 264px;width:264px/.test(css));
ok("the search box is a normal width (340px basis)", /\.sortsearchwrap\{flex:0 1 340px/.test(css));
ok("the name fields on the Pipelines screen are styled (.pfname)", /\.pfname input\{/.test(css));
ok("sidebar rename box: the sidebar's colours, white text and a white caret", /\.rail \.railrename\{[^}]*color:#fff;caret-color:#fff/.test(css));
ok("bigger labels: title 16px, body 13px", /\.sorttitle h2\{[^}]*font-size:16px/.test(css) && /\.sortrow\{[^}]*font-size:13px/.test(css));
ok("the pulse respects reduced motion", /prefers-reduced-motion:reduce\)\{\.sortwait \.pulse::after\{animation:none;\}/.test(css));
const font = read("../lib/font.ts");
const layout = read("../app/layout.tsx");
ok("one font, set in lib/font.ts and loaded by the layout", /export const UI_FONT = "/.test(font) && /uiFontHref\(\)/.test(layout) && /"--font" as string\]: uiFontStack\(\)/.test(layout));
ok("the build says 198", /round: "198"/.test(read("../lib/build.ts")));

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
