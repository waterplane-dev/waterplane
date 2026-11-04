# Security Policy

## Supported versions

This is a solo/small open-source project with no release branches — only the
latest commit on `main` is supported. If you find a problem, check whether
it's already fixed on `main` before reporting.

## Reporting a vulnerability

Please report privately, not in a public issue.

Open a [GitHub private security advisory](../../security/advisories/new)
for this repository. That gives us a private channel to discuss and fix
the issue before any public disclosure.

Include what you'd include in any good report: the affected file(s)/commit,
steps to reproduce, and what you'd expect to happen instead. A PoC is
appreciated but not required.

### What to expect

This is maintained by one person, unpaid, alongside other things. There is
**no bug bounty**. Realistic expectations:

- Acknowledgment: usually within a few days.
- Triage (in scope or not, and how bad): usually within a week.
- Fix timeline depends on severity and my availability — could be days for
  something clearly in scope and serious, could be longer for anything
  lower-severity. I'll keep you posted rather than go silent.

If you don't hear back after a reasonable wait, a follow-up comment on the advisory is fine.

## Threat model

waterplane's daemon spawns the real `claude` CLI (and, for the build feature,
arbitrary shell commands you've configured) in a PTY. That process can read,
write, and execute anything the account running it can. **The security
boundary is entirely about who can reach the daemon at all — not about
sandboxing what a connected, authorized caller can do once they're in.**
See `CLAUDE.md`'s "Security model" section for the full architecture; the
summary:

- By default the host binds only **loopback** and the machine's **Tailscale
  IP**. Reaching it at all normally requires being on the same tailnet as the
  machine — Tailscale's own device auth is the real gate. On Windows the host
  runs inside WSL2 with mirrored networking: its loopback is shared with
  Windows, so "loopback" there means any process on the Windows machine too —
  the same local-machine boundary as on a Mac, and the `Origin`/`Host` checks
  still apply to browsers on it.
- `WATERPLANE_ALLOW_PUBLIC=1` additionally binds LAN interfaces. Connections
  classified as `lan` (see `peerKind` in `packages/host/src/net.ts`) are then
  required to authenticate with a password (`packages/host/src/auth.ts`):
  scrypt-hashed, stored under `<state dir>/auth.json`. With no password set,
  LAN callers are refused outright
  ("deny until set"). An optional `gateTailscale` toggle extends the same
  password requirement to Tailscale peers too, for defense in depth.
  Loopback is always trusted and can never be gated — it's the local
  management path.
  An unreadable `auth.json` is moved aside and treated as "no password" —
  still deny-until-set for LAN — and if its bytes may have held
  `gateTailscale`, Tailscale stays gated too until the password is set
  again from loopback. A corrupt file never opens the gate.
- **Funnel is never trusted.** A loopback request carrying `Tailscale-Funnel-Request` (what
  `tailscale funnel` adds, from the public internet) is classed `public` (`requestPeerKind` in
  `net.ts`, used by the token gate, the host-management routes and `/api/peer*`): it always needs a
  token and can never manage auth or mint pairing codes. Behind `tailscale serve` every socket is
  loopback, so the rate limiter (`ratelimit.ts`) keys on the real client address serve writes into
  `X-Forwarded-For` (only when the socket is loopback and a proxy header is present), not on
  127.0.0.1. `POST /api/auth/login` is rate-limited per address (429 + retry-after) before the
  password hash is checked.
- **Device tokens.** Every token belongs to one row of the paired-device
  ledger, `<state dir>/devices.json` (mode 0600): 32 random bytes,
  base64url, returned once and kept on disk **only as its sha256**, looked up
  with a constant-time compare. Tokens survive a host restart; revoking a row
  (`POST /api/devices/revoke`, authenticated) kills its token at once and
  closes that device's open sockets — the close frame first, then the socket
  is torn down after one second whatever the peer did with it, and a frame
  that still arrives from it meanwhile is dropped, not dispatched
  (`socketAuthorized`, asked for every frame); setting, changing or clearing
  the password drops every row. A browser gets one from `POST /api/auth/login`
  as an httpOnly cookie. The Android shell (whose cross-site cookie is
  withheld) mints one with `POST /api/auth/token` — **only from a caller that
  is already trusted** (loopback, or a Tailscale peer holding a valid token
  when that path is gated — never LAN or Funnel, even with a token), so no password is retyped over the tailnet, and never while no
  password is set — and carries it as `Authorization: Bearer <tok>` on HTTP
  and as the WebSocket subprotocol `waterplane-tok.<tok>` on the upgrade (the host
  echoes only the base protocol, never the token). No token is valid while
  no password is set.
  On the phone the page keeps its tokens in the app's private localStorage; the
  APK's background link keeps a second copy of each gated desktop's token so it
  can reconnect with the app swiped away, AES-256-GCM sealed under a non-exportable
  Android Keystore key (`ShellLinkTokens`), bound to that desktop's id and address,
  sent only to that desktop's saved tailnet address, deleted when the desktop is
  removed, the token is refused or the link is switched off. **Stated residual:**
  the key needs no user authentication, because nobody is holding the phone when
  the service reconnects, so this protects against a copied file, not against code
  running as this app. That residual holds only while the phone's sign-ins are not
  locked: with *lock the desktop sign-ins* on (next bullet), the link keeps no copy at rest.
- **Sealed sign-ins (optional, off by default).** Settings › Connection ›
  *lock the desktop sign-ins* (Android app) puts this phone's device tokens in one
  blob under a Keystore key that each use opens with the fingerprint, or on a newer
  shell the phone's PIN, and removes the plaintext. **It guards against a copy of
  the app's storage (a backup, a pulled file), not against a hand holding the
  unlocked phone** (that is the app lock, and the process holds the tokens in plaintext
  memory while running). A desktop with no password has no token, so there is nothing
  to lock for it. The background link, per APK: a newer app keeps each token in
  memory only (alerts continue after a swipe-away until the phone restarts or
  Android stops the app, then "locked — open the app"); an older app is handed no
  token, so alerts from gated desktops wait until the app is opened. Nothing on the
  host changes. **Stated residuals:** a token the desktop revoked stays in the blob
  until the next rewrap; a stray bare token that belongs to no saved desktop can stay
  plaintext (the row says so); passive (kids') tokens are not sealed; on an older
  app the start prompt is the fingerprint only, and on a plain-HTTP route that app
  refuses the key, so its card stays until the route is the tailnet or HTTPS (the row
  refuses to lock in that state, and the host setup form refuses to save a plain
  address while that app has both locks on); the recents thumbnail is as before; and a lost key
  (screen lock removed, or a new fingerprint on a fingerprint-only key) loses the
  sign-ins, so a tailnet-gated desktop must be paired again. A missing sensor never
  counts as a lost key, and a lost one's blob is set aside on the phone
  (`tokenSealDead`), not deleted; nothing restores it yet, and the next lock's new key
  makes it unreadable. A key that is dead but not worded as such by an OEM stays a
  refusal, and the person's way out is *forget the locked sign-ins* (confirmed, behind
  the app lock): it discards the blob by hand, which gives a stranger nothing. "Nothing
  connects before the unlock" is true of the socket only: tokenless HTTP, such as the
  app-update check, runs first, carrying no token.
- **App lock (optional, off by default).** The Android app can require the
  phone's fingerprint, or on a newer shell its PIN, before it shows its screen
  (Settings › Connection › *lock this app*). **It is a hold-the-phone defence at
  UI level and nothing more.** No host route, token, gate or wire message changes;
  deny-until-set, token rotation, the passive allowlist and the origin checks are
  untouched, and **the device token's storage is unchanged** unless *lock the desktop
  sign-ins* is on (localStorage, plus the sealed copy above). The page stays mounted behind an opaque card. Stated
  residuals: anyone who has the phone's PIN passes it (the PIN fallback, or by
  enrolling a finger); the recents thumbnail, and the frame the WebView shows on
  wake before the page's JS runs, still show the last screen. The lock fails
  closed: a cancelled, failed, locked-out or unrecognised refusal never opens the
  app, at any repeat count. It opens and switches itself off (saying so) only when
  the phone's own credential had to change the key, the app's saved check is
  unreadable, or a fresh status read confirms no sensor or nothing to check with.
  So on an old APK with a dead sensor that still reports hardware, or on a plain
  HTTP route (where the old APK's key use is refused), the way out is a newer APK,
  another route (the tailnet or HTTPS), or clearing the app's data.
- **LAN identity.** `<state dir>/lan-identity.json` (0600) holds a `hostId`
  and a secret. `GET /api/lan/identity` hands them out to loopback and
  Tailscale callers ONLY — refused (403) for every other peer kind before the
  token gate, so a LAN token never unlocks it. `POST /api/lan/verify {nonce}`
  answers anyone (pre-auth, rate-limited per remote IP) with
  `HMAC-SHA256(secret, hostId + "\n" + nonce)`, and the phone sends a token
  over LAN only after that MAC checks out. **Stated residual:** this proves
  the thing answering at a LAN address holds the secret; it cannot resist an
  **active relay** on the person's own Wi-Fi that forwards the probe to the
  real desktop and then reads the plain-HTTP traffic (the token included).
  With the token that relay can drive the desktop. It could also answer the app
  with a forged page. So the Android app asks of every route whether it is
  *protected* (`isPlainRoute` in shared, mirrored natively by `ShellRoute.java`),
  and on one that is not it refuses every fingerprint use, every over-the-air
  update and every app download or install, and warns in the address form, the
  health sheet, the strip ("LAN, not protected") and a toast.
  **The protected-route rule.** A route is protected only if it is exactly one
  of: loopback; a Tailscale address or MagicDNS name over `http`, or `https` to a
  `*.ts.net` name, unless a newer app reports that the phone has no tailnet
  (then a tailnet name proves nothing: with Tailscale off, `100.x` goes to the
  Wi-Fi gateway); the desktop's own TLS address on a newer app that holds its
  pin; or an `https` address the person typed themselves. Everything else is
  plain, **whatever its scheme**: a relay with a public certificate for its own
  name passes `https` validation. A reply from a desktop that has not proved
  itself (anything not sealed by the pairing code, or not received over a
  protected route) never sets a saved desktop's address, key, pin or identity,
  so a relay cannot walk a row onto itself. **Stated residuals:** a row saved
  by an older app may already hold an address someone planted (a non-`ts.net`
  `https` one reads as plain and the app opens an empty field to retype it; a
  planted `ts.net` or `100.x` one cannot be told apart); and a person who taps
  "pair" on a pairing link someone else made pairs with whoever made it (the
  confirm says so). A browser on plain HTTP has no such defence, because the page
  itself is what arrives unprotected, and the token is still exposed to the
  relay. An older app keeps the older answer (tailnet and HTTPS only).
  Plain HTTP on a LAN has no defence against a man in the middle; if that
  network is not trusted, do not enable `WATERPLANE_ALLOW_PUBLIC`.
- **LAN TLS and the pin** (`packages/host/src/lantls.ts`). Only where
  `WATERPLANE_ALLOW_PUBLIC=1` already binds LAN addresses, the host also
  listens on `WATERPLANE_TLS_PORT` (default port + 1) on those same addresses
  with the same handler and the same gate, so a caller there is still peer kind
  `lan` and needs its token. Off with `WATERPLANE_TLS=0`; never on loopback or
  the tailnet; nothing without the opt-in. The key is P-256 in
  `<state dir>/lan-tls.json` (0600), kept across restarts; the certificate is
  self-signed and re-issued on the same key when the addresses change, so the
  phone's pin (SHA-256 of the key) survives. The app stores the pin per desktop
  and enforces it in the WebView, the background link and the pull service; a
  desktop with a pin is then never reached over plain HTTP on a LAN address.
  A self-signed port does not serve the web app (it answers a notice page): a
  browser click-through would look protected and is not. With
  `WATERPLANE_TLS_CERT` + `WATERPLANE_TLS_KEY` (a person's own leaf from a CA;
  a self-signed one is read as self-signed) it serves the app, and the pin
  follows that leaf. **What the pin does not defend:** the
  WebView's handler runs only when validation fails, so a certificate valid
  under a CA the phone trusts would skip the pin inside the WebView (pinned
  addresses are private IPs and `.local` names, which public CAs do not issue,
  and the app trusts no user-added CA); a first install of the APK over the
  network (Android accepts any signature then); code already running in the
  page; a browser; and dropping packets. The pin is a property of a newer APK:
  a shipped one learns it and ignores it, and stays on plain LAN with the
  warnings. The way out of a pinned desktop whose TLS port is off is a
  confirmed "use plain HTTP for this desktop" on its row; nothing does it
  by itself. The spike behind this (measured on two emulator WebViews only)
  is in `docs/notes/protocol-and-security.md`. **None of this has been tried on
  a real phone yet.**
- **Signed updates** (`packages/host/src/updatekey.ts`, `webbundle.ts`,
  `packages/web/src/updateTrust.ts`, `ShellBundleVerify.java`). Each desktop
  signs its web bundle's manifest with its own P-256 key
  (`<state dir>/update-key.json`, 0600), not a project key: people build their
  own bundles, and a private key shipped to every desktop is no key. The
  manifest carries `signed` (hostId, build id, `gen`, the file list with hashes)
  and `sig`. A phone learns the desktop's public key from `welcome` only when
  the delivering socket's address was protected (above), so a relay cannot
  hand it one. Once a phone holds a key, an update that is unsigned, badly
  signed, for another desktop or older than the last it took (`gen`, which
  rises when the served build id changes, so a real revert still works) is
  refused and nothing is written. The check runs in the page (works on a
  shipped APK) and again natively on a newer one, which also asks in its own
  dialog the first time it sees a desktop's key, a changed key, or a
  restored desktop; page code cannot tap it. A new key (a wiped state dir) or a
  lower `gen` (a restored one) waits for that answer. **What it does not do:** a
  signature proves the bundle came from the desktop you paired, never that
  its code is good. **A hostile desktop can still ship anything**, and a
  paired host stays fully trusted (last section). A passive (kids') phone opens
  no socket, so it never learns a key and takes updates as before, over a
  route that is protected or it would take none. A shipped APK without the
  native check has the page's check only, so page code that is already
  compromised can still persist a bundle there. A desktop that cannot read or
  write its key file serves the bundle unsigned (logged once): a phone that
  holds a key then refuses it and says to update or repair the desktop.
- **Pairing with no tailnet** (`pairpake.ts`, `shared/pake.ts`). A phone
  pairs by CPace over ristretto255 keyed by the 8-character code, on the plain
  port: the phone proves it knows the code first, the host answers with a
  sealed reply (token, `hostId`, TLS pin, update key, LAN identity), and the
  seal authenticates the host. A relay gets one online guess per attempt; an
  impostor host answering `start` gets at most five, one per share it sends,
  which is all a phone will answer. A real host offers the five newest open
  codes, each confirm checked against all of them in constant time, so with
  more than five open an older code never pairs this way: its phone is told
  the desktop does not know that code and to show a new QR, which then works,
  and the attempt counts as a miss against the five offered. A session lives
  60 s and is deleted on its first `finish`.
  10 wrong confirms close a code *for this pairing only*: it still redeems over
  the tailnet, so a device on the Wi-Fi can stop an encrypted pairing (as
  dropping packets does) but cannot burn a code meant for the tailnet. The
  desktop refuses with no password set. **A code never crosses a plain socket
  and lives:** on one that is not loopback, the tailnet, `tailscale serve` or
  TLS, `/pair/<code>` and `/pair/<code>/apk` burn the code and show a page with
  no link and no APK; a LAN-only desktop's screen shows the deep-link QR, which
  goes camera to app. A code already sent plain is dead on that phone. The
  link also carries a 128-bit commitment to the key and pin, which the seal
  must match. **Stated residuals:** a person who accepts the question that
  appears for an older desktop (it cannot tell an old desktop from someone
  blocking encrypted pairing) spends that code and token in the clear, as
  before; a relay can fill the miss count and stop pairing; whether every
  camera app opens the waterplane link is unverified, and the typed code runs the
  same protocol; the first APK install over the network is unprotected.
  `waterplane pair` prints the update key's fingerprint beside the code.
- **Read ticket** (`auth.ts`, `POST /api/auth/read-ticket`). An image tag or a
  download link cannot carry a bearer, so a phone with no tailnet could not
  load them. A signed device token buys a one-hour ticket (HMAC of device id,
  scope and expiry; the key lives in memory, so a restart voids every
  ticket) that is accepted as `?wt=` **only** on the two opaque read routes
  (`OPAQUE_READ_ROUTES`), **only** over the TLS socket, GET/HEAD only, only
  while the device row exists, and held to the row's scope (a passive phone's
  ticket gets what a passive token gets). Access logs, shares and copies
  strip `wt`. A ticket in a URL is a credential for those two read routes for
  up to an hour: do not paste such a URL.
- **A phone with Tailscale off.** It reaches the desktop only on the Wi-Fi.
  A shipped APK stays on plain LAN with name-based trust as before, except
  that an update key it already holds still refuses a forged bundle. A newer
  APK pairs by code, holds the pin and goes over TLS. A phone that never
  learned a pin cannot tell a relay from the desktop on the first
  plain contact; pairing by code is the fix. The password-change case: tokens
  rotate as before, so a LAN-only phone must pair again, and its gate says so
  rather than asking for a password that cannot work there.
  On a shell that enforces pins, a page that knows Tailscale is off sends no
  device token to a tailnet address, pinned or not, since only the Wi-Fi can
  answer it. Until the shell's first network reading it holds the token back on
  those addresses and learns no pin, for at most 8 seconds; a shell silent past
  that falls to trust by name. The background link is not covered on an unpinned
  row: it sends its token to the address it holds, as before.
- **Pairing codes** (`packages/host/src/pair.ts`). `POST /api/pair/mint`
  sits behind the normal gate; the 8-character code lives 10 minutes, is kept
  in memory only as its sha256 (a restart invalidates every outstanding one),
  at most 5 are live, and it is spent by its first successful
  `POST /api/pair/redeem` — the one pre-auth route that can mint a device
  token, rate-limited per remote IP (5, then one per 10 s). Redeem mints a
  token only while a password is set; with none, a LAN redeemer is refused
  before the code is spent (deny-until-set). The LAN identity secret goes only
  to a loopback/Tailscale redeemer. `GET /pair/<code>` (landing) and
  `/pair/<code>/apk` are outside `/api/` and the token gate so a brand-new
  phone can load them, and reveal nothing about the desktop until the code
  checks out; they carry `no-store`, `X-Frame-Options: DENY`, a
  `default-src 'none'` CSP and `no-referrer`. They are NOT in
  `OPAQUE_READ_ROUTES`.
- **Passive devices** (the kids' phone). Pairing can mark a device
  "passive": its ledger row stores `scope: "passive"` (rows without it are
  full scope). The host holds such a token to a **default-deny allowlist**
  (`passive.ts`): `GET /api/health`, `/api/webbundle[/file]`, `/api/theme`,
  `/api/passive/state`, and `GET /api/repos/<id>/artifact` only for an APK
  that is in the auto-pull queue at that moment — every other `/api/` route
  (403) and the WebSocket (closed 4403) are refused, and `/api/auth/token`
  never mints it a full token. A passive pairing needs a password and
  switches "gate Tailscale" on; while any passive row exists the gate cannot
  be switched off, so the phone has no tokenless path on Tailscale or the
  LAN. A request that reaches loopback through `tailscale serve` (it carries
  a proxy header) is classed as a Tailscale peer by the gate, so the gate
  applies to the https address too. **Unlock:** a PIN (4–12 digits,
  scrypt-hashed in `<state dir>/passive-pin.json`, 0600) set only from a
  trusted caller that is not passive (`POST /api/auth/pin`);
  `POST /api/auth/unlock` checks it, rate-limited per device (5, then one per
  minute), and lifts that one token to full scope for 30 minutes, held in the
  host's memory only — expiry, "Lock now" (`POST /api/auth/lock`), a PIN
  change or a host restart end it, and its sockets are closed. **Auth
  material is the one part of full scope an unlock never grants**, because
  each piece would outlive the 30 minutes: an unlocked passive device still
  cannot mint a pairing code (`POST /api/pair/mint` — a redeemed code is a
  permanent full token) or a device token, revoke a device, pair or unpair a
  peer (`/api/peers` writes), read the LAN identity secret, or set the
  password, the Tailscale gate or the PIN. Three places say no: `passive.ts`'s
  `passiveNeverAllows` for the pairing, revoke, peer and identity routes
  (checked in `server/http.ts` right after the allowlist), the `/api/auth/token`
  and `/api/auth/pin` handlers' own scope checks, and the WebSocket
  `auth.set`/`auth.clear`/`auth.gateTailscale` ops (`routes/system.ts`, by the
  socket's device row). A passive caller that knows the PASSWORD itself can
  still log in like any browser — the PIN model never covered that.
- Password management (`auth.set` / `auth.clear` / `gateTailscale`) is only
  accepted from an already-trusted connection (loopback or Tailscale). A LAN
  caller — even one who knows the current password — can never set or change
  it, only authenticate with it.
- `POST /api/hook` (the sink the spawned `claude` process posts lifecycle
  events to), `POST /api/plugin/<id>/hook` and `POST /api/shell/open` answer
  only a process on this machine, regardless of any other setting: the socket
  peer must be loopback AND the request must carry no reverse-proxy header
  (`X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `Via`, `Tailscale-User-*` —
  one list, `net.ts`'s `localProcessRefusal`). Loopback alone is not enough:
  behind `tailscale serve` every tailnet request arrives from 127.0.0.1.
  A loopback request whose `Host` names anything but this machine's loopback is
  treated as proxied; a reverse proxy that forwards neither a proxy header nor
  the client `Host` is treated as local — front the daemon only with one that
  sets `X-Forwarded-For`.
- A shell session (a plain login shell in a repo, `backends/shell.ts`) is the
  same `session.create` op behind the same gates as a `claude` session and
  widens nothing. Its `$BROWSER` shim posts to `POST /api/shell/open` (local
  process only, above) and stores nothing for an unknown session; a URL with
  userinfo in its authority (`https://github.com@evil.tld/`) is never
  published. Only a person's tap opens one: a job (the intent tick, the
  backlog, a fan-out, an agent's post) and a peer desktop's job are refused.
  The shell does not inherit the daemon's API keys and key files
  (`*_API_KEY`, `*_KEY_FILE`, `*_KEYCHAIN` are unset in the pane), and its
  commands are never written to the session's prompt history.
- **Live desktop** (`packages/extensions/desktop`, macOS, and Windows with the host in WSL; experimental). Watching is a
  stream on the same device-token socket and widens no gate. **Control is
  arbitrary input on the desktop** (clicks and keys reach every app, password
  managers and a logged-in terminal included), so it carries the same trust as
  the PTY and is a separate setting, **off by default**. It is gated on the
  host, not only on the phone: with it off, `stream.input` is dropped before it
  reaches the helper, and with it on a Mac still needs the macOS Accessibility
  grant. Windows asks no app for a grant, so there the host's switch is the only
  gate. A peer token never reaches a stream (`/api/peer/*` only), and no job,
  schedule or peer desktop opens a desktop stream. The helper `wp-desktop` runs as the desktop user and capture runs only while a
  view is open. On a Mac it is signed with a stable identifier and holds only the
  Screen Recording and Accessibility grants a person gave it there (it asks macOS
  only when a person taps Fix on a setup row), and macOS shows its own recording
  indicator the whole time. Windows shows no such indicator.
- **Browser origins** (`packages/host/src/origin.ts`). Every `/api/*` request
  and WebSocket upgrade is checked on `Origin` and `Host`; only `http`/`https`
  origins naming this machine on a port it serves pass, plus exactly one
  non-web origin: `capacitor://localhost`, the iOS shell's page (WKWebView
  cannot serve an app from `http`, so it is the twin of the Android shell's
  `http://localhost`). Any other scheme is refused, and the CORS header only
  ever reflects an origin that passed — never `*`. `*.ts.net` is accepted by
  suffix only while on a tailnet whose MagicDNS name could not be read, only
  for requests arriving through `tailscale serve`, and only when the Origin
  names the same host the request was sent to; the name is re-read
  until known.
- `/api/agent/intents`, `/api/agent/backlog`, `/api/agent/followup` and `/api/agent/exposure[/triage]` (an agent in a driven repo
  posting work for later, `agentintents.ts`; marking a crash / exposure finding, `agentexposure.ts`: a read, and a mark that needs a live session, never a clear) answers only a loopback caller that is neither a browser
  (any `Origin` or `Sec-Fetch-Site` header is refused, same-origin included)
  nor proxied (`tailscale serve` forwards to 127.0.0.1, so the same
  reverse-proxy headers as the hook sinks above are refused). It adds no new power:
  a posted row goes through the same containment gate and the same store as
  the phone's `intent.post`, cannot bring a budget waiver, and waits for the
  person's auto-fire switch and budget like any scheduled item; a backlog add
  never starts at all until the person fires it.
- **Consent is the phone's, checked on the host** (`confirmgate.ts`). The
  checklist fixes that act on the person's behalf (`CONFIRM_GATED_FIXES`:
  accepting Google's Android SDK licence and downloading the toolchain, making
  a signing key, writing a repo's Claude settings) and the first-app job
  (`POST /api/onboard`, and `/api/onboard/resume` when it adds consent) need
  BOTH a browser `Origin` that passes the origin gate (an Origin-less request,
  allowed everywhere else, is refused here) AND a one-shot token, 15 minutes,
  minted by the GET that draws the confirm (the compliance report, the onboard
  plan, the stopped job) and bound to that worktree + fix id, that path + the
  consent ids the screen listed, or that job. A gated fix never runs inside a
  "Fix all" list. Honest scope: a process running as you can run `sdkmanager`
  itself, so this does not stop a determined local program; it stops the
  spawned `claude` agent, a plugin or a script from accepting a licence with
  one undocumented POST, and every refusal is logged.
- **Ask rules** (`packages/host/src/askrules.ts`). A desktop-wide list of
  permission rules (`Bash(git push * main)`, `npm publish*`, ...) is passed to
  every spawned `claude` as `permissions.ask` in the `--settings` flag, which
  outranks anything the agent writes into the repo's settings and holds under
  bypass-permissions; the resulting box is answerable only by a person's tap.
  Changing the list (`PUT /api/askrules`) needs a browser `Origin` and a
  one-shot confirm minted by the GET for the list's current revision, so a
  `curl` with a forged header cannot delete a rule and a stale phone cannot
  overwrite a newer list. It reaches `claude` sessions started on this
  desktop only: a peer desktop's jobs run under that peer's own list, and the
  host's own headless calls (review, assess) take no rule. The state file is
  read at boot, so a same-user edit of it takes effect at the next restart.
  Honest scope: it stops the accident, not a wrapper script the rule cannot
  see or an agent talking you into Yes.
- **Toolchain downloads** land in a fresh `mkdtemp` directory (0700) under the
  per-user data dir, are created with `O_EXCL`, and are hashed and unpacked
  from there, never from a shared temp dir another local account could plant
  a file or symlink in.
- **Files the host rewrites inside a repo** — `.gitignore` (the secret writer,
  the checklist's gitignore fix, the signing-key link), `CLAUDE.md` and
  `.claude/settings.json` (checklist fixes) — are written through an in-repo
  symlink but never through one that leaves the worktree: a committed
  `.gitignore -> ~/.gitconfig` is refused in words (`writeTextAtomicKeepMode`'s
  `within`), the same realpath rule the file routes apply to reads. The repo
  walks (tree search, artifact discovery, directory entry counts) neither
  descend into nor list the contents of a link whose target is outside the
  worktree (the link itself is shown as a link, nothing more).
- **A repo's own repo-health engine** (`tools/repohealth.mjs`, run by the host
  after one approval — `repohealthapproval.ts`) is pinned by a hash of the
  entry, its siblings and every module it imports with a plain relative path,
  static or dynamic. An engine whose loads the hash cannot see is never
  approvable and the phone is told why: an `import()`/`require()` argument that
  is not one plain string, `eval`, `Function()`, `vm`, a worker, loader hooks, a
  `#` import-map entry, a module from a URL or an absolute path, an import
  outside the repo, a dependency committed under any `node_modules` or reached
  by the repo's own package name, or a tree too big to read whole. Honest scope:
  a comment- and string-aware text scan, not a parser — it closes the plain
  shapes; an engine that spawns `node <file>` or reaches code through an alias
  the scan does not know still runs what the approval never saw.
- **Plugins** (`packages/host/src/plugins/`, `docs/notes/plugins.md`) are code
  the machine's owner put in their own config dir (`~/.config/waterplane/plugins/`
  or `plugin-paths.json`). They run in the daemon's process with its rights —
  the same trust as the daemon, crossing no boundary it has not. The phone
  never runs plugin code: it draws what a plugin declares. A plugin answers a
  choice box only through the core's answer gate (`answergate.ts`: the
  manifest's `answers`, a per-session switch default OFF that only the phone
  flips, the same box it was told about, never a trust/tool/plan box or one
  naming something destructive or secret), reads files only through the
  containment guard, and — when loaded from outside this repo — reads only
  the env names its manifest declares (the in-repo extensions under
  `packages/extensions/` are part of the host and read its own knobs directly).
  Nothing on the network can install, load or reload one.
- **Peer tokens (paired desktops).** Two waterplane hosts can be paired so one
  delegates a job to the other (`<state dir>/peers.json`, mode 0600;
  outbound rows keep the token, inbound rows only its sha256). A peer token is a
  scoped credential: it unlocks `/api/peer/*` and nothing else, and a device
  token never unlocks those routes. Managing pairings (`/api/peers`) is allowed
  on the trusted path only (loopback and Tailscale, never LAN), the same rule as
  the password. `/api/peer/*` is exempt from the device-token gate in
  `server/http.ts` because `peers/routes.ts` applies a stricter check: trusted
  path kind, then the peer bearer token, then the peer API version header; an
  unknown token gets "not paired" and the refusal is logged with the remote
  address. Changing the password does NOT rotate peer tokens (a separate ledger;
  unpair to revoke). Peer addresses are tailnet or loopback only (100.64/10,
  `*.ts.net`, 127.0.0.1), never `*.local`. Honest scope: a tailnet client that
  sends no `Origin` can already drive a host over its WebSocket, so pairing gives
  a peer no power a tailnet process lacks. It makes delegation named (the
  "from peer" mark can be trusted) and refusable, not a new privilege class. A
  delegated job runs as an ordinary backlog row on the peer, held by that
  owner's auto-fire switch and budget, in a detached worktree
  (`<clone>/.claude/worktrees/peer-<from>-<key>`), and refuses to restart or install
  the peer's running daemon (the marker is checked by `scripts/restart.sh` and
  `deploy/install-service.sh`). `GET /api/peers` lists the peers from loopback or
  Tailscale only and reports this daemon's own tailnet address, never a LAN one.
- **The installer** (`curl -fsSL https://github.com/waterplane-dev/waterplane/releases/latest/download/install.sh | sh`,
  generated from `deploy/install.sh.tmpl`) is code you run as yourself, so
  read it first if you prefer: download it, open it, then `sh install.sh`.
  It edits no shell rc file and runs at most one `sudo` line — the Linux
  package manager installing `tmux` — and only after asking on the terminal;
  everything else is unprivileged. It verifies the Node runtime
  against nodejs.org's `SHASUMS256.txt` and the release archive against the
  `.sha256` published beside it, and installs nothing on a mismatch. Those
  checksums come over the same HTTPS channel as the files, so on their own
  they catch only corruption. **Who published the release** is checked too:
  the `.sha256` carries an Ed25519 signature (`.sha256.sig`) made with the
  project's offline release key, and the installer verifies it — with the
  Node it has just checked against nodejs.org — against the public key
  written into the script itself (`deploy/release-pubkey.pem`). A missing or
  wrong signature installs nothing. That defeats a compromised release page,
  GitHub account or mirror that swaps the archive and its checksum together.
  It does not defeat a compromised signing key, nor an `install.sh` that was
  itself swapped (the key travels inside it — read it, or compare it with the
  one in the repository). Rotating the key means a new `install.sh`: copies
  already downloaded trust only the old key. `WATERPLANE_INSECURE_SKIP_SIG=1`
  skips the check, loudly, for a release you built yourself. **Honest scope,
  freshness:** the signature proves who published a release, not that it is
  the newest — whoever can write the release assets can keep offering an
  OLDER signed release as "latest" (a freeze), though never one below the
  version already installed, which `waterplane update` refuses. A signed
  expiry would close that and needs re-signing on a schedule; until then a
  "current" that stays put for long is worth a glance at the releases page.
  `waterplane update` holds a release to the same rule with the same key,
  embedded in the host (`host/cli/releasesig.ts`, test-pinned to
  `deploy/release-pubkey.pem`): it verifies `release.json.sig` before it
  reads `release.json` (which decides the version it fetches) and
  `.sha256.sig` before it trusts the `.sha256`, and a missing or wrong
  signature refuses the update — nothing is installed and the current version
  is untouched. The same `WATERPLANE_INSECURE_SKIP_SIG=1` skips it, with a
  warning on every run; the doctor's self-update row believes a newer release
  only after the same check. The
  login service it installs (`waterplane service install`) bakes in only PATH,
  HOME, its own state dir (and the root and Claude config dir when the shell
  named them) and the variables passed with `--env`, never the installing
  shell's environment, and refuses `WATERPLANE_ALLOW_PUBLIC` outright: a public bind
  stays an explicit, visible opt-in in `.env`.
- **`node-pty` is pinned to a pre-release (`1.2.0-beta.15`) on purpose.** The
  stable 1.1.0 leaks two file descriptors into the daemon on every macOS spawn
  (a spare `/dev/ptmx` and the child's slave), which exhausted the machine's
  pseudo-terminals; the 1.2.0 betas fix it. The pin is exact, the published
  package's `npm-shrinkwrap.json` holds it, and `ptyleak.test.mjs` guards the fix.
  Scanners that flag the pre-release or node-pty's install script (a native
  build fallback; prebuilt binaries ship in the package) are seeing this choice.
  It moves to `1.2.0` once that is released stable.

### In scope

Bugs that let someone who should **not** be able to reach or drive the daemon
do so anyway, e.g.:

- Auth bypass: reaching a gated (LAN or `gateTailscale`) daemon without a
  valid password/token, or forging/replaying/extending a token.
- Cross-origin or DNS-rebinding attacks that let a malicious web page drive
  the API/WebSocket from a browser already on the trusted network.
- Path traversal in the file/git endpoints (`packages/host/src/files.ts`,
  `packages/host/src/git.ts`) that reaches outside the intended repo root.
- Injection bugs (shell, argument, or otherwise) reachable from network
  input rather than from the operator's own configured commands.
- Anything that lets a LAN-classified caller manage auth (set/clear the
  password, toggle `gateTailscale`) — that's supposed to be impossible.
- Secrets (VAPID keys, auth password hash, tokens, `<state dir>/*.json`) leaking
  to a caller who shouldn't be able to read them.

### Out of scope (by design)

- **Anything an authorized, already-connected caller can do.** The whole
  point of this project is that a trusted device can drive `claude` and run
  configured build commands — both of which execute arbitrary code by
  design. An authorized caller can read/write files in scanned repos, run
  git commands including `push`, run saved build commands
  (`packages/host/src/builds.ts`), and — via whatever `claude` itself can
  do — read the screen, use the clipboard, or run anything else the desktop
  user could run themselves. None of that is a vulnerability; it's the
  product.
- **Exposing the daemon to an untrusted network is a misconfiguration, not a
  vulnerability.** `WATERPLANE_ALLOW_PUBLIC=1` and/or binding `WATERPLANE_HOST` to a
  public interface are explicit opt-ins with a loud warning in the README.
  If you do that and then something bad happens because a stranger reached
  the daemon, that's expected behavior working as documented, not a security
  bug to report here.
- Denial of service from a caller who is already authorized to reach the
  host (e.g. spamming sessions, filling disk with uploads) — annoying, but
  not a security boundary violation. Feel free to file it as a regular
  issue/PR if you have a fix in mind.
- Vulnerabilities in the `claude` CLI itself, in Tailscale, or in other
  third-party software this project invokes but doesn't ship. Report those
  upstream.
- Anything that requires physical access to an already-unlocked machine
  running the daemon.
- **A paired host is fully trusted by the Android shell.** The app's UI
  updates over the air from the host it is paired with
  (`packages/web/src/webUpdate.ts`). Its bundles are signed with a per-desktop
  key the phone pins over a protected route, which stops a relay on the network,
  never the desktop itself: a host you pair with can ship JS that runs with the
  shell's native plugins. Pair only with desktops you control.

If you're not sure whether something is in scope, report it privately anyway
and let us sort it out together — a false positive costs us a few minutes; a
missed real bug costs a lot more.
