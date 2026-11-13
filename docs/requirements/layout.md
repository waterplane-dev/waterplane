# layout

### R-layout-001 · shipped
The message box grows with what is typed, up to a ceiling, so a long prompt can be read while typing.
- shipped: 664187d4

### R-layout-002 · shipped
The launcher's section-head buttons (waiting, starred, fold, fan-out, schedule, refresh, close) sit in one row, not stacked.
- shipped: 664187d4

### R-layout-003 · requested
A button a person taps always visibly does something: offline, queued or on a build screen it says what happened.
- note: Overlaps R-ui-076 (never grey out a button).

### R-layout-004 · shipped
Layout displays content in fewer lines (two instead of three).
- shipped: 8f710c1, 24008d9

### R-layout-005 · requested
All buttons are positioned at the top of the interface, not the bottom.

### R-layout-006 · shipped
UI boxes are sized consistently across all sections.
- shipped: 8f710c1

### R-layout-007 · shipped
The launcher topbar shows only the app mark, with no app-name text, to save space.
- shipped: 6cb1c809

### R-layout-008 · requested
On a session row the two small charts (context and token total) sit at the lower right with the prompt text wrapping around them.
- asked: 2026-09-18

### R-layout-009 · shipped
Scrollable sections display full content without letterboxing.
- asked: 2026-09-18
- shipped: 4ea4a5b

### R-layout-010 · shipped
Repo header remains fixed at top when scrolling in the main view.
- asked: 2026-09-12
- shipped: b2d01bc

### R-layout-011 · shipped
Upper header section with menu and repo title is space-optimized.
- asked: 2026-09-21
- shipped: b44385a

### R-layout-012 · requested
The mobile layout uses screen space efficiently.
- asked: 2026-10-05

### R-layout-013 · shipped
On a wide desktop window the sidebar's top bar sits on one line and session cards keep their chart on the right, aligned as on mobile.
- asked: 2026-10-10
- shipped: afa77b14, 8507dcb9

### R-layout-014 · requested
The bottom-left area of the screen uses less space so more content fits.
- asked: 2026-10-10

### R-layout-015 · requested
On desktop the sync dialog is tidy and its marked part is accessible; on mobile the sync log stays readable.
- asked: 2026-10-13

### R-layout-016 · requested
Marked text wraps so the x and ... controls stay pinned top-right on desktop and mobile.
- asked: 2026-10-13

### R-layout-017 · shipped
The VS Code extension has a native navigation tree on the left and one main view in the centre, with no second session list; in the wide web layout both side columns (sidebar and side panel) can be resized by dragging.
- asked: 2026-10-14, 2026-10-14
- shipped: a2ea18d8, 86981333

### R-layout-018 · requested
Elements on screen do not overlap each other.
- asked: 2026-10-15

### R-layout-019 · requested
On desktop the conversation uses the available screen space so the main content is comfortable to read.
- asked: 2026-10-19

### R-layout-020 · shipped
The gap at the top of the screen is tight.
- asked: 2026-10-21
- shipped: 6e037f89

### R-layout-021 · shipped
The section above the terminal/reader output is resizable by a drag grip, shrinking from the bottom first.
- asked: 2026-10-21
- shipped: 1d999d11

### R-layout-022 · shipped
The two buttons sit at the top-right of the section above the terminal/reader output.
- asked: 2026-10-21
- shipped: 1d999d11

### R-layout-023 · shipped
Every sheet scrolls when its content exceeds the viewport, so content is never cut off.
- asked: 2026-10-28
- shipped: 9d4eed95

### R-layout-024 · shipped
A failed build reads "failed" inline beside the hammer in the repo header instead of wrapping onto its own line.
- asked: 2026-10-28
- shipped: f7c01c82

### R-layout-025 · shipped
The usage week navigation buttons are neatly placed at the chart's edges and not cramped against it.
- asked: 2026-10-30
- shipped: 1aea1986

### R-layout-026 · shipped
The reader's list of running agents is shortened by a drag grip like the header's; a shortened list scrolls, and a tap shows all of it.
- asked: 2026-11-05

### R-layout-027 · shipped
Once the launcher's closed top section needs a second line, a drag grip under it shortens that section, down to the first line; a tap shows all of it.
- asked: 2026-11-05

### R-layout-028 · shipped
On a phone, the context window & cost screen's head, conversation name and door buttons scroll away with the charts, so the charts get the whole screen; a desktop side panel keeps its head (R-ui-075).
- asked: 2026-11-06
### R-layout-029 · shipped
On the context window & cost screen, the conversation name, the door buttons and the cached-graph line sit on one gutter, with even space above and below the buttons.
- asked: 2026-11-06
- shipped: 34ecfc00

### R-layout-030 · requested
The circled control sits at the very right edge of the screen.
- asked: 2026-11-07

### R-layout-031 · shipped
Text in panels, such as Settings' Plugins door and the plugin list, has comfortable side margins and does not run into its container's edges.
- asked: 2026-11-09
- shipped: ad691235

### R-layout-032 · requested
The UI has comfortable, even margins on both sides and tuned spacing on every screen.
- asked: 2026-11-10, 2026-11-11

