# Send sheet: target shape of the split

`packages/web/src/SendSheet.tsx` (1285 lines: a `Props` interface and ONE `SendSheet()` of ~1090 lines
holding ~15 pieces of state, five refs, two effects and the whole JSX of *To*, *When* and the rule
editor) and `packages/web/src/sendIntent.ts` (1149 lines of vocabulary and pure rules) are cut into
folders beside them. **Behaviour-neutral**: same DOM, same hook/effect order, same callbacks from the
same taps, same storage keys. The rules this code holds are the `web-send` skill's (every word is the
last copy, nothing sends around the queue, `onSend` is the only way out); this note is only about
where the code lives. Same method as [backlog-architecture.md](backlog-architecture.md).

Both stay top-level modules with a folder each (importers across `core/`, `features/`, `App` keep
their paths): `SendSheet.tsx` is the thin composer, `sendIntent.ts` is a barrel.

## Layers and what may import what

```
SendSheet.tsx           COMPOSER: exports `SendSheet` only. Calls `useSendSheet`, lays the regions out.
        │
send/*.tsx              presentational regions: NO hooks of their own, they read the model `m`
send/useSendSheet.ts    ALL state, refs, effects and handlers — one hook, so effect ORDER is the original's
send/sendSheetTypes.ts  `SendSheetProps`, `SendSheetModel` · send/sendTargets.ts  the pure target/hours helpers
        │
sendIntent.ts           BARREL — `export *` from sendIntent/*.ts (+ the two shared re-exports)
sendIntent/*.ts         pure rules, no React, `.ts` specifiers (node --test loads them directly)
```

- `sendIntent/` imports only `@waterplane/shared` and its siblings, never React, never `send/`.
  Dependencies point one way: every sibling imports `sendTypes` and nothing else.
- `send/` imports top-level modules like any flat module; never a feature (`local/feature-boundary`).
- **A hook in a region component is forbidden**: a child's effects run before its parent's, so moving a
  hook down reorders effects. The one hook is `useSendSheet`; regions get `m` and destructure what they
  draw. The `ref`s (`promptsRef`, `atMemo`, `ruleMemo`, `decideRef`, `focusStep`) stay inside it.
- The one send path is untouched: `go()` → `onSend(...)`; the one prompt textarea stays in
  `PromptComposer.tsx`; draft read once at mount, written per keystroke and cleared once after a post.

## Layout

| file | holds |
| --- | --- |
| `SendSheet.tsx` | the composer |
| `send/sendSheetTypes.ts` | `SendSheetProps`, `SendSheetModel` |
| `send/sendTargets.ts` | `defaultTarget`, `firstSession`, `cwdOf`, `dirsOf`, `chainRowState`, run-window helpers |
| `send/useSendSheet.ts` | the state, refs, effects, derivations and handlers |
| `send/RetimeHint.tsx` | the re-time banner and the past-the-budget verb |
| `send/ComposeSection.tsx` | the form hint, the prompt composer, the file strip |
| `send/ToSection.tsx` | the *To* row and its expansion (+ the budget chip) |
| `send/WhenSection.tsx` | the *When* row, now/idle, anchors, after-another, wait-until-free |
| `send/RuleEditor.tsx` | how often, once/weekly, the preview line and week bar |
| `send/WindowRule.tsx` | the usage-window rule's fields |
| `send/LeadPick.tsx` | *how long before*: lead presets, a typed lead, its kept chip |
| `send/MoreRule.tsx` | lead time, run hours, late runs, name |
| `send/SendActions.tsx` | the footer: attach buttons, cancel, the one primary button |
| `sendIntent.ts` | barrel |
| `sendIntent/send{Types,Clock,Lead,Labels,Chain,Rule,Retime}.ts` | the vocabulary and rules by subject: the four answers + seed; clock chips; a typed lead time; summary rows and refusals; chain candidates; the two rare clauses; re-time and budget holds. `send` prefix because file basenames must be unique across packages (`hostshape`: `clock.ts` is the host's) |

## Caps and pins

- `tools/webshape.test.mjs`: `SEND_FACADES` ratchets `SendSheet.tsx` and `sendIntent.ts` (lower in
  every commit that moves code out); `SEND_SPLIT_FILES` lists every file in the two folders once with
  its cap, none over 900, aim ≤ 500.
- `tools/sendpins.test.mjs`: the barrel's runtime + type surface read off the type checker (P1), the
  side-effect sites counted as text over `SendSheet.tsx` + `send/**` (P2: one `onSend`, one draft
  clear, one decision report), the never-do list (P3), one exported `SendSheet` (P4).
- `sendIntent.test.mjs` passes UNTOUCHED — it imports the barrel.
- Proof of no change: a server-render of `SendSheet` for 16 prop sets (live/none sessions, every
  target kind, repair, re-time with each `when`, a parked rule) and again with every `useState(false)`
  forced open (so *more*, the budget field and the `%` field draw) was byte-identical before and after.

## Hazards

- `atMemo` is read by the decision-report effect and written by `leaveAt`; effect order is
  `decide` effect after the draft effect, both in `useSendSheet`, in that order.
- `openedAt` freezes the chain list per mount; it stays a ref created once in the hook.
- The `More` / `pct` / `budget` toggles are state in the hook, passed down with their setters.
