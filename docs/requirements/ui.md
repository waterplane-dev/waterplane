# ui

### R-ui-001 · requested
Repo section font is sized appropriately for professional appearance.

### R-ui-002 · requested
Icons are easily tappable and mobile/tactile-friendly for touch interaction; the burger/menu button in particular is displayed larger for easier tapping.

### R-ui-003 · requested
Garmin simulator provides a visual user interface for testing.

### R-ui-004 · requested
Files icon is always visible, even without new files.

### R-ui-005 · shipped
Hammer/build tool is available in the session toolbar, integrated with the command icon buttons, and visible in its expected/marked location.
- shipped: 664187d

### R-ui-006 · shipped
Chips layout displays with proper wrapping instead of splitting across lines.
- shipped: 664187d

### R-ui-007 · requested
Recently added UI elements display correctly and look good on mobile.

### R-ui-008 · requested
Buttons clearly show what they do through better design or optional help dialogs.

### R-ui-009 · requested
Three related commands are combined or visually grouped, and redundant send-toggle options are merged into one.

### R-ui-010 · requested
Feature is available at this location.

### R-ui-011 · shipped
Tool call details are hidden by default and shown on-demand when the user clicks a placeholder.
- shipped: 7aaee35

### R-ui-012 · requested
Screens support scrolling functionality, including scrolling up by swiping with fingers.

### R-ui-013 · requested
User can send clipboard content or type text to send as an alternative.

### R-ui-014 · shipped
Item count/unread badge shows only new items from the outbox, not the inbox, and updates correctly when items are marked as read.
- shipped: 8fbe9f1

### R-ui-015 · requested
Items are automatically checked and retired.

### R-ui-016 · requested
Send button responds quickly in offline mode, and a busy indicator does not block the user from queuing additional prompts while offline.

### R-ui-017 · shipped
Marked/tagged UI controls (indicator, access button, build button) are consolidated behind, and removed/moved into, a menu button rather than shown as separate standalone elements; when nothing needs attention they sit in the expanded menu, but a control moves back to its original location when it needs the user's attention.
- asked: 2026-09-19
- shipped: 8fbe9f1

### R-ui-018 · requested
Buttons across the app respond reliably to taps and perform their intended action (e.g. delete, retry) without failing silently or showing visual glitches like flashing.

### R-ui-019 · requested
All repo functionality is integrated into the live view with per-repo entries, rather than separate screens.

### R-ui-020 · shipped
Gallery opened from the unread badge shows only matching files with correct filters applied.
- shipped: c74402f

### R-ui-021 · shipped
Read mode shows detailed insight into what is happening, including activity and status information, and progress indication for running sub-agents.
- asked: 2026-09-11
- shipped: c74402f

### R-ui-022 · requested
Repo filter list includes a filter for started repos.

### R-ui-023 · shipped
Clicking an item filters the results, with a clear-filter button to undo it.
- shipped: 00d1dc0

### R-ui-024 · requested
Terminal output displays without unwanted line breaks.

### R-ui-025 · shipped
Light and dark theme options are selectable as a user setting.
- shipped: 6cb1c80

### R-ui-026 · requested
Icon sizes are consistent throughout the interface, and button heights are fixed to a consistent size throughout.
- asked: 2026-09-20

### R-ui-027 · requested
Items or indicators marked as '2' are more clearly distinguished visually.

### R-ui-028 · requested
UI elements are removed from their current location and made visible by default in a flexible section the user controls.

### R-ui-029 · requested
Icon set is identical between CLI and read modes, except for the CLI/read toggle button itself.

### R-ui-030 · shipped
During typing mode, everything above the input box is hidden except the last output, with an outline button to reveal more context; the save button and new incoming information are not shown while typing.
- shipped: 7adeb6c

### R-ui-031 · shipped
A snooze button is available.
- shipped: c74402f

### R-ui-032 · shipped
List of queued/backlog entries displays age and prompt text, with status and age filters, and groups identical entries together.
- shipped: b57031c

### R-ui-033 · shipped
Filter dialogs show the item count and display exactly those items when opened.
- asked: 2026-09-11
- shipped: c74402f

### R-ui-034 · shipped
Font and icon sizes are customizable via a setting, in addition to being sized appropriately by default.
- asked: 2026-09-11
- shipped: c74402f

### R-ui-035 · requested
Gray boxes are removed from icon UI for visual consistency and space savings.
- asked: 2026-09-11

### R-ui-036 · requested
Dialogs have close and minimize buttons, are shown at a significantly smaller/reduced size (e.g. decision dialogues at most half their current size), and do not block screen interaction while in CLI mode.
- asked: 2026-09-13, 2026-09-20, 2026-09-20

### R-ui-037 · requested
Unnecessary spacing gaps are removed from the UI.
- asked: 2026-09-13

### R-ui-038 · requested
CLI read-mode toggle button appears once in the menu and is not duplicated elsewhere.
- asked: 2026-09-13

### R-ui-039 · requested
Button states update reliably without requiring a view switch to refresh.
- asked: 2026-09-18

### R-ui-040 · shipped
UI clearly indicates why an element is grayed out.
- asked: 2026-09-18
- shipped: 6d20ed8

### R-ui-041 · requested
Session view reuses the same component the main view uses.
- asked: 2026-09-18

### R-ui-042 · shipped
Tapping a marked element opens a detailed view with full information, including a large visualization with tooltips, subagent counts, modifications, and token usage over time.
- asked: 2026-09-18
- shipped: 6d20ed8

### R-ui-043 · shipped
Buttons in the assessment UI no longer overlap, and a button navigates to the groomed backlog with assessment results visible.
- asked: 2026-09-18
- shipped: fe18ee6

### R-ui-044 · shipped
User interface is simplified and unified across the app for clarity (e.g. one vocabulary for send target/timing).
- asked: 2026-09-17
- shipped: f7caebb

### R-ui-045 · shipped
Context/usage charts are positioned at the top of their screen, above supporting text.
- asked: 2026-09-19
- shipped: de77902

### R-ui-046 · shipped
Console redraw does not interfere with dialogue display or option visibility; question cards stay stable instead of redrawing on every repaint.
- asked: 2026-09-20
- shipped: 4b18afc

### R-ui-047 · requested
Dialogue options remain visible and do not scroll away when the console scrolls.
- asked: 2026-09-20

### R-ui-048 · requested
Dialogue list includes a visible clear button that actually clears the list when pressed.
- asked: 2026-09-20, 2026-09-20

### R-ui-049 · shipped
Full-screen mode can be exited without opening the menu, and only affects the display inside a session, not the main view.
- asked: 2026-09-20
- shipped: 7adeb6c

### R-ui-050 · shipped
Status bars for menu and user settings always remain visible in the main view.
- asked: 2026-09-20
- shipped: 7adeb6c

### R-ui-051 · requested
Main view displays summary keywords for each repo.
- asked: 2026-09-21

### R-ui-052 · shipped
Default branch name (e.g. main) is hidden throughout to save space, shown only for non-default branches.
- asked: 2026-09-21
- shipped: 9d32436

### R-ui-053 · shipped
Dialogs do not show an error when reopened with a previously selected option that is now valid again.
- asked: 2026-09-22
- shipped: 9c18e5b

### R-ui-054 · requested
Version numbers are visible and consistent across all screens for cross-checking.
- asked: 2026-09-24

### R-ui-055 · requested
Repository name is visible on all screens.
- asked: 2026-09-24

### R-ui-056 · requested
Clicking read mode exits full screen without re-entering CLI mode.
- asked: 2026-09-24

### R-ui-057 · requested
Current view mode is reliably detected and reflected in the UI.
- asked: 2026-09-24

### R-ui-058 · requested
Buttons always fit on one line without wrapping or overflow.
- asked: 2026-09-24

### R-ui-059 · shipped
Charts on the metrics page sit close together, with text below or as on-demand helper text.
- asked: 2026-09-26
- shipped: 1a37973

### R-ui-060 · requested
An 'all' button is present and scrolling shows all content without cutting it off.
- asked: 2026-09-30

### R-ui-061 · shipped
The product name is written as lowercase "waterplane" in documentation, UI and branding.
- asked: 2026-10-01
- shipped: 1040576, 0b06e8b

### R-ui-062 · shipped
Adding a short decision comment inline is quick: an answer list keys each picked item with a decision and a note.
- asked: 2026-10-01
- shipped: e98a940

### R-ui-063 · shipped
Every selection and annotation dialog can be cancelled at any time, by a cancel row, a tap elsewhere or Back.
- asked: 2026-10-01
- shipped: 9b96a3e

### R-ui-064 · shipped
On a session card, title and prompts sit on top and the chip and button strip is fixed at the bottom.
- shipped: 7cab2e7

### R-ui-065 · shipped
A button lets the user change the settings a readout reports, opening Settings at that row.
- shipped: 555175d

### R-ui-066 · requested
Layout has no empty space, with chips repositioned to the top right.

### R-ui-067 · shipped
The 5-hour session reset time appears next to the session value, not the weekly value.
- asked: 2026-10-03
- shipped: c3e1e53

### R-ui-068 · shipped
Open and Done labels sit adjacent to each other in the session strip.
- asked: 2026-10-03
- shipped: 469214e

### R-ui-069 · requested
A compact icon in the upper right corner replaces a large space-consuming element.
- asked: 2026-10-03

### R-ui-070 · requested
All text in the interface uses one uniform, smaller font size.
- asked: 2026-10-03

### R-ui-071 · requested
Subagents view is visible in the default view.
- asked: 2026-10-03

### R-ui-072 · requested
All text is visible in the main view, none missing.
- asked: 2026-10-04


### R-ui-073 · requested
On a window at least 1024px wide the app is a two-pane workspace — repos and sessions in a left sidebar, the live session with its composer on the right, sheets opening as side panels — and the phone layout is unchanged.
- asked: 2026-10-07 — plan: docs/analysis/desktop-workspace-plan.md
