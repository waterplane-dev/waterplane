# syntax=docker/dockerfile:1.7
#
# waterplane in a container: the host daemon, tmux, git and Tailscale. What it
# deliberately does NOT contain, and why (deploy/docker/README.md):
#
#   - Claude Code. It is Anthropic's proprietary software; the entrypoint installs
#     it with Anthropic's own installer on first start, into the home volume.
#   - The Android SDK, unless you build with --build-arg ANDROID=1. Its licence has
#     to be accepted by the person who installs it, so it is either fetched by the
#     phone's first-app flow (with a consent screen) or by your own build here.
#
# Build (from the repo root):
#   docker build -f deploy/docker/Dockerfile -t waterplane deploy/docker
# From a release you built yourself (npm run release:build && npm run release:install-sh):
#   docker build -f deploy/docker/Dockerfile --build-context release=dist-release -t waterplane deploy/docker

ARG UBUNTU=24.04

# Replaced by `--build-context release=<dir>`; empty by default, so the published
# installer is used.
FROM scratch AS release

FROM ubuntu:${UBUNTU}

ARG ANDROID=0
ARG INSTALL_URL=https://waterplane.dev/install.sh
# Only for a release you built with --unsigned. Never for a downloaded one.
ARG INSECURE_SKIP_SIG=0

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    DEBIAN_FRONTEND=noninteractive

# tmux is required (sessions live in it); tini reaps what tmux and claude leave
# behind; util-linux brings setpriv, used to drop from root to the `wp` user.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git tmux tini util-linux procps less openssh-client \
      unzip xz-utils iproute2 iptables gnupg \
 && curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
 && curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends tailscale \
 && rm -rf /var/lib/apt/lists/*

# The ubuntu image ships a `ubuntu` user at uid 1000; waterplane runs as `wp` instead.
RUN userdel -r ubuntu 2>/dev/null || true \
 && useradd --create-home --uid 1000 --shell /bin/bash wp \
 && mkdir -p /opt/waterplane /home/wp/dev \
 && chown -R wp:wp /opt/waterplane /home/wp

# waterplane itself, the new-user way (install.sh verifies Node and the release),
# but into /opt instead of ~/.local so an image upgrade is not shadowed by the
# home volume. A throwaway HOME keeps the installer's doctor run out of /home/wp.
RUN --mount=type=bind,from=release,target=/release \
    set -eu; \
    export HOME=/tmp/install-home XDG_DATA_HOME=/opt/waterplane WATERPLANE_INSECURE_SKIP_SIG=${INSECURE_SKIP_SIG}; \
    mkdir -p "$HOME"; chown wp:wp "$HOME"; \
    if [ -f /release/install.sh ]; then \
      cp /release/install.sh /tmp/install.sh; FROM="--from /release"; \
    else \
      curl -fsSL "$INSTALL_URL" -o /tmp/install.sh; FROM=""; \
    fi; \
    setpriv --reuid=wp --regid=wp --init-groups env HOME="$HOME" XDG_DATA_HOME="$XDG_DATA_HOME" \
      WATERPLANE_INSECURE_SKIP_SIG="$WATERPLANE_INSECURE_SKIP_SIG" \
      sh /tmp/install.sh $FROM --no-service --skip-claude-check --bin-dir /opt/waterplane/bin </dev/null \
      || { echo "install.sh failed" >&2; exit 1; }; \
    test -x /opt/waterplane/bin/waterplane; \
    rm -rf "$HOME" /tmp/install.sh

# Optional: a JDK and the Android SDK packages the first-app template builds against
# (packages/host/src/androidenv.ts WANT_PLATFORM / WANT_BUILD_TOOLS). Building with
# ANDROID=1 means YOU accept the Android SDK licence (https://developer.android.com/studio/terms)
# for exactly these packages. Google ships the SDK's native tools (aapt2) for x86_64
# Linux only, so on an ARM host build this with --platform linux/amd64.
ARG CMDLINE_TOOLS=commandlinetools-linux-15859902_latest.zip
ARG CMDLINE_TOOLS_SHA256=4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583
ENV ANDROID_HOME=/opt/android-sdk
RUN set -eu; \
    if [ "$ANDROID" != 1 ]; then exit 0; fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends openjdk-21-jdk-headless; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL "https://dl.google.com/android/repository/$CMDLINE_TOOLS" -o /tmp/clt.zip; \
    echo "$CMDLINE_TOOLS_SHA256  /tmp/clt.zip" | sha256sum -c -; \
    mkdir -p "$ANDROID_HOME/cmdline-tools"; \
    unzip -q /tmp/clt.zip -d /tmp/clt; mv /tmp/clt/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"; \
    rm -rf /tmp/clt /tmp/clt.zip; \
    yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \
      "platform-tools" "platforms;android-36" "build-tools;35.0.0" >/dev/null; \
    chown -R wp:wp "$ANDROID_HOME"

COPY --chmod=755 entrypoint.sh /usr/local/bin/waterplane-entrypoint

ENV PATH=/home/wp/.local/bin:/opt/waterplane/bin:/opt/waterplane/waterplane/runtime/current/bin:/opt/android-sdk/platform-tools:$PATH \
    WATERPLANE_ROOT=/home/wp/dev

# Everything a person makes or signs into lives here: repos (~/dev), the Claude
# login and binary, waterplane's settings and state, the Gradle cache.
VOLUME ["/home/wp", "/var/lib/tailscale"]

EXPOSE 8770
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/waterplane-entrypoint"]
CMD ["start"]
