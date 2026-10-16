# wp-desktop process protocol

This is the contract between `wp-desktop` (this directory, Swift) and the desktop extension's host half,
which spawns it. Change both sides together. Plan: `docs/analysis/desktop-stream-plan.md` §1.

## Build and placement

- `build.sh OUT` compiles every `*.swift` here with `swiftc -O -target arm64-apple-macos14`, embeds
  `Info.plist` (a template, filled into a scratch file), and ad-hoc signs. It writes `OUT.srchash`
  next to the binary.
- The signing identifier and display name are not spelled in these files: the host (`helperbin.mts`)
  derives them from the brand table and passes `WP_DESKTOP_ID` (the app id's prefix plus `.wp-desktop`)
  and `WP_DESKTOP_NAME` in the environment, for `--hash` and for the build alike. They are part of
  the hash. The identifier is the same on every build: macOS keys the grant on it. Without them
  (a hand build, `selftest.sh`) the identifier is `local.wp-desktop`.
- `build.sh --hash` prints the source hash. **Rebuild only when it changes.** A TCC grant is bound to the
  code signature, and an ad-hoc signature is the cdhash, so every rebuild means the owner grants Screen
  Recording and Accessibility again.
- Install at a stable path: `<state dir>/bin/wp-desktop`. TCC lists a non-bundled binary by its path.
- If there is no `swiftc` or SDK, `build.sh` exits 3 with the sentence `xcode-select --install`.
- `selftest.sh` builds into `$TMPDIR`, then exercises the synthetic source and dry-run input. It never
  touches the screen and never posts an event.

## Commands (argv)

| argv | does |
|---|---|
| `wp-desktop serve [--source synthetic] [--dry-input]` | the stream (below) |
| `wp-desktop probe` | one JSON line on stdout, then exit |
| `wp-desktop windows` | one JSON line: `{windows:[{id,pid,owner,name?,bounds:{x,y,w,h}}]}`. Metadata only; titles appear only where the system hands them out. Never prompts. Not part of `probe`. |
| `wp-desktop whoami` | `{pid, ppid, responsiblePid, responsibleSelf, disclaimed, path}` (`disclaimed` is `""`, `"exec"` or `"child"`). Diagnoses TCC attribution. |
| `wp-desktop request [screen\|accessibility]` | **ASKS macOS for the grant** (below), then one JSON line. Both kinds when none is named. The only command that can raise a dialog. |
| `wp-desktop version` | `0.1.0` |

Test-only flags:
- `--dry-request` (with `request`): read the current grant, call neither request API.
- `--no-capture`: behave as if Screen Recording were not granted.
- `--no-disclaim`: skip the re-exec described next.
- `--force-disclaim` and `--force-disclaim-child`: take the re-exec or child path even when already responsible for itself.

### Responsibility (who TCC asks about)

`serve`, `probe` and `whoami` first check `responsibility_get_pid_responsible_for_pid(getpid())`.
If the helper is not responsible for itself, it **re-execs itself in place**: `posix_spawn` with
`POSIX_SPAWN_SETEXEC` plus `responsibility_spawnattrs_setdisclaim(attr, 1)`, and
`WP_DESKTOP_DISCLAIMED=exec` in the environment. The pid, stdin, stdout and stderr are unchanged, so
the host notices nothing. Afterwards TCC judges `wp-desktop` itself, not node.

If the re-exec'd image is *still* not responsible for itself, the helper falls back to a disclaimed
**child** (`WP_DESKTOP_DISCLAIMED=child`):
- The child shares the same stdio fds.
- The pid the host holds becomes a thin parent. It forwards SIGTERM, SIGINT and SIGHUP, and exits with
  the child's status.
- The child exits when stdin hits EOF or when the parent goes away.
- Killing the pid the host spawned still ends everything. The selftest checks this.

- Set `WP_DESKTOP_NO_DISCLAIM=1` to opt out.
- `probe`, `whoami` and every status record carry `responsibleSelf`. If it is false, the grant would be
  judged for the parent (node), and the setup row should say so.
- Spawn it plainly from node. No shim is needed.

## `probe`

```json
{"screenRecording":false,"accessibility":false,"os":"macOS 26.6.2","helperVersion":"0.1.0",
 "pid":123,"responsiblePid":123,"responsibleSelf":true,
 "displays":[{"id":4,"width":3840,"height":2160,"scale":2,"main":true,
              "bounds":{"x":0,"y":0,"w":1920,"h":1080}}]}
```

- `width` and `height` are pixels.
- `bounds` is global points, top-left origin (CGEvent space).
- `screenRecording` comes from `CGPreflightScreenCaptureAccess()`.
- `accessibility` comes from `AXIsProcessTrustedWithOptions(prompt: false)`.
- **Neither ever prompts.** Neither does anything else in `probe`.

## `request`

```
wp-desktop request screen
{"accessibility":…,"dry":false,"responsibleSelf":true,"screen":{"already":false,"asked":true,"granted":false}}
```

- Runs through the same responsibility-disclaim path as `serve` and `probe`, so the dialog, and the row
  it adds to System Settings, name `wp-desktop`, not node.
- `screen` calls `CGRequestScreenCaptureAccess()`; `accessibility` calls
  `AXIsProcessTrustedWithOptions(prompt: true)`. With neither named, both, in that order.
- It **returns at once**. Both calls only start the dialog, which the system shows on the desktop's
  screen and the person answers there. `granted` is therefore usually `false` right after `asked:true`:
  the answer is read later with `probe`.
- Per kind: `already` is the grant before the call; `asked` is false when it was already granted (no
  request API was called), and in a `--dry-request`.
- macOS shows the Screen Recording dialog once per binary (per signature), so a repeat may show nothing.
  The host remembers that it asked for this build and opens the System Settings pane instead on the
  next tap. Accessibility prompts on every call.
- An unknown name exits 2 with one stderr line.
- The host runs it only from a person's tap on a setup row (`setup.mts`), never on its own, never from
  a peer or a job. `selftest.sh` only ever runs `--dry-request`.

## `serve`

### stdin: newline-delimited JSON

| line | effect |
|---|---|
| `{"t":"config", …params}` | The first one starts capture; later ones re-steer it. See "Params" below. Emits a status record. |
| `{"t":"keyframe"}` | Requests an IDR. The next frame is a key. On a still screen, the last frame is re-encoded as a key at once (≈3 ms), because no new frame would come. |
| `{"t":"bitrate","kbps":n}` | Cheap live change (clamped 50–20000). There is no new session and no keyframe. Emits a status record. |
| `{"t":"input","ev":{…}}` | Injects one event. See "Input" below. |
| `{"t":"stop"}` | Stops capture and encoder, emits `state:"stopped"`, and stays alive. A later `config` starts again. |
| `{"t":"probe"}` | Emits the probe object as a JSON record (`t:"probe"`). |

Invalid lines are ignored with **one stderr line each, never a crash**: bad JSON, unknown `t`, bad fields,
or lines over 1 MB.

**EOF on stdin means a clean exit within 1 s.** The selftest measures 3–9 ms. The host dying closes the
pipe, so a capture never outlives the host. Two backstops:
- being re-parented (`getppid()` changed) means exit within 1 s;
- a failed stdout write (EPIPE) means exit.

While a **source is running** (the capture or the synthetic pattern started, state `starting` or
`running`), `serve` holds a `latencyCritical | userInitiated | idleSystemSleepDisabled` activity:
- Without it, App Nap coalesces timers. A 66 ms frame timer was measured firing every ~180 ms.
- The Mac does not idle-sleep while a stream is up. The display may still sleep.
- It is **not** held before the first `config`, in state `error` (Screen Recording not granted: the
  helper stays alive so a new `config` can retry) or after `stop`: a phone left on that sentence must not
  keep the Mac awake. It is begun when a source starts, ended in the same teardown that ends the source,
  and logged (`activity: held` / `activity: released` on stderr). `pmset -g assertions` (read-only) lists it
  as `PreventUserIdleSystemSleep named: "live desktop stream"` against the helper's pid; the selftest
  checks that.

### stdout: binary records

```
u32le  length of the rest (= 10 + payload length)
u8     kind     1 = H.264 (Annex-B)   2 = JPEG   4 = JSON (status / stats / probe)
u8     flags    bit 0 = key
u64le  ptsMicros
       payload
```

`ptsMicros` is `CLOCK_UPTIME_RAW` in µs at capture.
- That is the same clock as `mach_absolute_time`, as SCK's sample times, and as node's
  `process.hrtime.bigint()/1000n` on macOS.
- So the host can measure capture→send latency directly.
- It increases strictly within one process.

**H.264 (kind 1)**
- One access unit per record, in Annex-B form (4-byte start codes).
- A record with the key flag begins with SPS and PPS, so it is a complete entry point. It is an IDR.
- There are no B-frames. Decode order equals presentation order.
- Profile: Main, AutoLevel (Baseline if Main is refused). The status record's `avc` names the codec
  string for WebCodecs, e.g. `avc1.4d0020`. The client can also read it from SPS bytes 1–3.
- Droppable: every non-key record. After the host drops one, it must send `{"t":"keyframe"}` and drop
  until a key arrives.
- **The size changes only with a key.** A crop or `maxWidth` change, or a moved window, creates a new
  encoder session. Its first record is a key with the new SPS. The status record names the new size.
- **A new region starts on a key of that region.** A `config` that changes `crop` or `source` (even at
  the same output size) forgets the last frame and keys the next captured one, so a `keyframe` asked
  right after it can never re-encode the previous region.
- **Which key that is, the stream says (see "Regions").** The phone does not guess it as "the next key
  after I asked for a crop": a key asked for by the core itself, or a `keyframeEverySec` key already in
  the encoder when the config landed, can come first and still be of the old region.

**JPEG (kind 2):** One baseline JFIF per record, always flagged key, always droppable.

**JSON (kind 4).** Dispatch on `t`.

`t:"status"`: one on start (once the source size is known), one on every config or bitrate change, one
on any error, and one when the H.264 codec string first becomes known.

```json
{"t":"status","state":"running","width":1280,"height":800,"srcWidth":2560,"srcHeight":1600,
 "fps":15,"codec":"h264","bitrateKbps":800,"source":"display","avc":"avc1.4d0020",
 "screenRecording":true,"accessibility":false,"responsibleSelf":true,"helperVersion":"0.1.0",
 "crop":{"x":0,"y":0,"w":1,"h":1},"regionSeq":1,
 "reason":"…only when there is something to say…"}
```

- `state` is one of:
  - `"starting"`: a screen source is resolving.
  - `"running"`
  - `"error"`: capture is torn down. The helper stays alive, so a new `config` retries.
  - `"stopped"`
- `width` and `height` are the encoded size.
- `srcWidth` and `srcHeight` are the full source in pixels, not the crop.
- `reason` is a sentence for a person, never a code. Examples:
  - Screen Recording not granted: *"Screen Recording is not granted to wp-desktop. On the Mac, open
    System Settings → Privacy & Security → Screen Recording, turn on wp-desktop, then open the desktop
    view again."* This comes with `state:"error"`, and no capture API is called.
  - Accessibility missing when an input arrives: a `running` status with a sentence naming
    System Settings → Privacy & Security → Accessibility. Events are dropped. The sentence repeats at
    most once per 10 s.
  - A display not active, a window closed, the encoder refusing a size.

#### Regions

A **region** is what a run of frames shows: the crop (and the source) they were encoded for. Every
`config` that changes the crop or the source, and every source restart, starts a new one, numbered by
`regionSeq` (1, 2, 3, ...; it only grows within one `serve`).

- Each frame carries the region that was current when it was **submitted** to the encoder, so
  VideoToolbox's late output still says which config made it.
- The writer of stdout (one lock) holds the region the OUTPUT is in. **The first frame of a new region
  is preceded, in the same locked write, by a `status` record naming it.** Every `status` carries
  the output's region as `crop` (normalised 0..1 of the full source; the whole source is
  `{"x":0,"y":0,"w":1,"h":1}`) and `regionSeq`. A status written for another reason (a bitrate change)
  therefore names the region of the frames that came before it, never a config the encoder has not
  reached yet. Before the first frame the fields are absent.
- So on this one ordered stream, a status naming region N is followed by region N's frames and by no
  earlier region's, and a frame is of the region the newest status named. Nothing is claimed about a
  region's frames the host skips.
- The host passes `crop` and `regionSeq` through to `DesktopStatus` (checked, absent when bad). The core
  sends `stream.status` and binary frames on the one WebSocket, each synchronously at the call, so
  they reach the phone in the order the host read them (`pluginstreams.ts`'s `send` and `status`, and the
  session handling each record as it is read). The phone remembers the newest named region and
  applies it at the next KEY (`web/view.ts`, `regionOnStatus` / `regionOnFrame`).
- Not covered: a frame ScreenCaptureKit captured under the old `sourceRect` and delivers after a live
  crop change is submitted under the new region (the helper cannot tell). Its next key puts that
  right. The synthetic source has no such lag.
- A status the core refuses while the view is still opening is retried 50 ms later; a crop change in
  that window can be named late, and the next key puts it right.

`t:"stats"`: every 2 s while running. The same numbers go to stderr as a `stats …` line.

```json
{"t":"stats","fps":15.0,"kbps":668,"keys":0,"encodeMsAvg":2.8,"encodeMsMax":3.7,
 "captured":30,"dropped":0,"periodMs":2001,"idle":false}
```

- `encodeMs*` measures submit → encoded output, inside the helper.
- `dropped` counts frames skipped because the encoder had more than 2 in flight.
- `idle: true` means the source reported a still screen in this period.

### Params (the `config` object)

**A config is a full params object.** A field left out takes its **default**, not its previous value.
The helper clamps every field.

| field | type | default | clamp / meaning |
|---|---|---|---|
| `codec` | `"h264"` \| `"jpeg"` | `"h264"` | a change restarts the source (pixel format 420v ↔ BGRA) |
| `source` | `{kind:"display",id?}` \| `{kind:"window",id}` \| `{kind:"front"}` \| `{kind:"synthetic",idle?}` | main display | `id` = CGDirectDisplayID / CGWindowID. `front` follows the frontmost window, polled at 1 Hz. `synthetic` is the test pattern; `idle:true` stands still 3 s of every 6 s. |
| `crop` | `{x,y,w,h}` normalised 0..1 of the full source | full | w,h ≥ 0.02. Becomes SCK `sourceRect`. Live. |
| `maxWidth` | px of encoded output | 1280 | 0 = native. Otherwise 64–8192. Never upscales; keeps aspect; even numbers. H.264 caps either side at 4096. |
| `fps` | 1–60 | 15 | SCK `minimumFrameInterval`. Live. |
| `bitrateKbps` | 50–20000 | 1000 | AverageBitRate, with DataRateLimits = 1.5× over 1 s. Live. |
| `jpegQuality` | 1–100 | 50 | Live. |
| `grayscale` | bool | false | JPEG only: one-component JPEG. Live. |
| `keyframeEverySec` | ≥ 0 | 0 | 0 = keyframes only on demand (and at session start). Live. |
| `cursor` | bool | true | SCK `showsCursor`. Live. |

What restarts what:
- A change of codec, source kind, display id or synthetic mode restarts the source.
- Another window id is re-aimed live (`updateContentFilter`).
- Everything else goes through `updateConfiguration` or a property set on the encoder.

`--source synthetic` on argv forces the synthetic source whatever `config` says. Tests use it.

### Input (`{"t":"input","ev":…}`)

**Coordinates.** `x` and `y` are **normalised 0..1 of the current source's full bounds**: the whole
display or window, **not the crop**.
- The helper maps them to global display points.
- Values within 0.05 outside 0..1 are clamped. Values further out are refused.

**Shapes:**

| ev | posts |
|---|---|
| `{k:"move",x,y}` | mouseMoved, or `*MouseDragged` while a button is held from `down` |
| `{k:"down",b,x,y}` / `{k:"up",b,x,y}` | `b`: `"l"`, `"r"` or `"m"` (default `"l"`). clickState 1. |
| `{k:"click",b,x,y,n}` | move, then `n` (1–3) down/up pairs with clickState 1…n. `n:2` is a double click. |
| `{k:"scroll",x,y,dx,dy}` | move, then `CGEventCreateScrollWheelEvent2`, pixel units (points). **DOM sign**: `dy > 0` scrolls the content down, as in `WheelEvent.deltaY`. The phone speaks the opposite (`dy > 0` = fingers moved down, in source pixels): the host's `session.mts` (`helperScroll`) negates it and divides by the display scale. |
| `{k:"key",key,mods}` | keyDown and keyUp (see below) |
| `{k:"text",s}` | `CGEventKeyboardSetUnicodeString` in chunks of ≤ 20 UTF-16 units, never splitting a surrogate pair. Up to 4096 units per event. |

**`key` names**, with the US layout:
- `Escape`, `Tab`, `Return`/`Enter`, `Backspace`, `Delete` (forward delete)
- `ArrowUp`/`Down`/`Left`/`Right`, `Home`, `End`, `PageUp`, `PageDown`
- `Space`, `F1`–`F12`
- any single printable US-layout character. Upper-case letters and shifted symbols imply Shift.

**`mods`** is any of `cmd`, `alt`, `ctrl`, `shift`, set as event flags. Every shape accepts it.

**Refusals.**
- An invalid event is ignored with one stderr line and never crashes the helper.
- Without Accessibility, events are dropped and a status record carries the sentence.
- **Secure input** (password fields, the login window) silently swallows synthetic keys. The helper
  cannot see this. The view must not claim "typed".

**`--dry-input`** builds every CGEvent exactly as it would post it, then logs it instead of posting:

```
wp-desktop: dry-input: leftMouseDown x=480.0 y=270.0 flags=0x0 button=l clicks=1
wp-desktop: dry-input: scrollWheel x=960.0 y=540.0 flags=0x0 wheel=-120,0
wp-desktop: dry-input: keyDown x=… y=… flags=0x100000 key=0x08
```

## Measured (selftest, synthetic source, M-series Mac, macOS 26.6)

The synthetic pattern is a worst-ish case:
- a 2560×1600 virtual desktop
- an editor scrolling 3 lines/s
- a terminal panel whose glyphs change every frame

A still real screen costs ~0. In the `idle` phase, no records are sent.

| preset | params | fps achieved | rate before the live change | after a live `bitrate` to 40% | encode ms/frame |
|---|---|---|---|---|---|
| Data saver | h264 640×400, 8 fps, 150 kbps | 8.1 | ~81 kbps (under the cap) | 60 kbps | 1.8 |
| Balanced | h264 1280×800, 15 fps, 800 kbps | 15.2 | ~517 kbps (under the cap) | 326 kbps | 3.1 |
| Sharp text | h264 1920×1200, 30 fps, 3000 kbps | 30.2 | ~3030 kbps (at the cap) | 1384 kbps | 5.3 |
| Stills | jpeg 1280×800, 2 fps, q40 | 2.0 | ~2.6 Mbps (164 KB/frame) | grayscale: 152 KB/frame | 3.6 |

More measurements:
- A keyframe request is answered by the next frame (≤ 1 frame later).
- On a still screen, a keyframe request is answered in 4 ms.
- EOF to exit takes 4–8 ms.

Stills are expensive on dense text: JPEG has no inter-frame coding. The grayscale gain is understated
here because the pattern is already almost colourless. Re-run with `selftest.sh`. Its last table
prints these numbers.

## Windows (`../helper-win/`, `wp-desktop.exe`)

The same contract, kept by a second helper in C#. The host picks it when it runs in WSL
(`detectDesktopOs`), spawns it through WSL's interop, and treats it exactly as the Mac's: same argv,
same stdin lines, same records, same status and stats fields. What differs:

- **Build.** `helper-win/build.sh OUT` (bash, in WSL) compiles every `*.cs` with the .NET Framework's
  `csc.exe` (C# 5, `C:\Windows\Microsoft.NET\Framework64\v4.0.30319`), in a Windows temp directory,
  and copies the result to `OUT` (`<state dir>/bin/wp-desktop.exe`). No interop, no `csc.exe`:
  exit 3. `--hash` works anywhere. Windows keys no permission on the binary, so a rebuild forgets
  nothing (the host sets no `rebuiltAt`). The code is C# 5 on purpose: that is the compiler every
  Windows 10/11 has. Check a change with Mono: `mcs -langversion:5 -unsafe -platform:x64
  -r:System.Drawing.dll -r:System.Web.Extensions.dll *.cs`.
- **Grants.** None exist. `screenRecording` means "this process can see the signed-in desktop": not
  session 0 (a scheduled task set to run whether the user is logged on or not) and the input desktop
  opens (not the lock screen or a UAC prompt). The host turns `false` into `available:false` with a
  sentence, not a grant button. `accessibility` is always true; `responsibleSelf` always true;
  `request` asks nothing and answers the same shape; `whoami` adds `session`.
- **Capture.** GDI: `StretchBlt` (HALFTONE) from the screen DC crops and scales in one call; the
  cursor is drawn with `DrawIconEx`. Each grab is compared with the last, so a still screen sends
  nothing (stats say `idle`). Per-monitor DPI aware: every size and coordinate is physical pixels.
  A window source is the screen region of the window's frame (DWM extended bounds), so whatever is
  in front of it shows too, which is also where a click lands. Window ids are HWNDs; display ids are
  the n of `\\.\DISPLAYn`; `scale` is the monitor's DPI over 96. A grab refused by the secure desktop
  is a `running` status with the sentence (at most every 10 s), and capture keeps trying.
- **H.264.** Media Foundation's software encoder MFT (`CLSID_MSH264EncoderMFT`), synchronous:
  BGRA → NV12 (BT.601, limited) in the helper, Main profile (Baseline if refused), low-latency mode,
  no B-frames, peak-constrained VBR with max = 1.5× mean, mean bitrate changed live, keys forced with
  `AVEncVideoForceKeyFrame`. Annex-B; a key without SPS gets the sequence header prepended.
  An N edition without the Media Feature Pack has no MF: the status says to use Stills.
- **JPEG.** GDI+. Grayscale is three equal channels, not a one-component file.
- **Input.** `SendInput`, absolute over the virtual desktop. `cmd` is the Windows key. Wheel: 3 wheel
  units per point (120 a notch ≈ 40 points), DOM sign as above. Text is `KEYEVENTF_UNICODE`. Windows
  drops synthetic input into an elevated window (UIPI) and on the secure desktop without a word.
  `--dry-input` logs the same `dry-input: …` lines.
- **Keeping awake.** `SetThreadExecutionState(ES_SYSTEM_REQUIRED)` on the worker thread only while a
  source runs; the same `activity: held/released` log lines.
- **Exit.** stdin EOF (≤ 0.5 s) and a failed stdout write. There is no re-parent check: through
  interop the Windows parent is not the host.
- **Clock.** `ptsMicros` is QueryPerformanceCounter in µs: increasing within the process, but not
  the host's clock (the host does not compare them).
- Not built for Windows: `--force-disclaim*`, `--no-disclaim` (nothing to disclaim).
