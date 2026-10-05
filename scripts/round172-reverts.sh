#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ROUND 172 — THE REVERTS.
#
# 🔴 A GREEN PROOF PROVES NOTHING UNTIL IT HAS BEEN SHOWN TO FAIL AGAINST THE
# PRE-FIX CODE. Each section puts back exactly one of round 172's three
# behaviours and re-runs the proof.
#
# ⚠️ AND EACH ONE PROVES IT CHANGED BYTES FIRST. Round 171's section F came
# back GREEN because a `perl` pattern had gone stale and matched nothing —
# rule 10, and the reason this guard now exists in both files.
#
# Run: bash scripts/round172-reverts.sh
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
  local label="$1"
  local out code n
  out=$(timeout 300 npx tsx scripts/round172-proof.mjs 2>&1)
  code=$?
  n=$(printf '%s\n' "$out" | grep -c '^  FAIL ')
  if [ "$n" -gt 0 ]; then
    echo "  ✅ $label — RED, $n assertion(s) failed"
    printf '%s\n' "$out" | grep '^  FAIL ' | head -8 | sed 's/^/       /'
  elif [ "$code" -ne 0 ]; then
    echo "  🔴 $label — CRASHED with no failures. A crash is not a passing revert."
    printf '%s\n' "$out" | tail -5 | sed 's/^/       /'
  else
    echo "  🔴 $label — STILL GREEN. The proof is not reaching the code (rule 10)."
  fi
}

F="lib/ghl.ts"

echo "═══ A · the \"show everyone\" fallback comes back ═══"
save "$F"
# The pre-172 last line: when nothing matched, return every hit instead.
perl -0pi -e 's/  const hits = matchCaseHolders\(\[\.\.\.byId\.values\(\)\], query\);/  let hits = matchCaseHolders([...byId.values()], query);\n  if (!hits.length) {\n    const everyone = await searchContacts(query);\n    hits = everyone.map((c) => ({ contactId: c.id, name: c.name, pipelineName: "", stage: "", more: 0 }));\n  }/' "$F"
changed "$F" "A" && run "A"
restore "$F"

echo "═══ B · the label test scans any custom field again ═══"
save "$F"
# The pre-172 scan: "Caregiver" in ANY field counts. Modelled by widening the
# label half to every contact carrying that string anywhere.
perl -0pi -e 's/  const res = await ghlSearchContacts\(rt\.id, CAREGIVER_RECORD_TYPE\);/  const res = { rows: [] };\n  for (const d of defs) {\n    try {\n      const got = await ghlSearchContacts(d.id, CAREGIVER_RECORD_TYPE);\n      res.rows.push(...got.rows);\n    } catch { \/* a field with no such value *\/ }\n  }/' "$F"
changed "$F" "B" && run "B"
restore "$F"

echo "═══ C · an applicant case stops counting — label only ═══"
save "$F"
perl -0pi -e 's/  const cases = await getCaregiverCaseRows\(\);/  const cases = [];/' "$F"
changed "$F" "C" && run "C"
restore "$F"

echo "═══ D · the picker is scoped to the viewer's grants after all ═══"
# 🔴 THE DECISION, NOT AN OMISSION — so it gets a revert like any behaviour.
# Scoping the caregiver list is what would leave a rep unable to link the
# caregiver actually doing the work.
F="app/api/opportunities/[id]/caregivers/search/route.ts"
save "$F"
perl -0pi -e 's/      const cg = await searchCaregiverContacts\(q\);/      const cgAll = await searchCaregiverContacts(q);\n      const cgRows = await getCaregiverCaseRows();\n      const cgMine = new Set(applyAccess(cgRows, { userId: session?.userId || "", isAdmin: !session || isAdminSession(session.role, session.type) }).map((r) => r.contactId));\n      const cg = { results: cgAll.results.filter((r) => cgMine.has(r.id)), labelsUnavailable: cgAll.labelsUnavailable };/' "$F"
perl -0pi -e 's/  searchCaregiverContacts,/  searchCaregiverContacts,\n  getCaregiverCaseRows,/' "$F"
changed "$F" "D" && run "D"
restore "$F"

echo "═══ E · the payload carries the contact's email again ═══"
F="lib/ghl.ts"
save "$F"
perl -0pi -e 's/    results: hits\.map\(\(h\) => \(\{\n      id: h\.contactId,\n      name: h\.name,/    results: hits.map((h) => ({\n      id: h.contactId,\n      name: h.name,\n      email: "leaked\@example.test",/' "$F"
changed "$F" "E" && run "E"
restore "$F"

echo "═══ F · a failed label half is reported as 'nobody matches' ═══"
save "$F"
perl -0pi -e 's/    labelsUnavailable = true;/    labelsUnavailable = false;/' "$F"
changed "$F" "F" && run "F"
restore "$F"

echo
echo "All files restored."
