#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ROUND 175 — THE REVERTS. One per item.
#
# ⚠️ EACH SECTION PROVES IT CHANGED BYTES FIRST — round 171's section F came
# back green because a pattern had gone stale and matched nothing (rule 10).
#
# Run: bash scripts/round175-reverts.sh
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
  local label="$1" out code n
  out=$(timeout 300 npx tsx scripts/round175-proof.mjs 2>&1)
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

W="app/api/webhooks/ghl/route.ts"
C="lib/webhookCase.ts"
L="lib/recruitingLabels.ts"
R="lib/referrals.ts"

echo "═══ A · the webhook reads the CONTACT's owner again (the live bug) ═══"
save "$W"
perl -0pi -e 's/      const rec = await getOpportunityById\(caseId\)\.catch\(\(\) => null\);\n      ownerId = rec\?\.ownerId \|\| "";/      ownerId = contactOwner;/' "$W"
changed "$W" "A" && run "A"
restore "$W"

echo "═══ B · setOwner is ignored — the case owner is never set ═══"
save "$W"
perl -0pi -e 's/  const setOwner = new URL\(request\.url\)\.searchParams\.get\("setOwner"\) === "1";/  const setOwner = false;/' "$W"
changed "$W" "B" && run "B"
restore "$W"

echo "═══ C · setOwner writes without reading back (a 200 is a success) ═══"
save "$W"
perl -0pi -e 's/      const after = await getOpportunityById\(caseId\)\.catch\(\(\) => null\);\n      if \(!after \|\| after\.ownerId !== contactOwner\)/      const after = { ownerId: contactOwner };\n      if (false)/' "$W"
changed "$W" "C" && run "C"
restore "$W"

echo "═══ D · the payload's id is trusted without checking it is a case ═══"
save "$W"
perl -0pi -e 's/        idIsOpp = !!\(await getOpportunityById\(oppId\)\);/        idIsOpp = true;/' "$W"
changed "$W" "D" && run "D"
restore "$W"

echo "═══ E · the fallback ignores the pipeline — any newest case will do ═══"
save "$C"
perl -0pi -e 's/    \.filter\(\(c\) => c\.pipelineId === pipelineId\)\n    \.filter/    .filter((c) => true)\n    .filter/' "$C"
perl -0pi -e 's/  if \(!pipelineId\)\n    return \{\n      ok: false,/  if (false)\n    return {\n      ok: false,/' "$C"
changed "$C" "E" && run "E"
restore "$C"

echo "═══ F · the fallback ignores the time window ═══"
save "$C"
perl -0pi -e 's/      return Number\.isFinite\(t\) && now - t >= 0 && now - t <= RECENT_CASE_MS;/      return true;/' "$C"
changed "$C" "F" && run "F"
restore "$C"

echo "═══ G · a refused owner write is swallowed and the route carries on ═══"
save "$W"
perl -0pi -e 's/        return done\(\n          `setOwner refused: \$\{await explainGhlError\(e\)\} The case \$\{caseId\} is unchanged\.`,\n        \);/        void e;/' "$W"
changed "$W" "G" && run "G"
restore "$W"

echo "═══ H · ODP wording goes away — everyone reads Caregivers ═══"
save "$L"
perl -0pi -e 's/    group: odpOnly \? "DSPs" : "Caregivers",/    group: "Caregivers",/' "$L"
perl -0pi -e 's/      label: odpOnly \? "DSP applicants" : "Caregiver applicants",/      label: "Caregiver applicants",/' "$L"
changed "$L" "H" && run "H"
restore "$L"

echo "═══ I · a viewer with no recruiting pipelines reads as ODP-only ═══"
save "$L"
perl -0pi -e 's/  if \(!divs\.length\) return false;/  \/\/ every() on [] is true/' "$L"
changed "$L" "I" && run "I"
restore "$L"

echo "═══ J · a saved row is not held — the reload wipes it ═══"
save "$R"
perl -0pi -e 's/  const stillPending = pending\.filter\(\(p\) => p\.id && !known\.has\(p\.id\)\);/  const stillPending = [];/' "$R"
changed "$R" "J" && run "J"
restore "$R"

echo "═══ K · a pending row is held for ever, even once search returns it ═══"
save "$R"
perl -0pi -e 's/  const known = new Set\(fromServer\.map\(\(r\) => r\.id\)\);/  const known = new Set();/' "$R"
changed "$R" "K" && run "K"
restore "$R"

echo
echo "All files restored."
