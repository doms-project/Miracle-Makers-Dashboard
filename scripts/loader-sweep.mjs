// ---------------------------------------------------------------------------
// THE SWEEP — run it every round. Round 111 built it by hand and found three
// defects AFTER the round's own report claimed the audit was complete; this is
// that sweep as a committed check, so "I audited the loaders" is a thing the
// repo can answer rather than a thing I remember doing.
//
// 🔴 IT IS A GREP, AND IT SAYS SO. It cannot prove a loader is correct — only
// that none matches a shape already known to be wrong. Every rule below exists
// because that exact shape shipped:
//
//   1 · a credential gated on `status === "ready"` instead of the blob
//       (round 111: /api/opportunities' 401 relayed onto a page holding a
//        session; and the note DELETE, whose header is its ONLY credential)
//   2 · a raw-truthy test that sends a trimmed value
//       (round 112 item 1: "  " is truthy, trims to "", GHL answers 422)
//   3 · a loader that blanks its own data on failure
//       (a failed refresh turning into a lost dashboard)
//   4 · a full-screen error or spinner with no emptiness test
//       (the card that sat beside 595 loaded records)
//   5 · a tickbox inside an `.irow`, which CSS sizes as a text input
//       (round 112 item 5: min-width:150px left 8px for the label)
//
// Run: node scripts/loader-sweep.mjs
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

let findings = 0;
const flag = (rule, file, line, text, why) => {
  findings++;
  console.log(`\n🔴 ${rule}`);
  console.log(`   ${file}:${line}`);
  console.log(`   ${text.trim().slice(0, 110)}`);
  console.log(`   → ${why}`);
};

/** Every .ts/.tsx under app/, components/ and lib/, excluding API route bodies
 *  where noted per rule. */
const walk = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (n === "node_modules" || n === ".next" || n.startsWith(".")) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(n)) out.push(p);
  }
  return out;
};
const files = [...walk("app"), ...walk("components"), ...walk("lib")];

const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");

  lines.forEach((l, i) => {
    const n = i + 1;
    if (isComment(l)) return;

    // ── 1 · A CREDENTIAL CHOSEN BY THE DECRYPTED SESSION ──────────────────
    // The blob is what authenticates. `status === "ready"` additionally
    // requires the DISPLAY decrypt to have finished, and everything sent in
    // that window goes out with nothing attached.
    if (/status === "ready"/.test(l) &&
        /(x-ghl-sso-key|ssoKey|ssoBlob|\.blob)/.test(l))
      flag("A CREDENTIAL GATED ON `status === \"ready\"`", f, n, l,
           "gate it on the blob — see lib/useGhlSession.ts and report 111.");

    // ── 2 · TEST THE RAW VALUE, SEND THE TRIMMED ONE ──────────────────────
    const m = l.match(/(\w[\w.]*)\s*\?\s*\{\s*\w+:\s*\1\.trim\(\)/);
    if (m)
      flag("RAW-TRUTHY TEST WITH A TRIMMED SEND", f, n, l,
           `"  " is truthy and trims to "" — trim ${m[1]} first, then test it.`);

    // ── 3 · A LOADER THAT BLANKS ITS DATA ON FAILURE ──────────────────────
    // Only inside a catch/!res.ok arm: the same call is legitimate when
    // CLEARING for a new selection.
    if (/set\w*(Data|Records|Rows|Caregivers|Resources|Partners)\(\[\]\)/.test(l)) {
      const ctx = lines.slice(Math.max(0, i - 6), i).join("\n");
      if (/catch\s*\(|!res\.ok|setErr|setLoadErr|setCgErr|setResErr/.test(ctx))
        flag("A FAILED LOAD BLANKS ITS OWN DATA", f, n, l,
             "keep what loaded; a failed refresh is not an empty result.");
    }
  });

  // ── 4 · A WALL WITH NO EMPTINESS TEST ───────────────────────────────────
  // A full-screen card or spinner must be conditioned on there being nothing
  // to show, or it replaces data that is still perfectly good.
  lines.forEach((l, i) => {
    if (isComment(l)) return;
    const wall = l.match(/^\s*(?:\) : |if \()(\w*(?:[Ee]rr|error|[Ll]oading))\s*\?\s*\($/)
              || l.match(/^\s*if \((\w*(?:[Ee]rr|error|[Ll]oading))\)\s*$/);
    if (!wall) return;
    const next = lines.slice(i, i + 4).join("\n");
    if (!/statewrap|statecard|spinner/.test(next)) return;
    flag("A FULL-SCREEN WALL WITH NO EMPTINESS TEST", files.indexOf(f) >= 0 ? f : f,
         i + 1, l,
         `"${wall[1]}" alone replaces loaded content — qualify it with ` +
         "`&& !data.length` and show a strip instead.");
  });
}

/**
 * 🔴 THE CSS SCANS MUST IGNORE COMMENTS — properly, not by prefix.
 *
 * Rules 5-7 skipped only lines that START with `/*`, so the CONTINUATION lines
 * of a block comment were scanned as if they were code. Round 115c wrote a
 * comment quoting the very rule it had just fixed, and the sweep flagged its own
 * explanation — a false positive is as corrosive as a missed one, because the
 * next person learns to ignore the output.
 *
 * Returns the file's lines with every commented one blanked, so line numbers
 * still line up with the real file.
 */
const cssCode = (src) => {
  let inBlock = false;
  return src.split("\n").map((l) => {
    let out = l;
    if (inBlock) {
      const end = out.indexOf("*" + "/");
      if (end === -1) return "";
      out = " ".repeat(end + 2) + out.slice(end + 2);
      inBlock = false;
    }
    const start = out.indexOf("/" + "*");
    if (start !== -1) {
      const end = out.indexOf("*" + "/", start + 2);
      if (end === -1) { inBlock = true; return out.slice(0, start); }
      out = out.slice(0, start) + " ".repeat(end + 2 - start) + out.slice(end + 2);
    }
    return out;
  });
};

// ── 6 · A SCROLLING FLEX CHILD WITH NO EXPLICIT MINIMUM ───────────────────
// Three separate symptoms from one rule: `.rfhits` collapsed to 0px, `.rfdbd`
// cut off its last row, `.movebody` clipped a modal at Owner. A flex item that
// scrolls needs `min-height:0`, or its automatic minimum keeps it at content
// size and the parent clips whatever does not fit.
const cssLines = cssCode(readFileSync("app/globals.css", "utf8"));
cssLines.forEach((l, i) => {
  if (!/overflow(-y)?\s*:\s*(auto|scroll)/.test(l)) return;
  // Only a FLEX ITEM is at risk, and only when it does not say its own minimum.
  if (!/flex\s*:/.test(l)) return;
  if (/min-height\s*:\s*0/.test(l)) return;
  flag("A SCROLLING FLEX CHILD WITH NO min-height:0",
       "app/globals.css", i + 1, l,
       "its automatic minimum keeps it at content size — add min-height:0 or " +
       "the parent clips what does not fit (rounds 112-113, three symptoms).");
});

// ── 5 · A TICKBOX SIZED AS A TEXT INPUT ───────────────────────────────────
// CSS-side rather than TS-side: any `.irow input` style that sets a width or a
// minimum will be inherited by checkboxes and radios placed in that row.
const css = cssCode(readFileSync("app/globals.css", "utf8"));
css.forEach((l, i) => {
  if (!/\.irow\s+input(?!\[)/.test(l)) return;
  if (!/min-width|width\s*:/.test(l)) return;
  if (/:not\(\[type="checkbox"\]\)/.test(l)) return;
  flag("A `.irow input` WIDTH RULE THAT WILL CATCH TICKBOXES",
       "app/globals.css", i + 1, l,
       "exclude [type=checkbox] and [type=radio] — round 112 item 5 left 8px " +
       "for a section label and wrapped it one character per line.");
});

// ── 7 · THE SAME CLASS DEFINED TWICE IN globals.css ───────────────────────
// Round 114 wrote `.statbtn` twice, ~1000 lines apart, with different
// properties. Nothing looked wrong — the cascade merges them per-property — so
// the file grew a rule that only half exists in either place, and the next edit
// to either half silently changes something else.
// ⚠️ A LATER OVERRIDE BLOCK IS A REAL PATTERN AND NOT A BUG. The master-board
// layout refinements deliberately re-open `.masterboard` and `.mstage` to widen
// them; `.pfsec` gets one extra property the same way. Those are intentional and
// commented as such. What is NOT intentional is the same class written twice by
// accident, which is what happened to `.statbtn`.
//
// So intent has to be DECLARABLE rather than guessed: a rule preceded by a
// comment carrying `deliberate-override` is allowed a second definition. That
// keeps the check honest — anything unmarked is still flagged — without
// rewriting working CSS to satisfy a grep.
const cssRaw = readFileSync("app/globals.css", "utf8").split("\n");
const cssAll = cssCode(readFileSync("app/globals.css", "utf8"));
const seen = new Map();
cssAll.forEach((l, i) => {
  // Only plain single-class selectors at the start of a rule; pseudo-classes,
  // descendants and compound selectors are legitimately repeated.
  const m = l.match(/^\.([a-zA-Z][\w-]*)\s*\{/);
  if (!m) return;
  const cls = m[1];
  if (!seen.has(cls)) { seen.set(cls, i + 1); return; }
  // Look back a few lines for the marker.
  // ⚠️ THE MARKER IS IN A COMMENT, so this one lookback reads the RAW file.
  const marked = cssRaw.slice(Math.max(0, i - 8), i)
    .some((x) => /deliberate-override/.test(x));
  if (marked) return;
  flag("A CLASS DEFINED TWICE IN globals.css", "app/globals.css", i + 1, l,
       `.${cls} is also defined at line ${seen.get(cls)} — merge them, or mark ` +
       "the block `deliberate-override` if the second definition is a " +
       "considered refinement; the cascade hides duplication until someone " +
       "edits one half.");
});

// ── 8 · A <details> WHOSE CONTENT NEVER COLLAPSES ─────────────────────────
//
// 🔴 THIS SHIPPED, AND READING THE JSX DENIED IT. The Pipelines screen renders
// each pipeline as `<details className="pfrow">` with no `open`, so the code
// says every row is collapsed. Measured in a browser: `OPEN at load: 0` and
// `chips VISIBLE: 8`. A closed <details> hides its children through the UA
// stylesheet, and ANY author `display:` rule on one of those children wins —
// `.pfseclist{display:grid}` did, so the chevron did nothing and the screen was
// ten expanded grids stacked.
//
// ⚠️ INVISIBLE IN REVIEW, because the markup is right and the CSS is right;
// only their interaction is wrong. That is precisely what a sweep is for.
const detailsBlocks = []; // { file, line, cls, children:Set<string> }
for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((l, i) => {
    if (!/<details\b/.test(l)) return;
    // ⚠️ THE OPENING TAG MAY SPAN LINES, and this rule missed its own motivating
    // case because it did not. `<details` + `className="pfrow"` on the next line
    // matched nothing, so the round-116 defect would have walked straight past
    // the rule written to catch it. Verified by removing the fix and watching
    // the sweep stay silent.
    const head = lines.slice(i, i + 6).join(" ");
    const m = head.slice(0, head.indexOf(">") + 1 || undefined)
      .match(/className=[{"`]*["`]([a-zA-Z][\w-]*)/);
    if (!m) return;
    // 🔴 DIRECT CHILDREN ONLY, and that is not pedantry. The browser hides the
    // DIRECT children of a closed <details>; a class three levels down is
    // already inside something hidden and cannot defeat the collapse. Scanning
    // "the next 220 lines" flagged `.sechead` and `.istep` — two classes that
    // are nowhere near a direct child — and a false positive teaches the next
    // person to ignore this output.
    const openIndent = l.search(/\S/);
    const children = new Set();
    let sawSummary = false;
    for (let j = i + 1; j < lines.length; j++) {
      const cur = lines[j];
      const ind = cur.search(/\S/);
      if (ind <= openIndent && /^\s*<\/details>/.test(cur)) break;
      if (/<\/summary>/.test(cur)) { sawSummary = true; continue; }
      if (!sawSummary) continue;
      // A direct child opens at exactly one indent step in.
      if (ind !== openIndent + 2) continue;
      const cm = cur.match(/className=["`]([a-zA-Z][\w- ]*)["`]/);
      if (cm) for (const c of cm[1].split(/\s+/)) if (c) children.add(c);
    }
    detailsBlocks.push({ file: f, line: i + 1, cls: m[1], children });
  });
}
for (const d of detailsBlocks) {
  const guarded = cssAll.some((l) =>
    new RegExp(`\\.${d.cls}:not\\(\\[open\\]\\)`).test(l),
  );
  if (guarded) continue;
  const offenders = cssAll.filter((l) => {
    const m = l.match(/^\.([a-zA-Z][\w-]*)\s*\{([^}]*)/);
    if (m && d.children.has(m[1]) && /display\s*:/.test(m[2])) return true;
    const n = l.match(new RegExp(`^\\.${d.cls}\\s+\\.([\\w-]+)\\s*\\{([^}]*)`));
    return !!(n && d.children.has(n[1]) && /display\s*:/.test(n[2]));
  });
  if (!offenders.length) continue;
  flag("A <details> WHOSE CONTENT WILL NOT COLLAPSE", d.file, d.line,
       `<details className="${d.cls}">`,
       `${offenders[0].trim().slice(0, 70)} sets display on a DIRECT CHILD of ` +
       `.${d.cls}, which OVERRIDES the browser's collapse — the block renders ` +
       `open whatever the \`open\` attribute says. Add ` +
       `\`.${d.cls}:not([open]) > :not(summary){display:none}\`.`);
}

// ── 9 · A FETCH WHOSE METHOD THE TARGET ROUTE DOES NOT EXPORT ─────────────
//
// 🔴 THIS SHIPPED TWICE AND A PROOF PASSED OVER IT. "Credit this case" and the
// attributed row's value/status edit both sent PUT to /api/opportunities/[id],
// which exports PATCH and nothing else — so Next.js answered 405 with an empty
// body before any handler ran. 115c's proof asserted "EXACTLY ONE write · a PUT
// to an opportunity" and passed, because the fake answered any method.
//
// ⚠️ BOTH SIDES ARE IN THIS REPO, so this is decidable without running
// anything: read the methods a route file exports, read the methods the client
// sends to it, and compare.
import { existsSync } from "node:fs";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
/** "/api/opportunities/${id}/notes" -> app/api/opportunities/[id]/notes/route.ts */
const routeFileFor = (apiPath) => {
  const parts = apiPath.replace(/^\/api\//, "").split("/").filter(Boolean);
  const tryPath = (segs) => {
    const f = `app/api/${segs.join("/")}/route.ts`;
    return existsSync(f) ? f : null;
  };
  // Any `${...}` segment is a dynamic param; try the literal first, then the
  // single [id]-style folder that actually exists beside it.
  const candidates = [[]];
  for (const seg of parts) {
    const next = [];
    for (const c of candidates) {
      if (/\$\{/.test(seg)) {
        // Find whichever bracketed folder exists at this level.
        for (const guess of ["[id]", "[slug]", "[key]"]) next.push([...c, guess]);
      } else next.push([...c, seg]);
    }
    candidates.length = 0;
    candidates.push(...next);
  }
  for (const c of candidates) {
    const f = tryPath(c);
    if (f) return f;
  }
  return null;
};

for (const f of files) {
  const src = readFileSync(f, "utf8");
  src.split("\n").forEach((l, i) => {
    // `fetch("/api/…", { method: "X"` and apiFetch(`/api/…`, { method: "X"
    const m = l.match(/["`](\/api\/[^"`]+)["`]/);
    if (!m) return;
    // ⚠️ THE WINDOW MUST NOT CROSS INTO THE NEXT CALL. A flat 12 lines found a
    // `method:` belonging to a DIFFERENT fetch and reported it against this
    // URL — a false positive, which is the one thing a sweep must not produce.
    // Cut at whichever comes first: the end of this call, or the next /api/.
    const after = src.split("\n").slice(i, i + 12);
    const stop = after.findIndex(
      (ln, k) => k > 0 && (/^\s*\)[;,]?\s*$/.test(ln) || /["`]\/api\//.test(ln)),
    );
    const window = (stop > 0 ? after.slice(0, stop) : after).join(" ");
    const meth = window.match(/method:\s*"([A-Z]+)"/);
    if (!meth) return;                       // no method given -> GET
    const method = meth[1];
    if (!METHODS.includes(method)) return;
    const routeFile = routeFileFor(m[1].split("?")[0]);
    if (!routeFile) return;                  // cannot resolve -> say nothing
    const route = readFileSync(routeFile, "utf8");
    const exported = METHODS.filter((x) =>
      new RegExp(`export\\s+(async\\s+)?function\\s+${x}\\b`).test(route),
    );
    if (!exported.length) return;
    if (exported.includes(method)) return;
    flag("A FETCH USING A METHOD THE ROUTE DOES NOT EXPORT", f, i + 1, l.trim().slice(0, 80),
         `${method} ${m[1]} -> ${routeFile} exports only ${exported.join(", ")}. ` +
         "Next.js answers 405 with an EMPTY BODY before any handler runs, so " +
         "nothing in the app can explain it and no request reaches GoHighLevel.");
  });
}

// ── 10 · A NEGATIVE TOP MARGIN THAT WILL BE CLIPPED BY A SCROLL BOX ───────
// 🔴 ROUND 125, MEASURED: the contact-search failure message rendered at y=532
// inside a container whose content box started at y=540. `.rfmodal .rfdhint`
// carries margin-top:-8px so a hint tucks up under the field it explains — and
// `.rfhits` is overflow-y:auto. An overflow container CANNOT PAINT ABOVE ITS
// OWN CONTENT BOX, so the top of the first line was simply cut off. The message
// existed to stop somebody creating a duplicate, and the half that said why was
// the half that was missing.
//
// ⚠️ TWO INSTANCES, and the brief had seen one. This rule is what finds the
// third.
//
// It works on the SELECTORS, not on the DOM: a class that is given a negative
// top margin anywhere, and is also used inside a container that scrolls, is the
// shape. Reported as a shape to check rather than a certainty — the two can be
// in different subtrees, which is why the wording says "check", not "broken".
{
  const clipping = new Set();
  const negTop = new Set();
  // 🔴 BLOCKS, NOT LINES — and the first version of this rule was line-based
  // and therefore BLIND to the very declaration it was written for. `.rfhits`
  // spans two lines, with the selector on the first and `overflow-y:auto` on
  // the second, so a per-line scan never associated the two and the rule
  // reported clean on the exact shape round 125 fixed. Sweep rule 8 carries the
  // same warning in its own comment; I wrote it and then did it again.
  {
    const cssText = cssCode(readFileSync("app/globals.css", "utf8")).join("\n");
    for (const block of cssText.split("}")) {
      const at = block.indexOf("{");
      if (at < 0) continue;
      const sel = block.slice(0, at);
      const decl = block.slice(at + 1);
      const classes = sel.match(/\.[A-Za-z0-9_-]+/g) || [];
      if (/overflow(-y)?\s*:\s*(auto|scroll|hidden)/.test(decl))
        for (const c of classes) clipping.add(c);
      // margin:-8px 0 14px   or   margin-top:-8px
      if (/margin(-top)?\s*:\s*-/.test(decl)) for (const c of classes) negTop.add(c);
    }
  }
  const src2 = files
    .filter((f) => /\.tsx$/.test(f))
    .map((f) => ({ f, t: readFileSync(f, "utf8") }));
  for (const neg of negTop) {
    const negCls = neg.slice(1);
    for (const clip of clipping) {
      const clipCls = clip.slice(1);
      if (clipCls === negCls) continue;
      // Is the negative-margin class ever used INSIDE the clipping one?
      for (const { f, t } of src2) {
        const at = t.indexOf(`className="${clipCls}"`);
        if (at < 0) continue;
        // ⚠️ THE FIRST CHILD, NOT "anywhere inside". A negative top margin only
        // gets clipped when the element sits at the TOP of the scroll box; one
        // further down merely overlaps the sibling above it, which is what the
        // margin is FOR. A first pass flagged `.movebody … .rfdhint` — the
        // intended use — and a sweep that produces a false positive is worse
        // than no sweep. Rule 9 says so in its own comment.
        const window = t.slice(at + clipCls.length, at + 1400);
        const first = window.match(/className="([^"]*)"/);
        if (!first || !new RegExp(`\\b${negCls}\\b`).test(first[1])) continue;
        flag("A NEGATIVE TOP MARGIN INSIDE A CONTAINER THAT CLIPS",
             f, t.slice(0, at).split("\n").length, `.${clipCls} … .${negCls}`,
             `\`.${negCls}\` is given a negative top margin in globals.css and is ` +
             `rendered inside \`.${clipCls}\`, which clips. A scroll box cannot ` +
             "paint above its own content box, so the first line is cut off, not " +
             "scrolled to. Round 125 shipped this twice.");
        break;
      }
    }
  }
}

// ── 11 · A CLASS USED IN JSX AND DEFINED NOWHERE ──────────────────────────
//
// 🔴 THREE ROUNDS RUNNING. Round 120 shipped `.moveacts` and `.savemsg.ok`
// used everywhere and defined nowhere. Round 130 shipped `.pfunkname`, in a
// round about not repeating faults. Round 132 wrote `.moveback` and `.movego`
// into a new dialog — a backdrop with no `position:fixed` and a primary button
// with no colour, which renders as a dialog inlined into the page behind a
// plain-text button.
//
// ⚠️ ALL THREE WERE CAUGHT BY GREPPING THE STYLESHEET BY HAND, which is not a
// process. Each time the report said "the sweep only catches shapes it has
// already met". It has now met this one three times.
//
// ⚠️ STRING LITERALS ONLY — `className="a b c"` — and deliberately not template
// literals. A first pass split `className={...}` too and produced two dozen
// false positives out of interpolated variables (`isOver`, `sortKey`, `def`),
// and rule 9 already says a sweep that produces false positives is worse than
// no sweep. The conservative version catches every one of the five real faults.
//
// 🔴 AND THE FIRST RUN OF THIS RULE PRODUCED A FALSE POSITIVE ANYWAY — it
// matched `className="chips"` inside a COMMENT in app/page.tsx describing the
// bug that class once was. Two lines below a comment saying false positives are
// worse than no sweep. Comments are stripped first now, which is what every
// other rule in this file already does and this one did not.
//
// ⚠️ A CLASS USED AS A SELECTOR IN scripts/ IS NOT UNDEFINED, IT IS A HOOK.
// `.pffolders` and `.pfstages` style nothing and are load-bearing in
// section-grid-proof and pipeline-controls-proof, which address the section
// list through them. A marker with a job is not the fault this rule is for, and
// exempting them automatically beats a hand-kept ignore list that goes stale.
const cssText = readFileSync("app/globals.css", "utf8");
const cssDefined = new Set(
  [...cssText.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]),
);
const scriptText = readdirSync("scripts")
  .filter((n) => /\.mjs$/.test(n))
  .map((n) => readFileSync(`scripts/${n}`, "utf8"))
  .join("\n");
const isHook = (cls) =>
  new RegExp(`["'\`][^"'\`]*\\.${cls}\\b`).test(scriptText);
/** Comments out, so the rule cannot be triggered by prose about itself. */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
for (const f of files) {
  if (!/\.tsx$/.test(f)) continue;
  const src = stripComments(readFileSync(f, "utf8"));
  for (const m of src.matchAll(/className="([^"{}]+)"/g)) {
    for (const cls of m[1].trim().split(/\s+/)) {
      if (!cls || cssDefined.has(cls) || isHook(cls)) continue;
      const n = src.slice(0, m.index).split("\n").length;
      flag("A CLASS USED IN JSX AND DEFINED NOWHERE", f, n, m[0],
           `\`.${cls}\` appears in no rule in globals.css and in no proof ` +
           "selector. It renders as an unstyled element — which looks like a " +
           "layout bug, not a missing class, so it gets investigated as one. " +
           "Define it, or use the existing class that already means what you " +
           "meant, or delete it.");
    }
  }
}

console.log(
  findings
    ? `\n${findings} finding(s). Each is a shape that has already shipped broken.`
    : "\nNo loader, credential, trim, wall, tickbox or undefined-class shape matches a known defect. ✅",
);
console.log(
  "\n⚠️ A CLEAN SWEEP IS NOT A PROOF OF CORRECTNESS. It only says nothing " +
  "matches a defect we have already met. New shapes need new rules.",
);
process.exit(findings ? 1 : 0);
