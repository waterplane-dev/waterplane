# waterplane — Android shell (`@waterplane/app`)

An APK that carries the existing web UI (`packages/web/dist`) inside itself instead of downloading it
from the daemon. It exists for one property:

> **The app shell is never on the network.**

Everything below follows from that. It is for developers building or changing the shell; the
permissions table is for anyone who wants to know what the app can reach.

**iOS:** the package also holds a simulator-only iOS shell (`ios/`, built with `scripts/ios-sim.sh`).
Its page is `capacitor://localhost` rather than `http://localhost`. See [iOS shell](#ios-shell) at
the end; everything else here is the Android shell.

---

## Why a shell at all

The PWA is served by the daemon over Tailscale, so the application itself sits on the far side of
the tunnel:

- **Any navigation while the tunnel is down destroys the app.** A reload, a watchdog reload, or
  Chrome restoring a discarded tab re-fetches `index.html` from a host that is not answering and
  shows the browser's timeout page. The send queue, drafts, prompt pad and cached transcripts are
  still in localStorage, but the code that reads them is gone.
- **A service worker cannot cache the shell** in the common setup: it needs a secure context, and
  plain `http://100.x.y.z:8770` is not one. `tailscale serve --https` fixes that, but people skip it
  and it competes for port 443.
- **Background Fetch needs the same secure context**, plus an installed PWA and Chromium.

Inside the APK the shell is a local asset. No navigation can fail, `http://localhost` is a secure
context whether or not `tailscale serve` ever ran, and a cold start with the network off lands in the
working app.

## Why Capacitor, and not Ionic Framework

Ionic Framework is a UI component library; adopting it would mean rewriting the whole UI (about 30
sheets, the xterm.js host, gallery, annotator, queue). Capacitor is the native runtime from the same
team: a WebView that loads a web build out of the app bundle and exposes native APIs. It ships
`packages/web/dist` verbatim, with zero UI changes. So: Capacitor, no Ionic Framework.

Rejected alternatives:

- **Bubblewrap / Trusted Web Activity.** A TWA is Chrome, with Chrome's storage, secure-context and
  navigation rules. The shell still comes over the tunnel and a dead tunnel still shows the error page.
- **React Native / Kotlin.** A rewrite of a large UI whose hardest parts (offline queue, resumable
  pulls, PTY replay) already exist and are tested.
- **A hand-written WebView host.** That is Capacitor minus the maintenance.

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

- **`androidScheme: "http"`, not Capacitor's `https` default.** `http://localhost` is still a secure
  context, so service workers, clipboard and install APIs work. And a page on `https://` may not open
  a `ws://` socket (mixed-content blocking applies to WebSockets whatever the WebView's setting), while
  the daemon's normal address is plain `ws://100.x:8770/ws`.
- **URL rewriting lives in the web layer.** `shared/hosturl.ts` holds the rules (pure functions, pinned
  by `scripts/e2e-hosturl.mjs`); `web/hostUrl.ts` patches `fetch`, `XMLHttpRequest.open` and
  `sendBeacon` once at boot, so a new `fetch("/api/…")` is correct in the APK on the day it is
  written. URLs that never pass a transport (`<img src>`, Background Fetch) call `abs()`. A native
  `shouldInterceptRequest` proxy cannot see request bodies, so uploads and POSTs would break.
- **Only `/api` and `/ws` are re-aimed.** `/`, `/assets/*`, `/sw.js` and icons stay local;
  rewriting them would put the app back into the failure it exists to fix. The allowlist is in
  `shared`, with a test around it.
- **The host needed no change.** `http://localhost` is already allowed by `host/origin.ts`; the
  same-origin guard was not widened.

### Branding

The launcher icon, adaptive-icon plate and splash are generated from
`packages/web/public/assets/icon-512.png` with `ffmpeg` (no image library). The native theme is
pinned dark so the launch window and system bars do not flash white. The adaptive foreground is
drawn at 86/108 of the canvas rather than the usual 66/108: the artwork is already a rounded badge
with its own margin, and the standard padding would shrink it twice.

---

## The UI updates itself: you do not push APKs

Carrying the UI in the APK would freeze it at build time, so the app updates its own web bundle from
the daemon:

```
web change  →  npm run build      (or npm run restart)
                    ↓
        daemon publishes /api/webbundle  ← build id + per-file sha256
                    ↓
        app checks on launch and every 5 min while open, downloads, verifies
                    ↓
        staged  →  starts on the next launch  (or "restart into it" now)
```

**A new APK is needed only when this package changes** (Java, manifest, icons). Web-only changes
reach the phone by themselves.

- **The build id is a content hash** (`dist/build-id.txt`, from the web build's `buildStamp` plugin),
  not a timestamp. `npm run restart` rebuilds constantly; a moving id would make the phone re-download
  ~1 MB over a roaming link for a byte-identical bundle.
- **`build-id.txt` ships inside the bundle**, so "which build am I running?" is read from whatever
  bundle is served, not from bookkeeping that can drift.
- **Every file is sha256-checked before anything is replaced**; a mismatch aborts the whole update
  rather than landing a mix of two builds. This guards against a truncated transfer, not a hostile
  host: the daemon already runs `claude` on your machine (SECURITY.md) and the bundle only comes from
  the host you paired with.
- **Nothing is applied under your feet.** A finished download is staged for the next launch;
  reloading mid-turn for an unrequested update is worse than waiting.
- **localStorage and IndexedDB survive an update** (the origin is `http://localhost` either way), so
  queue, drafts, paired host and cached transcripts carry across.
- **Installing a new APK wins.** The shell drops the stored bundle path when the APK's install time
  changes (`ShellUpdatePlugin`, `apkInstalledAt`). Capacitor's own check keys on
  `versionCode`/`versionName`, which `build.gradle` never changes, so it would never fire.

### If a bundle is bad

None of these recoveries needs the network. They live in the native shell, so an APK without them
keeps only the launch counter.

1. **A deadline per page load.** A page from a downloaded bundle has 15 s of on-screen time to call
   `markHealthy` (the web app does so from its first committed render, before pairing or any network).
   Otherwise the shell switches to the bundle inside the APK and says so in a toast. Time in a pocket
   does not count, because auto-restart starts new builds exactly then.
2. **A launch counter.** Each launch increments it; the web app zeroes it after rendering. Three
   launches that never get there and the native side drops the stored path before the bridge comes
   up. A stored path whose `index.html` is missing is dropped at once.
3. **The failed build is remembered.** Otherwise the APK's own bundle would ask the desktop what it
   serves, re-download the same bad build and restart into it. `stage`/`applyNow` refuse that id
   (`BAD_BUILD`) unless the person retries by hand from Settings → App version; the next different
   build is taken as usual.
4. **Manual.** Settings → App version → *use the build inside the APK*.

The APK's own copy is never deleted, so the floor is always there.

---

## Native rules a developer must know

### Where the system bar ends

The web app fixes a 22 px connection strip (`NetPulseBar`) to the top of the viewport, so whether
content starts under the clock decides whether the strip is readable.

- `android:windowOptOutEdgeToEdgeEnforcement` is **ignored on Android 16 for an app targeting SDK 36**
  (this one), so it is not used: one APK would lay out differently on different phones.
- Capacitor's `SystemBars` plugin pads only above API 35, and only after probing the installed
  WebView's major version and the viewport meta tag, both properties of a component that updates out of
  the Play Store. Its inset handling is off (`plugins.SystemBars.insetsHandling: "disable"` in
  `capacitor.config.ts`).
- `MainActivity.takeOverWindowInsets()` puts one `OnApplyWindowInsetsListener` on the WebView's
  container and pads by `systemBars | displayCutout`, replacing the bottom with the IME inset while the
  keyboard is up. It does not force edge-to-edge: below API 35 the platform hands it zero insets and
  nothing changes; from API 35 it pads by the real ones. A listener (not a measurement) survives
  rotation, the keyboard and switching between gesture and 3-button navigation.
- The web layer is untouched: `calc(env(safe-area-inset-top) + var(--ui-pulse-h))` keeps working.
  Nothing reads the `--safe-area-inset-*` properties the plugin used to inject.
- `android:windowBackground` is pinned to `#0B0D10`; edge-to-edge shows that strip behind the status
  bar, and the inherited AppCompat grey clashes with a near-black app.
- `plugins.SystemBars.style: "DARK"` is part of the same fix: left alone, the plugin derives bar-icon
  colour from the phone's night mode, giving dark icons on a dark bar. `MainActivity` also re-asserts
  light icons from `decorView.post()`, `onResume` and window-focus gain, because the appearance is
  re-derived after `onCreate` returns and a single call there is overwritten.

### Back, and the swipe-back gesture

Capacitor 8 registers nothing on the activity's back dispatcher, so by default Back (button, gesture,
Android 13+ predictive swipe) finishes the activity. `MainActivity.registerBackNavigation()` registers
an `OnBackPressedCallback`, and the web side decides:

- **The web decides, not `WebView.canGoBack()`.** Sheets (queue, pad, files) serialize to the same
  URL as the screen under them, so only the web knows they are separate screens; it pushes one history
  entry per screen keyed on `history.state` (`App.tsx`, `routeKey`). And the WebView's history contains
  the documents an OTA bundle swap loaded, so `canGoBack()` is true at the root.
- **Depth 0 closes the app.**
- **The depth is pushed.** Android 13+ asks whether the app will handle Back when the swipe starts,
  before anything is committed; an answer needing a JavaScript round trip does not exist yet. The web
  reports its depth on every route change via `window.ShellAndroidInterface.setBackDepth(n)`
  (`ShellNavPlugin`); the callback is enabled above 0 and off at 0, so the platform's own Back runs and
  the app leaves like any other.
- **Fallback.** A bundle that never calls `setBackDepth` leaves the depth unknown, and the shell asks
  `window.shellBack()` via `evaluateJavascript` behind a 1200 ms deadline. A deadline that expires while
  the depth is known to be above 0 is a busy renderer, so the press is dropped rather than closing an
  app that had somewhere to go. (The UI updates over the air and the shell does not, so every shell
  to page call must tolerate the other end being absent.)
- **`android:enableOnBackInvokedCallback="true"`** is stated, not inherited: on Android 13 and 14 the
  default is off and Back would arrive by the older path.
- **Leaving is `finishAfterTransition()`**, not a second trip through the dispatcher; re-entering it
  from inside its own dispatch broke under predictive back.

### Links that would take the app away

The document in this WebView is the app; replacing it loses the queue, drafts and compose box. A
relative URL (a markdown link in a transcript, an `<a href>` from host data) resolves against
`http://localhost`, Capacitor's asset server, which holds only the bundle, so the app would be replaced
by a blank 404.

- `MainActivity.guardNavigation()` installs a `BridgeWebViewClient` that refuses any main-frame
  navigation to our own origin that is not the app document, and says so.
- A main-frame navigation to a different origin leaves, but asks first with a dialog naming the URL.
- Sub-frame requests, `blob:` and `data:` keep Capacitor's behaviour.
- `MainActivity.catchDownloads()` hands `http(s)` downloads the WebView starts itself to
  `DownloadManager` and says where the file goes; `blob:` and `data:` live in the renderer, cannot be
  handed over, and are named instead. Silence is the outcome not on offer.

### Saving a file out of the app

A WebView silently drops `<a download href="blob:…">`, and a native `DownloadListener` cannot fix it
because a `blob:` URL lives in the renderer. So the bytes cross the bridge: `web/nativeSave.ts` slices
the blob and `ShellSavePlugin` writes it to Downloads.

```
IndexedDB blob ─► slice 512 KiB ─► base64 ─► ShellSave.chunk ─► cache/saves/<token>.part
                                                                       │
                       "Downloads/thing.apk"  ◄── MediaStore ◄── ShellSave.finish
```

- **Sliced, never one call.** Base64 of a 23 MB APK is ~31 MB of JSON string; one call peaks at several
  times that on both sides.
- **Assembled in the cache, published at the end**, so an interrupted save leaves nothing half-written
  where a file manager lists it. On API 29+ the MediaStore row is `IS_PENDING` until the last byte.
- **Two publish paths.** API 29+ inserts into `MediaStore.Downloads` and needs no permission. Below
  that (`minSdk` is 24) Downloads is a real path behind `WRITE_EXTERNAL_STORAGE`, declared
  `maxSdkVersion="28"` and requested only there.
- **The destination is reported, not assumed.** MediaStore renames a colliding file, so the settled name
  is read back and shown.

The browser is untouched: `pull.ts` uses the anchor click wherever `nativeSaveSupported()` is false.

### Downloading a file (`ShellPullService`)

`web/pull.ts` is a resumable downloader, but in the APK it stopped when the app was backgrounded.
The cause is not the process freezer: **Chromium freezes the document itself**, measured on API 34 /
WebView 113 at 300 s after `visibilitychange` even with the link service keeping the process alive.
The pump interval, retry timer, stall fuses and `fetch` reader all live in that document. So the
transfer runs natively:

```
pull.ts ─► ShellPull.enqueue ─► ShellPullService  ──OkHttp Range──►  daemon
                                     │
              files/pulls/<id>.part ─┴─► .bin ─► Downloads.publish ─► MediaStore
```

- **`dataSync`, not `specialUse`.** Android 15 caps `dataSync` at ~6 h per 24 h, irrelevant to a
  bounded download and the honest type for moving a file. Consequence: Android 15+ refuses a
  background start, so an enqueue made while backgrounded stays `queued` until the app is next opened;
  the row says so.
- **Not `DownloadManager`.** It runs in another app with its own VPN routing, cleartext policy and
  metered rules. The daemon is reachable because this process is inside the Tailscale tunnel.
- **The backoff is on disk** (`nextAt` persisted with the row). A timer dies with the process, so a
  handler-only wait would come back runnable at once after a restart and spend fifty attempts in a
  second against a down link.
- **The service stays alive while a retry counts down** (backoff caps at two minutes); stopping would
  move the retry back into the frozen document. The notification says *waiting to retry…*.
- **The offset is the file's own length**, with no second record to disagree. `Range` + `If-Range`; a
  416 discards the prefix and starts clean; a 200 answering a ranged request truncates.
- **A partial file is never published**: bytes land in `<files>/pulls/<id>.part`, renamed to `.bin`
  only when complete.
- **The bytes never cross the bridge.** The finished file stays in the app directory (previews use
  `Capacitor.convertFileSrc`); the copy into Downloads happens in Java (`Downloads.java`, shared with
  `ShellSavePlugin` so "landed and told where" is worded one way).
- **Publishing is what a tap promised.** `autoSave` rides on the row; the host's auto-pull rules leave
  it off, so those files wait for the save button (an APK appearing in Downloads unasked is a
  surprise). Below API 29 `ShellPullPlugin` asks for the storage permission and hands the job back,
  since a service cannot show a dialog.
- **The LAN gate's cookie is borrowed** from `CookieManager`; a 401 is permanent and says to open the app.

`web/nativePull.ts` is the page's side and keeps every decision: queue, order, words, give-up rule.

### Installing a build (`Installs`, `ShellInstallReceiver`)

A finished download is a fresh APK in the app's own directory. The platform shapes the install:

- **"Install unknown apps" is a special access** only the person can switch on.
  `Installs.canInstall` asks `canRequestPackageInstalls()` before any verb is drawn, and
  `Installs.settingsIntent` is what the row offers instead of a button that would fail.
- **The first install of a package always shows the dialog**; the row says so in advance.
- **An update can be silent**: API 31 `setRequireUserAction(USER_ACTION_NOT_REQUIRED)` plus
  `UPDATE_PACKAGES_WITHOUT_USER_ACTION`, and from API 34 update ownership
  (`setRequestUpdateOwnership(true)`, asked on the install that does show a dialog). Hence one dialog
  per app.
- **A refused silence is not an error.** It returns `STATUS_PENDING_USER_ACTION` with the same
  confirmation intent the loud path uses, so asking for silence never costs an install. Real failures
  (a debug key from another machine, a downgrade) arrive on the same door with the platform's message,
  kept verbatim by `Installs.failureText`.
- **The package is read from the archive, never the file name** (`Installs.read`): several repos all
  build `app-debug.apk`. Unreadable leaves the fields empty rather than guessed.
- **The allow-list is the page's** (`web/installPolicy.ts`, synced across phones). A copy lives in
  `SharedPreferences` because the install happens at the end of a transfer, where the document is frozen
  and a bridge call would never be answered. `Installs.mayAutoInstall` is narrower than a tap: access
  granted, package on the list, and already installed (an unattended first install would only produce a
  notification asking for a tap nobody wanted).
- **A confirmation that cannot be shown becomes a notification.** `ShellInstallReceiver` starts the
  installer directly when the app is in front; otherwise the same intent rides on a notification and
  the row reads *waiting for you to confirm*, never *failed*.

**All of this is the `dev` flavor.** The `play` build declares no
`UPDATE_PACKAGES_WITHOUT_USER_ACTION`, never asks for `USER_ACTION_NOT_REQUIRED` or update ownership
(`BuildConfig.QUIET_INSTALLS`), starts no install by itself (`mayAutoInstall` is false), and
`Installs.install`, the one door every install passes, refuses an archive of its own package or one it
cannot name (`Installs.refusal`, `BuildConfig.SELF_UPDATE`).

---

## Running in the background

Backgrounded with no foreground service, minutes later Android 12+'s cached-app freezer suspends the
whole process (JS, timers, socket). There is no service worker in the shell (`main.tsx` gates
registration on `!isNativeShell()`) and Android System WebView does not implement the Push API at all
(`registration.pushManager` does not exist), so nothing can wake it.

Capacitor's `KeepRunning` defaults to `true`, so WebView timers are not paused when the activity
pauses; JS dies only because the process is frozen. **Keep the process out of the freezer and the
existing web code keeps working.** Hence one permanent, opt-in `specialUse` foreground service,
`ShellLinkService`, with two jobs:

1. **By existing**, it keeps the process out of the freezer, so the WebView's `ws.ts` socket,
   `flushOutbox`, uploads and reconnect logic run in the background unchanged. No second protocol
   implementation is needed.
2. **It holds a minimal native socket** for the case the WebView cannot cover: app swiped away,
   process gone, which is when a waiting question matters most.

Rejected: a native client speaking the full protocol (duplication, and it still could not drain
uploads whose bytes live in the WebView's IndexedDB; **the queue drain stays in the page**); FCM (a
Firebase project and Google-routed metadata for a self-hosted tool on a private tailnet); WorkManager
alone (15-minute floor, useless for "a question is waiting"); an FGS only while work is outstanding
(nothing is alive to start it when a question lands).

### `specialUse`, never `dataSync`, for the link

Android 15+ caps a `dataSync` foreground service at about six hours per 24, then calls
`Service.onTimeout()` and refuses background restarts, so a permanent connection would quietly stop
overnight. It also bans starting `dataSync` from `BOOT_COMPLETED`, which would kill the recovery path.
`specialUse` has no timeout and is allowed from a boot receiver; the cost is a Play policy review. The
manifest declares the subtype honestly: one WebSocket to the user's own self-hosted daemon on their own
network, delivering that daemon's notifications. There is no cloud component.

### The native socket speaks three frames, not the protocol

- **The WebView keeps `ws.ts` untouched**; it remains the only speaker of the full protocol (attach,
  `resumeSeq`, acks, ops, flusher).
- **The service speaks a frozen subset**: send `hello`; keep alive with WebSocket protocol pings
  (OkHttp `pingInterval`, 2 min; the host's ws library auto-pongs, which costs far fewer radio wakeups
  than `ws.ts`'s 12-second JSON ping); act on exactly three inbound frames: `notification` (post an OS
  notification), `authRequired` (stop reconnecting, say so) and `pull.new` (start the announced download
  natively, since the page is frozen). Anything else is ignored, as `main.ts`'s dispatcher does for an
  unknown `t`.
- **`PROTOCOL_VERSION` and the host address are passed in from the web layer**, never compiled into
  Java: the version ships in the OTA bundle while the APK does not update, and the address lives in the
  WebView's localStorage.
- **Host cost is zero**: `broadcast()` already sends `notification` frames to every socket and the
  `notifyprefs` gate runs before it. The service is just another client.

### One socket per saved desktop (`multiLink`)

A phone paired with several desktops gets one link per desktop, so a card raised by a desktop the phone
is not switched to (a vault approval above all) still reaches the shade with the app swiped away.

- **`ShellLink.start({url, label, protocol, links})`**: the web layer (`shellLink.ts` →
  `shellLinkSet.ts`) sends every saved desktop as `links: [{hostId, url, label}]`, active one first,
  always the saved tailnet base (never LAN), the label being the person's own name. The call still
  carries `url`/`label` (the active desktop), so an old APK with a new bundle watches one desktop as
  before, and an old bundle on a new APK sends no list and behaves as before (a stored list is
  forgotten). `isSupported()` reports `multiLink: true`. `KEY_URL` keeps meaning the active desktop
  (`savedUrl`: the paired-host check, auto-downloads).
- **`ShellLinkService` holds one `Link` each**, with its own socket, backoff, `authRequired` pause and
  status. A re-sent list reconnects nothing; an added desktop opens, a removed one closes, a moved one
  reconnects (`ShellLinkSet.diff`, JVM-tested in `src/test/.../ShellLinkSetTest.java`). The page
  re-sends the list after a desktop is added, edited or removed and once per boot, only while the link
  is on, and never asks for a permission.
- **Alerts say whose they are** (only with two or more links): the title starts with the desktop's
  label, the tag is prefixed `hostId|` (equal tags from two desktops must not replace each other), and
  the tap hands `window.shellOpen` `host:<hostId>|<target>`. The page (`shellOpenTarget.ts`
  `shellHostOpen`) handles it directly when that desktop is active, and otherwise switches there only
  because the person tapped (`switchTo(hostId, target)`). Nothing switches by itself.
- **On each link's (re)open it asks `GET /api/attention` once** and posts one summary alert for that
  desktop when anything waits (tag `<hostId>|summary`, *prompt* channel, same words as the in-app
  sheet), because the notify link never replays a feed. Cards seen again on a reconnect do not ring
  again; a desktop with nothing waiting clears its old summary.
- The queue-backlog alert and auto-downloads (`pull.new`) stay the active desktop's: the page's queue
  holds only that desktop's work.
- **A password-gated desktop (`WATERPLANE_ALLOW_PUBLIC`) gets that desktop's own device token, and
  nothing else does.** A `links` row may carry `token`; the web builds it per host (`shellLinkToken`)
  under `bearerForSaved`'s rule (saved base origin only, never a LAN base, never another desktop) and
  omits it for a passive (kids') token, which the host refuses on the socket (`4403`) and on
  `/api/attention`. `start` also hands `wsProtocol`, the base subprotocol. Java sends the token only to
  that link's own url: `Sec-WebSocket-Protocol: <base>, <base>-tok.<tok>` on the socket,
  `Authorization: Bearer` on the attention read. Optional both ways: an old APK ignores the field, an
  old bundle sends none, and an ungated desktop dials as before.
- **At rest: `ShellLinkTokens`.** The service needs the token after a swipe, reboot or process death.
  Each token is AES-256-GCM sealed under one non-exportable Android Keystore key, in its own
  `MODE_PRIVATE` file beside the `shell.link` list, with the desktop's id and address as associated data
  so a blob opens for no other desktop. The key needs **no user authentication** on purpose: nobody holds
  the phone when the service reconnects, so the fingerprint key would stop the link. This guards against
  a copied file, not against code running as this app (the page's own copy is plaintext localStorage). A
  token that cannot be sealed is never stored in the clear; that link runs without it. Every `start`
  rewrites the set, and switching the link off deletes all blobs.
- **In memory only: `start({…, tokensInMemory: true})`**, for a phone whose sign-ins are sealed. No token
  reaches disk: the call deletes every blob, and tokens live in a static map in this process (bound to
  desktop and address), never in an intent or preference; stored rows gain `tokenHeld: true`. After a
  process death a restart finds `tokenHeld` and no token, so that link does not dial: state `locked`
  ("locked — open the app") until the page hands the token back. `caps()` resolves
  `{memoryTokens: true}` (positive detection; an older shell lacks the method).
- **Never in a log, notification or intent.** `Spec.toString` leaves the token out, and
  `loggingBehavior: "none"` (`capacitor.config.ts`) stops Capacitor printing `start`'s arguments, which it
  otherwise does in the debug builds `npm run apk` makes.
- **A refused token pauses, once.** `authRequired`, or a 401 on the attention read, on a link that carried
  a token means revoked or the password changed: state `signedOut` ("signed out there — pair again"), no
  retry, blob deleted. Only a different token clears it (`sameSocket` compares tokens); after a process
  death the page may offer the same token once more and it pauses again, so one try per page boot, never
  a loop. With no token at all a gated desktop reads "needs this phone signed in there".

### Notifications, and who posts them

**The service is the only poster of OS notifications**, and posts none while the activity is resumed:
the WebView has its own in-app feed.

- The **FGS notification is a status surface, not an alert**: its own `IMPORTANCE_MIN` channel reading
  "connected · 100.64.0.5" / "reconnecting…" / "sign-in needed". (Android floors it at
  `IMPORTANCE_LOW`; it is still silent and badge-less.)
- **Alerts go to a channel per kind** (`kind.prompt`, `kind.limit`, …), so Android's per-channel
  controls complement the host's `notifyprefs` gate: the host decides what may be published, the phone
  decides how loudly. A kind this APK does not know (a host newer than the binary) gets a channel named
  after itself rather than being dropped.
- **Channel importance is immutable**, which is why `approval` (a plugin's must-approve-now request,
  e.g. a vault fingerprint) is HIGH on its own id `kind.approval.high`: an older APK created
  `kind.approval` at DEFAULT. An alert with a `plugin` and no session opens that plugin via
  `shellOpen("plugin:<id>")`. `signin` ("Signed out", HIGH; a session stopped by a sign-out asks you to
  continue) has its own channel and needs an APK that has it; on an older APK the alert still lands, on
  a channel named `signin` at DEFAULT.
- **Replacement is by tag.** `NotificationItem.tag` carries it when the host sets one; otherwise the
  service derives `kind|sessionId`, falling back to the item id.
- Tapping opens the app with the session id, reaching the focus path `sw.js`'s `notificationclick`
  takes in the browser.

### The network changed: two jobs on one signal

A `ConnectivityManager.NetworkCallback` reconnects the native socket and nudges the WebView.
`ws.ts` verifies its socket on `visibilitychange`, `online`, `focus` and `pageshow`, all viewport
events, so a live page that is off screen when the network flaps gets no signal and sits on a socket
still reading OPEN. The nudge is `window.shellNudge(reason)`, guarded at the call site.

### Backstop and boot

A foreground service is not immortal (OEM task killers, a low-memory kill outrunning `START_STICKY`,
a reboot). Two recoveries, neither needing the app opened:

- **`ShellBootReceiver`** on `BOOT_COMPLETED` / `LOCKED_BOOT_COMPLETED` / `MY_PACKAGE_REPLACED` (the
  last because installing a new APK stops the service).
- **`ShellLinkWorker`**, a 15-minute WorkManager periodic check that the service is up and the socket
  sane. WorkManager is the only scheduler that survives process death and reboot; its floor is why it
  is the backstop and not the transport.

Both are gated on the stored enabled flag.

### Opt-in, and inert until it is not

Nothing starts the service but an explicit `ShellLink.start()` from the page. With the flag unset the
boot receiver returns immediately, no periodic work is scheduled, no channel is created and nothing is
posted: no notification, service, battery cost or behaviour change.

The **battery-optimisation exemption** is offered, never demanded. An app the system may doze cannot
start a foreground service from the background, which is what the boot receiver and periodic check do.
Without it the worst case is the socket stalling between Doze maintenance windows and the backstop
reconnecting in each: a notification within the next window, minutes to tens of minutes overnight.
Never "silently never".

### The plugin surface

`ShellLinkPlugin`, reached as `Capacitor.Plugins.ShellLink` (no npm import, like `webUpdate.ts` and
`nativeSave.ts`); `web/src/shellLink.ts` is the typed wrapper.

| call | what it does |
|---|---|
| `isSupported()` | `{supported, notifications, batteryExempt, powerSave, multiLink}` |
| `status()` | `{enabled, running, state, host, queueDepth, connectedAt, lastFrameAt, error, notifications, batteryExempt}` |
| `start({url, protocol, label, links?, wsProtocol?})` | persist + start. `url` is `wsUrl()`, `protocol` is `PROTOCOL_VERSION` |
| `stop()` | stop, cancel the periodic check, forget the flag |
| `setQueueDepth({depth})` | how many sends the page is holding |
| `requestNotifications()` | `POST_NOTIFICATIONS`; a refusal is not fatal |
| `requestBatteryExemption()` | opens the Settings screen (not the direct-grant dialog) |
| `openNotificationSettings()` | opens the app's notification settings |

Two optional globals the shell calls: `window.shellNudge(reason)` and `window.shellOpen(sessionId)`;
`shellLink.ts` installs them and re-emits each as a `window` event, so `ws.ts` and `App.tsx` import
nothing from it.

**The residual gap:** app swiped away with prompts queued offline. The page reports its queue depth on
each outbox write; after a process death, when the service's socket reconnects and the persisted count
is non-zero, it posts "N prompts waiting — open to send". The prompts are safe either way.

**What is verified, and what is not.** On an API 34 emulator (WebView 113) against a stub daemon: the
WebView is not throttled under the FGS (`ws.ts`'s 12-second heartbeat held 12.0 s ± 0.05 s backgrounded
with the screen off, so the native nudge is insurance); the service is `specialUse` (`dumpsys` reports
`types=40000000`, `isForeground=true`); and notifications dedupe (none while resumed, one tagged on
`kind.prompt` when backgrounded). Only a real device settles overnight Doze latency through Tailscale
(the emulator has no tailnet), OEM task killers, daily battery cost and a genuinely bad link.

---

## Which network, and pairing links (`ShellNetPlugin`, `waterplane://pair`)

### `ShellNet`: the transport and the Wi-Fi name

The page picks per host between its LAN address and the tailnet (`shared/lanroute.ts`); one gate is
"this phone is on a Wi-Fi saved for that host". A browser cannot read the Wi-Fi name, so the shell does.

| call | what it does |
|---|---|
| `current()` | `{transport: 'wifi'\|'cellular'\|'other'\|'none', ssid: string\|null, permission: 'granted'\|'denied'\|'prompt'}` |
| `requestLocation()` | asks for `ACCESS_FINE_LOCATION`, resolves with the same shape after the answer; never rejects |

Plus a push, **`window.shellNetChanged(state)`**, with the same object, debounced 500 ms (a Wi-Fi
hand-over is a burst of callbacks) and sent only when the state differs from the last one sent. The
plugin keeps its own default-network callback for as long as the bridge lives, independent of
`ShellLinkService`'s. It is guarded at the call site.

`ssid` is `null` whenever unknown: not on Wi-Fi, permission not granted, system location switch off, or
the platform answering `<unknown ssid>`. Quotes are stripped. On API 31+ the name exists only in the
`WifiInfo` of a callback registered with `FLAG_INCLUDE_LOCATION_INFO` (`getNetworkCapabilities()`
returns a redacted copy), so the plugin caches that callback's last capabilities and re-registers after
a grant and on every resume, because what arrives in the background has no name. That callback watches
the Wi-Fi network, not the default one: with Tailscale up the default network is the VPN, which says
`TRANSPORT_WIFI` but carries no `WifiInfo`. Below 31 it reads `WifiManager.getConnectionInfo()`.

**Why a location permission.** Android classes a Wi-Fi name as location, so reading it requires
`ACCESS_FINE_LOCATION` (and `ACCESS_WIFI_STATE` below API 31). It is asked for only through
`requestLocation()`, from the page's explicit "allow" button, and used for one thing: comparing on the
phone with the network names saved for each host. **It is never sent anywhere.** Refusing it costs only
the automatic LAN switch; the tailnet route keeps working.

### `waterplane://pair?u=<base>&c=<code>`: the pairing deep link

The host's `/pair/<code>` landing page links here after the APK is installed. `MainActivity` has a
`VIEW`/`BROWSABLE` intent filter for scheme `waterplane`, host `pair`; the link arrives in `onCreate`
(cold) or `onNewIntent` (`singleTask`, live) and is handed whole to **`window.shellPair(url)`**. Like
`shellOpen` it is parked: retried every 500 ms for up to 20 s until the page's function returns truthy,
because a cold start reaches `onResume` long before the bundle installs its global. The intent's data is
consumed so a rotation does not re-deliver it.

**Any app or web page can fire this link.** The shell validates only scheme and host; the page parses it
(`shared/pairing.ts`) and asks the person before adopting a host. It is a suggestion, never a command.

The link may also carry `s=1` (pair by the encrypted exchange only), `k=` (a 12-hex commitment the
host's sealed reply must match) and `l=` (the desktop's Wi-Fi address). `u` stays a plain address on
purpose: an older APK could not reach a TLS one. Whether every camera app opens a custom scheme is not
known; the typed code runs the same exchange.

`MainActivity.callWindow(fn, jsonArg)` is the one helper for fire-and-forget pushes (`shellNudge`,
`shellNetChanged`); the parked calls (`shellOpen`, `shellPair`, `shellShare`) share one `ParkedCall`
retry loop.

## Biometric keystore (`ShellKeystorePlugin`)

A key on the phone that only a fingerprint can use, or on request one the phone's PIN opens too. It is
generic: it wraps and unwraps bytes and knows nothing of their meaning (a vault, a token). Typed wrapper:
`web/src/nativeKeystore.ts`, exported from `web/src/sdk`. Needs `USE_BIOMETRIC` and
`androidx.biometric:biometric:1.1.0`; a shell without it has no `ShellKeystore` and
`nativeKeystore.available()` is false.

| call | what it does |
|---|---|
| `status()` | `{hardware, enrolled, strongBox}` from `BiometricManager.canAuthenticate(BIOMETRIC_STRONG)` |
| `has({alias})` | `{exists}` |
| `generate({alias, strongBox?, replace?, auth?})` | AES-256-GCM in the Keystore, StrongBox when present (else TEE) → `{strongBox}`; refuses an existing alias without `replace`. `auth` is `"biometric"` (same as omitted) or `"any"` (below); any other word is `badInput`. A caller who sent `auth` gets it back; an older shell ignores it and returns none, so test for that |
| `wrap({alias, dataB64, aadB64?, title?, subtitle?})` | one prompt → `{ctB64, nonceB64}` (Keystore-chosen nonce, tag inside `ct`) |
| `unwrap({alias, ctB64, nonceB64, aadB64?, title?, subtitle?})` | one prompt → `{dataB64}` |
| `remove({alias})` | deletes the key and what was remembered about it |
| `lockStatus()` | `{hardware, enrolled, screenLock}`, read fresh, no prompt. `hardware` is false only when no sensor exists (a sensor that is down still reads true); `enrolled` is `canAuthenticate(BIOMETRIC_WEAK)` reading clean, so false proves nothing unless `screenLock` is false too; `screenLock` is `KeyguardManager.isDeviceSecure()` |
| `authenticate({title?, subtitle?, description?, allowCredential?})` | a presence check, no key: `BiometricPrompt` without a `CryptoObject`, `BIOMETRIC_WEAK` plus the phone's PIN, pattern or password (`allowCredential` defaults true; false is biometric only, with a Cancel button) → `{method}`: `biometric`, `credential` or `unknown` |

`lockStatus` and `authenticate` need a newer APK than the rest: test `typeof K.authenticate === "function"`.

**Biometric keys** are bound per use to a STRONG biometric (`setUserAuthenticationParameters(0,
AUTH_BIOMETRIC_STRONG)` on API 30+, validity `-1` below) and invalidated by a new enrolment. Every
`wrap`/`unwrap` is a `BiometricPrompt` with a `CryptoObject`; no PIN fallback. `authenticate` is the one
call with a PIN fallback, because it guards no key; it shares the `busy` latch and refusal words with
`wrap`/`unwrap`.

**`generate({auth: "any"})`** makes a key that a fingerprint or the phone's PIN opens for 10 seconds
(`setUserAuthenticationParameters(10, AUTH_BIOMETRIC_STRONG | AUTH_DEVICE_CREDENTIAL)` on API 30+; timeout
0 with the credential is a shape Android rejects). `wrap`/`unwrap` show the prompt with no `CryptoObject`,
then make the cipher and finish at once. The prompt is STRONG plus the credential on API 30+, WEAK plus
the credential below, because the stronger pair does not exist on API 28-29; a WEAK face there passes the
prompt but does not open the key, which is `failed` with a message to use the PIN (a PIN used more than 10
seconds before the Cipher gives the same). The key needs a screen lock and no fingerprint, so for it
`noneEnrolled` means no screen lock and `status()` is the wrong question: ask `lockStatus().screenLock`.
Android documents it as bound to the lock screen's secret, so a new fingerprint does not touch it and
removing the screen lock destroys it. Which kind an alias is sits in the prefs file `shell.keystore.kind`
(only the `any` aliases), so older keys read as biometric; an older shell cannot use an `any` key. **None
of this has been run on a phone.**

Refusals carry one word in `code`: `noHardware`, `noneEnrolled`, `keyInvalidated`, `noKey`, `exists`,
`cancelled`, `lockout`, `busy`, `badInput`, `failed` (plus `unavailable` from the wrapper when there is no
plugin). `keyInvalidated` and `noKey` are said only when the exception names a dead key
(`KeyPermanentlyInvalidatedException` anywhere in its causes, the Keystore's own message, or from API 33
`ERROR_KEY_DOES_NOT_EXIST`). Any other `UnrecoverableKeyException` or `InvalidKeyException` stays
`failed`, because `getKey` throws the first for a passing system error too and a caller may give up what
the key wraps on those two words. An OEM wording a dead key its own way therefore reads `failed`; this is
read from the Android 16 sources, not seen on a phone. `noHardware` also covers a sensor that is briefly
down, and `noneEnrolled` a phone whose screen lock is gone, so read `lockStatus()` before treating either
as final.

**Manual test on a device** (remote-debug the WebView from `chrome://inspect` and use
`Capacitor.Plugins.ShellKeystore` from the console). Check, on a phone with a fingerprint and a PIN:

- `status()` and `lockStatus()` read true; `generate` returns `{strongBox}`, and a second `generate` of
  the same alias gives `exists`.
- `wrap` then `unwrap` with the same `aadB64` returns the data; a different `aadB64`, a short nonce or a
  bad `auth` word gives `badInput`; Cancel gives `cancelled`; two concurrent prompts give `busy`.
- Enrolling another fingerprint makes a biometric key's `wrap` fail `keyInvalidated`; `remove` then `has`
  gives `{exists: false}`.
- `authenticate`: fingerprint gives `{method: "biometric"}`, the PIN gives `credential`, Back or Cancel
  gives `cancelled`, `allowCredential: false` offers biometric only. With every fingerprint removed and
  the PIN kept, `lockStatus` reads `enrolled: false, screenLock: true` and `authenticate` takes the PIN;
  with the screen lock gone too it gives `noneEnrolled`.
- The `any` key (API 30+ and one phone below it; `strongBox: false` forces the TEE): `wrap`/`unwrap` accept
  the fingerprint or the PIN; right after unlocking the phone `wrap` still shows the sheet; a new
  fingerprint does not break `unwrap`; removing the screen lock gives `noneEnrolled`, and setting one
  again gives `noKey` or `keyInvalidated` (a bare `failed` here would strand a caller: report it). On API
  29 with a face unlock, passing the sheet with the face gives `failed` naming the PIN. A phone with a PIN
  and no fingerprint works on the PIN. `generate({replace: true})` returns it to fingerprint only.

The app lock also needs a real phone (Settings › Connection › lock this app):

1. Turn it on, leave the app over a minute, come back: the lock screen is up. Back within a minute: it
   is not. Kill and reopen: it is.
2. Fail a fingerprint until the sensor locks out: the sheet moves to the PIN, and the PIN opens the app.
3. Below API 30 (an emulator will do): `authenticate` with the PIN goes through Android's own credential
   screen. The page goes hidden and returns; it must not lock again on the way back. `method` may read
   `unknown`.
4. Switch through recents: the lock arrives when `visibilitychange` says it should, and the recents
   thumbnail is what you expect.
5. While locked: Back shows nothing of the app, and the keyboard goes away.
6. On a shell without `authenticate` (the fingerprint-key path): enrol a new fingerprint, and the unlock
   reports `keyInvalidated`.
---

## Permissions, and what each one is for

The manifest is long for an app that shows a terminal. Every line, with the feature behind it. Two facts
frame the list:

- **The app talks to one address: the desktop you enter or pair with.** There is no waterplane server,
  no Google Play Services or Firebase in the build, and no analytics. The UI it runs comes from inside
  the APK or from your own desktop's update (see *The UI updates itself*), never from us.
- **Nothing that prompts is asked for at first launch.** Each runtime permission is requested when you
  turn on the feature that needs it. Deny it and that feature says why it is off; the rest works.

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
| `USE_BIOMETRIC` | a fingerprint-locked key for an extension's secrets, and the optional app lock (`ShellKeystorePlugin`). Off until you turn it on |
| `UPDATE_PACKAGES_WITHOUT_USER_ACTION` (**`dev` flavor only**) | after the first confirmed install of an app, its later builds update without a dialog. The `play` build does not declare it |

**Not a permission, but visible:** `<queries>` for launcher activities lets the app see which apps with
a home-screen icon are installed. It answers one question: whether the build you are about to install is
already on the phone (first install versus update). It is narrower than `QUERY_ALL_PACKAGES`, and the
list is never sent anywhere.

**The flavors differ only in installing:** `dev` may update itself from a downloaded APK and may update
other apps quietly; `play` does neither. Permissions are otherwise identical.

---

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

`npm run sync` always rebuilds `packages/web` first (`packages/app/scripts/build-web.mjs`): `cap sync`
copies `webDir` without knowing whether it is current, and an APK built from a stale `dist` is
confusing to debug on a phone.

**Not a root workspace, on purpose.** Adding it would put Capacitor's dependencies into every
`npm install`, including CI, which builds the host and runs e2e with no use for an Android toolchain.
It has its own `.npmrc` (ignore-scripts, release-age cooldown) because the root one does not reach it.

### Two flavors: `dev` and `play`

One codebase, two distributions, **two different signing keys**:

| | `dev` | `play` |
|---|---|---|
| applicationId | `dev.waterplane.app.dev` | `dev.waterplane.app` (permanent once uploaded) |
| launcher label | waterplane dev | waterplane |
| who it is for | a developer's own phone, sideloaded | everybody, through Google Play |
| shell updates itself from a downloaded APK | yes | **never** — refused natively (`Installs.refusal`); the page says *this build updates through Google Play* |
| quiet updates of other apps (`UPDATE_PACKAGES_WITHOUT_USER_ACTION`, `USER_ACTION_NOT_REQUIRED`, update ownership) | yes (`src/dev/AndroidManifest.xml`) | **never** — not declared; every install shows the system's confirm dialog; auto-install is unavailable and the page says why |
| signed with | `keystore-dev.properties` if present, else `DEV_STORE_FILE` & co. in the environment, else the debug key | release: the Play **upload** key (build fails without it); debug: the debug key |
| output | `app/build/outputs/apk/dev/{debug,release}/app-dev-*.apk` | `app/build/outputs/bundle/playRelease/app-play-release.aab` |

The flavor reaches the page at run time: `ShellInstall.status()` answers `distribution: "dev" | "play"`
and `self` (its own package). The web bundle is shared by both and updates over the air, so it asks the
shell instead of being built per flavor; a shell older than the field says nothing, and the page then
keeps the full behaviour (absent means inherit).

**Keys.** Both properties files sit in `packages/app/android/` and are gitignored, as is every
`*.jks` / `*.keystore`:

```properties
# keystore-dev.properties — same shape for keystore-play.properties
storeFile=/Users/you/keys/waterplane-dev.jks   # relative paths resolve against packages/app/android
storePassword=…
keyAlias=…
keyPassword=…
```

Either key can come from the environment instead (the properties file still wins when it exists):

| key | Gradle properties (`-P…` or `ORG_GRADLE_PROJECT_…`) | plain env |
|---|---|---|
| dev | `devStoreFile`, `devStorePassword`, `devKeyAlias`, `devKeyPassword` | `DEV_STORE_FILE`, `DEV_STORE_PASSWORD`, `DEV_KEY_ALIAS`, `DEV_KEY_PASSWORD` |
| Play upload | `playUploadStoreFile`, `playUploadStorePassword`, `playUploadKeyAlias`, `playUploadKeyPassword` | `PLAY_UPLOAD_STORE_FILE`, `PLAY_UPLOAD_STORE_PASSWORD`, `PLAY_UPLOAD_KEY_ALIAS`, `PLAY_UPLOAD_KEY_PASSWORD` |

A store file set without the other three stops the build naming the missing ones, and a store file that
is not a regular file stops it too, never printing a value. `bundlePlayRelease` / `assemblePlayRelease`
without any Play key stops with a message naming all of this, never producing an unsigned artifact.

**Once you sign `dev` with your own key, keep it.** A build signed with the debug key cannot update one
signed with yours (or the reverse), so a second machine without `keystore-dev.properties` produces a
`dev` build your phone refuses as an update.

**Keys from the vault (`wp-secret`, the experimental vault extension, not shipped by default).** The
keystore and its passwords can be vaulted instead of sitting on disk, and released per build with a
fingerprint on the phone.

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

Without `--ttl` each secret is kept as its own policy says. `wp-secret policy <id> --lease 8h` / `--no-lease`
changes a policy later without re-entering the value (one fingerprint).

- **`--as-file … --as-tmpfile`, never `--as-file` alone.** Gradle opens the keystore more than once;
  `--as-tmpfile` gives a regular 0600 file in a 0700 temp dir, deleted on exit, while a bare `--as-file`
  is a FIFO, which the build refuses by name.
- **An alias is not a secret:** set it plainly in front of `wp-secret`, not via `-- env NAME=… npm …`
  (a lease is keyed to the command's basename, and `env` would be one key for every command). The dev
  lease is keyed to `npm`, this folder and this tmux pane, so any `npm …` asking for those ids there gets
  them for 8 h; revoke it from the phone when done. The Play upload key has no lease, so it asks every build.
- **The Gradle daemon gets the environment per build**, so an earlier daemon sees this build's secrets and
  the next build without `wp-secret exec` does not. Keep the configuration cache off for signed builds
  (it is by default): turning it on would write the inputs into `android/.gradle/configuration-cache/`.

Vaulting the **debug** key buys nothing (its password is public). The **dev** key matters because the
`dev` shell updates itself from a downloaded APK: whoever holds it can build an update the phone accepts
as the same app. The Play upload key is never kept (a lost one is a Play support case).

### Attaching the dev APK to a release

The sideloadable APK reaches release users as a release asset the pairing page links (`pair.ts`
`releaseApkUrl`). Build it, then hand the file to the release build:

```bash
npm run apk:dev-release        # app/build/outputs/apk/dev/release/app-dev-release.apk
npm run release:build -- --apk=packages/app/android/app/build/outputs/apk/dev/release/app-dev-release.apk
```

The file is copied to `dist-release/<slug>-<version>.apk` (`releaseApkName` in `shared/brand.ts`, the
rule `releaseApkUrl` resolves) and named in `release.json`; upload it with the other assets. Before
copying, `scripts/release/apk-lib.mjs` reads the APK's applicationId (`apkanalyzer`/`aapt` if on PATH,
else it parses the binary manifest) and **refuses anything but the dev flavor** (`<appId>.dev`). A
play-flavor APK is rejected by name; an unreadable one fails the release rather than being attached
unchecked. The step never runs gradle or reads a keystore.

### Migrating from `dev.waterplane.app` to `dev.waterplane.app.dev`

`dev.waterplane.app` belongs to the Play build; the sideloaded build is `dev.waterplane.app.dev`. A
sideloaded app still installed under the Play id is not replaced: the dev build is a **new, side-by-side
install** with empty WebView storage (storage is per app; nothing copies it). Before switching, empty the
old app's send queue and copy out drafts and pad notes. Then install and pair the dev build (synced
settings, including the auto-install allow-list, re-sync on connect), re-grant the per-app permissions
(*install unknown apps*, notifications, background link, battery exemption, location), and uninstall the
old app; until then both answer `waterplane://pair` and Android asks which. Apps the old shell
first-installed stay owned by it for quiet updates (ownership follows the FIRST installer), so each asks
once more on its next update, or can be reinstalled from the new shell.

### Dependency verification (a tampered Maven artifact fails the build)

`android/gradle/verification-metadata.xml` pins a sha256 for every artifact the build resolves (plugins
and buildscript included). `verify-metadata` is on; `verify-signatures` is off (checksums only, so no
trusted-keys file to maintain). A mismatch fails the build with "Dependency verification failed".

After bumping AGP, Capacitor, `variables.gradle` or any dependency, regenerate (run `npm run sync` first
so `capacitor-cordova-android-plugins` exists):

```bash
cd packages/app/android
./gradlew --continue --write-verification-metadata sha256 \
  help assembleDebug assembleRelease lintDebug lintRelease \
  testDebugUnitTest testReleaseUnitTest :app:dependencies :app:buildEnvironment
git diff gradle/verification-metadata.xml   # read it: only the bumped coordinates should change
```

(`--continue` because `lintDebug` currently reports errors; the metadata is still written.) **A
verification failure means: regenerate if you bumped something, investigate if you did not.** An
unchanged coordinate with a new hash is what a tampered or republished artifact looks like.

### To rebrand

The shell's identity is generated from `packages/shared/src/brand.ts`. Edit `appId`, `displayName`, `name`
and `pairScheme` there, then:

```bash
npm run build:shared && npm run brand:android   # from the repo root
```

`scripts/brand-android.mjs` rewrites `capacitor.config.ts` (appId, appName), `android/app/build.gradle`
(namespace, applicationId), both `strings.xml` (labels; the dev flavor's is `<displayName> dev`), the
manifest's pairing scheme, and the Java package: it moves `src/main/java/<appId as dirs>/` and fixes every
`package`/`import` line and `<appId>.…` intent action. The `.dev` flavor suffix stays, so `dev` and `play`
keep distinct ids. It is idempotent; `--check` exits non-zero if anything would change, and
`npm run test:unit` runs it that way, so a hand edit that drifts from `BRAND` fails. It never touches
keystores or signing. Not generated: prose in comments and this README. A new `appId` is a new app to
Android and to Play (see the migration above for what that costs an installed phone).

---

## Wi-Fi security: what needs a new APK, and what a shipped one does

Reasoning is in `docs/notes/protocol-and-security.md`; what it defends is in `SECURITY.md`. **None of
this has run on a real phone**; the Java side has JVM tests (`ShellRouteTest`, `ShellTlsPinsTest`,
`ShellTlsClientTest`, `ShellBundleVerifyTest`, `ShellUpdatePinsTest`).

**Needs a new APK** (Java, so not over the air):

- the pinned Wi-Fi link: `ShellTls` (the pin set), `onReceivedSslError` in the WebView client (a
  conditional handler: it proceeds only on the stored pin and cancels otherwise), a pinning trust manager
  in `ShellLinkService` and `ShellPullService` (a host with a pin and a URL that is not protected means no
  dial, "locked: open the app"), and the `ShellRoute` port of the route rule;
- native bundle verification and the update-key pin store (`ShellBundleVerify`, `ShellUpdatePins`, with
  its own dialog: no `MainActivity` edit);
- `NetState.tailnet`, so a phone with Tailscale off stops treating `100.x` as safe.

**Ships over the air** (the page): the signature check and key pinning, pairing by the encrypted
exchange, the refusal of an `https` address in a redeem reply, the APK-install refusal on a route that is
not protected, the Wi-Fi route ladder (inert without the plugin) and read tickets.

**An older APK degrades to plain behaviour.** It learns the pin and ignores it, stays on plain Wi-Fi with
the warnings, and still takes a signed update through the page's check once it holds a key. Pairing by
link works as before with a code that never crossed the wire. On an old desktop a new APK offers no pin
and behaves as before. The first APK install over the network is unprotected whatever this does (Android
accepts any signature on a first install); Play is the clean path.

Google Play's scanner flags `onReceivedSslError` handlers that always proceed; this one proceeds only on a
stored pin.

## Known limits

- **Emulator coverage: API 34, 35 and 36.** Insets in portrait and both landscapes with the keyboard up,
  in gesture and 3-button navigation; Back and the predictive edge swipe unwinding one screen at a time
  and leaving only at depth 0; the download button reaching `/sdcard/Download` with the name taken from
  the `path` query parameter. The over-the-air loop was checked on an emulator against a live daemon:
  detect, download and verify all files, restart into the new build, prune the superseded bundle, and
  `bootFails=0`. Cold start in airplane mode renders the full UI from the APK.
- **One thing a real phone still settles.** On Android 16 Capacitor's `SystemBars` hands insets to the
  page only when the installed WebView's major version is 140 or higher, and every system image available
  ships 113, 124 or 133. Forcing that gate showed the strip drawn over the clock and battery with the
  opt-out approach, and the current listener approach unaffected. How a genuine WebView 140+ behaves is
  not shown, since Chromium's own safe-area fix may resolve `env()` there. On API 34 the listener pads by
  zero, so that run is a regression pass.
- **The navigation guard's two dialogs are verified on API 34, not 36.**
- **The LAN password gate works in the APK through a device token, not the cookie.** The httpOnly
  `SameSite=Lax` cookie is withheld cross-site (`http://localhost` → `http://100.x:8770`), so the shell
  mints a token and sends it as `Authorization: Bearer` on fetch and as a `-tok.` WebSocket subprotocol
  (`host/auth.ts`, `web/deviceToken.ts`). `ShellPullService` does not carry that token: `nativeEnqueue`
  hands it a URL and it adds only the WebView's cookie, which stays empty cross-site, so by the code a
  native download from a gated host is refused. Not seen on a device. Unaffected on the normal Tailscale
  path, where the gate is off.
- **Web Push does not reach the APK** (Android System WebView lacks the Push API). The substitute is the
  app's own WebSocket in a `specialUse` foreground service raising local notifications, with no Google
  dependency; see *Running in the background*. It is off until you switch it on in Settings or the phone
  setup sheet.
- **Debug-signed by default.** `npm run apk` produces `app-dev-debug.apk`, signed with your key when
  `keystore-dev.properties` exists and the debug key otherwise. The Play release needs the upload key.
- **iOS is simulator-only** (below): no push, no background pulls, no over-the-air bundle.

---

## iOS shell

Simulator only: there is no paid Apple Developer account, so nothing signs, archives or uploads, and there
is no APNs. `scripts/ios-sim.sh` (or `npm run ios:sim`) builds, installs and launches; the web bundle goes
to `ios/App/build/web`, never `packages/web/dist`, which is what the host serves to every phone.
Capacitor 8 resolves its iOS parts with SwiftPM, so there is no CocoaPods.

**The origin.** Android's page is `http://localhost` so the plain `ws://100.x:8770/ws` socket is not mixed
content. WKWebView refuses a custom handler for `http`/`https`, so iOS serves the page from
`capacitor://localhost`, and `capacitor.config.ts` pins `scheme: "capacitor"` so nobody "fixes" it:

- Mixed-content blocking keys off an `https` page, and `capacitor://` is not one, so `ws://` and `http://`
  to the daemon are allowed, the property Android gets from `http`.
- App Transport Security is the other gate: `Info.plist` sets `NSAllowsArbitraryLoadsInWebContent`
  (cleartext for the WebView only; the daemon is plain HTTP on the tailnet, by IP or MagicDNS name) and
  `NSAllowsLocalNetworking` (the LAN route). Native code does no networking of its own.
- `origin.ts` judges only `http`/`https` origins on host and port; `capacitor://localhost` is the one
  non-web origin, named exactly (`NATIVE_SHELL_ORIGINS`) (`SECURITY.md`).

**What is ported.** The web side never branches on Android: every native call looks its plugin up by name
(`shellBridge.ts`), so a missing plugin is absent, never a dead button.

| Android | iOS |
|---|---|
| `MainActivity` (keyboard, bar colours, deep links, resume nudge) | `ShellViewController.swift`: keyboard resizes the WebView, status bar follows the page theme read off the DOM, `waterplane://pair`, resume nudge. No back button on iOS. |
| `ShellSavePlugin` (bytes to Downloads) | `ShellSavePlugin.swift`, same methods, writes to Documents, shown in Files as *On My iPhone › waterplane*. |
| `ShellNetPlugin`, `ShellPullPlugin`, `ShellKeystorePlugin`, `ShellUpdatePlugin`, `ShellShare` | Not ported. Equivalents when wanted: `NWPathMonitor`, a background `URLSession`, Keychain with `SecAccessControl`, `setServerBasePath`, a Share Extension. |
| `ShellLinkService` stack, `ShellInstallPlugin` | Android-only. No background service on iOS (the replacement is APNs, paid program); install controls are hidden by `nativeInstallSupported()`. The notifications screen says there is no background alert (`shellLinkSupported()`). |

Checked in the Simulator (iOS 27): pair by deep link, repo and session sync, a prompt typed and answered,
the keyboard under the composer, outbox thumbnails, a download into Files, and a 60-second background stay
resumed with the link live.

**Build trap.** The first `xcodebuild` can hang at *Resolve Package Graph* on a SwiftPM file lock while
fetching Capacitor's two binary xcframeworks. Seeding `~/Library/Caches/org.swift.swiftpm/artifacts/` with
the two checksum-verified zips unblocks it; later builds are cached.

**Not done.** APNs push, a Share Extension, background pulls, the OTA bundle swap. Auto-download still
pulls every announced APK onto an iPhone, where it cannot be installed (it should skip `.apk` in the
automatic path where `nativeInstallSupported()` is false). Some copy is Android-worded ("inside the APK",
"in Downloads"). The status bar follows the page theme, so over the black image viewer on a light theme
the clock is dark on dark.

