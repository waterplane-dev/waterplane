# Distribution: what a release is

Primary route: a `curl | sh` installer downloads a PINNED Node runtime (`deploy/node-version`, one
line, an Active LTS 24.x) and ONE platform-independent tarball. Nothing compiles on the user's
machine: node-pty ships N-API prebuilds for darwin/linux/win32 x64+arm64 and the tarball keeps all
of them. Secondary route: `npm i -g <slug>`, the same build with the dependencies declared,
published from the public repo's GitHub Actions with an npm provenance attestation (see
[Publishing a release](#publishing-a-release-npm-run-releasepublish)). The
installer and service registration (`cli/service.ts`) and self-update (`cli/selfupdate.ts`, its
signature check in `cli/releasesig.ts`) are other packages; this note is the contract they plug into.

`npm run release:build` (`scripts/release/build.mjs`) runs `npm run build`, then writes
`dist-release/` (gitignored). `--no-build` skips the build; a dirty tree is refused unless
`--allow-dirty` (the commit is recorded, with a `-dirty` suffix then). Version = root `package.json`.

**A signed build comes from the public snapshot, never from this tree.** The web bundle globs every
`packages/extensions/*/web`, whatever `ship.json` says, so a build here carries the private
extensions' UI: 0.1.0 did. `release:build` refuses a signed build in a tree that holds a private
extension (`deploy/public-allowlist.txt`) unless `--private-tree` (your own desktops only, e.g. the
wp-peer VM) or `--unsigned`. It also refuses to ship one by `ship.json`, and `install.sh` never names
one. Route: `publish-public.mjs --to <public clone> --commit`, then `npm ci`, `build:shared`,
`release:build` and `release:install-sh` inside that clone. `release:publish --build` still builds
here and its preflight wants `release.json`'s commit to be this HEAD, so it does not fit that route
yet: 0.1.1 went out by hand.

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
<dir>` (a clone of `github.com/<org>/<slug>`, for `release:public`), `--media-clone <dir>` (a clone
of the media repo in `deploy/public-media.json`: the hosted walkthrough videos, see
testing-and-ops.md "Rewritten on the way out"), `--accept <file>` (passed to
it), `--allow-dirty` (dry run only: waives clean tree / on main / pushed / built-from-HEAD, each
printed as `waived`, never as ok), `--no-apk` (publish without an Android APK, on purpose),
`--npm-from-desktop` (the escape hatch below: npm from this desktop, WITHOUT provenance).

- **Preflight** reports every check at once and refuses on any: clean tree on `main` and on
  `origin/main`; tag `v<version>` absent (or on HEAD); not on npm without a GitHub release; every
  asset in `dist-release/`; the `.sha256` matches the tarball and both `.sig` verify against
  `deploy/release-pubkey.pem`; `release.json`'s commit is HEAD; the npm `.tgz` carries
  `npm-shrinkwrap.json`; `gh auth status`; GitHub Actions enabled on the public repo (`gh api
  repos/<org>/<slug>/actions/permissions`; unreadable is refused, not assumed — skipped once the
  version is on npm), or with `--npm-from-desktop` `npm whoami` instead; a `## <version>` section in
  `CHANGELOG.md` (`Unreleased` does not count: the section is the release notes); the public repo
  exists and the clone's origin is it; an APK asset (`release.json` names one) unless `--no-apk` —
  undrafting makes the release `releases/latest`, where the pair page sends a phone for the app, so
  an APK-less release goes out only on purpose (the plan's undraft step refuses it too).
- **Steps**: `verify-public-tree.mjs --rev HEAD` (the allow-listed snapshot of HEAD, a real
  `npm ci` from its own lockfile and `.npmrc`, then build, **CI's own npm build**, lint, unit and
  host tests — a failure stops the run before anything leaves the desktop) → tag `v<version>` here and push the tag → `release:public --commit` into the clone (and the
  hosted videos into the media clone), push the media clone, then the public clone → render `install.sh` → `gh release create v<version> --draft` on `<org>/<slug>` with the
  tarball, `.sha256`, `.sha256.sig`, `release.json`, `release.json.sig`, the APK when `release.json`
  names one, and `install.sh` → undraft (`--latest`) → **wait for npm** (below). A draft
  first so `releases/latest` never points at a release still missing its `.sig`.
- **npm is published by the public repo's CI, with provenance.** The undraft makes the release
  `published`, which starts `.github/workflows/npm-publish.yml` in `<org>/<slug>`. The file lives in
  this repo's `.github/workflows/` too (it is how the public snapshot gets it); the job guard below
  skips it here. Pushing a change to it needs the gh token's `workflow` scope. The npm half of the
  trust is set once on npmjs.com (or `npm trust github waterplane --file npm-publish.yml --repo
  waterplane-dev/waterplane`). That job checks out the tag, stops
  in words unless the run started ON the tag (`GITHUB_REF`) and `package.json`'s version is the tag,
  runs `npm ci` and `release:build -- --unsigned`, checks the `.tgz` is `<slug>@<version>` and
  carries `npm-shrinkwrap.json`, then `npm publish <tgz> --provenance --access public` through npm
  **trusted publishing** (OIDC: no `NPM_TOKEN` exists anywhere; permissions are `contents: read`
  and `id-token: write`, nothing else), and finally `npm-verify.mjs --check`: on npm,
  `_hasShrinkwrap` true, a SLSA provenance attestation in `dist.attestations`. A version already on
  npm is a clean skip. A job-level `if: github.repository == '<org>/<slug>'` keeps it from ever
  running in the private repo (a literal, because `if:` runs before any checkout;
  `npm-publish-workflow.test.mjs` holds it equal to the brand, and a step re-checks it against the
  checked-out brand). **Why built in CI and not uploaded from here:** provenance is CI's signed
  statement that *this workflow built these bytes from this commit*. A `.tgz` built on the desktop
  and published from CI would get an attestation for a build that never happened there. That is
  also why a hand re-run must start on the tag (`gh workflow run npm-publish.yml --repo
  <org>/<slug> --ref v<version> -f tag=v<version>`): a run started on `main` would attest `main`.
  It follows that the npm `.tgz` and the `curl | sh` tarball are two builds of one tag — the
  tarball on the desktop, signed with the Ed25519 key — and the npm one's `release.json` names the
  public snapshot's commit, not this repo's. Whether CI should build the tarball too, with the
  desktop only signing it, is an open question for the owner.
- **Wait for npm** (`npm-wait` step): `scripts/release/npm-verify.mjs <pkg> <version> --wait 900
  --repo <org>/<slug>` polls `npm view` every 20 s for up to 15 minutes, printing the workflow run's
  state for the tag on each line (`gh run list`); a run that finished without success stops the
  wait at once with its URL and the re-run line above. On a timeout the step fails like any other
  and names the same way out; a re-run of `release:publish` resumes at this step. Exit codes: 0 the
  version is there (with `--check`: shrinkwrap and provenance too); 3 npm ANSWERED and it is not
  there after the wait; 1 a check failed, the run failed, or npm could not be asked (a failed
  `npm view` under `--wait 0`, or three failed asks in a row — "could not ask" is never "absent").
  The per-turn decision is `npmWaitDecision` in `publish-lib.mjs`, tested without a network. A failed
  run's message says to check `npm view <pkg>@<v>` before re-running: the workflow's own
  `npm-verify --wait 300 --check` can fail AFTER a good publish when the registry lags past 5
  minutes, and a re-run skips a version already on npm.
- **CI's build is rehearsed before the undraft.** After the build, `verify-public-tree` runs
  `npm run release:build -- --unsigned` in the snapshot (the exact command `npm-publish.yml` runs on
  the tag; the copy is clean, which `build.mjs` requires), then `scripts/release/check-npm-tarball.mjs`:
  the workflow's two assertions — the `.tgz` is `<slug>@<version>` and lists
  `package/npm-shrinkwrap.json`. A build or shrinkwrap problem thus stops `release:publish` before
  anything is pushed, not in a workflow run after the release is public. Order and stop flags:
  `verifySteps` in `public-lib.mjs`.
- **Escape hatch: `--npm-from-desktop`.** Today's old path: `npm publish
  dist-release/<slug>-<version>.tgz --access public` from this desktop, with `npm whoami` in the
  preflight. It is printed as **WITHOUT provenance** in a banner at the start, again at the step, and
  in the post-checks (there it is not counted as a failure). Use it only when the workflow cannot
  run; a version is published once, so that version never gets an attestation.
- **Resume**: each step knows when it is done (tag on HEAD and origin; release exists, so the
  snapshot was pushed; assets on the release; version on npm) and is skipped, said so. A run that
  died after the GitHub release finishes npm; a draft missing an asset gets only that asset
  uploaded. A release that exists with a different `.sha256` than `dist-release/` is refused, and so
  is `--build` against an existing release: a resume publishes the bytes already released, never
  new ones.
- **Post-checks**: every asset downloaded back from `releases/download/v<version>/` must equal the
  local bytes and pass the same sha256 + signature checks; `npm view <pkg>@<version>
  _hasShrinkwrap` must be `true` (if not, `npm i -g` re-resolves the whole tree: a loud warning
  with the fix, bump and republish, since a published version cannot be replaced), and `npm view
  <pkg>@<version> dist.attestations` must carry a provenance attestation (a version without one was
  published some other way: the same loud warning).
- **One-time setup, by hand (the owner), before the first release that relies on it:**
  1. Enable GitHub Actions on `waterplane-dev/waterplane` (at or before launch; minutes are free on
     a public repo). The preflight refuses while they are off.
  2. On npmjs.com, package `waterplane` → Settings → **Trusted Publisher** → GitHub Actions:
     organization `waterplane-dev`, repository `waterplane`, workflow filename `npm-publish.yml`,
     environment empty (the workflow uses none).
  3. After the first publish with provenance, optionally set the package's publishing access to
     **require two-factor authentication and disallow tokens**: trusted publishing keeps working,
     and no leaked token can publish. `--npm-from-desktop` then needs your 2FA code.
- **The install URL is the release's own asset**,
  `github.com/<org>/<slug>/releases/latest/download/install.sh`: undrafting with `--latest` is the
  deploy, and the run prints a `cmp` against the local copy. No domain sits in front of it on
  purpose: `install.sh` carries the release public key, so whoever serves that URL decides which key
  a new install trusts, and GitHub already serves the tarball. A domain added later is a redirect to
  that URL, never a copy. Writing the CHANGELOG section and bumping `package.json`'s version stay a
  person's job.

## Layout of `<slug>-<version>.tar.gz` (top dir `<slug>-<version>/`)

```
package.json     runtime manifest: name, version, type=module, bin, engines (no dependencies)
release.json     {name, version, commit, builtAt, node, protocolVersion, builtins}
bin/<slug>.mjs   GENERATED with the slug filled in from BRAND; imports packages/host/dist/cli/index.js
packages/shared/{package.json,dist}
packages/host/{package.json,dist}          dist/extensions = compiled built-in extensions
packages/web/dist                          host resolves it as ../../web/dist from host/dist
packages/extensions/*/<plugin manifest>   manifests only; the host reads built-in manifests from source folders
packages/extensions/<id>/<assets>          a shipped builtin's manifest `assets` folder (the OCR engine), built by `npm run build`
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
exit 1), `help`. Dev checkouts keep `npm run start/doctor/restart` unchanged. On win32 every command
goes to `cli/windows.ts` instead, which runs the host inside WSL ([below](#windows-the-launcher-drives-the-host-in-wsl)).

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
boot hook, no update-on-restart; only this explicit command (or a tap on the phone, below) downloads or
switches anything. The daily update check (`updates/checker.ts`) is a READ: it asks GitHub what is
newest and says so on the phone; it never installs.

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

### From the phone

Settings → Tools → updates (`updates/`, plan [plugin-manager-and-self-update.md](../plans/plugin-manager-and-self-update.md)).

- **The button is tarball-only** (`updates/self.ts`: `canApply` only for the install the updater above
  understands). An npm or checkout install shows the command instead (`npm i -g <slug>@latest`;
  `git pull` + `npm run restart`), the same ones this section gives.
- A tap runs `applyInProcess` (`cli/selfupdate.ts`, the CLI's own code, same signature and checksum
  checks, same snapshot) with `noRestart`; then `updates/apply.ts` writes the receipt and
  restarts through `updates/restart.ts`: SIGTERM after the reply, and ONLY when a supervisor
  (launchd/systemd) will start the host again; unsupervised it says "restart the desktop to switch".
- **The receipt** is `lastResult` in the checker's status, written BEFORE the restart; the phone
  reads it after it reconnects ("updated to 0.x").
- **Known gap: a rollback from the phone does not restore the state snapshot.** `update --rollback`
  on the CLI stops the service, flips and restores; the in-process one cannot stop the host it runs
  in, so it flips only. After it, `update --restore-state` (host stopped) is still the way to put
  the older stores back.
- **The phone's web UI follows over the air:** the new host serves the new bundle; the app picks it
  up on its next launch. No APK is involved.

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
curl -fsSL https://github.com/waterplane-dev/waterplane/releases/latest/download/install.sh | sh
```

or the same `install.sh` attached to a GitHub release. It is POSIX `sh`
(macOS `/bin/sh`, dash on Debian/Ubuntu), runs as the user, uses sudo only to install a missing tmux and only on a yes,
and edits no shell rc file. Supported: macOS arm64/x64, Linux x64/arm64,
Windows only inside WSL2. Native Windows (Git Bash, MSYS, Cygwin) and WSL1 are
refused with a sentence naming the fix. (A *source checkout* or an npm install on the Windows side
is the other route: [below](#windows-the-launcher-drives-the-host-in-wsl).)

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

- `claude` missing **stops** the install: every backend but Copilot is the
  claude binary (a Claude plan, an API key, or a local Ollama model behind it),
  so installing it first is the actual first step. The message prints
  Anthropic's native install command (npm second: the installer's own Node is
  not on PATH, so a fresh machine often has no `npm`) and says what claude runs
  on, paid plan or API key or Ollama with no account — then continues: the host
  runs without it and sessions start once claude is on PATH. It used to ask
  "continue without claude? [y/N]", and on 2026-10-20 a real Mac answered "y" to
  a `curl | sh` run and was still refused; a stop that costs a re-run buys
  nothing. `--skip-claude-check` only drops the explanation, and `--with copilot`
  skips it too (that backend drives its own CLI).
  Also looked for in `~/.local/bin` and `~/.claude/local`, where Claude Code's
  own installers put it.
- Tailscale missing is a **warning** with the download link; it is never
  installed for you. On WSL the Windows client counts (`tailscale.exe` through
  interop), and the warning names both routes: the Windows client with mirrored
  networking, or Tailscale inside the distro.
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
claude explained and continued, foreign wrapper refused,
uninstall keeping `~/.config` and other data; and in a Debian container
(no systemd) for the Linux path. `shellcheck --shell=sh` is clean on the
rendered script.

## Installing with an agent: one skill, a prompt that points at it

`docs/install.md` carries a paste-in prompt (the README links it); `deploy/agent/waterplane/SKILL.md`
carries the instructions. It used to live under `deploy/openclaw/` and the README held a second,
shorter copy of the rules — two lists drifting, and nothing a Claude Code user could paste.
`tools/agentinstall.test.mjs` holds the pieces together.

- **Clone first, read from disk.** Claude Code's web fetch hands a page through a small summarising
  model, so a long install doc read by URL arrives paraphrased — the first casualty is a "never".
  Every route needs the clone anyway (source build, `deploy/docker/`, the Windows launcher), and
  what is on disk is what the person can read.
- **The hard rules are in the prompt itself** (no public bind, no `funnel`, no sudo/admin by the
  agent), not only in the doc: an agent that skims still has them, and a doc changed upstream cannot
  quietly drop them. The test holds each of the prompt's words inside the skill.
- **Two questions, nothing else asked up front:** native or Docker, and the root. Docker is
  presented as a convenience with costs (second `claude` sign-in, repos inside a volume, no capture
  or dictation), never as a sandbox — the Docker README says the same.
- **Windows is in, with the person's steps named first:** `wsl --install` + reboot, `winget` (UAC),
  `sudo apt-get` in the distro, and a second `claude` sign-in inside WSL. `host.mjs setup` runs
  `wsl --shutdown`, which stops every distro (Docker Desktop's too), so the skill makes the agent
  warn and wait before it.
- **OpenClaw's parser reads single-line frontmatter keys and `metadata` as one line of JSON.** The
  old multi-line block would have lost the gating. `requires.bins: claude` is gone: on Windows the
  `claude` that matters lives in WSL, and gating on it also hid the skill from "is it worth it?".
- **`npm run doctor -- --json` never worked from a checkout** until this: the root script ran a
  nested `npm run`, which parses `--json` as its own config, and `oswrap.mjs` handed Windows no
  arguments at all. The doctor script now ends in `--` (npm forwards what follows), `oswrap.mjs`
  passes what comes after that `--` to the Windows task, and `host.mjs` prints its own lines to
  stderr under `--json`. Verified 2026-10-08 on Windows and in WSL: stdout parses, exit 1 on a fail.

## A second desktop as a peer: WSL2, and an OrbStack VM to rehearse it

Paired hosts delegate jobs to each other ([host.md](host.md#peers--delegating-a-job-to-another-waterplane-host); SECURITY.md for the trust
model). Windows is reached only as a waterplane host inside WSL2, so a peer setup is the WSL2 install
plus pairing — a release install inside the distro (below), or a Windows checkout or npm install driving WSL
([the next section](#windows-the-launcher-drives-the-host-in-wsl)).

**WSL2 box.** `wsl --install -d Ubuntu`; `[boot] systemd=true` in `/etc/wsl.conf`, then `wsl --shutdown`.
Tailscale: either the Windows client with `networkingMode=mirrored`, or `tailscale up` inside the
distro. Mirrored was verified on a real Windows 11 box (2026-10-07): the Windows Tailscale 100.x
shows up on a mirrored `eth0`, `tailscaleIp()` (which matches the address, not an interface name)
finds it and the host binds it; the Windows `tailscale.exe` is reached through interop for the
MagicDNS name and `serve` (`net.ts`' `tailscaleBin`), and a Windows-side `tailscale serve --https=443
http://127.0.0.1:<port>` reaches the WSL host over the shared loopback. Install waterplane,
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

## Windows: the launcher drives the host in WSL

The first real Windows box (2026-10-07) had the code under `C:\dev`, edited from Windows, and no
wish for a second clone. Sessions need tmux, which has no Windows build, so the daemon runs INSIDE
WSL2 — straight from the Windows files, `/mnt/<drive>/…`. One implementation drives it from
PowerShell, `packages/host/src/cli/windows.ts` (`run(argv, root, machine)`; the platform, env,
`%LOCALAPPDATA%` and `%TEMP%` are injectable, so `windowslauncher.test.mjs` pins the dispatch on
macOS without spawning wsl or powershell), for two install kinds (`installKind`: `.git` at the root ⇒
checkout, else npm):

- **A checkout:** `node scripts/windows/host.mjs <cmd>` — a thin wrapper that builds once if there is
  no `dist` yet and calls `run`. The root `restart`, `stop`, `start`, `doctor` and `dev` scripts reach it
  through `scripts/oswrap.mjs` on win32 (npm runs scripts under cmd.exe there, where `bash` is WSL's
  launcher and `pkill`/`VAR=x cmd` do not exist), and run their old POSIX command everywhere else.
  It builds on Windows; `update` refuses (a checkout updates with `git pull` + `npm run restart`).
- **An npm global install:** `npm i -g <slug>`, then `<slug> setup | start | stop | restart | status |
  doctor | autostart | update | pair | version` — `cli/index.ts` sends every command to `windows.ts` on
  win32. Prebuilt, so nothing is built; `dev` refuses (it runs Vite from a checkout). The release
  stages `scripts/windows/keeper.ps1`, `scripts/windows/wsl-setup.sh` and `deploy/node-version` into
  the package, and refuses at stage time when either script carries a `\r` (a release built from a
  CRLF clone would ship a `wsl-setup.sh` bash dies on).
- **`update`** (npm only): always `stop` (idempotent — a keeper between two restarts counts as up),
  `npm install -g <slug>@latest`, then `<slug> start` in a FRESH process when it was up (this process
  still holds the old launcher's code). A failed install says so and names `<slug> version` to see
  what is installed now — it does not claim the old version is intact. A host that was down without a
  `stop` gets its stop flag cleared again, so the autostart task may bring it back as before.
- **`version`** prints `cli/index.ts`' `versionLine` for the install (`release.json`, else the
  checkout's package.json + git) — the same line as on every other platform.

- **One checkout, one `node_modules`.** The host's runtime needs node-pty (its tarball carries
  linux-x64 next to win32-x64) and pure JS, so WSL's Node runs `packages/host/dist/main.js` straight
  from `/mnt/c/...`. Building stays on Windows: the esbuild/rollup binaries installed are the Windows
  ones, which is also why `dev` on Windows is the built host in WSL (`<PREFIX>DEV=1`) plus Vite on
  Windows, not `tsx watch`.
- **The root may be written the Windows way.** The repo `.env` is read by both sides, so under WSL a
  drive-letter `<PREFIX>ROOT` (or chosen root) is its `/mnt/<drive>` mount (`branddirs.ts`'
  `wslMountPath`). And `env.ts` now reads the repo and per-user `.env` into a scratch copy BEFORE
  resolving the root and the state dir — until then a root set only in `.env` was silently ignored.
- **`setup`** writes `networkingMode=mirrored` under `[wsl2]` in `%UserProfile%\.wslconfig` (never
  overriding another mode) and runs `scripts/windows/wsl-setup.sh --kind <checkout|npm>` in the
  distro: the pinned Node into `~/.local/opt`, the native Linux `claude`, and git settings.
  For a CHECKOUT it sets three global ones, because its repos are on `/mnt/<drive>` and Git for
  Windows writes them: `core.autocrlf=true` (Git for Windows' default — without it every CRLF
  checkout on `/mnt/c` reads as modified); `core.checkStat=minimal` + `core.trustctime=false` (the
  index Git for Windows writes carries stat fields Linux sees differently, so every `git status` from
  WSL re-read every tracked file over 9P). For an NPM install it only PRINTS those three, "only if
  your repos live on /mnt/<drive> and Git for Windows writes them": its repos may well live in the
  Linux filesystem, where a global `autocrlf=true` checks every file out with CRLF. Both kinds get
  `user.name`/`user.email` copied from Git for Windows through interop when absent (a commit made
  from the phone runs WSL's git, which had no identity: the commit failed); it fills an absence,
  never overwrites. Run by hand with no flag, the script behaves as for a checkout. Before that,
  the launcher checks there IS a distro (none: it says `wsl --install -d Ubuntu-24.04` in an admin
  shell, reboot, open Ubuntu once — a script can do none of that) and installs a missing
  tmux/git/curl/xz with apt as WSL's root (`wsl -u root`: no password, so no `sudo` prompt),
  retrying once with `/var/lib/apt/lists` cleared — the first box's index was truncated and failed
  every apt-get. Another package manager gets the names. The same box's dpkg database was EMPTY
  (every file under `/var/lib/dpkg` 0 bytes, binaries intact): apt then thinks nothing is installed,
  tries to reinstall libc6 and dies on "corrupt info database format file". Both the launcher
  (`cli/windows.ts`) and `wsl-setup.sh` name that instead of running into it; nothing repairs it (reinstalling the distro
  does). That is also why `gh` comes from its official release (`deploy/gh-version`, checked against
  the release's checksums, into `~/.local/opt` like Node) and not from apt: a person's first
  `sudo apt install gh` met a `sudo` password they never knowingly set — WSL's Linux password, from
  the first launch — and then that broken database. `wsl-setup.sh` says both: which password `sudo`
  wants, and `wsl -u root passwd <user>` to reset it. A tmux older than 3.3 (Ubuntu 22.04's
  3.2a) is flagged there, not left for a session's first pane to show the tmux.conf error.
- **Worktrees Windows git made** (Claude Code's `.claude/worktrees/…`) record `C:/dev/…` paths;
  `git worktree list` in WSL prints them as is, and `repos.ts` maps them to `/mnt/c/…`. Linux git
  cannot follow the `gitdir: C:/…` inside such a worktree, so its own `git status` fails there
  (counted as 0 changes) until it is recreated from WSL or with `worktree.useRelativePaths`.
- **`wsl.exe` without a console exits at once, silently** — spawned `detached`, or as the child of a
  detached process. `start` therefore launches the keeper (`scripts/windows/keeper.ps1`) through
  `Start-Process -WindowStyle Hidden`, which gives it a hidden console. The keeper is PowerShell, not
  Node, so a Node upgrade never finds `node.exe` busy and logon needs no Node at all. It holds
  `wsl.exe` (so the distro and its VM stay up while the host runs), `exec`s
  `node '<install>/packages/host/dist/main.js'` by its ABSOLUTE path, and restarts the host after a
  crash with backoff; `stop` writes the stop flag first so it does not. `autostart` registers a
  per-user scheduled task running `keeper.ps1 -Ensure` at logon, on wake, on unlock and every 10
  minutes. It replaced a Startup-folder `.cmd` (logon only) after a Windows Update "restart now"
  killed the keeper, the restart never completed (lid shut → sleep), and with no new logon the host
  stayed down for 13 h. `-Ensure` is a no-op while the stop flag is set, the host answers, or another
  keeper of THIS install runs, so `stop` still means stopped. The action is
  `conhost.exe --headless powershell.exe …`: a console for wsl.exe, no window flashing every 10
  minutes. The task sets no execution time limit (default 72 h), keeps running on battery, and
  priority 5 (a task's default 7 is below-normal, inherited by every session). Still nothing before
  the first logon — that would need a service and stored credentials. Windows Tailscale without
  "Run unattended" has the same hole: the update-restart killed its tray app too, and the host then
  bound loopback only until Tailscale was back and the host restarted.
- **Per-install names, one function** (`launcherNames`). Everything one user's installs could share
  on one machine — task, stop flag, log — is decided there; a checkout and an npm install on one box
  used to collide (B's `stop` wrote the flag A's task honours; B's `autostart -Force` replaced A's
  task). A CHECKOUT keeps the names it always had — task `<slug>-host`, `<slug>-host.stopped`,
  `<slug>-host.log` — so the box whose task is already registered needs no migration. An NPM
  install has its own: task `<slug>-host-npm`, `<slug>-host-npm.stopped`, `<slug>-host-npm.log`.
  Two CHECKOUTS on one machine still share the checkout names (the second `autostart` takes the task
  over); two npm installs (one per Node under nvm-windows) share the npm ones. The doctor's
  `wsl-idle` accepts both task names (`keepTaskNames`, from `launcherTaskName` in `doctorwsl.ts`).
- **The stop flag and the log live in `%LOCALAPPDATA%\<slug>\`**, not `%TEMP%`: Storage Sense may
  empty Temp, which would bring a deliberately stopped host back. Both survive a reboot, and that is
  the rule: **a stopped host stays stopped across a reboot** (as it always did — Temp survives one
  too) until `start` clears the flag; the autostart task honours it at logon. Backward compatible
  for the checkout: a task or keeper registered by the older launcher reads `%TEMP%\<slug>-host.stopped`,
  so the checkout's `stop` writes (and `start` clears) BOTH flags until `autostart` is run again,
  which registers the new paths; a failed `start` tails whichever of the two logs was written last.
- **The launcher's knobs** (`<PREFIX>PORT`, `<PREFIX>WSL_DISTRO`, `resolveKnobs`): the shell, then the
  install's launcher file `%LOCALAPPDATA%\<slug>\launcher-<id>.json` (`id` = the first 8 hex of a
  sha256 of the install's WSL path, lower-cased — `installId`), then (checkout only) the repo
  `.env`, then the default. An npm install has no `.env` on the Windows side, so a value it was given
  in the shell on `setup`/`start`/`restart`/`autostart` is WRITTEN there (atomic, `jsonstore.ts`):
  before, a later `stop` from a plain shell targeted the default port — and with nothing answering
  there, `taskkill`ed the keeper without the daemon's SIGTERM flush. A checkout never writes the file:
  its place for the knobs is the repo `.env`, and a remembered shell value would silently outrank an
  edit there. A port from the shell or the file is handed to the host (`<PREFIX>PORT=` before
  `exec`, and before `doctor` and `pair`), so the host and the launcher ask the same port. Only the
  launcher reads `WSL_DISTRO`.
- **Rebuild on pull** (`scripts/autoupdate.mjs install`): local `post-merge`/`post-rewrite` hooks
  that run `npm run restart` detached whenever a merge, pull or `pull --rebase` changes
  host/web/shared code (log `<tmp>/<slug>-autoupdate.log`). Only the main checkout acts (hooks are
  shared with agent worktrees); a lockfile change only prints the `npm ci` step, because
  `npm ci` replaces the node_modules the running host loads.
- **One keeper, always.** The keeper reads the stop flag only once its `wsl.exe` returns, seconds
  after the daemon is gone, and `start` clears the flag — so `stop` also waits for the keeper to
  exit (and kills one that does not), and `start` launches none while one is still running. Without
  that, a restart left the old keeper to boot a second daemon beside the new one. A keeper is THIS
  install's when its command line holds `-Repo "<install>"` exactly, matched through
  `[WildcardPattern]::Escape` (`keeperPatternPs`, and the same in `keeper.ps1 -Ensure`): the old
  `-like '*<path>*'` let `/mnt/c/dev/usmc` match the keeper of `/mnt/c/dev/usmc-peer`, and `[`/`]`
  in a path are wildcards.
- **A restart from inside WSL** (a session driven from the phone runs there) goes through
  `scripts/restart.sh`, which on a `/mnt/<drive>/` checkout hands the whole job to Windows
  (`cmd.exe /c npm run restart`): building in WSL fails on the Windows esbuild/rollup, and a daemon
  started with `nohup` there is one no keeper holds. So "pull, then `npm run restart`" works from the
  phone too.
- **Stopping THIS install's daemon** (`stopScript`): a process is this install's when its argv is
  `node <install>/packages/host/dist/main.js` (the ABSOLUTE path today's keeper execs), or `node
  packages/host/dist/main.js` RELATIVE with `readlink /proc/<pid>/cwd` = the install — an older
  keeper ran the relative path, and every keeper runs `wsl.exe --cd <install>`, so the cwd is what
  tells the box's already-running daemon apart from another install's with no migration. The port
  only NARROWS: when `ss -Hltnp "sport = :<port>"` names a listener that is this install's, only it
  is signalled (a second host started from the same tree on another port is left alone); else, and
  with no `ss` at all, every `/proc/<pid>` is walked with the same rule. The first version signalled
  ANY host `main.js` listening on the port — with two installs on one port, the other one's daemon.
  The old `pkill -f '^node packages/host/dist/main.js'` matched every install's daemon in the distro.
  Never `pkill -x node`: Node names its main thread `MainThread`, which is what `comm` shows. The
  script prints what it found (`stop: port|proc|none … ss=0|1`), and a `stop` that ends forced
  says WHY (`stopVerdict`) — "no daemon of this install found in WSL (ss is not installed there…)",
  the daemon outlasting SIGTERM by 16 s, WSL not answering — where it used to print a bare
  "stopped (forced)". `windowslauncher.test.mjs` RUNS the script under bash against a fake `/proc`.
- **The migration path is tested off Windows**: `run()` takes every child (`LauncherMachine.exec`,
  spawnSync's shape), the health probe, `sleep` and the keeper listing, so the test drives `stop`,
  `start`, `restart` and `update` on macOS — checkout `stop` writes both flags and hands `stopScript`
  to `wsl.exe … bash -lc`, `start` clears both, npm `stop` writes only its own, npm `update` is
  stop → install → a fresh `<slug> start`.
- **An old task after a pull:** the checkout's task registered before the flag left `%TEMP%` still
  names the Temp flag and log in its action. It keeps working (`stop`/`start` write and clear that
  flag too), and the checkout's `status` and `stop` read the action (`Get-ScheduledTask … .Actions[0]
  .Arguments`, `staleTaskNote`) and say "run `node scripts/windows/host.mjs autostart` again to move
  the task to the new paths" — a sentence, never a re-registration on its own.
- **One build, not two:** `scripts/windows/host.mjs` builds when `dist/cli/windows.js` is missing and
  then tells `run` so (`justBuilt`); a first `restart` used to build again (~100 s each on the first
  box).
- **`npm run stop` from inside WSL** on a `/mnt/<drive>/` checkout goes to Windows the way `restart`
  does (`scripts/oswrap.mjs`: `cmd.exe /d /c npm run stop`): the keeper honours only a stop flag
  written on the Windows side, and the POSIX `pkill -f …main.js` stopped every install's daemon in
  the distro. macOS and Linux run the POSIX command as before.
- **WSL interop can disappear from a RUNNING distro.** Measured on the owner's box (2026-10-09):
  every Windows binary run from WSL failed with "Exec format error" — `cmd.exe`, `tailscale.exe`,
  `schtasks.exe`, `git.exe` all still on PATH, none runnable. Hypothesis, NOT yet confirmed by the
  live test: a second systemd distro shutting down runs `systemd-binfmt --unregister`, which clears
  the binfmt_misc table every distro shares with the one kernel. What it costs here: the MagicDNS
  name and `tailscale serve` URL (the phone's HTTPS link), the doctor's keep-task row, a phone-driven
  `npm run restart`/`stop`, and setup's git identity. So everything that needs Windows now RUNS a
  Windows program before relying on one (`command -v` and `X_OK` both pass with interop off): the
  doctor's `wsl-interop` row (`cmd.exe /d /c exit 0`, never the `WSLInterop` binfmt entry — newer
  WSL registers `WSLInterop-late`), `restart.sh`, `oswrap.mjs`'s `stop`, `net.ts`' `tailscaleBin`
  (a `tailscale.exe` that cannot run is null) and `wsl-setup.sh` ("Git for Windows unreachable from
  WSL — interop off?"). Fix: `wsl --shutdown` from Windows (every WSL session stops), or as root in
  the distro `sudo sh -c 'echo :WSLInterop:M::MZ::/init:PF > /proc/sys/fs/binfmt_misc/register'`.
- **HTTPS:** `tailscale serve --bg --https=443 http://127.0.0.1:<port>` run on WINDOWS fronts the WSL
  host (mirrored loopback); restart the host afterwards so it discovers the front door
  (`secure-context` in the doctor turns ok).
- **Windows-side Node is build and test tooling only.** `npm test`'s unit layer imports `.ts`
  directly, which needs a Node with type stripping on by default (the pinned one has it); the pinned `deploy/node-version`
  is the one to install (`winget install OpenJS.NodeJS.LTS` — per-machine, so it asks for UAC). On
  an older Node those tests fail with `ERR_UNKNOWN_FILE_EXTENSION`; run them in WSL meanwhile. Under
  WSL the few tests that run esbuild (`tsx`, the server-rendered goldens) fail on the Windows
  `node_modules` — expected, they pass on the Windows side.
- **CRLF in an older clone.** A clone made before `.gitattributes` said `eol=lf`, under Git for
  Windows' `autocrlf=true`, keeps CRLF files that git never rewrites; shell scripts run in WSL then
  die on `\r`, and the CLAUDE.md budget and golden tests fail. Rewrite the files `git ls-files --eol`
  lists as `i/lf w/crlf` with LF, then `git add --renormalize` those paths (no content change is
  staged; it only refreshes the index).
- **`/mnt/c` is the slow part, and it froze the host.** Over 9P one `stat` is ~20 ms and a
  `git status` up to minutes for a big repo. Measured on 36 repos (2026-10-08): repo discovery was
  `readdirSync` + a `statSync` per entry + a `git worktree list` per repo — 233 s, all but the git
  part SYNCHRONOUS, so the daemon answered nothing (health included) for minutes at a time, and the
  phone said "loading repos… the connection may be down" and then "No repos under host root".
  `/api/repos` then waited on 38 parallel `git status` runs: 400 s. Now: the walk is async with
  entry types from `readdir` (`repos.ts`), a single-worktree repo is read off `.git/HEAD` with no
  git spawn, concurrent scans share one — 7 s; the listing answers a fresh scan within 1.5 s or the
  last one (`listTargets`; anything that decides, like `containRepoDir`, still scans fresh); and git
  counts run four at a time, cached, with the listing waiting 2.5 s at most (400 ms once every repo
  has a count) — a count not in yet is left out and arrives with the next listing
  (`git.ts`' `changedCountsWithin`). Listing: ~3 s; health stays in milliseconds. On a local disk
  every step finishes inside its budget, so nothing is stale there. The doctor's `wsl-root` warn is
  still right: repos in the Linux filesystem are an order of magnitude faster.
- **…and froze it again, from three more synchronous paths** (2026-10-08). A restart left the host
  listening and answering nothing for 13 minutes. Found by sampling the main thread as root:
  `/proc/<pid>/task/<pid>/syscall`, the path argument read out of `/proc/<pid>/mem` — the loop was
  `statx`/`openat` over 9P, file after file. The three paths:
  - **The setup sweep** ran `inspectRepo` at boot, whose git probes were `execFileSync` and whose
    Android, APK-module and build-scan walks listed (and the APK one `stat`ed, entry by entry) up
    to 400 directories each — ~9 s held for a vcpkg checkout — and it persisted `checkedAt` only
    when a verdict changed, so every restart found all 36 worktrees stale and re-ran the lot. The
    sweep now uses `inspectRepoAsync`: two background git calls and the three walks done async
    beforehand, the same checklist (`complianceasync.test.mjs` compares every row); the longest
    block per repo is now 20–70 ms. The times are saved once per pass.
  - **The artifact walk** (`discoverArtifacts`, repo scope) `stat`ed every file of a tree: the
    cross-repo search behind the gallery walked all 36 repos that way, and a session's image and
    auto-pull baselines walked its repo at create and at every turn end. `discoverArtifactsAsync`
    is that walk with the same answer; the outbox-only scans (a few files) stay sync.
  - **`git status` re-run for every repo on every listing**, four at a time, kept the bridge busy
    for good — which made every other file call slower. A count is now fresh for ten times as long
    as it took (capped at five minutes): every listing still re-asks on a local disk.

  The boot doctor's "claude / git / curl not found" in that log was the same freeze: `which` gave
  `command -v` an 8 s leash, the timer fired on a child that had exited, and its stdout came back
  empty. An answer that took the whole leash is now re-asked of the PATH directly (`onPath`).
- **The keeper log** got only stderr: `wsl.exe` writes stdout and stderr to a redirected file each
  from its own offset, so they overwrote each other ("listening …" was lost). The daemon's `2>&1`
  is done inside Linux now.
- **Boot:** ~25–35 s until `/api/health` answers with the root on `/mnt/c` (start, restart and
  crash-restart alike); `start` waits up to two minutes. A bare host on an empty root still takes
  28–44 s from `/mnt/c` (loading its own modules over 9P) and 3–5 s from the Linux filesystem, so
  an e2e script that boots a host waits for `/api/health` (`waitForHost`, `E2E_BOOT_MS` to lengthen
  it), never a fixed sleep; most of the suite only passes in WSL from a Linux-filesystem copy.

## Google Play: `npm run release:play`

The `play` flavor goes to Play from this desktop, never through Play Console after the first upload.
`scripts/release/play.mjs` (pure parts `play-lib.mjs`, tests `play-lib.test.mjs`) talks to the
Android Publisher API v3 directly: a service-account key signs one RS256 JWT with `node:crypto`,
and the rest is a handful of REST calls inside one *edit* that is committed with `--yes` and
deleted otherwise. **No dependency**: Gradle Play Publisher would add a plugin plus the Google API
client to `verification-metadata.xml`, and fastlane a Ruby toolchain, for what is ~10 calls.

- **Dry run by default**, like `release:publish`. The dry run still signs in, opens an edit and
  reads the tracks, so it proves the key and the Console permissions before anything is built.
- **versionCode** is one past the highest code on *any* track, never below build.gradle's default
  (now a `-PversionCode` property); **versionName** is the root `package.json` version. A code is
  spent by an upload even if its release is dropped; Play's refusal says so, and `--version-code` overrides.
- **The AAB carries the web UI of this working tree**, so `--yes` with a build refuses uncommitted
  changes under `packages/{web,shared,app,extensions}` (`--allow-dirty` overrides). After install,
  the UI updates over the air as everywhere else; a Play release is needed only for shell changes.
- **Store text, images and release notes are files** under `packages/app/play/` (Play's own field
  and image-type names), so a listing change is a diff and `listing --yes` pushes it.
- **What the API cannot do** and stays manual, once: creating the app, the first bundle upload
  (`Package not found` until then — `explainApiError` says so), the App content declarations
  (data safety, content rating, permissions forms), and, for a new personal account, the 12-tester
  14-day closed test before production. Setup: `packages/app/play/README.md`.

## The Android app outside Play: trust, and what F-Droid would take

Checked 2026-10-08. The question was: who sideloads an APK from someone they don't know? Few
people do. The trust they would need is mostly spent on the desktop installer anyway, so the APK's
job is to not lose it. The order picked: say plainly what the app does
([permission table](../../packages/app/README.md#permissions-and-what-each-one-is-for), the browser
version as the no-install route), then Play, then a verifiable release APK, then F-Droid if people
ask for it.

**What the release APK is today.** `release:build --apk` accepts only the `dev` flavor
(`apk-lib.mjs`), signed with the owner's dev key and built on the owner's machine. A stranger gets
the owner's dogfood build: it self-updates, installs quietly, and is labelled *waterplane dev*.
Nothing published lets them check that the file came from us: the signing certificate's SHA-256 is
not in the README or the release notes. Two cheap fixes, both waiting on the owner because they need
the keystore:
- Publish the dev cert fingerprint (`apksigner verify --print-certs`) in the README and in every
  release body. That is what AppVerifier and Obtainium check against.
- Once the repo is public, Actions minutes are free there, which removes the reason they are off. A
  CI job can build the APK and attach `actions/attest-build-provenance`. The catch is that signing
  in CI puts the key in a GitHub secret. Building unsigned in CI and checking it against the
  locally signed APK (`apksigcopier compare`) avoids that, and it is the same reproducibility
  F-Droid would want.

**What a `foss` flavor for F-Droid would need.** None of it is built yet.
1. **Drop the Google services plugin.** `android/build.gradle` has the
   `com.google.gms:google-services` classpath and `app/build.gradle` ends in a try-apply of it, both
   left over from the Capacitor template. There is no `google-services.json` and no push plugin,
   so it is never applied, but F-Droid's scanner flags the coordinate. Removing it changes nothing
   for `dev`/`play`. Regenerate `verification-metadata.xml` after removing it.
2. **Self-update off, quiet installs on.** F-Droid updates the app, so `SELF_UPDATE=false` as in
   `play`. Quiet updates of *other* apps can stay, because `UPDATE_PACKAGES_WITHOUT_USER_ACTION` is a
   normal permission (F-Droid's own client holds it). Two places assume there are only two flavors:
   `Installs.SELF_UPDATE_REFUSED` names Google Play, and `web/installPolicy.ts` knows only
   `"dev" | "play"`. A third word reads as absent there, which means inherit the full `dev`
   behaviour, so the page would offer a self-update the shell then refuses. **The web bundle has to
   learn `foss` before any foss shell ships.** Over-the-air updates make that ordering natural.
3. **Build from source in F-Droid's server.** That means `npm ci`, shared → web, `cap sync`, then
   gradle. F-Droid's build image needs a Node new enough for the web build, either through `sudo:`
   in the metadata or a srclib. This is not tested.
4. **`versionCode 2` / `versionName "1.0"` are hard-coded** in `app/build.gradle`. F-Droid's update
   check reads tags and `versionCode`, so it has to follow the release version.
5. **Signing and id.** F-Droid signs with its own key unless the build is reproducible, and then
   it can ship ours. Either way an install from one source cannot update an install from another.
   Whether `foss` reuses `dev.waterplane.app` (Play's id) or gets its own is the owner's call.
6. **Open policy question: the UI updates over the air from the person's own desktop.** That is a
   self-hosted FOSS server serving its own bundle, the same as a browser opening it, so it should not
   be NonFreeNet. Still, ask in the F-Droid RFP before building the flavor. It is the one thing that
   could make the rest moot.
