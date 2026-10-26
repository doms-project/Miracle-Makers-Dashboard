#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ROUND 181 — THE REVERTS ("New lead" until opened · sidebar expanded by default).
#
# 🔴 A GREEN PROOF PROVES NOTHING UNTIL IT HAS BEEN SHOWN TO FAIL AGAINST THE
# PRE-FIX CODE. Each section puts back exactly one fault and re-runs
# round181-proof; a revert that stays green means the proof is not reaching
# the code (rule 10).
#
# ⚠️ EXACT-STRING EDITS, NOT REGEX. Round 171's section F came back green
# because a perl pattern had gone stale and matched nothing. `swap` below
# replaces one exact string and FAILS if that string is not there exactly
# once, and `changed()` then proves bytes moved before the result is believed.
#
# ⚠️ A CRASH IS NOT A PASSING REVERT: each section prints the FAIL count, and a
# non-zero exit with no FAIL line is reported as a crash.
#
# Run: bash scripts/round181-reverts.sh
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."
BK=$(mktemp -d)
trap 'for f in "$BK"/*; do b=$(basename "$f" | tr "%" "/"); cp "$f" "$b"; done; rm -rf "$BK"' EXIT

save() { cp "$1" "$BK/$(echo "$1" | tr '/' '%')"; }
restore() { cp "$BK/$(echo "$1" | tr '/' '%')" "$1"; }

# swap FILE OLD NEW — exact, once, or it says so.
swap() {
  OLD="$2" NEW="$3" python3 - "$1" <<'PY'
import os, sys
p = sys.argv[1]; s = open(p).read(); old = os.environ["OLD"]; new = os.environ["NEW"]
n = s.count(old)
if n != 1:
    print(f"  🔴 swap: expected the pattern once in {p}, found {n}")
    sys.exit(0)
open(p, "w").write(s.replace(old, new))
PY
}

changed() {
  if cmp -s "$1" "$BK/$(echo "$1" | tr '/' '%')"; then
    echo "  🔴 $2 — THE REVERT EDITED NOTHING. Its pattern is stale; the green below means nothing."
    return 1
  fi
  return 0
}

run() {
  local label="$1" out code n
  out=$(timeout 300 npx tsx scripts/${PROOF:-round181}-proof.mjs 2>&1)
  code=$?
  n=$(printf '%s\n' "$out" | grep -c '^  FAIL ')
  if [ "$n" -gt 0 ]; then
    echo "  ✅ $label — RED, $n assertion(s) failed"
    printf '%s\n' "$out" | grep '^  FAIL ' | head -4 | sed 's/^/       /'
  elif [ "$code" -ne 0 ]; then
    echo "  🔴 $label — CRASHED with no failures. A crash is not a passing revert."
    printf '%s\n' "$out" | tail -6 | sed 's/^/       /'
  else
    echo "  🔴 $label — STILL GREEN. The proof is not reaching the code (rule 10)."
  fi
}

section() { # label file old new
  echo "═══ $1 ═══"
  save "$2"
  swap "$2" "$3" "$4"
  changed "$2" "$1" && run "$1"
  restore "$2"
}

section "R181-a · a missing createdAt counts as new" lib/newLead.ts \
'  if (isNaN(created.getTime()) || isNaN(cutoff.getTime())) return false;' \
'  if (isNaN(cutoff.getTime())) return false;
  if (isNaN(created.getTime())) return true;'

section "R181-b · the open route skips the can-they-see-it check" "app/api/opportunities/[id]/opened/route.ts" \
'    if (!canSeeRecord(rec, session))' \
'    if (false && !canSeeRecord(rec, session))'

section "R181-c · a second open overwrites the first opener" lib/ghl.ts \
'  if (existing)
    return { recorded: false, value: encodeFirstOpened(existing.at, existing.userId), why: "already opened" };' \
''

section "R181-d · Recruiting is left out again (clients only)" app/api/opportunities/route.ts \
'  let newLeads: { tracking: boolean; since: string } | undefined;
  {' \
'  let newLeads: { tracking: boolean; since: string } | undefined;
  if (scope === "client") {'

section "R181-e · tracking assumed on with no field (labels that can never clear)" app/api/opportunities/route.ts \
'      tracking = !!(await firstOpenedFieldId());' \
'      tracking = true;'

section "R181-f · the sidebar still starts collapsed (the round 177 script)" app/layout.tsx \
'(function(){var c=false;try{c=localStorage.getItem("mm.rail")==="collapsed"}catch(e){}if(c||matchMedia("(max-width: 640px)").matches)document.documentElement.setAttribute("data-rail","collapsed")})()' \
'(function(){try{if(localStorage.getItem("mm.rail")==="expanded"&&!matchMedia("(max-width: 640px)").matches)document.documentElement.setAttribute("data-rail","expanded")}catch(e){}})()'

section "R181-g · blocked storage on a phone gives a wide sidebar (width check inside the try)" app/layout.tsx \
'(function(){var c=false;try{c=localStorage.getItem("mm.rail")==="collapsed"}catch(e){}if(c||matchMedia("(max-width: 640px)").matches)document.documentElement.setAttribute("data-rail","collapsed")})()' \
'(function(){try{if(localStorage.getItem("mm.rail")==="collapsed"||matchMedia("(max-width: 640px)").matches)document.documentElement.setAttribute("data-rail","collapsed")}catch(e){}})()'

section "R181-h · the panel only clears client leads (Recruiting forgotten)" app/page.tsx \
'    const setList = inClients ? setData : setCgData;' \
'    const setList = setData;'

section "R181-i · the field shows up in the record panel" lib/fieldFolders.ts \
'  // ROUND 181 — `<iso>|<userId>`, machine-written once; the "New lead" label is
  // how people see it.
  "First Opened",' \
''
