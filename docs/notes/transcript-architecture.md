# Reader: target shape of the split

`packages/web/src/TranscriptView.tsx` (1272 lines: the status and props types, the pure row helpers,
and ONE `TranscriptView()` of ~870 lines holding ~20 pieces of state, a dozen effects and the whole JSX)
is cut into `packages/web/src/transcript/`. **Behaviour-neutral**: same DOM, same hook and effect
order, same fetches, same storage keys. The rules this code holds are the `web-term` skill's (a
compaction turn is a divider, the spinner waits for the cache, the reader owns no buttons); this note
is only about where the code lives. Same method as [send-architecture.md](send-architecture.md).

`TranscriptView.tsx` stays the importable module (exports `TranscriptView` and the `TranscriptStatus`
type) and is a thin composer. `tv` prefix on the pure files because basenames are unique across
packages (`transcript.ts` is the host's).

## Layers

```
TranscriptView.tsx                COMPOSER: calls useTranscriptView, lays out the regions and the scroll body
transcript/useTranscriptView.ts   ALL state, refs, effects and handlers, in the original declaration order
transcript/Tv*.tsx                presentational regions: NO hooks, they read the model `m`
transcript/tvLive.ts              the status strip's reading (pure)
transcript/readThrough.ts         the read watermark from turn edges (pure)
transcript/spentVerb.ts           a fired verb or outline jump runs once per tap, not per remount (pure)
transcript/tvRows.ts              fold rows, tally, `since`, poll constants
transcript/tvTypes.ts             `TranscriptStatus`, `TranscriptViewProps`, `DetailState`
transcript/tvParts.tsx            `Collapse`, `ToolRow`
```

**A hook in a region component is forbidden**: a child's effects run before its parent's, so moving a
hook down reorders effects. The model `m` is `{...props, ...liveReading, ...state}`.

## Layout

| file | holds |
| --- | --- |
| `transcript/tvTypes.ts` | the types |
| `transcript/tvRows.ts` | poll constants, `since`, `rowsOf`/`rowsFor`, `toolTally` |
| `transcript/tvLive.ts` | `liveReading`: dead > blocked > waiting > working > agents > shells > idle |
| `transcript/useTranscriptView.ts` | the one hook |
| `transcript/tvParts.tsx` | `Collapse`, `ToolRow` (one tool call, lite or full) |
| `transcript/TvFindBar.tsx` `TvStrips.tsx` `TvOutline.tsx` | find/unread bar; live strip, agent rows, cached notice; outline |
| `transcript/TvTurn.tsx` `TvBlocks.tsx` | one turn (head, prompt, notes, foot); its blocks and folded tool runs |
| `transcript/TvTail.tsx` | the open question card, the in-flight card |

## Pins and proof

- `tools/webshape.test.mjs`: `TV_FACADES` ratchets the facade; `TV_SPLIT_FILES` lists every file once with a cap.
- `tools/transcriptpins.test.mjs`: export surface off the type checker; side-effect counts as text.
- Byte-identical server render of 25 fixtures (modes fold/list/full, find, cached, busy/blocked/dead,
  agents, shells, each ask form, fork row, paging, peek) before and after, with `useState` seeded by
  declaration index and `useEffect` inert, `TZ=UTC`, `Date.now` frozen.
