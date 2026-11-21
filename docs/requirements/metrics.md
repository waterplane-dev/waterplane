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

### R-metrics-010 · superseded
The all-sessions view has well-structured data, visible charts and extra cost/usage insights, with filter buttons clearly tied to what they filter.
- asked: 2026-09-26
- shipped: ae9c3d7
- superseded-by: R-metrics-078

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
The This desktop sheet draws CPU, memory, GPU, held memory, temperature and fan readings as full-width graphs with axes and a current value, and also draws disk space as a history graph.
- asked: 2026-10-07
- note: Full-width graphs with axes, temperature and fans shipped in 74e3f90b; no disk history graph yet.

### R-metrics-016 · shipped
The VS Code extension shows repo health metrics over time.
- asked: 2026-10-11
- shipped: c4b2f739


### R-metrics-017 · shipped
Each repo has a health score, 0 to 100, read week by week from eleven readings (size, rework, escape hatches, context weight, untested files, and the six of R-metrics-055: duplicate code, dead exports, import cycles, files that change together, fixes after a change, tests changed with code), each against a fixed good value and read as lower-is-better, except tests changed with code, which is higher-is-better; the score is the geometric mean of the readings that could be measured (plus any own reading the repo gives a target, R-metrics-066), but never more than 30 above the worst one, never more than 100 × measured ÷ applicable, and held under 50 by a failing gate the repo declares (R-metrics-053), and the phone says which cap holds it down. A reading under 50 raises a warn alert and under 25 a severe one, each naming the offender (the longest file by path); the week-over-week trend sits second, and an unusual move against the score's own noise warns (drop) or praises (rise). Every repo is notified of a called move, and once more when a reading newly turns severe (never on a repo's first scored week, nor for one that was severe already); a chip shows in the main view. The good values are provisional.
- asked: 2026-10-15 (owner); reworked to an absolute score with cap, alerts and trend 2026-10-17 (owner); push on a new severe alert 2026-10-17 (owner); coverage and gates 2026-11-09 (owner, R-metrics-053)
- shipped: healthwatch.ts (host); chip in packages/web; healthindex.ts (shared); Health view in packages/vscode

### R-metrics-018 · shipped
A repo can declare readings of its own in a committed `.waterplane-shared/health.json` (argv run at HEAD, one number out, absent with a reason otherwise); they are stored in the series beside waterplane's and enter the health index only where the repo says so — as a gate (R-metrics-053) or with a target (R-metrics-066) — and every reading on the phone says whose it is — waterplane's (the same for every repo) or the repo's own — with one line on how to add one where a repo has none.
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
The repo health score has Ask-AI buttons: one on the index box asking what moved the picked week, and one, *assess and propose improvements*, that reads whether the repo is getting healthier, lists its proposed changes and asks which to keep, then posts only the ones the person picks as held backlog rows they fire, edit or delete (no file changed, nothing started), with a disclaimer that the biggest lever may not move the generic readings.
- asked: 2026-10-16
- shipped: 86e52da1, 81e3edb5, 6e8483f7
- amended: 2026-10-19 (owner: advice-on-request replaced by one tap whose proposals land as backlog rows, approved one at a time; button renamed from "ask if it is getting healthier")
- amended: 2026-10-28 (owner: proposals are discussed first — the agent lists them and asks; only the ones the person selects go into the backlog)

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

### R-metrics-027 · shipped
When repo health has no score, the view shows a plain sentence explaining why, never a prompt to restart the desktop app.
- asked: 2026-10-17
- shipped: 7c26e7fe

### R-metrics-028 · shipped
The repo-health engine counts .mts and .cts files as TypeScript source.
- asked: 2026-10-18
- shipped: 7f7a22ba

### R-metrics-029 · shipped
When a repo's own copy of the health engine fails, Setup & health offers a button that sends the agent a prompt to adopt the desktop's current engine.
- asked: 2026-10-19
- shipped: 6e2394a1
- note: Owner first asked for start over, then refined to the adopt-engine prompt button.

### R-metrics-030 · shipped
When a repo's own health engine copy fails, the view offers a button that seeds a prompt asking the agent to adopt the desktop's engine for the repo's item metrics.
- asked: 2026-10-19
- shipped: 6e2394a1

### R-metrics-031 · shipped
Repo health reports how many recent commits removed only comments or blank lines from a file near the line cap, so notes lost near the cap are visible.
- asked: 2026-10-21
- shipped: e34537cf

### R-metrics-032 · shipped
A daily job archives reach numbers (GitHub views, clones and stars, npm downloads, Marketplace and release installs, Google Play installs), one reading per day.
- asked: 2026-10-24
- shipped: 599fed7a, 4a57ca39, 39d00f35, 66abcdc2

### R-metrics-033 · shipped
A local dashboard reachable over Tailscale charts the reach numbers (views, clones, stars, npm downloads, installs) on one day axis, and marks npm publish days and GitHub release days on the charts. Each KPI tile carries its own small chart, all sharing the same x time scale.
- asked: 2026-10-24, 2026-10-25
- shipped: 0a3011d3, b98be267, ad48c626, 360f0586

### R-metrics-034 · requested
The reach dashboard opens from the Links sheet with content, not a blank page, and loads in Brave as in Chrome; the app links to it.
- asked: 2026-10-24

### R-metrics-035 · shipped
Scorecard readings are available for private repos too, locally.
- asked: 2026-10-26
- shipped: e7ac925c


### R-metrics-036 · shipped
A session's context view says what every turn of it carried (instructions, skills, MCP, agents, hooks, system prompt, tools), measured on that log's first request, next to that request's total tokens with the unexplained remainder named; it says so plainly when the log or host cannot tell.
- asked: 2026-10-26
- shipped: e5abc64a, eafed83a

### R-metrics-037 · shipped
In the all-sessions view each costliest conversation names its first request's tokens, measured, with no estimate or average.
- asked: 2026-10-26
- shipped: 2d220c87

### R-metrics-038 · shipped
The health score has a third button, *start a design-quality run*, that seeds (never sends) a prompt for a run that changes code: the index is named as not the target, a file split is allowed only inside a design change that says what it separates, tests come first, each change is reviewed by someone who did not write it, the repo's own readings are reported each round (or one is proposed where there is none), and the run stops implementing when only splits remain and asks which proposals go into the backlog.
- asked: 2026-10-29
- shipped: 1db8da28

### R-metrics-039 · shipped
When the score rises, its sentence names the cap lifting as its own part, splits the move exactly between the readings and the cap, and says "mostly files split up" with the file and line counts where file length carried most of the rise while the source files grew by half or more and the code did not shrink.
- asked: 2026-10-29
- shipped: 9f22d253, c49a21b0

### R-metrics-040 · shipped
The repo-health engine reads the import graph between a repo's own modules and plots two tiles that the health index does not read: files in import cycles (the largest cycle named by its files) and imports per file at the p95 (the file with the most named). Imports through tsconfig `paths` aliases and workspace package names are followed; if fewer than 90% of a repo's own imports resolve, both tiles show no number and name the imports that could not be followed, never a lower one. TypeScript/JavaScript only for now; other languages read as absent. Kill criterion: removed if after about four weeks the cycles tile has not pointed at something someone fixed.
- asked: 2026-10-30
- shipped: dce27e9b
### R-metrics-041 · shipped
The owner sees how many people, and how many unique visitors, visit waterplane.dev, from a built-in counter on the owner's own Google Cloud account that costs effectively nothing, uses no third-party analytics service, no script and no cookies, reads nothing from the visitor's device (no consent banner needed), never logs or stores raw IPs (unique visitors are salted daily hashes that expire within about a day), and is GDPR compliant for EU visitors.
- asked: 2026-10-30
- shipped: 80eff9f9, 62de4d8b, 69b5ef27

### R-metrics-042 · shipped
When the health engine's definition changes, a series measured under the older one is not mixed with new readings; one tap on the phone re-cuts it under the current definition and keeps the old series aside.
- asked: 2026-10-30
- shipped: 6f82322f

### R-metrics-043 · shipped
The reach page on the tailnet shows the waterplane.dev visit counts and the unique visitor count beside the page views.
- asked: 2026-10-30
- shipped: 69b5ef27, 8aa8d73f, 2b3262d0

### R-metrics-044 · requested
On the reach page, unique visitors are drawn as a second line in the same graph as page views.
- asked: 2026-10-30

### R-metrics-045 · requested
A repo that carries its own copy of the health engine never loses its charts because an update ran past its time limit; the measured series is kept intact.
- asked: 2026-10-30

### R-metrics-046 · shipped
Metrics such as page views have a refresh button that pulls fresh reach metrics on demand.
- asked: 2026-10-31
- shipped: 26cf42c0

### R-metrics-047 · shipped
The phone runs a repo-health re-cut itself with a button, rather than requiring the desktop to do it.
- asked: 2026-10-31
- shipped: 6f82322f

### R-metrics-048 · requested
The BA3 web app counts usage in the same lightweight way as waterplane.dev, in addition to keeping Google Analytics.
- asked: 2026-11-02

### R-metrics-049 · shipped
The CPU figure shown for a peer host (such as the zenbook under WSL2) matches the system monitor instead of reading too low.
- asked: 2026-11-03
- shipped: e2b54b97

### R-metrics-050 · requested
The reach dashboard is also available as a private cloud dashboard only the owner can open, near-zero cost, and available during Mac network outages.
- asked: 2026-11-06


### R-metrics-051 · shipped
The repo-health reading checks a Dart/Flutter project like any other: which Dart modules no test reaches, duplicated code, exports nothing uses, and import cycles. Generated Dart is left out, and anything the reader cannot tell is shown as absent, never as zero.
- asked: 2026-11-09 (health-metrics plan, package P5)
- shipped: e1811395

### R-metrics-052 · shipped
The repo-health readings include git-only measures that work in any language: how many commits fix a change from the last week, how much is deleted per line added (moves not counted) and how many commits delete more than they add, how many source commits also change a test, p95 commit size, the files where churn and size multiply, tracked binaries and build output, and docs naming paths that no longer exist. A reading that cannot be taken (shallow clone, no tests recognised) says why instead of showing zero.
- asked: 2026-11-09 (health-metrics plan, package P3)
- shipped: a8e8088fb

### R-metrics-053 · shipped
The health index never reads 100 over code it could not read: beside the score it says how many of the dimensions that apply to the repo were measured and names each unmeasured one with its reason (such as "untested modules: no rule for how a Dart test names a module (391 of 537 source files)"); an unmeasured dimension counts for nothing, so the score is at most 100 × measured ÷ applicable. A repo can mark one of its own health.json readings as a gate (`"gate": { "fails": "below" | "above", "at": n }`); a failing gate holds the score under 50 and is named on the phone and in VS Code, and a gate with no reading counts as unmeasured, never as passed, while a passing gate never raises the cap; a reading the repo replaced with its own whole-repo command counts as measured.
- asked: 2026-11-09 (owner: picture-app read 100, "it can not be 100 good")
- shipped: healthindex/coverage.ts (shared), tools/repohealth/reach.mjs + own.mjs gate, HealthIndexChart.tsx (phone and VS Code)


### R-metrics-054 · shipped
The repo-health reading also shows what the repo's own tools already say, taken from the newest commit only: vulnerable dependencies by severity with the package and version (osv-scanner), the analyzer findings per 1,000 lines of each language present (eslint, the TypeScript compiler, ruff, mypy, the Dart or Flutter analyzer, shellcheck, detekt, ktlint), which strictness settings the configs state, and the coverage files already on disk that are newer than the last commit. A tool that is not installed shows "X is not installed", never zero; no tool is installed, no test is run and nothing is written into the repo.
- asked: 2026-11-09 (health-metrics plan, package P6)
- shipped: cb471274f

### R-metrics-055 · shipped
The health index scores six more readings the engine already takes, each against a good line calibrated on the owner's repos: duplicate code (near-duplicate block pairs per 1,000 lines read, good under 0.25), dead exports (exports no other file uses per 1,000 lines, under 1.5), import cycles (share of import-graph files in a cycle, under 1%), files that change together (median other files a change to a busy file touches, under 5), fixes after a change (share of recent source commits fixing what a commit in the week before changed, under 10%) and tests changed with code (share of recent source commits that also change a test, at least 50%). Each has a plain alert sentence; a reading the engine could not take is unknown with its reason and counts for nothing, never 100. When the weekly move was caused by a repo gate starting to fail (or passing again) or by the share of measured dimensions, the move sentence names that cause.
- asked: 2026-11-09 (health-metrics plan, package P2)
- shipped: healthindex/readings.ts + types.ts + words.ts (shared), tools/repohealth/reach.mjs, healthIndexWords.ts (phone and VS Code); calibration docs/analysis/health-metrics/P2.md

### R-metrics-056 · shipped
The repo-readings sheet has an Agent readings region with four weekly figures only this desktop's own claude conversation logs can give: exploration cost (median tokens a fresh session reads before its first file edit), rework spend (share of tokens in sessions whose first prompt or title says fix, repair, broken, again, bug, regression, revert or not working, plus review-repair workflow agents, beside feature and unknown — never filed as feature when unsure), compactions per session that committed, and escaped defects (crash groups marked in the exposure watch and backlog items marked bug). Each shows its split, each `?` quotes the rule the desktop applied, a week where a reading cannot be taken says why instead of showing zero, and none of them is part of the health score. The desktop reads a repo's logs once and afterwards only the ones that changed.
- asked: 2026-11-09 (health-metrics plan, package P7)
- shipped: host agentreadings.ts + agentscan.ts + agentclass.ts, GET /api/repos/:id/agentreadings, web AgentReadingsRegion.tsx

### R-metrics-057 · shipped
The Play install numbers on the reach dashboard are current, refreshed on demand by a Refresh Play button that shows each app's report count, rather than stuck at an old reading date.
- asked: 2026-11-07
- shipped: 2dae7963, 5c4a85bc

### R-metrics-058 · shipped
The VS Code tile on the reach dashboard shows its downloads (including updates) and their growth beside installs, current rather than frozen at an old date.
- asked: 2026-11-09
- shipped: abdc445a, 59f36c6d

### R-metrics-059 · shipped
The traffic-archive script accepts a Google service-account key file as input as well as a minted token.
- asked: 2026-11-08
- shipped: cc0e4a61

### R-metrics-060 · requested
Code survival is not used as a health metric; feature housekeeping is measured by cleanup and removal of code instead.
- asked: 2026-11-09


### R-metrics-061 · shipped
Every Agent readings figure is a weekly bar chart over the same twelve weeks, and tapping a bar picks that week for every chart (no separate row of week chips); the picked week's figure is a text line under each chart and a week not taken is drawn as an outline, never a zero bar. The region also carries what used to live only on other screens: the repo's weekly spend at list price with its request count, price per priced request and context per request (the token ledger's per-repo rows), and who did the work — conversations, how many started that week, subagents, and the own-versus-subagent token split.
- asked: 2026-11-11
- shipped: host agentclass.ts + routes/apirepowork.ts, shared healthspend.ts repoSpendByWeek, web AgentWeekBars.tsx + agentWeekPlot.ts

### R-metrics-062 · shipped
The always-on list (what every turn in a repo carries: its instruction files, subagents, MCP servers, hooks and this desktop's own files, with the doors to what each live session actually carried) is the first card of the agents region rather than under the set-up checklist's context-weight row. That row (since 2026-11-16 a finding in the Setup check, `repo.context-weight`) keeps its sentence, its threshold and its two-clocks figure, and gains a "what it is made of" door to the list (the threshold form sits on the agents region's always-on card); the context sheet's repo-readings door lands on the agents region.
- asked: 2026-11-11
- shipped: web SetupSheet.tsx, AgentReadingsRegion.tsx, features/context/actions.ts

### R-metrics-063 · shipped
The Agent readings region leads with three weekly readings that show whether an instruction change (CLAUDE.md, skills, memory, plugins) made agents cheaper or not, in any repo: Start context (the median tokens a fresh session's first request carried, measured off the logs, with the median characters per part under the same part names as the session's "what every turn carries" list, and the subagents' own start as a separate line — never mixed with the skills screen's estimated weights), Before the first edit (tokens sent and look calls made before a fresh session's first file edit, both over the same sessions, the look rule quoted in its `?`; this replaces Exploration cost) and Requests per committing session (in the week each session started). A week with fewer than five sessions behind a median says so instead of showing one. They are the same weekly figures the token-stats over-time card draws.
- asked: 2026-11-12 (agent efficiency readings, package P3)
- shipped: host agentclass.ts (foldAgentWeeks + RULES), agentreadings.ts; shared wire/agentreadings.ts; web AgentReadingsRegion.tsx, agentReadingsWords.ts
- amended: 2026-11-14 — the part lines are grouped by whose they are: the repo's, yours, the CLI's, and "not split" where the log records one block without saying where each line came from, said in words (R-metrics-068)

### R-metrics-064 · shipped
In Setup & health, the repo's own readings card sits right after the score, before waterplane's readings, and its jump-bar chip follows the score's.
- asked: 2026-11-14 (owner)
- shipped: web RepoHealthRegion.tsx, RepoHealthCards.tsx (shownSections order), healthIndexWords.ts (NAV_LABELS)

### R-metrics-065 · shipped
A repo's own readings can be backfilled on request: the phone offers a button that runs the repo's declared commands at older commits in a scratch worktree, so a curve shows without waiting for new commits; a reading that did not exist at an older commit is absent there, never 0. Days whose readings FAILED can be re-read (`own-backfill --retry`: a number wins, an old number is never lost to a new failure), and a repo may declare what its scratch copy needs for the commands to run there (`"scratch": { "linkNodeModules", "prepare" }` in health.json: a node_modules link that keeps the commit's own workspace packages, and a prepare argv run once per commit) — approved with the readings, so changing either asks again, and run only in the read-back scratch, never at HEAD.
- asked: 2026-11-14 (owner)
- note: retry + scratch added 2026-11-15; a failed prepare is `own.prepare` on the day, a re-read day is `own.retried`
- shipped: engine tools/repohealth/ownbackfill.mjs (`own-backfill` in tools/repohealth.mjs; own.mjs `skip` hook, `"backfill": false`); host repohealth.ts (backfillOwnReadings, sweepOwnScratch), routes/apirepohealth.ts (POST repohealth/own-backfill); shared repohealth.ts + repohealthread.ts (RepoHealthOwnBackfillAnswer, parseOwnBackfill); web repoHealthOwnBackfill.ts, RepoHealthOwn.tsx, RepoHealthRegion.tsx, webapi/webapiRepoOps.ts; tests tools/repohealth-ownbackfill.test.mjs, packages/host/test/repohealth.test.mjs, packages/web/src/repoHealthOwnBackfill.test.mjs

### R-metrics-066 · shipped
An own reading that declares a target (a good line) in health.json is scored like one of waterplane's readings and joins the health score, shown as the repo's own in the breakdown; a reading without a target stays out of the score. The sheet says that a score including own readings is not directly comparable with another repo's.
- asked: 2026-11-14 (owner)
- shipped: tools/repohealth/own.mjs (`"target": n`, above 0, refused like any bad field); healthindex/own.ts + score.ts + coverage.ts (shared: same curve as an entry in the reading's direction, `own:<key>`, in the mean, the worst-entry cap and coverage, absent = unknown with the reason, a declared or changed target marks a coverage gap); HealthIndexChart.tsx + healthIndexWords.ts (phone and VS Code: breakdown rows named "(the repo's own)", one not-comparable line)

- amended: 2026-11-14 — a reading marked `"backfill": false` measures this desktop, so it cannot take a target: the target is refused with a sentence on the card's problems line, the reading still runs and shows, untargeted, and the score ignores it even where a row carries one. (owner, R-metrics-069; own.mjs, healthindex/own.ts)

### R-metrics-067 · shipped
The agent readings count skill loads per session: how many times a session actually invoked a skill (a Skill tool call, counted by the same parser as the Skills screen's uses, R-skills-008). The weekly region shows the median per fresh session as a secondary line, and the token-stats Agent readings over time card draws it as a fourth reading with a before/after, with one help text. A session or log that cannot say has no count rather than 0; older phones ignore the field.
- asked: 2026-11-14 (owner)
- shipped: host skills/skilluse.ts (`skillCallsOf`, the one parser), agentscan.ts (`sk`), agentreadings.ts (store VERSION 4: old logs rescan); shared agentseries (`skills` reading, `SKILLS_RULE_TEXT`), wire/agentreadings.ts (`AgentPoint.skills`, week `skills`, rules `skills`); web AgentReadingsRegion.tsx, agentReadingsWords.ts; token-stats AgentSeriesCard.tsx, agentSeriesPlot.ts; tests packages/host/test/agentreadings.test.mjs, packages/shared/test/agentseries.test.mjs
- amended: 2026-11-14 — a weekly median of skill loads is 0 or 1 (most sessions load none), so the reading is the mean loads per session beside the share of sessions that loaded at least one, with the n behind both, absent under the same minimum of five; its before/after compares means and says so. The week field is `skillLoads` (an older phone, which read `skills` as a median, shows no card rather than a wrong one); every other reading stays a median. (owner, setup-panel P2)

### R-metrics-068 · shipped
Start context is grouped by whose each part is, so two people on one repo can see what differs: the repo's (the project CLAUDE.md, committed, the same for everyone on it), yours (global and local CLAUDE.md, the memory index, connector tool names), the CLI's (system prompt, tool schemas, built-in deferred tools and subagents, moving with version and model), and "not split" for what the log records as one block without its source (the skill listing, other subagents, hooks, session context, and anything an older host sent whole) — said in words, never assigned to a side by guess. Part keys stay open strings, so another backend can name its own and an unknown key shows as such. The token-stats Agent readings over time card draws a model change and a CLI version change on the same day, or on neighbouring days where no session ran one without the other, as ONE "Model + CLI" marker naming both, and a before/after around it says the two cannot be told apart.
- asked: 2026-11-14 (owner, setup-panel P2)
- shipped: host agentclass.ts (`startPartsOf`: file type, `mcp__` names, `builtInTypes`), agentreadings.ts (store VERSION 5: rescan); shared wire/agentreadings.ts (`StartPart` open, `START_GROUPS`, `START_PARTS` groups, `startGroupOf`, `partsByGroup`), agentseries/markers.ts (`modelCli`, `MODEL_CLI_TEXT`); web AgentReadingsRegion.tsx, agentReadingsWords.ts (`startPartGroups`); token-stats AgentSeriesCard.tsx, agentSeriesPlot.ts (`groupedPartOrder`, grouped `partTwinWords`, `modelCli` row); tests packages/shared/test/agentseries.test.mjs, packages/host/test/agentreadings.test.mjs, packages/web/src/agentReadingsWords.test.mjs, packages/extensions/token-stats/web/agentSeriesPlot.test.mjs

### R-metrics-069 · shipped
Every reading that comes from this desktop rather than from git (the agent readings / setup panel: conversation logs, local settings, memory, model and CLI; probe results; an imported colleague's block; a repo's own reading marked `"backfill": false`) says so plainly, once per card in the same words, in contrast to the health score and waterplane's readings, which are built only from checked-in git data and read the same on every desktop.
- asked: 2026-11-14 (owner)
- note: partly shipped 2026-11-14 (P2, P3) for the agent readings: one sentence, shared `agentSourceText()`, said ONCE for the whole Agent readings region as the caption under its headline (P3: no longer repeated visibly on every card, which said one fact eight times) and in every card's `?`, and once on the token-stats Agent readings over time card; P5 (2026-11-14): an imported setup block names whose desktop it came from and its days in shared `shareSourceText(name, days)`, once per imported block on the Compare setups card (R-metrics-073)
- amended: 2026-11-14 — a repo's own reading marked `"backfill": false` carries that on the wire (`RepoHealthOwnSeries.backfill`) and its tile's means line says, once, in shared `ownThisDesktopText()`, that it reads this desktop, not the commit, and is not in the health score; no target counts for it (R-metrics-066). Tests tools/repohealth-own.test.mjs, packages/shared/test/healthown.test.mjs, packages/web/src/repoHealthWords.test.mjs
- amended: 2026-11-14 (P7) — probe results say their source: the Lookup probe card says shared `probeSourceText()` once (and in its `?`), each result names the desktop it ran on with `probeFromText`; an imported setup block names whose desktop it came from (`shareSourceText`, P5). The agent readings, probe results and imported blocks now all say it.
- shipped: 2b44570e3, eb4eccf35, da23be2fe, 1ec26dc6f

### R-metrics-070 · shipped
The Agent readings region opens on a headline: what the setup costs a median session — the start context (what the first request carries before anyone types) times the session's requests, priced at the model's cache-read rate at list price, in dollars with the tokens beside it, the median of that per-session product over the last 14 days' fresh interactive sessions (at least 10) — with its split by whose it is (the repo's / yours / the CLI's / not split, as shares of the measured part characters, never a dollar figure per group), what it is made of, and that it errs low (the first cache write and rebuilds after a pause are left out). A session on a model with no list price stays in the tokens and out of the dollars; too few priced ⇒ tokens only, said so. Beside it the last probe ("none run yet" until the probe ships) and one pattern sentence around the newest change that has a before/after on two or more readings (start context, looks before the first edit, requests, skill loads; one model at a time, the before/after's own band): none outside ⇒ "no detectable change", one ⇒ it and the rest within normal variation, two or more ⇒ each with its direction and, where the directions fit a known shape, the pattern's name (e.g. start down with looks or requests up: "the pattern of a trim that removed something agents used"); it says how many other changes fall in the same days, which a before/after cannot tell apart. Neutral words only, never better or worse; no 0–100 score.
- asked: 2026-11-14 (owner, setup-panel P3)
- amended: 2026-11-14 (setup-panel review) — a move under 2% (`PATTERN_MIN_MOVE`) counts as within however narrow the day-shuffle band is, so a sub-1% shift in start context never names a pattern. The headline's last-probe line for a paired result names both sides (B of A, or now of before) and says requests beside tokens, each outside or within normal variation.
- shipped: shared agentseries/setupcost.ts (`setupCostOf`, `cacheReadRate`), agentseries/pattern.ts (`setupPatternOf`, `patternName`, `setupPatternText`); web AgentReadingsRegion.tsx (`Headline`, over the token-stats card's points and markers), agentReadingsWords.ts (`setupCostLine`, `setupCostBeside`, `setupSplitLine`, `PROBE_NONE`, `headlineHelp`), repohealth.css; tests packages/shared/test/agentsetup.test.mjs, packages/web/src/agentReadingsWords.test.mjs


### R-metrics-071 · shipped
A lookup probe measures whether this desktop's setup still finds things and at what cost: a seeded draw of 20 questions from the repo's committed pool (`.waterplane-shared/probe.json`: question, answer patterns that accept other spellings, an owner who keeps them true; a repo without one is told how to add one), asked read-only (Read, Grep, Glob, Skill; no MCP; default permission mode; 12 turns, a cap hit is wrong) in a detached scratch worktree at a pinned commit with the pool removed from it and the worktree removed after, 3 repeats per arm by default with the arms interleaved. Correctness is a pass/fail gate; the headline is tokens and requests per question at equal correctness, paired over the draw with a 95% interval and said inside or outside the repeat-noise band (calls beside them, said to be noisier); dollars are never a figure. Comparisons: model against model on a fixed setup, and before/after against a stored baseline with its setup fingerprint (backend, model, CLI, start-context tokens, commit) and the differences named. It is tap-started only, with the estimate (tokens, and dollars at list price) accepted before the start and refused if the estimate grew; the halt gate is honoured, a question past its token cap has its process group killed, and the run stops at twice the estimated tokens. A tool input outside the scratch worktree (the person's memory excepted) or naming the pool voids the result. Results are kept per repo on this desktop, name it and say they come from it; the probe's own transcripts never enter the agent readings. One run per repo at a time.
- asked: 2026-11-14 (owner, setup-panel P6)
- shipped: shared wire/probe.ts, probe/ (pool.ts `parseProbePool` `drawProbeQuestions` `probeSchedule` `probeCorrect`; leak.ts `probeLeakOf`; analyze.ts `analyzeProbe` `probeGate` `probeFingerprintDiff`; estimate.ts `probeEstimate` `probeAcceptedCovers` `probeSourceText`); host probe.ts (`ProbeRunner`, `scratchStaysOut`, `sweepProbeScratch`), sidecar/sidecarprobe.ts (`probeArgv`, `ProbeStreamReader`, `runProbeAsk`), sidecarclaude.ts (`signal`, `runToolTask` `trustOf`), sidecarroute.ts (`probe` task, `WATERPLANE_SIDECAR_PROBE`), routes/apiprobe.ts (GET probe, GET probe/results, POST probe/start); pool .waterplane-shared/probe.json (46 questions, private; the Windows peer-dir question left 2026-11-14, its answer goes stale at the pending folder rename); tests packages/shared/test/probe.test.mjs, packages/host/test/probe.test.mjs
- amended: 2026-11-14 (setup-panel review) — tap-started is enforced on the host, not only by the phone's button: `POST probe/start` needs a browser `Origin` and the one-shot `confirm` token the idle `GET probe` minted for that worktree (`confirmgate.ts`, `PROBE_SCOPE`), consumed only when the run began; a view of a live run mints none. An Origin-less caller (a script, a driven session) cannot start a run by writing its own `accepted`. Test packages/host/test/probe.test.mjs.
- note: the phone card is R-metrics-074 (P7); person-to-person goes through the export block (P5)

### R-metrics-072 · shipped
Compare by model on real work: the setup panel's readings (start context, looks before the first edit, requests per committing session, skill loads as a mean with the share that loaded one) over a chosen window of days (7, 14 or 28, back from now), split by the model each session ran on — the two models with the most sessions side by side, each with its figure, sessions and days — against the before/after's own day-shuffle band (whole day blocks, a day both models ran being one block per model, shuffled between the two models): the ratio and whether it is within or outside normal day-to-day variation, neutral words only. Each model needs the before/after's minimum (10 sessions on 4 days) or that reading is absent with the sentence why, never a number from a handful of sessions. One model only — the usual state, since main sessions run one model at a time — is said plainly in one sentence; how to get a comparison (alternate models by day for a week or two) is in the `?`, not always-on prose. Where every session of one model ran a CLI version none of the other's ran, it says the model and the CLI changed together and cannot be separated. Further models and sessions with no model are named, not pooled. Shown as a "by model" view of the token-stats Agent readings over time card, and as one compact row in the Agent readings region's headline only when two models have enough sessions. The region's "read again" re-reads the headline's points and markers as well as the weekly readings.
- asked: 2026-11-14 (owner, setup-panel P4)
- shipped: shared agentseries/bymodel.ts (`compareByModel`, `compareByModelAll`, `byModelCliText`, `BY_MODEL_ALTERNATE_TEXT`), agentseries/compare.ts (`dayShuffleBand`, the one band both comparisons use); token-stats AgentModelCompare.tsx, AgentSeriesCard.tsx (view chips), agentSeriesPlot.ts (`byModelSideWords`, `byModelWords`, `byModelNotes`, `byModelHelp`); web AgentReadingsRegion.tsx (`Headline` row, `readAgain`), agentReadingsWords.ts (`byModelRow`); tests packages/shared/test/agentbymodel.test.mjs, packages/extensions/token-stats/web/agentSeriesPlot.test.mjs, packages/web/src/agentReadingsWords.test.mjs

### R-metrics-073 · shipped
Team members on one repo compare their local setups side by side through an export block, never git. Export, from the Agent readings region's "Compare setups" card: a versioned JSON block holding ONLY the schema version, the backend, the model ids and CLI versions the sessions ran, a display name the person chooses (asked once, kept on that phone), the repo as a name plus a 16-hex hash of its normalised origin remote (never a path; absent where there is no shared remote), the date range in whole days, the median first-request tokens, start-context part sizes as character medians grouped the repo's / yours / the CLI's / not split (part keys open strings), and an optional typed probe summary slot (filled from the newest non-void probe result, R-metrics-074). Never markers, file/skill/plugin/tag names, session counts, times finer than a day, behaviour readings (looks, requests, skill loads, and the setup cost figure: its tokens ÷ the start tokens is requests per session), prompts or paths; every figure is a median over at least five sessions, a part with fewer is left out rather than counted, and a part key the version does not name (which could name a plugin or connector) is folded into its group's "parts this version does not name" before anything is measured. The exact text that leaves is shown as a preview before it leaves; it goes out by copy, or by a write to the repo's `.claude/outbox/` that the desktop re-reads through the import's own strict parser, fetched with the one download button. Import: paste or pick a file; a size cap, then every field rebuilt from the ones the parser names (extra fields dropped and counted, never kept), anything out of shape refused with one sentence; kept on this phone only, each block removable with a two-tap remove. The side by side shows yours and theirs per group and part as two figures, never a difference, a ranking or "better"; the repo's half is labelled identical by construction, and flagged when it is not (different commits of the instruction files), when it is another repo, or when either side names no remote; a caption says the differences are setup, not skill; each imported block names whose desktop it came from (R-metrics-069).
- asked: 2026-11-14 (owner, setup-panel P5)
- shipped: shared agentseries/share.ts (`setupShareOf`, `setupShareText`, `shareKeyOf`, `SetupShareBlock`, `SetupShareProbe`), agentseries/shareparse.ts (`parseSetupShare`, `setupShareCompare`, `SETUP_SHARE_MAX_CHARS`), wire/agentreadings.ts (`shareSourceText`, `AgentPointsDoc.share`); host setupshare.ts (`shareRepoOfUrl`, `writeSetupShare`), routes/apiagentpoints.ts (`share` on the repo's points, `POST /api/repos/:id/setupshare`); web SetupShareCard.tsx, agentReadingsWords.ts (`SHARE_*`, `shareRowLine`, `shareRepoHalfText`), storage keys `setupShareName` / `setupShareImports` (device, never synced); tests packages/shared/test/agentshare.test.mjs, packages/host/test/setupshare.test.mjs, packages/web/src/agentReadingsWords.test.mjs
- amended: 2026-11-14 (setup-panel review) — the probe slot also carries the model the probe ran on, how many questions were asked and an 8-hex fingerprint of which ones (`probeDrawKey`; never the ids), because each desktop draws its own questions and a probe's model is typed at the card. The side by side names the model and count on each line and, under them, says when the two probes ran on different models or drew different questions, or when a block from an older version does not say; an older block without these fields still parses.
- amended: 2026-11-14 (owner, P7) — the setup cost figure (usd and tokens) left the block: with the start tokens it gives requests per session, a behaviour reading. Start-context parts and start tokens stay; a block that still carries `cost` has it dropped on import and counted among the fields this phone does not read (never kept, never a refusal). The side by side shows each side's start tokens and, when a block carries one, its probe summary. Tests packages/shared/test/agentshare.test.mjs, packages/web/src/agentReadingsWords.test.mjs

### R-metrics-074 · shipped
The Agent readings region carries a "Search test" card (named "Lookup probe" until 2026-11-14) in its "test & compare" view, the phone half of R-metrics-071; the card says in one line what the test is before anything else. It lists the possible kinds — model A vs B (the first use), save a baseline, rerun against a baseline (offered only once a non-void baseline is stored on this desktop, said in words when none is) — and shows the price estimate, dollars at list price with tokens, BEFORE the tap; the start is a two-tap confirm naming the price, and the estimate is sent back as `accepted`. A refusal shows the host's sentence. While a run is live its progress is re-read over plain fetch on a timer (never a second socket, nothing waits on it). The newest result shows the correctness gate passed or not with the counts, tokens and requests a question per arm, the paired ratio with its interval and band said "outside" or "within normal variation", a void result with its reason, and once per card where it comes from (`probeSourceText()`), each result naming the desktop it ran on. Never "better" or "worse". A repo with no `.waterplane-shared/probe.json` gets one line on how to add one. The headline's "Last search test" slot says the newest result in one line; the export block's probe slot is filled from the newest non-void result.
- asked: 2026-11-14 (owner, setup-panel P7)
- shipped: web ProbeCard.tsx, probeWords.ts (`probeGateLine`, `probeArmLine`, `probePairLine`, `probeVoidLine`, `probeLastLine`, `probeShareOf`, `probeConfirmText`), AgentReadingsRegion.tsx (probe view + results read once for headline, card and export; "read again" re-reads them), SetupShareCard.tsx (`probe` slot), webapi/webapiRepoOps.ts (`probeView`, `probeResults`, `probeStart`); tests packages/web/src/probeWords.test.mjs, packages/web/src/agentReadingsWords.test.mjs

### R-metrics-075 · shipped
Every reading tile on the repo-readings sheet — waterplane's own readings and a repo's declared ones — says under its value which way is better: "lower is better" or "higher is better" with an arrow, or "neither way is simply better" when both directions can be good news, and an opened tile adds the reason in one sentence. The line belongs to the METRIC, never the reading: it is the same whatever the value or slope, carries no colour, and the reader holds the slope against it. A repo's own reading takes the repo's declared `better`; one that declares none says so. A reading the engine adds later fails a test until it has a line.
- asked: 2026-11-14 (owner: "every metric needs a clear hint of larger or smaller is better or if it's not as easy as that")
- shipped: web repoHealthWords/repoHealthWordsAim.ts (`SERIES_AIM`, `seriesAim`, `aimWords`), RepoHealthTiles.tsx (`Aim`, `SeriesTile`'s `better`, `TileGrid`'s `betterFor`), RepoHealthOwn.tsx; test packages/web/src/repoHealthWords.test.mjs
### R-metrics-076 · shipped
The repo reports a repairRate reading: the share of non-repair source commits followed within 7 days by a repair commit touching the same files, one number between 0 and 1, with a list view naming each repaired commit.
- asked: 2026-11-11
- shipped: 59ff26ed5

### R-metrics-077 · shipped
The repo reports the share of vault host source lines that no vault test or e2e run executes, measured with V8 coverage across the processes the tests start, and lists files and functions with zero coverage.
- asked: 2026-11-11
- shipped: a46a7f450, 41b50e65d


### R-metrics-078 · shipped
Setup check is one ranked list of findings in three groups (this repo, this machine, account); a machine finding is shown once, never under each repo.
- asked: 2026-11-16 (owner, setup check plan PLAN.md §8)
- shipped: setup check plan 2026-11-16; tests: packages/shared/test/findingrules.test.mjs, packages/host/src/setupcheck/setupcheck.test.mjs

### R-metrics-079 · shipped
Each finding states its saving per week in dollars at list price with tokens beside it, worded as the billing profile words money; the saving is absent where it cannot be priced (claude-local, opencode, an unpriced model) and never estimated from nothing.
- asked: 2026-11-16 (owner, setup check plan PLAN.md §8)
- shipped: setup check plan 2026-11-16; tests: packages/shared/test/findings.test.mjs

### R-metrics-080 · shipped
A machine finding's saving is summed over every repo's sessions on this desktop and says how many sessions and repos.
- asked: 2026-11-16 (owner, setup check plan PLAN.md §8)
- shipped: setup check plan 2026-11-16; tests: packages/shared/test/findings.test.mjs

### R-metrics-081 · shipped
Each finding names the backends it read; a backend it could not read is named as not read, never as fine.
- asked: 2026-11-16 (owner, setup check plan PLAN.md §8)
- shipped: setup check plan 2026-11-16; tests: packages/shared/test/findings.test.mjs, packages/shared/test/findingrules.test.mjs

### R-metrics-082 · shipped
A finding's evidence door opens the existing screen cut to that item, with "n of N" and a clear.
- asked: 2026-11-16 (owner, setup check plan PLAN.md §8)
- shipped: setup check plan 2026-11-16; tests: packages/web/src/features/setupCheck/logic.test.mjs, packages/extensions/token-stats/web/tokenFocus.test.mjs

### R-metrics-083 · shipped
The repo badge counts exactly the rows its tap opens.
- asked: 2026-11-16 (owner, setup check plan PLAN.md §8)
- shipped: setup check plan 2026-11-16; tests: packages/web/src/features/setupCheck/logic.test.mjs

### R-metrics-084 · shipped
No composite score; findings are ordered by priced saving, then tokens.
- asked: 2026-11-16 (owner, setup check plan PLAN.md §8)
- shipped: setup check plan 2026-11-16; tests: packages/shared/test/findings.test.mjs

### R-metrics-085 · shipped
A finding can be waived with a reason, per repo or for this machine, and is then listed folded and not counted.
- asked: 2026-11-16 (owner, setup check plan PLAN.md §8)
- shipped: setup check plan 2026-11-16; tests: packages/host/src/setupcheck/setupcheck.test.mjs

### R-metrics-091 · shipped
Every findings view lists, beside its findings, what was checked and found fine ("checked, nothing to fix") and what could not be checked with the reason ("not checked: ..."), so the view is never empty; a waived finding moves to the checked-off list labelled "waived: <reason>". This holds on the phone's Setup check, the token-stats line ("N findings · M checks passed"), VS Code's Findings and the CLI.
- asked: 2026-11-16 (owner, setup check plan PLAN.md §0)
- shipped: 42966152a, 8d3f3b7c9, c9392c6e3, 9971e5019; tests: packages/shared/test/findings.test.mjs, packages/host/test/setupcheckcli.test.mjs

### R-metrics-086 · shipped
Setup check has an "all repos" view: a repo finding that repeats is listed once with the repos it is open in, counted against the repos it could be checked in ("in 7 of 33 repos"); machine and account findings are not repeated there. Auto-compact from the user-level setting (or none anywhere) is one machine finding; only a repo whose own settings override it has a repo finding.
- asked: 2026-11-16 (owner, ALL-REPOS.md and its decision 4)
- shipped: tests: packages/shared/test/findingsrollup.test.mjs, packages/shared/test/findingrules.test.mjs, packages/host/test/setupcheck.test.mjs, packages/web/src/features/setupCheck/logic.test.mjs

### R-metrics-087 · shipped
Repos are not ranked against each other and no saving is summed across findings or repos; within one rule its repos are ordered by that rule's own saving, absent last.
- asked: 2026-11-16 (owner, ALL-REPOS.md decision 1)
- shipped: tests: packages/shared/test/findingsrollup.test.mjs

### R-metrics-088 · shipped
The all-repos view lists the repos with nothing open and, apart from them, the repos that could not be checked, each with its reason; a hidden repo is left out and said so.
- asked: 2026-11-16 (owner, ALL-REPOS.md §3.3)
- shipped: tests: packages/shared/test/findingsrollup.test.mjs, packages/host/test/setupcheck.test.mjs

### R-metrics-089 · shipped
A count of repos on a rule opens exactly those repos, and a repo there opens its own check cut to that rule, with "n of N" and a clear at both steps; Back returns to the overview with the group still open.
- asked: 2026-11-16 (owner, ALL-REPOS.md §3.2)
- shipped: tests: packages/shared/test/findingsrollup.test.mjs, packages/web/src/features/setupCheck/logic.test.mjs, scripts/ui/journey-back-lands.mjs

### R-metrics-090 · shipped
The main menu has a "setup check" line that needs no repo and carries no count; it opens all repos with two or more primary repos, else that repo, else this machine.
- asked: 2026-11-16 (owner, ALL-REPOS.md §3.5 and decision 2)
- shipped: tests: packages/web/src/features/setupCheck/logic.test.mjs, scripts/ui/journey-back-lands.mjs
### R-metrics-092 · shipped
The release installs tile counts only real release installs and leaves out each asset's self-check download.
- asked: 2026-11-16
- shipped: ab34ee29c

