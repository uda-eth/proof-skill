#!/usr/bin/env bash
# merge-fix.sh <fix-branch> "<test projects>" [case files...]
# Merge a fixer's branch into main, build, run the named test projects, and push ONLY if all green.
# On red: undo the merge (keeps uncommitted work — never `reset --hard`), log failing test names for flake tracking, exit non-zero.
# With case files and without NO_RULE=1: sends them to the Judge for re-ruling (FIXED / STILL-OPEN).
set -euo pipefail
B="$1"; P="$2"; shift 2; REPO="$(git rev-parse --show-toplevel)"; cd "$REPO"; source court.env
[ "$(git rev-parse --abbrev-ref HEAD)" = "$MAIN_BRANCH" ] || { echo "NOT ON $MAIN_BRANCH"; exit 1; }
FLAKY="${FLAKY_LOG:-$(git rev-parse --git-common-dir)/court-flaky-tests.log}"   # outside the work tree, so it never blocks undo
undo() { git merge --abort 2>/dev/null || git reset -q --merge ORIG_HEAD || { echo "UNDO FAILED - main still has the merge commit; fix by hand before anything else"; exit 5; }; }
git fetch -q origin
git merge --no-ff "origin/$B" -m "Merge $B (Jury fixes)" >/dev/null || { echo "MERGE CONFLICT (merge aborted; resolve on the fix branch):"; git diff --name-only --diff-filter=U; git merge --abort; exit 2; }
out=$(eval "$BUILD_CMD" 2>&1) || { echo "$out" | grep -iE " error " | sort -u | head -5; echo BUILD-FAILED; undo; exit 3; }
fail=0
for p in $P; do
  cmd="${TEST_CMD_FOR//\{p\}/$p}"; full=$(eval "$cmd" 2>&1 || true)
  r=$(echo "$full" | grep -iE "total:|failed:|passed!|failed!" | tr '\n' ' '); echo "$p: $r"
  echo "$full" | grep -E "^\s*failed [A-Z]" | head -5 | tee -a "$FLAKY" || true
  echo "$r" | grep -qiE "failed: *0\b|passed!" || fail=1
done
[ $fail = 0 ] || { echo "TESTS FAILED — merge undone, nothing pushed. Rerun once; a test that passes alone but fails here is a flake to ROOT-CAUSE, not retry forever."; undo; exit 4; }
git push -q origin "$MAIN_BRANCH"; git fetch -q
[ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$MAIN_BRANCH")" ] || { echo "PUSH DID NOT LAND"; exit 1; }
echo "origin/$MAIN_BRANCH: $(git log --oneline -1 "origin/$MAIN_BRANCH")"
[ $# -gt 0 ] && [ -z "${NO_RULE:-}" ] || exit 0
nohup "$(dirname "$0")/jury-rule.sh" "$@" > "${TMPDIR:-/tmp}/rerule-${B//\//-}.out" 2>&1 &
echo "re-ruling launched ($#)"
