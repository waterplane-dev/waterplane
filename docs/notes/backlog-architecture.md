# Backlog sheet: target shape of the split

`packages/web/src/Backlog.tsx` (2674 lines: a ~370-line `Props` interface, the label/icon tables,
and ONE `Backlog()` component of ~2120 lines holding ~25 `useState`s, three memos, two effects and
eight raw `localStorage` calls) and `packages/web/src/backlogFilter.ts` (1649 lines of pure rules)
are cut into folders beside them. **Behaviour-neutral**: same DOM, same hook/effect order, same
callbacks fired from the same taps, same storage keys and values. The rules each region holds are
the `web-work` skill's (a count is a filter, nothing applies itself, no draft clobber); this note is
only about where the code lives.

Why not `features/backlog/`: that folder is the FEATURE that wraps the sheet (stores, actions, the
`BacklogSheet` binding). A feature folder is flat and its file names are prescribed
(`tools/webshape.test.mjs`), and other flat modules (`ActivitySheet.tsx`, `AssessSheet.tsx`,
`clockDirectory.tsx`, `core/**`) import `Backlog.tsx`'s tables and `backlogFilter.ts`'s rules — which
`local/feature-boundary` forbids from a feature. So both stay top-level modules, each with a folder of
its own, the way `kit/` and `demo/` are top-level folders.

## Layers and what may import what

```
features/backlog/BacklogSheet.tsx   binds stores + core() to the sheet's props (unchanged role)
        │
Backlog.tsx                         FACADE: the thin composer — calls the hooks in order, builds
        │                           the model, lays the regions out. Exports `Backlog` only
        │                           (ActivitySheet/AssessSheet take the tables from backlogLabels).
backlog/*.tsx                       presentational regions: NO hooks of their own, read the model
backlog/use*.ts                     the state clusters (useState/useEffect/useMemo live ONLY here)
backlog/backlog{Labels,Types}.ts   data tables and types, no React
        │
backlogFilter.ts                    BARREL — `export *` from backlogFilter/*.ts, nothing else
backlogFilter/*.ts                  pure rules, `.ts` specifiers (node --test loads them directly)
```

- `backlogFilter/` imports only `@waterplane/shared`, `../sendIntent.ts` and its siblings — never
  React, never `backlog/`. No cycles (`rowBuckets` ← `rowFilter` ← `cutCounts`; the rest import no sibling).
- `backlog/` imports top-level modules (`../backlogFilter`, `../Confirm`, `../RetimeBar`, …) like any
  flat module; never a feature (`local/feature-boundary`).
- Region components take the model (`BacklogModel`, `backlog/backlogTypes.ts`) and draw. **A hook in a
  region component is forbidden** — a child's effects run before its parent's, so moving a hook down
  reorders effects; that is behaviour (refactoring note, "Effect/hook ORDER").
- Raw `localStorage` goes through `storage.ts` (`lsGet`/`lsSet`/`lsDel` + the `LS` registry) with
  the same keys and the same raw values (`"1"` for the archived flag, a path for the repo, the draft
  string) — `lsBool` would also accept `"true"` and is therefore NOT used.

## Layout

| file | holds |
| --- | --- |
| `Backlog.tsx` | the composer: hook calls in the original order, `BacklogModel`, region layout |
| `backlog/backlogTypes.ts` | `BacklogProps` (grouped: facts flat; `verbs` per row, `cutVerbs` over a repo or a cut, `nav` to elsewhere) and `BacklogModel` |
| `backlog/backlogLabels.ts` | `CHECK_LABEL/ICON`, `VALIDATE_LABEL/ICON`, `CATEGORY_ICON`, `ENGINE_LABEL`, `CLOSED_GROUP`, `dropOffered` |
| `backlog/useBacklogDraft.ts` | the stranded add-field draft: read once, rescued, cleared only by a tap |
| `backlog/useBacklogFilters.ts` | search text, repo scope, archived toggle, the status/age/kind/clock/ids cut, the cut-from-outside effect |
| `backlog/useBacklogUi.ts` | the folds and per-row disclosure sets, the re-time pick list |
| `backlog/useBacklogEdit.ts` | the inline editor's fields, `beginEdit`/`saveEdit` |
| `backlog/useBacklogCuts.ts` | every derived list and number: base, counts, cut, visible, groups, `nextFireIds`, focus breakdown, bulk ids, the predicates over live sessions |
| `backlog/useBacklogDrag.ts` | the drag id, `canDrag`, the window pointer effect |
| `backlog/RepoBar.tsx` | sheet head (send…, auto) and the repo bar (picker, assess, smart pick) |
| `backlog/Notices.tsx` | auto-off banner, kept-from-before draft, the wait-verb and offline lines |
| `backlog/SmartPickNotes.tsx` | the smart pick's explainer, *on in N repos*, the last-look strip |
| `backlog/BacklogFilterBar.tsx` | search row, the chip rows, the filter bar |
| `backlog/BulkBars.tsx` | re-time pick, the focus sentence, drop clocks / run again / archive done / name |
| `backlog/BacklogList.tsx` | the list, empty state and group heads |
| `backlog/BacklogBody.tsx` | the scroll body's two orders: an ids cut leads with its rows (cut bar → rows → the rest) |
| `backlog/BacklogRow.tsx` | one row's frame: clock head, number, title, text, thumbs, order buttons |
| `backlog/RowEditor.tsx` | the inline edit form |
| `backlog/RowChips.tsx` | the meta line of chips |
| `backlog/RowNotes.tsx` | the sentences under the chips, waiting line, slots, close choice, check/validate details |
| `backlog/RowActions.tsx` | the verb row |
| `backlogFilter.ts` | barrel |
| `backlogFilter/{rowBuckets,rowFilter,cutCounts,clockGroups,dropClock,runAgain,mergeWords,scheduleWords,titleWords,rowWords,retimeMany}.ts` | the rules by subject (the barrel's header says which is which) |

There is no `sort` file: the order is the host's, and nothing on the phone re-sorts.

## Caps and pins

- `tools/webshape.test.mjs`: `BACKLOG_FACADES` ratchets `Backlog.tsx` and `backlogFilter.ts` (lower
  in every commit that moves code out); `BACKLOG_SPLIT_FILES` lists every file in the two folders
  exactly once with its own cap, none over 900, aim ≤ 500.
- `tools/backlogpins.test.mjs` (file-agnostic over `Backlog.tsx` + `backlog/**`): the barrel's 92
  runtime exports and 8 types (P1), one `ageBucket`/`categoryBucket` feeding both count and cut
  (P2), the call-site count of every callback (P3), every `track("action:backlog.*")` id and
  `data-hint` (P4), the three storage keys and the two effects + one clock (P5).
- `backlogFilter.test.mjs` passes UNTOUCHED — it imports the barrel.

## Inventory and cut order

`backlogFilter.ts` (line ranges of the original): 30–41 offline refusals → `rowFilter`; 42–126 → `rowBuckets`;
127–184 the filter → `rowFilter`; 185–224 `backlogCounts` → `cutCounts`; 225–255 the bar sentence →
`rowFilter`; 256–397 focus breakdown + count words → `cutCounts`; 398–491 merge words → `mergeWords`; 492–509
`hiddenByArchive` → `rowFilter`; 510–559 → `scheduleWords`; 560–725 clocks → `clockGroups`; 726–866 hold, budget
waiver, drop the clock → `dropClock`; 867–1209 run it again + requeued → `runAgain`; 1210–1308 archive
done + assess scope → `cutCounts`; 1309–1470 → `titleWords`; 1471–1491 the directory's labels → `clockGroups`;
1492–1580 span/label/edit options → `rowWords`; 1581–1649 → `retimeMany`.

`Backlog.tsx`: 1–41 imports; 42–412 `Props` → `backlogTypes.ts` (grouped); 414–552 tables + `dropOffered`
+ keys → `backlogLabels.ts`; 554–676 state → hooks; 678–1121 derivations → `useBacklogCuts` (+
`selectRepo`, `toggleArchived` → filters, `beginEdit`/`saveEdit` → edit); 1123–1164 drag →
`useBacklogDrag`; 1166–1258 head + repo bar → `RepoBar`; 1259–1442 notices + smart pick →
`Notices`/`SmartPickNotes`; 1444–1551 search + chips + bar → `BacklogFilterBar`; 1552–1738 bulk →
`BulkBars`; 1740–1786 list + groups → `BacklogList`; 1787–2667 the row → `BacklogRow` with
`RowEditor`, `RowChips`, `RowNotes`, `RowActions`.

Order: (1) this note + pins + ratchets; (2) `backlogFilter.ts` → barrel; (3) tables + storage
helpers; (4) hooks; (5) grouped props + region components. One commit each.

## Hazards

- **Hook order**: the composer calls the hooks so the two effects keep their order (cut-from-outside,
  then `useNow`'s, then the drag binding). State order may move (no effects), effects may not.
- **The drag effect's stale closure** is on purpose (`[dragId, visible]`, eslint-disabled): moved
  verbatim with the same deps.
- **`clockCuts` memo on `[base]`** never hits (a new array per render) — moved as is; noted, not fixed.
- **Row identity**: rows keep `key={it.id}` at the same level; the editor/row switch still swaps a
  `div` for a `Fragment`, so state below remounts exactly as before.
- **The `bulkverbs` pin** reads `onFire={(id) => …` in `BacklogSheet`; grouping the props makes it
  `onFire: (id) => …`, and the regex takes both spellings in the same commit.
