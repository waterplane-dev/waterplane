# cost

Where the weekly limit went, as a person can read it. Origin: on 2026-10-09 the weekly budget stood at 32% 13 hours after its reset, and the cost view could not say why — it had no per-repo cost for a recent window (under a live window the repo list said *Not answerable inside a live window*), nothing grouped the sessions one fan-out had opened, and nothing turned dollars into weekly points. Read off the CLI's logs at API list price, that week was about $470 in 13 hours: one "senior architect top 5" fan-out over ~36 repos was ≈48% of it, two garmin-monorepo sessions ≈41% (92% of those subagents, mostly Opus), subagents 73% overall.

### R-cost-001 · shipped
The cost view opens on "since the weekly reset" and its by-repo list follows the chosen window, live or past, instead of staying all-time; when the reset instant is not known it opens on all time, as before. A window the desktop cannot answer (offline, an older host without the route) says so in a sentence rather than showing a stale or empty list.
- asked: 2026-10-09
- shipped: 112b3120, e68fc533, 37d51564

### R-cost-002 · shipped
A "Where the week went" card shows the week since its reset an hour per column, stacked by repo, with the weekly percentage drawn over it on a fixed, labelled 0–100 axis. The four biggest repos wear the four validated chart hues and keep their colour across re-reads; every other repo folds into one grey "other repos" band. Tapping an hour filters the list beneath to the sessions that ran in it; the list says "n of N" and has a clear button. The money is the card's own (the token/cost metric switch does not reach it, and the tag says so).
- asked: 2026-10-09
- shipped: b57099ed, b8b4ba27, 112b3120, 37d51564

### R-cost-003 · shipped
The week's sessions can be grouped by repo or by what launched them. A fan-out run, a backlog item or a schedule is one row ("<label> · 36 repos · $218 · ≈15 pts") that expands to its sessions, each with its title where the desktop knows one (else `repo · id8`), its money, subagent share and the dearest subagent model; a session nobody can name is still a row, never dropped. Closed sessions are included, because the logs on disk are the source.
- asked: 2026-10-09
- shipped: 112b3120, 37d51564
- note: a conversation older than the closed-session stack has no title or launch and appears as a hand session; peak context per session was planned and is not shown (the host does not send it).

### R-cost-004 · shipped
Dollar figures in the cost view carry "≈ n pts" of the weekly limit, calibrated from the usage log's climb against the ledger's cost over the same hours. One calibration serves the whole screen, so two point figures never sit beside one dollar figure. The figure is absent, with the reason in words, when the readings are too few, too short, too small a climb, unstable between stretches, or disagree with the per-reading calibration; a reset inside the span never produces a wrong one.
- asked: 2026-10-09
- shipped: b8b4ba27, 37d51564

### R-cost-005 · shipped
When the weekly percentage climbs faster than a threshold (default 4 points an hour over the last stretch, `WATERPLANE_BURN_PTS_PER_HOUR`, 0 = off), the desktop pushes one "burn" notification naming the dearest launch in that stretch, with its points when the calibration allows. At most one per cooldown (default 3 h, `WATERPLANE_BURN_COOLDOWN_MS`) and never twice for one stretch; words only, and the body ends "Nothing was paused." A ledger that cannot be read costs the push its "dearest" line, never the push.
- asked: 2026-10-09
- shipped: b8b4ba27, e247fb1b, 71b227ad

### R-cost-006 · shipped
Before running a fan-out, the sheet says what the last similar finished run cost ("last similar run (36 repos): $218.00, 66% subagents"), and a session row says "Opus subagents: N% of this session's cost" when that share is large. Nothing applies itself: both are sentences, absent offline or without the data, and neither gates Run.
- asked: 2026-10-09
- shipped: b8b4ba27, 6ff4cee5, 37d51564
- note: the hint leaves out "≈ N% of week" because the rate lives in `features/tokens` and a feature may not import another.
### R-cost-007 · shipped
The VS Code extension shows token cost live per session and per prompt plus an overall total, with prompts that help cut cost and improve code health.
- asked: 2026-10-11
- shipped: f984d9cf
- reworked 2026-10-21 (owner): "live" now means running or written in the last 30 minutes; outside that the status bar shows the last seven days instead of the newest session (R-cost-018).

### R-cost-008 · shipped
Colour marks the dearer models red, with other models shifting cooler as they get cheaper.
- asked: 2026-10-11
- shipped: 2f225709

### R-cost-009 · shipped
The cost chart's scale is correct, so a session's spend never looks cheaper than it is; subagent spend is stacked on the parent's curve.
- asked: 2026-10-12
- shipped: 37a86540


### R-cost-010 · shipped
The desktop works out what kind of account it is driving (subscription, API key, cloud such as Bedrock/Vertex, or unknown) once at boot from the environment, claude's `apiKeyHelper` and its auth status, and says what it found; a person can override it and hand it back to auto-detect. Until probed, or when the probe fails, it is unknown and behaves as a subscription does; a claude.ai login with a key beside it is unknown, never api.
- asked: 2026-10-12 (billing-periods plan, phase 2)
- shipped: 413bfbd8, de9aef7d

### R-cost-011 · shipped
A budget can be governed per dollar period instead of the 5-hour and weekly windows: a calendar month (with a billing anchor day and time zone), a calendar week, a day, a rolling 30 days, or a from-to span.
- asked: 2026-10-12 (billing-periods plan)
- shipped: 413bfbd8, de9aef7d

### R-cost-012 · shipped
Spend so far in a period is this desktop's ledger at list price, never the invoice, and says so. A ledger that cannot be read leaves the figure absent, never $0, and a total measured for another period is never shown as this one's.
- asked: 2026-10-12 (billing-periods plan)
- shipped: de9aef7d, bb882b28

### R-cost-013 · shipped
On an API or cloud account with no weekly window, the desktop pushes at most once per period when the dollars spent project past the cap at the current pace; words only.
- asked: 2026-10-12 (billing-periods plan)
- shipped: de9aef7d
### R-cost-014 · requested
Sessions can be auto-compacted after 30 minutes idle, optionally limited to starred or flagged conversations, to cut cache-rewrite cost.
- asked: 2026-10-15

### R-cost-015 · requested
Metered AI calls run without asking under a per-repo daily budget; once it is used up the person gets a single ask stating what was spent today and the estimated cost of the next run, about one tap per repo per day.
- asked: 2026-10-15, 2026-10-15

### R-cost-016 · shipped
The VS Code extension shows the same overall cost view as the phone, with one sticky span filter.
- asked: 2026-10-16
- shipped: 4707cf3f
- reworked 2026-10-21 (owner): the view's headline is also shown before any scan, from the last scan's kept summary (R-cost-018).

### R-cost-017 · requested
The set budget is visible in the UI.
- asked: 2026-10-18

### R-cost-018 · shipped
The VS Code extension shows the last seven days' cost the moment VS Code opens, without reading the logs: the tree's All sessions row says `7 d: here $14 · all $80 · 2 h ago` from the last finished scan, with its age (none right after a read), the same seven days before and after this window's scan, and the `here` part only when that folder has a priced figure (a sub-folder counts only sessions started in it; never a prefix match, never `$0` — unpriced weeks in tokens). The status bar shows the session only while one is live (running, or written in the last 30 minutes); otherwise the seven days, `7 d here $14` when this repo's is known, else `7 d all $80`, with the age in the text once the reading is over a day old; with neither it hides. A reading more than seven days old is not shown anywhere: it would not be the last seven days. A changed Claude config dir drops the kept figure.
- asked: 2026-10-21 (owner)
- shipped: 4eac8074, f6fb1a70, f41b5db5

