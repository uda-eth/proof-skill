#!/usr/bin/env bash
# The Judge rules on Jury cases. Usage: jury-rule.sh <case files...>
# Writes $COURT_DIR/jury/rulings/<case-id>.json (one per case) + batch-<ts>.json/.log. COMMIT THE RULINGS IMMEDIATELY.
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"; source "$REPO/court.env"; J="$REPO/$COURT_DIR/jury"
SHA="$(git -C "$REPO" rev-parse HEAD)"; TS="$(date -u +%Y%m%dT%H%M%SZ)"
WT="${JUDGE_WORKTREE_ROOT:-${TMPDIR:-/tmp}}/jury-${SHA:0:8}-$TS"; git -C "$REPO" worktree add --detach "$WT" "$SHA" >/dev/null
mkdir -p "$J/rulings"; OUT="$J/rulings/batch-$TS.json"; LOG="$J/rulings/batch-$TS.log"
CASES=""; for c in "$@"; do CASES+=$'\n\n### '"$c"$'\n'"$(cat "$c")"; done
PRIOR="$(for c in "$@"; do id=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['id'])" "$c"); f="$J/rulings/$id.json"; [ -f "$f" ] && { echo "### prior ruling $id"; cat "$f"; }; done; true)"
PROMPT="$(cat "$J/JURY.md")

You are the Judge ruling on Jury cases at commit $SHA (repo checked out in the current directory).
${REFERENCE_DIR:+The reference ($REFERENCE_NAME) is at $REFERENCE_DIR (read-only).} Verify every case yourself: read both sources, run tests, reproduce where you can.
Be strict both ways: reject speculative or wrong cases, confirm real regressions. For a case with a prior VALID ruling, rule FIXED only if the merged fix really resolves it, otherwise STILL-OPEN.
Cases:$CASES

Prior rulings:
${PRIOR:-none}

Return only the JSON."
ADD=(); [ -n "${REFERENCE_DIR:-}" ] && ADD=(--add-dir "$REFERENCE_DIR")
codex exec -C "$WT" -s workspace-write -c sandbox_workspace_write.network_access=true -c model_reasoning_effort=\"$JUDGE_EFFORT\" \
  --skip-git-repo-check ${ADD[@]+"${ADD[@]}"} --output-schema "$J/ruling.schema.json" -o "$OUT" \
  < <(printf '%s' "$PROMPT") > "$LOG" 2>&1 || true
if [ ! -s "$OUT" ]; then python3 - "$LOG" "$OUT" <<'PY'
import json,re,sys
s=open(sys.argv[1],encoding='utf-8',errors='replace').read(); d=json.JSONDecoder(); best=None
for m in re.finditer(r'\{\s*"rulings"',s):
    try: o,_=d.raw_decode(s[m.start():]); best=o
    except Exception: pass
if best: json.dump(best,open(sys.argv[2],'w'),indent=2)
PY
fi
git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true
if [ ! -s "$OUT" ]; then
  echo "NO RULINGS (see $LOG)"; grep -qi "usage limit" "$LOG" && echo "JUDGE RATE-LIMITED: $(grep -oi 'try again at [^.]*' "$LOG" | tail -1)"; exit 2
fi
python3 - "$OUT" "$J/rulings" <<'PY'
import json,sys,os
for r in json.load(open(sys.argv[1]))["rulings"]:
    json.dump(r,open(os.path.join(sys.argv[2],r["case_id"]+".json"),"w"),indent=2); print(r["case_id"],r["ruling"],r["severity"])
PY
