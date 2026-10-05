#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ROUND 171 — THE REVERTS.
#
# 🔴 A GREEN PROOF PROVES NOTHING UNTIL IT HAS BEEN SHOWN TO FAIL AGAINST THE
# PRE-FIX CODE. Each revert below puts back exactly one of the five bugs and
# the proof is re-run; a revert that comes back green means the assertion is
# not reaching the code (rule 10), not that the fix was unnecessary.
#
# ⚠️ A CRASH IS NOT A PASSING REVERT EITHER. A revert that produces a syntax
# error gives a non-zero exit for the wrong reason — round 170 shipped one of
# those — so each section prints the failure COUNT, and a count of zero with a
# non-zero exit is reported as a crash.
#
# Run: bash scripts/round171-reverts.sh
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."
BK=$(mktemp -d)
trap 'for f in "$BK"/*; do b=$(basename "$f" | tr "%" "/"); cp "$f" "$b"; done; rm -rf "$BK"' EXIT

save() { cp "$1" "$BK/$(echo "$1" | tr '/' '%')"; }
restore() { cp "$BK/$(echo "$1" | tr '/' '%')" "$1"; }

# 🔴 A REVERT THAT CHANGED NO BYTES IS NOT A REVERT. Section F came back GREEN
# on the first run of this file — not because the assertion was weak, but
# because a `perl -0pi -e` pattern had gone stale against an edit made an hour
# earlier and silently matched nothing. Rule 10, caught by the run rather than
# by reading: a revert that changes nothing is not a passing revert. So every
# section now proves it edited something BEFORE it believes the result.
changed() {
  if cmp -s "$1" "$BK/$(echo "$1" | tr '/' '%')"; then
    echo "  🔴 $2 — THE REVERT EDITED NOTHING. Its pattern is stale; the green below means nothing."
    return 1
  fi
  return 0
}

run() {
  local label="$1"
  local out
  out=$(timeout 300 npx tsx scripts/round171-proof.mjs 2>&1)
  local code=$?
  local n
  n=$(printf '%s\n' "$out" | grep -c '^  FAIL ')
  if [ "$n" -gt 0 ]; then
    echo "  ✅ $label — RED, $n assertion(s) failed"
    printf '%s\n' "$out" | grep '^  FAIL ' | head -4 | sed 's/^/       /'
  elif [ "$code" -ne 0 ]; then
    echo "  🔴 $label — CRASHED with no failures. A crash is not a passing revert."
    printf '%s\n' "$out" | tail -5 | sed 's/^/       /'
  else
    echo "  🔴 $label — STILL GREEN. The proof is not reaching the code (rule 10)."
  fi
}

echo "═══ A · the Clients picker filters Record Type again ═══"
F="app/api/opportunities/[id]/caregivers/search/route.ts"
save "$F"
# The pre-171 behaviour: whichever record is open, search caregivers.
perl -0pi -e 's/const openRecordIsCaregiver = cgPipes\.some\(\(p\) => p\.id === target\.pipelineId\);/const openRecordIsCaregiver = false;/' "$F"
changed "$F" "A" && run "A"
restore "$F"

echo "═══ B · people met are found by Record Type only ═══"
F="app/api/referrals/route.ts"
save "$F"
perl -0pi -e 's/const extra = await attendeesByEventField\(\n        attendeeEventField,\n        allEvents\.map\(\(e\) => e\.id\),\n      \);/const extra = { rows: [], via: "none" };/' "$F"
changed "$F" "B" && run "B"
restore "$F"

echo "═══ C · Record Type is written over an existing person again ═══"
F="app/api/referrals/route.ts"
save "$F"
perl -0pi -e 's/if \(rtDef && rtOption && !theirRecordType\.trim\(\)\)\n            writes\.push\(\{ id: rtDef\.id, value: rtOption \}\);/if (rtDef \&\& rtOption) writes.push({ id: rtDef.id, value: rtOption });/' "$F"
changed "$F" "C" && run "C"
restore "$F"

echo "═══ D · the create paths stop asking and just upsert ═══"
F="lib/existingPerson.ts"
save "$F"
perl -0pi -e 's/  const match = await findContactByEmailOrPhone\(\{ phone, email \}\);\n  if \(!match\) return null;/  const match = await findContactByEmailOrPhone({ phone, email });\n  if (!match) return null;\n  return null;/' "$F"
changed "$F" "D" && run "D"
restore "$F"

echo "═══ E · a first row is never a move again ═══"
F="lib/stageKpi.ts"
save "$F"
perl -0pi -e 's/        if \(isCreationRow\(row\.at, r\.createdAt\)\) \{\n          out\.creationRows \+= 1;\n          continue;\n        \}\n        out\.unknownOrigin \+= 1;/        out.creationRows += 1;\n        continue;/' "$F"
changed "$F" "E" && run "E"
restore "$F"

echo "═══ F · the case-manager headings stop depending on the view ═══"
F="lib/caseManagerLabels.ts"
save "$F"
perl -0pi -e 's/  return view === "manager"\n    \? \{ who: "Case manager", what: "Follows cases owned by" \}\n    : \{ who: "Case owner", what: "Their cases are followed by" \};/  void view;\n  return { who: "Case manager", what: "Follows cases owned by" };/' "$F"
changed "$F" "F" && run "F"
restore "$F"

echo
echo "All files restored."
