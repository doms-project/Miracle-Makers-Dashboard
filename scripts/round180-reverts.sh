#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ROUND 180 — THE REVERTS (the Agency Owner is an admin).
#
# 🔴 A GREEN PROOF PROVES NOTHING UNTIL IT HAS BEEN SHOWN TO FAIL AGAINST THE
# PRE-FIX CODE. Each section puts back exactly one fault and re-runs
# round180-proof; a revert that stays green means the proof is not reaching
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
# Run: bash scripts/round180-reverts.sh
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
  out=$(timeout 300 npx tsx scripts/${PROOF:-round180}-proof.mjs 2>&1)
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

section "R180-a · the rule accepts only \"admin\" again" lib/adminRole.ts \
  'export const ADMIN_ROLES: readonly string[] = ["admin", "owner"];' \
  'export const ADMIN_ROLES: readonly string[] = ["admin"];'

PROOF=sso-roles section "R180-a2 · same revert, seen by the round-179 probe self-test" lib/adminRole.ts \
  'export const ADMIN_ROLES: readonly string[] = ["admin", "owner"];' \
  'export const ADMIN_ROLES: readonly string[] = ["admin"];'

section "R180-b · the server keeps its own \"admin\"-only check" lib/visibility.ts \
  '  return isAdminRole(role);' \
  '  return role === "admin";'

section "R180-c · the browser keeps its own \"admin\"-only check (server fixed, admin UI still hidden)" app/page.tsx \
  '(sso.status === "ready" && isAdminRole(sso.session.role));' \
  '(sso.status === "ready" && sso.session.role === "admin");'

section "R180-d · the Access tab labels only \"admin\"" components/PipelineAccessTab.tsx \
  'const isAdmin = (u: User) => isAdminRole(u.role);' \
  'const isAdmin = (u: User) => u.role === "admin";'

section "R180-e · a fourth private copy appears elsewhere (referrals route)" app/api/referrals/route.ts \
  'import { isAdminSession } from "@/lib/visibility";' \
  'import { isAdminSession } from "@/lib/visibility";
const _r180Probe = (s: { role?: string }) => s.role === "admin";
void _r180Probe;'
