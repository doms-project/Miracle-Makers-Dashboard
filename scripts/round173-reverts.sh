#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ROUND 173 — THE REVERTS. Item 1 and the creation window.
#
# ⚠️ EACH ONE PROVES IT CHANGED BYTES FIRST. Round 171's section F came back
# green because a pattern had gone stale and matched nothing — rule 10.
#
# Run: bash scripts/round173-reverts.sh
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
  out=$(timeout 300 npx tsx scripts/round173-proof.mjs 2>&1)
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

echo "═══ A · search-then-upsert comes back (the v172 behaviour) ═══"
F="lib/existingPerson.ts"
save "$F"
# The pre-173 shape: decide from the lagging index, then UPSERT regardless.
perl -0pi -e 's/  try \{\n    const made = await createContact\(fields\);\n    return \{ ok: true, id: made\.id \};\n  \} catch \(e\) \{/  {\n    const pre = await checkExistingPerson({ phone: fields.phone, email: fields.email });\n    if (pre) return { ok: false, conflict: pre };\n    const g = await import("\@\/lib\/ghl");\n    const up = await g.upsertContact(fields);\n    return { ok: true, id: up.id };\n  }\n  try {\n    const made = await createContact(fields);\n    return { ok: true, id: made.id };\n  } catch (e) {/' "$F"
changed "$F" "A" && run "A"
restore "$F"

echo "═══ B · the refusal stops being treated as 'person exists' ═══"
save "$F"
perl -0pi -e 's/    if \(!isDuplicateRefusal\(e\)\) throw e;/    throw e;/' "$F"
changed "$F" "B" && run "B"
restore "$F"

echo "═══ C · an unidentifiable match goes through instead of refusing ═══"
save "$F"
perl -0pi -e 's/    if \(!id\)\n      return \{\n        ok: false,\n        conflict: \{/    if (!id)\n      return { ok: true, id: "c_went_through" };\n    if (false)\n      return {\n        ok: false,\n        conflict: {/' "$F"
changed "$F" "C" && run "C"
restore "$F"

echo "═══ D · the creation window goes back to two minutes ═══"
F="lib/stageKpi.ts"
save "$F"
perl -0pi -e 's/export const CREATION_WINDOW_MS = 300_000;/export const CREATION_WINDOW_MS = 120_000;/' "$F"
changed "$F" "D" && run "D"
restore "$F"

echo "═══ E · the creation check is dropped — every first row is a move ═══"
save "$F"
perl -0pi -e 's/        if \(isCreationRow\(row\.at, r\.createdAt\)\) \{/        if (false) {/' "$F"
changed "$F" "E" && run "E"
restore "$F"

echo
echo "All files restored."
