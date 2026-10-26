# input

### R-input-001 · shipped
Send button activates via the return key.
- shipped: 664187d

### R-input-002 · shipped
Text input remains visible when the on-screen keyboard is open, and tapping the message field reliably opens the keyboard for typing without it flashing shut.
- asked: 2026-09-24
- shipped: 5f910d5, 9a49bc3

### R-input-003 · shipped
On mobile the keyboard closes after sending a message; this is a setting, on by default.
- asked: 2026-09-30
- shipped: 91593d3

### R-input-004 · shipped
Long-press on CLI text offers a menu: pick lines, answer list, or select text with the phone's own selection.
- asked: 2026-10-01
- shipped: e98a940

### R-input-005 · shipped
Pinch, pan and double-tap zoom work on pictures in the repo browser, like the gallery.
- asked: 2026-10-03
- shipped: 32a7cf9

### R-input-006 · requested
The hint text does not shrink the selector, which stays large enough to use on a phone.
- asked: 2026-10-05

### R-input-007 · requested
Text inputs do not auto-capitalize the first letter by default on the keyboard.
- asked: 2026-10-06


### R-input-008 · shipped
With a physical keyboard, Ctrl+N / ⌘N / Alt(Option)+N opens a new session: on a session screen in that session's repo, elsewhere it asks which repo in a keyboard-driven picker. Alt+N works in a plain browser tab, where the browser keeps Ctrl+N (Windows/Linux) and ⌘N for itself.
- asked: 2026-10-14 (owner)
- shipped: 3a01b062

### R-input-009 · shipped
On a desktop or with a physical keyboard, holding Ctrl (⌘ on a Mac) or Alt/Option alone for about half a second shows a temporary card listing the keys that make a shortcut with it right now and what each will do (e.g. "N — new session in <repo>", "Return — send"). Letting go, pressing any key, or leaving the window hides it; a quick Ctrl+C never shows it; pressing a listed key still runs the shortcut. Never on a touch-only phone. A chord the browser tab will not pass on says so in words and names the one that works. The first time a keyboard key is pressed one notice says how to see the card; Settings › Writing & reading turns it off.
- asked: 2026-10-14 (owner)
- shipped: 5994be77
### R-input-010 · shipped
With a physical keyboard, Ctrl+Return (⌘+Return on a Mac) confirms the primary action button in any dialogue.
- asked: 2026-10-12, 2026-10-13, 2026-10-14
- shipped: 5994be77

### R-input-011 · requested
After the relevant action the cursor is placed in the prompt input field automatically.
- asked: 2026-10-14

### R-input-012 · shipped
While a prompt has not been sent, the user can edit it with an edit button.
- asked: 2026-10-19
- shipped: 61c601fb

### R-input-013 · requested
Confirmation prompts accept a response without 'y' and continue.
- asked: 2026-10-20

### R-input-014 · shipped
With a picture open in the annotator, Ctrl/Cmd+Return sends the picture first; the next press sends the prompt.
- asked: 2026-10-20
- shipped: abcd5220

### R-input-015 · requested
Remote desktop keyboard input accepts upper-case letters.
- asked: 2026-10-21

### R-input-016 · shipped
Typed answers sent to a backend are limited to 1000 characters and sent with Return only.
- asked: 2026-10-22
- shipped: ea856e88

### R-input-017 · shipped
On desktop, after pasting an image and sending it with Ctrl+Return, the caret is in the prompt box at the end of the text, so no mouse is needed.
- asked: 2026-10-24
- shipped: 81cd5434

