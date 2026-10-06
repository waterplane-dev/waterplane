# Refactoring a big file here

_The why behind the `refactoring` skill. Index: [README.md](README.md)._

Written after `packages/web/src/App.tsx` went from 17,014 lines to 1,091 across two phases and ~45
commits (2026-09-24/25), while other sessions kept committing into the same working tree. The web
result is described in [web-architecture.md](web-architecture.md); this note is about the METHOD,
so the next big file does not have to rediscover it. (As of 2026-10-04 no source file is over 900 lines:
~38 were split into folders behind barrels, and `max-lines: 900` is a lint error, so a file that grows past it is the next one.)

## Target first, then moves

The split only stayed coherent because the destination was written down before a line moved:
`web-architecture.md` names the layers, what may import what, the folder layout and the one API
features reach the core through. Two sessions splitting one file without that document produce two
architectures, and the second merge is a rewrite. So a package without such a document starts with a
planning pass that writes one (`docs/notes/<package>-architecture.md`), reviewed before any cut.

The plan is an inventory by REGION with current line ranges, what each region becomes, and the
order of the cuts. Line numbers rot with the first commit, so every cut re-derives them with
`grep -n` against the file as it is then — never from the plan.

## Guardrails before the move, not after

- **A ratchet on the file** (`tools/webshape.test.mjs` `MAX_APP_LINES`): each commit that moves code
  out lowers it, so the file cannot quietly grow back while the split is half done — or after.
- **Pins on the behaviour a move can silently fork.** `queue.test.mjs` counts every ack-id mint per
  file, `compose.test` every draft clear, `createOp.test` every session-create site. A move that
  relocates a pinned site edits the map in the same commit — which is exactly what makes a
  DUPLICATED site (the real danger of a copy-then-delete move) fail loudly.
- **Boundaries as lint** (`local/feature-boundary`): a rule written in prose was violated within a
  day; a lint rule never was.

## Parallel builders, serial integration

One big file cannot be edited by several agents at once, but most of a split is NEW files. So:
builders write the new modules in parallel (new-file-only — they can always run beside anything),
then the SAME builder integrates its own package into the big file, one agent holding the file at a
time, one commit per package. An integrator never touches another package's hunk.

## Verify each commit in a clean worktree

The shared tree carries other sessions' untracked and modified files; a gate run there fails (or
passes) for reasons unrelated to the commit. `scripts/verify-rev.sh <rev> [e2e…]` builds the exact
revision in a throwaway worktree with the installed deps linked in. When a shared file also holds
someone else's uncommitted edit, commit only your hunk: write your version of the blob with
`git hash-object -w` and stage it with `git update-index --cacheinfo`, leaving theirs in the tree.
Never `git stash`/`reset`/`checkout` here — those destroy the other sessions' work.

## What went wrong, so it does not twice

- **An import prune swapped an icon.** A cleanup rewrote `ChevronLeft` as `Type as ChevronLeft`; it
  type-checks, and every back button drew a "T". tsc cannot catch an alias of one component for
  another — a headless render check at phone size can, and caught it.
- **Hook and effect ORDER is behaviour.** Moving the queue into its own hook ran its mount effect
  before two status effects instead of after, so every reload mid-send spent one of the send's
  retries (`9da658b`). And the socket handler, subscribed once, kept reading the FIRST render's hook
  values. When code moves out of a component, effect order and what each callback reads (a ref or a
  render value) are part of the contract.
- **Pre-existing failures must be classified, not believed.** Run the failing test on the base
  commit before the split; `echo-stream` failed identically there and was a stale test stub, not
  the refactor.
- **Concurrent e2e runs collide** on ports, tmux and `shared/dist`. A failure in a script you did not
  touch is re-run alone before it is believed.
- **A review finds old bugs.** The post-split review surfaced five bugs that predated the refactor;
  they were fixed in their own commits and named as pre-existing, so the refactor commits stay
  behaviour-neutral and bisectable.
- **Accepted behaviour changes are listed**, never discovered: a refactor that changes something on
  purpose says so in the commit and in the final report.

## Proving nothing changed

Unit + lint + the full e2e suite at the end, plus a headless run at 412×915 against the live build
that compares what a user sees (settings order, every sheet opens and closes, Back) with the
pre-split commit. Host changes reach the running daemon only through `npm run restart`, and after
host work `/api/health` should show `ptys.masters` equal to `sessions` — the PTY leak found during
this work was invisible until that number existed.

## The host split

The same method, applied to the daemon (2026-09-25): `sessions.ts` 5,598 → 711, `intents/manager.ts`
3,456 → 314 and `main.ts` 2,426 → 700 lines, in 26 commits, into `sessions/`, `intents/` and
`server/` ([host-architecture.md](host-architecture.md), whose "Result" is the map). Builders wrote
new files in parallel and integrators took one package per commit, serially per file; the intents
and main builders ran while the sessions packages were still being integrated, so the three files
were cut as a pipeline rather than one after another. What bit:

- **Parallel builders shared scratch filenames.** Phase-A builders wrote drafts and logs under the
  same names in one scratch directory, so what one read could be another's. Every builder gets
  its own scratch directory.
- **Untracked slice files break in-tree tests.** A builder's not-yet-integrated `sessions/x.ts`
  sits in the shared tree, is picked up by tsc and the shape tests, and fails a gate that has
  nothing to do with the commit being made. Only the clean-worktree gate (`verify-rev.sh`) is
  meaningful while builders are running.
- **Hub members were discovered late.** The hub sketched in the plan was short: S1's script found
  six members beyond it (`closedRow`, `dropClosed`, …) and S2 two more (`backendField`,
  `lastTurnOf`), each only when the method that needed it moved. Deriving the list by script from
  every `this.<member>` is what found them; reading the file would not have.
- **Pin exclusions have to follow the arrows.** A pin that subtracts a forwarder (`settle: (…) =>
  this.settle(`) is right while the arrow reads that; once the arrow retargets to the slice the
  exclusion subtracts a call nobody counts. Each retargeting commit re-reads the exclusion.
- **A pin must see the new spelling.** The `notify` pin counted `notify(` and not `ctx.notify(`,
  so the first `server/` factory made its calls invisible; it now matches both. The same question
  goes to every pin when code moves behind a record: what does a call look like from there?
- **Models to copy for the next split:** `tools/hostshape.test.mjs` (ratchets, slice caps, "a move
  is a move", type-only files, import-time rules) and `tools/hostpins.test.mjs` (per-file counts and
  the order pins), beside the web's `tools/webshape.test.mjs`.
