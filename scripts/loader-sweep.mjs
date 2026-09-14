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

// ── 6 · A SCROLLING FLEX CHILD WITH NO EXPLICIT MINIMUM ───────────────────
// Three separate symptoms from one rule: `.rfhits` collapsed to 0px, `.rfdbd`
// cut off its last row, `.movebody` clipped a modal at Owner. A flex item that
// scrolls needs `min-height:0`, or its automatic minimum keeps it at content
// size and the parent clips whatever does not fit.
const cssLines = readFileSync("app/globals.css", "utf8").split("\n");
cssLines.forEach((l, i) => {
  if (/^\s*\/\*|^\s*\*/.test(l)) return;
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
const css = readFileSync("app/globals.css", "utf8").split("\n");
css.forEach((l, i) => {
  if (/^\s*\/\*/.test(l)) return;
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
const cssAll = readFileSync("app/globals.css", "utf8").split("\n");
const seen = new Map();
cssAll.forEach((l, i) => {
  // Only plain single-class selectors at the start of a rule; pseudo-classes,
  // descendants and compound selectors are legitimately repeated.
  const m = l.match(/^\.([a-zA-Z][\w-]*)\s*\{/);
  if (!m) return;
  const cls = m[1];
  if (!seen.has(cls)) { seen.set(cls, i + 1); return; }
  // Look back a few lines for the marker.
  const marked = cssAll.slice(Math.max(0, i - 8), i)
    .some((x) => /deliberate-override/.test(x));
  if (marked) return;
  flag("A CLASS DEFINED TWICE IN globals.css", "app/globals.css", i + 1, l,
       `.${cls} is also defined at line ${seen.get(cls)} — merge them, or mark ` +
       "the block `deliberate-override` if the second definition is a " +
       "considered refinement; the cascade hides duplication until someone " +
       "edits one half.");
});

console.log(
  findings
    ? `\n${findings} finding(s). Each is a shape that has already shipped broken.`
    : "\nNo loader, credential, trim, wall or tickbox shape matches a known defect. ✅",
);
console.log(
  "\n⚠️ A CLEAN SWEEP IS NOT A PROOF OF CORRECTNESS. It only says nothing " +
  "matches a defect we have already met. New shapes need new rules.",
);
process.exit(findings ? 1 : 0);
