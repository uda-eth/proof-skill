#!/usr/bin/env bash
# The Judge (Codex) reviews one gate. Usage: judge.sh <gate-file-name> [commit] [image ...]
# <gate-file-name> must match $COURT_DIR/judge/gates/<name>.md exactly (e.g. G2-recorder, not G2).
set -euo pipefail
GATE="$1"; COMMIT="${2:-HEAD}"; shift || true; shift || true
REPO="$(git rev-parse --show-toplevel)"; source "$REPO/court.env"
C="$REPO/$COURT_DIR/judge"
[ -f "$C/gates/$GATE.md" ] || { echo "no gate file $C/gates/$GATE.md"; ls "$C/gates"; exit 1; }
SHA="$(git -C "$REPO" rev-parse "$COMMIT")"; TS="$(date -u +%Y%m%dT%H%M%SZ)"
WT="${JUDGE_WORKTREE_ROOT:-${TMPDIR:-/tmp}}/judge-$GATE-${SHA:0:8}"
rm -rf "$WT"; git -C "$REPO" worktree prune; git -C "$REPO" worktree add --detach "$WT" "$SHA" >/dev/null
mkdir -p "$C/verdicts"; OUT="$C/verdicts/$GATE-$TS.json"; LOG="$C/verdicts/$GATE-$TS.log"
PROMPT="$(cat "$C/JUDGE.md")

---
# Gate: $GATE   (commit $SHA)
$(cat "$C/gates/$GATE.md")

## Previous verdicts for this gate (check that their blocking items are fixed)
$(ls "$C"/verdicts/$GATE-*.json 2>/dev/null | tail -3 | xargs -I{} sh -c 'echo "### {}"; cat "{}"' || echo none)

You are the Judge. Work read-only against the source; you may build ($BUILD_CMD) and run tests in this worktree.
${REFERENCE_DIR:+The reference ($REFERENCE_NAME) is at $REFERENCE_DIR (read-only). Compare against its source, not against docs describing it.}
Be rigorous and specific; cite files and lines. Return only the JSON verdict."
IMGS=(); for i in "$@"; do IMGS+=(-i "$(cd "$(dirname "$i")" && pwd)/$(basename "$i")"); done
ADD=(); [ -n "${REFERENCE_DIR:-}" ] && ADD=(--add-dir "$REFERENCE_DIR")
codex exec -C "$WT" -s workspace-write -c sandbox_workspace_write.network_access=true \
  -c model_reasoning_effort=\"$JUDGE_EFFORT\" --skip-git-repo-check ${ADD[@]+"${ADD[@]}"} \
  --output-schema "$C/verdict.schema.json" -o "$OUT" ${IMGS[@]+"${IMGS[@]}"} \
  < <(printf '%s' "$PROMPT") > "$LOG" 2>&1 || true
# codex sometimes prints the verdict without writing -o: recover the last verdict JSON from the log.
if [ ! -s "$OUT" ]; then python3 - "$LOG" "$OUT" <<'PY'
import json,re,sys
s=open(sys.argv[1],encoding='utf-8',errors='replace').read(); d=json.JSONDecoder(); best=None
for m in re.finditer(r'\{\s*"gate"',s):
    try:
        o,_=d.raw_decode(s[m.start():])
        if 'verdict' in o: best=o
    except Exception: pass
if best: json.dump(best,open(sys.argv[2],'w'),indent=2)
PY
fi
git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true
echo "$OUT"
if ! python3 -c "import json,sys;v=json.load(open(sys.argv[1]));print(v['verdict'],'blocking:',len(v['blocking']));print(v['summary'])" "$OUT" 2>/dev/null; then
  echo "NO VERDICT (see $LOG)"; tail -5 "$LOG"
  grep -qi "usage limit" "$LOG" && echo "JUDGE RATE-LIMITED: $(grep -oi 'try again at [^.]*' "$LOG" | tail -1)"; exit 2
fi
