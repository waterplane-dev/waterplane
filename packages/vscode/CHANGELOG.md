# Changelog

## 0.3.1 - 2026-10-20

- A folder with no CLAUDE.md or skills says it carries nothing always-on, instead of drawing ~0 tokens over an empty bar.
- Repo health on a folder that is not a git repository says so once, in the view and on the tree's row, instead of quoting the engine's exit twice and offering Forget.
- The listing shows the Repo health view too: a third screenshot, over a fictional repo's generated git history.

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
