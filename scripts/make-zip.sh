#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# THE ROUND ZIP.
#
# 🔴 ROUND 153 — THIS EXISTS BECAUSE THE ARCHIVE LIVED IN A SHELL HISTORY.
# The exclusion list was retyped by hand every round, which is how
# `scripts/*.png` stayed in it for fifty rounds. Same reasoning as
# scripts/regression.txt in round 149: a list that matters belongs in the repo,
# not in whatever terminal happened to run it.
#
# 🔴 WHY THE SCREENSHOTS GO. Round 152's zip truncated in transfer three times
# — 1,991,151 / 1,293,427 / 1,462,549 bytes against 3,238,393. The eleven PNGs
# under scripts/ are 1.68 MB of that, FIFTY-TWO PER CENT of the archive, and
# they are the one part of it nobody has ever opened.
#
# ⚠️ AND THEY ARE WRITE-ONLY. Every one is a `page.screenshot({path})` output
# from a browser proof; grep finds them being WRITTEN by the proofs and read by
# nothing. They are regenerated whenever their proof runs, so excluding them
# loses nothing that cannot be remade in a minute — and they grow by one with
# every browser proof added, which is why this needed a permanent answer rather
# than a bigger transfer.
#
# ⚠️ THEY STAY IN THE REPOSITORY. Removing eleven committed files is a separate
# decision from leaving them out of a transfer, and it is not this script's to
# make. But nothing reads them, so `scripts/*.png` in .gitignore is the obvious
# next step if anyone wants the repo smaller too.
#
# Usage:  bash scripts/make-zip.sh 153
# ---------------------------------------------------------------------------
set -euo pipefail

ROUND="${1:?usage: make-zip.sh <round-number>}"

cd "$(dirname "$0")/.."

# ═══ ROUND 156 — TWO ARCHIVES, BECAUSE SIZE WAS NOT THE WALL ════════════════
#
# 🔴 FOUR TRUNCATIONS ACROSS THREE ROUNDS, at 1.29 / 1.38 / 1.46 / 1.99 MB,
# against archives of 3.24 MB and 1.58 MB. Halving the archive did not fix it
# and the cut lands in a different place every time, so this is the transfer
# failing part-way rather than a size limit being hit.
#
# ⚠️ SO THE SPLIT IS NOT "SMALLER", IT IS "INDEPENDENTLY USEFUL". Two transfers
# each have their own chance of landing, and the CODE half is the one that has
# to arrive: if it does, the round can be verified without the other. The
# reports and proofs are the record, valuable and re-sendable.
#
#   <name>-code.zip     app/ components/ lib/ + the root config files
#   <name>-docs.zip     scripts/ and V2-REPORT-*.md
#
# 🔴 EVERY FILE LANDS IN EXACTLY ONE OF THEM AND THE SCRIPT PROVES IT. A split
# that silently drops a file is worse than a truncation, because a truncation
# announces itself. The count below is checked against the single-archive
# listing, and the build fails if they disagree.
#
# ═══ ROUND 164 — THE SINGLE ARCHIVE IS NOW KEPT, NOT DELETED ════════════════
#
# 🔴 IT WAS ALREADY BEING BUILT EVERY ROUND AND THROWN AWAY. The split check
# needs a reference listing, so a complete archive existed at /tmp for the
# length of one `rm -f`. Asking for the full repo was therefore asking for a
# file the script had just deleted — and the reflex answer, a hand-typed `zip`
# at the prompt, is exactly the retyped-exclusion-list failure round 153 exists
# to stop. It is the same bytes either way; only the `rm` changes.
#
# ⚠️ ALL THREE ARE EMITTED EVERY ROUND, and which one to send is the reader's
# choice, not the script's: FULL when it lands, the two halves when it does not.
# The halves keep their reason — four truncations across three rounds, at sizes
# that ruled out a size limit — so this adds an option rather than retiring one.
CODE="miracle-makers-round${ROUND}-code.zip"
DOCS="miracle-makers-round${ROUND}-docs.zip"
ALL="miracle-makers-round${ROUND}-full.zip"

EXCLUDES=(
  -x 'node_modules/*' '*/node_modules/*'
     '.next/*' '*/.next/*'
     '.git/*'
     '.vercel/*'
     'test-results/*'
     '*.zip'
     'scripts/*.png'
     '*.tsbuildinfo'
)

rm -f "$CODE" "$DOCS" "$ALL"

# The whole tree in one file. Built FIRST so the two halves are checked against
# it, and `-x '*.zip'` keeps it out of them.
zip -rq "$ALL" . "${EXCLUDES[@]}"

# docs: the proofs and the round reports.
zip -rq "$DOCS" scripts V2-REPORT-*.md "${EXCLUDES[@]}"

# code: everything else. `-x` the docs paths rather than listing directories,
# so a new top-level file joins the CODE half by default — the half that must
# be complete for the round to be verifiable.
zip -rq "$CODE" . "${EXCLUDES[@]}" 'scripts/*' 'V2-REPORT-*.md'

count() { unzip -l "$1" | tail -1 | awk '{print $2}'; }
C=$(count "$CODE"); D=$(count "$DOCS"); A=$(count "$ALL")
for f in "$ALL" "$CODE" "$DOCS"; do
  echo "$f"
  echo "  bytes  $(stat -c %s "$f")"
  echo "  sha256 $(sha256sum "$f" | cut -d' ' -f1)"
  echo "  files  $(count "$f")"
  # ⚠️ `unzip -t` READS EVERY ENTRY BACK AND CHECKS ITS CRC. A zip that
  # truncated in transfer fails this, which is the whole point of printing the
  # byte count and the hash beside it: the receiving end can check the same two
  # numbers without unpacking anything.
  unzip -tq "$f" >/dev/null && echo "  integrity OK"
done
echo "  split check: $C code + $D docs = $((C + D)) · full archive $A"
if [ "$((C + D))" != "$A" ]; then
  echo "  🔴 THE SPLIT LOST OR DUPLICATED A FILE — do not send these."
  exit 1
fi
echo "  ✅ every file is in exactly one half, and FULL has all $A"
