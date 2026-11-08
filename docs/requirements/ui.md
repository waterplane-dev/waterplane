# ui

### R-ui-001 · requested
Repo section font is sized appropriately for professional appearance.

### R-ui-002 · shipped
Header icons are at least a fingertip wide (40px) on a phone, and the menu button that stays on screen while typing is full fingertip size, not a thin chip.
- shipped: 6cb1c809

### R-ui-003 · requested
Garmin simulator provides a visual user interface for testing.

### R-ui-004 · shipped
Files icon is always visible, even without new files.
- shipped: 664187d4

### R-ui-005 · shipped
Hammer/build tool is available in the session toolbar, integrated with the command icon buttons, and visible in its expected/marked location.
- shipped: 664187d

### R-ui-006 · shipped
Chips layout displays with proper wrapping instead of splitting across lines.
- shipped: 664187d

### R-ui-007 · requested
Every screen and sheet fits and is usable on a phone-width display, with no clipped or overflowing controls.

### R-ui-008 · shipped
A button's purpose can be learned on a phone: tapping a ? chip or explain mode shows a hint card per control, and the person can permanently dismiss the chip.
- shipped: f479df98

### R-ui-009 · requested
On a queued message the retry, discard and more buttons read as one group; and the compose bar's separate queue-another icon is merged into the Send button's options menu instead of sitting beside it.

### R-ui-010 · shipped
A fan-out sweep can be put on a clock from inside the Fan-out sheet, with a later button beside Run in N repos.
- shipped: f479df98

### R-ui-011 · shipped
Tool call details are hidden by default and shown on-demand when the user clicks a placeholder.
- shipped: 7aaee35

### R-ui-012 · shipped
The terminal scrolls back with a finger swipe on a phone, and editor and sheet bodies scroll when taller than the screen.
- shipped: 6cb1c809

### R-ui-013 · shipped
The to-host-clip sheet takes text from the compose draft, the phone's clipboard or typed on the spot, all in one editable box.
- shipped: 241769c6

### R-ui-014 · shipped
Item count/unread badge shows only new items from the outbox, not the inbox, and updates correctly when items are marked as read.
- shipped: 8fbe9f1

### R-ui-015 · shipped
A prompt whose delivery could not be confirmed when sent is checked again later, and its row is retired automatically once the conversation shows it ran.
- shipped: 6b101ad1

### R-ui-016 · requested
Send button responds quickly in offline mode, and a busy indicator does not block the user from queuing additional prompts while offline.

### R-ui-017 · shipped
Marked/tagged UI controls (indicator, access button, build button) are consolidated behind, and removed/moved into, a menu button rather than shown as separate standalone elements; when nothing needs attention they sit in the expanded menu, but a control moves back to its original location when it needs the user's attention.
- asked: 2026-09-19
- shipped: 8fbe9f1

### R-ui-018 · requested
A button that cannot act is not drawn as a dimmed look-alike but says why in words, and a retry or delete tap visibly does its action without flashing or failing silently.
- note: Greyed-button part: d30355b6.

### R-ui-019 · requested
All repo functionality is integrated into the live view with per-repo entries, rather than separate screens.

### R-ui-020 · shipped
Gallery opened from the unread badge shows only matching files with correct filters applied.
- shipped: c74402f

### R-ui-021 · shipped
Read mode shows detailed insight into what is happening, including activity and status information, and progress indication for running sub-agents.
- asked: 2026-09-11
- shipped: c74402f

### R-ui-022 · shipped
The live list's status chips include a starred filter that shows only starred sessions.
- shipped: 718cc630

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

### R-ui-036 · shipped
In the terminal view a choice question is answered on the CLI itself and no card covers the screen; the send-mode strip is compact and carries its own close button.
- asked: 2026-09-13, 2026-09-20, 2026-09-20
- shipped: bab3986c, f55b57cd
- note: The old answer bar with minimize and hide handles was removed rather than shrunk.

### R-ui-037 · requested
Unnecessary spacing gaps are removed from the UI.
- asked: 2026-09-13

### R-ui-038 · shipped
The CLI/reader switch is one button in the terminal's corner group on both surfaces, and is not repeated in the header or the menu.
- asked: 2026-09-13
- shipped: 8fbe9f1f

### R-ui-039 · shipped
Button states update reliably without requiring a view switch to refresh.
- asked: 2026-09-18
- shipped: 7adeb6c9, 3ca7a224

### R-ui-040 · shipped
UI clearly indicates why an element is grayed out.
- asked: 2026-09-18
- shipped: 6d20ed8

### R-ui-041 · shipped
The session screen's header draws the same spend miniature curve as the main view's session row.
- asked: 2026-09-18
- shipped: 4ea4a5ba, 89051a36

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

### R-ui-047 · shipped
Dialogue options remain visible and do not scroll away when the console scrolls.
- asked: 2026-09-20
- shipped: 4b18afc7

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

### R-ui-051 · shipped
Each session row in the main view shows the conversation's short keyword name.
- asked: 2026-09-21
- shipped: 9d32436d

### R-ui-052 · shipped
Default branch name (e.g. main) is hidden throughout to save space, shown only for non-default branches.
- asked: 2026-09-21
- shipped: 9d32436

### R-ui-053 · shipped
Dialogs do not show an error when reopened with a previously selected option that is now valid again.
- asked: 2026-09-22
- shipped: 9c18e5b

### R-ui-054 · shipped
An app build's version prints the same way on the Downloads list, the Apps list and the install log; the install log shows the file name and every app row names its repo.
- asked: 2026-09-24
- shipped: e38c44a6

### R-ui-055 · superseded
Repository name is visible on all screens.
- asked: 2026-09-24
- superseded-by: R-ui-054

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

### R-ui-066 · shipped
On a session card the status chip sits on the title line at the top right beside the age, with the new marker folded into it, leaving no empty space.
- shipped: b50d69ef

### R-ui-067 · shipped
The 5-hour session reset time appears next to the session value, not the weekly value.
- asked: 2026-10-03
- shipped: c3e1e53

### R-ui-068 · shipped
Open and Done labels sit adjacent to each other in the session strip.
- asked: 2026-10-03
- shipped: 469214e

### R-ui-069 · shipped
The per-prompt cost card's why-dollars explanation is a small ? icon in its top-right corner instead of a row that takes space.
- asked: 2026-10-03
- shipped: f28eea72

### R-ui-070 · shipped
Every item in the session status strip uses one smaller text size.
- asked: 2026-10-03
- shipped: d13c256b

### R-ui-071 · shipped
The context sheet's default chart stacks by token kind and still shows the subagent lanes.
- asked: 2026-10-03
- shipped: e821180b

### R-ui-072 · shipped
A reopened conversation's session card keeps its first and latest prompt text instead of showing blank.
- asked: 2026-10-04
- shipped: fe835fd2


### R-ui-073 · shipped
On a window at least 1024px wide the app is a two-pane workspace — repos and sessions in a left sidebar, the live session with its composer on the right, sheets opening as side panels — and the phone layout is unchanged; the web app looks good in a desktop browser as well as on mobile.
- asked: 2026-10-07 — plan: docs/analysis/desktop-workspace-plan.md, 2026-10-07
- shipped: fd8cc502, 41a0931a, 57a3510b, 75352f87, f7f79edd

### R-ui-074 · shipped
On a desktop window the keyboard drives the CLI: a key typed while no field has focus reaches the terminal (which then keeps the keyboard), and the terminal says when it has it — not only the on-screen key buttons.
- asked: 2026-10-08 — plan: docs/analysis/desktop-workspace-plan.md §5
- shipped: dda5ea28
- note: The cited plan section does not describe this; the behaviour is in strayKeys.

### R-ui-075 · shipped
A side panel on a desktop window can always be closed with a visible control: its head sits below the top strips and never scrolls away.
- asked: 2026-10-08 — plan: docs/analysis/desktop-workspace-plan.md §3
- shipped: dda5ea2
### R-ui-076 · requested
The UI never greys out a button; when an action is unavailable it explains why in text. Confirmations never use the browser's window.confirm, and icons are lucide-react icons only, with no emoji.
- asked: 2026-10-04, 2026-10-06, 2026-10-25, 2026-10-25, 2026-10-30

### R-ui-077 · shipped
The All chip and the worktree chip have the same size and style.
- asked: 2026-10-05
- shipped: 2f56055d

### R-ui-078 · requested
On iOS, web controls for features the native shell lacks are hidden or explained in a sentence, never shown as dead buttons.
- asked: 2026-10-06

### R-ui-079 · requested
The model wheel offers alternative views (such as cells coloured by cost) that the user can switch between, with the plain wheel as the default.
- asked: 2026-10-07
- note: Owner may discard it later.

### R-ui-080 · shipped
The app has an icon that works well in light mode, and the icon is the same size as the button it sits in, never larger.
- asked: 2026-10-07
- shipped: af03b451, 4d73eecc, eaeff300

### R-ui-081 · shipped
The full-screen toggle works whenever a session is on screen.
- asked: 2026-10-07
- shipped: e62ded58

### R-ui-082 · shipped
The ? help button, on the main screen and in the session header alike, shows its message first and then asks once whether to remove the button to save space; removing it hides it in all views, and Settings brings it back.
- asked: 2026-10-07
- shipped: edc40bd5

### R-ui-083 · shipped
Chrome that changes itself (a label retiring, a button removed) says so when it happens and names the way back, consistently for the + and the ? buttons.
- asked: 2026-10-08
- shipped: df830262, edc40bd5

### R-ui-084 · shipped
After dragging the terminal's corner group, its drag handle is not shown in blue.
- asked: 2026-10-08
- shipped: 9a9b415f


### R-ui-085 · shipped
On a desktop browser a picture or file pasted with Cmd/Ctrl+V into the session's prompt box (or with no field focused) attaches to the session the way the paperclip does — a picture opens the annotator.
- asked: 2026-10-10

### R-ui-086 · shipped
On a desktop browser files dragged from the file system onto the prompt box upload to the repo's inbox the way the paperclip does; a drop beside the box never navigates the tab away.
- asked: 2026-10-10

### R-ui-087 · shipped
On a desktop window with room, the annotator for the session on screen opens as a column to the right of the session, so the prompt can be typed while the picture is marked; with too little room it takes the main pane as before.
- asked: 2026-10-10

### R-ui-088 · shipped
On a phone the session's prompt can be shown, and edited, above the picture while it is being marked.
- asked: 2026-10-10

### R-ui-089 · shipped
The session tab strip is on by default and is drawn on a desktop window too, beneath the top status strips.
- asked: 2026-10-10

### R-ui-090 · shipped
On a desktop Cmd/Ctrl+Return in the prompt box sends it, whatever Enter is set to do.
- asked: 2026-10-10

### R-ui-091 · shipped
The annotator column beside the session on a desktop window can be resized by dragging its left edge, and has a full-screen toggle (Esc steps back); switching never loses the marks.
- asked: 2026-10-10

### R-ui-092 · shipped
A picture pasted or dropped while another is being marked asks each time whether to append it; yes adds it to the batch after the current one, no leaves everything as it was.
- asked: 2026-10-10

### R-ui-093 · shipped
The sessions list has separate expand-all and collapse-all buttons for the repo groups.
- asked: 2026-10-10

### R-ui-094 · shipped
The sessions list has an always-visible quick filter that narrows the rows to those whose shown text (title, prompts, repo, branch) contains every typed word, saying "n of N"; the full transcript search sits at the end of the same line.
- asked: 2026-10-10

### R-ui-095 · shipped
With a picture open on the annotator beside the session, Send in the session's prompt box asks whether the picture goes too; yes sends it with the message (its marks included), no sends the words alone and leaves the picture open.
- asked: 2026-10-10
### R-ui-096 · shipped
Floating controls over the terminal have a clearly visible edge in dark mode.
- asked: 2026-10-09
- shipped: df14356a

### R-ui-097 · shipped
The fan-out sheet picks its launch with the same backend, model and effort controls as the main start-with sheet.
- asked: 2026-10-09
- shipped: cce74b6b

### R-ui-098 · shipped
Strips above the prompt bar can be folded away through one reusable component, take no visible space when folded, and come back from a chip in the status line.
- asked: 2026-10-09
- shipped: b8221c01

### R-ui-099 · shipped
Any horizontally scrollable strip that hides content shows a clearly visible chevron and fade at the edge with more past it, and nothing when everything fits.
- asked: 2026-10-10
- shipped: afe65dd2, 0dbdd2d2

### R-ui-100 · shipped
Expanding or collapsing a repo group scrolls the list so its header and revealed content are visible; expanding any list item scrolls to the end of the expanded items. This is on by default and a user setting turns it off.
- asked: 2026-10-11, 2026-10-13
- shipped: 9e2321e3

### R-ui-101 · shipped
The context sheet has a /compact button at the end of the Context window title row.
- asked: 2026-10-11
- shipped: 9b085576, 463c8abe

### R-ui-102 · shipped
Screens such as the inbox, outbox, backlog and activity look plainly designed: fewer fat chips, each fact said once, no generated-looking decoration.
- asked: 2026-10-12
- shipped: cbe100c3, 938faf36, 2994113e, 53b4df7f, 0dd2d2e2

### R-ui-103 · shipped
The VS Code extension has a sidebar view and shows subagent lanes.
- asked: 2026-10-11
- shipped: c4b2f739

### R-ui-104 · requested
Filtered gallery views look the same as the unfiltered view, with the same styling and layout.
- asked: 2026-10-12

### R-ui-105 · requested
No two buttons share the same name, so the UI is easy to follow.
- asked: 2026-10-12

### R-ui-106 · requested
waterplane.dev is a real final landing page (hook, journey gif, short description, three or four features each with a real still or gif, install snippet, demo link, source link, no 'coming soon'). It makes no third-party requests, works at 360px width in light and dark mode, and avoids generic AI-looking design (no gradient hero, glassmorphism, emoji, icon-in-circle grids, identical card rows or buzzword copy).
- asked: 2026-10-13, 2026-10-15

### R-ui-107 · shipped
Choices among text options are radio rows with a round dot and a full wrapping label; a solid accent fill appears only on the single 'tap here next' button on a screen, and selected-option states never use the accent background. Icon-only toggles, chip sets and single on/off switches keep their look.
- asked: 2026-10-15
- shipped: a2a657b4, 8489dc15, c38b1ba3

### R-ui-108 · shipped
Multi-selection controls are rendered as checkboxes, not circles.
- asked: 2026-10-17
- shipped: 40d54917

### R-ui-109 · requested
The VS Code extension UI looks the same as the web UI, with matching styling.
- asked: 2026-10-17

### R-ui-110 · shipped
App styling is built on reusable shared variables (a token scale) and split into ordered slices, so styles stay maintainable.
- asked: 2026-10-18
- shipped: cd8ae25f, 669f639c

### R-ui-111 · shipped
The cute elements have a cancel button.
- asked: 2026-10-19
- shipped: e2b6da2f

### R-ui-112 · shipped
Folding the CLI output stays folded: it does not reopen itself in a loop.
- asked: 2026-10-19
- shipped: 56451ee6

### R-ui-113 · shipped
Radio-button option groups show visible headings and full labels, with no text missing.
- asked: 2026-10-19
- shipped: 54ed1399

### R-ui-114 · shipped
A banner that reports a stopped download can be removed from the strip itself and stays gone.
- asked: 2026-10-20
- shipped: ce716886

### R-ui-115 · requested
Dialogs offer a "don't show again" tickbox.
- asked: 2026-10-20

### R-ui-116 · requested
A button on the phone clears the element marked at the top of the screen.
- asked: 2026-10-20

### R-ui-117 · shipped
The VS Code extension logo looks clean and recognisable at small sizes, with transparent corners in the editor and Marketplace.
- asked: 2026-10-20
- shipped: 0b83f4d2

### R-ui-118 · shipped
Buttons, rows, hints and tags across the web app and extensions use shared kit components, render the same DOM and pixels as before in dark and light mode, and the count of raw hand-written ones only goes down.
- asked: 2026-10-21
- shipped: 35bc0e92, 35ecd0c9, 246db90a, 5173b09f, 88386404, e4e1648c, 4a03bb50

### R-ui-119 · shipped
The development build of the Android app is visibly labelled with a DEV ribbon on its launcher icon.
- asked: 2026-10-21
- shipped: e0dc2f49

### R-ui-120 · shipped
Marker 2 in the marked screenshot is clearly visible.
- asked: 2026-10-22
- shipped: 761be680

### R-ui-121 · shipped
The two buttons are never shown on screen at the same time, so the screen is not confusing.
- asked: 2026-10-22
- shipped: 13640e8d

### R-ui-122 · shipped
A plugin panel pinned to the header, such as GitHub Copilot, shows as one icon that opens its menu, not as a whole panel inside the icon strip.
- asked: 2026-10-23, 2026-10-23
- shipped: 080e4276

### R-ui-123 · requested
Every user-visible reference to the old name "USMC" is replaced with "waterplane".
- asked: 2026-10-24

### R-ui-124 · shipped
Text in a marked strip shows on one line and is cut with an ellipsis when it does not fit.
- asked: 2026-10-24
- shipped: 34e7cef4, 724f6908

### R-ui-125 · shipped
Filters, search, bulk buttons and a marked element sit at the top of a list, above its rows, never at the end.
- asked: 2026-10-25, 2026-10-25
- shipped: 9896a16e, 723c6cad

### R-ui-126 · shipped
When the user selects an item in a dialogue, the dialogue states clearly what that selection will do.
- asked: 2026-10-26
- shipped: 9dbda67f

### R-ui-127 · shipped
Text on every row, including repo-tinted tab rows, is readable against its background in light and dark.
- asked: 2026-10-26
- shipped: 41fe5bfc

### R-ui-128 · shipped
Repo lists show whether they have been read yet: 'not read yet' and 'no repos found' are different states, and a host with zero repos does not leave the launcher waiting forever.
- asked: 2026-10-30
- shipped: ced613d9, 2b1aba68

### R-ui-129 · superseded
When a feature does not apply, it is collapsed away with an explanation rather than hidden.
- asked: 2026-10-31
- superseded-by: R-usage-029

### R-ui-130 · shipped
The "All backends" and "Open code" buttons in the VS Code extension open their pages instead of crashing into an empty page.
- asked: 2026-11-02
- shipped: 5bc643e1

### R-ui-131 · shipped
The context weight screen looks the same wherever it appears, with the three variants consolidated into one.
- asked: 2026-11-02
- shipped: f8521a12, 7b1dd405

### R-ui-132 · shipped
The vault's token-file check is generic: it finds any `credentials.json` holding a refresh token in a hidden folder and names no provider, and the vault has no Garmin-specific secret kind.
- asked: 2026-11-06
- shipped: fb508e2c

