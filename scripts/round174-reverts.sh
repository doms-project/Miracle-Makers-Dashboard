#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ROUND 174 — THE REVERTS. One per calculation, plus the refusal's matchingField.
#
# ⚠️ EACH SECTION PROVES IT CHANGED BYTES FIRST — round 171's section F came
# back green because a pattern had gone stale and matched nothing (rule 10).
#
# Run: bash scripts/round174-reverts.sh
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."
BK=$(mktemp -d)
trap 'for f in "$BK"/*; do b=$(basename "$f" | tr "%" "/"); cp "$f" "$b"; done; rm -rf "$BK"' EXIT
save() { cp "$1" "$BK/$(echo "$1" | tr '/' '%')"; }
restore() { cp "$BK/$(echo "$1" | tr '/' '%')" "$1"; }
changed() {
  if cmp -s "$1" "$BK/$(echo "$1" | tr '/' '%')"; then
    echo "  🔴 $2 — THE REVERT EDITED NOTHING. Its pattern is stale; any green below means nothing."
    return 1
  fi
  return 0
}
run() {
  local label="$1" script="$2" out code n
  out=$(timeout 300 npx tsx "$script" 2>&1)
  code=$?
  n=$(printf '%s\n' "$out" | grep -c '^  FAIL ')
  if [ "$n" -gt 0 ]; then
    echo "  ✅ $label — RED, $n assertion(s) failed"
    printf '%s\n' "$out" | grep '^  FAIL ' | head -6 | sed 's/^/       /'
  elif [ "$code" -ne 0 ]; then
    echo "  🔴 $label — CRASHED with no failures. A crash is not a passing revert."
    printf '%s\n' "$out" | tail -4 | sed 's/^/       /'
  else
    echo "  🔴 $label — STILL GREEN. The proof is not reaching the code (rule 10)."
  fi
}

K="lib/stageKpi.ts"
P="scripts/round174-proof.mjs"

echo "═══ A · the funnel trusts declaration order instead of positions ═══"
save "$K"
perl -0pi -e 's/  return \[\.\.\.stages\]\.sort\(\(a, b\) => \{/  return [...stages];\n  return [...stages].sort((a, b) => {/' "$K"
changed "$K" "A" && run "A" "$P"
restore "$K"

echo "═══ B · the funnel counts a case's current stage as 'reached' ═══"
save "$K"
perl -0pi -e 's/      let top = -1;/      let top = -1;\n      { const p = posOf.get(r.stageId); if (p !== undefined) { reached.get(r.stageId)?.add(r.id); if (p > top) top = p; } }/' "$K"
changed "$K" "B" && run "B" "$P"
restore "$K"

echo "═══ C · 'moved on' needs the immediately next stage ═══"
save "$K"
perl -0pi -e 's/          if \(p < top && reached\.get\(sid\)\?\.has\(r\.id\)\) movedOn\.get\(sid\)\?\.add\(r\.id\);/          if (p === top - 1 \&\& reached.get(sid)?.has(r.id)) movedOn.get(sid)?.add(r.id);/' "$K"
changed "$K" "C" && run "C" "$P"
restore "$K"

echo "═══ D · pct falls back to 0 instead of null ═══"
save "$K"
perl -0pi -e 's/          pct: hit\.size \? Math\.round\(\(on\.size \/ hit\.size\) \* 100\) : null,/          pct: hit.size ? Math.round((on.size \/ hit.size) * 100) : 0,/' "$K"
changed "$K" "D" && run "D" "$P"
restore "$K"

echo "═══ E · time in stage counts the OPEN stay as if finished ═══"
save "$K"
perl -0pi -e 's/    for \(let i = 0; i < rows\.length - 1; i\+\+\) \{/    for (let i = 0; i < rows.length; i++) {\n      if (i === rows.length - 1) { const a2 = Date.parse(rows[i].at); if (Number.isFinite(a2)) { let c2 = per.get(rows[i].to); if (!c2) { c2 = { days: [], ids: new Set() }; per.set(rows[i].to, c2); } c2.days.push(Math.round(((now - a2) \/ 86400000) * 10) \/ 10); c2.ids.add(r.id); } continue; }/' "$K"
changed "$K" "E" && run "E" "$P"
restore "$K"

echo "═══ F · the approximate cases are averaged in with the measured ones ═══"
save "$K"
perl -0pi -e 's/      if \(Number\.isFinite\(t\) && now >= t\) \{\n        const d = Math\.floor\(\(now - t\) \/ 86_400_000\);\n        approx\.push\(d\);\n        approxIds\.push\(r\.id\);\n      \}/      if (Number.isFinite(t) \&\& now >= t) {\n        const d = Math.floor((now - t) \/ 86_400_000);\n        let c3 = per.get(r.stageId);\n        if (!c3) { c3 = { days: [], ids: new Set() }; per.set(r.stageId, c3); }\n        c3.days.push(d); c3.ids.add(r.id);\n      }/' "$K"
changed "$K" "F" && run "F" "$P"
restore "$K"

echo "═══ G · first move is credited to the RECORD's owner ═══"
save "$K"
perl -0pi -e 's/    const who = first\.ownerId \|\| "";/    const who = r.ownerId || "";/' "$K"
changed "$K" "G" && run "G" "$P"
restore "$K"

echo "═══ H · the creation row counts as the first move ═══"
save "$K"
perl -0pi -e 's/  return parseStageHistory\(r\.cf\[historyFieldId\]\)\.filter\(\n    \(row\) => !isCreationRow\(row\.at, r\.createdAt\),\n  \);/  return parseStageHistory(r.cf[historyFieldId]);/' "$K"
changed "$K" "H" && run "H" "$P"
restore "$K"

echo "═══ I · won/lost ignores the window ═══"
save "$K"
perl -0pi -e 's/    if \(!inRange\(at, opts\.window\)\) continue;\n    const who = r\.ownerId \|\| "";/    const who = r.ownerId || "";/' "$K"
changed "$K" "I" && run "I" "$P"
restore "$K"

echo "═══ J · an undated closed case is placed in the period anyway ═══"
save "$K"
perl -0pi -e 's/    if \(!at\) \{\n      \/\/ 🔴 COUNTED AND NAMED/    if (false) {\n      \/\/ 🔴 COUNTED AND NAMED/' "$K"
perl -0pi -e 's/  if \(!w \|\| \(!w\.from && !w\.to\)\) return true;\n  const t = Date\.parse\(at\);\n  if \(!Number\.isFinite\(t\)\) return false;/  if (!w || (!w.from \&\& !w.to)) return true;\n  const t = Date.parse(at);\n  if (!Number.isFinite(t)) return true;/' "$K"
changed "$K" "J" && run "J" "$P"
restore "$K"

echo "═══ K · the week starts on Sunday ═══"
save "$K"
perl -0pi -e 's/    const dow = \(d\.getUTCDay\(\) \+ 6\) % 7;/    const dow = d.getUTCDay();/' "$K"
changed "$K" "K" && run "K" "$P"
restore "$K"

echo "═══ L · the refusal's matchingField is ignored (guess from presence) ═══"
F="lib/existingPerson.ts"
save "$F"
perl -0pi -e 's/    const field = \(err\?\.dupField \|\| ""\)\.toLowerCase\(\);/    const field = "";/' "$F"
changed "$F" "L" && run "L" "scripts/round173-proof.mjs"
restore "$F"

echo
echo "All files restored."
