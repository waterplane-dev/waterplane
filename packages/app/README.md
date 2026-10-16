# waterplane — Android shell (`@waterplane/app`)

An APK that ships the existing web UI inside itself instead of downloading it
from the daemon. It exists for exactly one property:

> **The app shell is never on the network.**

Everything else here follows from that.

**iOS:** the same package also holds an iOS shell (`ios/`, simulator-only — no paid Apple account),
built and launched with `scripts/ios-sim.sh`. Its page is `capacitor://localhost` rather than
`http://localhost`; why, and what is ported, is under [iOS shell](#ios-shell) at the end.
Everything else here is the Android shell.

---

## The problem it solves

The PWA is served by the daemon over Tailscale. That means the *application
itself* is on the far side of the tunnel, and so:

- **Any navigation while the tunnel is down destroys the app.** A reload, a
  watchdog reload, Chrome discarding and restoring a backgrounded tab — all of
  them re-fetch `index.html` from a host that is not answering, and the result is
  the browser's `ERR_CONNECTION_TIMED_OUT` page. Not a degraded app: *no* app.
  The send queue, the compose drafts, the prompt pad and the cached transcripts
  are all still in localStorage, and all of them are unreachable because the code
  that reads them is gone.
- **The service worker that would cache a shell against this cannot exist**, in
  the common configuration. Service workers need a secure context, and plain
  `http://100.x.y.z:8770` is not one. Fixing that means `tailscale serve --https`,
  a setup step people skip, and one that competes for port 443 on the machine.
- **Background Fetch (auto-download's engine) needs the same secure context** —
  plus an installed PWA, plus Chromium.

`web/ws.ts` already contains an elaborate mitigation for this: before its
last-resort reload it probes `/api/health` *twice* when no service worker
controls the page, precisely because reloading into a dead tunnel is
unrecoverable. That workaround is evidence of the shape of the problem, not a
fix for it.

Inside the APK the shell is a local asset. There is no navigation left that can
fail, the origin (`http://localhost`) is a secure context whether or not
`tailscale serve` was ever run, and a cold start with the network fully off
lands in the working app.

---

## Why Capacitor, and why *not* Ionic

The starting suggestion was Ionic. That is two different products, and the
distinction decides the whole design:

| | What it is | Cost here |
|---|---|---|
| **Ionic Framework** | A UI component library (`ion-*` components, its own router, its own navigation model) | Would mean **rewriting the entire UI** — ~30 sheets, the xterm.js terminal host, the gallery, the annotator, the queue. Reimplementation by another name. |
| **Capacitor** | The native runtime *by the Ionic team*: a WebView shell that loads a web build out of the app bundle and exposes native APIs to it | **Zero UI changes.** It ships `packages/web/dist` verbatim. |

So: Capacitor, no Ionic Framework. That is what "use Ionic to avoid a Kotlin
rewrite" means once the two halves are separated — the runtime is the part that
avoids the rewrite; the component library is the part that *is* one.

Rejected alternatives:

- **Bubblewrap / Trusted Web Activity.** The obvious "just wrap the PWA" answer,
  and it fixes nothing: a TWA *is* Chrome, with Chrome's storage, Chrome's
  secure-context rules and Chrome's navigation. The shell still comes over the
  tunnel and a dead tunnel still yields the error page.
- **React Native / Kotlin.** A full rewrite of a large, subtle UI whose hardest
  parts (offline send queue, resumable pulls, PTY replay) are already written and
  tested.
- **A hand-written WebView host.** That is Capacitor, minus the maintenance.

---

## How it is wired

```
┌─ APK ──────────────────────────────────────────┐
│  WebView @ http://localhost   (secure context) │
│    └── packages/web/dist, straight from assets/│──── no network ────
│                                                │
│         fetch("/api/…")  ──rewritten──►  http://100.x.y.z:8770/api/…
│         new WebSocket()  ──rewritten──►  ws://100.x.y.z:8770/ws
└────────────────────────────────────────────────┘
```

**`androidScheme: "http"`, not Capacitor's `https` default.** Two reasons, both
load-bearing:

1. `http://localhost` is still a *secure context* — browsers treat localhost as
   potentially trustworthy — so service workers, clipboard and install APIs work.
2. A page on `https://` **may not open a `ws://` socket**. Mixed-content blocking
   applies to WebSockets regardless of the WebView's mixed-content setting, and
   the daemon's normal address is plain `ws://100.x:8770/ws`. An `https` scheme
   here breaks the one connection the entire app is built on.

**The URL rewriting is in the web layer, not in native code.** `shared/hosturl.ts`
holds the rules (pure functions, pinned by `scripts/e2e-hosturl.mjs`);
`web/hostUrl.ts` patches `fetch`, `XMLHttpRequest.open` and `sendBeacon` once at
boot. Patching the transports rather than editing ~60 call sites means a
`fetch("/api/…")` written next month is correct in the APK on the day it is
written. The two URL kinds that never pass through a transport — strings handed
to `<img src>` and to Background Fetch — call `abs()` explicitly.

A native `shouldInterceptRequest` proxy was considered and rejected: it cannot
see request bodies, so every upload and POST would break.

**No host-side change was needed.** The shell's origin is `http://localhost`,
which `host/origin.ts` already allows (`localhost` is in the host set, 80 is in
the port set). The same-origin guard was not widened for this.

**Only `/api` and `/ws` are ever re-aimed.** Everything else — `/`, `/assets/*`,
`/sw.js`, icons — stays local by construction. Rewriting them onto the host would
put the app straight back into the failure it exists to fix, so the allowlist is
in `shared` with a test around it rather than in a comment.

---

## Verified

On an Android emulator against the live daemon (`100.64.0.5:8770`):

1. First launch → pairing screen; typed `100.64.0.5`; the field shows the
   normalised `http://100.64.0.5:8770` as you type.
2. **test** → `daemon found — root /Users/me/dev`. Cross-origin GET from
   `http://localhost` passed the same-origin guard untouched.
3. **connect** → full launcher, WebSocket `open · 100.64.0.5`, 15 live
   sessions, usage meter, notifications.
4. **Airplane mode on, app force-stopped, cold start** → the complete UI renders
   from the APK with the session list restored from its snapshot and an honest
   `closed` status. This is the case that produces a browser error page in the
   PWA.
5. Airplane mode off → reconnected on its own, live counts resumed.

And the over-the-air loop, with **no APK reinstall at any point**:

6. Changed a heading in the web UI, ran `npm run build` on the desktop only. The
   panel went from `running 441dd0f8… · up to date` to `running 441dd0f8… · host
   has 5c172032…`, downloaded and verified all 11 files, and reported
   *"build 5c172032… downloaded and verified — it starts the next time the app
   does"*.
7. Tapped *restart into it* → the changed heading was on screen and the panel
   read `running 5c172032… · up to date`.
8. Reverted the change, rebuilt, then just force-stopped and cold-started the app
   twice with no taps at all. `run-as` on the device confirms one bundle
   directory (`48d5a2d4ff713f9f`, matching the host), Capacitor's
   `serverBasePath` pointing at it, the superseded bundle pruned, and
   `bootFails=0` — i.e. the watchdog saw the new bundle report healthy.

Screenshots and the built APK: `.claude/outbox/android-apk/` — the repo's
phone-facing outbox, which is gitignored, so open them in the app's own gallery
rather than looking for them in a clone.

### Branding

The launcher icon, the adaptive-icon plate and the splash are generated from the
app's own `packages/web/public/assets/icon-512.png` with `ffmpeg` (no image
library added — the same "shell out to what the platform already ships" rule
`host/thumbs.ts` follows), and the native theme is pinned dark so the launch
window and system bars stop flashing Capacitor's default white at a black app.
The adaptive foreground is drawn at 86/108 of the canvas rather than the usual
66/108 safe zone: the source artwork is already a rounded-square badge with its
own margin, so the standard rule padded it twice and the glyph came out visibly
small inside the launcher's circle.

---

## The UI updates itself — you do not push APKs

Carrying the UI inside the APK is what makes it survive a dead tunnel. Left
alone it would also *freeze* the UI at APK build time, which is the wrong half of
that trade: the shell is what must be local, not the version of it.

So the app updates its own web bundle from the daemon:

```
web change  →  npm run build      (or npm run restart)
                    ↓
        daemon publishes /api/webbundle  ← build id + per-file sha256
                    ↓
        app checks on launch (and every 30 min), downloads, verifies
                    ↓
        staged  →  starts on the next launch  (or "restart into it" now)
```

**You only need a new APK when this package changes** — the Java, the manifest,
the icons. Web-only changes reach the phone by themselves.

Details that are deliberate:

- **The build id is a content hash** (`dist/build-id.txt`, from the web build's
  `buildStamp` plugin), not a timestamp. `npm run restart` rebuilds constantly,
  and an id that moved every build would have the phone re-downloading ~1 MB over
  a roaming link to arrive at a byte-identical bundle. Identical sources ⇒
  identical id ⇒ no download.
- **`build-id.txt` ships inside the bundle**, so "which build am I running?" is
  answered by reading a file out of whatever bundle is being served — APK or
  download — instead of by bookkeeping that can drift from reality.
- **Every file is sha256-checked before anything is replaced**, and a mismatch
  aborts the whole update rather than landing a bundle mixed from two builds.
  This protects against a truncated transfer, *not* against a hostile host: the
  daemon already runs `claude` on your machine (SECURITY.md), and the bundle only
  ever comes from the host you paired with.
- **Nothing is applied under your feet.** A finished download is staged for the
  next launch. This is a remote control for live sessions; reloading the page
  mid-turn for an update nobody asked for is worse than waiting.
- **localStorage and IndexedDB survive an update** — the origin is
  `http://localhost` either way — so the send queue, drafts, the paired host and
  cached transcripts all carry across.
- **Installing a new APK wins.** The shell drops the stored bundle path when the
  APK's install time changes (`ShellUpdatePlugin`, `apkInstalledAt`), so a
  sideloaded build is never shadowed by an older download. Capacitor's own
  version of this keys on `versionCode`/`versionName`, which `build.gradle` never
  changes — so it never fired, and reinstalling was no way out of a bad bundle.

### If a bundle is bad

Recoveries, none needing the network:

1. **A deadline per page load.** A page served from a downloaded bundle has 15 s
   of *on-screen* time to call `markHealthy` (the web app does so from its first
   committed render, before pairing or any network). If it does not, the shell
   switches to the bundle inside the APK there and then — no relaunch needed —
   and says so in a toast. Time in a pocket does not count, because the
   auto-restart starts new builds exactly then.
2. **A launch counter.** Every launch increments a counter that the web app
   zeroes once it has rendered. Three launches that never get there and the
   native side drops the stored path before the bridge comes up. A stored path
   whose `index.html` is missing is dropped the same way, at once.
3. **The failed build is remembered.** Without this, falling back did not stick:
   the APK's own bundle asked the desktop what it was serving, got the same
   build, downloaded it and restarted into it the next time the phone was put
   down — a white screen again. `stage`/`applyNow` refuse that build id
   (`BAD_BUILD`) unless the person retries it by hand from Settings → App
   version; the desktop's next *different* build is taken as usual.
4. **Manual.** Settings → App version → *use the build inside the APK*.

The APK's own copy is never deleted, so the floor is always there. These
recoveries live in the native shell, so they need an APK that has them — an
older install keeps only the launch counter.

## Where the system bar ends

The web app fixes a 22 px connection strip to the very top of the viewport
(`NetPulseBar`), so "content starts at y = 0" and "content starts under the
clock and the battery" are the same screen. Which of the two you got used to be
decided by the phone:

- `android:windowOptOutEdgeToEdgeEnforcement` in the theme kept the pre-Android-15
  layout, where the window sits below the bars. It is honoured on Android 15 and
  **ignored on Android 16 for an app targeting SDK 36**, which this one does — so
  one APK laid out one way on one phone and the other way on the next, and on the
  newer phone the strip ran under the status bar.
- Capacitor's own `SystemBars` plugin will pad for you, but only above API 35, and
  only after a probe of the installed **WebView's major version** and of the page's
  viewport meta tag picks between padding the container and passing the insets
  through for `env(safe-area-inset-*)`. Three conditions, two of them properties of
  a component that updates itself out of the Play Store.

So the opt-out is gone and the plugin's inset handling is switched off
(`plugins.SystemBars.insetsHandling: "disable"` in `capacitor.config.ts`).
`MainActivity.takeOverWindowInsets()` puts one `OnApplyWindowInsetsListener` on
the WebView's container and pads it by `systemBars | displayCutout`, replacing the
bottom with the IME inset while the keyboard is up.

- **It does not force edge-to-edge.** Below API 35 the platform still fits the
  window below the bars and hands the listener insets of zero, so it pads by zero
  and that path is exactly what it always was. From API 35 the platform lays out
  edge-to-edge whatever the theme says and the same listener pads by real insets.
  One rule, both worlds.
- **The web layer is untouched.** `calc(env(safe-area-inset-top) + var(--ui-pulse-h))`
  keeps working, with `env()` contributing the 0 it has always contributed here.
  Nothing reads the `--safe-area-inset-*` custom properties the plugin used to
  inject, which is why turning them off costs nothing.
- **A listener, not a measurement**, which is what makes it survive rotation, the
  keyboard, and a switch between gesture and 3-button navigation: all three are
  inset changes and all three re-dispatch.
- `android:windowBackground` is pinned to `#0B0D10`, because edge-to-edge means
  the strip of screen behind the status bar shows *that* — inherited, it is
  AppCompat's dark grey against a near-black app.

`plugins.SystemBars.style: "DARK"` belongs to the same fix. The plugin otherwise
derives the bar-icon appearance from the **phone's** night mode, which is not a
fact about this app — it is dark in either — and on a phone set to light it asked
for dark icons on a near-black bar.

## Back, and the swipe-back gesture

Capacitor 8 registers **nothing** on the activity's back dispatcher, so every
Back — the button, the gesture, and Android 13+'s predictive swipe — took the
platform default and finished the activity. One swipe out of a session left the
app entirely instead of returning to the session list, taking the whole UI down
with it.

`MainActivity.registerBackNavigation()` registers an `OnBackPressedCallback`, and
the WEB side decides:

- **The web decides, not `WebView.canGoBack()`.** The screens the hash cannot
  restore (sheets — queue, pad, files, …) serialize to the same URL as the
  screen under them, so only the web knows they are separate screens; it pushes
  one history entry per screen keyed on `history.state` (`App.tsx`, `routeKey`).
  And the WebView's own history contains the documents an OTA bundle swap
  loaded, so `canGoBack()` is true at the root screen — "back" there would
  reload a retired build rather than leave.
- **Depth 0 is what closes the app.**
- **The depth is PUSHED, because of when the question is asked.** Android 13+ asks
  at the moment the swipe *starts* — while the finger is still moving, before
  anything is committed — whether the app will handle this Back, so that it can
  play either the in-app animation or the one that slides the app away. An answer
  that needs a round trip into JavaScript does not exist yet at that moment. So
  the web reports its depth on every route change through
  `window.ShellAndroidInterface.setBackDepth(n)` (`ShellNavPlugin`), and the
  callback's enabled state is already correct when the gesture begins: enabled
  above 0, **off at 0** so the platform's own Back runs and the app leaves the way
  every other app leaves.
- **The fallback is the old behaviour.** A bundle that never calls `setBackDepth`
  leaves the depth unknown, and the shell asks `window.shellBack()` over
  `evaluateJavascript` behind a 1200 ms deadline. The UI updates over the air and
  the shell does not, so the receiving end has to be able to sit unused until a
  bundle that knows about it arrives. A deadline that expires while the depth is
  *known* to be above 0 is a busy renderer, not a dead one, and drops the press
  rather than closing an app that had somewhere to go.
- **`android:enableOnBackInvokedCallback="true"`** is stated rather than inherited.
  Targeting SDK 36 the platform treats it as on from Android 15 up, but on
  Android 13 and 14 the default is off and Back arrives by the older path. Declaring
  it means one code path on every version.
- **Leaving is `finishAfterTransition()`**, not a second trip through
  `getOnBackPressedDispatcher().onBackPressed()`. Re-entering the dispatcher from
  inside its own dispatch meant disabling the callback for exactly one press and
  re-arming it on `onResume`, and under predictive back that replayed press
  arrives after the system's own back event has already completed.

## Links that would take the app away

The document in this WebView **is** the app. Replacing it is not a navigation,
it is an uninstall for as long as the page is gone — the send queue, the drafts
and the compose box all live in that document.

One shape of link does it in silence. A relative URL — a markdown link in a
transcript, an `<a href>` a sheet renders from host data — resolves against the
shell's own origin, `http://localhost`, which is Capacitor's asset server and
holds only the bundle. Capacitor allows it (same host as the app), the asset
server has nothing at that path, and the app is replaced by a blank 404.

`MainActivity.guardNavigation()` installs a `BridgeWebViewClient` that refuses
any main-frame navigation to our own origin that is not the app document itself,
and names it. A main-frame navigation to a **different** origin does leave — that
is a real link to the outside — but it asks first, with a dialog naming the URL,
because the alternative is the app vanishing on a tap nobody read as "leave".
Sub-frame requests, `blob:` and `data:` keep Capacitor's own behaviour.

Downloads the WebView starts *by itself* used to be discarded in complete
silence — the same failure the save bridge below exists to fix, on the path
nothing in this app controls. `MainActivity.catchDownloads()` hands `http(s)` to
`DownloadManager` and says where the file is going; `blob:` and `data:` cannot be
handed over (they live in the renderer) and are named instead. The one outcome
no longer on offer is nothing happening.

## Saving a file out of the app

A WebView **silently drops** `<a download href="blob:…">`. No listener, no error,
no file — which is what "on phone · save" was, so in the APK the tap looked like
it worked and the file existed nowhere a file manager could reach. A native
`DownloadListener` does not fix it: a `blob:` URL lives in the renderer and
cannot be handed to `DownloadManager`.

So the bytes cross the bridge instead. `web/nativeSave.ts` slices the blob and
`ShellSavePlugin` writes it into the phone's own Downloads:

```
IndexedDB blob ─► slice 512 KiB ─► base64 ─► ShellSave.chunk ─► cache/saves/<token>.part
                                                                       │
                       "Downloads/thing.apk"  ◄── MediaStore ◄── ShellSave.finish
```

- **Sliced, never one call.** Base64 of a 23 MB APK is ~31 MB of JSON string;
  one call peaks at several times that on both sides. A slice at a time is flat
  in the file's size.
- **Assembled in the cache, published at the end.** An interrupted save leaves
  nothing half-written where a file manager would list it as the real thing —
  and on API 29+ the MediaStore row is `IS_PENDING` until the last byte lands.
- **Two publish paths.** API 29+ inserts into `MediaStore.Downloads` and needs
  no permission at all. Below that (`minSdk` is 24) Downloads is a real path
  behind `WRITE_EXTERNAL_STORAGE`, so the permission is declared
  `maxSdkVersion="28"` and only ever requested there.
- **The destination is reported back, not assumed.** MediaStore renames a
  colliding file, so the name it settled on is read back and shown — "saved" with
  no *where* is what this whole path exists to stop.

The browser is untouched: `pull.ts` still uses the anchor click everywhere
`nativeSaveSupported()` is false.

## Downloading a file (`ShellPullService`)

> "Downloads do not continue if I switch to another app — zero progress."

`web/pull.ts` is a complete resumable downloader and in the APK it stopped dead
on backgrounding. **Not the freezer**: with the link service running the process
sits unfrozen indefinitely and the transfer still stops, because **Chromium
freezes the DOCUMENT on its own** — measured on API 34 / WebView 113 at 300 s
after `visibilitychange`, three times out of three, to the second, with timers
running at a dead-on 1/s until that instant. The pump's interval, the retry
timer, both stall fuses and the `fetch` reader loop are all inside it.

So the transfer runs here instead:

```
pull.ts ─► ShellPull.enqueue ─► ShellPullService  ──OkHttp Range──►  daemon
                                     │
              files/pulls/<id>.part ─┴─► .bin ─► Downloads.publish ─► MediaStore
```

- **`dataSync`, not `specialUse`.** The two services are opposite shapes.
  Android 15 caps `dataSync` at ~6 h per 24 h, which is why a permanent
  connection may not use it — and irrelevant to a download, which is bounded and
  measured in minutes. `dataSync` is the type that honestly describes moving a
  file. Its one consequence: Android 15+ refuses a **background start**, so an
  enqueue made while the app is already backgrounded is caught, the row stays
  `queued`, and it runs when the app is next opened. Said in the row, not hidden.
- **Not `DownloadManager`.** It runs in `com.android.providers.downloads` — a
  different app, with its own VPN routing, cleartext policy and metered rules.
  The daemon is reachable because *this* process is inside the Tailscale tunnel;
  handing the URL to another process makes reachability an untestable property
  of a component the user can also disable, and trades every sentence these rows
  say for a status enum and a reason int.
- **The backoff is on disk, not in a handler.** A timer dies with the process, so
  a row whose wait lived only in `postDelayed` comes back runnable immediately
  after a restart — fifty attempts spent in a second against a link that is
  simply down. `nextAt` is persisted with the row and the pump honours it.
- **It stays alive while a retry counts down.** Stopping there would move the
  retry back into the frozen document this service exists to replace. The
  backoff caps at two minutes, so the wait is bounded, and the notification says
  *waiting to retry…* rather than showing a progress bar for nothing.
- **The offset is the file's own length.** No second record of "how much we
  have" that can disagree with the bytes on disk. `Range` + `If-Range`; a 416
  throws the prefix away and starts clean; a 200 answering a ranged request
  truncates rather than appending.
- **A partial file is never published.** Bytes land in `<files>/pulls/<id>.part`
  and are renamed to `.bin` only when the transfer is complete.
- **The bytes never cross the bridge.** The finished file stays in the app's own
  directory; a preview is `Capacitor.convertFileSrc`, and the copy into Downloads
  happens in Java (`Downloads.java`, shared with `ShellSavePlugin` — one
  implementation, because "the file landed and the user was told where" must not
  be worded two ways).
- **Publishing is what a tap promised.** `autoSave` rides on the row; the host's
  own auto-pull rules leave it off, and those files wait for the save button —
  an APK appearing in Downloads unasked is a surprise. Below API 29 the storage
  permission is asked for by `ShellPullPlugin`, which then hands the job back:
  a service cannot show a dialog, and a finished download must not fail over one.
- **The LAN gate's cookie is borrowed** from `CookieManager`, so a gated host can
  still be downloaded from. A 401 is permanent and says to open the app.

`web/nativePull.ts` is the page's side, and it keeps every decision: the queue,
the order, the words, the give-up rule.

## Installing a build (`Installs`, `ShellInstallReceiver`)

The download already ends with a fresh APK sitting in the app's own directory
minutes after the desktop finished building it. What was left was the manual
part: find it in Downloads, tap it, tap through the system installer — once per
build, per app, and there are five Android repos on the desktop this runs
against.

**The platform decides the shape here, not this app:**

- **"Install unknown apps" is a special access.**
  `REQUEST_INSTALL_PACKAGES` is half of it; the rest is a per-app switch only
  the person can turn on. `Installs.canInstall` asks
  `canRequestPackageInstalls()` before any verb is drawn, and
  `Installs.settingsIntent` is what the row offers instead of a button that
  would fail.
- **The first install of a package always shows the dialog.** Nothing removes
  it. The row says so in advance rather than promising otherwise.
- **An update can be silent** — API 31's
  `setRequireUserAction(USER_ACTION_NOT_REQUIRED)` plus
  `UPDATE_PACKAGES_WITHOUT_USER_ACTION`, and from API 34 update *ownership*,
  which `setRequestUpdateOwnership(true)` asks for on the install that does show
  a dialog. Hence the shape: **one dialog per app, ever.**
- **A refused silence is not an error.** It comes back as
  `STATUS_PENDING_USER_ACTION` carrying the same confirmation intent the loud
  path uses, so asking for silence can never cost an install. Every real failure
  — a debug key from another machine, a downgrade — arrives on the same door with
  the platform's own message, which `Installs.failureText` keeps verbatim.

**All of the above is the `dev` flavor.** The `play` build (see *Two flavors*
under Build) declares no `UPDATE_PACKAGES_WITHOUT_USER_ACTION`, never asks for
`USER_ACTION_NOT_REQUIRED` or update ownership (`BuildConfig.QUIET_INSTALLS`),
starts no install by itself (`mayAutoInstall` is false), and refuses in
`Installs.install` — the one door every install goes through — an archive of
its OWN package or one it cannot name (`Installs.refusal`,
`BuildConfig.SELF_UPDATE`). Its ready-to-install notification skips both.

**The package is read from the archive, never from the file name.** Three repos
here all build `app-debug.apk`. `Installs.read` pulls the package, label and
version out of the file at completion; unreadable leaves them empty rather than
guessed.

**The allow-list is the page's, mirrored here.** `web/installPolicy.ts` owns
every decision and the list is synced across the person's phones; the copy in
`SharedPreferences` exists because the install happens at the end of a transfer
in this service, where the document is frozen and a bridge call would never be
answered. `Installs.mayAutoInstall` is deliberately narrower than a tap: access
granted, package on the list, **and already installed** — an unattended first
install would only produce a notification asking for a tap nobody asked for.

**A confirmation that cannot be shown becomes a notification.**
`ShellInstallReceiver` starts the installer directly when the app is in front;
Android refuses a background activity start, so otherwise the same intent rides
on a notification and the row reads *waiting for you to confirm* — never
*failed*.

## Running in the background

> "Until I switch on the phone it was disconnected." · "Our APK is still doing
> nothing if in background."

Backgrounded, this app used to do nothing at all — and not for one reason but
for a chain of them, of which the middle link is the one that matters:

- **No foreground service**, so minutes after backgrounding the process drops to
  the cached bucket and **Android 12+'s cached-app freezer suspends the whole
  process** — JS, timers, socket. `ws.ts` even anticipates its own death: its
  `freeze` handler deliberately closes the socket on the way down.
- **No service worker in the shell** (`main.tsx` gates registration on
  `!isNativeShell()`), so nothing can wake it. And registering one would buy
  nothing for push anyway: **Android System WebView does not implement the Push
  API at all** — `registration.pushManager` does not exist there.

And one fact that shapes the whole design: **Capacitor's `KeepRunning` defaults
to `true`**, so WebView timers are *not* paused when the activity pauses. The JS
dies from the process being frozen, not from Capacitor stopping it. **Keep the
process out of the freezer and the existing web code simply keeps working.**

So: **one permanent, opt-in `specialUse` foreground service**
(`ShellLinkService`) that does two jobs.

1. **By existing**, it keeps the process out of the cached freezer — so the
   WebView's own `ws.ts` socket, `flushOutbox`, upload POSTs and reconnect logic
   keep running in the background, unchanged. This is the whole reason the design
   needs no second protocol implementation.
2. **It holds a deliberately minimal native socket** for the one case the WebView
   can never cover: the app swiped away, process gone — which is exactly when a
   waiting question matters most.

### `specialUse`, never `dataSync` — the landmine

`FOREGROUND_SERVICE_DATA_SYNC` is the obvious type and it is a trap here.
**Android 15+ caps a `dataSync` foreground service at roughly six hours per
24-hour window**, then calls `Service.onTimeout()` and refuses background
restarts. A "permanent connection" built on it quietly stops working overnight —
precisely the failure this app exists to fix. Android 15 also bans starting a
`dataSync` service from `BOOT_COMPLETED`, which would take the recovery path with
it.

`specialUse` has no timeout and is allowed from a boot receiver. It costs a Play
Store policy review, which is zero here: this APK is sideloaded by design. The
manifest declares the subtype honestly — one WebSocket to the user's own
self-hosted daemon on their own private network, delivering that daemon's
notifications. There is no cloud component.

### The native socket speaks three frames, not the protocol

The duplication worry is the right worry, so the split is explicit:

- **The WebView keeps `ws.ts` untouched** — it remains the only speaker of the
  full protocol: attach, `resumeSeq`, acks, ops, the flusher.
- **The service speaks a frozen subset**: send `hello`; keep alive with WebSocket
  *protocol* pings (OkHttp's `pingInterval`, 2 min — the host's ws library
  auto-pongs, so liveness costs no protocol duplication and far fewer radio
  wakeups than `ws.ts`'s 12-second JSON ping); and act on exactly two inbound
  frames — `notification` (post an OS notification) and `authRequired` (stop
  reconnecting, say so). Everything else is ignored, the same rule `main.ts`'s
  dispatcher follows for an unknown `t`.
- **`PROTOCOL_VERSION` and the host address are passed in from the web layer**,
  never compiled into Java: the version ships in the OTA-updating bundle while
  the APK does not update, so a constant would drift, and the address only ever
  lived in the WebView's localStorage.
- **Host cost: zero.** `broadcast()` already sends `notification` frames to every
  socket, and the `notifyprefs` gate already ran before the broadcast. The
  service is just another client.

The rejected extreme — a native client speaking the full protocol — is
duplication this repo spent a day deleting, and it still could not drain
uploads, whose bytes live in the WebView's IndexedDB and are unreachable from
native. **The queue drain stays in the page.**

Also rejected: **FCM** (a Firebase project and Google-routed metadata for a
self-hosted tool on a private tailnet is wrong in kind, not just in taste);
**WorkManager alone** (a 15-minute floor is fine for "drain my queue", useless
for "a question is waiting"); and **an FGS only while work is outstanding**,
because it reintroduces the wake problem — nothing is alive to start the service
when a question lands.

### Notifications, and who posts them

**The service is the only poster of OS notifications**, and it posts none while
the activity is resumed — the WebView has its own in-app feed, and duplicating a
row the user is already looking at is noise.

- The **FGS notification is a status surface, not an alert**: its own
  `IMPORTANCE_MIN` channel, reading "connected · 100.64.0.5" / "reconnecting…"
  / "sign-in needed". (Android floors a foreground-service notification at
  `IMPORTANCE_LOW`; it is still silent and badge-less.)
- **Alerts go to a channel per kind** (`kind.prompt`, `kind.limit`, …),
  so Android's per-channel controls *complement* the host's `notifyprefs` gate
  rather than fighting it: the host decides what may be published at all, the
  phone decides how loudly each kind lands. A kind this APK has never heard of —
  a host newer than the binary — gets its own channel named after itself rather
  than being dropped. `approval` (a plugin's must-approve-now request, e.g. a vault
  fingerprint) is HIGH on its own id `kind.approval.high`, because channel importance
  is immutable and an older APK would have created `kind.approval` at DEFAULT; an alert
  with a `plugin` and no session opens that plugin via `shellOpen("plugin:<id>")`.
- **Replacement is by tag.** `NotificationItem` carries no `tag` field yet (that
  is a separate, additive host+`shared` change), so one is derived here —
  `kind|sessionId`, falling back to the item id — and `item.tag` is preferred the
  moment it starts arriving, so that change needs nothing from the Java side.
- Tapping opens the app with the session id, reaching the same focus path
  `sw.js`'s `notificationclick` takes in the browser.

### The network changed — two jobs on one signal

A `ConnectivityManager.NetworkCallback` reconnects the native socket, and
**nudges the WebView**. `ws.ts` verifies its socket on `visibilitychange`,
`online`, `focus` and `pageshow` — every one of them a viewport event — so a page
that is alive but not on screen when the network flaps gets no signal at all and
sits on a socket whose `readyState` still says OPEN. The nudge is
`window.shellNudge(reason)`, guarded at the call site because the UI updates
over the air and this shell does not.

### Backstop and boot

A foreground service is not immortal: an OEM task killer, a low-memory kill that
outruns `START_STICKY`, a reboot. Two recoveries, neither of which needs the app
to be opened:

- **`ShellBootReceiver`** on `BOOT_COMPLETED` / `LOCKED_BOOT_COMPLETED` /
  `MY_PACKAGE_REPLACED` (the last one for the sideload — installing a new APK
  stops the service).
- **`ShellLinkWorker`**, a 15-minute WorkManager periodic check: is the service up,
  is the socket sane. WorkManager is the only scheduler here that survives
  process death and reboots, and its 15-minute floor is exactly why it is the
  backstop and not the transport.

Both are gated on the stored enabled flag, so on a phone where nobody touched the
toggle they cost a few microseconds at boot and nothing else.

### Opt-in, and inert until it is not

**Nothing starts the service but an explicit `ShellLink.start()` call from the
page.** With the flag unset the boot receiver returns immediately, no periodic
work is scheduled, no channel is created and no notification is posted. A user
who never enables it sees no notification, no service, no battery cost and no
behaviour change.

The **battery-optimisation exemption** is offered, never demanded — and it is not
only about battery: an app the system may doze **cannot start a foreground
service from the background**, which is exactly what the boot receiver and the
periodic check do. Without it the worst honest case is the socket stalling
between Doze maintenance windows and the backstop reconnecting during each one:
"a notification within the next maintenance window", minutes to tens of minutes
overnight. **Never "silently never."**

### The plugin surface

`ShellLinkPlugin`, reached off `Capacitor.Plugins.ShellLink` — no npm import, the
same way `webUpdate.ts` and `nativeSave.ts` reach theirs. `web/src/shellLink.ts`
is the typed wrapper.

| call | what it does |
|---|---|
| `isSupported()` | `{supported, notifications, batteryExempt}` |
| `status()` | `{enabled, running, state, host, queueDepth, connectedAt, lastFrameAt, error, notifications, batteryExempt}` |
| `start({url, protocol, label})` | persist + start. `url` is `wsUrl()`, `protocol` is `PROTOCOL_VERSION` |
| `stop()` | stop, cancel the periodic check, forget the flag |
| `setQueueDepth({depth})` | how many sends the page is holding (see below) |
| `requestNotifications()` | `POST_NOTIFICATIONS`; a refusal is **not** fatal |
| `requestBatteryExemption()` | opens the Settings screen (not the direct-grant dialog) |

And two globals the shell calls into, both optional at the far end:
`window.shellNudge(reason)` and `window.shellOpen(sessionId)` —
`shellLink.ts` installs them and re-emits each as a `window` event, so `ws.ts`
and `App.tsx` need no import from it.

**The residual gap, stated:** app swiped away with prompts queued offline. The
page reports its queue depth on each outbox write; after a process death, when
the service's socket reconnects and the persisted count is non-zero, it posts
*"N prompts waiting — open to send"*. The prompts are safe either way; this turns
"sits until you next open the app" into "the phone tells you the moment sending
would work."

### What was measured, and what a real device still settles

On an **API 34 emulator** (Android 14, WebView 113), against a stub daemon over
`adb reverse`:

- **The WebView is not throttled at all under the FGS.** `ws.ts`'s 12-second
  heartbeat kept firing at 12.0 s ± 0.05 s for the whole soak, backgrounded, with
  the screen off — no stretch toward the 1/min the design feared. The native
  nudge is therefore *insurance*, not the thing that makes this work.
- **The service is `specialUse`**: `dumpsys` reports `types=40000000`
  (`FOREGROUND_SERVICE_TYPE_SPECIAL_USE`), `isForeground=true`.
- **Dedupe works both ways**: nothing posted while resumed, one tagged
  notification on `kind.prompt` when backgrounded.

**Only a real device settles**: overnight Doze latency *through Tailscale* (the
emulator has no tailnet, so a forced-Doze test measures Doze and not the
WireGuard-tunnel question), OEM task killers, battery cost per day, and a
genuinely bad link.

## Which network, and pairing links (`ShellNetPlugin`, `waterplane://pair`)

Two inputs the multi-host LAN route needs and a WebView cannot produce.

### `ShellNet` — the transport and the Wi-Fi name

The page picks, per host, between its LAN address and the tailnet
(`shared/lanroute.ts`); one gate is "this phone is on a Wi-Fi saved for that
host". A browser has no API for the Wi-Fi name, so the shell reads it.

| call | what it does |
|---|---|
| `current()` | `{transport: 'wifi'\|'cellular'\|'other'\|'none', ssid: string\|null, permission: 'granted'\|'denied'\|'prompt'}` |
| `requestLocation()` | asks for `ACCESS_FINE_LOCATION`, resolves with the same shape after the answer; never rejects |

and a push: **`window.shellNetChanged(state)`** with that same object,
debounced 500 ms (a Wi-Fi hand-over is a burst of lost/available/capabilities)
and sent only when the state differs from the last one sent. The plugin keeps
its own default-network callback for as long as the bridge lives —
independent of `ShellLinkService`'s, which exists only while the background link
is on. Guarded at the call site like every other push, so an older bundle is
no worse off.

`ssid` is `null` whenever it is not known: not on Wi-Fi, permission not
granted, the system location switch off, or the platform answering
`<unknown ssid>`. Quotes Android wraps a name in are stripped. On API 31+ the
name only exists in the `WifiInfo` of a callback registered with
`FLAG_INCLUDE_LOCATION_INFO` (`getNetworkCapabilities()` returns a redacted
copy), so the plugin caches its callback's last capabilities and re-registers
after a grant; below 31 it reads `WifiManager.getConnectionInfo()`.

**Why a location permission.** Android classes a Wi-Fi name as location — a
list of nearby SSIDs places a phone as well as GPS does — so reading it
requires `ACCESS_FINE_LOCATION` (and `ACCESS_WIFI_STATE` below API 31). It is
asked for only through `requestLocation()`, from the page's explicit "allow"
button. The name is used for one thing: comparing, on the phone, with the
network names saved for each host. **It is never sent anywhere** — not to a
host, not to anyone. Refusing it costs only the automatic LAN switch; the
tailnet route keeps working.

### `waterplane://pair?u=<base>&c=<code>` — the pairing deep link

The host's `/pair/<code>` landing page links here after the APK is installed.
`MainActivity` has a `VIEW`/`BROWSABLE` intent filter for scheme `waterplane`, host
`pair`; the link arrives in `onCreate` (cold) or `onNewIntent` (`singleTask`,
live) and is handed whole to **`window.shellPair(url)`**. Like
`shellOpen`, it is **parked**: retried every 500 ms for up to 20 s until the
page's function returns truthy, because a cold start reaches `onResume` long
before the bundle has installed its global. The intent's data is consumed so a
rotation does not re-deliver it.

**Any app or web page can fire this link.** The shell does no validation beyond
scheme and host; the page parses it (`shared/pairing.ts`) and asks the person
before adopting a host — a suggestion, never a command.

`MainActivity.callWindow(fn, jsonArg)` is the one helper every fire-and-forget
push goes through (`shellNudge`, `shellNetChanged`); the parked calls
(`shellOpen`, `shellPair`) share one `ParkedCall` retry loop.

## Biometric keystore (`ShellKeystorePlugin`)

A key on the phone that only a fingerprint can use. Generic: it wraps and
unwraps bytes and knows nothing about what they are for — any meaning (a vault,
a token) lives in whoever calls it. Typed wrapper: `web/src/nativeKeystore.ts`,
exported from `web/src/sdk`. Needs a new APK (`USE_BIOMETRIC`,
`androidx.biometric:biometric:1.1.0`); an older shell has no `ShellKeystore`
and `nativeKeystore.available()` is false.

| call | what it does |
|---|---|
| `status()` | `{hardware, enrolled, strongBox}` from `BiometricManager.canAuthenticate(BIOMETRIC_STRONG)` |
| `has({alias})` | `{exists}` |
| `generate({alias, strongBox?, replace?})` | AES-256-GCM in the Keystore, StrongBox when present (else TEE) → `{strongBox}`; refuses an existing alias without `replace` |
| `wrap({alias, dataB64, aadB64?, title?, subtitle?})` | one fingerprint → `{ctB64, nonceB64}` (Keystore-chosen nonce, tag inside `ct`) |
| `unwrap({alias, ctB64, nonceB64, aadB64?, title?, subtitle?})` | one fingerprint → `{dataB64}` |
| `remove({alias})` | deletes the key |

The key is per-use bound to a STRONG biometric (`setUserAuthenticationParameters(0,
AUTH_BIOMETRIC_STRONG)` on API 30+, validity `-1` below) and invalidated by a new
enrolment. Every `wrap`/`unwrap` is a `BiometricPrompt` with a `CryptoObject`;
no PIN fallback. Refusals carry one word in `code`: `noHardware`, `noneEnrolled`,
`keyInvalidated`, `noKey`, `exists`, `cancelled`, `lockout`, `busy`, `badInput`,
`failed` (plus `unavailable` from the wrapper when there is no plugin).

**Manual test on a device** (remote-debug the WebView from `chrome://inspect`, console):

```js
const K = Capacitor.Plugins.ShellKeystore;
await K.status();                                   // hardware/enrolled true on a phone with a fingerprint
await K.generate({alias: "t"});                     // {strongBox: true|false}
await K.generate({alias: "t"}).catch(e => e.code);  // "exists"
const w = await K.wrap({alias: "t", dataB64: btoa("hello"), aadB64: btoa("x"), title: "Test"});  // fingerprint
atob((await K.unwrap({alias: "t", ...w, aadB64: btoa("x")})).dataB64);                            // "hello"
await K.unwrap({alias: "t", ...w, aadB64: btoa("y")}).catch(e => e.code);                         // "badInput"
await K.wrap({alias: "t", dataB64: "AA=="}).catch(e => e.code);  // tap Cancel → "cancelled"
// enrol another fingerprint in Settings, then: wrap → "keyInvalidated"
await K.remove({alias: "t"}); await K.has({alias: "t"});        // {exists: false}
```

## Permissions, and what each one is for

The manifest is long for an app that shows a terminal, and read cold it looks like a lot of reach.
Here is every line with the feature behind it. Two facts frame the list:

- **The app talks to one address: the desktop you enter or pair with.** There is no waterplane
  server, no Google Play Services or Firebase in the build, and no analytics. The UI it runs comes
  from inside the APK or from your own desktop's update (see *The UI updates itself*), never from us.
- **Nothing that prompts is asked for at first launch.** Each runtime permission is requested when
  you turn on the feature that needs it. Deny it and that feature says why it is off; the rest of the
  app works.

**Asked at run time, when you use the feature**

| permission | feature | asked when | if you say no |
|---|---|---|---|
| `POST_NOTIFICATIONS` | a waiting question, a usage limit or a finished build reaches you while the app is closed; download progress | you switch on the background link | the link and downloads still run; you see nothing until you open the app |
| `RECORD_AUDIO` (+ `MODIFY_AUDIO_SETTINGS`, no prompt) | push-to-talk dictation | your first press on the mic | dictation says the app has no microphone permission; typing is unaffected |
| `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION` | reading the **Wi-Fi name**, which Android counts as location, so the app can switch to a desktop's LAN address at home | you turn on LAN switching for a desktop | the LAN route never auto-selects; Tailscale is used. The name is compared on the phone and never sent anywhere. No GPS, no location history |
| `WRITE_EXTERNAL_STORAGE` (Android 9 and older only) | saving a downloaded file into Downloads | your first save | the file stays in the app. Android 10+ needs no permission for this and is never asked |

**Switches only you can flip in Android Settings**

| permission | feature | note |
|---|---|---|
| `REQUEST_INSTALL_PACKAGES` | installing an APK **your own repo** just built on your desktop (the build sheet's *install*) | inert until you allow *install unknown apps* for this app. Every install shows Android's own confirm dialog, except as below |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | letting the background link restart after Doze or a reboot | offered on a Settings screen, never the direct-grant dialog. Without it notifications arrive at the next Doze window instead of at once |

**Granted at install, no prompt**

| permission | feature |
|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE` | reaching your desktop; noticing the network changed so the link reconnects; the Wi-Fi name on Android 11 and older |
| `FOREGROUND_SERVICE`, `_SPECIAL_USE`, `_DATA_SYNC` | the background link (one WebSocket to your desktop) and the download engine. Each shows its own ongoing notification while it runs, and the link runs only after you switch it on |
| `RECEIVE_BOOT_COMPLETED` | restarting the background link after a reboot. It does nothing unless you switched the link on |
| `USE_BIOMETRIC` | a fingerprint-locked key for an extension's secrets (`ShellKeystorePlugin`). The public build's own screens never call it |
| `UPDATE_PACKAGES_WITHOUT_USER_ACTION` (**`dev` flavor only**) | after the first confirmed install of an app, its later builds update without a dialog (the README's *other phones install it by themselves*). The `play` build does not declare it |

**Not a permission, but visible:** `<queries>` for launcher activities lets the app see which
apps with a home-screen icon are installed. It is used for one question: whether the build you are
about to install is already on the phone (a first install versus an update). It is narrower than
`QUERY_ALL_PACKAGES`, and the list is never sent anywhere.

**The flavors differ only in installing:** `dev` may update itself from a downloaded APK and may
update other apps quietly; `play` does neither. The permissions are otherwise identical. Details
under *Two flavors* below.

## Build

Requires a JDK 21 and an Android SDK (`compileSdk 36`).

```bash
cd packages/app
npm install                     # once — deliberately NOT a root workspace, see below

export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
echo "sdk.dir=$HOME/Library/Android/sdk" > android/local.properties

npm run apk                     # builds packages/web, cap sync, gradle assembleDevDebug
npm run install-apk             # the above + adb install -r (app-dev-debug.apk)
npm run apk:dev-release         # assembleDevRelease — dev flavor, release build type
npm run apk:play-debug          # assemblePlayDebug — the Play build, debug-signed, for testing
npm run aab:play                # bundlePlayRelease — the AAB uploaded to Google Play
npm run open                    # Android Studio
```

### Two flavors: `dev` and `play`

One codebase, two distributions, **two different signing keys**:

| | `dev` | `play` |
|---|---|---|
| applicationId | `dev.waterplane.app.dev` | `dev.waterplane.app` (permanent once uploaded) |
| launcher label | waterplane dev | waterplane |
| who it is for | the owner's own phone, sideloaded | everybody, through Google Play |
| shell updates itself from a downloaded APK | yes | **never** — refused natively (`Installs.refusal`); the page says *this build updates through Google Play* |
| quiet updates of other apps (`UPDATE_PACKAGES_WITHOUT_USER_ACTION`, `USER_ACTION_NOT_REQUIRED`, update ownership) | yes (`src/dev/AndroidManifest.xml`) | **never** — not declared; every install shows the system's confirm dialog; auto-install is unavailable and the page says why |
| signed with | `keystore-dev.properties` if present, else `DEV_STORE_FILE` & co. in the environment, else the debug key | release: the Play **upload** key (build fails without it); debug: the debug key |
| output | `app/build/outputs/apk/dev/{debug,release}/app-dev-*.apk` | `app/build/outputs/bundle/playRelease/app-play-release.aab` |

The flavor reaches the page at **run time**: `ShellInstall.status()` answers
`distribution: "dev" | "play"` and `self` (its own package). The web bundle is
shared by both and updates over the air, so it asks the shell instead of being
built per flavor; a shell older than the field says nothing, and the page then
keeps today's full behaviour (absent means inherit).

**Keys.** Both properties files sit in `packages/app/android/` and are
gitignored, as is every `*.jks` / `*.keystore`:

```properties
# keystore-dev.properties (the owner's own key) — same shape for keystore-play.properties
storeFile=/Users/you/keys/waterplane-dev.jks   # relative paths resolve against packages/app/android
storePassword=…
keyAlias=…
keyPassword=…
```

Either key can come from the environment instead of a file (the properties file
still wins when it exists):

| key | Gradle properties (`-P…` or `ORG_GRADLE_PROJECT_…`) | plain env |
|---|---|---|
| dev | `devStoreFile`, `devStorePassword`, `devKeyAlias`, `devKeyPassword` | `DEV_STORE_FILE`, `DEV_STORE_PASSWORD`, `DEV_KEY_ALIAS`, `DEV_KEY_PASSWORD` |
| Play upload | `playUploadStoreFile`, `playUploadStorePassword`, `playUploadKeyAlias`, `playUploadKeyPassword` | `PLAY_UPLOAD_STORE_FILE`, `PLAY_UPLOAD_STORE_PASSWORD`, `PLAY_UPLOAD_KEY_ALIAS`, `PLAY_UPLOAD_KEY_PASSWORD` |

A store file set without the other three stops the build naming the missing
ones, and a store file that is not a regular file stops it too — never a value
in a message. `bundlePlayRelease` / `assemblePlayRelease` without any Play key
stops with a message naming all of this — never an unsigned artifact.

**Keys from the vault (`wp-secret`, the private vault extension).** No key or
password then sits on disk in clear: the keystore and its passwords are vaulted,
and released per build with a fingerprint on the phone.

```bash
# once: store them (one fingerprint each), with the lease policy you want
wp-secret put waterplane-dev-jks --kind file --file ~/keys/waterplane-dev.jks --label "dev signing key" --lease 8h
wp-secret put waterplane-dev-store-pw --label "dev keystore password" --lease 8h
wp-secret put waterplane-dev-key-pw --label "dev key password" --lease 8h
wp-secret put play-upload-jks --kind file --file ~/keys/play-upload.jks --label "Play upload key" --no-lease
wp-secret put play-upload-store-pw --no-lease
wp-secret put play-upload-key-pw --no-lease

# a dev release build: one fingerprint, then 8 h of builds from this folder without asking
DEV_KEY_ALIAS=waterplane-dev wp-secret exec --as-file DEV_STORE_FILE=waterplane-dev-jks --as-tmpfile \
  --secret DEV_STORE_PASSWORD=waterplane-dev-store-pw --secret DEV_KEY_PASSWORD=waterplane-dev-key-pw \
  -- npm run apk:dev-release

# the Play bundle: never kept, so every build asks
PLAY_UPLOAD_KEY_ALIAS=upload wp-secret exec --as-file PLAY_UPLOAD_STORE_FILE=play-upload-jks --as-tmpfile \
  --secret PLAY_UPLOAD_STORE_PASSWORD=play-upload-store-pw --secret PLAY_UPLOAD_KEY_PASSWORD=play-upload-key-pw \
  -- npm run aab:play
```

An alias is not a secret: set it plainly in front of `wp-secret`, whose
environment the command inherits (not `-- env NAME=… npm …`: a lease is keyed to
the command's basename, and `env` would be one key for every command). Without
`--ttl` each secret is kept as its own policy says — the dev lease is keyed to
`npm`, this folder and this tmux pane, so any `npm …` asking for those ids there
gets them for 8 h; revoke it from the phone when done. `wp-secret policy <id>
--lease 8h` / `--no-lease` changes a policy later without re-entering the value
(one fingerprint).

Why this works with Gradle:

- **`--as-file … --as-tmpfile`, never `--as-file` alone.** Gradle opens the
  keystore more than once (validating the signing config, then signing each
  output). With `--as-tmpfile` the file is a regular 0600 file in a 0700 temp
  dir, deleted when the command exits; a bare `--as-file` is a FIFO, which the
  build refuses by name.
- **The Gradle daemon gets the environment per build.** `./gradlew` is a client;
  it hands its own environment to the (possibly long-running) daemon with every
  build, so a daemon started earlier still sees this build's `DEV_STORE_FILE`
  and passwords, and the next build without `wp-secret exec` does not. The
  values are read at configuration time; the configuration cache is off here (Gradle's
  default; `android/gradle.properties` does not enable it) — turning it on would write those inputs into
  `android/.gradle/configuration-cache/`, so keep it off for signed builds.

What vaulting buys, honestly: the **debug** keystore's password is public
(`android`) and its key signs nothing anyone trusts — vaulting it buys nothing.
The owner's **dev** key matters because the `dev` shell **updates itself** from a
downloaded APK: whoever holds that key can build an update the owner's phone
accepts as the same app. Hence a long lease for it (a working day of builds,
one fingerprint) but no file on disk; and **never kept** for the Play upload key
(a lost one is a Play support case) — every Play build asks.

**Once you sign `dev` with your own key, keep it.** A build signed with the debug
key cannot update one signed with yours (and the reverse), so a second machine
without `keystore-dev.properties` produces a `dev` build your phone refuses as an
update.

### Attaching the dev APK to a release

The sideloadable APK reaches release users as a release asset the pairing page links
(`pair.ts` `releaseApkUrl`). Build it first, then hand the finished file to the release build:

```bash
npm run apk:dev-release        # app/build/outputs/apk/dev/release/app-dev-release.apk
npm run release:build -- --apk=packages/app/android/app/build/outputs/apk/dev/release/app-dev-release.apk
```

The file is copied to `dist-release/<slug>-<version>.apk` (`releaseApkName` in `shared/brand.ts`, the
same rule `releaseApkUrl` resolves) and named in `release.json`. Upload it with the other assets.
Before copying, `scripts/release/apk-lib.mjs` reads the APK's applicationId (`apkanalyzer`/`aapt` if
on PATH, else it parses the binary manifest itself) and **refuses anything but the dev flavor**
(`<appId>.dev`). A play-flavor APK is rejected by name; an APK it cannot read fails the release
rather than being attached unchecked. The step never runs gradle or reads a keystore.

### One-time migration: `dev.waterplane.app` → `dev.waterplane.app.dev`

Until this split the owner's dogfood app WAS `dev.waterplane.app`. That id now
belongs to the Play build, and the dogfood build is `dev.waterplane.app.dev` — a
**new, side-by-side install** whose WebView storage starts empty (storage is per
app; nothing here tries to copy it). Once, before switching:

1. In the OLD app, empty the send queue and finish or copy out any drafts and
   pad notes — they live in that app's localStorage and do not move.
2. Install `app-dev-debug.apk` (`npm run install-apk`, or the pairing page's
   download), pair it with the desktop. Synced settings re-sync from the host on
   connect; the auto-install allow-list is a synced setting too.
3. Re-grant what is per app: *install unknown apps*, notifications, the
   background link, battery exemption, location for the Wi-Fi name.
4. Uninstall the old `dev.waterplane.app`. Until you do, both answer the
   `waterplane://pair` link and Android asks which one.

Apps the old shell first-installed stay owned by `dev.waterplane.app` for
quiet updates (update ownership follows the FIRST installer): after it is gone,
each asks once more on its next update from the new shell — or uninstall/
reinstall it from the new shell for quiet updates again.

`npm run sync` always rebuilds `packages/web` first (`packages/app/scripts/build-web.mjs`) —
`cap sync` copies `webDir` with no idea whether it is current, and an APK built
from a stale `dist` costs an afternoon of confusion on a phone.

**Not a root workspace, on purpose.** Adding it would put Capacitor's
dependencies into every `npm install` — including CI, which builds the host and
runs the e2e suite and has no interest in an Android toolchain. It has its own
`.npmrc` (ignore-scripts, release-age cooldown) because the root one does not reach it.

### Dependency verification (a tampered Maven artifact fails the build)

`android/gradle/verification-metadata.xml` pins a sha256 for every artifact the
build resolves (plugins and buildscript included). `verify-metadata` is on;
`verify-signatures` is off — checksums only, so there is no trusted-keys file to
maintain. A mismatch fails the build with "Dependency verification failed".

After bumping AGP, Capacitor, `variables.gradle` or any dependency, regenerate
(run `npm run sync` first so `capacitor-cordova-android-plugins` exists):

```bash
cd packages/app/android
./gradlew --continue --write-verification-metadata sha256 \
  help assembleDebug assembleRelease lintDebug lintRelease \
  testDebugUnitTest testReleaseUnitTest :app:dependencies :app:buildEnvironment
git diff gradle/verification-metadata.xml   # read it: only the bumped coordinates should change
```

(`--continue` because `lintDebug` currently reports errors; the metadata is
still written.) **A verification failure means: regenerate if you bumped
something, investigate if you did not** — an unchanged coordinate with a new
hash is exactly what a tampered or republished artifact looks like.

---

### To rebrand

The shell's identity is generated from `packages/shared/src/brand.ts` — edit `appId`,
`displayName`, `name` and `pairScheme` there, then:

```bash
npm run build:shared && npm run brand:android   # from the repo root
```

`scripts/brand-android.mjs` rewrites `capacitor.config.ts` (appId, appName),
`android/app/build.gradle` (namespace, applicationId), both `strings.xml` (labels; the dev
flavor's is `<displayName> dev`), the manifest's pairing scheme, and the Java package: it moves
`src/main/java/<appId as dirs>/` and fixes every `package`/`import` line and `<appId>.…` intent
action. The `.dev` flavor suffix stays, so `dev` and `play` keep distinct ids. It is idempotent;
`--check` exits non-zero if anything would change, and `npm run test:unit` runs it that way, so
a hand edit that drifts from `BRAND` fails. It never touches keystores or signing. Not generated:
prose in comments and this README, and a new `appId` is a new app to Android and to Play — see
the one-time migration note above for what that costs an installed phone.

## Known limits

- **Verified on emulators for API 34, 35 and 36** — insets in portrait, both
  landscape orientations, with the soft keyboard up, and in gesture and 3-button
  navigation; Back and the predictive edge swipe unwinding one screen at a time
  and leaving only at depth 0; and the download button reaching
  `/sdcard/Download` with the name taken from the `path` query parameter. On
  API 34 the platform still fits the window, so the listener pads by zero and
  nothing moved — a regression pass, not a confirmation.

  **One thing a real phone still settles.** On Android 16 the old build's bug is
  gated by Capacitor's `SystemBars`, which only hands insets to the page when the
  installed WebView's major version is ≥ 140 — and every system image available
  here ships 113, 124 or 133. So on a stock API 36 emulator the *old* build looks
  correct, and the bug only appears once that gate is forced. Forcing it does
  show the strip drawn over the clock and battery, and shows the current build
  unaffected (screenshots in `.claude/outbox/android-api36/`), which is the
  commit's claim exactly: the old behaviour was decided by a Play-Store-updated
  component. What it does not prove is how a genuine WebView ≥ 140 behaves, since
  Chromium's own safe-area fix — the reason that gate exists — may resolve
  `env()` there.

- **The navigation guard's two dialogs are verified on API 34, not on 36.** A
  relative in-shell href is refused and named; an outward origin asks first.

- **The LAN password gate does not work in the APK.** The auth token is an
  httpOnly `SameSite=Lax` cookie (`host/auth.ts`), and `http://localhost` →
  `http://100.x:8770` is cross-site, so the browser withholds it. Rewritten
  fetches already ask for `credentials: "include"`; making it work needs the
  token carried in a header instead, which is a host change. Unaffected on the
  normal Tailscale path, where the gate is off.
- **Web Push does not reach the APK** — Android System WebView does not
  implement the Push API at all. The fix is not FCM: the app holds its own
  WebSocket open in a `specialUse` foreground service and raises local
  notifications, which needs no Google dependency and works on a tailnet-only
  setup. See *Running in the background* above. **Built, and off until you
  switch it on** — the settings toggle that switches it on is not written yet,
  so today the only thing that starts it is a direct
  `Capacitor.Plugins.ShellLink.start(…)` call.
- **Saving a downloaded file works now** (see above) — it did not, silently, for
  as long as the shell existed. **Downloads still run in the WebView.** `web/pull.ts`'s chunked Range loop
  works (and resumes), but it stops when Android freezes the app. A native
  downloader in a foreground service would make an APK-sized pull survive the
  screen going off. Not built yet.
- **Status-bar icon tint** — fixed. The bar is dark and the icons were dark on
  top of it: the clock, the signal and the notification icons were invisible and
  the only thing left of the battery was its coloured fill, with the outline and
  the percentage gone. Both the theme attribute and the runtime
  `setAppearanceLightStatusBars(false)` said "light icons"; the appearance is a
  property of the window's insets controller and it is re-derived after
  `onCreate` returns, so the single call there was overwritten. `MainActivity`
  re-asserts it from `decorView.post()`, `onResume` and window-focus gain, and
  `plugins.SystemBars.style: "DARK"` stops Capacitor deriving the same property
  from the phone's night mode. Verified on the emulator by building both ways and
  comparing screenshots.
- **Debug-signed by default.** `npm run apk` produces `app-dev-debug.apk`, signed
  with the owner's key when `keystore-dev.properties` exists and the debug key
  otherwise. The Play release needs the upload key (see *Two flavors* above).
- **iOS is simulator-only** (see *iOS shell* below): no push, no background
  pulls, no over-the-air bundle.

---

## iOS shell

Simulator only: there is no paid Apple Developer account, so nothing signs, archives or uploads, and
there is no APNs. `scripts/ios-sim.sh` (or `npm run ios:sim`) builds, installs and launches; the web
bundle goes to `ios/App/build/web`, never `packages/web/dist`, which is what the host serves to every
phone. Capacitor 8 resolves its iOS parts with SwiftPM, so there is no CocoaPods.

**The origin.** Android's page is `http://localhost` so the plain `ws://100.x:8770/ws` socket is not
mixed content. WKWebView refuses a custom handler for `http`/`https`, so iOS serves the page from
`capacitor://localhost`, and `capacitor.config.ts` pins `scheme: "capacitor"` so nobody "fixes" it:

- Mixed-content blocking keys off an `https` page, and `capacitor://` is not one, so `ws://` and
  `http://` to the daemon are allowed, the property Android gets from `http`.
- App Transport Security is the other gate: `Info.plist` sets `NSAllowsArbitraryLoadsInWebContent`
  (cleartext for the WebView only; the daemon is plain HTTP on the tailnet, by IP or MagicDNS name)
  and `NSAllowsLocalNetworking` (the LAN route). Native code does no networking of its own.
- `origin.ts` judges only `http`/`https` origins on host and port; `capacitor://localhost` is the one
  non-web origin, named exactly (`NATIVE_SHELL_ORIGINS`). Before, `anything://localhost` passed by
  accident, so this narrowed the guard (`SECURITY.md`).

**What is ported.** The web side never branches on Android: every native call looks its plugin up by
name (`shellBridge.ts`), so a missing plugin is absent, never a dead button.

| Android | iOS |
|---|---|
| `MainActivity` (keyboard, bar colours, deep links, resume nudge) | `ShellViewController.swift`: keyboard resizes the WebView, status bar follows the page theme read off the DOM, `waterplane://pair`, resume nudge. No back button on iOS. |
| `ShellSavePlugin` (bytes to Downloads) | `ShellSavePlugin.swift`, same methods, writes to Documents, shown in Files as *On My iPhone › waterplane*. |
| `ShellNetPlugin`, `ShellPullPlugin`, `ShellKeystorePlugin`, `ShellUpdatePlugin`, `ShellShare` | Not ported. Equivalents when wanted: `NWPathMonitor`, a background `URLSession`, Keychain with `SecAccessControl`, `setServerBasePath`, a Share Extension. |
| `ShellLinkService` stack, `ShellInstallPlugin` | Android-only. No background service on iOS (the replacement is APNs, paid program); install controls are hidden by `nativeInstallSupported()`. The notifications screen says there is no background alert (`shellLinkSupported()`). |

Checked in the Simulator (iOS 27): pair by deep link, repo and session sync, a prompt typed and
answered, the keyboard under the composer, outbox thumbnails, a download into Files, and a 60-second
background stay resumed with the link live.

**Build trap.** The first `xcodebuild` can hang at *Resolve Package Graph* on a SwiftPM file lock
while fetching Capacitor's two binary xcframeworks. Seeding
`~/Library/Caches/org.swift.swiftpm/artifacts/` with the two checksum-verified zips unblocks it;
later builds are cached.

**Not done.** APNs push, a Share Extension, background pulls, the OTA bundle swap. Auto-download
still pulls every announced APK onto an iPhone, where it cannot be installed (skip `.apk` in the
automatic path where `nativeInstallSupported()` is false). Some copy is Android-worded ("inside the
APK", "in Downloads"). The status bar follows the page theme, so over the black image viewer on a
light theme the clock is dark on dark.
