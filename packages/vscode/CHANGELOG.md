# Changelog

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
