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

If you don't hear back after a reasonable wait, a follow-up email is fine.

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
  machine — Tailscale's own device auth is the real gate.
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
- **Device tokens.** Every token belongs to one row of the paired-device
  ledger, `<state dir>/devices.json` (mode 0600): 32 random bytes,
  base64url, returned once and kept on disk **only as its sha256**, looked up
  with a constant-time compare. Tokens survive a host restart; revoking a row
  (`POST /api/devices/revoke`, authenticated) kills its token at once and
  closes that device's open sockets; setting, changing or clearing the
  password drops every row. A browser gets one from `POST /api/auth/login`
  as an httpOnly cookie. The Android shell (whose cross-site cookie is
  withheld) mints one with `POST /api/auth/token` — **only from a caller that
  is already trusted** (loopback, an ungated Tailscale peer, or a valid
  token), so no password is retyped over the tailnet, and never while no
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
- **Browser origins** (`packages/host/src/origin.ts`). Every `/api/*` request
  and WebSocket upgrade is checked on `Origin` and `Host`; only `http`/`https`
  origins naming this machine on a port it serves pass, plus exactly one
  non-web origin: `capacitor://localhost`, the iOS shell's page (WKWebView
  cannot serve an app from `http`, so it is the twin of the Android shell's
  `http://localhost`). Any other scheme is refused, and the CORS header only
  ever reflects an origin that passed — never `*`.
- `/api/agent/intents` and `/api/agent/backlog` (an agent in a driven repo
  posting work for later, `agentintents.ts`) answers only a loopback caller that is neither a browser
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
- **Toolchain downloads** land in a fresh `mkdtemp` directory (0700) under the
  per-user data dir, are created with `O_EXCL`, and are hashed and unpacked
  from there, never from a shared temp dir another local account could plant
  a file or symlink in.
- **Plugins** (`packages/host/src/plugins/`, `docs/notes/plugins.md`) are code
  the machine's owner put in their own config dir (`~/.config/waterplane/plugins/`
  or `plugin-paths.json`). They run in the daemon's process with its rights —
  the same trust as the daemon, crossing no boundary it has not. The phone
  never runs plugin code: it draws what a plugin declares. A plugin answers a
  choice box only through the core's answer gate (`answergate.ts`: the
  manifest's `answers`, a per-session switch default OFF that only the phone
  flips, the same box it was told about, never a trust/tool/plan box or one
  naming something destructive or secret), reads files only through the
  containment guard, and reads only the env names its manifest declares.
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
- **The installer** (`curl -fsSL https://waterplane.dev/install.sh | sh`,
  generated from `deploy/install.sh.tmpl`) is code you run as yourself, so
  read it first if you prefer: download it, open it, then `sh install.sh`.
  It never uses sudo and edits no shell rc file. It verifies the Node runtime
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
  skips the check, loudly, for a release you built yourself.
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
  HOME and the variables passed with `--env`, never the installing shell's
  environment, and refuses `WATERPLANE_ALLOW_PUBLIC` outright: a public bind
  stays an explicit, visible opt-in in `.env`.

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

If you're not sure whether something is in scope, report it privately anyway
and let us sort it out together — a false positive costs us a few minutes; a
missed real bug costs a lot more.
