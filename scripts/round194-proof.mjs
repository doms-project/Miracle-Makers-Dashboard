// ---------------------------------------------------------------------------
// ROUND 194 PROOF — the three board toolbars line up.
//
// Reads app/page.tsx with the TypeScript parser (not a regex) and checks what
// sits directly inside each `filterbar`: search, the filters, Sort + Group,
// the count. Then checks app/filterbar.css gives every control one height and
// is scoped so no other toolbar changes. The look itself was checked in
// Chrome against the real stylesheet (V2-REPORT-194.md).
// Run: npx tsx scripts/round194-proof.mjs
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import ts from "typescript";

let pass = 0, fail = 0;
const ok = (n, c, got) => {
  if (c) { pass++; console.log(`  ok   ${n}`); }
  else { fail++; console.log(`  FAIL ${n}${got === undefined ? "" : `\n       got: ${JSON.stringify(got)}`}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const src = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const sf = ts.createSourceFile("page.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const tagOf = (el) => (ts.isJsxElement(el) ? el.openingElement : el);
const classOf = (el) => {
  const a = tagOf(el).attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === "className");
  return a && a.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : "";
};
const attr = (el, name) => {
  const a = tagOf(el).attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name);
  return a?.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : a ? "{…}" : "";
};
/** A child's short name: the component, or the element's class. */
const label = (el) => {
  const t = tagOf(el).tagName.getText();
  return /^[A-Z]/.test(t) ? t : `${t}.${classOf(el).split(" ")[0] || "?"}`;
};
/** Direct element children, looking through `{cond ? <x/> : null}` and `{(() => …)()}`. */
function kids(el) {
  const out = [];
  const visit = (n) => {
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) return out.push(n);
    if (ts.isJsxFragment(n)) return n.children.forEach(visit);
    if (ts.isJsxExpression(n) && n.expression) return visitExpr(n.expression);
  };
  const visitExpr = (e) => {
    if (ts.isParenthesizedExpression(e)) return visitExpr(e.expression);
    if (ts.isConditionalExpression(e)) { visitExpr(e.whenTrue); visitExpr(e.whenFalse); return; }
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return visit(e);
    if (ts.isCallExpression(e) && ts.isParenthesizedExpression(e.expression)) {
      // an inline (() => { … return <span/> })()
      const fn = e.expression.expression;
      fn.body && ts.forEachChild(fn.body, function walk(n) {
        if (ts.isReturnStatement(n) && n.expression) visitExpr(n.expression);
        else if (!ts.isFunctionLike(n)) ts.forEachChild(n, walk);
      });
    }
  };
  if (ts.isJsxElement(el)) el.children.forEach(visit);
  return out;
}
const bars = [];
(function find(n) {
  if ((ts.isJsxElement(n)) && classOf(n).split(" ").includes("filterbar")) bars.push(n);
  ts.forEachChild(n, find);
})(sf);

console.log("1 · The three toolbars, as written in page.tsx");
ok("exactly three toolbars carry `filterbar`", bars.length === 3, bars.length);
const byWhich = {};
for (const b of bars) {
  const search = kids(b).find((k) => label(k) === "SearchBox");
  byWhich[search ? attr(search, "which") : "?"] = b;
}
const shape = (b) => (b ? kids(b).map(label) : []);
ok("Clients: search · filters · Sort+Group · count", eq(shape(byWhich.clients), ["SearchBox", "div.filters", "div.viewctls", "span.count"]), shape(byWhich.clients));
ok("Master: search · filters · count (no Sort or Group there)", eq(shape(byWhich.master), ["SearchBox", "div.filters", "span.count"]), shape(byWhich.master));
ok("Recruiting: search · filters · Sort+Group · count", eq(shape(byWhich.recruiting), ["SearchBox", "div.filters", "div.viewctls", "span.count"]), shape(byWhich.recruiting));

const inner = (b, cls) => {
  const box = b && kids(b).find((k) => classOf(k) === cls);
  return box ? kids(box) : [];
};
const ids = (els) => els.map((e) => {
  const sel = [];
  (function f(n) { if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && tagOf(n).tagName.getText() === "select") sel.push(attr(n, "id")); ts.forEachChild(n, f); })(e);
  return label(e) === "CreatedFilter" || label(e) === "OwnerFilter" ? `${label(e)}#${attr(e, "id")}` : sel.join("+") || label(e);
});
ok("Clients' filters row: Show, Pipeline, Created, Office", eq(ids(inner(byWhich.clients, "filters")), ["scopeSel", "pipeSel", "CreatedFilter#createdSel", "officeSel"] /* round 195: owner moved into search */), ids(inner(byWhich.clients, "filters")));
ok("Clients' right side: Sort, Group", eq(ids(inner(byWhich.clients, "viewctls")), ["sortSel", "groupSel"]), ids(inner(byWhich.clients, "viewctls")));
ok("Master's filters row: Office, Created", eq(ids(inner(byWhich.master, "filters")), ["mofficeSel", "CreatedFilter#mcreatedSel"]), ids(inner(byWhich.master, "filters")));
ok("Recruiting's filters row: Pipeline, Created", eq(ids(inner(byWhich.recruiting, "filters")), ["cgPipeSel", "CreatedFilter#cgCreatedSel"]), ids(inner(byWhich.recruiting, "filters")));
ok("Recruiting's right side: Sort, Group", eq(ids(inner(byWhich.recruiting, "viewctls")), ["cgSortSel", "cgGroupSel"]), ids(inner(byWhich.recruiting, "viewctls")));
const cgSortGroup = inner(byWhich.recruiting, "viewctls")[0];
ok("🔴 Recruiting's ▲/▼ is inside the Sort group, where it is styled", !!cgSortGroup && kids(cgSortGroup).some((k) => classOf(k) === "dirbtn"));

console.log("2 · A switched-on filter is lit");
ok("Show, Pipeline and both Office dropdowns", /id="scopeSel"\s+className=\{scope !== "all" \? "on" : undefined\}/.test(src) && /id="pipeSel"\s+className=\{adminPipeline !== "all" \? "on" : undefined\}/.test(src) && /id="officeSel"\s+className=\{office !== "all" \? "on" : undefined\}/.test(src) && /id="mofficeSel"\s+className=\{office !== "all" \? "on" : undefined\}/.test(src));
ok("Created (every tab); the person is a tag in the search box since round 195", /className=\{range !== "all" \? "on" : undefined\}/.test(src));
ok("a custom range is one box", /<span className="createdrange">/.test(src));

console.log("3 · app/filterbar.css");
const css = readFileSync(new URL("../app/filterbar.css", import.meta.url), "utf8");
ok("imported by the page", /import "\.\/filterbar\.css";/.test(src));
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").split("}").map((r) => r.trim()).filter(Boolean);
ok("🔴 every rule is scoped to .filterbar — no other toolbar changes", rules.every((r) => r.startsWith(".filterbar")), rules.filter((r) => !r.startsWith(".filterbar")).map((r) => r.slice(0, 60)));
const h = (sel) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\{[^}]*height:34px`).test(css.replace(/\s+/g, " ").replace(/\{ /g, "{"));
ok("one height (34px): search, dropdowns, ▲/▼, date range", h(".filterbar > .search") && h(".filterbar .officefilter select") && h(".filterbar .officefilter .dirbtn") && h(".filterbar .createdrange"));
ok("Sort+Group on the right of row 1, filters a full row, count last", /\.viewctls\{order:1;margin-left:auto/.test(css) && /\.filters\{order:2;flex-basis:100%/.test(css) && /\.count\{order:3;flex-basis:100%/.test(css));
ok("dropdowns draw one arrow on every system", /appearance:none/.test(css) && /data:image\/svg\+xml/.test(css));

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
