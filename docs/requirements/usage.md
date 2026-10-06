# usage

### R-usage-001 · shipped
Usage graphs show token usage and remaining limit over time (selectable by day/week, separate lines for session vs weekly limit), a context-window-size graph with compact events, cost-at-list-price figures, and cumulative token stats across sessions, reachable by tapping the token indicator; chart values display to the right of chart elements as absolute numbers (e.g., 1.8k), not percentages. Cost figures based on Claude API pricing are shown consistently across all similar token-tracking views.
- asked: 52e9a630, 96b3a216, 35871f0a, 159ba946, 2026-09-14 (session c174a199), 2026-09-19 (session 1d5e8f84)
- shipped: 5782931, 6d20ed8, de77902, 244d424, 8e79bd0, a00edb9

### R-usage-002 · shipped
Usage limits are correctly detected and consistently shown throughout the interface: no false session-limit errors, the badge clears once a limit is lifted, and the weekly limit does not trigger intra-day window reset resumption.
- asked: 1e30cec0, ea58d75c, f7be1724, 37f81460
- shipped: 4c89d5b

### R-usage-003 · requested
Duplicate second usage-visualization bar is merged into the first and removed.
- asked: 4d7626af

### R-usage-004 · requested
User sees which prompts or messages are impacted by rate limits.
- asked: c37bc613

### R-usage-005 · shipped
Main view and CLI show total session cost in k tokens, including subagent usage.
- asked: 2026-09-17 (session fb744493)
- shipped: 5782931, 89051a3

### R-usage-006 · requested
Charts display fully without being cut off, are large enough and clear enough to read without strain, have a polished visual appearance, and show tooltips on hover.
- asked: 2026-09-18 (session fba49171), 2026-09-18 (session 2a423bcf), 2026-09-24 (session 259706ec)

### R-usage-007 · requested
Budget projection shows remaining tokens for the current session and week at the current burn rate.
- asked: 2026-09-13 (session e25a7c4a)

### R-usage-008 · shipped
Cache read ratio assessment indicates whether the ratio is healthy or suggests context pollution.
- asked: 2026-09-13 (session e25a7c4a)
- shipped: 8fbe9f1

### R-usage-009 · requested
Context size graph displays consistently and never goes missing.
- asked: 2026-09-13 (session 54c148be)

### R-usage-010 · shipped
Cache expiration time is displayed, and conversations are flagged as expensive to continue after the cache expires.
- asked: 2026-09-19 (session c42b4227)
- shipped: fe8ec19

### R-usage-011 · shipped
Token statistics can be viewed separately for local and hosted models without being merged.
- asked: 2026-09-14 (session 222d5868)
- shipped: 8fbe9f1

### R-usage-012 · shipped
Cache read tokens display alongside input/output tokens, consistently across all token-tracking views.
- asked: 2026-09-19 (session 1694b342)
- shipped: 6d20ed8

### R-usage-013 · shipped
Usage charts display as stacked area charts distinguishing model and token type.
- asked: 2026-09-19 (session 1d5e8f84)
- shipped: 6d20ed8

### R-usage-014 · shipped
Subagent count displays as a stacked bar chart with models as stacked elements.
- asked: 2026-09-19 (session 1d5e8f84)
- shipped: b87535a

### R-usage-015 · requested
Sessions view shows token and dollar savings achieved by using compact prompts.
- asked: 2026-09-19 (session 1d5e8f84)

### R-usage-016 · shipped
Chart gaps and data voids (e.g. usage-window rollovers) are labeled and explained rather than left unexplained.
- asked: 2026-09-24 (session 259706ec)
- shipped: a00edb9

### R-usage-017 · shipped
Weekly usage chart displays the actual usage week (reset-to-reset) rather than only the last 24 hours.
- asked: 2026-09-24 (session e1ff29ed)
- shipped: f541c2c

### R-usage-018 · shipped
Session cost and prompt cost show what share of the weekly window budget they used.
- asked: 2026-10-01 (session 7c582b94)
- shipped: 8e9c3d6

### R-usage-019 · shipped
A session budget set as a share of the 5-hour or weekly window is judged as an estimate, from what this desktop spent in that window against the share the usage screen reports; when there is no fresh reading or the window has not run enough to say, the budget reads "can't tell", says why, and never holds anything.
- asked: 2026-10-01
- shipped: 6d43fde, e2d45d5
