# The Jury (bug-bounty swarm) and the Judge's rulings

Owner's rule: **no regression from <REFERENCE>.** A swarm of Jury agents hunts for regressions and files each one as a **case**. The **Judge** rules on every case. The final gate cannot pass while any VALID case is open.

## What counts as a regression
Anything a user of <REFERENCE> can do, see or rely on that <TARGET> does worse, does differently without an owner-approved reason, or doesn't do at all:
- functional behaviour
- privacy and security
- data integrity
- performance
- copy and UX flows
- error handling
- accessibility

Two things are **not** regressions:
- reference defects that the target deliberately fixes (`docs/REFERENCE-DEFECTS.md`);
- owner-accepted gaps (`docs/COMPATIBILITY.md` and the gate files).

## Jurors
There is one juror per area, and each round uses FRESH jurors (new agents, not the previous round's).
- A juror reads the reference and target sources side by side, and proves each finding with a targeted **failing probe test** plus file:line on both sides.
- A juror files a case only with evidence. Zero cases is an honest outcome.
- A juror never fixes code.

## Case format (`cases/r<round>-<area>-<nnn>.json`)
```json
{ "id": "r3-calls-004", "area": "calls", "title": "...",
  "category": "regression|missing-feature|privacy|security|data-loss|crash|performance|ux-parity|accessibility",
  "severity": "critical|high|medium|low",
  "reference_behavior": "what the reference does, file:line",
  "target_behavior": "what the target does, file:line",
  "repro": "deterministic steps or a failing test name",
  "evidence": "paths under evidence/<id>/",
  "proposed_fix": "..." }
```

## Rulings (`rulings/<case-id>.json`, written by the Judge)
| Ruling | Meaning |
|---|---|
| `VALID` | Must fix; includes the required fix, which is binding. |
| `INVALID` | Not a regression, or wrong. |
| `DUPLICATE` | Same as another case. |
| `ACCEPTED-GAP` | Only when the owner already accepted it. |
| `FIXED` / `STILL-OPEN` | Re-rulings after a fix is merged. |

A VALID case closes only when a fix is merged **and** the Judge re-rules it `FIXED`.

## Exit criterion (feeds the final gate)
One full round of fresh jurors files **zero new VALID cases**, and every earlier VALID case is FIXED.
