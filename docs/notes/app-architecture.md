# App.tsx: target shape of the split

`packages/web/src/App.tsx` (1053 lines, at its `webshape` ratchet) was ONE `App()` holding the host's
lists as state, the socket's frame switch (~170 lines), the launcher's view cuts, a dozen boot
effects, the toolbar's command switch and the overlay table. It is cut into hooks and modules under
the core directories that already own each subject, so `App()` is left as what
[web-architecture.md](web-architecture.md#what-stays-in-app-on-purpose) says it is: the WIRING — one
call per core hook, `bindCore`, the `authGate` return and the three screens. **Behaviour-neutral**:
same DOM, same hook/effect order, same callbacks, same storage keys. Same method as
[send-architecture.md](send-architecture.md).

## The one rule this split is about: effect ORDER

React runs a component's effects in hook order, and a custom hook's hooks ARE its caller's, inlined
where it is called. So a CONTIGUOUS run of hooks moved verbatim into `useX()`, called at the same
place, runs exactly as before. Moving a hook past another one does not. Every move here is a
contiguous run; plain state (`useState`, `useRef`, `useMemo`) may move, because it has no order of
its own to keep. The ws handler reads this render's hooks through one `useLatest` (the subscription
is made once), and that stays true in `useHostFrames`.

Values a moved hook needs from LATER in `App()` (`setLaunch`, `attach`, …) are passed as arrows
(`(l) => setLaunch(l)`), never as the bare binding: an argument is evaluated at the call, where a
later `const` is still in its temporal dead zone, while the arrow is only called from an effect.

## Layout

| file | holds | called |
| --- | --- | --- |
| `core/sessions/useHostState.ts` | the lists the host pushes (sessions, recent, closed, repos + `reposAt`, intents, backends, update, meter), seeded from the snapshot | where `sessionsRaw` was |
| `core/settings/useSettingsAdoption.ts` | the settings-sync install and the adopt switch | where its effect was |
| `core/launcher/useLauncherView.ts` | hidden repos, focus paths, the visible/hidden cuts, `openingCwds`, `cwdVisible`, the visible backlog | after `useTransportIndex` |
| `core/conn/useHostFrames.ts` | **the socket's frame switch** (`routeHostFrame`) and its one subscription, the features' listener after it | where the ws effect was |
| `core/launcher/useRepoRefresh.ts` | re-list repos on connect and on a turn's end, the manual-fire navigation | after the ws effect |
| `core/settings/useInstallOffer.ts` | the PWA install offer: its state and the `beforeinstallprompt` effect | where that effect was |
| `core/sessions/useTabStripBridge.ts` | publishing the tab strip and its two tap events | where they were |
| `core/route/useOutsideOpens.ts` | the cold notification download, the service worker's and the shell's "open this" | where they were |
| `core/queue/useQueueSignals.ts` | the stuck-sends count for `link.ts`, the reload guard | where they were |
| `core/session/runToolbar.ts` | the toolbar's command switch and `runSlash` (plain functions, no hooks) | — |
| `core/route/overlayViews.tsx` | the overlay TABLE and the `SheetGuard` layer (a plain function, not a component) | after the `authGate` return |

The overlay layer is a FUNCTION returning an element or `null`, not a component: `App` falls through
to the screen underneath when the table misses (a restored overlay with nothing behind it), and only
a value it holds before it returns can say so. A component would add a level to the tree and could
not make the miss fall through.

The 30 s `nowTick` stays in `App` unchanged. Removing it is NOT neutral: the interval re-renders
the whole tree, and the launcher's and the session screen's relative times ("finished 3 m ago",
countdowns) are only current because of it. Left for later: the tick as a store only the screens that
draw a relative time subscribe to.

## Caps and pins

- `tools/webshape.test.mjs`: `MAX_APP_LINES` ratchets down in every commit that moves code out;
  `APP_SPLIT_FILES` caps each new file (none over 500). The "no `case` for a feature's frame" and
  "no `overlayViews` entry for a feature's sheet" checks read the files the switch and the table moved
  to.
- `tools/apppins.test.mjs`: `App.tsx` exports exactly `App` (type checker, P1); the ORDER of every
  effect and subscribing hook with the moved hooks inlined (P2); one subscription for App's frames
  with the features' after it, one `bindCore`, no socket (P3).
- `tokenstatspins` keeps `usage.refresh` in `App.tsx` (the effect stays there).
- Proof of no change: a server-render of `App` seeded from each demo scenario's host frames, for every
  overlay id on the launcher and on two sessions (819 renders), byte-identical before and after.
