# Distribution: what a release is

Primary route: a `curl | sh` installer downloads a PINNED Node runtime (`deploy/node-version`, one
line, an Active LTS 24.x) and ONE platform-independent tarball. Nothing compiles on the user's
machine: node-pty ships N-API prebuilds for darwin/linux/win32 x64+arm64 and the tarball keeps all
of them. Secondary route: `npm i -g <slug>`, the same build with the dependencies declared. The
installer and service registration (`cli/service.ts`) and self-update (`cli/selfupdate.ts`, its
signature check in `cli/releasesig.ts`) are other packages; this note is the contract they plug into.

`npm run release:build` (`scripts/release/build.mjs`) runs `npm run build`, then writes
`dist-release/` (gitignored). `--no-build` skips the build; a dirty tree is refused unless
`--allow-dirty` (the commit is recorded, with a `-dirty` suffix then). Version = root `package.json`.

**Signing.** The build signs the exact bytes of the `.sha256` and of `release.json` with the
project's Ed25519 key (Node's own `crypto`, no minisign/cosign) into `<file>.sig`: one line, base64.
The key is `WATERPLANE_RELEASE_KEY` (pkcs8 PEM), default
`~/.config/waterplane-release/release-ed25519.pem`; it is checked BEFORE the build, and a key whose
public half is not the committed `deploy/release-pubkey.pem` stops it (a release signed with any
other key is one every installer out there refuses). No key ⇒ the build stops unless `--unsigned`
(dev builds; the installer and `update` then need `WATERPLANE_INSECURE_SKIP_SIG=1`). Pure parts:
`scripts/release/sign-lib.mjs`. `scripts/release/keygen.mjs` makes a keypair once (private 0600,
never overwritten; public into `deploy/release-pubkey.pem`) and says to back the private key up
offline. **Rotating the key is a new `install.sh`** — `render-install.mjs` embeds the public key
(`@@RELEASE_PUBKEY@@`, its SPKI DER as one base64 line), so copies already downloaded trust only the
old one — and `update` checks against `RELEASE_PUBKEY` in `cli/releasesig.ts`, so a rotation
changes that line too (`packages/host/test/releasesig.test.mjs` fails until both move). **Both
`.sig` files are mandatory release assets** beside the tarball, `.sha256` and `release.json`
(`release:publish` uploads them and checks them back): the installer refuses a missing
`.sha256.sig`, and `update` refuses a missing `release.json.sig` or `.sha256.sig`. **Back the private key up offline** (keygen says so once): losing it is a rotation, and
a rotation strands every `install.sh` already downloaded.

## Publishing a release: `npm run release:publish`

One command, `scripts/release/publish.mjs` (pure parts `publish-lib.mjs`, tests
`publish-lib.test.mjs`). **Dry run by default**: it makes only read-only calls (git, `gh release
view`, `npm view`, `gh auth status`, `npm whoami`) and prints every command the real run would make;
`--yes` runs them. Flags: `--build [--apk=<file>]` (run `release:build` first), `--public-clone
<dir>` (a clone of `github.com/<org>/<slug>`, for `release:public`), `--accept <file>` (passed to
it), `--allow-dirty` (dry run only: waives clean tree / on main / pushed / built-from-HEAD, each
printed as `waived`, never as ok), `--no-apk` (publish without an Android APK, on purpose).

- **Preflight** reports every check at once and refuses on any: clean tree on `main` and on
  `origin/main`; tag `v<version>` absent (or on HEAD); not on npm without a GitHub release; every
  asset in `dist-release/`; the `.sha256` matches the tarball and both `.sig` verify against
  `deploy/release-pubkey.pem`; `release.json`'s commit is HEAD; the npm `.tgz` carries
  `npm-shrinkwrap.json`; `gh auth status` and `npm whoami`; a `## <version>` section in
  `CHANGELOG.md` (`Unreleased` does not count: the section is the release notes); the public repo
  exists and the clone's origin is it; an APK asset (`release.json` names one) unless `--no-apk` —
  undrafting makes the release `releases/latest`, where the pair page sends a phone for the app, so
  an APK-less release goes out only on purpose (the plan's undraft step refuses it too).
- **Steps**: `verify-public-tree.mjs --rev HEAD` (the allow-listed snapshot of HEAD, a real
  `npm ci` from its own lockfile and `.npmrc`, then build, lint, unit and host tests — a failure
  stops the run before anything leaves the desktop) → tag `v<version>` here and push the tag → `release:public --commit` into the clone, push
  it → render `install.sh` → `gh release create v<version> --draft` on `<org>/<slug>` with the
  tarball, `.sha256`, `.sha256.sig`, `release.json`, `release.json.sig`, the APK when `release.json`
  names one, and `install.sh` → undraft (`--latest`) → `npm publish <tgz> --access public`. A draft
  first so `releases/latest` never points at a release still missing its `.sig`. No `--provenance`:
  npm provenance needs a CI OIDC identity (GitHub Actions, which is off here); from a desktop it fails.
- **Resume**: each step knows when it is done (tag on HEAD and origin; release exists, so the
  snapshot was pushed; assets on the release; version on npm) and is skipped, said so. A run that
  died after the GitHub release finishes npm; a draft missing an asset gets only that asset
  uploaded. A release that exists with a different `.sha256` than `dist-release/` is refused, and so
  is `--build` against an existing release: a resume publishes the bytes already released, never
  new ones.
- **Post-checks**: every asset downloaded back from `releases/download/v<version>/` must equal the
  local bytes and pass the same sha256 + signature checks; `npm view <pkg>@<version>
  _hasShrinkwrap` must be `true` (if not, `npm i -g` re-resolves the whole tree: a loud warning
  with the fix, bump and republish, since a published version cannot be replaced).
- **By hand, still**: `https://<domain>/install.sh` is deployed by nothing in this repo. The run
  prints the step: put `dist-release/install.sh` there (or redirect the URL to
  `releases/latest/download/install.sh`) and `cmp` it against the local copy. Writing the CHANGELOG
  section and bumping `package.json`'s version stay a person's job.

## Layout of `<slug>-<version>.tar.gz` (top dir `<slug>-<version>/`)

```
package.json     runtime manifest: name, version, type=module, bin, engines (no dependencies)
release.json     {name, version, commit, builtAt, node, protocolVersion, builtins}
bin/<slug>.mjs   GENERATED with the slug filled in from BRAND; imports packages/host/dist/cli/index.js
packages/shared/{package.json,dist}
packages/host/{package.json,dist}          dist/extensions = compiled built-in extensions
packages/web/dist                          host resolves it as ../../web/dist from host/dist
packages/extensions/*/<plugin manifest>   manifests only; the host reads built-in manifests from source folders
tools/repohealth.mjs, tools/repohealth/   the engine repohealth.ts looks for at <root>/tools
node_modules/    PRODUCTION deps as the lockfile resolved them; @waterplane/shared is a REAL copy
LICENSE README.md SECURITY.md NOTICES.md DISCLAIMER.md CHANGELOG.md
```

Beside it: `<slug>-<version>.tar.gz.sha256` (`sha256sum` format) and its `.sha256.sig`, a copy of
`release.json` and its `release.json.sig`, and the
npm tarball `<slug>-<version>.tgz` (`npm pack` of the same tree without `node_modules`;
dependencies pinned to the lockfile's versions, `@waterplane/shared` in `bundleDependencies`).
`deploy/npm-placeholder/` is the name-squat and is untouched.

## The CLI (`packages/host/src/cli/index.ts`)

`main(argv): Promise<number>`: `start` (default) and `doctor` import `dist/main.js` IN THIS PROCESS
(so launchd/systemd supervise the daemon itself; argv is rewritten so `env.ts`'s `isDaemonEntry` still
sees `main.js`; they never resolve, the daemon ends the process), `version` (release.json, else the
checkout's package.json + `git rev-parse`), `service <install|uninstall|status>` and `update [--check|--rollback]`
(each `import("./service.js")` / `import("./selfupdate.js")` and call `run(args)`; absent ⇒ one line,
exit 1), `help`. Dev checkouts keep `npm run start/doctor/restart` unchanged.

## What assumes a checkout (tarball mode)

- `repohealth.ts` `bundledEngine`: `<root>/tools/repohealth.mjs`. Shipped, so it resolves.
- `plugins/builtin.ts`: manifests from `packages/extensions/<id>/`. Shipped (manifest only).
  **Which builtins ship** is `release.json`'s `builtins` (`{ <id>: { on, experimental? } }`): every
  always-on extension, plus each OPTIONAL one (manifest `optional: true`) that `deploy/ship.json`
  says ships — `{ "builtins": { "opencode": { "ship": true, "on": true, "experimental": true } } }`.
  `build.mjs` stops in words when an optional extension is missing from `ship.json` or its
  `experimental` disagrees with the manifest; a dropped one loses its manifest AND its
  `host/dist/extensions/<id>`. The host loads only the builtins `release.json` names, an optional one
  starting at its `on` unless the person switched it (`<state>/plugins.json`). A checkout has no
  `release.json`: everything loads, on.
- `env.ts` also loads `<root>/.env` (the release root, harmless; per-user config is the real path).
- `pair.ts` `DEFAULT_APK` (`packages/app/android/...`): absent in a release, so "no APK to offer";
  an APK for release users comes from the release page: `release.json` names it (`apk`, written by
  `release:build -- --apk=<file>`, which also copies it beside the tarball; upload it as a release
  asset) and `pair.ts` `releaseApkUrl` links `releases/download/v<version>/<apk>` ONLY then
  (or `WATERPLANE_APK_URL`, https). `apkSource`: local build, else release, else the page says the
  web route. A release that names no APK offers no link, never one that would 404.
  **The asset is the dev flavor only, named by one shared rule** (`releaseApkName(slug, version)` in
  `shared/brand.ts`, used by `build.mjs` and `releaseApkUrl`; any other name never resolves). Before
  copying it, `scripts/release/apk-lib.mjs` reads the APK's applicationId (`apkanalyzer`, `aapt2`/`aapt`
  if on PATH, else a direct zip + binary-manifest read) and refuses anything but `devApplicationId()`
  (`<appId>.dev`): the play build (`<appId>`) gets its own message, and an unreadable APK fails, never
  skips. It never runs gradle or touches a keystore: build the APK first (`npm run apk:dev-release`).
- The installer's last lines (`finish_https`) discover whether `tailscale serve` already proxies the
  host port (same proxy-TARGET rule as `net.ts` `serveHttpsUrl`), else print the exact serve line,
  the MagicDNS + HTTPS-certificates prerequisite and the https URL, asking y/N only with a terminal
  (`/dev/tty`, so it works under `curl | sh`). Plain http is not a secure context; `doctor` says so.
- `doctor.ts` fix text mentions `scripts/fix-node-pty.mjs`, which a release lacks (prebuilds ship
  with the exec bit; node-pty's own install script covers the npm route; the checkout's `.npmrc`
  ignore-scripts does not ship).
- `scripts/restart.sh`, `deploy/install-service.sh` stay checkout-only.

## Self-update

`<slug> update` (`packages/host/src/cli/selfupdate.ts`). **Nothing applies itself:** no timer, no
boot hook, no update-on-restart; only this explicit command downloads or switches anything.

**Install mode is read off the running file's REAL path, never guessed** (`detectMode`, pure):
`<data>/versions/<v>/` carrying `release.json` = tarball; `…/node_modules/<slug>/` = npm global;
`.git` at the root = checkout; anything else is "cannot tell", said so. Only a tarball install
updates itself; npm is told `npm i -g <slug>@latest`, a checkout `git pull` + `npm run restart`
(exit 3). The data dir is the parent of `versions/`, so the updater does not re-derive
`XDG_DATA_HOME` and cannot disagree with the installer about it.

Source: `--from <dir-or-url>` > `<ENV_PREFIX>RELEASE_URL` > `github.com/<org>/<slug>/releases/latest/download/`.

- `update --check`: fetch `release.json` and verify `release.json.sig` BEFORE reading it, compare (semver incl. pre-release, no dependency;
  unparseable ⇒ "cannot compare", never a guess), print `current → latest`. **Exit 0 current,
  10 update available**, 1 could not check. Works in every mode.
- `update`: one at a time (`versions/.update.lock`, a pid; a dead pid's lock is taken over).
  Download `<slug>-<v>.tar.gz` + `.sha256`, verify `.sha256.sig` (key in `cli/releasesig.ts`), then
  the checksum; **a missing or wrong signature, or a mismatch, refuses with nothing changed**
  (`<ENV_PREFIX>INSECURE_SKIP_SIG=1` skips the signature and warns on every run), extract
  into `versions/.tmp-*` and RENAME to `versions/<v>`, then check the tree's `release.json` and
  `bin/<slug>.mjs`. If `release.json.node` ≠ what `runtime/current/bin/node --version` says, fetch
  `node-v<n>-<os>-<arch>.tar.gz` from nodejs.org, verify against `SHASUMS256.txt`, install as
  `runtime/node-v<n>-<os>-<arch>`, flip `runtime/current`. Then flip `current` → `versions/<v>`
  (relative link; temp symlink renamed over it — atomic). Prune: keep `current` plus the newest by
  semver, **2 in all**; runtimes no kept version asks for go too (never `runtime/current`'s). A
  version already unpacked (e.g. after a rollback) is reused, not re-downloaded.
- **State snapshot before the swap** (`cli/statesnap.ts`): just before `current` flips, the state
  dir's top-level stores (`*.json`, `*.jsonl`, `*.bak`; never a `.corrupt-*`, tmp, dot-file,
  symlink or subdir) are copied to `<data>/state-snapshots/<version being left>/` (0700, built in a
  tmp dir and renamed). The state dir is the service's own `STATE_DIR` when a service runs this
  install, else the CLI's. **No snapshot ⇒ no switch.** A pruned version's snapshot goes with it.
  Why: a newer host may convert its stores on first boot, and the older code facing them is at best
  read-only (`intents.json` with a newer `schema`).
- `update --rollback`: `current` → the newest installed version BELOW it, and that version's Node
  if it is still under `runtime/` (else the current runtime is kept, and the line says so). With a
  snapshot and a service: **stop** the service (`launchctl bootout` / `systemctl --user stop` — a
  running host flushes its stores on exit, over any restore), flip, restore, **start**. A restore
  never deletes: what it replaces is moved to `<state dir>/.before-rollback-<ts>/`. No service, or
  `--no-restart`: the flip happens and the line says to stop the host and run
  `update --restore-state` (restores the snapshot of the version `current` points at).
- Restart: only a service definition that **names this data dir** (or names `~/.local/bin/<slug>`
  whose text does) counts — launchd `~/Library/LaunchAgents/<launchdLabel>.plist` ⇒
  `launchctl kickstart -k gui/<uid>/<label>`; systemd `~/.config/systemd/user/<slug>.service` ⇒
  `systemctl --user restart <slug>`. A dev checkout's job under the same label is never restarted
  by a tarball update. No such service ⇒ the user is told to restart. `--no-restart` skips it.
- Exit codes: 0 done/current · 1 failed or refused · 2 usage · 3 this install does not update
  itself · 10 (`--check`) newer release available.

**Doctor row `self-update`** (tarball mode only; else no row): one `release.json` request, 4 s
timeout. Newer ⇒ `warn` "<v> available — run `<slug> update`"; a network failure is an `ok` row
saying it could not check, never a failure. **Not in the boot preflight** (`runChecks`'
`skipNetwork`): boot is not delayed by it anyway (the preflight runs after listen), but a restart is
not a reason to make a request to the release host. It runs when doctor is asked for by name.

Verified by hand against a real `release:build` tarball in a fake `XDG_DATA_HOME` install (runtime
symlinked to the local node, `release.json.node` set to match so no Node download): check → 10,
tampered `.sha256` refused with the tree untouched, update flips `current`, prunes to 2, a stale
runtime removed, rollback and re-update. The pure parts are `packages/host/test/selfupdate.test.mjs`.

## Installer and service

### The route

```
curl -fsSL https://waterplane.dev/install.sh | sh
```

or the same `install.sh` attached to a GitHub release. It is POSIX `sh`
(macOS `/bin/sh`, dash on Debian/Ubuntu), runs as the user, uses sudo only to install a missing tmux and only on a yes,
and edits no shell rc file. Supported: macOS arm64/x64, Linux x64/arm64,
Windows only inside WSL2. Native Windows (Git Bash, MSYS, Cygwin) and WSL1 are
refused with a sentence naming the fix.

**Why it brings its own Node.** The host needs a Node that matches the
`node-pty` prebuilt in the tarball, and "whatever `node` is on PATH" is nvm's
current shell, a Homebrew version that moves under it, or nothing. So the
installer downloads the pinned official build named in `deploy/node-version`
from nodejs.org and checks it against nodejs.org's `SHASUMS256.txt`; a
version already present is not downloaded again. The person's own `node` is
never touched.

**Why one tarball.** The release is `waterplane-<version>.tar.gz` plus
`.sha256` and `.sha256.sig` (checked first, by the just-verified Node, against the key embedded in
`install.sh`; see Signing above), platform-independent (the release build's contract): top dir
`waterplane-<version>/` with `package.json`, `release.json`, `bin/waterplane.mjs`,
`packages/{shared,host}/dist`, `packages/web/dist`, production
`node_modules`. The installer checks the archive's own `release.json`
`version` against the one it asked for and refuses a mismatch.

### What it lays down

```
${XDG_DATA_HOME:-~/.local/share}/waterplane/
  runtime/node-v<x>-<os>-<arch>/     the pinned Node
  runtime/current -> node-v...       relative symlink
  versions/<version>/                one unpacked release per version
  current -> versions/<version>      relative symlink
~/.local/bin/waterplane              sh wrapper: exec runtime/current/bin/node current/bin/waterplane.mjs "$@"
```

- **Unpack, then rename.** Both archives are extracted into a `.stage.<pid>`
  directory beside their destination and moved into place, then the
  `current` symlink is flipped (`mv -T` of a fresh link where GNU `mv` has it,
  unlink+rename on macOS). A failed download or a bad checksum leaves the
  previous install exactly as it was.
- **Re-running is the upgrade.** Older `versions/` are kept (a rollback is a
  symlink flip); the installer says where they are.
- **The wrapper is marked** (`# waterplane-installer-wrapper`): a re-run
  overwrites only its own file, and a foreign `~/.local/bin/waterplane` is
  refused BEFORE anything is unpacked.
- **PATH is reported, not edited.** If `~/.local/bin` is missing from PATH,
  the line to add is printed for the person's shell.

### Prerequisites, and which ones stop it

- `claude` missing **stops** the install: waterplane drives the Claude Code
  CLI the person already has (opencode is experimental), so installing it
  first is the actual first step. The message links the Claude Code docs;
  `--skip-claude-check` continues anyway. Also looked for in `~/.local/bin`
  and `~/.claude/local`, where Claude Code's own installers put it.
- Tailscale missing is a **warning** with the download link; it is never
  installed for you. On WSL the warning adds that Tailscale must run inside
  the distro: the Windows client does not reach into the WSL VM.
- git missing is a warning.
- tmux missing **stops** the install (`ensure_tmux`, right after the other
  prerequisites): every session runs inside tmux so it survives a host
  restart and a self-update, and the host refuses to start sessions without
  it. It used to be opt-in, set only by the dev-checkout
  `deploy/install-service.sh`, so a release install lost every live session
  on each restart. The installer names the exact command for the package
  manager that is HERE (`brew install tmux`; `sudo apt-get`/`dnf`/`pacman`/
  `zypper`/`apk`), and with a terminal asks y/N through `/dev/tty` like the
  https step; without one, or on no, it stops with that command. No brew on
  macOS ⇒ it names Homebrew. This is the one place the installer may run
  sudo, and only on a yes. Native Windows is refused earlier (WSL2 only).
  `scripts/release/render-install.test.mjs` drives every branch with a PATH
  that holds only fake binaries.

### Flags

`--version <v>` (default: the version the script was rendered for; a named
version is fetched from `releases/download/v<v>/`), `--from <dir|url>` (a
local `dist-release/` for testing — the public repo does not exist yet),
`--node-mirror <url>`, `--bin-dir <dir>`, `--no-service`,
`--skip-claude-check`, `--with <id>`, `--without <id>`, `--uninstall` (plugins: next section).

`--uninstall` runs `waterplane service uninstall`, then removes `runtime/`,
`versions/`, `current` and the marked wrapper — and nothing else. Settings in
`~/.config/waterplane`, the host state dir (`~/.local/state/waterplane`) and each repo's own `.waterplane/`, and
anything else under the data dir (e.g. dictation models) stay.

### Plugins at install time (`--with`, `--without`)

`deploy/plugins.json` is the installer's catalogue of EXTERNAL plugins only:
`{plugins:[{id, name, repo (git URL), ref (full commit sha — a tag can move), description, experimental?, listed}]}`. Listed today: `copilot` (`waterplane-dev/waterplane-plugin-copilot`, private until the public release).
In-repo optional builtins (opencode) are not in it: `deploy/ship.json` and the
release's `builtins` decide those. `render-install.mjs` renders the catalogue
(`CATALOGUE`, one `id|listed|experimental|repo|ref|name` line each, every field
checked against a strict pattern, a listed entry with a TODO repo or ref fails
the render) and the in-repo extension ids (`BUILTINS`, read from
`packages/extensions/*/waterplane-plugin.json`) into the script.

- `--with <id>` (repeatable): refused in words, before anything is fetched, when
  the id is unknown, known but `listed:false`, or a builtin (it already ships in
  the release; the sentence names `--without` as the way to switch it off). Else:
  `git clone --no-checkout` with hooks off, `checkout --detach <ref>`, check that
  `waterplane-plugin.json`'s `id` equals the catalogue's, and only then place it in
  `<config dir>/plugins/<id>` (after the release is verified, so a refusal leaves
  the old install as it was). **No plugin code runs at install time** and no
  `npm install` either: a plugin must ship what it needs, prebuilt. It loads at
  the next host start. A re-run replaces a directory the installer made earlier
  (marker in its `.git/`) and refuses one it did not.
- `--without <id>`: only for an optional builtin; writes `{enabled:{<id>:false}}`
  into `<state dir>/plugins.json`, merging with what is there (the registry
  already honours it; delete the entry to turn it back on). A non-optional
  builtin or a non-builtin is refused.
- `--uninstall` leaves installed plugins, like the rest of `~/.config/<slug>`.
- Copilot is in the file as `listed:false` with a TODO repo (`<plugin-repo>`):
  it is listed only after its real-check verdict and when the repo exists.

Tests: `scripts/release/render-install.test.mjs` (rendering, the refusal
sentences, and a clone-verify-place run against a local fixture repo).

### The template, and why it is one

The installer cannot import `brand.ts`, so it is `deploy/install.sh.tmpl`
with `@@SLUG@@`, `@@NAME@@`, `@@ENV_PREFIX@@`, `@@NODE_VERSION@@`,
`@@VERSION@@`, `@@REPO_URL@@`, `@@INSTALL_URL@@`, filled by
`scripts/release/render-install.mjs` (`npm run release:install-sh` →
`dist-release/install.sh`, executable) from the built brand table, root
`package.json` and `deploy/node-version`. An unfilled placeholder, or a value
that could break out of the template's single quotes, fails the render.
Everything runs from `main "$@"` on the last line, so a `curl | sh` cut off
mid-download executes nothing.

### `waterplane service`

`packages/host/src/cli/service.ts`, loaded by the CLI for `service`, imports
nothing from the host but `@waterplane/shared`, so it does not boot the
daemon. `install | uninstall | status`, with `--dry-run` (print the file and
the commands, run nothing), `--force`, `--env KEY=VALUE` (repeatable).

- **Paths come from the running process** (`process.execPath`, this file's
  location), mapped onto the installer's stable symlinks when they are inside
  a data dir it laid out, so an upgrade needs no service rewrite. An
  `npm i -g` install keeps its own paths; a package manager's versioned node
  (`…/Cellar/node/<v>/bin/node`) is swapped for the `node` on PATH that
  resolves to the same binary, because the versioned path dies on the next
  `brew upgrade`.
- **PATH is computed, the shell's env is not copied.** launchd hands a job
  `/usr/bin:/bin:/usr/sbin:/sbin`, which finds neither `node` nor `claude`
  (an npm-installed `claude` is `#!/usr/bin/env node`, so it needs node on
  PATH too). The service gets the dirs of node, claude, git, tmux and
  tailscale, then the platform defaults; plus HOME, the resolved root and
  state dir (no tmux knob: tmux is the only substrate), and whatever `--env` named — spread last, so it
  wins. A tmux missing at install time is a warning: the service starts, and
  refuses sessions until tmux is there (no restart needed once it is).
  `deploy/install-service.sh` bakes the current shell's knobs in; this one
  deliberately does not, and refuses `--env <prefix>ALLOW_PUBLIC` in every
  current and legacy spelling, and `PATH`/`HOME` overrides.
- **macOS:** `~/Library/LaunchAgents/<launchdLabel>.plist`, RunAtLoad,
  KeepAlive, logs `~/Library/Logs/waterplane-host.{out,err}.log`. Legacy
  labels from `LEGACY` are booted out and their plists removed (two jobs on
  one port fight for ever under KeepAlive). Then `bootout`, `bootstrap`
  (retried: bootout returns before the job is gone and bootstrap meanwhile
  fails with an I/O error), `kickstart -k`.
- **The dev-checkout conflict.** `deploy/install-service.sh` writes the SAME
  label. If the existing plist (or a legacy one) runs
  `<repo>/packages/host/dist/main.js` and `<repo>` has a `.git`, install AND
  uninstall refuse with a sentence naming the checkout and
  `deploy/uninstall-service.sh`, unless `--force`. `status` says which kind
  is installed and what it runs.
- **Linux:** `~/.config/systemd/user/waterplane.service`, `Restart=always`,
  `daemon-reload`, `enable`, `restart` (not `enable --now`, which leaves an
  already-running old version running). Linger is checked and
  `sudo loginctl enable-linger $USER` is printed, never run. Without systemd
  as PID 1 outside WSL it says so and exits non-zero; the installer turns
  that into a warning and carries on.
- **WSL:** without systemd it prints the two fixes — `[boot] systemd=true` in
  `/etc/wsl.conf` + `wsl --shutdown`, or the exact `schtasks /create … /tr
  "wsl.exe -d $WSL_DISTRO_NAME -e ~/.local/bin/waterplane start"` line — and
  exits 0. In both cases it warns that WSL stops the distro and its VM once
  no Windows-side session is open (`vmIdleTimeout` in `.wslconfig`): a
  systemd service runs only while the VM is up and does not keep it up.

### Verified how

`packages/host/test/service.test.mjs` pins the pure half: plist and unit
text (escaping, argv round-trip), `--env` refusals, path mapping, PATH
composition, the WSL lines, the checkout conflict. The installer was run
end to end against a hand-assembled release dir with `HOME` and
`XDG_DATA_HOME` in a temp dir and `--no-service`: fresh install through a
pipe, re-run (Node skipped), upgrade, tampered archive refused, missing
claude refused and `--skip-claude-check`, foreign wrapper refused,
uninstall keeping `~/.config` and other data; and in a Debian container
(no systemd) for the Linux path. `shellcheck --shell=sh` is clean on the
rendered script.

## A second desktop as a peer: WSL2, and an OrbStack VM to rehearse it

Paired hosts delegate jobs to each other (`docs/analysis/peer-hosts-plan.md`; SECURITY.md for the trust
model). Windows is reached only as a waterplane host inside WSL2, so a peer setup is the WSL2 install
plus pairing.

**WSL2 box.** `wsl --install -d Ubuntu`; `[boot] systemd=true` in `/etc/wsl.conf`, then `wsl --shutdown`.
Inside the distro run Tailscale (`tailscale up`): the Windows client does not reach into the WSL VM.
`networkingMode=mirrored` makes the Windows 100.x reachable, but `tailscaleIp()` then finds no
`tailscale0` and the bind falls to loopback, so it is a caveat, not the route. Install waterplane,
log `claude` in once, set `WATERPLANE_ROOT=~/dev`, `waterplane service install`. Set `vmIdleTimeout=-1`
in `.wslconfig` or keep a Windows session alive, or the VM stops and the peer is unreachable every
morning. Check repos out on the distro's own filesystem, not `/mnt/c`: git and node-pty are about ten
times slower across 9P. A job reaches native Windows programs through WSL interop (`powershell.exe`,
`/mnt/c/.../x.exe`).

**First peer: an OrbStack Linux VM on the Mac** (`orb create ubuntu <vm>`), with Tailscale
inside it and no OrbStack-local route. The Mac daemon binds Tailscale and loopback only, so a
`<vm>.orb.local` address would need a LAN-class bind and a `*.local` allowance this project forbids;
and OrbStack's 198.19/16 classifies as public. A tailnet-only VM is also exactly the WSL2 route.
Peer addresses are 100.64/10, `*.ts.net` or loopback, nothing else. A delegated job runs in a detached worktree
`<clone>/.claude/worktrees/peer-<from>-<key>` carrying a `peer-job.json` marker; the restart and install paths
refuse there (`scripts/restart.sh` and `deploy/install-service.sh` — there is no `bin/waterplane.mjs` check), so a peer
can test waterplane without being taken down. Pairing uses each host's own tailnet `ip:port` (`self.addr` in
`GET /api/peers`), so a host saved on the phone as an https front door still pairs.

It covers the Linux side of WSL2: installer, systemd service, Node and node-pty, git worktrees, the
stub e2e suite. It does NOT cover WSL interop to `.exe`, mirrored networking, Tailscale-in-distro on
WSL, systemd via `wsl.conf`, `vmIdleTimeout`, or any native Windows GUI program (the Garmin
simulator). Those need the real Windows box.
