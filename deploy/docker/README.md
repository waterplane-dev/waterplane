# waterplane in Docker

Run the waterplane host in a container: on a home server, a NAS, a cheap VPS, or next to your
other containers on a desktop. The phone reaches it over your tailnet, exactly as it reaches a
desktop install. The container joins your tailnet itself, as its own machine.

> **Read this first.** The host spawns `claude`, which reads, edits and runs code. The container
> is a convenience, not a sandbox you should trust with secrets. The security boundary is still
> your tailnet: anyone who can reach port 8770 can, in effect, use this container and everything
> mounted into it. The compose file publishes **no ports** on purpose. Do not add
> `ports: ["8770:8770"]`. See [SECURITY.md](../../SECURITY.md).

## What is in the image, and what is not

| | In the image | Why |
|---|---|---|
| waterplane, its pinned Node, tmux, git | yes | installed with the same verified `install.sh` a desktop uses |
| Tailscale | yes | so the container gets its own tailnet address |
| Claude Code | **no**, installed on first start | It is Anthropic's software, not ours to redistribute. The entrypoint runs Anthropic's own installer into your home volume, where it also auto-updates. |
| JDK + Android SDK | **only if you build with `ANDROID=1`** | The SDK licence has to be accepted by you. Leave it out and the phone's first-app flow installs it later, behind a consent screen that links the licence. |

You build the image yourself, from this directory. No prebuilt image with the SDK or Claude Code
in it is published, for the reasons above.

## Quick start

You need Docker (or [OrbStack](https://orbstack.dev) on a Mac) and a [Tailscale](https://tailscale.com)
account, with the Tailscale app on your phone.

```bash
git clone https://github.com/waterplane-dev/waterplane.git
cd waterplane/deploy/docker
docker compose up -d --build
docker compose logs -f
```

**Until the first public release** the published installer is not online yet, so build from a
release you made yourself. From the repo root, run `npm ci && npm run release:build && npm run
release:install-sh`, then `WATERPLANE_RELEASE_DIR=../../dist-release docker compose up -d --build`.

The log does three things in order:

1. **Joins your tailnet.** On the first start it prints a link (`To authenticate, visit:
   https://login.tailscale.com/a/…`). Open it and approve the machine. The identity is kept in the
   `tailscale` volume, so this happens once. To skip the link, put an
   [auth key](https://login.tailscale.com/admin/settings/keys) in `TS_AUTHKEY` (see
   [Settings](#settings)).
2. **Installs Claude Code** into the home volume (once).
3. **Starts the host:** `listening http://100.x.y.z:8770`.

Then sign in to Claude and pair your phone:

```bash
# Sign in to Claude Code once (or do it from the phone: open a session, tap its sign-in button)
docker compose exec -u wp waterplane claude

# Pair the phone: prints a link and a code
docker compose exec -u wp waterplane waterplane pair
```

Open the link on your phone. On the tailnet the machine is called `waterplane` (change it with
`TS_HOSTNAME`).

**Always pass `-u wp`** to `docker compose exec`. Without it you are root in the container, and
anything you create (a `claude` login, a cloned repo) ends up owned by root, where the host
cannot use it.

### HTTPS (recommended)

The entrypoint runs `tailscale serve --bg --https=443 http://127.0.0.1:8770`, so the phone gets
`https://waterplane.<your-tailnet>.ts.net`. Only an HTTPS address gives the phone push
notifications, the install prompt, the clipboard, and an app that survives the tunnel dropping.
For that to work, turn on **MagicDNS** and **HTTPS certificates** once in the
[tailnet's DNS settings](https://login.tailscale.com/admin/dns). If they are off, the log says so
and the plain `http://100.x.y.z:8770` address still works.

## Your repos

Repos live in `/home/wp/dev` inside the `home` volume. That is everything the phone can open.
Clone into it:

```bash
docker compose exec -u wp waterplane git clone https://github.com/you/your-app.git dev/your-app
```

For pushing, give the `wp` user credentials the way you would on a fresh machine: a deploy key in
`~/.ssh`, or `gh auth login` after installing `gh`. Only use credentials you would also let
`claude` use.

If you want the files on the host disk, replace the named volume with a bind mount in
`compose.yaml`. The directory must belong to uid 1000:

```yaml
    volumes:
      - ./home:/home/wp
```

## Building Android apps

The phone builds an APK on the server and installs it on itself. **No emulator is involved, so
there is no KVM to pass through.** Two ways to get the toolchain:

- **Nothing to do now (the default).** The first time a repo needs it, the phone offers to install
  a JDK and the Android SDK into the home volume. It shows the licence and asks before accepting
  it.
- **Bake it into the image** with `ANDROID=1`. By building it, you accept the
  [Android SDK licence](https://developer.android.com/studio/terms) for the packages it installs
  (`platform-tools`, `platforms;android-36`, `build-tools;35.0.0`, plus OpenJDK 21):

  ```bash
  WATERPLANE_DOCKER_ANDROID=1 docker compose up -d --build
  ```

**ARM machines** (Apple silicon, Ampere and Graviton servers, Raspberry Pi): Google ships the SDK's
build tools for x86_64 Linux only, so an ARM container cannot build an APK. Uncomment
`platform: linux/amd64` in `compose.yaml`. OrbStack and Docker Desktop on Apple silicon then run it
through Rosetta. That works, but builds are slower than native. On an ARM server without
emulation, use an x86_64 machine for Android work.

Gradle is hungry. The compose file gives the container 8 GB (`WATERPLANE_DOCKER_MEM`). Below about
4 GB, builds die with an unhelpful out-of-memory error.

## Settings

Put these in a `.env` file next to `compose.yaml`, or export them before `docker compose up`.

| Variable | Default | What it does |
|---|---|---|
| `TS_AUTHKEY` | empty | Tailscale auth key. Empty means log in once through the printed link. |
| `TS_HOSTNAME` | `waterplane` | The machine's name on the tailnet. |
| `TS_SERVE` | `1` | `0` means do not set up `tailscale serve` (no HTTPS front door). |
| `TS_EXTRA_ARGS` | empty | Extra flags for `tailscale up`, e.g. `--advertise-tags=tag:waterplane`. |
| `CLAUDE_INSTALL` | `1` | `0` means do not install Claude Code on first start. |
| `ANTHROPIC_API_KEY` | empty | Use an API key instead of signing in to a Claude subscription. |
| `WATERPLANE_DOCKER_ANDROID` | `0` | `1` means bake the JDK and Android SDK into the image (you accept the licence). |
| `WATERPLANE_DOCKER_MEM` | `8g` | The container's memory limit. |
| `WATERPLANE_RELEASE_DIR` | empty | Build from a release you built yourself (`npm run release:build && npm run release:install-sh`, then `../../dist-release`), instead of the published installer. |

Every other waterplane setting ([`.env.example`](../../.env.example)) goes in
`/home/wp/.config/waterplane/.env` inside the volume, or in the phone's Settings.

## Upgrading

Rebuild the image. Your repos, logins and settings are in the volumes and stay:

```bash
docker compose build --pull && docker compose up -d
```

`waterplane update` inside the container works too, but it writes into the container's own
layer and is lost the next time the container is recreated. Prefer the rebuild. Claude Code
updates itself inside the home volume.

## Troubleshooting

- **`tailscaled did not start`** means `docker compose exec waterplane cat /var/log/tailscaled.log`.
  Usually `/dev/net/tun` is missing on the host. Without the `devices:` and `cap_add:` lines the
  container falls back to userspace networking, and the phone can only reach it through
  `tailscale serve` (HTTPS).
- **A second machine appears on the tailnet after a rebuild** means the `tailscale` volume was
  removed. Keep it; it holds the machine's identity.
- **`docker compose exec -u wp waterplane waterplane doctor`** runs the same preflight as on a
  desktop. In a container, the `capture` and `dictate` rows are expected to say "not set up".
- **Files owned by root in `~/dev`** means something ran without `-u wp`. Fix it with
  `docker compose exec waterplane chown -R wp:wp /home/wp`.

## Removing it

```bash
docker compose down        # stops it; volumes (repos, logins) stay
docker compose down -v     # also deletes the volumes: your repos in ~/dev are GONE
```

Then remove the machine from the [Tailscale admin console](https://login.tailscale.com/admin/machines).
