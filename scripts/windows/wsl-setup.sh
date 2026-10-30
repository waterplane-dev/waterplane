#!/usr/bin/env bash
# Provision the WSL distro the Windows host runs in — no sudo, idempotent, user-local.
# Run by the Windows launcher's `setup` (`packages/host/src/cli/windows.ts`) with `--kind
# checkout|npm` (or by hand inside WSL from the install; no flag = checkout). On Windows the daemon
# runs INSIDE WSL from the Windows install (/mnt/c/...): it needs tmux, which has no Windows build.
# What it needs from the distro:
#   - tmux + git        (apt, as root: installed by host.mjs's ensurePackages through `wsl -u root`
#                        before this runs; run by hand without them, this only names them)
#   - the pinned Node   (deploy/node-version, official linux-x64 build into ~/.local/opt)
#   - a Linux `claude`  (the Windows claude.exe reached through interop cannot drive a Linux PTY)
#   - a Linux `gh`      (deploy/gh-version, the official release, checksum-checked, into ~/.local/opt:
#                        a phone shell's `gh auth login` and an agent's PR need it, and the first box's
#                        apt could not install it — see the dpkg check below)
#   - git's line endings matching Git for Windows (core.autocrlf=true), or every repo checked
#     out from Windows reads as modified to the git the host runs. A CHECKOUT install sets it: its
#     repos are on /mnt/<drive>, written by Git for Windows. An NPM install only prints it — its
#     repos may well live in the Linux filesystem, where autocrlf=true turns checkouts into CRLF.
set -uo pipefail
kind=checkout
while [ $# -gt 0 ]; do
  case "$1" in
    --kind) kind="${2:-checkout}"; shift 2 || shift;;
    --kind=*) kind="${1#--kind=}"; shift;;
    *) shift;;
  esac
done
cd "$(dirname "$0")/../.."
BIN="$HOME/.local/bin"
mkdir -p "$BIN"
case ":$PATH:" in *":$BIN:"*) ;; *) export PATH="$BIN:$PATH" ;; esac
fail=0
say() { printf '[wsl-setup] %s\n' "$*"; }

missing=""
for c in tmux git curl tar xz; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done
# An EMPTY dpkg database (measured on the first Windows box: every file under /var/lib/dpkg 0 bytes,
# binaries intact) makes apt think nothing is installed — it tries to install libc6 and dies on
# "corrupt info database format file". Nothing here repairs it; say what it is and the way out.
if command -v dpkg >/dev/null 2>&1 && [ ! -s /var/lib/dpkg/status ]; then
  say "apt is broken in this distro: /var/lib/dpkg/status is empty, so apt cannot install anything (the programs themselves are fine)."
  say "  node, claude and gh are installed here without apt; tmux, git, curl and xz need it. The fix is reinstalling the distro (back up your WSL home first)."
fi
if [ -n "$missing" ]; then
  pkgs="$(echo "$missing" | sed 's/\bxz\b/xz-utils/')"
  say "missing:$missing — run inside WSL: sudo apt-get update && sudo apt-get install -y$pkgs"
  fail=1
fi
# The generated tmux.conf sets allow-passthrough, which tmux has had since 3.3 (`tmuxreq.ts`' TMUX_MIN).
# An older tmux shows the config error in a session's first pane, where it swallows typed text.
# Ubuntu 22.04 ships 3.2a; 24.04 ships 3.4.
if command -v tmux >/dev/null 2>&1; then
  tv="$(tmux -V 2>/dev/null | sed -n 's/^tmux [^0-9]*\([0-9]*\)\.\([0-9]*\).*/\1 \2/p')"
  set -- $tv
  if [ -n "${1:-}" ] && { [ "$1" -lt 3 ] || { [ "$1" -eq 3 ] && [ "${2:-0}" -lt 3 ]; }; }; then
    say "tmux $(tmux -V | cut -d' ' -f2) is older than 3.3 — sessions will show a tmux.conf error. Use a newer distro (wsl --install -d Ubuntu-24.04) or a newer tmux."
    fail=1
  else
    say "$(tmux -V)"
  fi
fi

want="$(tr -d ' \r\n' < deploy/node-version)"
have="$(node -v 2>/dev/null | sed 's/^v//')"
nodepath="$(command -v node 2>/dev/null || true)"
case "$nodepath" in /mnt/*) have="";; esac   # a Windows node.exe through interop is not ours
if [ "$have" = "$want" ]; then
  say "node $have ($nodepath)"
elif command -v curl >/dev/null && command -v xz >/dev/null; then
  arch="$(uname -m)"; case "$arch" in x86_64) arch=x64;; aarch64) arch=arm64;; esac
  dir="$HOME/.local/opt/node-v$want-linux-$arch"
  if [ ! -x "$dir/bin/node" ]; then
    say "installing node $want into $dir…"
    mkdir -p "$HOME/.local/opt"
    # Checked against nodejs.org's SHASUMS256.txt before it is unpacked — the same rule as
    # install.sh's Node step (the sums come over the same https channel as the tarball, so
    # this catches corruption and a swapped file, not a compromised nodejs.org).
    tarball="node-v$want-linux-$arch.tar.xz"
    opt="$HOME/.local/opt"
    if curl -fsSL --retry 3 -o "$opt/$tarball" "https://nodejs.org/dist/v$want/$tarball" \
       && curl -fsSL --retry 3 "https://nodejs.org/dist/v$want/SHASUMS256.txt" | grep -F -- " $tarball" > "$opt/$tarball.sha256" \
       && [ -s "$opt/$tarball.sha256" ] \
       && (cd "$opt" && sha256sum -c --quiet "$tarball.sha256") \
       && tar -xJ -C "$opt" -f "$opt/$tarball"; then
      :
    else
      say "node download failed, or its checksum did not match nodejs.org's SHASUMS256.txt"; fail=1
    fi
    rm -f "$opt/$tarball" "$opt/$tarball.sha256"
  fi
  for b in node npm npx; do [ -x "$dir/bin/$b" ] && ln -sf "$dir/bin/$b" "$BIN/$b"; done
  say "node $("$BIN/node" -v 2>/dev/null) → $BIN/node"
fi

cl="$(command -v claude 2>/dev/null || true)"
case "$cl" in
  ""|/mnt/*)
    if command -v curl >/dev/null; then
      say "installing the Linux Claude Code (claude.ai/install.sh)…"
      # Pinned by sha256 (same pin as deploy/docker/entrypoint.sh): a changed installer is refused,
      # never run. After reading the new one, set CLAUDE_INSTALL_SHA256 to its hash.
      sum="${CLAUDE_INSTALL_SHA256:-3a68d3406cf674e17bed1733a4dcf37805e2e47d87417700007d7e1aa766a944}"
      f="$(mktemp)"
      if curl -fsSL --retry 3 -o "$f" https://claude.ai/install.sh \
         && echo "$sum  $f" | sha256sum -c --quiet - \
         && bash "$f"; then :
      else say "Claude Code install failed, or install.sh no longer matches CLAUDE_INSTALL_SHA256"; fail=1
      fi
      rm -f "$f"
    fi
    cl="$(command -v claude 2>/dev/null || true)";;
esac
case "$cl" in
  ""|/mnt/*) say "no Linux claude on PATH"; fail=1;;
  *) say "claude $("$cl" --version 2>/dev/null | head -1) ($cl)"
     if [ ! -s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" ]; then
       say "claude is not signed in inside WSL yet — open a WSL shell, run \`claude\`, and /login once."
     fi;;
esac

want="$(tr -d ' \r\n' < deploy/gh-version)"
ghpath="$(command -v gh 2>/dev/null || true)"
case "$ghpath" in /mnt/*) ghpath="";; esac   # gh.exe through interop has no Linux login to share
if [ -n "$ghpath" ]; then
  say "$("$ghpath" --version | head -1) ($ghpath)"
elif command -v curl >/dev/null && command -v sha256sum >/dev/null; then
  arch="$(uname -m)"; case "$arch" in x86_64) arch=amd64;; aarch64) arch=arm64;; esac
  name="gh_${want}_linux_$arch"; dir="$HOME/.local/opt/$name"; url="https://github.com/cli/cli/releases/download/v$want"
  tmp="$(mktemp -d)"
  say "installing gh $want into $dir…"
  if curl -fsSL --retry 3 -o "$tmp/$name.tar.gz" "$url/$name.tar.gz" &&
     curl -fsSL --retry 3 "$url/gh_${want}_checksums.txt" | grep " $name.tar.gz\$" | (cd "$tmp" && sha256sum -c --quiet -) &&
     mkdir -p "$HOME/.local/opt" && tar -xzf "$tmp/$name.tar.gz" -C "$HOME/.local/opt"; then
    ln -sf "$dir/bin/gh" "$BIN/gh" && say "$("$BIN/gh" --version | head -1) → $BIN/gh"
  else
    say "gh download or checksum failed — not installed"; fail=1
  fi
  rm -rf "$tmp"
fi
if command -v gh >/dev/null 2>&1 && ! gh auth status >/dev/null 2>&1; then
  say "gh is not signed in yet — run \`gh auth login\` in a WSL shell (a shell tab on the phone opens its link there)."
fi

if [ "$kind" = npm ]; then
  # Global settings that are right only for repos Git for Windows writes on /mnt/<drive>: named, not set.
  unset_keys=""
  for k in core.autocrlf core.checkStat core.trustctime; do
    [ -z "$(git config --global --get "$k" 2>/dev/null)" ] && unset_keys="$unset_keys $k"
  done
  if [ -n "$unset_keys" ]; then
    say "git: only if your repos live on /mnt/<drive> and Git for Windows writes them, run inside WSL:"
    say "  git config --global core.autocrlf true && git config --global core.checkStat minimal && git config --global core.trustctime false"
    say "  (repos in the Linux filesystem must NOT get core.autocrlf=true — it would check them out with CRLF)"
  fi
else
  if [ -z "$(git config --global --get core.autocrlf 2>/dev/null)" ]; then
    git config --global core.autocrlf true && say "git: core.autocrlf=true (matches Git for Windows on /mnt/c checkouts)"
  fi
  # The index Git for Windows writes carries stat fields Linux sees differently (inode, ctime, …),
  # so without these every `git status` from WSL re-reads every tracked file over 9P.
  if [ -z "$(git config --global --get core.checkStat 2>/dev/null)" ]; then
    git config --global core.checkStat minimal && git config --global core.trustctime false &&
      say "git: core.checkStat=minimal, core.trustctime=false (share the Windows index without re-reading every file)"
  fi
fi
# Commits made from the phone run git here: same author as on Windows (asked through interop).
# Whether git.exe RUNS is asked once: with WSL interop off it is still on PATH and dies with
# "Exec format error", which used to read as "Git for Windows has no identity".
gitwin_note=""
git.exe --version >/dev/null 2>&1 || gitwin_note=" (Git for Windows unreachable from WSL — interop off?)"
for k in user.name user.email; do
  if [ -z "$(git config --global --get "$k" 2>/dev/null)" ]; then
    v=""
    [ -z "$gitwin_note" ] && v="$(git.exe config --global --get "$k" 2>/dev/null | tr -d '\r')"
    if [ -n "$v" ]; then git config --global "$k" "$v" && say "git: $k from Git for Windows ($v)"
    else say "git: no $k$gitwin_note — set it: git config --global $k \"…\""; fi
  fi
done

say "sudo inside WSL asks for your LINUX password, set the first time Ubuntu opened — not your Windows one."
say "  forgot it? in PowerShell: wsl -u root passwd $(id -un)"

exit "$fail"
