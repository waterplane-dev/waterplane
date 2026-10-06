# pull.ts and link.ts: target shape of the split

`packages/web/src/pull.ts` (1666 lines: the download manager, one class) and
`packages/web/src/link.ts` (1471: the link store, one module with shared mutable state) are cut into
`packages/web/src/pull/` and `packages/web/src/link/`. **Behaviour-neutral**: same timers armed in the
same order, same writes, same sentences. Both stay top-level modules and become barrels, so no importer
changes. The rules are the `web-files` skill's (pull) and `web-chrome`'s (link); this note is only about
where the code lives. Basenames carry a `pull` / `link` prefix because they are unique across packages.

Neither file touches the socket or the send queue. `link.ts` is the telemetry store `ws.ts` reports into
(`noteLinkStatus` stays the only writer of online-ness); the split adds no second socket and no send path.

## link.ts: one store, slices by section

The module-level `let`s are state a section OWNS. Another slice reads one through the ES live binding
(`export let status`), never a copy; only the owner assigns it, which the compiler enforces. `doc` is never reassigned, so it is a `const` exported from `linkDoc.ts`.

```
link.ts                BARREL: header comment + `export *` / `export type` from link/…
link/linkTypes.ts      every type: status, the persisted doc, the snapshot and its sections
link/linkDoc.ts        constants, load/migrate, `doc`, the one debounced writer (persist/persistNow)
link/linkStatus.ts     status, connectedSince, noteLinkStatus (the one writer of online-ness)
link/linkStore.ts      snapshot memo, invalidate, emit, listeners, the clock, subscribeLink, useLink
link/linkPulse.ts      the probe window and loop, summarize
link/linkSync.ts       noteHostSeen, noteSynced, syncSnapshot, whenText
link/linkTraffic.ts    byte buckets and rates, fmtTotal, fmtRate
link/linkLog.ts        the delivery window, deviceId, rollup, stuck/outstanding counts
link/linkVerdict.ts    HostLinkStats and the one sentence
link/linkOps.ts        netBegin, labelForUrl
link/linkMeters.ts     the fetch/XHR/resource meters, the pagehide flush, the roll-up report
```

`linkStore` and the slices import each other (a slice invalidates and emits; the snapshot reads every
slice). Every cross-slice use is inside a function body, run after all modules have loaded, and no slice
reads an import at top level, so the cycle is safe; it is the one place a cycle is deliberate.

## pull.ts: one class, methods as `this`-typed functions

`PullManager` keeps its state and its method list in `pull/pullManager.ts`; each method body moved
verbatim (dedented, `this` untouched) into a slice as a function declared `this: PullManager`, and the
class holds `name = pullName` fields. No body was edited; the one change to a member is that `private` became unmarked (a
function in another file cannot see a private member). The `no-anchor-download` lint rule's exemption
follows the one legitimate anchor from `pull.ts` to `pull/pullSave.ts`.

```
pull.ts                BARREL: the public exports
pull/pullTypes.ts      PullState, PullRecord, LocalPull, SaveResult, PullBlob
pull/pullConsts.ts     the constants, the id/url/state helpers, openPullCache
pull/pullManager.ts    the class and the `pulls` singleton, setAutoPull/autoPull, the SW message hook
pull/pullQueue.ts      the list, persist/patch, host sync, add/addLocal, retry/remove/pause/resume
pull/pullSave.ts       save to Downloads (browser and native), verify, objectUrl
pull/pullEngine.ts     start, pump, watchdog, run, scheduleRetry
pull/pullNative.ts     the native engine
pull/pullBgFetch.ts    Background Fetch, the cache import
pull/pullRange.ts      the chunked Range fetch, store, eviction
```

## Pins and proof

`tools/pulllinkpins.test.mjs` pins both barrels' export surface off the type checker, and that every
member of `pulls` that was public stays public. `tools/webshape.test.mjs` ratchets both barrels and
lists every file in `pull/` and `link/` with its cap (none over 500).
