# Changelog

## 0.9.7 - 2026-11-13

### New

- **Agent readings show what a session starts with.** The weekly readings add start context (with its parts), read-only looks before the first edit, and requests per committing session. A reading with fewer than five sessions is shown as absent, with the reason.
- **Agent readings over time, with markers.** A new card beside Over time marks changes such as instruction commits, model and CLI versions, and memory or skills listing steps. Tapping a marker compares the 14 days before and after it, with the band of normal variation, worded neutrally.
- **Weekly readings are bar charts.** Tapping a bar picks that week for every reading. Spend and who-did-the-work join them.
- **Dollar figures say where their prices come from.** Status bar tooltips name either Anthropic's price list with the date it was read, or the built-in price table with its date.
- **Fable 5.2 is priced** at $8 in and $40 out, with cache reads at $0.20. Sonnet 5.5 reads the cache at its published $0.10.

### Fixed

- **The Copilot week no longer starts a day early** on the 23- and 25-hour days when the clocks change.

## 0.9.6 - 2026-11-10

### New

- **Repo health reads more of your code.** Eleven new readings cover duplicate code, dead exports, import cycles, files that change together, fixes that follow a change, and tests changed alongside code. A reading that cannot be taken is shown as unknown and lowers coverage, never as a perfect score.
- **Repo health uses the tools you already have.** Vulnerable dependencies, analyzer findings, type strictness and coverage files are read from tools installed on your machine, each with a time limit. A missing tool is reported as absent with its reason, never as zero.
- **Dart and Flutter repos are read in full.** Import graph, test reach, clones and dead exports are now measured, so a Flutter repo no longer scores as if it had none of them.
- **Agent readings per repo and week.** The repo-readings sheet shows exploration cost, rework spend, compactions per committed session and escaped defects, read from your Claude session logs.
- **All sessions opens on the last scan.** The finished figures are kept on disk, so a new window or a reload shows them at once, with their age, while the refresh scan runs.
- **A reading that has not arrived says so.** Session, Always-on, Repo health, All sessions and Prompts show a spinning "Reading ..." line instead of an empty "nothing found" message, and All sessions adds a progress bar while logs are read.
- **Re-reading the logs and measuring repo health show VS Code's own spinner** in the status bar until they finish.

### Fixed

- **The extension starts no program except git.** Native-tool readings no longer try to run anything inside VS Code; each one is shown as absent with that reason.
- **A stopped first health read says so** instead of looking like an empty result.

## 0.9.5 - 2026-11-09

### Changed

- **Rebuilt with the shared waterplane modules of waterplane 0.1.22.** Nothing changes in what the extension shows or reads.

## 0.9.4 - 2026-11-08

### New

- **The file browser reopens in the folder you left.** Each repo remembers its own folder.
- **Every Questions card names the session's conversation beside its title.** Two sessions of one repo can now be told apart.
- **Each row in the tabs list shows its star, flag, prompt count and cost.** The launcher row already did.
- **The shift+tab chip sits at the very end of the key row**, past CLI.

### Fixed

- **A narrowed terminal no longer raises a false "asked you".** A narrowed screen kept the tail of an older, wider frame, and that text could end in a "?". A session that asked nothing showed a question, with the mixed text on its card. The agent's recap is also cut from the question check, so a "?" in it can no longer count as the ask.
- **The footer is no longer published as Claude's proposal.** Letters left on the composer's closing rule made the box run on into the footer. A proposal now needs a box that a rule closes.
- **A cached list no longer says the connection is down when it is up.** The age line read "down" under a strip showing 185 ms. It now says what is true: checking, connection down, no answer, or the host's refusal.
- **A sheet opened during a reconnect now reads the host when the connection returns.** It used to stay on its cached copy.
- **Smaller fixes.** The name fields on the New sheet open a lowercase keyboard, since project, folder and branch names are not sentences.

## 0.9.3 - 2026-11-06

### New

- **Render a changed Markdown file and edit it from its diff.** The diff has a rendered mode and a pencil. The file opens over the diff, so Back lands on that diff, re-read, in the mode you left it.
- **A repo can be shown under a name you choose.** Set it from the repo's own menu ("shown as…"). The name is stored on the host and shown on every device: launcher, tabs, Start sheets, pickers, search and push titles. The folder keeps its name, so nothing has to move to rename it.
- **Every reading on the connection strip has a chart behind its tap.** The health sheet charts ping, route, connection, unsaved items, sends and data by source over 1h, 24h, 7d or 30d. Drops, route moves and what is waiting are listed. Time the app was off screen is drawn as not measured. One sticky range control replaces seven pickers.
- **A crash finding can go to a session to be fixed.** Every finding now names its source.
- **The agent list and launcher have a drag grip.** A shortened agent list scrolls.

### Fixed

- **The context chart no longer slopes.** The window and the running total change only at a request, but the charts joined readings with straight lines, so a compaction read as an hour of draining. Both charts now hold a value until the next reading and drop at a compaction. The scrub and every total keep the real readings.
- **A dynamic workflow's agents are now counted.** They were in no figure: one session read 2 agents and $22 with 83 agents and about $207 spent. They now land on the turn of their Workflow call, and a row reads by what the agent was launched to do.
- **A retry line clears once the session answers.** "Retried (2/8), waiting for the reply" stayed up for the whole retried turn, so a working session looked like a failed retry. It now clears at the first reply.
- **A message sent with ultracode on is no longer left unsubmitted.** The labelled top rule of the composer was not recognised, so the words were read as already typed.
- **Smaller fixes.** The context sheet's name, buttons and age line sit on one edge, and its head scrolls away with the charts on a phone.

## 0.9.2 - 2026-11-04

### New

- **Run the pre-push checks without pushing.** The git view's Sync sheet has a new Run checks button. It runs your repo's own pre-push hook the way a push would, and pushes nothing. Each commit in the not-pushed list is marked with its result. A commit that passed offers Push up to here, which leaves newer commits local. The real push still runs the hook, so a result is only a mark and never blocks you.
- **The always-on list names the hooks that add to context.** A SessionStart or UserPromptSubmit hook in your settings, the repo's settings files or an enabled plugin now shows as its own row. Before, the list looked complete when it was not.

### Fixed

- **"% of week" no longer reads far too small a share.** On a desktop that does little of the week's work, the share was worked out against the whole account's usage, so a cheap session could trip the red spend mark. It is now refused in words when another paired desktop on the same account has done a large part of the week. An optional per-desktop setting adds up every paired desktop instead.
- **The incoming count says how old it is.** A checkout that had not fetched for weeks showed ↓0. The git sheet now fetches when it opens, and a count older than a day reads ↓? with its age in words.
- **Network failures when pulling are one calm notice.** A failed fetch gives its reason, such as a timeout or a transport error. A burst of network failures is one info notice naming every repo. A repo only asks for your attention after three network failures in a row.
- **Smaller fixes.** On Windows under WSL2 the CPU figure now covers all of Windows and no longer prints "0% in the kernel". The upstream-age note in the git review keeps its height when the branch list opens.

## 0.9.1 - 2026-11-02

- **Long or odd lines no longer stall the extension.** Reading a markdown file's front matter, or the activity and stats lines of a running session, could slow to a crawl on a very long line with a repeating pattern. These lines are now read in a single pass, so the time depends only on their length. Results for normal input are unchanged.

## 0.9.0 - 2026-11-02

0.8.0 and 0.7.0 were never published to the Marketplace; their changes ship here.

- **Repo health shows one series, the phone's.** When the repository holds a series the waterplane desktop app measured (`.waterplane/repohealth.jsonl`), that file is the one shown, always, and the refresh button reads it again (`read it again`) instead of measuring a second copy beside it. The two can no longer show different numbers. The extension's own copy is used only for a repository the desktop app has never measured.
- **Repo health reads the repository you are editing in.** A workspace opened on a parent folder (`~/dev`, holding many repositories) used to say "not a git repository". It now reads the repository that holds the active file, and a folder below a repository's root reads that repository. The panel's heading names it.

## 0.8.0 - 2026-10-30

- **Which build is running.** The status-bar tooltip and the panel's footer name this build: version, commit and build time (`0.7.0 · a1b2c3d · 27 Oct 08:42`, with `+ edits` when it was built from uncommitted changes). The repo's build list shows the same line for the build it last installed or published.
- **A cost window over undated records says so.** When part of Claude Code's log carries no date, a window it cannot place them in says how many it left out instead of printing a smaller total; every view words that count the same way.
- **The tree highlights a session only while the panel shows it**, and the note about left-out sessions always opens All sessions.
- **Always-on context lists files the way the phone does.** One row per file — path, then type and who reads it, then what it costs every request and on demand — instead of a four-column table that wrapped every path mid-word and split a skill into two rows. A folder with no instruction files of its own still draws the strip over this desktop's files.

## 0.7.0 - 2026-10-26

- **What every turn carries, measured.** The Session view shows what the conversation's first request actually carried, as Claude Code logged it: instruction files (with `~` paths and their type), the skill listing, MCP instructions, deferred tool names, subagent listing, hook context, and the system prompt and tool schemas (marked undocumented), with the unattributed rest as its own segment. One strip, a meter per row; hover reads a part, a click keeps it.
- **Always-on context draws the phone's strip.** Every file that reaches Claude Code on every request, by size and coloured by what the threshold does with it; MCP servers and other rows with no size are named markers, never a length. Hover reads a file, a click keeps it. **repo** and **desktop** chips cut the strip and the tables, and say how many rows they hide.
- **Listed beside the threshold:** `CLAUDE.local.md`, subagent descriptions (`.claude/agents/*.md`) and `.mcp.json` servers, plus this desktop's own files (user CLAUDE.md, auto-memory, user skills, plugin skills, user MCP servers). A line above `CLAUDE.local.md` and subagent files says what each costs. A repo file's name opens it.
- **The sidebar says the measured figure too.** Each session row ends with its first request's tokens (`first request 61k`), and Always-on context puts the newest session's first request beside the folder's estimate; the tooltip says which is which. The status bar's session tooltip names it as well.
- **Doors between the three views.** Session, Always-on context and All sessions each link to the other two; a costliest-conversation row in All sessions that is one of this folder's sessions opens it in the Session view (**context & cost**). All sessions' rows show each conversation's first request as a bar.

## 0.6.1 - 2026-10-24

- **Clicking the Copilot row no longer asks to sign in to GitHub.** It opens Copilot Chat's token use read off this machine's logs. GitHub's quota figure is its own optional action: the GitHub button on the row, or right-click.
- **The tree counts Copilot on a machine without Claude Code.** All sessions' headline shows Copilot Chat's tokens for the last seven days when Claude Code's logs have none, and Sessions says where Copilot's went instead of only "No Claude Code logs".
- **Always-on context reads skill descriptions the way a YAML loader does.** A `SKILL.md` with a byte-order mark, blank lines before its `---`, a quoted `"description"` key or an empty frontmatter block showed 0 chars every request and its whole text as body; a `>`/`|` description no longer counts the marker. A skill whose frontmatter really has no description says so on its row.
- **Two more Copilot settings are followed:** `chat.useAgentSkills` (off drops Copilot from every skill row) and `chat.includeApplyingInstructions` (off drops Copilot from `.instructions.md` files attached by `applyTo`).

## 0.6.0 - 2026-10-23

- **Token statistics with Copilot and no Claude Code.** All sessions gains a **Copilot Chat** tab: the prompt and output tokens Copilot itself recorded under each answer, per day and per model, with the premium requests beside them — read off this VS Code's chat logs, no desktop needed. On a machine where Claude Code has no logs, the view opens on it instead of an empty Claude screen.

- **All sessions is the phone's token screen itself.** The view used to re-create it from the phone's cards with its own copy of the screen's logic, and fell behind it; it now draws the phone's own body and stylesheet, so every span, switch, chart and sentence is the same and stays the same.
- **Live limits from the waterplane desktop, if you want them.** Off until switched on (the line at the top of All sessions, or `waterplane.desktopUrl`): the view then reads a waterplane desktop on this machine — loopback only — and adds the five-hour and weekly limit windows, the week since the reset, the dollar period, the past-window grids and the other backends' ledgers.

## 0.5.1 - 2026-10-21

- Repo health uses a git that runs, not just the first one on the extension's PATH: each candidate (`git.path`, PATH, and on macOS Homebrew's and the Command Line Tools' git) is tried with `git --version` and the first that works is used. A Mac whose `/usr/bin/git` refuses until Xcode's license is accepted, while the terminal's git works, now measures. `DEVELOPER_DIR` reaches the engine too.

## 0.5.0 - 2026-10-21

- Insight first: the tree leads with **All sessions** and its last seven days (`7 d: here $14 · all $80 · 2 h ago`), before and after a read, then Repo health, Always-on context and Copilot. Sessions sits second and open while a session ran in the last 30 minutes, last and closed otherwise; a fold you set yourself is kept.
- The panel opens on All sessions, or on the Session view while one is live, instead of always on Session; while the panel stays open it keeps the view you left it on. All sessions says how old its reading is (`Read 2 h ago`) beside Re-read every log now, and drops the conversation-count line the footer already had.
- No scan at startup for the headline: each finished log read leaves a small summary in VS Code's storage, shown after a reload with its age; one more than seven days old is not shown. A changed `claudeConfigDir` drops it.
- The status bar shows a session only while one is live; otherwise the last seven days' cost, this repo's when the logs have a priced figure for it (`7 d here $14`), else everything (`7 d all $80`), with the reading's age once it is over a day old.
- A line above the first row of `CLAUDE.md`, `AGENTS.md`, `copilot-instructions.md`, `*.instructions.md`, `.claude/rules` and skill `SKILL.md` files says what the file costs on every request (its Always-on row's reading, in tokens); a click opens Always-on, saving the file updates it.
- Repo health on a Mac whose git is blocked by Xcode's unaccepted license says so in plain words with the fixes (`sudo xcodebuild -license accept`, switching to the Command Line Tools, or `git.path` to another git), and no longer offers Forget, which could not help. The tree's row reads `git blocked: Xcode license`.

## 0.4.1 - 2026-10-21

- The Copilot row shows your plan and this month's premium requests counted from this machine's Copilot Chat logs, with no GitHub sign-in and no network. A click still reads GitHub's own figure, which knows the limit.
- Repo health no longer calls a real repository "not a git repository" when git refuses to read it (dubious ownership / `safe.directory`, a broken Xcode command-line-tools shim, an unknown repository extension). It quotes git's own message, which carries the fix.

## 0.4.0 - 2026-10-20

- Copilot quota in the tree: premium requests and chat usage, read with VS Code's own GitHub sign-in. It is the extension's one network call, so it stays off until you click the row (kept per machine), re-reads every 10 minutes while on, and a right-click turns it off.
- Always-on weighs Copilot's instruction files too (AGENTS.md, `.github/copilot-instructions.md`, `.github/instructions`, skills under `.github` and `.agents`) and names who reads each file and when. Copilot counts only in a folder with a Copilot file of its own; VS Code's instruction settings drop it from a row when turned off.
- Claude's always-on weight now also counts CLAUDE.md `@imports` and unscoped `.claude/rules`.
- Always-on names instruction files one agent carries twice (AGENTS.md copied into CLAUDE.md, or imported and repeated), with the repeated characters and how one copy can serve both agents.
- Repo health states a failed read once instead of quoting the engine's error again on the run's line.
- A folder with no CLAUDE.md or skills says it carries nothing always-on, instead of drawing ~0 tokens over an empty bar.
- Repo health on a folder that is not a git repository says so once, in the view and on the tree's row, instead of quoting the engine's exit twice and offering Forget.
- The listing shows the Repo health view too: a third screenshot, over a fictional repo's generated git history.
- The extension icon has transparent corners instead of a white frame on a dark panel.

## 0.3.0 - 2026-10-19

- A fresh install from the desktop app's install build loads itself: every open window restarts its extensions once, a few seconds after the install (the build's `restart` option, on by default). No more hand reload.
- Repo health is laid out as the phone's: one status line with its details behind a `?`, a sticky jump bar with the refresh button, one weeks | commits x-axis choice for every chart (kept across reloads), and a card per section — score, longest file, the tiles as a two-column grid that opens one tile at a time, always-on weight, size, the table, the repo's own readings.
- Repo health leads with the health score, as the phone does: an absolute 0–100 per week held down by its worst reading, the alert that names it, its line, and the picked week's contributions. Derived from the series the view already read, by the same code the desktop app serves it with — including the per-commit series and the older-engine reason. The tree's Repo health row shows it. Not drawn for a scope.
- Beside the score, a dotted context-per-request line per week, folded off the All sessions log scan once it has run (nothing is scanned for it).
- The tree's Sessions section stays collapsed once you collapse it (a live log write used to re-open it), across reloads too.
- The tree no longer lists Optimisation prompts; the prompts stay beside the views they quote.

## 0.2.0 - 2026-10-16

- Repo health follows the engine's 2026-10-16a definition: escape hatches count only unexplained ones, re-touch counts only rework. A series measured under the old definition is still drawn; a measure refuses to mix the two, and the view offers to forget the extension's copy and re-cut it.
- Two groups, each with its own heading: waterplane's readings, and the repo's own readings declared in `.waterplane-shared/health.json`.
- A reading the repo disabled or replaced says so on its tile, with the repo's reason; entries the file got wrong are listed.
- The extension does not run the commands that file names (it starts only `git`): those readings show as absent with the reason, said once at the top. The desktop app runs them.
- The "why is this metric rising" prompt states what the reading counts, in the same words the phone uses, and any change the repo made to it.

## 0.1.0 - 2026-10-12

First release.

- Status bar: the current session's cost and context percentage; hidden when the folder has no session.
- Panel: per-prompt cost, context window over time with compactions and cold rebuilds, the token and dollar split, all-sessions overview.
- Always-on weight: what `CLAUDE.md` and skill descriptions cost on every turn.
- Six optimisation prompts, copied or typed (not sent) into the active terminal.
- Health tab: repo health over the folder's git history, read by the bundled engine, measured only on a tap; the series lives in VS Code's global storage.
- Subagent lanes under the context chart; subagent cost counted in the session total.
- Activity-bar tree as the one navigation: the recent sessions (cost, context, age, live marker) and the four other views with a one-line headline each. A click opens that view in the panel, an editor tab with no tab bar of its own.
- No telemetry, no network. Dollars are API list prices, not a bill.
