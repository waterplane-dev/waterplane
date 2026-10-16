---
name: web-config
description: waterplane phone client, settings, models and backends (packages/web/src): SettingsKit.tsx + settingsIndex.ts, settings.ts/settingsPush.ts/hostUrl.ts/hints.ts + HintChip.tsx, CliHealthSheet.tsx, LoginBar.tsx + openExternal.ts, ShellLinksBar.tsx + shellLinks.ts (and features/shellLogins/), LocalRtBar.tsx + localRt.ts + sysStat.ts, hostedAck.ts + HostedAckSheet.tsx, ModelField.tsx + LaunchAskSheet.tsx and modelGroups, backendCaps.ts, resumeIdOf. Load BEFORE adding a setting or a settings control, changing how preferences sync or adopt, touching sign-in, the local runner strip, the model picker or the launch ask, or reading a backend capability — an optional cap on the wire means INHERIT, never off.
---

# waterplane web — settings, models and backends

How this app is configured and what it is allowed to launch: the Settings screen and its sync, sign-in, the local runner, model and backend choice, and the health readout. Router: `web`. Reasoning: [web.md](docs/notes/web.md).

- `CliHealthSheet.tsx` — the health board's readout: one row per signal, and **nothing is
  re-derived** — verdict, sentence, order and prose all come from `@waterplane/shared`. **The unprompted
  mark is the feature**: an amber/red chip in the launcher TOPBAR (not beside "N at limit", whose
  section is absent exactly when a broken heuristic matters), plus one toast when an arriving rollup
  is WORSE than the last seen. `healthy` and `unknown` render nothing.
- `PluginsSettings.tsx` (`features/plugins`, with its session-menu group and the decision log) —
  plugin UI per CLAUDE.md (`local/extension-boundary`); a plugin without it DECLARES fields, actions, toggles, a badge and a status
  line (`shared/plugin.ts`) and these draw them with the app's own controls. A plugin's fields are
  dynamic, so they NEST (no `id`) inside the one catalogued row `plugins` — a new catalogue row per
  plugin would fail `settingsIndex.test.mjs` and could never be searched. `plugin.set` carries ONLY
  the changed key; a typed number out of range is refused in words (`parseFieldInput`), never
  clamped; a refusal (`plugin.error`) and a load error are shown VERBATIM; env is set/unset, never a
  value. The "let <name> answer" switch is CORE's, default off, and always says that core still
  refuses permission/plan/trust/destructive boxes. A toggle flipped back to its default is sent as
  `null`. The decision log's source chips are filters that say "n of N" (`cutDecisions`).
- `SettingsKit.tsx` + `settingsIndex.ts` — **the Settings screen: one component per KIND of
  decision, and a catalogue of what is on it.** A boolean was spelled ELEVEN ways here (`data saver:
  on` · `auto-continue on` · a bare `on` whose label was the section heading · `Return sends` ⇄
  `Return newlines` · `remote-control` with no state word at all · `ask every time` ⇄ `use these
  silently` · `also gating Tailscale` ⇄ `gate Tailscale too` · `auto-fire ON` ⇄ `ask me` · `weekly
  ceiling: 90%` ⇄ `off` · two state machines), picking one of N was FOUR idioms, and **an ACTION was
  a bare `.key` — pixel-identical to a switch that is off**, so `token statistics` (a door) and
  `data saver: off` (a switch) were the same rectangle. Now: `SetSwitch` (label left, `on`/`off`
  pinned RIGHT, whole row the target) · `SetChoice` (chips, never a `<select>` — a drop-down hides
  the alternatives, which is how `localRt`'s third mode was invisible) · `SetPick` (the ONE place a
  `<select>` is right: a long or open list) · `SetMulti` (SEVERAL of a closed set — chips that latch; what an empty pick falls back to is in the NOTE, never a dimmed chip) · `SetStepper` (absent at the ends) · `SetSlider`
  (always with its readout) · `SetAction` (**never wears the accent** — that colour means *on* — and
  a chevron ONLY when it opens another screen). `disabled` is gone from three rows: `cant` draws the
  REASON where the button was (`Unavailable.tsx`), `busy` is a running verb in its own glyph.
  **`SetNote` folds all but one line** into `hint-more`; **`SetWarn` never folds** — an absence and
  a warning are what must be read unasked. **Search is `settingsIndex.ts`** — keywords carry the
  words the LABELS do not; its matching rules (AND, substring, no group keywords, group title
  matches) are pinned by `settingsIndex.test.mjs`.
  **A group never skips rendering its rows** — one did, and the rows inside never counted
  themselves, so the filter bar read **"1 of 8" on a screen holding 54**; only the SECTION hides
  (`gone`, exact and `:has()`-free, plus a `:has()` rule for a group whose every row is absent).
  **The counts are the RENDER's, never the catalogue's length** (a third of the rows are
  conditional): rows push their ids into a tally, and `SetFilterBar` is drawn LAST and floated up
  with `order: -1` so it reads this pass rather than trailing a `useEffect`. Screen ⇄ catalogue
  ⇄ manifest group agreement is `settingsIndex.test.mjs`'s. Seventeen sections are SEVEN groups; the three always-on strips moved
  into Appearance (a strip costs a line of THIS screen — the text-size question, not a diagnostic).
  **`local-sessions`** (*local model sessions at once*: desktop default · 1 · 2 · 3 · no limit) writes the synced `LOCAL_SESSIONS_KEY` (`localSessionsSetting`, `""` deletes the key ⇒ the desktop's `WATERPLANE_LOCAL_SESSIONS`, else 1); the host's `localslot.ts` reads it.
- `settings.ts` / `hostUrl.ts` / `hints.ts` + `settingsPush.ts` — three places where a rule is enforced by **patching a
  global** rather than a helper call sites must remember. All three fail silently otherwise, weeks
  later, on the device you aren't holding. Keep it that way. **`AdoptGuard` may RETURN the string to
  write** — the pad is the one key that does, merging on adopt; a merge that produced something the
  host lacks is re-stamped STRICTLY newer (`ts + 1` at least: equal loses, and a skewed clock must
  not park it) and pushed, which is what makes the exchange converge in two round trips.
  **Both pushes are `settingsPush.ts`'s rules, node-tested** (this file patches a global and cannot
  be imported without a browser): a merge pushes only when the WRITE actually LANDED
  (`repushAfterAdopt` — quota throws, and the push reads the store BACK, so a refused write went up
  as the older copy under a newer stamp), and a device that is AHEAD merges the host's copy in
  before it pushes (`aheadValue` — ahead is not complete, and for a list "wins" means the other
  device's notes leave the host).
- `hosts.ts` + `hostBoot.ts` — several desktops, one phone (Android shell only). One host ACTIVE
  (bare keys), every other PARKED under `waterplane.h.<id>.`; a switch is two phases split by a reload,
  and `hostBoot.ts` is deliberately the FIRST import of `main.tsx` so the park/restore runs before
  any module reads a host key. Removing a host never deletes its words (`waterplane.hostsGone`). Screens:
  `features/hosts/` — read its own README first. Reasoning: [web.md](docs/notes/web.md).
- `shellNet.ts` + `deviceToken.ts` + `lanRoute.ts` + `lanLink.ts` — the LAN auto-route: which
  network the phone is on (the Android `ShellNet` plugin's page half), this phone's device token for
  the active host, the pure gate ladder (SSID → token → identity → probe → HMAC), and the runtime
  that wires it to the socket and falls back to the tailnet on any LAN failure. Reasoning:
  [web.md](docs/notes/web.md).
- `HintChip.tsx` — the VISIBLE half of `hints.ts`: a `?` that opens the same card the long press
  does, from the same catalog, with the same text. Long press is the right affordance for a
  toolbar, where an icon you cannot guess is one you will probe, and the wrong one for a screen of
  TERMS, where nothing suggests an explanation is there to hold down for. It carries the id on
  `data-hint` as well as in the handler so the press route still works on the chip itself, and
  renders **nothing** for an id with no entry — never a dead tap. `scripts/e2e-hints.mjs` scans
  `<HintChip id="…">` and the `hint="…"` prop components hand down to one, because a bare
  `data-hint={id}` tells that scan nothing.
- `LoginBar.tsx` + `openExternal.ts` — signing in from a phone: *open*, *copy*, *paste code*, plus a
  disclosure holding the URL in one piece. **The code goes in on the RAW, undurable path** (a login
  starts no turn, so the verified path would press Return into whatever came next).
  **Non-`http(s)` is refused** — screen-scraped text is not a link.
- `ShellLinksBar.tsx` + `shellLinks.ts` + `features/shellLogins/` — **a shell session's `LoginBar`**
  (`LoginBar` stays claude's). Links the host read off the screen or a `$BROWSER` call
  (`SessionInfo.links`): *open*, *copy*, a *copy code* button, *paste code* only while `awaitingCode`
  (RAW path, as `LoginBar`). A `local` link is a SENTENCE, never an Open button. `shellLinks.ts` is
  the pure wording. NOT `shellLink.ts` (the Android background link, `web-files`). The logins sheet
  inserts a command into compose, never sends it, and flags flows that redirect to localhost.
- `LocalRtBar.tsx` + `localRt.ts` + `sysStat.ts` — **the local runner as a strip**, `link.ts`'s shape: one store,
  one writer, **observes and never steers**. **FIVE states worded apart, never collapsed** (holding ·
  up-and-holding-nothing · did-not-answer · polling-off-here · this-desktop-never-answered); **misses
  DRAWN never averaged or bridged**; **ring is MEMORY-ONLY**, only the last sample persists so an
  offline open says its age. **THREE modes** (`off`/`while a model is loaded`/`always on`): `always`
  is its OWN choice, not a stronger `auto` — auto's vanishing act makes watching a model NOT be there
  impossible, and a bar that hides for both can only report good news; auto LINGERS past an eviction;
  the row SAYS auto still polls. **Strip the provider prefix at the FIRST `/`** or the resident model
  looks absent and the pressure note lies. The pressure note is a SENTENCE, never a block.
  **Tokens/sec absent, no placeholder.** `sysStat.ts` is the DESKTOP half of the sheet
  (`host/sysstat.ts` measures it): **the memory bar always adds up to the machine** — slices against
  the total, remainder as one explicit *available*, an overshoot CLAMPED never drawn past the end —
  **a slice nobody measured is not drawn** (no 0-byte row standing for an absent reader), the caption
  **leads with AVAILABLE and still names FREE** (33 GB against the 1.1 GB that started this) with one
  wording per `source`, **CPU busy and the load average are BOTH drawn and worded apart** (busy names
  its interval; the first sample of a watch has no delta and falls back to load), **process rows are
  a FOLD** (`23 processes`, never a pid standing for one) with `rssSumText` saying the column
  overlaps, the slow readers **say their age** (`slowAgeSec`), and an absent temperature is a
  SENTENCE naming the helper, never a blank. `sysStat.test.mjs`.
- `hostedAck.ts` + `HostedAckSheet.tsx` — **one acknowledgement before the FIRST hosted launch**, per
  device, resettable. **UNKNOWN IS NEVER FOLDED INTO HOSTED** — only an explicit `where === "hosted"`
  gates; no frame, claude, absent backend, no model named, `"local"`, an unnamed id and a newer
  host's invented verdict are ALL false, or the notice fires before every local launch and trains
  people to tap through it. Residual STATED not closed (a hosted model via the backend's own unnamed
  default slips it). Client-side — **the host never refuses a spawn over it**. Hangs off
  `askLaunchFirst`; `createOp.test.mjs` fails BY NAME on a start site that stops handing over its launch.
- `ModelField.tsx` + `LaunchAskSheet.tsx` + `LaunchPicker.tsx` — **choosing a model, and choosing WHEN to be asked.**
  `LaunchPicker` is the backend/wheel/effort/version set, ONCE: the ask and the fan-out's sweep row
  both draw it (they were two looks for one decision); the caller owns the pick and what is remembered.
  `ModelField` is the one model control before a session exists (new-session defaults + the ask):
  ONE drop-down with *Aliases* and *Versions*, the typed field only for a genuinely empty catalogue,
  and **a stored id the catalogue does not name shown as ITSELF** — a `<select>` whose value matches
  no option renders as the first, so it would otherwise read back as "default". `LaunchAskSheet` is
  `waterplane.launchAsk` (synced, **off by default**): a fresh open stops and asks backend + model,
  starting from the defaults. **The answer is for that launch only** — it never writes the defaults
  back — **but it IS remembered**: `LS.launchLast` (per device, NOT synced) holds the last answered
  pair and `launchAskStart` starts the controls on it, dropping it **as a pair** when the backend is
  one this host does not describe (a `<select>` off its options renders as the FIRST, so the control
  would say claude while the create carried opencode). Its controls are **`.set-row`, never a bare
  `<label>`** — that class is where labelled-control styling lives and `.form` has no gutter.
  **Never on a resume and never over a caller that already decided** (`shouldAskLaunch`, pure
  and tested; a resumed conversation carries its recorded launch). **Nothing is queued while it is
  up**, so closing starts nothing and the overlay is deliberately not reload-restored. **The gate is
  EVERY fresh start's, not `openCwd`'s** — `openRepo` and `startSessionWithPrompt` build their own
  create, and gating only `openCwd` left the switch doing nothing for the launcher row. One helper
  (`askLaunchFirst`), callers hand over the rest of their own tap; `createOp.test.mjs` fails by name
  on a fourth start site. Fan-out is out of scope: a sweep is ONE decision over N repos.
- **`ModelField` groups by WHERE a model runs** (`modelGroups`/`showWhereFilter`, `BackendInfo.models.where`):
  chips *On this desktop · 2* / *Hosted · 28*, **the count IS the filter**, **local FIRST** (that is a
  recommendation), one `<optgroup>` per place, and a sentence saying a hosted model needs the tunnel
  and may bill. **`unknown` is a real third group, NEVER folded into hosted** — that is why the wire
  field is a map and not a boolean. **No map ⇒ one group ⇒ the picker it has always been** (claude,
  and any older host). A filter with no matching group is dropped, not held; a value filtered out of
  view still SAYS it is set. **A hosted model carries a NON-DISMISSIBLE disclaimer** — drawn when the
  group is open OR the current value is hosted (the second is the case that matters) — and it states
  only what waterplane structurally knows: the prompt and every file read into it leave this machine, under
  the OPERATOR's terms. **Never restate a third party's data policy** (it changes, and the app would
  be asserting something untrue about code already sent); the test forbids naming a vendor. **"Free"
  is MEASURED** (`models.zeroCost`, 0/0 from the binary), never inferred from a `-free` name, and an
  unknown price is never drawn as free.
- `backendCaps.ts` — the pure capability slice for a multi-backend host. `showBackendPicker`
  renders NOTHING when the `backends` hello frame never arrived (old host ⇒ UI pixel-identical),
  and `launchFor()` strips a backend/effort/permissionMode the target cannot satisfy off EVERY
  `session.create`. An absent capability becomes a SENTENCE (`capReason`/`reasonText`,
  `Unavailable.tsx`), never a greyed control and never a 0%. Empty model catalogue ⇒ free-text
  field, never a guessed list — **for claude too: the app carries NO model table** (one catalogue, on the
  host: `claudemodels.ts` + the owner's `models.json`); no `backends` frame yet ⇒ typed field + `freeTextNote`.
  The demo host sends a fixture list in its `backends` frame.
- **`fork` / `resumePick` / `contextSeries` are OPTIONAL on the wire and ABSENT MEANS INHERIT** —
  `fork ?? transcript`, `resumePick ?? transcript`, `contextSeries ?? contextMeter`. Read raw,
  `undefined` is falsy and deletes working controls from every host one version behind, so the
  resolution lives ONLY in `hasCap`/`capReason` and no call site touches `caps.fork` itself —
  enforced by **`local/no-raw-optional-cap`**.
- **A shell is a backend with `kind: "shell"`** (`isShellBackend`, `shellBackend`, `shellQuietLine`):
  not in the picker (`agentBackends`), opened by its own action, and it gets ONE quiet line in
  place of the claude-only strip — never a row of greyed gaps.
  `sessionCants` is the strip as ONE builder: the fork sentence only where a READER EXISTS (with no
  transcript that absence is already said once), and `[]` for claude.
- **A reopen goes through `resumeIdOf`, never one id field** — `claudeSessionId ?? backendSessionId`,
  two fields because the daemon turns the first into a path under `~/.claude/projects`. Read as
  `claudeSessionId` alone (all four taps were), an opencode row names no id, falls through to the
  directory's `--continue` and, with two closed conversations in one repo, the OLDER row reopens the
  NEWER one — silently. Same reader for `conversationOpen` and the row `key`; the ended-session
  reopen carries `backend` too or it resumes under the wrong BINARY. **Where a row has no exact id
  the row SAYS so** (`reopenCant` + `CantInline`, `capReason`'s `resumePick` sentence) — on the row
  where the tap is decided, not in the cants strip of the session you land in. Titles say the EFFECT
  (`resumeHint`), never a command the row may not run. `createOp.test.mjs` fails on a site that reads
  either field directly.
- `BillingSettings.tsx` — billing profile override and the dollar periods + caps form; written with shared `withLimit`/`withoutLimit`. Reasoning: [web.md](docs/notes/web.md).
