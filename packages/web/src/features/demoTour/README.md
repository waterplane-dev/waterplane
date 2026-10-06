# demoTour — the demo's first minute, and "More to try"

The demo (`demo/`, `docs/requirements/demo.md`) drops a person into a real-looking app over a
pretend desktop. This feature is its guide, in two parts:

- **The hook** (docs/analysis/demo-pitch-plan.md §1, R-demo-014): the default scenario
  (`first-look`) opens STRAIGHT INTO its todo-garden session while a turn is running — tool lines
  stream and the context meter moves with no tap (the scenario's `script`). One non-modal hint,
  *Read it like a chat*, points at the session's REAL reader toggle; once the reader has been
  opened it is gone. When the annotate-and-send-back loop has run (the scenario's "bigger" reply),
  a closing card, *While you're away*, offers three doors — the schedule sheet, the token ledger,
  repo health — and *More to try*.
- **More to try**: one sheet listing the headline features, grouped (*Drive it*, *Leave it
  running*, *See what it did*, *Know what it costs*), each row an icon, a headline and ONE
  sentence saying what it does for the person, and a tap that opens that screen of the demo.
  Reached from the demo line and the closing card; it never opens by itself.

Only in the demo (`isDemo()`); it sends nothing anywhere (R-demo-004).

**Owns**

- `logic.ts` — the row list (`TOUR`), where each row goes (`TourTarget`: the demo session, its
  reader, or a sheet — `inSession` sheets attach the session first), the per-device `TourState`
  (`seen` rows; the hook's `opened`/`read`/`closed`) and its pure rules: `parseTourState`,
  `markSeen`, `markHook`, `tourProgress`/`progressText`, `tourSession`, and the hook's
  `shouldOpenHook`, `hintShown`, `loopDone`, `cardShown`. Pinned by `logic.test.mjs`, which also
  checks every row's overlay is in `routing.ts`'s `Overlay`; `HOOK_REPLY_MATCH` is held to the
  scenario by `demo/scenarios/scenarios.test.mjs`.
- `store.ts` — `tourStore`, read from `LS.demoTour` at `boot`. One writer, `actions.ts`'s
  `saveTour` (store and storage together).
- `DemoTourSheet.tsx` — overlay `demotour` (not persisted), titled *More to try*. A row reached by
  tap shows a check AND the word "tried"; the intro counts them ("3 of 14 tried").
- `DemoHook.tsx` — `DemoHookHint` (floating in `.term-wrap`, measured under the
  `[data-hint="term.read"]` toggle, which pulses while it stands) and `DemoHookCard` (a strip
  under the session, like the new-images one). Both are mounted by `core/session/TermArea.tsx`,
  which hands the card `openRepoHealth` (features never import each other).
- `actions.ts` — `runTourRow` (navigate + mark seen; the *answer by tap* row appends the scripted
  prompt to the session's draft via `compose.seedDraft`, first tap only), `bootDemoTour` (the
  `DEMO_TOUR_EVENT` listener for `DemoLine`'s *More to try* button), `openHookSession` (the
  manifest's `session.list` handler: attach the hook session once per visit, a render later),
  `hookReadUsed`, `closeHookCard`, `hookDoor`.
- Track ids: `overlay:demotour`, `action:demotour.<row id>`, `action:demohook.<open|read|schedule|tokens|health|more>`.

**Reads from core**: `nav.open/close/attach/openReader`, `compose.seedDraft`, `world.sessions`,
`world.active`, `world.activeRepo`, `nav.overlay`, `say.toast/track`.

**Rules that apply here**

- The hook opens its session ONCE per visit and never over a screen a reload restored. It plays
  under browser automation too (`navigator.webdriver`): the journeys walk this first minute, and
  they wait on the scenario's TEXT, never on its script's timings.
- The hint owns no view switch: the person taps the real toggle. It never covers the toggle, and
  it is a `note`, not a dialog — nothing waits for it.
- The tour sheet never opens by itself (it used to, and sat on top of the hook).
- `LS.demoTour` is cleared when the demo is entered or left (`demo/mode.ts` `enterDemo`/`exitDemo`,
  `demoEntry.ts` `tryDemo`/`leaveDemo` for the shell's path), so each visit starts fresh.
- Typed words are never overwritten: the seed APPENDS, once.
- A row whose session is not on the list yet says so in a toast; it never silently does nothing.
- A row is added only for a screen the first-look scenario fills — an empty sheet sells nothing.
