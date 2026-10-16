# Assessment: target shape of the split

`packages/web/src/assessRows.ts` (1758 lines, pure: every rule that decides whether a tap on the
assessment is safe) and `AssessSheet.tsx` (1589 lines: one `AssessSheet()` of ~900 lines holding the
ticks, the answers, the clock and the whole JSX) are cut into `packages/web/src/assess/`.
**Behaviour-neutral**: same DOM, same hook and effect order, same tracked taps, same words. The rules
this code holds are the `web-work` skill's (nothing applies itself, words in full, a verb that does
nothing is not drawn); this note is only about where the code lives. Same method as
[transcript-architecture.md](transcript-architecture.md).

Both originals stay importable (`assessRows.ts` exports every name it did, `AssessSheet.tsx` exports
`AssessSheet` and `AssessSheetProps`). Prefixes `arows` / `asx` because basenames are unique across
packages (`assess.ts` is the host's and shared's).

## Layers

```
assessRows.ts                      BARREL: `export *` over the arows slices (the test imports it, untouched)
assess/arows*.ts                   pure slices, one per subject; imports carry `.ts` (node --test loads source)
AssessSheet.tsx                    COMPOSER: useAssessSheet, then <Sheet> over the regions
assess/useAssessSheet.ts           ALL state, effects and handlers, in the original declaration order
assess/Asx*.tsx                    presentational regions: NO hooks, they read the model `m`
```

**A hook in a region component is forbidden** (`ItemFiles` and `useInView` already were components with
their own hook before the split and stay as they were): a child's effects run before its parent's, so
moving a hook down reorders effects. The model `m` is `{ p, ...state }`.

## Pure slices (`assess/arows*.ts`)

| file | holds |
| --- | --- |
| `arowsDisplay.ts` | `ASSESS_SAMPLE`, `assessRetires`, `AssessDisplayRow` |
| `arowsAccept.ts` | what a tap does or refuses: `assessAcceptBlocker`, `assessAcceptWords`, `assessRowPosition`, `requeueWhereWords` |
| `arowsGroups.ts` | `LEAVE_WORDS`, the strips and merge cards, `assessGroups`, `assessRowHead` |
| `arowsBulk.ts` | the unclear tally, bulk and merge confirmation words |
| `arowsApply.ts` | the guide, ticks counted, `assessApplySummary`/`Label`/`Note` |
| `arowsAfter.ts` | after an apply: the backlog route, the receipt, new-item and pad-note words, the filed split |
| `arowsRun.ts` | `assessApplyBlocker`/`assessRunBlocker` and `assessWatch` |

## The sheet (`assess/`)

| file | holds |
| --- | --- |
| `asxTypes.ts` / `asxConst.ts` | `AssessSheetProps`; `ICON`, the verdict and run pills, the step icons |
| `useAssessSheet.ts` | the one hook: picks, answers, clock, derived values, toggles, bulk, merge confirm, apply. Returns the model `m` |
| `AsxParts.tsx` | `RunLog`, `NameHead`, `ItemFiles` (the last keeps its own `useInView`, as before) |
| `AsxRowCard.tsx` / `AsxMergeCard.tsx` | one assessed row; one merge card |
| `AsxSlotCards.tsx` | a slot check's conflict cards (words, no choice) and split cards (approve/leave) |
| `AsxActions.tsx` / `AsxHead.tsx` / `AsxFooter.tsx` | the verbs; the pinned run status; the apply bar and the route out |
| `AsxTop.tsx` | verdict counts, the guide, detail, the watch panel, empty states, refused notes |
| `AsxStrips.tsx` / `AsxNews.tsx` / `AsxTail.tsx` | the verdict strips; proposed new items and offered pad notes; what the run looked at, then `AsxAsks.tsx` (the pin and naming answers) |

Nothing here changes what applies itself: `onApply` is called from one place (`apply` in the hook), behind
the one Apply tap.

## Pins and proof

- `tools/webshape.test.mjs`: `ASSESS_FACADES` ratchets both facades; `ASSESS_SPLIT_FILES` lists every file once with a cap.
- `tools/assesspins.test.mjs`: both export surfaces off the type checker; side-effect counts as text.
- `packages/web/src/assessRows.test.mjs` passes untouched; every export of the barrel run over fixed
  fixtures gives byte-identical JSON before and after.
- Byte-identical server render of 26 fixtures (plain, ticked, answers, guide open, applied, failed,
  running, quiet, no run, offline, scoped, empty, cached, notes, put-back rows, ...) before and after, with
  `useState` seeded by declaration index and `useEffect` inert, `TZ=UTC`, `Date.now` frozen.
