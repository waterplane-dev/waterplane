#!/bin/bash
# Verify one revision in a CLEAN worktree: build:shared, build, lint, test:unit,
# then optional e2e filters. The shared working tree carries other sessions'
# untracked files, which break tsc and tests that have nothing to do with the
# commit under review — so a gate run there proves nothing about the commit.
#
#   scripts/verify-rev.sh <rev> [e2e filter...]
#   scripts/verify-rev.sh "$(git write-tree | xargs git commit-tree -p HEAD -m wip)"   # the staged tree
#
# Logs land in $TMPDIR/verify-rev-<pid>/. Why: docs/notes/refactoring.md.
set -u
REV=${1:?usage: verify-rev.sh <rev> [e2e filter...]}; shift
MAIN=$(git rev-parse --show-toplevel)
LOG=${TMPDIR:-/tmp}/verify-rev-$$
WT=$LOG/wt
mkdir -p "$LOG"
cd "$MAIN" || exit 1
git worktree add --detach "$WT" "$REV" >/dev/null 2>&1 || { echo "worktree add failed for $REV"; exit 1; }
trap 'cd "$MAIN" && git worktree remove --force "$WT" 2>/dev/null' EXIT

# Borrow the installed deps instead of a fresh npm install (minutes, and offline-hostile).
mkdir -p "$WT/node_modules/@waterplane"
for e in "$MAIN"/node_modules/* "$MAIN"/node_modules/.bin; do
  n=$(basename "$e"); [ "$n" = "@waterplane" ] && continue
  ln -s "$e" "$WT/node_modules/$n"
done
for p in host shared web; do ln -s "../../packages/$p" "$WT/node_modules/@waterplane/$p"; done
[ -d "$MAIN/packages/host/node_modules" ] && ln -s "$MAIN/packages/host/node_modules" "$WT/packages/host/node_modules"
# Gitignored inputs some unit tests read when present (repo-health series + narrative).
# The state dir is named by the built brand table (current, then past: the REV under test may predate a rename).
brandlist() { node --input-type=module -e "import { BRAND, LEGACY } from '$MAIN/packages/shared/dist/brand.js'; console.log([BRAND.$1, ...LEGACY.map((l) => l.$1)].join(' '))" 2>/dev/null; }
STATE_DIRS=$(brandlist stateDirName); ENV_PREFIXES=$(brandlist envPrefix)
mkdir -p "$WT/.claude/outbox"
for d in $STATE_DIRS; do
  mkdir -p "$WT/$d"
  cp "$MAIN"/$d/repohealth*.jsonl "$WT/$d/" 2>/dev/null
done
cp "$MAIN/.claude/outbox/repohealth.md" "$WT/.claude/outbox/" 2>/dev/null

cd "$WT" || exit 1
ok=1
npm run build:shared >"$LOG/shared.log" 2>&1 || { echo "build:shared FAIL"; ok=0; }
npm run build >"$LOG/build.log" 2>&1 || { echo "build FAIL"; tail -30 "$LOG/build.log"; ok=0; }
npm run lint >"$LOG/lint.log" 2>&1 || { echo "lint FAIL"; grep -E "error" "$LOG/lint.log" | head -20; ok=0; }
grep -E "✖ [0-9]+ problems" "$LOG/lint.log"
npm run test:unit >"$LOG/unit.log" 2>&1 || { echo "test:unit FAIL"; grep -E "^not ok|✖ " "$LOG/unit.log" | head -20; ok=0; }
grep -E "^ℹ (pass|fail)" "$LOG/unit.log"
if [ $ok = 1 ] && [ $# -gt 0 ]; then
  for p in $ENV_PREFIXES; do export "${p}PREFLIGHT=0"; done  # tmux: run-e2e.mjs gives each script its own socket dir
  node scripts/run-e2e.mjs "$@" >"$LOG/e2e.log" 2>&1 || { echo "e2e FAIL"; ok=0; }
  tail -25 "$LOG/e2e.log"
fi
echo "GATE ok=$ok (logs: $LOG)"
[ $ok = 1 ]
