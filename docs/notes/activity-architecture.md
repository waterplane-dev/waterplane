# Activity sheet: target shape of the split

`packages/web/src/activityRows.ts` (1950 lines of pure row logic: the model, one builder per source,
bucketing, the selector, the chips, the triage and the bulk rules) and
`packages/web/src/ActivitySheet.tsx` (927 lines: a props interface, three icon tables, `Row`, `Group`
and one `ActivitySheet()` holding the filter/selection state) are cut into `packages/web/src/activity/`.
**Behaviour-neutral**: same rows in the same order with the same sentences, same DOM, same hook order.
The rules each part holds are the `web-work` skill's (one row for a work's whole life; it reads
`Intent` directly and infers no lifecycle; a disabled action carries a reason); this note is only
about where the code lives. The shape follows [backlog-architecture.md](backlog-architecture.md).

Both stay top-level modules (`App.tsx`, `clockDirectory.tsx`, `assessRows.ts`, `core/**` import
`activityRows`), each a facade over the folder, so no importer changes.

## activityRows.ts: pure, `.ts` specifiers, no React

```
activityRows.ts            BARREL: explicit `export { … } from "./activity/…"` lists, nothing else
activity/activityTypes.ts  the model (types only)
activity/activityPieces.ts row keys, clip, `act`, recorded-failure sentence
activity/activityQueueRow.ts   activityIntentWords.ts + activityIntentRow.ts   activityPullRow.ts
activity/activitySelect.ts bucketOf, compareActivity, activityRows (the selector)
activity/activityFilters.ts   activityTriage.ts   activityBulk.ts
```

The barrel is an explicit export list, not `export *`, because the slices export their private helpers
to one another (`clip`, `act`, `intentRow`, …) and those must not leak out. Imports run one way:
`types` ← `pieces` ← the row builders ← `select` ← `filters`/`triage` ← `bulk`. No cycles.
Value imports are `.ts` (node strips types and runs the files in `activityRows.test.mjs`); the
outbox and the pull record stay `import type` — `./outbox` patches `localStorage` at load, which is
why this module is pure at all.

## ActivitySheet.tsx: a facade over a model hook and regions

| file | holds |
| --- | --- |
| `ActivitySheet.tsx` | composes the regions in the original order; re-exports `ActivitySheetProps`, `ReviewMarks` |
| `activity/activitySheetTypes.ts` | `ActivitySheetProps`, `ReviewMarks` |
| `activity/activityLabels.ts` | the icon tables, `DELIVERY_TEXT`, `inWords`, `bytes` |
| `activity/useActivityModel.ts` | every `useState`/`useMemo` and the peer-jobs hook, in the original declaration order; returns the model |
| `activity/ActivityHead.tsx` | the chip row and the triage strip |
| `activity/ActivityNotices.tsx` | the shortlist bar, the headline, the offline and chatter lines |
| `activity/ActivityList.tsx` | the groups, or the sentence for an empty list |
| `activity/ActivityBulkBar.tsx` | the footer's two bulk verbs (mounted only while selecting) |
| `activity/ActivityGroupCard.tsx`, `ActivityRowCard.tsx` | one group, one row — each keeps its own disclosure `useState`, moved whole |

Region components take the model and draw; they hold no hooks of their own. `Row` and `Group` are
the one exception because they ALWAYS had per-row state; they moved unchanged.

## Pins and proof

- `tools/activitypins.test.mjs` pins both facades' export surface off the type checker, and holds a
  **golden**: a deterministic matrix (every queue status × failure state × mode, every intent state ×
  block reason over four payloads, sweeps, pulls, dismissed/done sets, online and offline) is run
  through every exported pure function, and a digest of each observation is compared with
  `tools/activitypins.golden.json`. It was recorded BEFORE the move and passed unchanged after. A
  deliberate behaviour change regenerates it with `WATERPLANE_REGOLDEN=1` and says so in its commit.
- `tools/webshape.test.mjs` ratchets both facades and lists every file in `activity/` with its cap.
- The sheet was server-rendered (`renderToStaticMarkup`, five prop variants over ~190 rows) from the
  pre-split and post-split trees: 950,596 bytes each, identical. Selection mode (the bulk bar) is
  client state and is not in that render; it moved verbatim and is type-checked.
