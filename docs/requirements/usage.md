# usage

### R-usage-001 · shipped
Usage graphs show token usage and remaining limit over time (selectable by day/week, separate lines for session vs weekly limit), a context-window-size graph with compact events, cost-at-list-price figures, and cumulative token stats across sessions, reachable by tapping the token indicator; chart values display to the right of chart elements as absolute numbers (e.g., 1.8k), not percentages. Cost figures based on Claude API pricing are shown consistently across all similar token-tracking views.
- asked: 2026-09-14, 2026-09-19
- shipped: 5782931, 6d20ed8, de77902, 244d424, 8e79bd0, a00edb9

### R-usage-002 · shipped
Usage limits are correctly detected and consistently shown throughout the interface: no false session-limit errors, the badge clears once a limit is lifted, and the weekly limit does not trigger intra-day window reset resumption.
- shipped: 4c89d5b

### R-usage-003 · shipped
The session reader's own controls (outline, find, refresh) live in the header toolbar; no second control bar sits above the conversation.
- shipped: 6cb1c809
- note: The marked bar was the CLI/outline/find/new row above the conversation, not a usage bar.

### R-usage-004 · requested
User sees which prompts or messages are impacted by rate limits.

### R-usage-005 · shipped
Main view and CLI show total session cost in k tokens, including subagent usage.
- asked: 2026-09-17
- shipped: 5782931, 89051a3

### R-usage-006 · requested
Charts display fully without being cut off, are large enough and clear enough to read without strain, have a polished visual appearance, and show tooltips on hover.
- asked: 2026-09-18, 2026-09-18, 2026-09-24

### R-usage-007 · shipped
The 5-hour and weekly limit windows each say, at the current burn rate, when they will fill or where they will stand at the reset.
- asked: 2026-09-13
- shipped: 8fbe9f1
- note: Ask was how long the budget lasts; the figure is in percent and time, not remaining tokens.

### R-usage-008 · shipped
Cache read ratio assessment indicates whether the ratio is healthy or suggests context pollution.
- asked: 2026-09-13
- shipped: 8fbe9f1

### R-usage-009 · shipped
Context size graph displays consistently and never goes missing.
- asked: 2026-09-13
- shipped: 8fbe9f1

### R-usage-010 · shipped
Cache expiration time is displayed, and conversations are flagged as expensive to continue after the cache expires.
- asked: 2026-09-19
- shipped: fe8ec19

### R-usage-011 · shipped
Token statistics can be viewed separately for local and hosted models without being merged.
- asked: 2026-09-14
- shipped: 8fbe9f1

### R-usage-012 · shipped
Cache read tokens display alongside input/output tokens, consistently across all token-tracking views.
- asked: 2026-09-19
- shipped: 6d20ed8

### R-usage-013 · shipped
Usage charts display as stacked area charts distinguishing model and token type.
- asked: 2026-09-19
- shipped: 6d20ed8

### R-usage-014 · shipped
Subagent count displays as a stacked bar chart with models as stacked elements.
- asked: 2026-09-19
- shipped: b87535a

### R-usage-015 · shipped
The session's context view shows what compacting saved (tokens not re-sent, with a dollar worth) and what it cost (tokens and dollars to rebuild the window).
- asked: 2026-09-19
- shipped: b87535a7

### R-usage-016 · shipped
Chart gaps and data voids (e.g. usage-window rollovers) are labeled and explained rather than left unexplained.
- asked: 2026-09-24
- shipped: a00edb9

### R-usage-017 · shipped
Weekly usage chart displays the actual usage week (reset-to-reset) rather than only the last 24 hours.
- asked: 2026-09-24
- shipped: f541c2c

### R-usage-018 · shipped
Session cost and prompt cost show what share of the weekly window budget they used.
- asked: 2026-10-01
- shipped: 8e9c3d6

### R-usage-019 · shipped
A session budget set as a share of the 5-hour or weekly window is judged as an estimate, from what this desktop spent in that window against the share the usage screen reports; when there is no fresh reading or the window has not run enough to say, the budget reads "can't tell", says why, and never holds anything.
- asked: 2026-10-01
- shipped: 6d43fde, e2d45d5
### R-usage-020 · shipped
The model and effort wheel marks a pick with one dot per spoke and effort ring instead of a filled area, and a list of model chips below it lets the user choose which models appear.
- asked: 2026-10-05
- shipped: e409b04f
- note: This is the model/effort wheel, not a usage chart.

### R-usage-021 · shipped
The model and effort wheel looks identical in both places it is shown.
- asked: 2026-10-05
- shipped: e409b04f
- note: This is the model/effort wheel, not a usage chart.

### R-usage-022 · shipped
An optional, synced setting marks a session's spend with an orange or red triangle when it passes a threshold: orange at 2% and red at 5% of the weekly limit on a fixed-price plan, or $30 / $75 of list price for API users (derived from Max plan limits).
- asked: 2026-10-12
- shipped: 2c6cb1c2


### R-usage-023 · shipped
An API-key, Bedrock or Vertex account (no 5-hour or weekly window) sees its spend per governed period instead: the launcher and session chip read like `Oct $412 / $2000 · on pace` (no `?` chips, no empty weekly card), and the token statistics lead with "Where the month went" — per repo and per model, split shown with the total, pacing in words (on pace, ahead, $X/day left, projected end), and a single caveat that the figure is this desktop's ledger at list price. Settings holds the billing profile (auto-detect or override) and the periods and $ caps (calendar month with billing day and zone, calendar week, day, rolling 30 days, custom span). A subscription host is unchanged.
- asked: 2026-10-12 (billing-periods plan, phase 3)

### R-usage-024 · shipped
On a host known to be API or cloud, the `/usage` screen is not polled at all (it has no windows to read); unknown and subscription hosts poll as before.
- asked: 2026-10-12 (billing-periods plan, phase 2)
- shipped: de9aef7d

### R-usage-025 · shipped
The token usage screen has ONE time filter that sticks to the top while scrolling — 5h session · Limit week · 30 days · 90 days · All time, plus count in tokens/cost and chart/values — and every metric and chart below it follows that span: the totals, tiles, by model, by repo, the costliest conversations, cumulative, per day, cost per request, subagents, per hour and the time-of-day clock. The one exception sits above the filter, compact: the 5-hour and weekly limit bars and the current week's hour chart, which are always "now". A section that cannot be cut to the span says so in a sentence rather than showing an all-time number under the span's name. Opens on the limit week.
- asked: 2026-10-15 ("so many different time frames active at the same time")

### R-usage-026 · shipped
The usage meter shows one reading per source that has one (Claude, Copilot, any plugin that contributes a probe), side by side; a source with nothing to say draws nothing, except Claude, whose `?` door stays beside the others when its scrape parsed nothing; tapping a source other than Claude opens token statistics on it and says which other sources are not shown, while tapping Claude opens them as they always opened; a desktop with only Claude sees exactly the chip it has today, and a second source does not widen Claude's part (on a phone the sources wrap inside the chip, never off the screen). opencode contributes no reading until one of its providers exposes a quota.
- asked: 2026-10-15 (the usage-sources plan)
- shipped: 12729bff, fcd392f1, 1ae60c16, 99e8727e, b7a2e798, 94d18b09, c67e2cab, 40cb54d6
### R-usage-027 · shipped
The usage view lets the user step back and forward through past weeks with left and right buttons.
- asked: 2026-10-30
- shipped: d005b9bc

### R-usage-028 · shipped
A week's spend counts this desktop and its peer jobs by default. With "count every paired desktop" turned on (off by default), each same-account peer's own spend replaces its job figure, so nothing counts twice; a peer counts as the same account only if its weekly reset matches this desktop's. A session's share of the weekly limit is hidden rather than shown wrong when the calibration cannot be trusted.
- asked: 2026-11-03
- shipped: 44e338ed

### R-usage-029 · shipped
When the 5-hour usage window is disabled for an account, the usage display says so in one row instead of looking broken.
- asked: 2026-11-03
- shipped: 9c6e6219

### R-usage-030 · shipped
The reach dashboard's GitHub tiles say where GitHub's traffic data ends, so days GitHub has not published yet do not look like missing numbers.
- asked: 2026-11-04
- shipped: 1e2bad61


### R-usage-031 · shipped
"What drives the cost" on the token usage screen follows the span when one is picked (switch back to the whole record with a chip), and each finding says how its share moved against the span before — the week before, the window before, or the same number of days before. Where the record does not reach a whole span back, nothing is compared and it says so; re-caching after breaks is counted over the whole record only, and the span view says that.
- asked: 2026-11-11 ("Can we optionally cut it to the span and also show a delta?")
