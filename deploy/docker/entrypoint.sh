#!/bin/sh
# waterplane container entrypoint. Runs as root only long enough to start
# Tailscale; waterplane, tmux and claude run as the unprivileged `wp` user.
#
#   1. fixes ownership of a fresh /home/wp volume;
#   2. starts tailscaled (kernel networking when /dev/net/tun is there, else
#      userspace) and brings the node up — with TS_AUTHKEY, or by printing the
#      login link to the container log and waiting for you to open it;
#   3. fronts the host with `tailscale serve` on https :443 (TS_SERVE=0 skips it),
#      so the phone gets a secure context;
#   4. installs Claude Code with Anthropic's installer if it is not in the home
#      volume yet (CLAUDE_INSTALL=0 skips it);
#   5. runs `waterplane start` (or the command you gave) as `wp`.
#
# The daemon binds the Tailscale IP and loopback only, as on a desktop. Never
# publish its port on a public interface: it spawns claude, which runs code.

set -eu

WP_USER=wp
WP_HOME=/home/wp
PORT="${WATERPLANE_PORT:-8770}"
TS_HOSTNAME="${TS_HOSTNAME:-waterplane}"
TS_STATE_DIR="${TS_STATE_DIR:-/var/lib/tailscale}"
TS_SOCKET=/var/run/tailscale/tailscaled.sock

say() { printf '[waterplane-docker] %s\n' "$*"; }
warn() { printf '[waterplane-docker] %s\n' "$*" >&2; }
as_wp() { setpriv --reuid="$WP_USER" --regid="$WP_USER" --init-groups env HOME="$WP_HOME" USER="$WP_USER" LOGNAME="$WP_USER" SHELL=/bin/bash "$@"; }

if [ "$(id -u)" != 0 ]; then
  warn "the entrypoint needs root to start Tailscale; it drops to '$WP_USER' itself. Do not set user: in compose."
  exit 1
fi

# ── 1. home volume ──────────────────────────────────────────────────────
mkdir -p "$WP_HOME/dev"
if [ "$(stat -c %U "$WP_HOME")" != "$WP_USER" ]; then
  say "taking ownership of $WP_HOME for $WP_USER"
  chown -R "$WP_USER:$WP_USER" "$WP_HOME"
fi

# ── 2. tailscale ────────────────────────────────────────────────────────
if [ "${TS_DISABLE:-0}" = 1 ]; then
  warn "TS_DISABLE=1: no Tailscale. The host binds loopback only, so nothing outside this container reaches it."
else
  mkdir -p "$TS_STATE_DIR" "$(dirname "$TS_SOCKET")"
  if [ -c /dev/net/tun ]; then
    TUN_ARGS=""
    say "starting tailscaled (kernel networking)"
  else
    TUN_ARGS="--tun=userspace-networking"
    warn "no /dev/net/tun: starting tailscaled in userspace mode. The phone can then reach the host only"
    warn "through 'tailscale serve' (https). Add the device and NET_ADMIN (see compose.yaml) for the 100.x address too."
  fi
  # shellcheck disable=SC2086
  tailscaled --state="$TS_STATE_DIR/tailscaled.state" --socket="$TS_SOCKET" $TUN_ARGS >/var/log/tailscaled.log 2>&1 &
  i=0
  until tailscale --socket="$TS_SOCKET" status --json >/dev/null 2>&1 || [ -S "$TS_SOCKET" ]; do
    i=$((i + 1)); [ "$i" -lt 50 ] || { warn "tailscaled did not start; see /var/log/tailscaled.log"; exit 1; }
    sleep 0.2
  done

  UP_ARGS="--hostname=$TS_HOSTNAME --operator=$WP_USER"
  if [ -n "${TS_AUTHKEY:-}" ]; then UP_ARGS="$UP_ARGS --authkey=$TS_AUTHKEY"; fi
  if ! tailscale --socket="$TS_SOCKET" status >/dev/null 2>&1; then
    if [ -z "${TS_AUTHKEY:-}" ]; then
      say "this container is not on your tailnet yet. Open the link below to add it (the state is kept in the"
      say "tailscale volume, so this happens once). Or set TS_AUTHKEY and restart."
    fi
  fi
  # shellcheck disable=SC2086
  tailscale --socket="$TS_SOCKET" up $UP_ARGS ${TS_EXTRA_ARGS:-}
  # The key has done its one job. Nothing below needs it — least of all the agents the
  # daemon spawns, which inherit its environment (`ptyenv.ts`): a key an agent could print
  # or commit is a device on your tailnet for whoever reads it.
  unset TS_AUTHKEY TS_EXTRA_ARGS UP_ARGS
  TS_IP="$(tailscale --socket="$TS_SOCKET" ip -4 2>/dev/null | head -n1 || true)"
  say "on the tailnet as $TS_HOSTNAME${TS_IP:+ ($TS_IP)}"

  # ── 3. https front door ───────────────────────────────────────────────
  if [ "${TS_SERVE:-1}" = 1 ]; then
    if tailscale --socket="$TS_SOCKET" serve status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
      say "tailscale serve already fronts port $PORT"
    elif tailscale --socket="$TS_SOCKET" serve --bg --https=443 "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
      say "tailscale serve: https on :443 -> 127.0.0.1:$PORT"
    else
      warn "tailscale serve failed (is HTTPS enabled for your tailnet? admin console -> DNS -> HTTPS certificates)."
      warn "The phone can still use http://${TS_IP:-<tailscale ip>}:$PORT, without push, install or offline use."
    fi
  fi
fi

# ── 4. claude ───────────────────────────────────────────────────────────
if ! as_wp sh -c 'command -v claude' >/dev/null 2>&1; then
  if [ "${CLAUDE_INSTALL:-1}" = 1 ]; then
    say "installing Claude Code into $WP_HOME with Anthropic's installer (https://claude.ai/install.sh)"
    as_wp sh -c 'curl -fsSL https://claude.ai/install.sh | bash' ||
      warn "the Claude Code install failed; sessions will not start until claude is on PATH. Retry with a restart."
  else
    warn "CLAUDE_INSTALL=0 and no claude on PATH: sessions will not start until you install it."
  fi
fi
if as_wp sh -c 'command -v claude' >/dev/null 2>&1 && [ ! -s "$WP_HOME/.claude/.credentials.json" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  say "Claude Code is not signed in yet. Sign in from the phone (it shows the login link), or run:"
  say "  docker compose exec -u wp waterplane claude"
fi

# ── 5. waterplane ───────────────────────────────────────────────────────
cd "$WP_HOME"
# Belt to the unset above: whatever path got here, the daemon and every PTY under it
# start without the tailnet key.
unset TS_AUTHKEY TS_EXTRA_ARGS
case "${1:-start}" in
  start|doctor|pair|version|--version|help|--help) exec setpriv --reuid="$WP_USER" --regid="$WP_USER" --init-groups \
    env -u TS_AUTHKEY HOME="$WP_HOME" USER="$WP_USER" LOGNAME="$WP_USER" SHELL=/bin/bash waterplane "$@" ;;
  *) exec setpriv --reuid="$WP_USER" --regid="$WP_USER" --init-groups \
    env -u TS_AUTHKEY HOME="$WP_HOME" USER="$WP_USER" LOGNAME="$WP_USER" SHELL=/bin/bash "$@" ;;
esac
