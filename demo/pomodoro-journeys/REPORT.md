# Proof — wedge pomodoro user journeys

## ✅ PROVEN — 17/17 assertions across 4 journeys

Against `http://localhost:4173` · 2026-07-19 · [interactive proof — watch the run](REPORT.html)

![journey replay](replay.gif)

| journey | promise | steps |
| --- | --- | ---: |
| [01-focus-cycle](#01-focus-cycle) | The core promise: a focus block runs, the wedge drains, and completion hands off to a break automatically | ✅ 7/7 |
| [02-pause-resume](#02-pause-resume) | Pause freezes the wedge exactly where it is; Resume continues from there | ✅ 3/3 |
| [03-slices-persist](#03-slices-persist) | A completed focus block earns a slice that survives a full reload | ✅ 4/4 |
| [04-reset-no-credit](#04-reset-no-credit) | Reset restores the full block — and never awards a slice for abandoned work | ✅ 3/3 |

### Before → after

Same journey step on the merge-base build (left) and this branch (right).

| step | before | after |
| --- | --- | --- |
| 01-focus-cycle<br>`idle-focus` | <img src="shots-baseline/01-focus-cycle/01-idle-focus.png" width="200"> | <img src="shots/01-focus-cycle/01-idle-focus.png" width="200"> |
| 01-focus-cycle<br>`focus-running` | <img src="shots-baseline/01-focus-cycle/02-focus-running.png" width="200"> | <img src="shots/01-focus-cycle/02-focus-running.png" width="200"> |
| 01-focus-cycle<br>`break-queued` | <img src="shots-baseline/01-focus-cycle/03-break-queued.png" width="200"> | <img src="shots/01-focus-cycle/03-break-queued.png" width="200"> |
| 02-pause-resume<br>`paused` | <img src="shots-baseline/02-pause-resume/01-paused.png" width="200"> | <img src="shots/02-pause-resume/01-paused.png" width="200"> |
| 02-pause-resume<br>`resumed` | <img src="shots-baseline/02-pause-resume/02-resumed.png" width="200"> | <img src="shots/02-pause-resume/02-resumed.png" width="200"> |
| 03-slices-persist<br>`one-slice-earned` | <img src="shots-baseline/03-slices-persist/01-one-slice-earned.png" width="200"> | <img src="shots/03-slices-persist/01-one-slice-earned.png" width="200"> |
| 03-slices-persist<br>`slice-persists-after-reload` | <img src="shots-baseline/03-slices-persist/02-slice-persists-after-reload.png" width="200"> | <img src="shots/03-slices-persist/02-slice-persists-after-reload.png" width="200"> |
| 04-reset-no-credit<br>`reset-full-block` | <img src="shots-baseline/04-reset-no-credit/01-reset-full-block.png" width="200"> | <img src="shots/04-reset-no-credit/01-reset-full-block.png" width="200"> |

## 01-focus-cycle

> The core promise: a focus block runs, the wedge drains, and completion hands off to a break automatically

- ⏸ (manual) grant notification permission — effect staged via API — a human performs this step in real use
- ✅ idle timer shows the full 25:00 focus block
- ✅ mode chip reads Focus
- ✅ primary control offers Start
- ✅ running: control flips to Pause
- ✅ running: wedge is draining (time below 00:04) — 00:03
- ✅ completion hands off to Break automatically
- ✅ break block queued at full 00:03

<img src="shots/01-focus-cycle/01-idle-focus.png" width="160"> <img src="shots/01-focus-cycle/02-focus-running.png" width="160"> <img src="shots/01-focus-cycle/03-break-queued.png" width="160">

## 02-pause-resume

> Pause freezes the wedge exactly where it is; Resume continues from there

- ✅ paused time does not move — 00:58
- ✅ control offers Resume while paused
- ✅ resume continues the countdown

<img src="shots/02-pause-resume/01-paused.png" width="160"> <img src="shots/02-pause-resume/02-resumed.png" width="160">

## 03-slices-persist

> A completed focus block earns a slice that survives a full reload

- ✅ empty state invites the first block
- ✅ one slice earned after completing a block
- ✅ the earned slice survives a reload
- ✅ empty-state prompt stays gone

<img src="shots/03-slices-persist/01-one-slice-earned.png" width="160"> <img src="shots/03-slices-persist/02-slice-persists-after-reload.png" width="160">

## 04-reset-no-credit

> Reset restores the full block — and never awards a slice for abandoned work

- ✅ reset restores the full block
- ✅ control returns to Start
- ✅ no slice awarded for an abandoned block

<img src="shots/04-reset-no-credit/01-reset-full-block.png" width="160">

## Viewport sweep

<img src="shots/viewports/1280x800.png" height="150"> <img src="shots/viewports/320x568.png" height="150"> <img src="shots/viewports/390x844.png" height="150"> <img src="shots/viewports/430x932.png" height="150"> <img src="shots/viewports/768x1024.png" height="150">
