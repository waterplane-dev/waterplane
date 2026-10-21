---
name: refactoring
description: How big files are split in this repo without changing behaviour — target architecture doc first, ratchet and pinning tests before any move, parallel new-file builders with serial one-package-per-commit integration, each commit verified in a clean worktree (scripts/verify-rev.sh), review afterwards. Load BEFORE splitting or modularising a large file (TokenStatsSheet.tsx, Backlog.tsx, a host slice past its cap, …) or planning such a split.
---

# Refactoring a big file

The why and the incidents behind every step: [refactoring.md](../../../docs/notes/refactoring.md). The two
finished splits are the worked examples: the web client's
[web-architecture.md](../../../docs/notes/web-architecture.md) and the host's
[host-architecture.md](../../../docs/notes/host-architecture.md) (its "Result" is the map; the "as landed"
sections are what each package decided).

## Order of work

1. **Target document first.** No package-level split without `docs/notes/<package>-architecture.md`
   saying: the layers, what may import what, folder/file layout, the one API pieces reach shared
   state through, and the cap each file is held to. Web and host each have one; a new package
   writes its own (and has it reviewed) before the first cut. Add it to `docs/notes/README.md`'s table.
2. **Plan as an inventory.** Regions of the file with current line ranges → what each becomes →
   cut order. Line numbers rot after the first commit: every cut re-derives them with `grep -n`.
3. **Guardrails before moves.**
   - A line ratchet on the file and a per-file cap on the new dirs (models: `tools/webshape.test.mjs`,
     `tools/hostshape.test.mjs`). Lower the ratchet in every commit that moves code out.
   - Pin every site a copy-then-delete move could DUPLICATE: ack-id mints (`core/queue/queue.test.mjs`), draft
     clears, session creates (`packages/web/src/createOp.test.mjs`), deliveries — and, where ORDER is behaviour (listener
     registration, a shutdown flush), the order (model: `tools/hostpins.test.mjs`). Moving a pinned
     site edits the map in the same commit.
   - Boundaries as lint rules (`tools/eslint/`), not prose.
4. **Build in parallel, integrate serially.** Builders write NEW files only, in parallel. The same
   builder then integrates its package into the big file — one agent holds the file at a time, one
   commit per package, never another package's hunk.
5. **Verify every commit in a clean worktree**: `scripts/verify-rev.sh <rev> [e2e filters]`. The
   shared tree's other-session files make an in-tree gate meaningless.
6. **Review after** (a fresh agent, adversarial), fix findings right away. Bugs that predate the
   split get their own commits, named as pre-existing.
7. **Prove nothing changed**: lint, `test:unit`, `test:host`, full `node scripts/run-e2e.mjs`, and a
   headless 412×915 run against the build comparing with the pre-split commit. Host/shared changes:
   `npm run restart`, then `/api/health` → `ptys.masters` should equal `sessions`.

## Rules that bit

- **A file at the cap is cut by subject; its notes are never trimmed to make room.** The comments are
  where this repo records why a rule exists — deleting them to get back under `max-lines` loses the
  reason and still owes the split. `capSqueeze` (`tools/healthreadings.mjs`) counts the commits that did.
- **Behaviour-neutral.** A refactor commit changes structure only. An intended change is named in
  the commit and in the report — never discovered by the user.
- **Effect/hook ORDER and what a callback reads (ref vs render value) are behaviour.** A moved mount
  effect spent a send retry on every reload; a once-subscribed handler read the first render forever.
- **Import prunes can alias the wrong symbol** (`Type as ChevronLeft` type-checks and draws a "T").
  Render-check after pruning; don't trust tsc for it.
- **A failing test is run on the base commit before it is blamed** on the split.
- **Concurrent e2e runs collide** (ports, tmux, `shared/dist`): re-run alone before believing.
- **Shared working tree** (CLAUDE.md has the rules): a shared file carrying someone else's edit →
  commit your hunk via `git hash-object -w` + `git update-index --cacheinfo`.
- CLAUDE.md's never-fork list holds during a split: MOVE those files whole or not at all.
