# Changelog

Notable changes. This project has no release branches — `main` is the supported
version — so entries are grouped by the release they shipped in.

## 0.1.5

### New

- **A plugin manager on the phone.** Settings › Tools › plugins lists the plugins published in the waterplane-dev GitHub organisation, each with a maturity label. Install one, update one, or add a plugin by its repository URL. Only plugins with no dependencies of their own can be installed this way, and nothing installs or updates by itself: every change waits for your tap and ends in a receipt.
- **Update waterplane from the phone.** For installs made with `install.sh`, Settings › Tools › updates has an update button and a roll-back to the previous version, and says when the restart is done. The desktop checks once a day for a new version; that check can be switched off. Installs from npm or a git checkout show the exact command to run instead of a button.
- **The GitHub Copilot CLI plugin is available as a preview.** Install it from the plugin manager to drive Copilot sessions from the same phone: its launch modes, slash commands, plan box, context window and usage show up where they do for `claude`, and the conversation archive lists its conversations too. What a backend cannot do is said in words next to the control instead of the control being greyed out.
- **"When idle" on the CLI restart banner.** Arm a restart of the CLI and it fires once the session has nothing running.
- **The words in a marked area, read on the phone.** A new optional extension, text in marks (off until you switch it on), reads the text inside a highlight, box or circle you draw in the annotator (English and German) and writes it into that mark's note, unless you have already typed one. Switching it on downloads its engine (about 8 MB) from your desktop once; the reading runs on the phone.
- **Send offers to restart onto the newer `claude` first.** When a session still runs an older `claude` than the one installed, a plain Send asks: "Restart, then send" reopens the same conversation on the new version with your words as its first prompt; "Send on <old>" sends as before and is not asked again for that version.
- **The context sheet has a Skills chart.** It shows which skills entered a window, when, and what brought them in.
- **Closed sessions look like open ones.** "Recently closed" in the launcher and the conversation archive draw each row as the session's own card, including the context spark it ended with.
- **Small things.** A day axis on a chart names days (one dated tick per day, not 12:00 / 00:00). The files viewer shows the token and character count of instruction files. The annotator toolbar picks the top or the left edge, whichever leaves the picture larger, and wraps instead of scrolling. The floating terminal toolbar has uniform 36 px buttons. The Android app follows the phone's light or dark setting. Back from the annotator on a desktop, the caret is at the end of the compose box. A skill's description is read the way a YAML loader reads it, so the context weight no longer counts a skill with a byte-order mark or a quoted key as all body.
- **VS Code extension 0.6.0 and 0.6.1.** All sessions shows the same token stats as the phone, with live limits from a local desktop, and token stats work on a machine with Copilot and no Claude Code. In 0.6.1 the Copilot row opens Copilot Chat's token use without asking to sign in to GitHub.

### Fixes

- **Repo readings work on an installed release.** 0.1.4's release left out a file the health engine imports, so every reading on an `install.sh` or npm install failed with `ERR_MODULE_NOT_FOUND`. The release build now refuses to ship an engine with a missing import.
- **Re-running `install.sh` says what it did.** It names the run up front and at the end: a first install, an update from the version you had ("updated 0.1.4 -> 0.1.5"), or the same version again because there is nothing newer.
- **Starting a session on a desktop without Claude Code now says so.** You get "Claude Code isn't installed" and how to install it, instead of a bare "[exited]".
- **A session started while its CLI is being updated says so.** A package-manager upgrade removes the command for a few minutes; a session opened then (Claude Code, opencode or any other backend) is refused with "being updated, start it again once it is done" instead of `[exited]`, and the update button will not start a second install over one already running.
- **Security hardening (third pass).** Repo files that are links pointing out of the repo are refused rather than followed (inbox, outbox, `.env`, screenshots). A repo's own committed health engine, and the build listings a repo supplies, run only after a one-time approval you give. Thumbnails run under a deny policy. Origin and Host checks, the login rate limit and device-token minting are tighter, the release APK is no longer remote-debuggable or backed up, and several commands no longer pass values through a shell.
- **Answers and queue rows say what happened.** An answer is shown as queued only when the link is down, a failed queue row says it needs trying again, and a question cut at the host's length cap is marked as cut.
- **Unavailable controls say why in text** instead of being greyed out.
- **Idle and agent state is steadier.** A redraw over an idle prompt no longer clears "idle", an agent that woke after its notification ends when the CLI marks it finished, and a dynamic workflow's agents are read so the reader stops saying idle over one.
- **Dictation comes back after a dropped link.** The desktop's speech recogniser is asked again when the link returns.
- **A `tmux kill-server` typed inside a session can no longer kill the host's own tmux server.**
- **Repo readings:** the worktree toggle is gone (a worktree's readings are its repo's history again), and a pending health approval holds both verbs in one box.
- **A gated desktop's refusal to a tokenless probe counts as an answer** on the LAN route, so the host is no longer shown as unreachable.
- **A header pin for a plugin is one icon that opens its menu**, not the whole panel. The setup button for the build list reads "write build list", with what it writes said in text under the finding.

## 0.1.4

0.1.3 was tagged but never published; its notes below ship with this release.

### New

- **Every device can show your tabs in the same order.** On by default: the tab order and which sessions you opened most recently are shared between your devices, so a tab sits in the same place on the phone and on the desktop. The switch is per device, in Settings › Appearance › "same tab order on every device"; a device that turns it off keeps its own order.
- **A data saver or battery saver offers, once, to stop sharing the tab order.** When this app's data saver, the phone's data saver or Android's battery saver comes on, you are asked once per saver spell whether to stop sharing; nothing changes unless you say yes. Detecting Android's battery saver needs this release's APK.
- **A list button at the left edge of the tab strip shows every open tab as a vertical list.** It carries the number of open tabs. Names wrap in full, the repo and state are in words under each, rows wear their repo's tint, and tapping a row opens it.
- **Bookmark a conversation and find it again.** A session's menu has a bookmark line with a one-line note. The archive has a "Bookmarks (n)" filter, a toggle and note on each row, and a "read" button that opens the conversation read-only without starting `claude`.
- **The key row sends any key combination.** Ctrl, Alt and Shift stay held for the next key (tap once to hold, twice to lock, three times to let go). A new Keys list has `claude`'s own shortcuts, one tap each. The row also offers the shortcuts the CLI names on screen, such as "shift+tab to cycle".
- **The session header can be shortened by dragging.** A grip under the header clips it from the bottom (status line first, title last) and a tap shows it all again. It is remembered per device. The star and follow-up flag moved to the title row.
- **The context sheet names the dearest subagents and warns when one grows large.** It lists the five costliest agents with requests, peak window, tokens and cost. You get one push when a running agent passes a line you set (200k to 500k), and an "interrupt and re-plan" button on the large-agent card. It only warns; it never stops an agent.
- **The launcher lists repos with the most open sessions first.** Alphabetical order is still a choice in Settings; a device that already chose it keeps it.
- **"Assess and propose improvements" on the health index posts its proposals as held backlog rows.** Each proposal is a row you can fire, edit or delete. The session itself changes no file.
- **Repo health quotes git's refusal and handles committed bundles.** A repo git refuses to read is no longer called "not a git repository"; git's own words and suggested fix are shown, and a failed read is said once. Files marked `linguist-generated` or `linguist-vendored` in `.gitattributes` no longer count as your longest file. A repo with no `CLAUDE.md` now scores instead of showing no score. When a repo's own copy of the health engine fails, the readings offer a prompt to switch to the desktop's engine.
- **The desktop view (experimental) goes fully fullscreen.** Fullscreen covers the status strips too. The controls sit behind one draggable round handle, and Android hides its status and navigation bars (older APKs keep theirs). The desktop typing box no longer auto-capitalises or autocorrects. The extension's settings row now carries an "experimental" tag.
- **`claude` update checks work for the native install.** The host asks npm for new versions, on the channel `claude` itself follows, so the update banner no longer depends on the CLI printing its own nag.

### Fixes

- **A restart says why.** The restart toast and strip name the reason and the new build, for example "desktop restarting (npm run restart · new build ad1f6b9) · 12 s · usually ~30 s".
- **Pasting a picture next to the annotator asks instead of replacing your marks.** One paste handler now decides, so a screenshot pasted while another is being marked can no longer wipe that one's marks.
- **Ctrl/Cmd+Return in the annotator sends the picture first, then the prompt.**
- **A stopped download can be removed from the strip itself.** A file the desktop no longer has reads "no longer on the desktop" instead of "tap retry".
- **A finished fan-out target whose session has closed no longer reads "starting…".**
- **Repo headers in the launcher scroll away with their rows.** A tall header (two chip rows) no longer peeks out under the next one.
- **Connection health is clearer.** The unconfirmed-prompts banner can be cleared where it stands, and the median-ping note counts only the replies that came back.
- **The Send sheet's option groups have visible headings** ("What it waits for", "How many at once", and so on).
- **The installer explains a missing `claude`, then carries on.** It also says why `npm i -g` can fail and what to use instead.
- **The context-weight row no longer mentions Copilot in a Claude-only repo.** Copilot is weighed only where the repo has its own Copilot instruction file.

### Docs

- The Impressum page and footer links, a GDPR paragraph and a controller address are on the site's privacy pages. The site header and footer say waterplane is open source and link the repo.
- The comparison docs now say iOS uses the web app rather than "No".

## 0.1.3

### Fixes

- **The installer names everything missing at once.** Before downloading
  anything it lists what this machine lacks (claude, tmux, git, Tailscale), so
  one round of fixes is enough instead of one re-run per missing piece.
- **A Mac account without admin rights is told what to ask for.** The installer
  and `doctor` say which of tmux, the Xcode Command Line Tools and Tailscale an
  administrator has to install, and never offer a `brew install` that would fail
  because Homebrew belongs to another account.
- **`doctor` no longer calls Apple's git stand-in "git present".** Without the
  Xcode Command Line Tools, `/usr/bin/git` only offers to install them; the row
  now fails and names `xcode-select --install`.
- **The npm package is published.** 0.1.2's publish job failed after building
  the package, so 0.1.2 never reached npm despite its note above; 0.1.4 is the
  first version there, published by this repository's CI with provenance.

### Docs

- `docs/install.md`: installing on a Mac without admin rights, and the `EACCES`
  fix for `npm i -g`.

## 0.1.2

### New

- **Edit or cancel a waiting prompt from the next-prompt strip.** A pencil opens
  the prompt composer over the row's full words; cancel puts the words back on
  the pad, so nothing typed is lost.
- **Clear the health board's warnings you have read.** A two-tap "clear N
  warnings" hides what you saw; the next new miss brings its row back.

### Fixes

- **Switching a session's model or effort no longer changes the defaults for
  new sessions.** The model wheel, the model sheet and a relaunch only change
  the session they act on; defaults are set in Settings. A launch with no model
  set now starts on the account's default, not on whatever the CLI's own
  `/model` last saved.
- **One tap on the CLI-restart banner is one relaunch.** A double tap no longer
  opens a second `claude` on the same conversation, a relaunch keeps the
  session's own model, effort and mode, and the phone says when the desktop
  restarts.
- **Pasting a screenshot that is already open for marking no longer uploads it
  twice.**
- **A shell's link card stays folded** instead of flipping open and shut.
- **The installer explains a missing `claude`.** It prints the install command,
  says what `claude` needs (a paid plan, an API key, or a local Ollama model),
  and offers to continue without it; a local-only setup is no longer reported
  as broken.
- **The npm package can be built on Linux.** The release build used a
  macOS-only `tar` option, so 0.1.1 never reached npm; 0.1.2 is the first
  version published there, by this repository's CI with provenance.

## 0.1.1

### Fixes

- **The release tarball carried an extension that is not part of the open-source
  project.** 0.1.0 was built with a private extension switched on; 0.1.1 ships
  only what this repository contains. A release build now refuses an extension
  the public tree leaves out, and the installer no longer names one.
- **No more `tar: Ignoring unknown extended header keyword` lines on Linux.**
  The tarball is built without macOS extended attributes.
- **`waterplane doctor` sees a port taken on the Tailscale address.** It said
  "port 8770 is free" while another host held it there, and the service then
  restarted in a loop.
- **The port-in-use exit no longer tells an installed user to run
  `npm run restart`**, which only exists in a checkout.

## 0.1.0 — first public release

Everything below already existed privately; this is what the first public
version contains, plus the work done to make it fit to publish.

### Features

- **Sessions** — spawn and attach real `claude` CLI sessions per repo, worktree
  or branch over one WebSocket; model / effort / permission mode per session;
  fork a session; adopt sessions started in your own terminal; survive a host
  restart via `--continue`, or live inside tmux with `USMC_TMUX=1`.
- **Reader view** — a plain-DOM alternative to the terminal for the same
  session, parsed from Claude's own conversation log, with an outline, find bar
  and an unread watermark.
- **Backlog** — queued instructions that fire into fresh worktrees (parallel) or
  one session (queue), with turn boundaries taken from Claude's hooks.
- **Usage-limit auto-continue** — detect the limit, resume at the reset time,
  and reopen the conversation with `--continue` when the CLI exited outright.
- **Builds** — saved shell build commands runnable from the phone with no Claude
  session, so a rate limit doesn't stop you shipping an APK.
- **Git** — diffs, stage/unstage, commit, branch create/switch/delete, push.
- **Images and files** both directions, with annotation, zoom and swipe.
- **Prompt detection and one-tap approve**, Web Push notifications, voice
  dictation, slash palette, search, speed test, usage meter, LAN password gate,
  write-only secret entry.
- **Decision oracle** (optional, off by default) — a second model suggests an
  answer to routine prompts; never for permission, destructive or plan prompts.

### Security

- **Same-origin guard on `/api/*` and the WebSocket.** Previously the WS had no
  `Origin` check and the API answered `access-control-allow-origin: *`. Since
  loopback and Tailscale peers are trusted without a password, any web page open
  in a browser on the host — or on any tailnet device — could open a socket,
  spawn a session and execute code, without ever being on the tailnet. Both
  `Origin` and `Host` (DNS rebinding) are now checked, with `Sec-Fetch-Site` as
  the backstop for cross-origin GETs, and no `/api` GET mutates state.
- **Worktree containment.** `newWorktree` accepted a `basePath` off the request
  body with no guard; it is now confined to the scan root, and the containment
  check compares realpath-resolved paths.
- LAN password minimum raised from 4 to 8 characters.
- The file viewer no longer renders dotenv files, so the secret sheet's "never
  shown back" promise holds for the app's own surfaces.

### Safety

- `bypassPermissions` and `dontAsk` require an explicit confirmation, mark the
  control as dangerous, and show a standing indicator while armed.
- `install-service.sh` warns before baking an inherited `USMC_ALLOW_PUBLIC=1`
  into a service that then runs on every login, and ships an uninstaller.

### First run

- **`npm run doctor`** — preflight for the failures that are otherwise silent:
  logged-out `claude`, missing `node-pty`, no Tailscale IP, no secure context,
  busy port. Also runs at boot; `USMC_PREFLIGHT=0` opts out.

### Project

- `npm test` runs every `e2e-*.mjs` via `scripts/run-e2e.mjs`; the previous
  hand-maintained list had drifted to a third of the suite. CI runs the full
  suite on Linux and macOS.
- README rewritten against the code, `.env.example` completed, and SECURITY.md,
  NOTICES.md, CONTRIBUTING.md, issue/PR templates added.
- Public name is **UNSUCK AMC**. `usmc` remains only as an internal identifier
  (`USMC_*` env vars, the `.usmc/` state directory, npm workspace names).

### Since the first private snapshot (2026-10-07)

- **Windows from a Windows checkout.** Build in PowerShell, and `npm run
  restart` / `stop` / `start` / `doctor` / `dev` run the host inside WSL2 from
  the same checkout (`scripts/windows/host.mjs`): `setup` turns on mirrored
  networking and installs the pinned Node and a Linux `claude` in the distro
  without sudo; a hidden PowerShell keeper restarts a crashed host;
  `autostart` starts it at every logon. Under WSL a Windows-style
  `WATERPLANE_ROOT` (`c:/dev`) is its `/mnt/c` mount, and the Windows
  `tailscale.exe` is found through interop (MagicDNS name, `tailscale serve`).
  `npm run restart` run inside WSL (a session on the phone) hands off to
  Windows, and a restart never leaves two keepers starting two daemons.
  See `docs/notes/distribution.md`.

- **The host no longer freezes for minutes on a slow disk.** On WSL reading a
  Windows drive, three paths held the event loop on synchronous file and git
  calls: the setup sweep's git probes and folder walks (Android, APK, build
  scan — and every restart re-checking every repo), the artifact walk behind the gallery search and each turn end's
  new-image scan, and a `git status` per repo on every listing. All three now
  run in the background or are reused while fresh. The boot doctor no longer
  reports a slow `claude`/`git`/`curl` lookup as "not found".

- **The usage gauge reads again in an untrusted folder.** claude 2.1.293's
  unnumbered trust box made the usage probe press "No, exit", so the phone
  showed `? / ? wk`. The probe now walks to "Yes". The phone's answer card no
  longer highlights "No, exit" as the primary button on that box.

- **`WATERPLANE_ROOT` and `WATERPLANE_STATE_DIR` in `.env` are honoured.** They
  were read from the process environment only — a root set in the repo `.env`,
  as `.env.example` said to, was silently ignored. The repo and per-user `.env`
  now count for both.

- **Installable without a checkout.** `npm run release:build` makes one
  platform-independent tarball (production deps, all node-pty prebuilds) plus an
  npm package; `deploy/install.sh.tmpl` renders the `curl | sh` installer, which
  downloads a pinned Node (`deploy/node-version`) and the tarball, verifies both
  checksums, and stops with a sentence when `claude` is missing (this drives
  Claude Code first; opencode is experimental). The new `waterplane` command
  runs `start`, `doctor`, `version`, `service install|uninstall|status` (launchd,
  systemd user unit, WSL guidance) and `update [--check|--rollback]`, an
  explicit, checksum-verified self-update that never runs on its own. `doctor`
  gains WSL checks and now exits 1 when a check fails. Windows is supported
  through WSL only. See `docs/notes/distribution.md`.

- **Two Android builds with two keys.** `dev` (`<appId>.dev`, the owner's
  build: self-update, quiet installs) and `play` (the canonical app id: never
  installs itself, every install asks, and the page says so in words). The
  location prompt now follows an in-app explanation. The owner's app moves to a
  new id once; `packages/app/README.md` has the migration.

- **Open source, not open contribution.** Features arrive as intent requests,
  drafted and checked by the contributor-side `feature-request` skill; code PRs
  are merged only for a failing test or a docs fix (CONTRIBUTING.md).
  `npm run release:public` builds the public repo's snapshot from an allow-list
  and refuses to write while its secret and personal-data scan has hits.

- **USMC is now waterplane.** Every brand-bearing value — env
  prefix, config and state dirs, storage keys, cookie, WS subprotocol, pairing
  scheme, launchd label, app id — now has one source,
  `packages/shared/src/brand.ts`, with the old USMC names kept in its `LEGACY`
  table and read as fallbacks: an existing install keeps working unchanged, and
  a knob set under its old `USMC_*` name is reported once at boot with the name
  to use instead. The docs, the skills and the visible strings follow the new
  name; history in this file keeps the name it was written under.

- **The model picker was a typed field, offering nothing, over a list that had
  gone stale.** Two separate faults, visible as one blank box. The host's
  `claude` descriptor names no models on purpose — the catalogue belongs on the
  side where a person picks from it, so that there are not two tables that must
  agree — but `modelChoices` could not tell that deliberate empty from
  opencode's "nobody asked ollama", so the day a desktop described two backends
  the new-session model control silently became a free-text box: the list was
  still correct, still shipped, and unreachable from the only control that shows
  it. Claude's empty catalogue now falls back to that list; a non-empty one from
  the host still wins wholesale, and every other backend keeps the free-text
  rule. Meanwhile the control offered `aliases || ids` and never both, so the
  version list was unreachable by construction too, and the ids themselves had
  drifted far enough to be missing the model the app was running on while still
  offering a `[1m]` variant the installed binary does not name. The ids are now
  read off that binary's own strings (the re-derivation is a one-liner in the
  file, and the shape is pinned by a test), and `ModelField.tsx` is one
  drop-down with *Aliases* and *Versions* as groups — with a stored id the
  catalogue does not name shown as ITSELF, because a `<select>` whose value
  matches no option renders as the first one and would have read back "default"
  for a model that is set.

- **New sessions can ask which backend and model to run, instead of applying
  the defaults silently.** The defaults are a good answer for the session you
  are not thinking about, and the wrong shape for running a cheap model for a
  quick question and an expensive one for the work after it: doing that against
  a default is three screens, and forgetting the last one is silent — the
  session starts, looks right, and is on the wrong binary until the output feels
  off. `usmc.launchAsk` (synced, off by default) puts the same two controls
  where the decision is. The answer applies to **that launch only** — it never
  writes the defaults back, or the next session would inherit a choice made for
  this one. It is never asked on a **resume** (a resumed conversation carries
  the launch it was recorded with; asking there offers to continue it under a
  different binary) and never over a caller that already decided; both refusals
  are one pure, tested predicate rather than a condition inline. Nothing is
  queued while the question is up, so closing it starts nothing. The gate is
  every fresh start's, not `openCwd`'s: the launcher's repo row and the Start
  sheet each build their own create, so gating the one function whose name says
  "open a session" left the switch doing nothing for the tap people actually
  use. `createOp.test.mjs` now reads the source for that too — a fourth way to
  start a session, or an existing one that stops asking, fails by name.

- **The context curve is drawn while the session is working, not only after
  it stops.** The launcher row's miniature was rebuilt on the turn boundary and
  on a sweep that skipped anything younger than `IDLE_PING_MS` — two callers,
  one condition: the session went quiet. A session mid-turn, spinner repainting
  every frame, was therefore never refreshed, so a new session's row carried no
  curve for the whole of its first turn — blank on exactly the session whose
  context was climbing fastest — and a restored session that had printed nothing
  to this host process carried none either. The sweep's gates belong to the
  limit scan, which reads the SCREEN and must not read a half-drawn repaint; the
  miniature reads the CLI's log, which does not care. It now refreshes ahead of
  both, for one `statSync` per live session per sweep. `e2e-ctxgraph.mjs` pins
  it with a session poked often enough that it is never quiet.

- **A name nobody typed no longer survives an edit.** The card only titles
  itself when somebody actually named the schedule (`typedName`) — but the
  editor seeded itself with the stored `name`, which is the host's
  `text.slice(0, 120)` when nobody did. Edit the prompt, save, and the old
  fragment no longer prefixed the new words, so it came back wearing the
  authority of a chosen name: a mid-word slice of a prompt that no longer
  existed, crowning the row on both surfaces. Both seeds now re-derive through
  the same predicate, and the round trip is pinned by a test.

- **Three more places said a wall clock in the desktop's locale.** The skip
  verdict stored on the row (`skipped the 9/17/2026, 4:00:00 PM run`) printed
  beside the phone's own rendering of that same instant, which the card appends
  from `occurrence`; the save and skip toasts did the same. The verdict drops the
  date (the instant already travels as a number) and the toasts say a duration —
  `saved · next run in 2h 10m` — which reads the same in every locale.

- **Smaller ones from the same review:** the *see them in Activity* hand-off
  labelled its filter "that have already run" over rows whose own verdict says
  they never did (a one-off the desktop slept through is missed, not run) — it
  says *been and gone*, like the sentence it is tapped from; the schedules chip
  called its pool "armed rules" and then printed the unarmed count twice when
  nothing was armed at all; and the four schedule verbs that leave the sheet
  (*now*'s siblings — skip next, session, repo session, the spent hand-off) are
  in the feature catalogue, so "which button does nobody press" can see them.

- **A schedule card no longer prints the same sentence three times, in three
  lengths.** Its header showed `name` and its body showed the first 110
  characters of the prompt — and `name` is not a name: when nobody types one the
  host fills it with the prompt's own first line cut at 120. So one string was cut
  twice and ellipsised again by CSS at whatever width the phone was, and a card
  ended on *"already fi"*. `typedName` in `@usmc/shared` is the single test for
  "did somebody type this, or is it a slice of the text underneath it" — the
  backlog's `realLabel` is now a delegate to it, the card asks it of `name`, and
  Activity asks it of `Intent.title` (a schedule row there was a 120-character
  fragment of its own prompt). A derived name is simply not rendered; the prose is
  the title, which is what it had all along. The prompt itself is now clamped by
  LINES and not by characters, in the app's ONE three-line clamp with a tap to
  open it, in the UI font rather than mono — monospace says *this is a command*,
  and a scheduled prompt is a sentence.

  The card also answered one question in two vocabularies. The `SyncChip` says
  WHERE the rule is stored, the tag beside it says WHEN it fires, the rule line
  says WHAT it is — so *no next run* became `not armed`, the word the launcher
  chip and this sheet's own filter bar already use for that bucket, and the
  `one-off`/`repeats` chip went away because `describeRule` now leads with the
  kind (*every Thu · 16:00*, matching *once · …*). That matters more than it
  sounds: the section headings are not sticky, so a card scrolled past one has
  only its own lines to say which kind it is.

  Offline, the verbs that need the host are still absent rather than dimmed — but
  the reason is one fact about the link, and printing it under every card in the
  list buried the per-row facts that actually differ (this save is queued, that
  one gave up). It is said once now, in the sheet's banner, naming every verb the
  dead link takes away and naming *edit* as the one that still works because a
  save is a durable op. Two dead branches went with it: `spent` was constantly
  false on every card that renders (the list is cut by the negation of the same
  function, against the same clock, with no timer to change it), and the foot's
  sentence stopped claiming the spent one-offs *ran* — `isSpentOnce` reads the
  clock and nothing else, so one the desktop slept through never fired and
  Activity buckets it as failed. It now says they have *been and gone — run or
  missed, Activity's row says which*, under a `History` icon: a green tick over a
  missed run is the same lie in an icon.

- **A one-off that has been and gone is no longer a schedule.** Schedules listed
  every prompt that had already fired, and the launcher's chip counted them: ten
  spent one-offs put a permanent *10 not armed* on a desktop holding nothing
  pending, and tapping it opened *showing the not armed · 10 of 10* — a filter
  naming a state with no way out. A one-off cannot be re-armed (`nextFireAt`
  answers null for ever), so it is not a thing that is going to happen; it is an
  account of a thing that did, which is Activity's row, for its whole life, with
  what it produced and where it ran. `isStandingSchedule` is the cut, and it is
  the SAME function on both sides — the chip counts with it and the sheet lists
  with it, so the badge and the list cannot disagree. The sheet names the spent
  ones in a sentence at its foot with a tap that opens exactly those rows in
  Activity, and the empty state says so rather than reading as *your schedules
  are gone*. A one-off still in the FUTURE with nothing armed is unaffected: that
  one really was switched off and the switch really does undo it.

- **The same row now gets the same answer on both screens.** Activity refused
  *run it now* on a spent one-off while the schedule sheet offered it, for the
  same row and the same tap — and the sheet was right: the host revives the row
  in place and fires it, which is exactly what you want for a schedule missed
  while the desktop slept. Both surfaces now take their verdict, and their
  sentence, from one string in `@usmc/shared`; Activity also reads *spent* off
  the shared edge rather than its own, which called a one-off spent while the
  host still had it armed inside its grace window.

- **No wall clock is written into a wire string any more.** `missed — the host
  was not running at 9/10/2026, 9:52:00 PM` was formatted on the desktop, in the
  desktop's locale, and read on a phone two lines under `Do., 10. Sept., 21:52`
  — one instant, two formats, one card. The instant travels as a number and the
  phone prints it (the schedule row now shows the occurrence it missed); the
  sentences keep the grace window, which is a duration somebody configured and
  reads the same everywhere.

- **"At this rate" now has an answer in both halves of the usage screen, and a
  96% cache share has a verdict on it.** The two live windows projected a *full
  around HH:MM* only when the window filled before its reset, and said nothing
  at all otherwise — which is the ordinary case for the five-hour one, and reads
  as a projection that could not be made rather than as the good news it is. A
  window that sees itself out now says so in the unit it has an answer in: *on
  track for ~13% by the reset at that rate*. The instant, where there is one, is
  written like every other on that screen — the weekly projection lands days out
  and a bare `15:25` for it was the wrong-day reading the parse refuses to make
  upstream — and it carries the distance ("in 26h") beside it, because a date is
  only an answer after you have done the subtraction. Same arithmetic for both
  branches, still absent from a flat rate, a rate falling, fewer than two
  readings twenty minutes apart in the current window, or a reading whose reset
  has already passed.

  The other question that screen provoked and could not answer: whether being
  96% cache reads is the cache working or the same bloated conversation being
  re-read for ever. The SHARE cannot tell those apart and is no longer asked to
  — a cache read bills at a tenth of the input rate, so a high share is the
  cheap shape of the same traffic and the only way to lower it is to re-send
  that context at full price. Two ratios under it can: reads per written token
  against what a write has to earn back (derived from the tier mix actually
  written, ~1.4 reads at the 5-minute rate and ~2.2 at the 1-hour one — below it
  the caching is losing against sending the tokens fresh, which is sessions
  dying before their prefix is re-read and not a context that is too big), and
  the context an average turn carried against the ~200k where this desktop's own
  logs found the spend concentrating. Sentences, never a gate, and the mean is
  always stated as a mean: the distribution behind it was 1.4% of conversations
  holding 76% of every token.

- **A `Stop` hook is the CLI asking to end the turn — and a hook may answer no.**
  A session was spinning `✻ Crafting… (9m 35s · ↓ 34.5k tokens)` while the
  reader two taps away said "idle — nothing running", and the queue typed a
  prompt into it that was never confirmed and was retried four times. Nothing
  was wrong with the hook pipe: every keep-going loop (a `/goal` hook, a
  checklist driver) works by blocking the `Stop` and sending the next step back
  in, and when that happens no `UserPromptSubmit` follows — the continuation
  arrives in the conversation as a meta message, so nothing on the wire says the
  turn resumed. A Stop is now settled against the screen before it is believed:
  the CLI's own working line still printing after it means the turn is carrying
  on, and the hold is re-earned every pass, so a continuation that stops without
  a second Stop cannot leave a session wrongly busy either. One matcher for that
  line, shared with the phone's reader, because the interlock that keeps a
  queued prompt out of a live turn hangs off the answer. The same watch covers
  the other half of the complaint, reported an hour later: `/compact` announces
  nothing whatsoever — no hook of any kind — and grinds for minutes, so the
  screen is the only witness there is. Work the CLI is visibly doing is now
  published as work, whoever failed to mention it.

- **A highlighter that sends the words, not a picture of them.** Marking a
  screenshot on a phone has always had one hole in it: the marked copy is
  re-encoded down to the link's width on the way up, so the band drawn round an
  error message survives and the eight-pixel text inside it does not — the agent
  receives a picture of a sentence it cannot read, plus a note saying only where
  the sentence is. The new marker tool swipes translucent ink along a line of
  text (multiplied into the image, so the words underneath stay legible) and the
  band is then READ on the host, from the clean image at the resolution the
  phone still holds, so the prompt carries
  `highlight over "TypeError: cannot read x of undefined"` verbatim. Fewer
  tokens than an image to squint at, and the one part of a screenshot that
  cannot be misread. It uses the same Gemini key the decision oracle does and
  none of its machinery — it decides nothing, is asked for by hand once per
  mark, and what it read is shown on the bar and is editable before anything is
  sent, because a transcription nobody checked is a sentence the prompt
  asserts. No key, no network or no legible words are four different sentences
  and the mark still says where to look (`USMC_OCR=0` turns it off with a key
  set).
- **A marked image now names its marks.** The note beside an uploaded picture
  was a list of sentences with no handle on it — the prompt log has a message
  whose six marks arrived as six identical copies of `red circle at left`, so
  "this one is wrong" pointed at one of six and a reply could not point back.
  Marks are numbered now, in the words and on the image, from one list, so the
  `#2` in the prompt and the 2 painted next to the mark cannot drift; an exact
  twin (a double tap) collapses to one; the colour is stated only when marks
  differ in colour, since six "red"s on six numbered marks is six tokens buying
  nothing; and the pixel grid the agent ACTUALLY receives is appended, which is
  what makes the percentages convertible at all — absent, never guessed, when
  the final size is not a fact. A collage also says what it is
  (`collage of 3 panels in one row, left to right, numbered 1-3`): the panel
  numbers used to exist as pixels and nowhere else.

- **A queued backlog item now says why it is still queued.** The row looked
  identical whether the backlog was waiting exactly as designed or was stuck on
  something only the daemon could see: auto-fire switched off, no session open
  for the repo, the session it was queued for gone, another item holding that
  session, the agent mid-turn, the agent parked on a question. From the phone
  those six are indistinguishable, which made "is this thing working?" a trip to
  the desktop — the same gap the download queue's "why is nothing moving" line
  already closed. Each queued row carries the reason now, computed by the host
  from the very ladder that decides whether to fire (and the per-session half is
  the function `readyForAutoFire` itself delegates to, so the explanation cannot
  drift from the behaviour). It is deliberately live-only: the offline snapshot
  does not carry it, because "the session is working" read from a cache
  describes a session that may have ended an hour ago. The reason also keeps
  itself current — it describes a session, and a session moves without the
  backlog moving — and where one tap fixes it (no session open for the repo, or
  only a session you opened by hand, which auto-fire will never type into) the
  line IS that tap.

- **"Hold until idle" waits for a session that can actually run the prompt.** It
  waited for the turn to end and nothing else, so a session parked on a question,
  showing a dialog it could not parse, or blocked on a usage limit counted as
  idle — and the parked text was typed INTO the dialog, where it neither ran nor
  answered. On sessions that report turn boundaries the hold happened to hold;
  on the ones that do not, "no output" is the guess used for "not working", and a
  session waiting for an answer is perfectly silent — so exactly the sessions
  with no hook pipe were the ones this hit. The park now clears on the same three
  facts the backlog has always gated auto-fire on, which is the point: "queue for
  this session" and "hold until idle" are one intent said two ways.

- **Your settings follow you, instead of following one browser.** Prompt
  templates, fan-out presets, header commands, the prompt pad, the toolbar
  layout and the new-session defaults all lived in localStorage, so they existed
  on exactly one device: written on the phone, absent on the desktop, and gone
  entirely if the PWA was reinstalled — while a host that already persists the
  backlog, the ack ledger and the audit log sat on the other end of the socket.
  They are kept there now and reconciled on every connect (which is also what
  pushes edits made while the tunnel was down — there is no separate queue). The
  host stores opaque strings and never parses them, so a UI change does not need
  a daemon upgrade; conflicts are last-write-wins on the writing client's
  timestamp, with the loser told the winning value rather than left holding a
  version nobody else has. Only an allow-list of keys travels: the send queue,
  the paired host address and everything describing this device's link stay
  local, because a second device replaying another device's queue is a prompt
  typed twice. Settings → "Synced with the host" says what is covered and can
  force this device's copy onto the others.

- **A delivered prompt is no longer reported as lost because the screen was
  slow.** Typing into a session checks that the text echoed in the composer, and
  that check looked exactly once, 500 ms after writing. A session that is WORKING
  redraws its composer on the TUI's own schedule, so the text was frequently
  there and simply not painted yet — and the verdict for "written but never
  seen" is `unconfirmed`, the one result that is deliberately never retried. The
  prompt sat in the composer of a healthy session while the queue showed "not
  delivered · typed, but never appeared on screen". The check now re-reads the
  screen for up to 4 s; looking again is free, it is retyping that stacks copies,
  and nothing about the at-most-once guarantee changes. Alongside it, a backlog
  item can no longer be marked done DURING its own delivery: it flips to
  `running` before the text is typed, and the silence fallback read the quiet of
  a session waiting to be typed into as a finished turn.

- **The queued-messages rows are readable on a phone again.** Seven icon buttons
  claimed the whole width of a 360 px screen, leaving the message itself a column
  about one word wide — so a queued prompt rendered as a vertical stack of single
  words, exactly when reading it is the point (deciding whether it is still worth
  sending). The row wraps now: the text keeps a floor of 240 px and the buttons
  drop onto their own line below it.

- **Auto-download survives a bad link, and says what it is doing.** A queued
  APK sat at "Tiptoi · 24.0 MB" with a retry button that did nothing, and the
  row could not say whether it had 0 or 18 of those megabytes. Both halves are
  fixed. A `fetch` against a dead Tailscale path does not error, it HANGS, and a
  hung fetch pinned the one active-download slot — so the queue stopped and every
  retry tap returned immediately without starting anything. There are now two
  fuses (no response headers, then no bytes mid-stream, both re-armed per chunk)
  plus a watchdog for the case the fuses were frozen with the page by the phone
  backgrounding the app; a record left `downloading` by a killed page is revived
  on boot instead of spinning forever; `navigator.onLine` gates only the
  automatic path, because it stays true the whole time a tunnel is dead, so a tap
  always gets a real attempt; and the queue is re-tried on a timer, on wake, and
  when the socket comes back. An attempt that moved bytes resets the attempt
  count, so a link handing over 40 KB per try is never given up on — only one
  that delivers nothing, or an HTTP verdict that will not change (403/404/410).
  Pause is its own state (it used to be re-queued and restarted instantly), and a
  download aged out after a week stays `done` with its bytes cleared rather than
  quietly re-downloading itself. On the host, `if-range` is honoured: a resume
  against a REBUILT file at the same path now gets the whole body back instead of
  a 206 the client would append to the old prefix, which produced a corrupt
  artifact that looked complete. Every row carries a status sentence —
  `12.3 of 24.0 MB · 41% · 380 KB/s · 31s left`, `retrying in 12s · resumes at
  12.3 MB`, `paused · 12.3 MB kept`, `stopped at 63% · tap to retry` — with a bar
  that only animates while bytes actually move, a `resume all` button, and a line
  saying in words why nothing is downloading when nothing is.

- **Questions can be answered with no connection, and the answer sends itself
  when there is one.** A session parking on a choice was the one thing the
  offline queue did not cover: the question reached the phone in whatever
  seconds of tunnel there were, and then every route to answering it was gone —
  the approve bar's buttons wrote straight to the socket, so a tap on a dead
  link went into an in-memory queue and died at the next reload, leaving the bar
  on screen, still tappable, still doing nothing, and the session blocked. Taps
  now go through the same durable send queue as everything else, and a new
  **Questions** sheet (the "N waiting" chip on the launcher, which is a button
  now) lists every pending question across sessions and answers them from the
  snapshot, offline, with the age of what you are reading stated out loud.
  What makes a late answer safe is that it names the question it answers: an
  answer is a KEYSTROKE, and "2" means the option you read only while that exact
  box is up — four minutes later it answers something else, or drops a stray
  digit into the composer that the next Return submits. Each queued answer
  therefore carries a fingerprint of the question, and the host refuses to type
  it once that box is gone (`input.ack` state `stale`, naming the question so
  the refusal is actionable) instead of aiming the keystroke at whatever
  replaced it. Because the refusal is exact, an answer is deliberately NOT
  bounded by the queue's 30-minute TTL — a question answered in a tunnel with
  the link back an hour later is the case this exists for, and the session is
  still sitting on it. Answers also jump their lane: prose queued behind one
  would otherwise be typed into the open dialog rather than run.

- **A log of every command the app typed into a session, and a link into the
  session to check it.** Automation drives a session through the same PTY a
  person does — a backlog item firing, a fan-out target, an oracle auto-answer,
  a usage-limit `continue` — so all of it lands in the scrollback looking exactly
  like something you wrote, and afterwards there was nothing to consult but the
  scrollback itself, which is the evidence under suspicion. Settings-free: the
  launcher's `sent` button lists everything, the `sent` toolbar item narrows it
  to the session you are in. Each row names the source, whether the app or you
  decided it, the exact text, and how the delivery ENDED — `unsubmitted` (the
  text is sitting in the composer, un-run) stays distinct from `ok`, because a
  log that called both "sent" would state the one thing that is untrue. Tapping
  a row opens the session, so the claim can be checked rather than believed.
  One entry per command, not per PTY write (a delivery types the text and the
  Return separately and re-presses Return up to five times); persisted to
  `<root>/.usmc/sent.json`, so it still answers the question after the restart
  that made you ask it.

- **The gallery says what is already on the phone, and the download queue says
  when a file was made.** An outbox tile looked identical whether its bytes were
  still on the host, in flight, or long since downloaded — so the way to find out
  was to tap "to phone" again and spend the 90 MB a second time. Each tile now
  carries an auto-download badge next to the read mark, deliberately in a
  different vocabulary (a phone icon for "on this phone", a spinner and percent
  while it arrives, "queued"/"stalled" otherwise) because "did I read this" and
  "do I have this" are different questions and the eye mark answering both is how
  the double download happened. The viewer's "to phone" button follows the same
  state: already downloaded turns into "on phone · save", in-flight is disabled
  with its percent, a stalled one offers a retry. In the Auto-download sheet each
  queued file now shows when it was produced (with the exact timestamp on hold),
  which is the only way to tell this build's APK from this morning's when both
  carry the same name.

- **An annotated image no longer dies with the page.** Marking up a screenshot,
  typing a prompt and tapping "send & run" used to start a plain HTTP upload
  from the tab's memory — and the bytes existed nowhere else, because the marked
  copy had just been drawn on a canvas. A tunnel blip in that window is exactly
  what makes the reconnect watchdog reload the page, so the prompt came back
  (drafts are persisted per keystroke) pointing at an image that had never
  reached the host, and the annotation had to be redone from scratch. Every
  attached file now goes into the send queue first — bytes to IndexedDB, intent
  to the outbox, the path it will land at handed back immediately — and the
  upload is retried from there across a reload, a killed tab or a dead link,
  with the prompt naming it queued behind it. Same rule for picked files and the
  gallery/backlog annotate flow. On top of that, the last-resort reload is now
  vetoed while the annotator is open: everything else the app holds survives a
  reload, and markup in progress does not.

- **Prompts no longer disappear between "sent" and the composer.** The submitting
  Return used to be the client's job: the host wrote the text, answered "ok", the
  phone dropped the message from its queue, and 50 ms later fired the Return as a
  separate, unacknowledged message. Everything about that gap is hostile on a
  phone — an undeliverable send is parked in memory, and the reconnect watchdog
  *reloads the page*, which is exactly when the tunnel is flapping — so a link
  that died in it left the prompt sitting typed-but-unsent in the session with
  nothing left to retry and the app saying "sent". The Return now happens on the
  host, which can see whether it worked: the same delivery path the backlog and
  fan-out use types the prompt, checks it echoed on screen, presses Return and
  re-presses until the turn provably starts. A receipt now means *the prompt is
  running*. When it can't be confirmed the app says which of the two it was —
  "in the composer, Return didn't take" (open the session and press Return) or
  "typed but never appeared on screen" (check before re-sending) — and the text
  stays in the recovery bar either way. Typing at a session that is already
  working still goes straight in; it does not wait for the agent to finish.

- **The send queue stops giving up on a slow link.** A receipt deadline that
  passes now widens the next one, and an op's deadline is sized from the measured
  round trip instead of a fixed 20 seconds — eight missed windows used to go by
  in under a minute on a relayed Tailscale path and permanently fail a message
  the host had already delivered. A socket that drops mid-send puts its messages
  back immediately rather than holding the session's queue for the full window.
  And the queue's size limit no longer silently drops the oldest message: settled
  entries go first, and anything that has to be pushed out lands in the recovery
  bar with a reason.

- **New: Settings → Tools → connection health.** The speed test says how fast the
  link is now; this says what it has been doing to your prompts. Round trip,
  time spent with no connection, forced reloads, how long messages actually wait
  before they run, and — from the host — socket close codes, receipts the tunnel
  ate, and the outcome of every delivery it attempted. It opens with a one-line
  verdict, because "prompts go missing sometimes" has four different causes and
  the numbers underneath are what tell them apart. Everything is local: the
  device half in the browser, the host half in `.usmc/netstats.json`.

- **Auto-download keeps only the newest version of an artifact.** An APK named
  with its build hash is a new path every rebuild, so an afternoon of builds
  queued five 23 MB files that were all the same thing — and the phone, which
  downloads one at a time, spent 115 MB of a roaming link to reach the one it
  actually wanted, sitting last in the queue. Every queued item now carries a
  `family` (directory + extension + the name with the variable tokens — hashes,
  build numbers, timestamps, `v2`-style versions — folded out), and a new file
  drops the older queue entries that share it, cancelling a download already in
  flight for them: those bytes are a build that has been replaced. Only strictly
  older entries go, so two files written in the same second both survive; only
  the variable tokens are folded out, so `app-release.apk` never eats
  `app-debug.apk`; and a file already downloaded to the phone is never touched.
  Off per repo with `newest only: off` in Auto-download → Rules.

- **The Android app updates its own UI — no more pushing APKs for web changes.**
  Carrying the UI inside the APK is what makes it survive a dead tunnel, but on
  its own it also froze the UI at APK build time, which is the wrong half of that
  trade: the shell is what must be local, not the *version* of it. The daemon now
  publishes what it is serving (`/api/webbundle`: a build id plus per-file size
  and sha256, from the same directory it already serves at `/`), and the app
  checks on launch and every 30 minutes, downloads, verifies every file and hands
  the result to a small native plugin that points Capacitor's WebView at it. A
  new APK is only needed when `packages/app` itself changes — the Java, the
  manifest, the icons.

  **The build id is a content hash, not a timestamp.** `npm run restart` rebuilds
  constantly, and an id that moved on every build would have the phone
  re-downloading ~1 MB over a roaming link to arrive at a byte-identical bundle.
  Identical sources now produce an identical id and no download at all. It ships
  as `build-id.txt` INSIDE the bundle, so "which build am I running?" is answered
  by reading a file out of whatever bundle is being served — APK or download —
  rather than by bookkeeping that can drift.

  **A downloaded bundle cannot brick the app.** Every file is sha256-checked and
  a mismatch aborts the whole update (a bundle mixed from two builds is worse
  than no update); a finished download is *staged* for the next launch rather
  than applied under a live session; and every launch increments a counter that
  the web app zeroes only once it has actually rendered — three launches that
  never get there and the native side falls back to the bundle inside the APK,
  which is never deleted and needs no network. Settings → App version has the
  same revert as a button. Installing a new APK also wins by itself: Capacitor
  drops the stored path when the binary version changes, so a sideloaded build is
  never shadowed by an older download. The origin is `http://localhost` either
  way, so the send queue, drafts, the paired host and cached transcripts all
  survive an update. The sha256s are protection against a truncated transfer, not
  against a hostile host — the daemon already runs `claude` on your machine, and
  the bundle only ever comes from the host you paired with.

- **An Android APK, so a dead tunnel can no longer take the whole app away.**
  The PWA is served by the daemon, which means the *application itself* is on
  the far side of the tunnel: a reload, the reconnect watchdog, or Chrome
  restoring a discarded tab re-fetches `index.html` from a host that isn't
  answering, and the entire app is replaced by the browser's
  `ERR_CONNECTION_TIMED_OUT` page — send queue, drafts, prompt pad and cached
  transcripts all still sitting in localStorage, all unreachable, because the
  code that reads them is gone. Over plain `http://100.x` there isn't even a
  service worker to cache a shell against it. `packages/app` is a Capacitor
  wrapper that ships the *existing* web bundle inside an APK, so the shell is a
  local asset: there is no navigation left that can fail, `http://localhost` is
  a secure context whether or not `tailscale serve` was ever run, and a cold
  start with the network fully off lands in the working app. Verified on an
  emulator against the live daemon — paired, connected (15 live sessions over
  the WebSocket), then force-stopped and cold-started in airplane mode into the
  full UI, then reconnected on its own when the network came back
  (`.claude/outbox/android-apk/`).

  **Capacitor, explicitly not Ionic Framework** — they are different products
  and the difference decides everything: Ionic Framework is a UI component
  library, so adopting it would mean rewriting ~30 sheets, the xterm.js terminal
  host, the gallery and the annotator (a reimplementation by another name),
  while Capacitor is the native runtime from the same team and ships
  `packages/web/dist` verbatim, with zero UI changes. A Bubblewrap/TWA wrap was
  rejected because a TWA *is* Chrome — same secure-context rules, same
  navigation, so the shell still arrives over the tunnel and nothing is fixed.

  In the shell the page origin is the APK's own asset server, so `/api` and
  `/ws` are re-aimed at the paired host: the rules are pure functions in
  `shared/hosturl.ts` (pinned by `e2e-hosturl.mjs`) and the client patches
  `fetch`/`XHR`/`sendBeacon` once at boot rather than editing ~60 call sites, so
  a `fetch("/api/…")` written next month is correct in the APK the day it is
  written. **Only** `/api` and `/ws` are ever re-aimed — the shell's own assets
  stay local by construction, since serving them off the host is the exact
  failure the APK removes. **No host-side change:** the shell's
  `http://localhost` origin already passed the same-origin guard, which was not
  widened. In the browser every one of these functions is a no-op and the PWA
  behaves precisely as before. Known limits (LAN password gate, Web Push,
  background downloads) are listed in `packages/app/README.md`.

- **A queued "open a session" now carries the work it was queued for.** Tapping
  a repo with the tunnel down queued a bare `session.create` — an empty terminal
  scheduled for later, with no way to say what should run in it and no way to
  add one afterwards (the queue sheet refused to edit an action). The offline
  tap now opens the start sheet instead, which takes a CHAIN of prompts: the
  first rides inside the create op (typed host-side by `deliverToNewSession`),
  and each further one waits in the same `create:<cwd>` lane until `op.ack`
  names the session, then is delivered only after the previous turn has ended —
  so "read the failing test" → "fix it" → "commit" written on a train arrives as
  three turns, not one glued composer line. A queued create can also be tapped
  to write/rewrite its first prompt, and `+` appends more. If the create is
  discarded, refused or ages out, the prompts behind it fail with a reason
  (text kept, re-aimable) instead of parking their lane on a session that will
  never exist. No wire change — `PROTOCOL_VERSION` stays 1.

- **Queued work no longer gives up because the tunnel was down.** Every delivery
  attempt arms a receipt window; when it expired the entry went back in the
  queue with the attempt COUNTED, so eight six-second windows — under a minute
  of a bad link — burned the whole give-up budget and left "open a session here"
  permanently `not delivered · delivery kept failing · 8 attempts`. An attempt
  is now rolled back when the socket wasn't open (nothing reached a host that
  could answer it), durable ACTIONS get a 20 s window instead of a keystroke's
  6 s (the host answers on accept, so it is pure round-trip budget and a DERP
  relay eats more than 6 s), and a `failed` entry can be retried by hand from
  the queue sheet — same ackId, so the host's ledger still guarantees it runs at
  most once. Before, a failed action could only be deleted: an action has no
  text to restore into a compose box.

- **Text typed in a sheet survives the page dying.** The compose bar persisted
  every keystroke per session, but the two places you write text BEFORE a
  session exists — the prompt pad's editor and "start a session with this
  prompt" — kept theirs in React state only. Those are exactly the screens used
  with no tunnel, on a phone that kills backgrounded tabs and reloads itself
  when a reconnect goes nowhere, so a paragraph was lost with nothing to
  restore. Both now write through to `usmc.compose.sheets` on every keystroke;
  an interrupted pad note reopens its editor with the text still in it.

- **The plain-HTTP door no longer strands you on the browser's error page.**
  Symptom: the app is replaced by `ERR_CONNECTION_TIMED_OUT` and there is no way
  back. Cause: `http://100.x:8770` is not a secure context, so there is no
  service worker, so there is no cached app shell — any navigation while the
  tunnel is down (a reload, or Chrome discarding and restoring the tab) has
  nothing to fall back on. Three fixes: the same-origin guard now trusts our OWN
  discovered `tailscale serve` front door on whatever port it landed on
  (`--https=443` claims one slot per machine, so a busy host gets fronted
  elsewhere — and the guard refusing it made the app advertise an HTTPS address
  it then 403'd, which is exactly how you end up staying on plain HTTP); the
  "switch to HTTPS" banner now snoozes for a week instead of being dismissible
  forever; and `ws.ts`'s last-resort reload probes `/api/health` twice when no
  service worker controls the page, so a link that answered once but died in the
  next 200 ms can't navigate the app into oblivion.

- **The inbox takes every kind of file, not just images.** The whole upload path
  was image-shaped: the phone's picker said `accept="image/*"`, every attach flow
  ran the file through the annotator, and the host's serve gate only handed back
  a short list of extensions — so a PDF, a spreadsheet, a zip or a voice memo
  either couldn't be picked at all or could be written into `.claude/inbox` and
  then never fetched back. Now: a **paperclip button** next to the camera in the
  compose bar (and in the backlog add sheet, the start-a-session sheet, and the
  toolbar as `file`) opens an any-type picker whose files skip the annotator (a
  PDF has nothing to draw on) and go straight up, with their paths in the prompt;
  the host serves them back with a real content-type (office formats, audio,
  archives, fonts, source files), and the gallery viewer PLAYS audio and shows a
  PDF inline instead of offering a dead "Open …" link. Two details that were
  quietly broken: an umlaut in a document name **threw at `setRequestHeader`**
  (an HTTP header is Latin-1) and killed the upload before it started — the name
  is percent-encoded now and decoded host-side; and the upload ceiling moved to
  64 MB, since a scanned PDF clears 32 MB routinely. Serving widened, **discovery
  did not**: `DISCOVERABLE` (what the gallery walks the tree for) stays
  deliverables-only, because putting source and config extensions in it floods
  the "this repo" tab and the per-turn new-file notifications with every
  `src/*.ts` in the repo — while the curated outbox scope lists whatever an agent
  drops there. `.env` files stay refused on every transport route.
  (`host/files.ts`, `host/api.ts`, `web/App.tsx`, `web/Gallery.tsx`,
  `web/StartSheet.tsx`, `web/Backlog.tsx`, `e2e-docs.mjs`.)

- **Auto-download: repos push files to the phone, resumably.** The inbox worked
  in one direction — the phone could send images into a repo, but a 90 MB APK
  coming back was a manual tap that restarted from zero every time the tunnel
  blinked. A repo can now carry a rule (`<repoDir>/.usmc/autopull.json`: scope,
  glob-ish patterns, a size cap, build outputs on/off) saying what is worth
  fetching, and the host queues every match to a persisted, host-wide queue
  (`<root>/.usmc/pulls.json`) — persisted because the file almost always lands
  while nothing is connected, and a restart that emptied the queue would drop
  exactly the pull you were waiting for. The phone downloads it two ways:
  **Background Fetch** where it exists (Android Chrome, installed PWA), which
  keeps running with the app CLOSED and is started from the push handler, so an
  overnight build is simply already there; and a **resumable Range loop**
  everywhere else (iOS included), which persists the accumulated bytes plus the
  offset to IndexedDB as it goes and resumes with `Range: bytes=<n>-` after a
  dead spot, a reload, or the OS killing the tab. The gallery grew a "to phone"
  button for the manual case. Settings → Data usage → auto-download, or the
  download strip next to the send-queue bars. (`host/autopull.ts`,
  `web/pull.ts`, `web/PullSheet.tsx`, `public/sw.js`, `e2e-autopull.mjs`.)

- **Big artifacts stream instead of being buffered.** The artifact endpoint read
  the WHOLE file into a Buffer, so a 300 MB APK was 300 MB of host RAM per
  request — and worse, every resumed range re-read all of it to hand back the
  last few MB. Anything over 2 MB is now piped off disk with real range support
  (`accept-ranges`, 206 with a correct `content-range`, and **416** for an
  unsatisfiable range — a 200 there would make a resuming client append a full
  copy to what it already had and call the result complete). Small text
  artifacts keep the buffered path so they still get br/gzip.

- **Start a session with its first prompt — and queue the whole thing offline.**
  Tapping a repo with no tunnel queued a `session.create` and nothing else: a
  prompt for that session could not be queued at all, because there is no
  session id to address until the create lands. The prompt now travels INSIDE
  the create (`session.create.prompt`), so "open a session in this repo and do
  this" is one durable op — de-duped by the same persisted ackId ledger, and
  typed by the same at-most-once `deliverPrompt()` path the fan-out uses (a
  retry can never produce two sessions or two copies of the instruction). The
  new sheet is the repo row's notebook button, and the prompt pad grew a fourth
  target for it (`web/StartSheet.tsx`, `host/deliver.ts` `deliverToNewSession`).

- **Images queue offline too.** The compose box survived a dead tunnel; the
  picture attached to it did not — `api.uploadInbox` is a plain POST, so an
  image picked while offline died at the fetch and the prompt naming it pointed
  at a file that never arrived. Uploads are now a queue mode of their own: the
  bytes go to IndexedDB (a photo is megabytes, and localStorage is where the
  send queue itself lives), the entry sits in the SAME lane as the prompt that
  references it, and the flusher does the POST when the link is back — so the
  file is in `.claude/inbox` before the agent is told to look at it. The path is
  minted client-side so the prompt can name it immediately; if the host renames
  the file anyway, every queued message that mentioned the prediction is
  rewritten to follow it. A re-sent upload carries `x-dedupe`, so a tunnel that
  dropped mid-POST can't leave two copies of the same screenshot.

- **Auto-send is a button on the queue bar.** "Will send when the connection is
  back" still needed a tap on *Send now*, because the two switches that decide
  it (auto-send, ask-on-reconnect) were three screens away in Settings. The bar
  now carries an `auto on/off` toggle that drives both, so queued work really
  does go out the moment the link returns. Same state as the Settings pair, not
  a third setting.

- **Inbox/outbox paths in the conversation are the file now.** A prompt or an
  agent reply that names `.claude/inbox/1000073847.png` used to be dead text in
  the reader view — the file was one tap away in the gallery, but you had to go
  find it. Those paths (`.claude/inbox/`, `.claude/outbox/`, a top-level
  `.outbox/`, bare, in backticks, or as a markdown link target) now render as
  the file itself: a server-made thumbnail for an image, a chip for anything
  else, tapping through to the full-screen viewer (annotate / ref path from
  there) or a tab for a document. Matching is narrow on purpose — only paths
  containing a transport dir, so an ordinary source path in a diff stays text.
  The gallery's document preview gets the same treatment, so an outbox report
  that points at the screenshots next to it shows them inline
  (`web/fileRefs.ts`, `Markdown.tsx` `FileRefCtx`).

- **Uploads report bytes, and shrink themselves on a slow link.** The compose
  bar blocks on image uploads ("Send waits for uploads") and all it showed was a
  spinner and a file count — indistinguishable from a hang while a 4 MB phone
  screenshot crawled up a roaming uplink. Uploads now go through XHR for
  `upload.onprogress`, so the strip shows percent, bytes, rate and an ETA over a
  determinate bar. And before the bytes go out, the image is re-encoded to a
  width picked from the link: an EWMA of the *measured* upload rate when there
  is one (the only number that reflects the real Tailscale path, DERP relay and
  all), else `navigator.connection`. A picker sits right above the annotator's
  send buttons — and in Settings → Data usage — because auto can't know the
  content: a 4K UI screenshot with 10px text needs full size, a photo never
  does. Per device, sticky (`web/uploadScale.ts`).

- **The offline queue is now per-session, manageable, and asks before it
  fires.** Three fixes to the same feature:
  - *One message per session at a time.* The reconnect flush wrote every queued
    entry to the socket at once. For two messages typed for the SAME session
    while offline that is a corruption: the PTY composer concatenates the writes
    into one line ("fix the testsadd a changelog") and the Returns that follow
    submit the mush plus a stray blank. Delivery is now serialized per session
    (`shared/queue.ts` `selectSendable`) — the next entry is released only once
    the previous one is acked and its Return has gone out. Different sessions
    still drain concurrently, and a stale head no longer holds its lane hostage.
  - *"Queue for this session" survives being offline.* The compose bar's queue
    modes wrote `backlog.add` straight to the socket, which the ws layer drops
    when it can't connect — the one send path that skipped the durable outbox,
    so a work item queued on a dead tunnel was simply gone. Those items now go
    through the same store and the same receipts; `backlog.add` takes an `ackId`
    and the host de-dupes it (`backlog.ack`), so a reconnect re-send can't add
    the item twice.
  - *A reconnect asks before it sends.* Text typed offline was written against
    what the session looked like then — by the time the link is back the agent
    may have finished, asked something else, or moved on. "Back online — send N
    messages you queued while offline?" offers Send / Review / Hold. A message
    sent with the link UP is never held by this, and the prompt can be turned
    off (Settings → Install & offline → "ask on reconnect").

  New **Queued messages** sheet ("Manage" on the queue bar, also in Settings):
  the whole queue grouped by session in delivery order, each entry editable,
  reorderable within its session, sendable on its own, restorable into the
  compose box, or discardable. The queue bar now renders on the launcher too —
  a queue built while offline is global, so "did that go?" shouldn't require
  finding the right session first.

- **The HTTPS front door is discovered, not assumed to be 443.** `tailscale
  serve --https=443` claims one slot on the whole machine, and a host may
  already serve something else there. The doctor's secure-context check and the
  phone's Connection shortcut both hardcoded `https://<tailscale name>` — which,
  on such a host, opens a different app entirely. Both now use
  `net.ts serveHttpsUrl()`, which parses `tailscale serve status --json` and
  matches on the **proxy target**, returning that listener's URL with its real
  port (`welcome.httpsUrl`). The old check matched a substring of the status
  text, which the proxy target itself contains — so any serve config at all read
  as "we are fronted".

- **Offline command queuing, with automatic submission.** Send a prompt while
  the tunnel is down and it is kept — in localStorage, so a reload or the phone
  killing the tab doesn't lose it — then delivered and *submitted* by itself the
  moment the host is reachable again. The compose bar shows "N queued — will
  send when the connection is back", with "Send now" and "Manage" escapes, and a
  toast confirms the flush. Auto-send is a switch (Settings → Install & offline)
  for when you'd rather review before it fires.

  Two invariants made this safe rather than a duplicate-prompt generator:
  - *The host de-duplicates delivery receipts.* `session.input` keeps a bounded,
    expiring ledger of ackIds; a re-send of one it already handled is re-ACKed
    with the original verdict and NOT typed again. Retrying without this would
    have re-run the prompt — the client-side twin of the at-most-once rule
    `deliver.ts` enforces for the backlog.
  - *The submitting Return waits for the receipt.* It used to fire 50 ms after
    the text and hope; if the socket died in between, the prompt sat unsent in
    the composer while the UI said "sent". It is now written only once the host
    confirms the text landed, exactly once per message.

  The outbox is now the single send path — nothing reaches the socket that isn't
  in it — so there is exactly one thing to retry. A message the previous tab left
  in flight is re-queued on load instead of being surfaced as "not delivered".
  Verified by `scripts/e2e-queue.mjs`, which drives the whole offline → reconnect
  → deliver → submit path against a real PTY.

- **Install as an app.** Settings → Install & offline captures the browser's
  install offer and gives it a button, instead of leaving it to Chrome's
  easily-missed mini-infobar. iOS gets the Share → Add to Home Screen wording
  (Safari fires no install event). Over plain HTTP it explains that a service
  worker — hence installing and the offline shell — needs a secure context, and
  points at the `tailscale serve` fix.

- **Bandwidth: the phone now moves a fraction of the bytes.** Four independent
  cuts, aimed at a roaming/hotel link:
  - *Image thumbnails.* The gallery grid, the new-image strip and the backlog
    attachment row pointed an `<img>` at the ORIGINAL artifact. Across this
    machine's outbox dirs that is 1170 images averaging 607 KB (worst case
    14 MB), so one scroll of a 300-row grid was well over 100 MB. `?thumb=<w>`
    on the artifact/inbox routes now returns a screen-sized JPEG — a real
    3.25 MB screenshot is 18 KB at 320 px and 63 KB at 640 px. No image library
    was added: it shells out to `sips` (macOS, built in), ImageMagick or ffmpeg,
    caches by path+mtime+size+width under `<root>/.usmc/thumbs`, and falls back
    to serving the original whenever it can't produce one. `download=1` and the
    annotator always get the real file, and the full-screen viewers load a
    screen-width copy with an explicit "full res" tap.
  - *WebSocket compression.* permessage-deflate on `/ws`. The PTY stream is the
    largest continuous byte source in the app — tens of KB of repetitive ANSI
    per TUI repaint, inflated another ~33% by the base64 framing — and the
    deflate window carries across frames, so a repeat repaint costs almost
    nothing. Browsers offer the extension by default; no client change.
  - *HTTP compression + caching.* br/gzip on JSON and the app bundle (722 KB →
    ~165 KB brotli), ETag/304 on artifacts and the shell, `immutable` on
    versioned thumbnails and Vite's content-hashed assets. A revisited gallery
    now costs nothing instead of re-downloading images the phone already had.
  - *Pagination.* The gallery asked for 300 rows at once; it now pages 60 at a
    time with a "load more" button.
  Disable any of it with `USMC_THUMBS=0` / `USMC_COMPRESS=0` /
  `USMC_WS_COMPRESS=0`. Verified by `scripts/e2e-thumbs.mjs`.

- **Data saver (Settings → Data usage).** A per-device toggle that asks the host
  for smaller image copies and multiplies the reader view's background poll
  interval by 4. "Full res" stays one tap away everywhere.

- **Outbox files say whether you already looked at them.** The gallery grid
  badges every artifact `new` / opened (eye) / downloaded (arrow): a per-device
  mark in localStorage (`usmc.artMarks`, same shape as the reader view's unread
  watermark — no host round trip, no wire change), set when a file is rendered
  in the viewer and upgraded when the download button is tapped. Marks are
  validated against the file's mtime, so an agent that regenerates `report.md`
  in place makes it `new` again. The `new` badge only shows in the outbox tab —
  the repo/all-repos tabs list arbitrary existing files, where "never opened in
  USMC" is the boring default; there only a positive opened/downloaded mark
  shows.

- **The mark-&-send sheet closes on the tap, not after the encode.** "Send to
  repo" / "Send & run" used to sit on `Sending…` while `canvas.toBlob` encoded a
  phone-sized screenshot to PNG — seconds of a blocked screen before the sheet
  handed off to the (already backgrounded) upload. The annotator now derives the
  file name/note synchronously and passes the still-encoding blob as a promise,
  which the upload buffer awaits inside its slot, so the sheet closes (or
  advances to the next image in a batch) immediately and the compose box is
  typeable while the image uploads. `canvas.toBlob` snapshots the bitmap at call
  time, so the encode is unaffected by the sheet going away.

- **Build buttons wired up for the repos that actually ship something.** The
  Garmin monorepo gets beta ship (all nine beta apps, plus one-tap per app for
  the three that also have store listings), PROD ship per app for those three,
  and build-only/compile-check buttons; a new `ship-prod.sh` in that repo is the
  non-interactive prod counterpart of its existing `ship-betas.sh`, and it
  refuses to start when the app's declared `LATEST_WATCH_VERSION` doesn't match
  the version the run would build — the store submit would have rejected it
  anyway, but only after bumping the version. Android/Flutter/Ionic repos get
  APK buttons; a release button is only wired where the artifact is actually
  signed. Connect IQ `.iq`/`.prg` packages are now recognised as build
  deliverables, so a Garmin build's output is downloadable from the phone.

- **Fixed: a successful build could report no artifact at all.** The
  post-build scan `stat`ed every entry it walked against a flat 40k budget, so
  in a repo with a large data tree (47k entries, 41k of them under one asset
  dir) whether the APK was found came down to directory read order. The walk now
  reads dirents and only `stat`s candidate files, visits output-looking dirs
  first, and has a much higher bound — and it no longer follows symlinks, which
  could previously send it round a cycle until the budget ran out.

- **Fan-out: run one prompt in several repos at once.** "Repos & worktrees →
  fan out" takes a prompt or slash command, a set of repos, and starts a FRESH
  `claude` session in each — the maintenance sweep (`/init` everywhere, "what did
  this project cost this month?") that used to be one repo tap and one retyping
  per project. Delivery reuses the backlog's echo-confirmed, at-most-once path,
  each target reports starting / running / done / failed, and tapping a target
  opens its session like any other. Repos are started a few at a time
  (`USMC_FANOUT_CONCURRENCY`, default 6) so a big sweep can't stampede the host.
  A run stays drivable afterwards: "follow up in N sessions" types a second
  instruction ("now commit that") into the sessions it already spawned — all of
  them or a ticked subset — with the same at-most-once delivery. It never spawns
  anything, so a target whose session you closed is reported rather than quietly
  restarted from scratch.

- **Fixed: a fanned-out prompt could land in every session without ever being
  run.** Delivery pressed Return once and treated "the terminal produced more
  output" as proof it had been submitted — but the CLI repaints constantly, so
  that test passes whether or not the keystroke landed. A 12-repo sweep came back
  with every repo marked *running* while every session sat holding an un-run
  prompt. Sessions that report turn boundaries (the normal case) now prove the
  turn actually started before delivery is called done, re-pressing Return until
  it does; if it never takes, the target says the prompt is sitting in the
  composer waiting for a Return instead of claiming work is under way. Retyping
  is still never attempted — that's what used to send the same prompt ten times.

- **Fixed: a fan-out could skip repos entirely.** Readiness waited for the
  terminal to fall silent for over a second, which a booting `claude` on a
  machine starting six of them at once may never do — those repos timed out
  un-fed. It now uses the same exact "no turn in flight" signal the backlog uses,
  and waits longer before giving up.

- **Documents in the gallery now render, and download.** Opening a `.md` or text
  artifact used to show a single "Open …" link — on a phone that meant a browser
  tab or a save-as dialog, for a file the agent wrote to be read. Markdown is now
  formatted in place (with a source toggle), other text shows as monospace
  source, and every open file has a download button.

- **Fixed: a backlog item could be typed into a session over and over.** The
  check that confirmed an instruction had echoed in the composer ANSI-stripped a
  fixed byte window off the tail of the terminal capture, but a single claude-TUI
  repaint is tens of kilobytes — so text plainly visible on screen read as "not
  echoed" and got retyped on top of itself, three times per attempt and once per
  retry, up to ~15 copies of the same prompt. Delivery now reads the rendered
  screen (the capture replayed through a headless terminal) and writes the
  instruction at most once: if it can't be confirmed, the item is flagged for you
  to check instead of being re-sent automatically.

- **Fixed: phantom approve bars, and garbled one-tap option labels.** Prompt
  detection scanned an ANSI-stripped byte window, so repaint fragments were
  surfaced verbatim as option labels ("My recommendation(B") and a numbered list
  in Claude's own prose ("1. Now: … 2. Then: …") flickered an approve bar in and
  out mid-answer. A candidate is now re-checked against the rendered screen
  before anything is published, and a real choice box must carry a selection
  cursor or the "Enter to confirm · Esc to cancel" footer.

- **New project scaffold** — "New → repo" now creates a project that is ready
  for phone use: `git init` on `main` with an initial commit, `.gitignore`,
  `README.md`, a `CLAUDE.md` documenting the outbox convention, and the
  `.claude/inbox` / `.claude/outbox` / `.usmc` dirs. An optional one-line
  description seeds the README/CLAUDE.md; a "set up for phone use" toggle falls
  back to the old bare `git init`.
