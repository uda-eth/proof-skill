# Proof — wedge pomodoro user journeys

## ✅ PROVEN — 17/17 assertions across 4 journeys

Against `http://localhost:4173` · 2026-07-31 · [interactive proof — watch the run](REPORT.html)

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
- ✅ the timer is ready with a full 25-minute block — reads 25:00
- ✅ it starts in Focus mode, not on a break
- ✅ the main button invites her to Start
- ✅ the block is running — the button now offers Pause
- ✅ the countdown is ticking down — now at 00:03
- ✅ when the block ends it moves her to a break by itself
- ✅ the break starts fresh, at its full length — reads 00:03

<img src="shots/01-focus-cycle/01-idle-focus.png" width="160"> <img src="shots/01-focus-cycle/02-focus-running.png" width="160"> <img src="shots/01-focus-cycle/03-break-queued.png" width="160">

## 02-pause-resume

> Pause freezes the wedge exactly where it is; Resume continues from there

- ✅ while paused, the clock does not lose a second — still 00:57
- ✅ the button now offers to Resume
- ✅ it carries on from where it stopped, not from the top — resumed below 00:57

<img src="shots/02-pause-resume/01-paused.png" width="160"> <img src="shots/02-pause-resume/02-resumed.png" width="160">

## 03-slices-persist

> A completed focus block earns a slice that survives a full reload

- ✅ she has earned nothing yet, and the app says so
- ✅ finishing the block earns her a slice
- ✅ the slice she earned is still there
- ✅ and the app no longer says she has nothing

<img src="shots/03-slices-persist/01-one-slice-earned.png" width="160"> <img src="shots/03-slices-persist/02-slice-persists-after-reload.png" width="160">

## 04-reset-no-credit

> Reset restores the full block — and never awards a slice for abandoned work

- ✅ the timer goes back to a full, untouched block — reads 01:00
- ✅ the button offers Start again, as if nothing had run
- ✅ and crucially she earns NO slice for the abandoned work

<img src="shots/04-reset-no-credit/01-reset-full-block.png" width="160">

## Viewport sweep

<img src="shots/viewports/1280x800.png" height="150"> <img src="shots/viewports/320x568.png" height="150"> <img src="shots/viewports/390x844.png" height="150"> <img src="shots/viewports/430x932.png" height="150"> <img src="shots/viewports/768x1024.png" height="150">
