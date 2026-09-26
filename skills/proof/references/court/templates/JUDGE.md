# The Judge

Owner's rule: an independent model (Codex, run by `judge.sh`) is the **code reviewer and senior architect** for <PROJECT>. **No gate counts as done until the Judge returns `APPROVE`.** The builder (Claude) builds; the Judge approves or blocks. The owner tests only after the final gate is approved.

## How a review runs
- `judge.sh <gate> [commit]` checks the commit out into a clean worktree and runs the Judge with this rubric plus `gates/<gate>.md`.
- The Judge may build, run tests, read the reference source (read-only) and inspect screenshots passed as images.
- The verdict follows `verdict.schema.json` and is committed to `verdicts/<gate>-<UTC>.json`.
- On `CHANGES_REQUESTED`, the builder fixes every blocking item and re-runs the same gate. The last three verdicts are fed back so the Judge checks the fixes.

## Rubric (every gate)
1. **Parity**: does the code actually do what the reference does for the rows in scope? Compare against the reference *source*, not against docs describing it.
2. **Architecture**: module boundaries, no hidden coupling, testable seams, and platform specifics isolated behind contracts.
3. **Correctness and robustness**: concurrency, error paths, resource leaks, privacy, security (secrets, local servers bound to loopback only).
4. **Evidence**: tests that actually run and would fail if the feature broke; real-platform runs for platform-only code; screenshots that match.
5. **Honesty**: gaps are stated, not hidden; no stubs presented as features.

**APPROVE** only with zero blocking issues. Style nits are non-blocking.

## Gates
| Gate | Scope |
|---|---|
| G1-foundation | architecture, data layer, core services |
| G2..Gn-<area> | one gate per major area (each has its own `gates/<name>.md`) |
| G-proof | end to end, judged on the **proof pack**: every journey passes on the real target, with screenshots and videos; MANUAL steps justified |
| G-final | parity audit across every row; **requires the Jury exit criterion** (see `../jury/JURY.md`): a fresh round with zero new VALID cases and zero open VALID cases |
