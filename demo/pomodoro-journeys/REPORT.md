# Proof — wedge pomodoro user journeys

17 passed / 0 failed against http://localhost:4173

## 01-focus-cycle

The core promise: a focus block runs, the wedge drains, and completion hands off to a break automatically

- ✅ idle timer shows the full 25:00 focus block
- ✅ mode chip reads Focus
- ✅ primary control offers Start
- ✅ running: control flips to Pause
- ✅ running: wedge is draining (time below 00:04) — 00:03
- ✅ completion hands off to Break automatically
- ✅ break block queued at full 00:03

## 02-pause-resume

Pause freezes the wedge exactly where it is; Resume continues from there

- ✅ paused time does not move — 00:58
- ✅ control offers Resume while paused
- ✅ resume continues the countdown

## 03-slices-persist

A completed focus block earns a slice that survives a full reload

- ✅ empty state invites the first block
- ✅ one slice earned after completing a block
- ✅ the earned slice survives a reload
- ✅ empty-state prompt stays gone

## 04-reset-no-credit

Reset restores the full block — and never awards a slice for abandoned work

- ✅ reset restores the full block
- ✅ control returns to Start
- ✅ no slice awarded for an abandoned block

