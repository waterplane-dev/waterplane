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
  Plain HTTP on a LAN has no defence against a man in the middle; if that
  network is not trusted, do not enable `WATERPLANE_ALLOW_PUBLIC`.
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
- **Live desktop** (`packages/extensions/desktop`, macOS, experimental). Watching is a
  stream on the same device-token socket and widens no gate. **Control is
  arbitrary input on the desktop** (clicks and keys reach every app, password
  managers and a logged-in terminal included), so it carries the same trust as
  the PTY and is a separate setting, **off by default**. It is gated on the
  host, not only on the phone: with it off, `stream.input` is dropped before it
  reaches the helper, and with it on it still needs the macOS Accessibility
  grant. A peer token never reaches a stream (`/api/peer/*` only), and no job,
  schedule or peer desktop opens a desktop stream. The helper `wp-desktop` runs
  as the desktop user, is signed with a stable identifier and holds only the
  Screen Recording and Accessibility grants a person gave it at the Mac (it asks
  macOS only when a person taps Fix on a setup row), and capture runs only while a
  view is open. macOS shows its own recording indicator the whole time.
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
  (`packages/web/src/webUpdate.ts`); the manifest's sha256 hashes come from
  that same host, so they catch corruption, not a hostile host. A host you
  pair with can ship JS that runs with the shell's native plugins. Pair only
  with desktops you control.

If you're not sure whether something is in scope, report it privately anyway
and let us sort it out together — a false positive costs us a few minutes; a
missed real bug costs a lot more.
