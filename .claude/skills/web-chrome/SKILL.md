---
name: web-chrome
description: waterplane phone client — the frame around the content (packages/web/src): theme.ts + styles.css, routing.ts and Back (backStep.ts), the link store (link.ts, NetPulseBar.tsx), SessionTabsBar.tsx, repoColors.ts, chromeMode.ts (typing room, full screen), the phone/wide layout (layout.ts, Workspace.tsx), the launcher, CloseSheet.tsx, PassiveScreen.tsx, UpdateBanner.tsx, Markdown.tsx. Load BEFORE touching theming or repo colours, Back or the route stack, the header or session tabs, bulk close, typing room, phone vs wide layout, the passive screen, or bundle chunking.
---

# waterplane web — the app frame

The chrome around whatever is on screen: theme, routing and Back, the link store, the header and its session tabs, the update banner, typing room, the wide layout and the launcher. Router: `web`. Reasoning: [web.md](../../../docs/notes/web.md); moved-out stories: [web.md](../../../docs/notes/web.md#moved-out-of-skill-web-chrome-2026-10-17).

- `theme.ts` + `termTheme.ts` + `themeOverlay.ts` + the palette in `styles/00-tokens.css` — light or dark as a setting (`styles.css` is only the `@import` index of `styles/NN-*.css`: ORDER is the cascade, cut at rule boundaries, wide layout last, ≤650 lines a slice, tests read it via `tools/csssource.mjs`: `cssshape.test.mjs`)
  (`system`/`light`/`dark`, **per device, not synced**: storage.ts `theme: "device"`; written to `<html data-theme>`). Three things are NOT CSS and are
  pushed: the `theme-color` meta, xterm's palette (light MUST state all sixteen), and the Android
  window's system bars. **`index.html` sets the attribute inline, before the bundle parses** — any
  import arrives too late to stop the cold-start flash. Light is not dark inverted: hues re-picked,
  DEPTH ORDER inverted, white-at-low-alpha overlays become black-at-low-alpha. **There is no literal
  colour anywhere else in `styles/`**, and `theme.test.mjs` parses the slices to keep it that way
 . `themeOverlay.ts`: the
  host's `theme.json` becomes one `<style id="theme-overlay">`, the terminal palette, and `appName()`.
- `routing.ts`'s `Overlay` also accepts `feature:<manifest id>/<sheet>` (an in-repo extension's sheet, `featureSheetId`) — never in `PERSISTED_OVERLAYS`.
- `App.tsx` overlays and toasts (moved verbatim from the router): **it returns early once per overlay, so an always-on layer may not live
  in it** (`HintLayer`, the toast: `main.tsx`). **A toast's clock is the LENGTH of its
  words** (`toastMs`); every toast except a host alert also lands as a row in the bounded `ToastLog.tsx`, never counted into the unread badge.
- `App.tsx` sends and overlay table (moved verbatim from the router): **An explicit send beats `holdUntilIdle`**; a busy TURN is not a wall, but a question
  box, an unparsable dialog and a limit block are, and they get NAMED. **Which sheet is on top is a TABLE**
  (`overlayViews`); a miss falls through. **A chatty push nothing on screen reads keeps
  `prev`**; a status TRANSITION, a new id or a `null` is NEVER swallowed.
- `toolbar.ts` / `routing.ts` / `format.ts` / `localState.ts` — slices lifted out of `App.tsx`.
  **Back is a history STACK, not a URL diff**: each screen pushes one entry keyed on `history.state`,
  landing on a screen already in the stack UNWINDS to it, and a document that BOOTS deep seeds its own
  ancestors. **A pop is ONE pure decision** (`routeFromPop`, node-tested) that **reads the overlay off the KEY, not the hash** (`overlayFromKey`) — the hash
  drops a transient overlay on purpose; only a key THIS document pushed is trusted. Depth is what
  `window.shellBack()` (a legacy shell calls its old name) answers and is **PUSHED** to the APK shell. **Repo focus is part of the route** (`?repo=`) —
  never `window.open`. `localState.ts` also holds the pending stars (retired when a LIVE row shows the
  host agreeing) and caches the two lists READ with no socket — build commands and schedules — because
  **an empty list is a CLAIM**. Only the READING is cached.
- `backStep.ts` — **Back inside a sheet**, and the one route stack (`routeStack`) both it and
  `useRoute` move. **Closing a sheet is exactly ONE Back** (`routeStep`): the arrow lands where the
  gesture does, so a sheet opened from a sheet closes to that sheet. **A sub-view with its own back
  arrow (an opened file, an editor, a detail pane) calls `useBackStep(open, close)`** or the swipe
  pops the whole sheet — `tools/backstep.test.mjs` enforces it. Never wire it to a close that
  DISCARDS typed words (`PadSheet`'s editor is exempt for that). Features get it from `sdk`.
- `resumeRoute.ts` — **landing back where you were when a NEW BUNDLE replaces the running one.** The route is remembered on every change and put back before React mounts, **only when ARMED** by
  `webUpdate.ts` (stage / apply / revert) and consumed once: an ordinary launch still opens the
  launcher, and a bundle that crashes on the restored screen cannot restore it twice. **Only onto a
  bare URL** — a notification cold-tap naming a file beats where this phone was. Store
  `routeToUrl`'s output, never `location.href`. Pure decision, node-tested; `seedRouteStack` then gives the restored screen its ancestors.
- `UpdateBanner.tsx` + `updateSnooze.ts` — a staged build, said on the screen you are on. **It never
  applies anything itself.** Two answers to "not now", both keyed to the BUILD: the × is in-memory (a
  reload is when you want telling again), the **snooze is durable and pure/tested** — because not
  every reload is a decision. The clock opens **5m · 1h · 4h · 1d** as chips IN the bar (a preference
  is not `askConfirm`, which is destructive-only) and takes the choice back itself. Neither postpones
  `watchAutoApply()`.
- **Bundle chunking** (`vite.config.ts` `manualChunks`) is an UPDATE boundary, not a load-time tweak:
  `webbundle.ts` ships only files whose sha256 moved,. Nothing is lazily loaded.
- `Markdown.tsx` + `fileRefs.ts` / `media.ts` / `thumbSrc.ts` — React nodes only, never `dangerouslySetInnerHTML`; **an anchor only for an absolute
  `http(s)`/`mailto:` href** (in the Capacitor WebView `target="_blank"` is a SAME-FRAME navigation). Plus `fileRefs.ts` (**a written-out transport path is recognised anywhere; a BARE filename only in a code span, only for media, and only when the repo's listing — `transportIndex.ts`, read while the reader is open, never cached to disk — holds exactly one file by that name**) ·
  `media.ts`/`uploadScale.ts` (**`encodeCanvas`, the one way a canvas becomes bytes** — a bare
  `toBlob` can return null, an EMPTY blob, or never call back at all) · `fileMtime.ts` (**an
  un-versioned thumb URL is cacheable by nobody**) · `thumbSrc.ts` · `ZoomableImage.tsx` · `NetActivity.tsx` (background
  polls must NOT register).
- `link.ts` + `NetPulseBar.tsx` — **the link, as ONE store**
  (code: `link/` — `linkStatus.ts` the one online writer (`noteLinkStatus`), `linkStore.ts` the store (`subscribeLink`/`useLink`/`linkSnapshot`), `linkPulse`, `linkTraffic`, `linkSync`, `linkLog`, `linkOps`, `linkVerdict`, `stallRecorder`; `link.ts` is the facade). **One status, one document, one emit**: `noteLinkStatus()` is the ONLY
  writer; sections are `pulse` (**misses are drawn, never averaged**; it **observes and never
  steers**), `traffic` (measured by **patching the transports, never call sites**), `sync` (**last
  connected is the newest INBOUND FRAME**, never `readyState`) and `log`. Persisted, because **the
  reload IS a data point**. **Every reading is its own tap target and its own hint.**
- `hostRoute.ts` — how the active host is reached right now (LAN or tailnet) plus the one sentence
  why, as a store with ONE writer (`lanLink.ts`, `web-config`). Read by `NetPulseBar.tsx`, the
  health sheet and `features/hosts`' door and switcher sheet — never re-derived at any of those
  sites. Reasoning: [web.md](../../../docs/notes/web.md).
- `SessionTabsBar.tsx` + `sessionTabs.ts` — **the open sessions as a strip**, the third always-on bar, in the link store's shape:
  one store, ONE writer (`noteSessionTabs`, fed by `App`'s render data); taps leave as EVENTS (the bar is
  mounted beside `App` and cannot call its setters) — `attach` and `closeSession`, **no new send path**.
  **The colour is the repo's own** (`repoHue`) as a TINT under `--fg`, never repo-hued text on a repo-hued
  ground, the selected tab a stronger mix of the same hue, never the accent. **The tint is the LAUNCHER's
  token over the LAUNCHER's surface** (`--repo-fill`/`--repo-fill-on` as alphas over `--bg`), so a tab and
  its group header match; **declare those shapes on the ELEMENTS carrying `--repo-accent`, NEVER at
  `:root`**; light FILLS harder and WASHES lighter than dark (`theme.test.mjs`). **`TAB_STRIP_H` and
  `.sess-tabs`'s height are one number in two files** (`sessionTabs.test.mjs`). **What a tab is DOING is
  `sessionStatus()`** (`sessionFacts.tsx`), never booleans of the strip's own; words from `STATUS_LABEL`; a
  running turn SPINS (still under `prefers-reduced-motion`). **How many FIT is a setting** (`--stab-n`, per
  device, default 3); **how many are DRAWN is a limit** (`tabsLimit`, default 10, `limitTabs` pure/tested):
  the open session is always drawn, the cut is COUNTED at the strip's end (`+N`, words not a control).
  **THREE orders** (`open` / `frequent` / `recent`; the DEFAULT is the only one that MOVES under you), **the
  tie-break is always the open sequence**. The store is `{n, at}` per session (`migrateOpens` converts the
  old bare count; no instant reads as longest-ago), bumped when a session COMES ON SCREEN (`openOwed`),
  **pruned on publish but NEVER against an empty session list** (a cold start and a dead tunnel look
  identical). **The × asks** (`Confirm.tsx`) and archives. **Nothing to show ⇒ nothing drawn**, height
  published as 0. `tabLabel` is the one label rule: the host's ≤4-word `tabTitle`, else the title with
  the repo prefix cut, never blank and never invented.
- `repoColors.ts` + `RepoColorSheet.tsx` (+ `shared/repocolor.ts`) — **which repo is which colour, as
  a decision a person may take.** A RING of hues ≥24° apart indexed by the repo-name hash, four rings to
  choose from (one measured under simulated CVD in `theme.test.mjs`), and **a hue a person may pin per repo
  — which SURVIVES a change of ring**. **`format.ts`'s `repoHue` reads a MODULE value**, never a hook (~30
  call sites are a `style=` mid-render); `App` and the strip subscribe for the RE-RENDER. **The count IS the
  filter** (*12 repos share a colour* opens those twelve); **nothing applies itself** — *give them separate
  colours* moves only what collides, keeps a repo already alone on its hue, **NEVER moves a pinned one**;
  more repos than hues is a SENTENCE, never a dimmed button. **Synced** (`waterplane.repoColors`) where
  `waterplane.theme` is not: which colour a repo is, is a fact about the person. Only the HUE is decided
  here; `--repo-sat`/`--repo-lit` are per theme.
- **The session header is TWO rows and the break is STATED** (`.hdr-row2`). **A wrapping flex row breaks
  on BASE sizes before it shrinks anything**: `.hdr-cmds` sits at basis ZERO so a long list eats its OWN row; `.hdr-ctl` groups the buttons
  so the break never lands between two of them. **The typing keeps stay DIRECT children** —
  `.screen.typing .topbar > *:not(.hdr-typing-keep)` hides a nested one with its group. A header button is
  40px on the phone layout (32px under `html[data-layout="wide"]` with a fine pointer, `styles/`), not
  `.key`'s 46×44. The header wears the
  repo's hue as `.row-wrap`'s own 3px stripe — and drops it in typing room, where the bar is gone.
- `ArchiveSheet.tsx` — the route back to a session you closed. The × is an ARCHIVE: it sends
  **`session.remove`, never `session.kill`**. **`session.remove` is answered with the session list even for an UNKNOWN
  id.** Search is a SUBMIT, not a keystroke filter. Its entry point is the launcher header.
- **Typing room** (`chromeMode.ts`, `uiScaleSteps.ts`; state in `core/session/useSessionChrome.ts`) —
  while the caret is in the compose box the chrome ABOVE it is hidden and the terminal keeps the rows.
  **The signal is FOCUS, not a keyboard measurement** — but LEAVING is: Android's back gesture keeps the
  caret, so `trackKeyboard` blurs the box only when the viewport returns to its height AT FOCUS after
  dropping a keyboard's worth, held still `KEYBOARD_SETTLE_MS`. CLI mode is excluded. What survives is the
  output and two buttons — **outline** (which does not end typing mode) and **menu** (`typingPeek`, which
  brings the chrome back without giving up the caret). The strip is absolute, never `fixed`. **Full screen
  is the same layout asked for BY HAND** (`fullMode`, the terminal's own corner button, not persisted):
  same class so the two never drift, drawn on BOTH surfaces, and the **special-key row STAYS** — with no
  keyboard those keys are the only way to answer the CLI. **`chromeMode.ts` is the whole conjunction, pure
  and node-tested.** Three rules: **`onSessionScreen` gates BOTH hiders** (the strips it hides —
  `.net-pulse`, `.localrt-bar` — are mounted OUTSIDE `App`, hidden by an attribute on `<html>`;
  `composeFocused` survives the back button, no blur fires on unmount) · **`fullScreen` resets on leaving
  the session** · **the peek suspends full screen too**, or the ☰ reads as dead. The corner button
  carries `keepFocus`, or the pointerdown blurs the box and the button moves out from under the finger
  before its own click lands.
- **The corner group** (drawn by the terminal area, web-term's `core/session/` file; `.term-zoom`, top right of the TERMINAL *and* the READER, floating for the
  `conn-banner` reason — a strip in flow refits the grid and SIGWINCHes the PTY): the **reader/CLI
  switch** (moved OFF the header — full screen hides that row), the zoom pair, then **full screen LAST**,
  anchored RIGHT and growing leftward. **It draws and toggles what is ON SCREEN (`chromeHidden`), never
  either switch**. `fullScreenTap` (pure, tested) asks for the opposite of what is visible and moves BOTH
  the switch and the peek to agree. **Two stored zooms, one per surface** (`waterplane.termZoom` /
  `waterplane.readerZoom`; `uiScaleSteps.ts`'s `termFontPx`/`nextTermZoom` is a multiplier ON the text
  size — smaller font is a BIGGER grid, and the refit's report is what resizes the PTY; the reader is ONE
  `--ui-font` override, `readerScale`). **No px readout** over live output; at an end of the ladder that
  button is ABSENT with the end named, never dimmed.
- **The terminal toolbar IS the burger's MENU** (`core/session/ToolbarMenu.tsx`) — a vertical list of labelled line items, a full-width
  child of the wrapping header (never a popover), capped at `50svh` with its own scroll, shut by
  default at every width. The switch is in the header, never in the menu it opens. **A tap closes
  it** (`closeToolbarMenu`, same persisted key as the burger) except `MENU_KEEP_OPEN`, which mutate
  in place. **Labels are not optional here** — `ToolbarCfg.iconsOnly` is deprecated; only the header
  PINS are icon-only. One rendering at every width on the phone layout; the wide layout puts the launcher in `aside.ws-side` (`Workspace.tsx`).
- `headerCmds.ts` — the header chips, and `splitHeaderCmds(cmds, canSlash)` → `{ shown, hiddenSlash }`.
  Withheld, **never deleted** (synced user data; the manage sheet still lists all
  of them) and **never dimmed** — the loss leaves as a COUNT on the slash line of the cants strip,
  from this same call. **`canSlash: true` is the list unchanged**, so a claude header is
  byte-identical. Predicate is `runHeaderCmd`'s own, on the TEXT never the title.
- `LauncherScreen.tsx` (`core/launcher/`) — **the launcher is ONE list**
  (`repoGroups`, a memo in `useLauncherModel.ts` over `repoGroupsOf` in `model.ts`): a repo group header per repo whether or not it has a
  live session, its sessions under it and its worktrees as start-point rows. A repo with nothing running is ONE ROW. **Launcher state is module stores: the screen unmounts under every sheet**, and a filter must survive the round trip. Session rows sort strictly by `createdAt` (status never enters the key), with a manual per-device
  order, same-repo rows kept contiguous and a companion shell glued under its session (`glueCompanions`, applied in `model.ts`). The local/external switch is a menu entry, not
  a segmented bar, but WHICH view is showing stays on screen. **A row opens into the READER too**
  (`openReader`): read mode set BEFORE the attach, outline fired after — and `attach` CLEARS `readerCmd`, or a verb fired in one session
  re-fires over the next reader that mounts.
- **`CloseSheet.tsx` + `closeModel.ts`** (`core/launcher`) — the bulk
  close as seven combinable FACETS (state, idle-for, open-for, underneath, words at stake, conversation,
  repo): facets AND, options within one OR, every chip cross-counted against the OTHER active facets
  (`facetCounts`'s `withoutFacet`, as `backlogFilter.ts`'s age/status pair). A full `Sheet` reached via `useBackStep`, never a route of
  its own. The list under the chips is the actual rows (`SessionFacts`) with a per-row "keep" toggle; the
  foot sends `session.remove` once per row still in and says `close N · stops M background shells`
  before it stops them (closing a session stops its shells, fully). `N = 0` is a sentence,
  never a dimmed button. A session a TIMED prompt is aimed at starts KEPT (`isKept`) and `timedKeptNote` says so — never silently spared. Reasoning: [web.md](../../../docs/notes/web.md#the-close-sheet-facets-that-combine-replacing-five-single-cut-buttons).
- `Stowable.tsx` + `stow.ts` — **a strip above the prompt bar FOLDS, never closes.** Wrap it in `Stowable`
  (slot + `stowKey` = its CONTENT, so new content unfolds by itself) and put `<StowButton />` in its head;
  the chip rides the session status line (`StowTray`), no row of its own. Used by `ShellLinksBar`,
  `LoginBar`, `NextPrompt`. Reasoning: [web.md](../../../docs/notes/web.md#a-strip-above-the-prompt-bar-folds-it-never-closes-stowabletsx--stowts).
- `layout.ts` + `Workspace.tsx` (`core/layout/`) — **PHONE OR WIDE is one fact, one writer** (`startLayout`'s media-query listener; `WIDE_MIN_PX` 1024, **width ONLY** — pointer/hover decide affordances, never structure). **No hysteresis**: anything that must survive a crossing lives outside the frame (the draft in `App`, PTY bytes in `useTermFeed`, the overlay in the route); **never a remount** — both layouts return the same two-slot fragment, so the session screen sits at the same React position at every width. `html[data-layout="wide"]` carries the CSS (one block, `styles/15-wide-layout.css`, last); the launcher moves to `aside.ws-side`. Read `useLayout()`/`useWide()`, never a second width test.
- `PassiveScreen.tsx` + `passiveMode.ts` — the kids' phone: **the HOST is the boundary** 
  (`host/passive.ts` allows a passive token only what `passiveAllows` names — health, the web bundle the OTA update reads, the passive screen's own state, the theme, and the artifact download of an APK the auto-pull queue holds right now; the WebSocket is refused outright, `server/wsops.ts`); this is a courtesy. `bootMode` (pure) picks the one screen — the host's answer, else the remembered mark — and **a passive boot opens no socket**. Never widen what the passive screen can reach.
