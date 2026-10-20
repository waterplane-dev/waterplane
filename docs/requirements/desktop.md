# desktop

All items: asked by the owner 2026-10-09, after NoMachine's
server had quietly stopped: "an additional video desktop live stream feature as plugin … integrated
kind of similar as the shell feature but also available on the main screen and with various options
to optimize for bandwidth". Owner chose view + control now, macOS host first.
Plan: `docs/analysis/desktop-stream-plan.md`; design and what is unverified: `docs/notes/desktop.md`.
Shipped, pending a check on a real phone and the owner's Screen Recording and Accessibility grants on the Mac.

### R-desktop-001 · shipped
The desktop's screen can be watched live from the phone as video. It ships as an extension and
works on the same connection as everything else.
- asked: 2026-10-09
- shipped: 7a9b776e, fecccccf, c823e072, 8d0998be, bb12fa16

### R-desktop-002 · shipped
The session header's segment offers Desktop next to Claude and Shell, once Desktop has been opened
from the ☰ menu; the tab's × takes it down again, and until then the header spends no room on it.
Desktop is there even when the session has no companion shell. When the desktop cannot be shown,
tapping it says why in words.
- asked: 2026-10-09; only-after-opened and the × asked
  2026-10-09: "only show that Desktop button after the user
  opened it from the menu … close the remote view with an x and then also hide that space
  consuming button"
- shipped: 426a2a13, 8d0998be

### R-desktop-003 · shipped
The home screen has a one-tap way into the live desktop, with no session needed.
- asked: 2026-10-09
- shipped: 426a2a13, 8d0998be

### R-desktop-004 · shipped
The desktop can be controlled from the phone: clicks, right clicks, drags, scrolling, keys with
modifiers, and typed text. There is a touch mode and a trackpad mode. Control stays off until it is
turned on in settings, and a view-only lock is available.
- asked: 2026-10-09
- shipped: c823e072, 8d0998be, bb12fa16

### R-desktop-005 · shipped
Bandwidth is the person's to choose, from presets (Auto, Data saver, Balanced, Sharp text, Stills)
or individual knobs: codec, resolution, frame rate, bitrate, quality, keyframe refresh, cursor,
source display or window, and streaming only the zoomed-in area. A still screen costs next to
nothing.
- asked: 2026-10-09
- shipped: 7a9b776e, c823e072, 8d0998be

### R-desktop-006 · shipped
The view shows what it costs: bitrate, frame rate, latency and megabytes used. An optional data cap
pauses the stream and says so. On cellular it starts in the saver preset and says it did.
- asked: 2026-10-09
- shipped: 8d0998be, bb12fa16

### R-desktop-007 · shipped
Watching the desktop never slows down the terminal or a prompt's delivery on the same connection.
The stream stops when nobody is watching, including when the app goes to the background.
- asked: 2026-10-09
- shipped: fecccccf, 8d0998be

### R-desktop-008 · shipped
macOS first (Windows since R-desktop-013). On other desktops, and from peer desktops, jobs or schedules, a live desktop is never
opened. Where it is unavailable, the phone says so in words.
- asked: 2026-10-09
- shipped: fecccccf, bb12fa16
### R-desktop-009 · shipped
The live desktop view has its own close button, a three-finger pan in every zoom mode and no always-visible launcher button; it reopens from the menu line. Its orange notice names each closed control gate with its own fix button.
- asked: 2026-10-10, 2026-10-09
- shipped: 20acdd54, 257eba0b

### R-desktop-010 · shipped
The desktop's own setup rows (helper, Screen Recording, Accessibility) sit in a system-level checklist in Settings, not in any repo's checklist.
- asked: 2026-10-09
- shipped: 1760f7f5


### R-desktop-011 · shipped
The live desktop view has a screenshot button, in the toolbar and on the picture in fullscreen, that
saves the whole desktop at full resolution (not the possibly zoomed or compressed stream picture) into
the session repo's `.claude/outbox/`, so it shows in the gallery. A receipt names where it went and opens it.
- asked: 2026-10-14 (owner)
- shipped: 39b5d688

### R-desktop-012 · shipped
A zoomed desktop view can be moved with a mouse, outside fullscreen and in it, without sending
anything to the desktop: an overview of the whole desktop in a corner whose outline is dragged (or
pressed to jump there), and a middle-button drag on the picture.
- asked: 2026-10-14 (owner)
- shipped: a0301548

### R-desktop-013 · built, unverified on Windows
The live desktop works on a Windows desktop whose host runs in WSL, as it does on the Mac: watch,
the same presets, and control behind the same switch. Nothing to install: the helper is compiled on
first use by the C# compiler Windows already carries. Where it cannot show the screen (the host
outside the signed-in session, a locked screen), the phone says so in words.
- asked: 2026-10-16 (owner, a marked screenshot of the Desktop button: "build the remote desktop thing also for windows")
- built: the commit that adds `packages/extensions/desktop/helper-win/`; compiled under C# 5 and run
  (synthetic source, JPEG, dry input) under Mono only — never on Windows yet
### R-desktop-014 · shipped
In the remote desktop view, keyboard input and shortcuts typed on the desktop are forwarded to the remote desktop, including in full screen.
- asked: 2026-10-14
- shipped: 7dc611f

### R-desktop-015 · shipped
Full screen fills the whole screen with the remote display; the top tabs bar is hidden there while the other two status bars stay visible.
- asked: 2026-10-14
- shipped: 0fb733d

### R-desktop-016 · shipped
The live desktop view has a focus toggle in its header that streams the front window.
- asked: 2026-10-16
- shipped: c25e0c06

### R-desktop-017 · shipped
The desktop strip shows how many agents run in parallel, amber past 10 and red past 30, with configurable marks. Past a mark the strip appears by itself and can be closed; tapping the count opens details with agent count over time and which sessions run how many agents, and tapping a session opens it.
- asked: 2026-10-17
- shipped: 5fb76a92, df902b7e

