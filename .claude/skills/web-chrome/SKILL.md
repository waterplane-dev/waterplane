---
name: web-chrome
description: waterplane phone client, the app frame around the content (packages/web/src): theme.ts/termTheme.ts and styles.css, App's routing.ts/format.ts/localState.ts/toolbar.ts slices, resumeRoute.ts, UpdateBanner.tsx + updateSnooze.ts, Markdown.tsx with fileRefs.ts/media.ts/thumbSrc.ts, link.ts + NetPulseBar.tsx, SessionTabsBar.tsx + sessionTabs.ts, repoColors.ts, ArchiveSheet.tsx, chromeMode.ts + uiScaleSteps.ts, headerCmds.ts and the launcher. Load BEFORE touching theming or repo colours, Back and the route stack, the two-row header, the burger menu, typing room and full screen, or bundle chunking.
---

# waterplane web — the app frame

The chrome around whatever is on screen: theme, routing and Back, the link store, the header and its session tabs, the update banner, typing room and the launcher. Router: `web`. Reasoning: [web.md](docs/notes/web.md).

- `theme.ts` + `termTheme.ts` + the palette at the top of `styles.css` — light or dark as a setting
  (`system`/`light`/`dark`, synced, written to `<html data-theme>`). Three things are NOT CSS and are
  pushed: the `theme-color` meta, xterm's palette (light MUST state all sixteen), and the Android
  window's system bars. **`index.html` sets the attribute inline, before the bundle parses** — any
  import arrives too late to stop the cold-start flash. Light is not dark inverted: hues re-picked,
  DEPTH ORDER inverted, white-at-low-alpha overlays become black-at-low-alpha. **There is no literal
  colour anywhere else in `styles.css`**, and `theme.test.mjs` parses the file to keep it that way
  (token parity, 4.5:1 text, 3:1 charts, CVD separability, all 360 repo hues).
- `routing.ts`'s `Overlay` also accepts `feature:<manifest id>/<sheet>` (an in-repo extension's sheet, `featureSheetId`) — never in `PERSISTED_OVERLAYS`.
- `toolbar.ts` / `routing.ts` / `format.ts` / `localState.ts` — slices lifted out of `App.tsx`.
  **Back is a history STACK, not a URL diff**: each screen pushes one entry keyed on `history.state`,
  landing on a screen already in the stack UNWINDS to it, and a document that BOOTS deep seeds its own
  ancestors. **A pop is ONE pure decision** (`routeFromPop`, node-tested) that **reads the overlay off the KEY, not the hash** (`overlayFromKey`) — the hash
  drops a transient overlay on purpose, so unwinding INTO one landed on the screen underneath (the
  annotator's return from `SendSheet`, prompt stranded in its draft); only a key THIS document
  pushed is trusted. Depth is what `window.shellBack()` (a legacy shell calls its old name) answers and is **PUSHED** to the APK shell (Android 13+
  asks at the START of a predictive-back swipe). **Repo focus is part of the route** (`?repo=`) —
  never `window.open`. `localState.ts` also holds the pending stars (retired when a LIVE row shows the
  host agreeing) and caches the two lists READ with no socket — build commands and schedules — because
  **an empty list is a CLAIM**. Only the READING is cached.
- `backStep.ts` — **Back inside a sheet**, and the one route stack (`routeStack`) both it and
  `useRoute` move. **Closing a sheet is exactly ONE Back** (`routeStep`): the arrow lands where the
  gesture does, so a sheet opened from a sheet closes to that sheet. **A sub-view with its own back
  arrow (an opened file, an editor, a detail pane) calls `useBackStep(open, close)`** or the swipe
  pops the whole sheet — `tools/backstep.test.mjs` enforces it. Never wire it to a close that
  DISCARDS typed words (`PadSheet`'s editor is exempt for that). Features get it from `sdk`.
- `resumeRoute.ts` — **landing back where you were when a NEW BUNDLE replaces the running one.** Every
  ordinary reload keeps the hash; the APK's update does not — Capacitor's `setServerBasePath` ends in
  `loadUrl(appUrl)`, the bare start URL, and so does the cold launch after a merely STAGED build. So
  the route is remembered on every change and put back before React mounts, **only when ARMED** by
  `webUpdate.ts` (stage / apply / revert) and consumed once: an ordinary launch still opens the
  launcher, and a bundle that crashes on the restored screen cannot restore it twice. **Only onto a
  bare URL** — a notification cold-tap naming a file beats where this phone was. What is stored is
  `routeToUrl`'s output, never `location.href`, or a `dlPath` would re-open a download on the next
  restart. Pure decision, node-tested; `seedRouteStack` then gives the restored screen its ancestors.
- `UpdateBanner.tsx` + `updateSnooze.ts` — a staged build, said on the screen you are on. **It never
  applies anything itself.** Two answers to "not now", both keyed to the BUILD: the × is in-memory (a
  reload is when you want telling again), the **snooze is durable and pure/tested** — because not
  every reload is a decision. The clock opens **5m · 1h · 4h · 1d** as chips IN the bar (a preference
  is not `askConfirm`, which is destructive-only) and takes the choice back itself. Neither postpones
  `watchAutoApply()`.
- **New behaviour goes in a feature folder, not in App** (`packages/web/src/features/<name>/`,
  [web-architecture.md](docs/notes/web-architecture.md) has the step-by-step). A folder declares a
  `manifest` (sheets, wire handlers, toolbar commands, boot) listed once in `registry.ts`, and
  reaches App only through `core()` from the SDK's `index.ts` — whose members ARE App's own
  `liveSend`/`queueOp`/`downloadArtifact`, so the one-socket, one-send-path and one-download rules
  hold unchanged. **`local/feature-boundary` refuses** a feature importing another feature, `core/`
  or `App`. Feature state is a `createStore` with ONE writer (its handler or an exported action).
  **`App.tsx` is a ratchet** (`tools/webshape.test.mjs` `MAX_APP_LINES`): moving code out lowers
  it in the same commit; raising it is a decision, never a fix.
- **Bundle chunking** (`vite.config.ts` `manualChunks`) is an UPDATE boundary, not a load-time tweak:
  `webbundle.ts` ships only files whose sha256 moved, and one monolithic chunk re-sent ~1 MB for a
  one-line change. Nothing is lazily loaded.
- `Markdown.tsx` + `fileRefs.ts` / `media.ts` / `thumbSrc.ts` — React nodes only, never `dangerouslySetInnerHTML`; **an anchor only for an absolute
  `http(s)`/`mailto:` href** (in the Capacitor WebView `target="_blank"` is a SAME-FRAME navigation,
  so a relative href replaces the whole app with a blank 404). Plus `fileRefs.ts` (**a written-out transport path is recognised anywhere; a BARE filename only in a code span, only for media, and only when the repo's listing — `transportIndex.ts`, read while the reader is open, never cached to disk — holds exactly one file by that name**) ·
  `media.ts`/`uploadScale.ts` (**`encodeCanvas`, the one way a canvas becomes bytes** — a bare
  `toBlob` can return null, an EMPTY blob, or never call back at all) · `fileMtime.ts` (**an
  un-versioned thumb URL is cacheable by nobody**) · `thumbSrc.ts` · `ZoomableImage.tsx` (clamped pan,
  GPU-derived scale ceiling, `will-change` only during a gesture) · `NetActivity.tsx` (background
  polls must NOT register).
- `link.ts` + `NetPulseBar.tsx` — **the link, as ONE store.** It was six modules with four independent
  derivations of "am I online". **One status, one document, one emit**: `noteLinkStatus()` is the ONLY
  writer; sections are `pulse` (**misses are drawn, never averaged**; it **observes and never
  steers**), `traffic` (measured by **patching the transports, never call sites**), `sync` (**last
  connected is the newest INBOUND FRAME**, never `readyState`) and `log`. Persisted, because **the
  reload IS a data point**. **Every reading is its own tap target and its own hint.**
- `hostRoute.ts` — how the active host is reached right now (LAN or tailnet) plus the one sentence
  why, as a store with ONE writer (`lanLink.ts`, `web-config`). Read by `NetPulseBar.tsx`, the
  health sheet and `features/hosts`' door and switcher sheet — never re-derived at any of those
  sites. Reasoning: [web.md](docs/notes/web.md).
- **`giveups.ts` — DELETED**, its localStorage key deliberately NOT: `migrateGiveUps` converts every
  un-retried row into a `failed` queue row exactly once, with a **FRESH ackId always**. Its three jobs
  are Activity's now, "have I dealt with this" included (`activityDismiss.ts` files a row without
  deleting it).
- `SessionTabsBar.tsx` + `sessionTabs.ts` — **the open sessions as a strip**, the THIRD always-on bar
  and `link.ts`'s shape again: one store, ONE writer (`noteSessionTabs`, fed by `App`'s own render
  data), taps leaving as EVENTS because the bar is mounted beside `App` and cannot call its setters —
  the two verbs are `attach` and `closeSession`, unchanged, and **no new send path**. **The colour is
  the repo's own** (`repoHue`) as a TINT under `--fg`, never repo-hued text on a repo-hued ground
  (the one pairing the palette cannot hold at 4.5:1 across 360 hues); the selected tab is a STRONGER
  MIX OF THE SAME HUE plus a cap of it on its top edge and three more pixels of HEIGHT (brightness
  alone cannot say "front tab" — a vivid repo looks that way anyway), never the accent. **The tint is
  the LAUNCHER's token over the LAUNCHER's surface** — `--repo-fill`/`--repo-fill-on` as ALPHAS, the
  strip's ground `--bg` not `--panel` — so a tab and its group header are the same COLOUR, not the
  same hue in two mixes tuned apart (`--tab-veil`/`--repo-veil`, which is what "the colours nearly
  match" was). **Those three shapes are declared on the ELEMENTS carrying `--repo-accent`, NEVER at
  `:root`**: a custom property resolves its `var()`s where it is DECLARED, so a root `--repo-fill`
  computes to flat transparent and inherits colourlessness into every tab, with nothing in the
  stylesheet looking wrong. **Light FILLS harder and WASHES lighter than dark** (46/10 against
  40/18, the wash exactly where it shipped — it sits behind text of its own hue), the fill's ceiling measured in `theme.test.mjs`, never chosen. **`TAB_STRIP_H` and
  `.sess-tabs`'s height are one number in two files**, pinned by `sessionTabs.test.mjs`.
  **What a tab is DOING is `sessionStatus()`**, never booleans of the strip's own — the same five
  buckets and the same five colours (`--accent`/`--dead`/`--limit`/`--muted`/`--dead`) the row badge,
  the roll-up and the filter share, words from `STATUS_LABEL`; the two booleans it replaced drew
  *waiting on you* and *at the limit* as the same grey dot as *nothing left to do*. **A running turn
  SPINS** — `statusPill`'s own `Loader`, only while a turn runs, only on tabs running one, stilled by
  `prefers-reduced-motion` into a spoked RING that is still not a dot.
  **How many fit is a setting and NOT a limit** (`--stab-n` sizes a tab to `1/N`; the rest scroll,
  the active one is scrolled into view) — per device with `netPulse`'s argument, because three tabs
  is a measurement of THIS screen; **default 3 because the names are up to FOUR words**. **How many
  are DRAWN is a second setting that IS a limit** (`tabsLimit`, default 10, `limitTabs` pure/tested):
  the open session is always drawn, and the cut is COUNTED at the strip's end (`+N`, words not a
  control). **THREE orders** (`open` / `frequent` = the habit / `recent` = where was I, the only one
  that MOVES under you — and the DEFAULT, by the owner's ask), and **the tie-break is always the open sequence** or tabs swap places on a publish that
  changed nothing. The store is `{n, at}` per session, ONE store for both orders, `migrateOpens`
  converting the old bare count rather than dropping it (**no instant reads as longest-ago, never as
  just-now**); bumped in `attach` (every route in goes through it), **pruned on publish but NEVER
  against an empty session list** (a cold start and a dead tunnel look identical). **The × asks**
  (`Confirm.tsx`) and archives — never `window.confirm`. **Nothing to show ⇒ nothing drawn**, height
  published as 0. `tabLabel` is the one label rule: the host's ≤4-word `tabTitle`, else the title with
  the repo prefix cut, never blank and never invented — and the SESSION HEADER draws that name in
  FULL (`.brand-name`, wrapping, `Sparkles`), INLINE beside the branch, which is what four words are
  for.
- `repoColors.ts` + `RepoColorSheet.tsx` (+ `shared/repocolor.ts`) — **which repo is which colour, as
  a decision a person may take.** The hue was `hash * 137.508 % 360`, a golden-angle spread that
  spreads CONSECUTIVE inputs and nothing else: two of sixteen repos here measured 9° apart — one
  colour, twice. Now a RING of hues ≥24° apart indexed by the same hash, four rings to choose from
  (one measured under simulated CVD in `theme.test.mjs`, because a hue GAP says nothing about that),
  and **a hue a person may pin per repo — which SURVIVES a change of ring** (you chose a colour, not
  a slot). **`format.ts`'s `repoHue` reads a MODULE value**, never a hook: ~30 call sites are a
  `style=` mid-render and what a change needs is the RE-RENDER — `App` and the strip subscribe for
  exactly that. **The count IS the filter** (*12 repos share a colour* opens those twelve);
  **nothing applies itself** — *give them separate colours* moves only what collides, keeps a repo
  already alone on its hue, and **NEVER moves a pinned one**; more repos than hues is a SENTENCE,
  never a dimmed button. **Synced** (`waterplane.repoColors`) where `waterplane.theme` is not: the theme is a
  fact about the device, which colour `waterplane` is, is a fact about the person. Only the HUE is ever
  decided here — `--repo-sat`/`--repo-lit` per theme are swept over all 360 hues, so nothing
  pickable can make a name unreadable.
- **The session header is TWO rows and the break is STATED** (`.hdr-row2`). It was four — title,
  derived name, chips, and the five icon buttons that could not fit beside the chips — and that last
  one is not a sizing accident: **a wrapping flex row breaks on BASE sizes before it shrinks
  anything**, so a chip list wider than the row pushes the controls onto their own line however well
  it scrolls. One child at a 100% basis can only ever start a line; `.hdr-cmds` sits at basis ZERO
  inside it so a long list eats its OWN row; `.hdr-ctl` groups the buttons so the break never lands
  between two of them. **The typing keeps stay DIRECT children** — `.screen.typing .topbar >
  *:not(.hdr-typing-keep)` hides a nested one with its group. A header button is 40px, not `.key`'s
  46×44: in a bar that already wraps, 4px is measured against a whole ROW. The header wears the
  repo's hue as `.row-wrap`'s own 3px stripe — and drops it in typing room, where the bar is gone.
- `ArchiveSheet.tsx` — the route back to a session you closed. The × is an ARCHIVE: it sends
  **`session.remove`, never `session.kill`** (kill leaves the row `exited`, which then suppresses the
  "Recently closed" entry). **`session.remove` is answered with the session list even for an UNKNOWN
  id.** Search is a SUBMIT, not a keystroke filter. Its entry point is the launcher header,
  deliberately not the section header that disappears when the shortlist empties.
- **Typing room** (`chromeMode.ts`, `uiScaleSteps.ts`) — while the caret is in the compose box the chrome ABOVE it is hidden and the
  terminal keeps the rows (measured: all of it together left TWO lines). **The signal is FOCUS, not a
  keyboard measurement** — but LEAVING is: Android's back gesture keeps the caret, so `trackKeyboard` blurs the box only when the viewport returns to its height AT FOCUS after provably dropping a keyboard's worth, held still `KEYBOARD_SETTLE_MS` ("grew back from the shortest" fired on the opening animation and shut the keyboard). CLI mode is excluded. What survives is the output and two buttons —
  **outline** (which does not end typing mode) and **menu** (`typingPeek`, which brings the chrome back
  without giving up the caret). The strip is absolute, never `fixed`. **Full screen is the same layout
  asked for BY HAND** (`fullMode`, the terminal's own corner button, not persisted): same class so the
  two never drift, drawn on BOTH surfaces (the exit must exist wherever the mode can be entered), and
  the **special-key row STAYS** — with no keyboard those keys are the only way to answer the CLI.
  **`chromeMode.ts` is the whole conjunction, pure and node-tested** — every bug here was a bug in
  the conjunction. Three rules: **`onSessionScreen` gates BOTH hiders** (the strips it hides —
  `.net-pulse`, `.localrt-bar` — are mounted OUTSIDE `App` and hidden by an attribute on `<html>`, so
  an ungated mode took them off the launcher and every sheet; `composeFocused` survives the back
  button, no blur fires on unmount) · **`fullScreen` resets on leaving the session** (a hidden header
  you never asked for is the state bug, not its symptom) · **the peek suspends full screen too**, or
  the ☰ asks one hider to let go while the other holds on and reads as dead. The corner button
  carries `keepFocus`: without it the pointerdown blurs the box and the button moves out from under
  the finger before its own click lands.
- **The corner group** (`.term-zoom`, top right of the TERMINAL *and* the READER, floating for the
  `conn-banner` reason — a strip in flow refits the grid and SIGWINCHes the PTY): the **reader/CLI
  switch** (moved OFF the header — full screen hides that row, and this is the control you want most
  in the layout you read a long turn in), the zoom pair, then **full screen LAST** — the group is
  anchored RIGHT and grows leftward, so the right-most button is the only one that never moves when a
  zoom button drops off its ladder. **It draws and toggles what is ON SCREEN (`chromeHidden`), never either switch**: drawn from `fullMode` it said *enter* while typing room hid the chrome; drawn from `fullScreen` it said *leave* over a header the ☰ peek had brought back — a dead tap both times. `fullScreenTap` (pure, tested) asks for the opposite of what is visible and moves BOTH the switch and the peek to agree. **Two stored zooms, one per surface** (`waterplane.termZoom` / `waterplane.readerZoom`): the
  terminal is told to xterm as PIXELS, the reader is ONE `--ui-font` override on its subtree
  (`readerScale`, clamped as a PRODUCT), wrapper `display: contents` so `.tr`'s height still resolves
  (`uiScaleSteps.ts`'s `termFontPx`/`nextTermZoom`, a multiplier ON the text size — smaller font is a
  BIGGER grid, and the refit's report is what resizes the PTY). **No px readout** over live output;
  at an end of the ladder that button is ABSENT with the end named, never dimmed.
- **The terminal toolbar IS the burger's MENU** — a vertical list of labelled line items, a full-width
  child of the wrapping header (never a popover), capped at `50svh` with its own scroll, shut by
  default at every width. The switch is in the header, never in the menu it opens. **A tap closes
  it** (`closeToolbarMenu`, same persisted key as the burger) except `MENU_KEEP_OPEN`, which mutate
  in place. **Labels are not optional here** — `ToolbarCfg.iconsOnly` is deprecated; only the header
  PINS are icon-only. No desktop rail: one rendering at every width.
- `headerCmds.ts` — the header chips, and `splitHeaderCmds(cmds, canSlash)` → `{ shown, hiddenSlash }`.
  A `/compact` chip rendered beside "no slash commands" typed Claude's vocabulary at a backend that
  reads it as PROSE. Withheld, **never deleted** (synced user data; the manage sheet still lists all
  of them) and **never dimmed** — the loss leaves as a COUNT on the slash line of the cants strip,
  from this same call. **`canSlash: true` is the list unchanged**, so a claude header is
  byte-identical. Predicate is `runHeaderCmd`'s own, on the TEXT never the title.
- Session rows sort strictly by `createdAt` (status never enters the key), with a manual per-device
  order and same-repo rows kept contiguous.
- **The launcher is ONE list** (`repoGroups`): a repo group header per repo whether or not it has a
  live session, its sessions under it and its worktrees as start-point rows — because with a second
  section below, WHICH half of a repo's verbs you got depended on whether it happened to have a
  session open. A repo with nothing running is ONE ROW. The local/external switch is a menu entry, not
  a segmented bar, but WHICH view is showing stays on screen. **A row opens into the READER too**
  (`openReader`): read mode set BEFORE the attach (the ref moves by hand or the transcript is fetched
  twice), outline fired after — and `attach` CLEARS `readerCmd`, or a verb fired in one session
  re-fires over the next reader that mounts.
- **`CloseSheet.tsx` + `closeModel.ts`** (`core/launcher`, replacing the old single-cut close dialog) — the bulk
  close as seven combinable FACETS (state, idle-for, open-for, underneath, words at stake, conversation,
  repo) instead of five single-cut buttons: facets AND, options within one OR, every chip cross-counted
  against the OTHER active facets (`facetCounts`'s `withoutFacet` — the same self-exclusion
  `backlogFilter.ts`'s age/status pair uses). A full `Sheet` reached via `useBackStep`, never a route of
  its own. The list under the chips is the actual rows (`SessionFacts`) with a per-row "keep" toggle; the
  foot sends `session.remove` once per row still in and says `close N · stops M background shells`
  before it stops them — CLAUDE.md's "closing a session stops its shells, fully". `N = 0` is a sentence,
  never a dimmed button. A session a TIMED prompt is aimed at starts KEPT (`isKept`: there `kept` is the
  override) and `timedKeptNote` says so — never silently spared. Reasoning: [web.md](docs/notes/web.md#the-close-sheet-facets-that-combine-replacing-five-single-cut-buttons).
