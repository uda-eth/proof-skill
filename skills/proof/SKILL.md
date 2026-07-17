---
name: proof
description: Prove a task is actually done before it merges — drive the real app through end-to-end user journeys in a real browser, assert every step, capture screenshots, and produce a committed proof pack (REPORT.md + shots/). Use at review stage whenever a feature or bugfix claims to be complete; "tests pass" is not proof, a user journey is.
---

# /proof — the user-journey proof loop

A task is **done** when a real user can do the thing it promised, in the real app, and you can show it. This skill turns that bar into a repeatable loop: derive journeys from the task → stand up the real app → drive it with Playwright as a phone-sized user → assert + screenshot every step → ship the evidence with the PR.

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

- **Real Chrome, headless, phone viewport** (390×844, dpr 2) — review-stage proof looks like the product, not a 1920px dev window.
- **Fresh throwaway users per journey** with a greppable email prefix (e.g. `fpj_…@t.com`), purged at the start of every run so reruns are deterministic.
- **Stage state through APIs/DB, drive UI only for what the user would do.** Registration flags, onboarding, seed posts — set them up via requests or SQL so each journey spends its time on the promise, not on typing into forms (except the journey whose promise IS the form).
- **`rec(journey, step, ok, note)` for every step** — every claim in the report is an assertion that ran, pass or fail, never prose.
- **`shot(page, journey, n, name)` after each user-visible state** — numbered screenshots into `shots/<journey>/`.
- **A `PROMISES` map** — one sentence per journey, quoted from the ticket. It headlines the TLDR in both reports, so a reviewer reads *what* was proven before *how*.
- **The report writer** (`report.mjs`) — one call writes three views of the same results: `report.json` (machine), `REPORT.md` (GitHub-renderable: verdict + promises table + ✅/❌ per step, screenshots inline), and `REPORT.html` (self-contained interactive page — verdict stamp, assertion ledger, per-journey filmstrips, viewport strip; no dependencies, opens offline). Exit non-zero on any failure.

### 4. Run until green — then LOOK at the screenshots

Rerun the suite until every assertion passes. Then open the screenshots and look at each one like a reviewer:

- Is the feature actually **visible**, or is it below the fold / behind an onboarding takeover / under a modal? A DOM-presence assertion passes either way; the screenshot doesn't lie.
- Does it look like the product (theme, fonts, avatars, imagery) or like a skeleton? Decorate journey users (avatars, real-looking content) so the shots are shippable in a PR.
- If a screenshot doesn't show what its step name claims, fix the harness (dismiss the takeover, scroll, wait) and rerun.

### 5. Sweep viewports

One extra script, five sizes, four checks each: the new surface is visible, inside the viewport, causes no horizontal scroll, and its primary control actually works when clicked.

Recommended matrix: `320×568` (small phone), `390×844` (default), `430×932` (large phone), `768×1024` (tablet), `1280×800` (desktop). See `references/viewports-template.mjs`.

### 6. Ship the proof pack

Commit the whole folder with the PR:

```
<feature>-journeys/
  run.mjs            # the journeys
  report.mjs         # the report writer (verbatim from the template)
  viewports.mjs      # the size sweep
  report.json        # machine-readable results
  REPORT.md          # TLDR verdict + ✅/❌ per step — renders in the PR
  REPORT.html        # interactive: verdict stamp, ledger, filmstrips — open locally
  shots/<journey>/   # numbered screenshots
  shots/viewports/   # one per size
```

Paste REPORT.md's TLDR block (verdict line + promises table) into the PR description. The reviewer should be able to judge the feature from the proof pack without checking out the branch.

## Rules

1. **Never mock the network layer.** The runner hits the same server a user would. If the app needs external services you can't run, stage their *effects* in the DB — don't stub the app's own API.
2. **Assert, then screenshot.** A screenshot without an assertion is decoration; an assertion without a screenshot is unreviewable.
3. **Negative journeys are mandatory** for anything that filters, gates, hides, or permissions.
4. **Deterministic reruns.** Prefix + purge test users; never depend on data an earlier run left behind; pin theme/locale via `localStorage` init scripts so screenshots are stable.
5. **The suite exits non-zero on any failure** — wire it into CI or a pre-merge checklist if you want, but at minimum run it at review and commit the green report.
6. **100% or not done.** A journey suite at 24/26 is a task at 0%. Fix the harness or fix the feature — the report never merges red.

## Gotchas that have burned real reviews

- **Stale server on the port** (step 2) — journeys silently drove last week's build. Always verify cwd + a changed-string probe.
- **Onboarding takeover hid the feature** — every assertion passed via DOM, every screenshot showed the tutorial. Dismiss first-run chrome via state seeding, then reshoot.
- **`psql -t -A` + `RETURNING`** appends the command tag (`INSERT 0 1`) — parse the first line only, or every id comparison silently fails.
- **Auth cookie jars**: curl-style jars may prefix session cookies with `#HttpOnly_` — strip it or authenticated requests silently 401.
- **Snap-scroll pagination needs multiple items per page** — a one-item page can't scroll far enough to trigger loading the next.
