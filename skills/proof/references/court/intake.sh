#!/usr/bin/env bash
# intake.sh <area> <round> — bring a juror's cases onto main WITHOUT its failing probe tests.
# Copies only files the juror ADDED under $COURT_DIR/jury (cases, evidence); stores each probe test as .txt evidence
# so main never carries a red test. Then commits, pushes, verifies origin, and (unless NO_RULE=1) sends the cases to the Judge.
set -euo pipefail
A="$1"; R="$2"; REPO="$(git rev-parse --show-toplevel)"; cd "$REPO"; source court.env
B="origin/jury/r$R-$A"; J="$COURT_DIR/jury"
[ "$(git rev-parse --abbrev-ref HEAD)" = "$MAIN_BRANCH" ] || { echo "NOT ON $MAIN_BRANCH"; exit 1; }
[ -z "$(git status --porcelain -- "$J")" ] || { echo "uncommitted changes under $J — commit rulings first"; exit 1; }
git fetch -q origin
for f in $(git diff --name-only --diff-filter=A "origin/$MAIN_BRANCH...$B" -- "$J"); do mkdir -p "$(dirname "$f")"; git show "$B:$f" > "$f"; done
P="$J/evidence/r$R-$A-probes"; mkdir -p "$P"; : > "$P/SOURCES.txt"
for f in $(git diff --name-only --diff-filter=AM "origin/$MAIN_BRANCH...$B" -- . ":!$J"); do
  git show "$B:$f" > "$P/$(basename "$f").txt"; echo "$f" >> "$P/SOURCES.txt"; done
printf '\nProbe tests from %s stored as .txt (not built on %s). Fixers restore them with: git checkout %s -- <path>\n' "$B" "$MAIN_BRANCH" "$B" >> "$P/SOURCES.txt"
git add "$J"; n=$(git diff --cached --name-only -- "$J/cases/r$R-$A-*.json" | wc -l | tr -d ' ')
git commit -q -m "Jury round $R ($A): $n cases filed, probe tests as evidence text" || true
git push -q origin "$MAIN_BRANCH"; git fetch -q
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$MAIN_BRANCH")" ] || { echo "PUSH DID NOT LAND"; exit 1; }
echo "origin/$MAIN_BRANCH: $(git log --oneline -1 "origin/$MAIN_BRANCH") ($n cases)"
ls $J/cases/r$R-$A-*.json >/dev/null 2>&1 || { echo "no cases for $A"; exit 0; }
[ -n "${NO_RULE:-}" ] && { echo "intake only (NO_RULE) — queue for the Judge"; exit 0; }
nohup "$(dirname "$0")/jury-rule.sh" $J/cases/r$R-$A-*.json > "${TMPDIR:-/tmp}/jury-r$R-$A.out" 2>&1 &
echo "ruling launched -> ${TMPDIR:-/tmp}/jury-r$R-$A.out"
