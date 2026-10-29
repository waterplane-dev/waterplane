# navigation

### R-navigation-001 · shipped
Screen/downloads are accessible whether or not a download is currently active.
- shipped: 6d20ed8

### R-navigation-002 · shipped
Swipe-back navigates to the previous screen instead of closing the app.
- shipped: fa25be5

### R-navigation-003 · requested
Submit selection navigates directly to submit rather than toggling the selection.

### R-navigation-004 · shipped
A menu icon appears next to the outline icon; the outline button toggles only the outline, not the whole menu.
- shipped: 6cb1c80

### R-navigation-005 · shipped
After restart or an APK update, app restores the user to the exact location they were in before, or to the leftmost open tabs view when nothing was open.
- asked: 2026-09-12, 2026-10-01
- shipped: b2d01bc

### R-navigation-006 · shipped
Back navigation returns to the previous screen, not the main view — the session header's back arrow included (a session started from a launcher sheet returns to that sheet), and a sheet returned to shows the cut it had (the backlog's "the 10 waiting").
- asked: 2026-09-28, 2026-10-28
- shipped: 3d62f7f, 46310e4a

### R-navigation-007 · shipped
A links sheet lists every app running on the host and every deployed frontend, with pins, a search box, filter chips and grouping by repo, environment or place; it is a plugin, opened from the menu.
- asked: 2026-10-10, 2026-10-11, 2026-10-11
- shipped: 5b2f2767, 51b17fae, 461e8522

### R-navigation-008 · shipped
A repo card shows a found chip with its discovered link count; tapping it opens the links sheet filtered to that repo.
- asked: 2026-10-11
- shipped: c1af892a

### R-navigation-009 · shipped
The repo list is sorted alphabetically by default.
- asked: 2026-10-13
- shipped: 21bdcd3

### R-navigation-010 · shipped
Tapping the clock marker opens the matching provider's section, so the Copilot clock opens Copilot rather than Claude.
- asked: 2026-10-15
- shipped: 1e04d23d

### R-navigation-011 · shipped
The ☰ menu button shows a badge summing every counted line inside it, and a counted extension item such as the vault's asks lifts out beside the bell while work waits.
- asked: 2026-10-16
- shipped: ea3bcb34, 9f15a7e6

### R-navigation-012 · shipped
In the VS Code tree the Sessions section stays collapsed after the user collapses it, and there is no prompts row.
- asked: 2026-10-16
- shipped: 70886617
- reworked 2026-10-21 (owner): until the user folds it, Sessions is open while a session is live and closed otherwise (R-navigation-013); a fold against that default is kept, one matching it hands the choice back.

### R-navigation-013 · shipped
The VS Code tree leads with insight: All sessions first, then the folder switcher (several folders), then Repo health, Always-on context and Copilot. Sessions sits second and expanded while a session is running or was written to in the last 30 minutes, and last and collapsed when none is; a fold the user sets against that default is remembered. The panel opens on the Session view while a session is live (the same test as Sessions' placement) and on All sessions otherwise, decided once the folder's sessions are read; while the panel stays open (hidden included) it keeps the view it was last left on. All sessions says once how old its reading is, beside the re-read link, and does not repeat the conversation count its footer carries.
- asked: 2026-10-21 (owner)
- shipped: f6fb1a70, e5c20ae7, f41b5db5
### R-navigation-014 · shipped
One central What's new page links to every new thing, each with its state, instead of scattered entry points.
- asked: 2026-10-25
- shipped: 9d5c718f, 17de3b66

### R-navigation-015 · shipped
A hidden menu entry shows an activity marker when something inside it needs attention.
- asked: 2026-10-26
- shipped: 4e07a381


### R-navigation-016 · shipped
The session context view, the repo readings (set-up) sheet and the all-sessions view each link to the other two for what every turn carries; following a link from all-sessions closes it first.
- asked: 2026-10-26
- shipped: 3e2685b7, b1e06e5d, 5addc8e8, bcc7de90, eafed83a
