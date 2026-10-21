# metrics

### R-metrics-001 · shipped
Repo health metrics track code quality over time via classic git-history-derived measures (no AI tokens), reachable via a button in each repo's action row, prominently displayed as time-series charts with axis ticks, labels, and per-metric help icons.
- asked: 2026-09-21
- shipped: 9dc4fed, 02ac488, aa20495, d38b20d, 93767cd, 6459002

### R-metrics-002 · shipped
Skill count and CLAUDE.md/AGENTS.md size are tracked as metrics, with skill count shown as an ungraded line graph over time.
- asked: 2026-09-21, 2026-09-21, 2026-09-21
- shipped: 8d3acd9

### R-metrics-003 · shipped
Metrics work identically and are readable across all repositories, regardless of language.
- asked: 2026-09-21
- shipped: a539ab3, fd9b7c2

### R-metrics-004 · shipped
Metrics can be broken down and filtered by file type and by subtree/folder.
- asked: 2026-09-22, 2026-09-22
- shipped: 8596e4c, 5f8c844, 03ae3f3

### R-metrics-005 · requested
Metrics that require AI tokens are hidden behind a button the user can enable, separate from the free classic metrics.
- asked: 2026-09-21

### R-metrics-006 · shipped
A graph at the top of repo readings shows the largest file's line count over time, marking handovers as a different file takes the top spot.
- asked: 2026-09-24, 2026-09-24
- shipped: cd1cb67

### R-metrics-007 · shipped
Clicking a session's context window chart shows both context and cost for that session.
- asked: 2026-09-26
- shipped: 3c4f0a2

### R-metrics-008 · shipped
Session metrics accurately measure tokens and cost, in both the single-session and all-sessions views, including whole logs and subagent spend.
- asked: 2026-09-26, 2026-09-29
- shipped: 448d4b7, 2d35bd5, 01d64ff

### R-metrics-009 · shipped
The header sparkline shows agent activity in addition to token usage.
- asked: 2026-09-26
- shipped: 1a37973

### R-metrics-010 · shipped
The all-sessions view has well-structured data, visible charts and extra cost/usage insights, with filter buttons clearly tied to what they filter.
- asked: 2026-09-26
- shipped: ae9c3d7

### R-metrics-011 · shipped
Cost is shown as a trend over time with a per-repository breakdown.
- asked: 2026-09-28
- shipped: 4567c1d

### R-metrics-012 · shipped
Each model has the same color across all sessions, and the models bar is a donut.
- asked: 2026-09-30
- shipped: c36d13b

### R-metrics-013 · shipped
Local models display compute time, token count and memory consumption.
- shipped: 3a6b932

### R-metrics-014 · shipped
The per-prompt cost section is one component shared by CLI and GUI modes, collapsible and styled the same in both.
- asked: 2026-10-04, 2026-10-04, 2026-10-04
- shipped: f61cced, 83a6fda

### R-metrics-015 · requested
Graphs are placed on the relevant screen and are improved in readability and information shown.
- asked: 2026-10-07

### R-metrics-016 · shipped
The VS Code extension shows repo health metrics over time.
- asked: 2026-10-11
- shipped: c4b2f739


### R-metrics-017 · shipped
Each repo has a health score, 0 to 100, read week by week from five readings (size, rework, escape hatches, context weight, untested files), each against a fixed good value and read as lower-is-better; the score is the geometric mean of the five, but never more than 30 above the worst one, and the phone says which reading holds it down. A reading under 50 raises a warn alert and under 25 a severe one, each naming the offender (the longest file by path); the week-over-week trend sits second, and an unusual move against the score's own noise warns (drop) or praises (rise). Every repo is notified of a called move, and once more when a reading newly turns severe (never on a repo's first scored week, nor for one that was severe already); a chip shows in the main view. The good values are provisional.
- asked: 2026-10-15 (owner); reworked to an absolute score with cap, alerts and trend 2026-10-17 (owner); push on a new severe alert 2026-10-17 (owner)
- shipped: healthwatch.ts (host); chip in packages/web; healthindex.ts (shared); Health view in packages/vscode

### R-metrics-018 · shipped
A repo can declare readings of its own in a committed `.waterplane-shared/health.json` (argv run at HEAD, one number out, absent with a reason otherwise); they are stored in the series beside waterplane's but never enter the health index, and every reading on the phone says whose it is — waterplane's (the same for every repo) or the repo's own — with one line on how to add one where a repo has none.
- asked: 2026-10-16 (owner)
- shipped: tools/repohealth/own.mjs; RepoHealthOwn.tsx in packages/web
### R-metrics-019 · requested
Repo health counts a module as covered when a test reaches it through the language's own import or path rules, lists modules no test reaches as its headline (a repo can declare globs covered elsewhere), explains which modules joined, were lost or stayed, and a change in measuring bumps the version and recomputes so old and new readings never mix.
- asked: 2026-10-15

### R-metrics-020 · shipped
A script archives GitHub traffic and release download counts to a local file outside the repo, one row per day with no duplicates.
- asked: 2026-10-15
- shipped: f8d4b23f

### R-metrics-021 · shipped
The repo health score has Ask-AI buttons: one on the index box asking what moved the picked week, and one, *assess and propose improvements*, that reads whether the repo is getting healthier and then posts each proposed change as a held backlog row the person fires, edits or deletes (no file changed, nothing started), with a disclaimer that the biggest lever may not move the five generic readings.
- asked: 2026-10-16
- shipped: 86e52da1, 81e3edb5, 6e8483f7
- amended: 2026-10-19 (owner: advice-on-request replaced by one tap whose proposals land as backlog rows, approved one at a time; button renamed from "ask if it is getting healthier")

### R-metrics-022 · shipped
A repo can overwrite or disable one of the centrally provided health readings in its committed health.json (with a reason), and add its own readings beside them without replacing them.
- asked: 2026-10-16
- shipped: d09adb82, 2f156069

### R-metrics-023 · shipped
The health chart plots tokens per request as a line beside the score, and its hint says context size raises both cost and waiting time and names the readings that directly affect it.
- asked: 2026-10-17
- shipped: 56e8ec5f

### R-metrics-024 · shipped
The health charts have a toggle switching the x-axis between weeks and commits, with a score per commit.
- asked: 2026-10-17
- shipped: c9e436db, d358a466

### R-metrics-025 · shipped
The VS Code extension's Health view matches the phone's repo-health region: cards, a sticky jump bar, a weeks|commits x axis, the tile grid, the score card with its spend line, and the same current health value as the phone.
- asked: 2026-10-17, 2026-10-17
- shipped: 7c26e7fe

### R-metrics-026 · shipped
The current repo health score is calculated from current data alone, without needing commit history.
- asked: 2026-10-17
- shipped: 87750d7a

### R-metrics-027 · requested
When repo health has no score, the view shows a plain sentence explaining why, never a prompt to restart the desktop app.
- asked: 2026-10-17

### R-metrics-028 · shipped
The repo-health engine counts .mts and .cts files as TypeScript source.
- asked: 2026-10-18
- shipped: 7f7a22ba

### R-metrics-029 · requested
The metrics view has a button that resets the stats so the user can start over.
- asked: 2026-10-19

### R-metrics-030 · shipped
When a repo's own health engine copy fails, the view offers a button that seeds a prompt asking the agent to adopt the desktop's engine for the repo's item metrics.
- asked: 2026-10-19
- shipped: 6e2394a1

