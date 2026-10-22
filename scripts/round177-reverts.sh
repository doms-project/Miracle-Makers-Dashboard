#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ROUND 177 — THE REVERTS.
#
# 🔴 A GREEN PROOF PROVES NOTHING UNTIL IT HAS BEEN SHOWN TO FAIL AGAINST THE
# PRE-FIX CODE. Each section puts back exactly one fault and re-runs
# round177-proof; a revert that stays green means the proof is not reaching
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
# Run: bash scripts/round177-reverts.sh
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
# with R177_LIB_ONLY=1 (seconds, no dev server); only the ones that can ONLY go
# red in a browser pay for one. ONLY=H,J runs just those sections.
run() {
  local label="$1" out code n
  if [ "${MODE:-full}" = lib ]; then
    out=$(R177_LIB_ONLY=1 timeout 300 npx tsx scripts/round177-proof.mjs 2>&1)
  else
    out=$(timeout 600 npx tsx scripts/round177-proof.mjs 2>&1)
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

MODE=lib section "1 · staff pipelines listed under Caregivers" lib/recruitingSidebar.ts \
'    out[groupOf(groups, p.id)].push({' \
'    out.caregiver.push({'

MODE=full section "2 · an All entry under Recruiting" app/page.tsx \
'          {cgSidebarLoading
            ? [0, 1].map' \
'          <button type="button" className="railpipe" data-pipeline="all-recruiting" onClick={() => setView("caregivers")}><span className="railpipename">All applicants</span></button>
          {cgSidebarLoading
            ? [0, 1].map'

MODE=lib section "3 · entries built with selectableFor (home only)" lib/recruitingSidebar.ts \
'  return cgPipelines.filter((p) => home.has(p.id) || inData.has(p.id));' \
'  void inData;
  return cgPipelines.filter((p) => home.has(p.id));'

MODE=full section "4 · the checkbox client-only again" components/PipelineAdmin.tsx \
'{entry?.scope === "client" || entry?.scope === "caregiver" ? (' \
'{entry?.scope === "client" ? ('

MODE=lib section "5 · a failed caregiver pipeline reads 0" lib/recruitingSidebar.ts \
'  for (const p of visible) counts[p.id] = failedIds.has(p.id) ? null : per.get(p.id) || 0;' \
'  for (const p of visible) counts[p.id] = per.get(p.id) || 0;'

MODE=lib section "6 · the click always sets the group" lib/recruitingSidebar.ts \
'    cgGroup: s.cgGroup === "all" ? "all" : groupOf(groups, id),' \
'    cgGroup: groupOf(groups, id),'

MODE=lib section "7 · a pick outside the group is drawn anyway (B7)" lib/recruitingSidebar.ts \
'  if (cgPipeline !== "all" && groupList.some((p) => p.id === cgPipeline)) return cgPipeline;' \
'  if (cgPipeline !== "all") return cgPipeline;'

MODE=full section "9 · the caregiver load is lazy again" app/page.tsx \
'      (clientSettled || view === "caregivers") &&' \
'      view === "caregivers" &&'

MODE=full section "10 · two caregiver loads per page load" app/page.tsx \
'      (clientSettled || view === "caregivers") &&
      !cgLoaded &&
      !cgTried.current &&' \
'      (clientSettled || view === "caregivers") &&'

MODE=full section "11 · the default is expanded again" app/page.tsx \
'    let pref: "collapsed" | "expanded" = "collapsed";
    try {
      if (window.localStorage.getItem(RAIL_KEY) === "expanded") pref = "expanded";' \
'    let pref: "collapsed" | "expanded" = "expanded";
    try {
      if (window.localStorage.getItem(RAIL_KEY) === "collapsed") pref = "collapsed";'

MODE=full section "12 · no inline script — the collapse is read after hydration" app/layout.tsx \
'if(localStorage.getItem("mm.rail")==="expanded"&&' \
'if(false&&'

MODE=lib section "13 · the default landing picks a hidden pipeline" lib/recruitingSidebar.ts \
'    groupList.find((p) => !isHiddenFromSidebar(hidden, p.id))?.id ||
' \
''

MODE=full section "14 · one shared hidden map (the caregiver load writes the client one)" app/page.tsx \
'      setCgSidebarHidden(b.pipelineSidebarHidden);
      setCgFailedPipelines' \
'      setPipelineSidebarHidden(b.pipelineSidebarHidden);
      setCgFailedPipelines'

MODE=full section "15 · the failed banner is client-only again" app/page.tsx \
'              {cgFailedPipelines.length ? (' \
'              {false ? ('

MODE=full section "16 · the client dropdown counts REASSIGN and reads 0 for a failed one" app/page.tsx \
'                    {sidebar.counts[p.id] == null ? "didn'"'"'t load" : sidebar.counts[p.id]})' \
'                    {data.filter((r) => r.pipelineId === p.id).length})'

MODE=full section "A1a · collapsed hides the failed marker" app/globals.css \
'html:not([data-rail="expanded"]) .rail .railpipe.failed .railpipeini{color:var(--gold);}
html:not([data-rail="expanded"]) .rail .railpipe.failed::after{' \
'html:not([data-rail="expanded"]) .rail .railpipe.failed .railpipeini{}
html:not([data-rail="expanded"]) .rail .railpipe.failed::after{display:none;'

MODE=full section "A1b · collapsed hides Open Recruiting" app/globals.css \
'html:not([data-rail="expanded"]) .rail .railopen{justify-content:center;padding:0;height:34px;}' \
'html:not([data-rail="expanded"]) .rail .railopen{display:none;}'

MODE=full section "A1c · a Recruiting entry's title loses its count" app/page.tsx \
'                        title={e.failed ? `${e.name} — didn'"'"'t load` : `${e.name} — ${e.count}`}' \
'                        title={e.failed ? `${e.name} — didn'"'"'t load` : e.name}'

MODE=full section "M9 · the board stays put after an add" app/page.tsx \
'              setCgPipeline(landedIn);
' \
''

MODE=full section "Q4 · Refresh fires both at once" app/page.tsx \
'                    cgTried.current = false;
                    await loadCaregivers();
                    await load();' \
'                    cgTried.current = false;
                    void loadCaregivers();
                    void load();'

MODE=full section "R4 · a move to none keeps sidebar:false" components/PipelineAdmin.tsx \
'            if (next === "none") {' \
'            if (next === "never") {'

MODE=lib section "R5 · the refusal says older again" app/api/admin/pipelines/route.ts \
'`This page is from a different version of the dashboard `' \
'`This page is from an older version of the dashboard `'

echo
echo "All files restored."
