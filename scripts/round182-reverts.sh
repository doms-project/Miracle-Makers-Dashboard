#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ROUND 182 — THE REVERTS (a First Opened field created after start-up).
#
# 🔴 A GREEN PROOF PROVES NOTHING UNTIL IT HAS BEEN SHOWN TO FAIL AGAINST THE
# PRE-FIX CODE. Each section puts back exactly one fault and re-runs
# round182-proof; a revert that stays green means the proof is not reaching
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
# Run: bash scripts/round182-reverts.sh
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
  out=$(timeout 300 npx tsx scripts/${PROOF:-round182}-proof.mjs 2>&1)
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

section "R182-a · no re-check: a missing field stays missing until the server restarts" lib/ghl.ts \
'  if (!def && Date.now() - firstOpenedLastRecheck >= FIRST_OPENED_RECHECK_MS) {' \
'  if (false && !def && Date.now() - firstOpenedLastRecheck >= FIRST_OPENED_RECHECK_MS) {'

section "R182-b · First Opened read through the (stale) name map again, not by id" app/api/opportunities/route.ts \
'        if (v.trim()) r.firstOpened = v;' \
'        void v;'

section "R182-c · the re-check is not throttled (a GoHighLevel call on every board load)" lib/ghl.ts \
'  if (!def && Date.now() - firstOpenedLastRecheck >= FIRST_OPENED_RECHECK_MS) {' \
'  if (!def) {'
