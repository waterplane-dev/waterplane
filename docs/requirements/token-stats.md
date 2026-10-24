# token-stats

### R-token-stats-001 · shipped
The token statistics screen is an in-repo extension (`packages/extensions/token-stats/`) that opens exactly where and how it did before: the same four doors, the same `#o=tokens` deep link and reload restore, the same usage counters, and a render identical to the screen it replaced.
- asked: 2026-09-30 (session: extensions plan agreed that day, id not recorded)
- shipped: a52a57f
### R-token-stats-002 · shipped
Token type shows as a stacked chart in the default view.
- asked: 2026-10-03
- shipped: e821180

### R-token-stats-003 · shipped
The context chart draws the currently set auto-compact window as a line, and says why when none can be drawn.
- asked: 2026-10-11
- shipped: 0153deae

### R-token-stats-004 · shipped
The context window mini graph uses the auto-compact value as its maximum y value.
- asked: 2026-10-12
- shipped: e6e47af

### R-token-stats-005 · requested
The Copilot stats page has the same quality and layout as the Claude stats page, built from shared code; other providers' pages match where it makes sense.
- asked: 2026-10-15

### R-token-stats-006 · requested
The token stats view shows a turns section beside the token charts, with a button to set a limit on the number of turns.
- asked: 2026-10-21

### R-token-stats-007 · shipped
Token stats pages look and behave identically in the web app, APK and VS Code, built from one shared source.
- asked: 2026-10-22
- shipped: 1264a52c, abd94826, d4ff3668


### R-token-stats-008 · shipped
The VS Code panel's All sessions shows token statistics on a machine with GitHub Copilot and no Claude Code: a Copilot Chat tab counts Copilot's own prompt and output tokens per day and model off VS Code's chat logs, with no waterplane desktop needed, and the view opens on it when Claude's logs hold nothing.
- asked: 2026-10-23
