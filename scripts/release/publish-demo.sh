#!/usr/bin/env bash
# Publish the static web demo (https://waterplane.dev/demo/) from the PUBLIC MIRROR, never from this tree
# (this tree bundles the private extensions). Called by train.sh step 8; runnable on its own:
#
#   bash scripts/release/publish-demo.sh [mirror-dir] [version-label]
#
# Builds `dist-demo/` in the mirror with base /demo/, mirrors it into a fresh clone of waterplane-dev/demo
# (its README.md and .nojekyll are kept), and pushes only when something changed. ~10 s.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
C="${1:-$ROOT/../waterplane-public}"; V="${2:-$(git -C "$C" describe --tags --always)}"
DEMO_REPO=waterplane-dev/demo
[ -f "$C/scripts/build-demo-web.mjs" ] || { echo "STOPPED: $C has no scripts/build-demo-web.mjs"; exit 1; }
[ -d "$C/node_modules" ] || (cd "$C" && npm ci)
(cd "$C" && WATERPLANE_DEMO_BASE=/demo/ node scripts/build-demo-web.mjs >/dev/null) || { echo "STOPPED: demo build failed in $C"; exit 1; }
[ -f "$C/dist-demo/index.html" ] || { echo "STOPPED: no dist-demo/index.html"; exit 1; }
grep -q 'src="/demo/' "$C/dist-demo/index.html" || { echo "STOPPED: dist-demo was not built for base /demo/"; exit 1; }

W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
gh repo clone "$DEMO_REPO" "$W" -- -q --depth 1
rsync -a --delete --exclude .git --exclude README.md --exclude .nojekyll "$C/dist-demo/" "$W/"
# buildstamp.json and build-id.txt move on every build; anything else is a real change.
if [ -z "$(git -C "$W" status --porcelain -- . ':!buildstamp.json' ':!build-id.txt')" ]; then
  echo "no change: waterplane.dev/demo/ already matches $V"
  exit 0
fi
git -C "$W" add -A
git -C "$W" commit -q -m "waterplane static demo $V"
git -C "$W" push -q origin HEAD
echo "pushed: waterplane.dev/demo/ updates in ~1 min ($V)"
