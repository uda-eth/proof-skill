---
name: proof
description: Prove a task is actually done before it merges — drive the real app through end-to-end user journeys in a real browser, assert every step, capture screenshots, and produce a committed proof pack (REPORT.md + shots/). Use at review stage whenever a feature or bugfix claims to be complete; "tests pass" is not proof, a user journey is.
---

# /proof — the user-journey proof loop

A task is **done** when a real user can do the thing it promised, in the real app, and you can show it. This skill turns that bar into a repeatable loop: derive journeys from the task → stand up the real app → drive it with Playwright as a real user (desktop by default, phone for mobile-only apps) → assert + screenshot every step → ship the evidence with the PR.

Unit tests prove functions. Integration tests prove endpoints. **Only a journey proves the feature.** All three of these have passed while the feature was invisible to users (wrong server on the port, UI behind an onboarding takeover, empty state that never resolves). The proof pack catches what green checkmarks miss.

## The loop

### 1. Derive the journeys from the task, not the code

Read the ticket/PR description and write down every promise it makes to a user. Each promise becomes one journey; a feature usually needs 3–5:

- **The happy path** — the core promise, end to end ("toggle filters the feed to connections only").
- **The exclusion / negative** — what must NOT happen ("a stranger's post never appears"). A filter feature without a negative journey proves nothing.
- **Persistence** — survive a reload, a re-login, a second device if the ticket implies it.
- **The empty/first-run state** — what a user with no data sees, and whether its call-to-action actually leads somewhere.
- **Adjacent behaviors** — blocks, permissions, roles that must keep holding through the new surface.

Do NOT skip a journey because an integration test covers the same endpoint. The journey is testing the promise, not the endpoint.

**Drive every journey to its OUTCOME — the button is not the feature.** The single most common way a proof lies: it clicks the trigger and stops. "Connect GitHub" renders and the click lands ✅ — but the journey never drove the connect flow, so the recording shows a button and a spinner and nothing else, and the integration was never actually proven to work. Do not do this. Each journey continues past the trigger through the *entire process* to the finished, working result, and asserts *that result*:

- **Follow the whole flow.** Click "Connect GitHub" → complete the connect/OAuth/callback → land on the connected state → assert the repo is actually linked and a sync actually moved data. Click "Add DNS record" → submit the form → wait for it to provision → assert the record exists and reads back as active. The proof is the end state, not the entry point.
- **Both directions for two-way features.** A sync, import/export, or mirror is two promises — prove each way (local→remote *and* remote→local), each with its own assertion, or it's half-proven.
- **External providers: drive the round trip or stage its effect, then assert the return.** OAuth popups, DNS APIs, payment redirects — never stop at "redirected to the provider." Drive the callback (or seed its result via API/DB) and assert your app reflects the connected/configured state. A screen recording that ends at the redirect proves nothing.
- **If it can't be driven end to end, say so — don't dress up a partial run as PROVEN.** A journey that only reaches the trigger is a FAIL, not a pass.

### 2. Stand up the REAL app — and verify it's YOUR code

Run the real dev server against a real database. No mocks, no fixtures-only mode, no storybook.

**Trust nothing about an already-running server.** Before driving it, verify the process on the port is serving the code under review:

```bash
lsof -p $(lsof -ti :$PORT | head -1) | grep cwd   # is its cwd YOUR checkout?
curl -s "http://localhost:$PORT/<path-to-a-changed-module>" | grep -c "<string-you-just-added>"
```

A stale server from another checkout will happily serve old code and every journey will "test" the wrong build. If in doubt, kill it and start your own.

### 3. Write the runner from the template

Copy `references/run-template.mjs` (as `run.mjs`) and `references/report-template.mjs` (as `report.mjs`, verbatim — no edits needed) into a `<feature>-journeys/` folder at the repo root and adapt the runner. The template gives you the harness contract:

- **Real Chrome, headless, desktop viewport by default** (1280×800) — most web apps are used in a desktop browser, so that's the honest review surface. **Pick the device from the app, not a habit:** record phone (390×844, dpr 2 — `PROOF_DEVICE=phone` or `--device=phone`) only when the app is mobile-only, or the ticket is specifically about a mobile/responsive/touch surface. If the feature has genuinely distinct, important experiences on *both* desktop and mobile, **ask the user** which to prove — or whether to prove both — before you run; don't guess. The proof page renders the matching chrome automatically (a browser window for desktop, a phone for mobile).
- **Fresh throwaway users per journey** with a greppable email prefix (e.g. `fpj_…@t.com`), purged at the start of every run so reruns are deterministic.
- **Stage state through APIs/DB, drive UI only for what the user would do.** Registration flags, onboarding, seed posts — set them up via requests or SQL so each journey spends its time on the promise, not on typing into forms (except the journey whose promise IS the form).
- **`rec(journey, step, ok, note)` for every step** — every claim in the report is an assertion that ran, pass or fail, never prose. Write `step` as a plain sentence a stranger could follow (`'the timer is counting down'`, not `'running: elapsed < 4000'`) and put the technical predicate in `note` — the two show up side by side in the ledger and in REPORT.md, which is where reviewers read them.
- **`shot(page, journey, n, name)` after each user-visible state** — numbered screenshots into `shots/<journey>/`.
- **Drive inputs through the act helpers** — `tap`/`fillIn`/`swipe`/`navTo`/`pause` instead of raw `page.*`. Each journey is **screen-recorded** (real video); every input's target, label and sampled pointer path land in `replay.json`, and the player redraws a real cursor along that path on top of a clean recording. Raw `page.*` still works — but those actions teleport the pointer and aren't paced, so they read as a machine editing the DOM. `--no-replay` skips recording when you only want the pass.
- **Label every action with the user's INTENT** — the last argument to `tap`/`fillIn`/`swipe`/`navTo`/`pause` is logged to `replay.json` as what that step was *for*: `'Maya starts the focus block'`, not `'#start-btn'`. It costs nothing and it's what makes a replay log readable when a run goes wrong.
- **The run is PACED and the pointer is DRIVEN LIKE A HAND** — this is the difference between a recording that reads as a person using the app and one that reads as a machine mutating the DOM. `locator.click()` teleports the mouse and presses in the same instant: measured on a real app that delivers **one** mousemove and ~2 frames of `:hover`, so hover states, focus rings and CSS transitions never render and the video shows an inert app that suddenly changes — effects with no visible cause. The helpers instead move the real pointer along a bowed Bézier with a minimum-jerk velocity profile, distance-scaled duration, then they *hover* long enough for the app to react, and hold the button down so `:active` renders. Every sample is logged, so the player redraws a real cursor — arrow while travelling, hand over a clickable target, because that is what the OS cursor actually was — replaying the pointer's real path rather than drawing a line it never took. A screen recording never captures a cursor; this is how the run gets one. Motion is **seeded**, so reruns reproduce it. Tune `PACE` at the top of `run.mjs`; `PROOF_PACE=fast` collapses it for CI. Don't reach for `--no-replay` to make a run quick — that throws away the evidence, not the wait.
- **Popups and extra sessions are recorded too — drive them like any other surface.** Every page a context opens is adopted automatically as its own **track**: a `target="_blank"` tab, a `window.open`, an OAuth consent screen, or a second `freshUser()` for a collab/permissions/second-device journey. Each gets its own recording (`videos/<journey>.webm`, then `-2`, `-3`…), its own cursor track, and its own errors and network traffic attributed to it; the player shows a **surface** switcher when a journey has more than one. Grab a popup with `const p = ctx.waitForEvent('page')` before the click that opens it, then drive it with the same `tap`/`fillIn`/`pause` helpers. This is what makes the OAuth round trip in step 1 actually provable rather than something you stop short of.
- **Un-automatable steps go through `manual(page, j, label, { stage })` — never fake them.** Some real steps a machine physically can't perform: a fingerprint/passkey, a CAPTCHA, an OAuth consent screen, a 3DS/OTP challenge, a native OS dialog. Run locally in a TTY and `manual()` pauses so you do it live in the browser and press Enter — the recording captures the real thing. Run headless/CI and you pass a `stage` fn that applies the step's *effect* via API/DB so the journey continues. Either way you **still `rec()` the real OUTCOME afterward** (the passkey logged you in → assert the authenticated state). Manual steps are logged as MANUAL and shown as manual (⏸) in the report — never blended into the machine-driven steps, never counted as a pass or a fail. This is the sanctioned, honest alternative to the one thing you must never do: fabricate a recording.
- **A `PROMISES` map** — one sentence per journey, quoted from the ticket. It headlines the TLDR in both reports, so a reviewer reads *what* was proven before *how*.
- **The report writer** (`report.mjs`) — one call writes every view of the same results: `report.json` (machine), `REPORT.md` (GitHub-renderable: verdict + replay.gif + promises table + before/after pairs + ✅/❌ per step, screenshots inline), and `REPORT.html` — **THE proof page, one system, one self-contained file**: the run's real screen recordings in a scrubbable player up top (video-editor timeline with input + assertion ticks, a real cursor replaying the pointer's recorded path, network log, per-step timing). **Nothing is drawn over the app but the cursor** — no captions, no title cards, no highlight boxes. The app is the thing the reviewer came to watch and every overlay competes with it. Below the player sits the evidence — verdict stamp, TL;DR promises, before/after drag-sliders, journey ledgers with filmstrips, viewport strip. Everything embedded as data URIs (videos as mp4 when ffmpeg is available), so the single file renders anywhere. With `ffmpeg` on PATH it also emits `replay.gif` straight from the happy-path recording, which REPORT.md embeds — GitHub animates it right in the PR. Exit non-zero on any failure.

### 4. Run until green — then LOOK at the screenshots

Rerun the suite until every assertion passes. Then open the screenshots and look at each one like a reviewer:

- Is the feature actually **visible**, or is it below the fold / behind an onboarding takeover / under a modal? A DOM-presence assertion passes either way; the screenshot doesn't lie.
- Does it look like the product (theme, fonts, avatars, imagery) or like a skeleton? Decorate journey users (avatars, real-looking content) so the shots are shippable in a PR.
- If a screenshot doesn't show what its step name claims, fix the harness (dismiss the takeover, scroll, wait) and rerun.
- **Watch the recording end to end: does it show the feature WORKING, or does it stop at the button?** If the video ends at the click — the connect button, the submit, the redirect — the journey is incomplete. Drive the flow to its finished result, re-record, and confirm the recording shows the actual working outcome (repo linked and syncing, DNS record live, order placed). A recording that ends at the trigger is not proof.
- **Watch it at 1× and ask whether it looks like a person using the product.** Does the pointer travel to things before clicking them? Do buttons light up under it? Can you see what changed after each click? If a step blurs past, if the pointer teleports, or if the app never visibly reacts to being touched — that's the proof failing at its job, not a cosmetic issue. Fix it with more `PACE` and re-record. A reviewer who can't follow the video falls back to trusting your summary, which is the exact thing this skill exists to replace.

### 5. Sweep viewports

One extra script, five sizes, four checks each: the new surface is visible, inside the viewport, causes no horizontal scroll, and its primary control actually works when clicked.

Recommended matrix: `320×568` (small phone), `390×844` (default), `430×932` (large phone), `768×1024` (tablet), `1280×800` (desktop). See `references/viewports-template.mjs`.

### 6. Capture the before (optional — one extra run)

If the change alters an existing surface — and *especially* for a bugfix — capture the merge-base build so the reports carry before/after evidence:

```bash
git worktree add /tmp/proof-base $(git merge-base HEAD origin/main)
# boot that checkout on a second port, then:
PORT=5002 node <feature>-journeys/run.mjs --baseline
node <feature>-journeys/run.mjs   # regenerate reports — pairs appear automatically
```

Baseline runs are capture-only: same journeys, same shot names, but shots land in `shots-baseline/`, assertions don't gate (the feature isn't supposed to exist back there), and no reports are written. The report writer pairs shots by journey + filename: REPORT.md gets a side-by-side table, REPORT.html gets drag-sliders. For a bugfix, the before-shot *showing the bug* is the strongest evidence a pack can carry. Write journeys with `count()`-guarded lookups (see the demo) so a baseline run reaches every `shot()` instead of throwing on a surface that doesn't exist yet.

### 7. Ship the proof pack

Commit the whole folder with the PR:

```
<feature>-journeys/
  run.mjs            # the journeys
  report.mjs         # the report writer (verbatim from the template)
  viewports.mjs      # the size sweep
  report.json        # machine-readable results
  replay.json        # input + network event log (drives the player)
  REPORT.md          # TLDR verdict + replay.gif + before/after + ✅/❌ per step — renders in the PR
  REPORT.html        # THE proof page: recordings player + stamp + sliders + ledgers — one file
  replay.gif         # (with ffmpeg) happy-path recording — animates in the PR
  videos/<j>.webm    # raw screen recordings, one per journey
  shots/<journey>/   # numbered screenshots
  shots-baseline/    # (optional) merge-base captures for before/after pairs
  shots/viewports/   # one per size
```

Paste REPORT.md's TLDR block (verdict line + promises table) into the PR description. The reviewer should be able to judge the feature from the proof pack without checking out the branch.

**Commit the ENTIRE pack — never .gitignore any of it.** `videos/*.webm` and `REPORT.html` are evidence, not build output: the webms are a few hundred KB each and REPORT.html is the only place a reviewer can watch the run. "Regenerate locally from replay.json" is a lie the moment the run happened in an ephemeral environment — the recordings cannot be regenerated, only re-run. If pack size genuinely worries you, shorten journeys; do not drop artifacts. A REPORT.md whose proof-page link 404s in the PR is a broken proof.

**Always deliver a viewable proof URL in the chat — publish it, don't host it.** Your final message after a run must lead with a link the user can actually open, and never substitute a PR link (GitHub renders REPORT.md but NOT REPORT.html; a PR link is not a proof link). REPORT.html is a single self-contained file (all video/screenshots embedded), so the durable way to deliver it is to **publish it as a hosted artifact**, in this order of preference:

1. **Publish REPORT.html as a shareable artifact** whenever a publish/artifact capability exists in your environment (e.g. the Artifact tool) — this yields a durable URL that opens anywhere, for anyone, with nothing running. This is the default. Lead with it.
2. **Otherwise link the committed file**: `[REPORT.html](<feature>-journeys/REPORT.html)` when the pack is on the user's machine and they can open it directly.
3. **A localhost URL is a last resort, never the deliverable.** A `localhost:<port>` link only resolves on the exact machine running that exact server, right now — it dies the moment the server stops and means nothing on a cloud/ephemeral run. Use localhost *only* to feed a preview panel that technically requires it, and even then also hand over a durable link (1 or 2). Do not spin up a server and paste its URL as "the proof."

If the pack only exists on a branch/remote (cloud run, worktree), do NOT stop at a PR or localhost link — publish REPORT.html as an artifact (it embeds all its media precisely so it stays viewable detached from the repo) before ending the turn.

## Rules

1. **Never mock the network layer.** The runner hits the same server a user would. If the app needs external services you can't run, stage their *effects* in the DB — don't stub the app's own API.
2. **Assert, then screenshot.** A screenshot without an assertion is decoration; an assertion without a screenshot is unreviewable. (Baseline shots are the one sanctioned exception: capture-only by design, each one exists to pair with an asserted after-shot.)
2b. **Prove the outcome, record the whole process.** Every journey drives the feature to its finished, working result and asserts *that result* — not that the trigger renders. The recording must show the full process end to end (trigger → flow → confirmed working state), both directions for two-way features. "The button is there and I clicked it" is never proof the feature works.
2c. **Never fabricate evidence.** If a step can't be automated (fingerprint/passkey, CAPTCHA, OAuth consent, 3DS/OTP, native dialog), mark it `manual` — pause for a human or stage its effect — and still assert the outcome. Never synthesize, hand-assemble, or inject a recording, and never dress a manual step up as automated. A pack that fabricates any segment is not a proof.
3. **Negative journeys are mandatory** for anything that filters, gates, hides, or permissions.
4. **Deterministic reruns.** Prefix + purge test users; never depend on data an earlier run left behind; pin theme/locale via `localStorage` init scripts so screenshots are stable. Replay artifacts (`videos/`, `replay.json`, `replay.gif`, and the player portion of `REPORT.html`) are context, not claims — they're exempt from byte-stability since timestamps and visible clocks differ per run; pin the app clock too if you want them stable.
5. **The suite exits non-zero on any failure** — wire it into CI or a pre-merge checklist if you want, but at minimum run it at review and commit the green report.
6. **100% or not done.** A journey suite at 24/26 is a task at 0%. Fix the harness or fix the feature — the report never merges red.
7. **The pack ships whole, and the chat gets a published URL.** Every generated artifact — `videos/` and `REPORT.html` included — is committed; nothing in the pack is ever `.gitignore`d. The run's final chat message leads with an actually-openable link to the proof page — **publish the self-contained REPORT.html as a hosted artifact** rather than serving it on localhost (localhost dies with the server and is meaningless off-machine). A PR link or a bare localhost link does not count as delivering the proof.

## Gotchas that have burned real reviews

- **Stale server on the port** (step 2) — journeys silently drove last week's build. Always verify cwd + a changed-string probe.
- **Onboarding takeover hid the feature** — every assertion passed via DOM, every screenshot showed the tutorial. Dismiss first-run chrome via state seeding, then reshoot.
- **`psql -t -A` + `RETURNING`** appends the command tag (`INSERT 0 1`) — parse the first line only, or every id comparison silently fails.
- **Auth cookie jars**: curl-style jars may prefix session cookies with `#HttpOnly_` — strip it or authenticated requests silently 401.
- **Snap-scroll pagination needs multiple items per page** — a one-item page can't scroll far enough to trigger loading the next.
- **A recording nobody can follow** — the runner drove the app at machine speed, so a six-step journey flew by in two seconds, the cursor teleported between clicks, and the player opened at 2× on top of that. Every assertion passed and the video was still useless: reviewers watched it once, understood nothing, and fell back to trusting the summary. Legibility is part of the proof, not polish on top of it.
- **The app never looked *touched*** — the sequel to the above, and subtler. Even correctly paced, `locator.click()` delivers a single mousemove at the instant of the press, so `:hover`, `:active` and every CSS transition are skipped: the recording is an inert app that abruptly changes state, and viewers reported it "didn't feel like a person." Measure it if you doubt it — count `mousemove` events and frames where the target `:hover`s. Drive the real pointer to the target and dwell on it, or the video shows effects with no visible cause.
- **Overlays that bury the app** — captions, title cards, highlight boxes and dimming were all added to "explain" the run, and together they left the product itself as the smallest, most obstructed thing on the page. The recording's job is to show the app being used; the ledger right below it already carries the assertions. Keep the video clean.
- **Popup evidence silently thrown away** — Playwright records every page in a context, but the harness only ever banked the one page it opened. A popup's recording was written to `videos/` under a random hash and never referenced, and its JS errors were invisible, so an OAuth journey could go green while the consent screen threw. Worse, two sessions in one journey both wrote `videos/<journey>.webm` and the second silently overwrote the first, and each `freshUser()` reset the journey clock so events logged before it pointed at the wrong moment (measured: `507, 1910, 506, …` — the timeline jumping backwards mid-journey). If you ever see a `page@<hash>.webm` in a pack, that is a surface the harness failed to adopt.
- **Fabricated evidence for an un-automatable step** — a journey hit a fingerprint/biometric approval Playwright can't perform, so the agent went off-script, hand-assembled its own fake GIF "proof", and published *that* instead of the real report. For a proof tool, fabricating any segment is the cardinal sin. `manual()` + rule 2c exist precisely to prevent this: pause for a human or stage the step's effect, mark it MANUAL, and still assert the real outcome — never synthesize a recording.
