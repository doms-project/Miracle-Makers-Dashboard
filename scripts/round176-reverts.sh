#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ROUND 176 — THE REVERTS.
#
# 🔴 A GREEN PROOF PROVES NOTHING UNTIL IT HAS BEEN SHOWN TO FAIL AGAINST THE
# PRE-FIX CODE. Each section puts back exactly one fault and re-runs
# round176-proof; a revert that stays green means the proof is not reaching
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
# Run: bash scripts/round176-reverts.sh
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

# ⚠️ QUICKER, NOT WEAKER. A revert whose red lands in Parts 1–5 runs the proof
# with R176_LIB_ONLY=1 (seconds, no dev server); only the ones that can ONLY go
# red in a browser (C, H, J) pay for one. ONLY=H,J runs just those sections.
run() {
  local label="$1" out code n
  if [ "${MODE:-full}" = lib ]; then
    out=$(R176_LIB_ONLY=1 timeout 300 npx tsx scripts/round176-proof.mjs 2>&1)
  else
    out=$(timeout 600 npx tsx scripts/round176-proof.mjs 2>&1)
  fi
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

section() { # label file old new   (MODE=lib|full set by the caller)
  local key="${1%% *}"
  if [ -n "${ONLY:-}" ] && ! printf ',%s,' "$ONLY" | grep -q ",$key,"; then return; fi
  echo "═══ $1 ═══"
  save "$2"
  swap "$2" "$3" "$4"
  changed "$2" "$1" && run "$1"
  restore "$2"
}

MODE=lib section "A · the parser forgets \`sidebar\`" lib/pipelineConfig.ts \
'    if (e.sidebar === false) base.sidebar = false;' \
'    void e.sidebar;'

MODE=lib section "B · the entries ignore the setting" lib/clientSidebar.ts \
'  const shown = selectable.filter((p) => !isHiddenFromSidebar(hidden, p.id));' \
'  const shown = selectable;'

MODE=lib section "B2 · hiding a tab also takes the records out of All clients" lib/clientSidebar.ts \
'    if (isExcluded(r)) continue;' \
'    if (isExcluded(r) || isHiddenFromSidebar(hidden, r.pipelineId)) continue;'

MODE=full section "C · the entries are built from config keys" app/page.tsx \
'        selectable: selectablePipelines,
        records: data,' \
'        selectable: [
          ...selectablePipelines,
          ...Object.keys(pipelineFolders ?? {})
            .filter((id) => !selectablePipelines.some((p) => p.id === id))
            .map((id) => ({ id, name: id })),
        ],
        records: data,'

MODE=lib section "D · counts include the REASSIGN record" lib/clientSidebar.ts \
'    if (isExcluded(r)) continue;
    all += 1;' \
'    all += 1;'

MODE=lib section "E · a failed pipeline reads 0" lib/clientSidebar.ts \
'      count: isFailed ? null : perPipeline.get(p.id) || 0,' \
'      count: perPipeline.get(p.id) || 0,'

MODE=lib section "F · withExclusion rebuilds the entry as {scope, folders}" lib/pipelineConfig.ts \
'  if (next.length) return { ...entry, exclude: next };
  const { exclude: _gone, ...rest } = entry;
  void _gone;
  return rest;' \
'  return next.length ? { ...entry, exclude: next } : { scope: entry.scope, folders: entry.folders };'

MODE=lib section "G · the click leaves scope and stage to the effects" lib/clientSidebar.ts \
'    scope: "all",
    stage: "all",' \
'    scope: s.scope,
    stage: s.stage,'

MODE=full section "H · the heading is a .railsec button again" app/page.tsx \
'          <h2 id="railhead-clients" className="railhead">
            Clients
          </h2>' \
'          <button type="button" id="railhead-clients" className="railsec" onClick={() => setView("board")}>
            Clients
          </button>'

MODE=lib section "I · hiding the selected pipeline does not reset it" lib/clientSidebar.ts \
'  return isHiddenFromSidebar(after, selected) && !isHiddenFromSidebar(before, selected)
    ? "all"
    : selected;' \
'  void before; void after;
  return selected;'

MODE=full section "J · the rail stops scrolling" app/globals.css \
'gap:3px;overflow-y:auto;overflow-x:hidden;min-height:0;}' \
'gap:3px;}'

# ⚠️ K FIRST CAME BACK GREEN, AND THE PROOF WAS RIGHT. It filtered
# `meta.pipelines`, which the signed-in response overwrites with the scoped
# list (`...meta` first, then `pipelines: scopedPipelines`) — a revert of code
# no signed-in viewer ever receives. Rule 10 read the other way: the revert
# missed, not the proof. It now filters what is actually sent.
MODE=lib section "K · the server filters records by the flag" app/api/opportunities/route.ts \
'    records: visible,' \
'    records: visible.filter((r) => !pipelineSidebarHidden?.[r.pipelineId]),'

MODE=lib section "K2 · the server filters the pipeline list by the flag" app/api/opportunities/route.ts \
'    pipelines: scopedPipelines,' \
'    pipelines: scopedPipelines.filter((p) => !pipelineSidebarHidden?.[p.id]),'

MODE=lib section "L · save-config takes a save from any build" app/api/admin/pipelines/route.ts \
'        if (String(body.build ?? "") !== BUILD.round)' \
'        if (String(body.build ?? "") === "never")'

MODE=lib section "M · the payload stops sending the map" app/api/opportunities/route.ts \
'    pipelineSidebarHidden,
    folderNames,' \
'    folderNames,'

echo
echo "All files restored."
