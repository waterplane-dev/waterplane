# Live desktop

The desktop extension (`packages/extensions/desktop/`) lets the phone watch the Mac's screen as
video, on the one WebSocket everything else uses, and, if the person turns it on, click and type
into it. macOS, and Windows when the host runs in WSL (see "Windows" below). Plan and the reasons behind each choice:
[desktop-stream-plan.md](../analysis/desktop-stream-plan.md). What was asked:
[R-desktop-*](../requirements/desktop.md). Experimental, `optional`, off a Mac it is a sentence.

**Why it exists.** NoMachine's server had quietly exited and launchd's `SuccessfulExit=false` did not
restart it, so "the desktop view" was gone and nobody knew until the phone got "connection refused".
This one rides the connection waterplane already has, and says in words why it cannot show a screen.

## The parts

| part | where | does |
|---|---|---|
| `wp-desktop` | `helper/*.swift` | ScreenCaptureKit capture, VideoToolbox H.264 or JPEG, CGEvent input, `probe`, `request`. Contract: `helper/PROTOCOL.md` (change both sides together) |
| host half | `host/*.mts` | builds and keeps the helper (`helperbin`), one `wp-desktop serve` per open view (`session`), the Auto controller (`auto`), the probe, the setup rows and their fixes (`setup`), the control gate |
| wire | `shared/wire.mts` | params, presets, input events, status; both halves import it |
| web half | `web/*` | player, gestures, key row, Quality sheet, stats chip; a Desktop line in the session ☰ menu whose open gives it a header segment (with an × that takes it down, `core/session/headerViews.ts`, the generic `sessionViews` seam), and a Desktop line in the launcher ☰ menu (2026-10-11 — the old home-screen button was dropped 2026-10-10 because it cost a whole row; launcher items now live in the menu); the view has its own close. Three fingers pan a zoomed view in every mode (two already mean scroll); a mouse uses the overview or the middle button |
| core seams | `plugins/pluginstreams.ts`, `sdk/stream.ts` | `api.stream` (plugin API 1.4) and `openStream`: [plugins.md](plugins.md) |

The extension's host half never touches a socket; the web half never touches the socket either (the
SDK owns it, `local/extension-boundary`).

## The helper, and why a rebuild forgets a grant

- **Built on first use** by `swiftc` into `<state dir>/bin/wp-desktop`, ad-hoc signed; no Xcode
  command line tools means the sentence `xcode-select --install`, not a stack trace. Nothing builds at
  import or activate; one build at a time; a failed build is not retried for a minute.
- **macOS keys Screen Recording and Accessibility on the binary's code signature.** An ad-hoc
  signature IS the cdhash, so every rebuild is a new binary and both grants are gone. So it rebuilds
  **only when `build.sh --hash` differs** from the `.srchash` the last build left, and says so (log
  and setup row) whenever a rebuild replaced an existing binary.
- **The identity is the brand's, handed in, not spelled.** `helperbin.mts` reads `BRAND` and passes
  `WP_DESKTOP_ID` (the app id's prefix plus `.wp-desktop`) and `WP_DESKTOP_NAME` to `build.sh` for both
  `--hash` and the build; `Info.plist` is a template filled into a scratch file. The identifier stays
  the same across builds (that is how macOS recognises the grant) and is part of the hash, so a rename
  rebuilds. A hand build gets `local.wp-desktop`. This is what `tools/brand.test.mjs` forced: Swift,
  plist and shell cannot import `brand.ts`.
- **The selftest driver is `selftest-driver`, not `selftest.py`.** One `.py` file in the tree
  activates the repo-health Python pack and re-cuts the version of every row of the series
  (`tools/repohealth/census.mjs`): the fixture stops reproducing and the owner's live series would be
  "mixed". It is test glue for a Swift helper, so it is named without an extension.
- **Who macOS judges.** Every child of the launchd host reports node as its responsible process, so a
  plain spawn would put the grant on `/opt/homebrew/bin/node` (every node script would get it and a
  Homebrew upgrade would drop it). `wp-desktop` re-execs itself with responsibility disclaimed
  (`Responsibility.swift`), falling back to a disclaimed child; `probe` and every status carry
  `responsibleSelf`, and a setup row warns when it is false.
- **Asking.** `probe` only reads (`CGPreflightScreenCaptureAccess`, `AXIsProcessTrustedWithOptions`
  with the prompt off), so looking can never raise a dialog. `wp-desktop request [screen|accessibility]`
  is the one command that asks. The setup rows' Fix runs it from a person's tap on the phone; the
  dialog appears on the Mac and names wp-desktop. That dialog has no Allow: it offers "Open System
  Settings" and "Deny", and neither grants — only the switch in the pane does. The note said "click
  Allow there" until 2026-10-09, and the owner took the dialog for the grant; it now says the button
  grants nothing by itself. macOS shows the Screen Recording dialog once per binary, so the host
  remembers (a marker beside the binary, keyed by the source hash) that it asked, and the next tap
  opens the System Settings pane instead; so does a helper that is not built or fails to run.
  Accessibility prompts on every call. `selftest.sh` only ever runs `--dry-request`.
- **Why not ffmpeg:** the avfoundation screen input is the deprecated capture path, it streams a
  still screen, it has no window source and no input injection, and this repo already rejected it for
  dictation as a binary the daemon does not otherwise need. One Swift binary needs nothing the Mac lacks.

## The stream path

`stream.open` / `params` / `input` / `ack` / `close` on the one socket, binary frames with a 12-byte
header to one socket only, and the rule that **video never delays a PTY frame or an ack** (droppable
frames are skipped past a backlog, a keyframe is asked after any skip, keyframes wait for the PTY
backlog): all in [plugins.md](plugins.md). None of it is durable, queued or ackId'd: a stream opened
late is for a screen nobody watches, and a click delivered late lands on another screen.

On the host an open view is one `wp-desktop serve` process (two views at most; a third is refused in
words). The helper's stdout records become frames; `config` to its stdin is a FULL params object;
closing is `stop`, EOF, SIGTERM after 1 s, SIGKILL after 3 s. The phone closes the stream when the
page is hidden and reopens it with a fresh keyframe; that is not an option. A still screen sends
nothing: ScreenCaptureKit delivers a frame only when pixels change.

**WebCodecs needs a secure context**, so plain `http://100.x` gets JPEG ("Stills") and the view says so.

**Which region a picture shows is told by the stream, not guessed.** After a crop change the phone used
to tag "the next keyframe" as the new region; a key the core asked for itself, or a `keyframeEverySec` key
already in the encoder, could arrive first and be drawn at the new region. Now the helper's output
writer (one lock) writes a `status` naming the new region (`crop`, `regionSeq`) immediately before the
first frame encoded for it, every frame carries the region it was submitted under, and the host passes
both through to `DesktopStatus`. `stream.status` and frames go out on the one socket in call order
(`pluginstreams.ts`), so the phone applies the newest named region at the next key
(`view.ts` `regionOnStatus` / `regionOnFrame`). Exactness and its two stated gaps: PROTOCOL.md, "Regions".
Pinned by the helper selftest (`[regions]`, real pixel sizes), `host.test.mjs` (a fake helper that sends an
old-region key late) and `view.test.mjs`.

**The idle-sleep hold follows the source.** The helper keeps the Mac awake (and App Nap off) only while a
source runs: not before the first config, not in `error`, not after `stop`. A phone left on "Screen
Recording is not granted" holds nothing awake. The selftest reads `pmset -g assertions`.

## The Auto controller

`host/auto.mts`, pure, one per stream with Auto on. In flight = bytes sent minus the phone's `rxBytes`.
In flight above 0.5 s of the current bitrate, or any skipped frame: bitrate x0.7 (floor 100 kbit/s).
5 s clean while frames were really going out: x1.15 up to the cap. Below 400 kbit/s the frame rate
follows (half the cap, never under 5). One change per second at most; a decrease that has to wait is
not forgotten. A bitrate change is the cheap `{"t":"bitrate"}`; an fps change is a `config`. The chip
shows the current pick, never hides it.

## Control is a gate on the host

The extension's one setting, **Let the phone control this desktop**, is off by default. With it off
`stream.input` is dropped on the HOST (one log line per stream per reason), not merely hidden on the
phone; with it on, an event still has to survive `cleanDesktopInput`. `control.on` in the status also
needs Accessibility, because without it the helper drops every event and a view saying "on" would
lie. The status names each closed gate (`control.needs`: `setting`, `accessibility`) so the view
lists them one by one, each with its fix: "turn on control" (the same `plugin.set` as the Settings
switch, two taps, live only) and "ask macOS for Accessibility" (the checklist's Fix). The Accessibility
step says outright that the phone cannot flip it: until it is on nothing from the phone clicks, so it
needs the Mac itself or another remote-control app. Control is arbitrary input on the desktop, the same trust as the PTY: see SECURITY.md. A peer
token never reaches a stream (`/api/peer/*` only), and no job, schedule or peer opens one. Secure input
(password fields, the login window) silently swallows synthetic keys; the view must never say "typed".

## Moving a zoomed view with a mouse

Fingers move a zoomed view with three of them (two mean scroll), and View only pans with one. A
desktop browser has neither: every plain press is a click on the desktop, and a wheel scrolls it. So:

- **The overview** (`Overview.tsx`): while zoomed, the whole desktop small in the bottom-right corner
  with the part on screen outlined. Drag the outline (held where it was pressed, so it does not jump),
  or press anywhere on it to centre the view there. Mouse, pen and finger alike, in fullscreen too. It
  is a SIBLING of the picture's element, never inside it: the controller's native pointer listeners on
  that element turn any press into a click. Size, rectangle and drag are pure (`view.ts`
  `overviewSize`/`overviewRect`/`overviewGrab`/`overviewDrag`/`centreOn`, `view.test.mjs`); at most a
  third of the box either way, absent when the box is too small.
- **Its picture is the last one of the WHOLE desktop**, copied at most once a second whenever a frame
  covering the full source is drawn. With Crop to view on, a zoomed stream carries only the crop, so
  the overview keeps the picture from before the zoom; the outline is always live.
- **The middle button drags the picture** (`isPanButton`): never sent as a click, and the browser's
  autoscroll and middle-click paste are kept off the picture. Ctrl+wheel still zooms.

## Screenshot: the core's route, not the stream

The camera button (the toolbar row, and a worded float on the picture in fullscreen, where the toolbar
is hidden) saves the WHOLE desktop at full resolution into the session repo's `.claude/outbox/`, so it
lands in the phone's gallery. It is the existing `POST /api/host/screenshot` (`screencapture -x`,
the main display), reached through the SDK's `desktopScreenshot` (`web/src/desktopShot.ts`), not
the canvas: the stream's picture may be cropped to the zoomed view, scaled to the phone and
compressed, and the helper has no one-shot capture (adding one would mean a rebuild, and a rebuild
drops both grants). Measured 2026-10-15 from the launchd host: 3840x2160, real windows, 2.6 MB PNG.

- **Not gated on control.** The switch gates INPUT; a screenshot is watching, which the open view
  already is. It is drawn only while the view can serve (`availability` true). The route is a device
  token's, POST (side effect), never a peer's (`/api/peer/*` only).
- **Which repo:** `world.activeRepo`, the session the view sits over. None (the launcher, nothing
  open) is a sentence naming where it would have gone, not a hidden button.
- **The receipt is a line in the picture's column, not a toast.** In fullscreen the column (z 80) sits
  over the toast layer (z 20), so a toast would be said where nobody can read it. It names the file by
  its full path (`<repo>/.claude/outbox/screenshot-….png`), has an open (the viewer, whose close comes
  back to the view, `openFileFrom(…, DESKTOP_SHEET)`), a ×, and gives its room back after 15 s.

## Presets, with the numbers they were measured at

Helper selftest, synthetic busy 2560x1600 desktop (an editor scrolling, a terminal whose glyphs change
every frame: worse than most real screens; a still real one costs about nothing), M-series, macOS 26:

| preset | params | fps achieved | kbit/s | encode ms/frame |
|---|---|---|---|---|
| Auto (default) | h264, fit phone, 30 fps, AIMD 100 kbit/s to 4 Mbit/s | follows the link | follows the link | n/a |
| Data saver | h264 640 wide, 8 fps, cap 150 | 8.1 | ~85 | 1.8 |
| Balanced | h264 1280 wide, 15 fps, cap 800 | 15.2 | ~550 | 3.0 |
| Sharp text | h264 1920 wide, 30 fps, cap 3000 | 30.2 | ~2950 | 5.4 |
| Stills | jpeg q40 1280 wide, 2 fps | 2.0 | ~2600 (164 KB a frame) | 3.6 to 6 |

Stills are NOT a saver: JPEG has no inter-frame coding, so dense text is expensive. They exist for a
phone without WebCodecs. Also measured: a keyframe request is answered by the next frame (4 ms on a
still screen), EOF on stdin exits in 3 to 25 ms. Re-run with `helper/selftest.sh`; its last table
prints these. Custom exposes codec, resolution, fps, bitrate, JPEG quality, grayscale (JPEG only),
keyframe refresh, cursor, source (display, one window, the front window) and Crop to view. A
cellular start in Data saver (says so) and an optional data cap that pauses and says so are settings,
never silent degradation.

## Tests

`packages/extensions/desktop/test/` (`host.test.mjs` over `fake-helper.mjs`, which speaks only
PROTOCOL.md; `wire.test.mjs`) and the web half's `*.test.mjs` run in `test:unit` / `test:host`.
`scripts/e2e-desktop.mjs` boots a real host with `WATERPLANE_DESKTOP_SYNTHETIC=1` (every helper runs
`--source synthetic --no-capture --dry-input`: the test pattern, never the screen, input logged and
not posted) and builds the real helper; it SKIPs off a Mac or without `swiftc`.
`scripts/e2e-stream.mjs` covers the core seam with a fixture plugin. Nothing automated ever runs a
real capture, posts a real event, or calls a request API.

## Windows

Asked 2026-10-16. A host in WSL (`detectDesktopOs` in `host/knobs.mts`: `WSL_DISTRO_NAME`, else
`microsoft` in the kernel release) runs `helper-win/`'s `wp-desktop.exe` through interop instead of
the Swift helper; everything above the helper (session, Auto, status, gate, web) is the same code.
The contract and what differs is PROTOCOL.md's "Windows" section. The choices:

- **C# 5, compiled by `csc.exe` from the .NET Framework directory.** It is on every Windows 10/11,
  so "built on first use, nothing to install" holds as it does with `swiftc` on a Mac. A .NET SDK,
  Rust or a prebuilt binary would each be a download, and a prebuilt unsigned .exe in the repo is
  the thing a reader of a remote-control tool should least have to trust. The cost is C# 5 syntax and
  hand-written COM interop for Media Foundation (`Native.cs`).
- **GDI capture, not Desktop Duplication or Windows.Graphics.Capture.** One `StretchBlt` crops and
  scales; no D3D, no WinRT projection (which C# 5 cannot reach). It is CPU work per frame, measured
  only under Mono so far. If it is too slow on a real 4K screen, Desktop Duplication is the next step.
- **Software H.264 MFT, synchronous.** The hardware MFTs are asynchronous (event-driven) and vary
  by GPU vendor; the Microsoft software encoder is on every install and simple to drive.
- **No grants, so fewer rows.** Windows asks no app for permission to read the screen or send input.
  What can stop it is the session: a host started in session 0 (a scheduled task "whether the user
  is logged on or not") sees no desktop, and the lock screen or a UAC prompt is a desktop no app
  reads. Those are a sentence (`WIN_NO_DESKTOP`) with no Fix: no tap on the phone changes them. The
  setup checklist has three rows (helper, Windows desktop, control); the Accessibility and
  permission-owner rows are Mac-only, and the ask fixes say there is nothing to ask.
- **Control** reaches every app except an elevated one: Windows' UIPI drops synthetic input into a
  window running as administrator, silently. The control row says so. `cmd` sends the Windows key.
- **Screenshot**: `takeScreenshot` (core `host.ts`) asks Windows through PowerShell for the primary
  display at its real pixel size, as `screencapture -x` does on the Mac.

**Not verified on Windows at all yet** (the peer zenbookj was offline when it was built): the build
through interop, a real capture, the H.264 encoder (GUIDs and vtable layouts are hand-declared; a
wrong one fails at the first `config` with the HRESULT in the sentence), real input, that a helper
started from the `waterplane-host` scheduled task is in the user's session, that stdin EOF reaches the
Windows process when the host kills the interop shim, and the PowerShell screenshot. Verified: it
compiles as C# 5 (Mono `mcs -langversion:5`), and under Mono the synthetic source, JPEG, regions,
stats, dry input and EOF behave per PROTOCOL.md.

## Not verified until someone is at the Mac (and the phone)

Everything above was built and tested without the owner present, so none of this has been seen:

- That the grant lands on `wp-desktop`, not node, when the host runs under launchd (`responsibleSelf`
  from the launchd host; `wp-desktop whoami` diagnoses it). The fallback, if it cannot, is a
  user-session LaunchAgent for the helper.
- A real capture with a real Screen Recording grant, and that the `request` dialog appears, names
  wp-desktop, and lists it in the pane. The "macOS asks once per build, then open the pane" rule is an
  assumption about macOS, held in a marker file, not an observation.
- Real input with a real Accessibility grant, including that a rebuild does forget both grants.
- WebCodecs H.264 in the APK WebView (Capacitor, `https://localhost`) and in Chrome over
  `tailscale serve`; the hardware decoder on the phone; battery and heat at 30 fps (if bad, Auto's
  cap drops to 15).
- Head-of-line blocking: PTY latency on a slow link while video is open, and Auto on a real one. The
  bitrates above are the synthetic pattern's, not a real screen's.
- How any of the UI looks and feels on a phone.
