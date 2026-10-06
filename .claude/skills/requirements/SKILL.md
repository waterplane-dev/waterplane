---
name: requirements
description: What this repo is expected to do, as a person asked for it — one file per area under docs/requirements/, stable IDs, status + source. Load before changing behaviour someone relies on, or when asked how something should work.
generated-by: waterplane requirements (packages/shared/src/requirements.ts) — a machine-written preset, not one of this repo's hand-authored skills. Edit it freely; nothing overwrites it.
---

# Requirements

The list of what this project is expected to do, reconstructed from the prompts
that asked for it and the commits that shipped it. Index:
`docs/requirements/README.md` — read it, then only the area file you need.

## Before you change behaviour

Grep the area file for the thing you are about to change. If an item says it
must work another way, **say so before acting** — the person may have forgotten
they asked for it, or may be superseding it on purpose. Either way it is their
call, not yours.

## Item format

```
### R-<area>-<nnn> · <status>
One or two sentences: observable behaviour, from the user's side, as an end state.
- asked: 2026-08-25 (session 1a2b3c4d)
- shipped: 3f9e2a1
- superseded-by: R-<area>-<nnn>
```

- **status** — `requested` (asked, no evidence it shipped), `shipped` (a commit
  or the code shows it), `superseded` (a later item replaced it —
  `superseded-by` says which), `dropped` (the person withdrew it).
- **IDs are stable.** Never renumber, never reuse, never delete an item: change
  its status. A later request that contradicts an item supersedes it.
- Behaviour, not implementation: "Child mode has one canvas and no save", not
  "ChildActivity hides the save button".

## Who updates it

`node /Users/me/dev/usmc/scripts/requirements/update.mjs .` reads the prompts and commits since
`docs/requirements/.state.json` — a cheap model extracts, a stronger one merges
as add/amend/status operations — and leaves an **uncommitted diff** for a
person to review. It preserves every item it was not told to change, byte for
byte, so hand edits are safe. waterplane's setup checklist says when it is behind.
