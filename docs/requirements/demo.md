# demo

### R-demo-001 · shipped
A demo of the app — no desktop, no Tailscale, no `claude` installed — is reachable from the first-run
screen with one tap, in the APK and in a plain browser.
- asked: 2026-10-01 (demo-mode plan, docs/analysis/demo-mode-plan.md)
- shipped: demo-mode WP5a (first-run "Try the demo" in HostSetup; a browser has no first-run screen, so there it is Settings → Connection → try the demo, or `?demo=`)

### R-demo-002 · shipped
Opening the app with `?demo=<scenario>` starts the demo straight into that named scenario.
- asked: 2026-10-01 (demo-mode plan, docs/analysis/demo-mode-plan.md)
- shipped: demo-mode WP4 + WP5a (`?demo=first-look` boots; an unknown id says so in words, `demoProblem()`)

### R-demo-003 · shipped
While the demo is on, a line on screen says so in words, so nobody mistakes it for a connected
desktop, and offers the way out to set up a real one.
- asked: 2026-10-01 (demo-mode plan, docs/analysis/demo-mode-plan.md)
- shipped: demo-mode WP5a (`DemoLine.tsx`: APK "Connect a real desktop" / "Leave the demo", host-served browser "Leave the demo", static page says to open waterplane from your own host)

### R-demo-004 · shipped
The demo makes zero network requests off the app's own origin — no push, no update check, no
background fetch, no LAN probe, no native worker.
- asked: 2026-10-01 (demo-mode plan, docs/analysis/demo-mode-plan.md)
- shipped: demo-mode WP7 (`npm run test:ui`: every request off the served origin is aborted and fails the `first-look` journey, with the service worker allowed and blocked)

### R-demo-005 · shipped
An action the demo cannot perform answers in text saying it is not available in the demo and why —
it never silently does nothing, never retries forever, and is never a greyed-out control.
- asked: 2026-10-01 (demo-mode plan, docs/analysis/demo-mode-plan.md)
- shipped: demo-mode WP2b + WP5a (tier-B verdicts reach the screen as text: build save and session fork toast the reason; build scan answers empty instead of a spinner)

### R-demo-006 · requested
A Google Play reviewer can open the APK and use it through the demo without any desktop, and the
store listing's app-access note tells them how.
- asked: 2026-10-01 (demo-mode plan, docs/analysis/demo-mode-plan.md)

### R-demo-007 · shipped
Every user journey in the docs has a gif or screenshot produced from the demo by a script, so the
docs' media is regenerated rather than hand-recorded.
- asked: 2026-10-01 (demo-mode plan, docs/analysis/demo-mode-plan.md)
- shipped: `docs/guide.md` embeds one `--media` gif per journey (`first-look`, `queue-and-schedule`, `gallery-and-files`, `numbers`, `repo-health`, `demo-tour`); `first-app` needs a real host and keeps its own gif

### R-demo-008 · shipped
One contract test suite runs against both the real host and the demo's fake host, and fails when
the two answer the same message differently.
- asked: 2026-10-01 (demo-mode plan, docs/analysis/demo-mode-plan.md)
- shipped: demo-mode WP6 (`npm run test:contract`, scripts/run-contract.mjs)

### R-demo-009 · shipped
The demo can be made to fail the way a real tunnel does — offline, a lost receipt, a socket that dies
mid-send and a watchdog reload — so tests show a prompt queued through any of them runs exactly once;
those faults can never be reached in a shipped build or scenario.
- asked: 2026-10-01 (demo-mode plan §6 "Fault journeys", docs/analysis/demo-mode-plan.md)
- shipped: demo-mode WP8b (`scripts/ui/journey-fault-*.mjs`; the page hook exists only in a VITE_DEMO_FAULTS=1 build, `assertShippable` refuses a scenario carrying rules)

### R-demo-010 · shipped
Every scenario the build ships has a journey that plays it end to end, with its screens as aria
snapshots, the zero-network check and a regenerated gif, so a scenario nobody can walk through
cannot be added.
- asked: 2026-10-02 (demo-mode plan WP8a, docs/analysis/demo-mode-plan.md)
- shipped: demo-mode WP8a (`queue-and-schedule`, `gallery-and-files`, `numbers` with `scripts/ui/journey-<id>.mjs`; `scenarios.test.mjs` pins every registry entry)

### R-demo-011 · shipped
The demo guides a person through the app's headline features: a "More to try" list, grouped, one
plain sentence per feature, each a tap into that screen of the demo. It is reachable any time from
the demo line and from the first minute's closing card (it no longer opens by itself — the first
minute is R-demo-014), and marks each feature tried (a check and the word) so progress is visible;
leaving the demo forgets it.
- asked: 2026-10-02 ("Demo mode needs more elaboration … make sure all our key features are fully sold to the user of the demo")
- shipped: `features/demoTour` (overlay `demotour`, `DemoLine`'s "More to try")

### R-demo-012 · shipped
The default demo shows every headline screen with fictional, self-consistent figures — token
ledger, usage windows, budget, context, CLI and repo health, notifications and logs — never an
empty screen that reads like a broken one.
- asked: 2026-10-02 (user, inbox screenshot of an empty Token usage screen in the demo)
- shipped: `scripts/ui/journey-demo-tour.mjs` asserts the ledger is populated

### R-demo-013 · shipped
The demo shows a session's own budget holding a deferred send before the account's usage limit,
then the session parked at the limit and continuing by itself at the reset, with the held prompt
run exactly once — the hold, the park and the resume answered the way the real desktop answers them.
- asked: 2026-10-02 (user: "limit → continue … pair it with a token budget for the session"; docs/analysis/demo-pitch-plan.md §2.7)
- shipped: scenario `limit-and-budget`, `scripts/ui/journey-limit-and-budget.mjs`, `docs/media/limit-and-budget.gif`

### R-demo-014 · shipped
The default demo opens on the main screen, the repo list, with one non-modal cue pointing at the
real control that starts a session in a repo (`+ now` on todo-garden) — nothing is opened by itself.
The session that tap starts opens on Claude Code's own header, and the demo types its first prompt
into the phone's compose box, a word at a time (2026-10-16: letter by letter filmed as 1.5 s of
near-still pictures), then sends it by itself (only into an empty box; a
person's own typing stops it) — then tool lines stream and the context meter moves with no tap. The
story the turn tells is R-demo-033's. When that loop has run, one non-modal hint points at the real
reader toggle; the finished turn shows what it cost (tokens in/out/cache, dollars at list price, and
what the next prompt costs against a fresh session); a closing card then offers the schedule, the
token ledger and repo health, and "More to try".
- asked: 2026-10-02 (docs/analysis/demo-pitch-plan.md §1 and §7, decision 1); 2026-10-07 the prompt typed into the box (user, inbox `.claude/inbox/combined-3-screens-marked-muydt9fxc40ce7.png` #3: "insert the prompt into our text input box"); 2026-10-16 start on the main screen with the cue at + New rather than auto-opening the session, the hint after the loop (user, session conversation)
- shipped: `demo/scenarios/first-look.ts` (`hookReply`, `fixReply`), `features/demoTour` `DemoStartCue` + `claimHookSession` + `typeHookPrompt` (sdk `compose.typeOn`/`compose.send`), `features/demoTour` (`DemoHook.tsx`), the reader's turn foot (`TranscriptView.tsx` `TurnCost`, `TranscriptTurn.tokens`); `scripts/ui/journey-first-look.mjs`

### R-demo-015 · shipped
Every picture in the docs — journey gifs, their stills, the animated flow diagram — is regenerated by scripts from the current code with no model in the loop, so a UI change reaches the docs by re-running one command (`npm run media`), never by hand-recording or spending tokens. Only the hand-drawn architecture SVGs are edited by hand, and a test keeps their names honest.
- asked: 2026-10-03 (user: "must be regenerateable without burning new tokens … if the UI changes should automatically get up to date if the scripts re-run")
- shipped: ca6aa30

### R-demo-016 · shipped
The first gif that shows the terminal opens on something a Claude Code user recognises at once: the CLI's own welcome header with the Claude logo, version, model and folder.
- asked: 2026-10-03 (user, inbox screenshot `.claude/inbox/1000077783-mus5yb9nd5cd28.png`)
- shipped: ff7805b

### R-demo-017 · shipped
Every screen a docs gif shows carries one plain sentence, above the app picture, saying what is
being done there.
- asked: 2026-10-03 (user: "the gifs need an explainer sentence for every shown screen that tells what is done")
- shipped: bdc168f
- amended: 2026-10-16 (user: caption band moved to the top, above the app picture and still a separate band, never over the app. People read top-down and the caption is a headline naming the beat; the bottom already carries the loop's orange progress bar and most taps.)

### R-demo-018 · shipped
The demo's token statistics and per-prompt cost are shaped on the owner's real heavy use — long
sessions dominating, cache reads dwarfing output, subagents a large share, cold-start premium,
prompts costing tens of dollars — with fictional repo names, so the insights read as worth having.
- asked: 2026-10-03 (user: "use sessions from my real use that are impressive … the cheap ones shown don't seem to be interesting enough")
- shipped: b757688

### R-demo-019 · shipped
The per-prompt cost card the reader draws under a turn is also drawn under the terminal, always for the last prompt, and can be collapsed to one line and expanded again.
- asked: 2026-10-03 (user, inbox screenshot `.claude/inbox/combined-2-screens-marked-mus60xm461af25.png`)
- shipped: 2970935, f61cced

### R-demo-020 · shipped
Wherever a list-price dollar figure is shown, a tap explains why dollars are shown to someone on a flat-fee plan: plan limits don't count token kinds the same, so a summed token count misleads and the list price is the one figure comparable across prompts, sessions and models.
- asked: 2026-10-03 (user: "explain why we show dollar values for a user that has Claude max plan")
- shipped: 1d06184, fb0626a, f28eea7

### R-demo-021 · shipped
The APK film tells one story on two phones: a screenshot of the running app is marked in the
annotator ("put the logo here") and sent to the session; the session changes the app and bumps its
version; the build runs; the other phone installs the update by itself and opens it with the logo
where it was marked. Scripted end to end, the session's `claude` a stub, so it costs no tokens.
- asked: 2026-10-03 (user: "the user uses the image annotation feature to mark something like the target position of a not yet shown Logo and then the simulator shows us the update happening automatically and the new logo showing up in the new version")
- shipped: `scripts/media/apk-install.mjs` + `STUB_MODE=logo` (`scripts/media/tide-tables.mjs`, `tools/stublogo.test.mjs`)

### R-demo-022 · shipped
Every scripted docs gif also comes as an mp4 from the same run, for places a video beats a gif; and
the gifs are as sharp as the size cap allows — filmed at device pixels, not shrunk from a blurred
recording.
- asked: 2026-10-03 (user: "Extend that so I also have videos as alternative material. Also i think gifs can have higher quality")
- shipped: `scripts/ui/encode.mjs` (CDP screencast → lossless captioned master → gif + mp4); `docs/media/<journey>.mp4`, `docs/media/apk-install.mp4`; no blank frame: a film opens on its first picture, a flat frame after it is named (`STRICT.flatFrames`) and a loop never opens on one (`tools/uiencode.test.mjs`, 2026-10-11 reviews)

### R-demo-023 · shipped
The docs gifs and videos run at one even, readable pace: every screen worth showing stays up long
enough to see, the last one under each caption long enough to read the caption, and that pace is the
same in every film — not whatever a journey's waits happened to take.
- asked: 2026-10-03 (user: "the gifs and videos are too fast in general and I think also not in same speed - I mean the time one thing is shown until the next thing is visible that is worth showing")
- shipped: `scripts/ui/pace.mjs` (`PACE`, one rule for all journeys) + `tools/uipace.test.mjs`; the change probe in `scripts/ui/encode.mjs`; a caption arrives WITH the screen it describes, never over the one before (`scripts/ui/captions.mjs` `snapMarks`, `PACE.lead` 0; 2026-10-11 frame-by-frame reviews); a caption's last picture held at most 4 s (`PACE.readMax`), and a caption over 70 characters reported by `tools/uicaptions.test.mjs` (`PACE.captionMax`, `STRICT.captionChars`)

### R-demo-024 · shipped
The APK film shows the notifications the other phone gets: the build succeeded, and the new version is downloaded and ready to install, with its one-tap Install button, which is tapped. The subtitle says that both the download and the install can also happen by themselves, on the phone the build was started from or any other phone with waterplane.
- asked: 2026-10-05 (user: "Here we must show this notification with the one tap install button and the download succeeded message and say in the subtitle that both can happen automatically if desired on the same phone or other phones where waterplane is installed"), 2026-10-05
- shipped: b6f3e5a8

### R-demo-025 · shipped
A docs gif too long to loop is cut to a short stretch that still opens on the familiar screen, carries
a progress bar so a viewer landing mid-loop sees how far the start is, and holds its last picture
before looping; a tap on it opens the whole film as a video with pause and seek — on GitHub and in
the phone's own markdown reader.
- asked: 2026-10-07 (user: "the things that we show in the GIF are kind of long and people might miss the first few seconds and in videos they pause and go back and play over, but with GIFs they don't have these controls")
- shipped: `scripts/ui/encode.mjs` `loopFilm`, `scripts/ui/captions.mjs` `teaserWindows` (+ `tools/uiteaser.test.mjs`), a journey's `teaser`; README/guide gif linked to its mp4 (sized since R-demo-028); `Markdown.tsx` `inlineDoc`; every caption in the loop has its own screen in it (`teaserWindows` `changes`, `STRICT.teaserReferents`), and the run prints how long the loop holds each caption, warning over 8 s (`loopCaptions`, 2026-10-11 reviews)

### R-demo-026 · shipped
The full first-minute film opens the way a fresh install does: the APK's first screen asking for
a desktop, with Try the demo tapped there — never an empty app, and never the demo reached through a
settings search; the README's loop is exactly the hook's seven beats (R-demo-033), from the main
screen to the build reaching the phone (R-demo-030).
- asked: 2026-10-07 (user, inbox `.claude/inbox/combined-3-screens-marked-muydt9fxc40ce7.png` #1 "skip this frame with empty view", #2 "don't show this as filter settings but as the user after a fresh installation … with a dialogue"); 2026-10-11 (README frame-by-frame review: in the hero loop the first-run screen was a 0.8 s flash before a blank frame, so the loop opens on Claude Code's header with the prompt typed and the whole film keeps the first-run opening); 2026-10-16 the loop opens on the main screen and covers the seven beats, the full film keeps the first-run opening and the reader, cost and closing card after them (user, session conversation)
- shipped: `scripts/ui/journey-first-look.mjs` (filmed with the shell's marker, so `HostSetup` is the first screen; the test run keeps the browser's Settings way in); 2026-10-16 the gif's loop is the journey's `teaser`, from "Start a session on your desktop." to "Now try it on the real device…"

### R-demo-027 · shipped
The README's install section has a film of setting it up, from its first install command to the first
prompt sent and worked on: the desktop terminal typing the README's own commands (clone, install,
doctor, the HTTPS front door, build, start), then the phone opening the app, starting `claude` on a
repo with `+ new`, answering claude's first-launch trust question, typing and sending the first
prompt, and the turn running to its end. A short loop as a gif beside the install steps, the whole
journey as a video linked from it.
- asked: 2026-10-08 (owner: "A gif and a video for the setup steps in our README: the steps until the first prompt I sent and worked on, starting with the first install step.")
- shipped: `scripts/ui/journey-setup.mjs` + `scripts/ui/deskterm.mjs` (the terminal half), `STUB_TRUST=1` in `scripts/claude-stub-tui.mjs`; `docs/media/setup.{gif,mp4,png}`

### R-demo-028 · shipped
A docs gif fits on a laptop screen whole: the README and the guide show each film at a set width
(about 640 px tall) instead of its natural 1280, keeping its pixels so it stays sharp on a 2x
display, and the tap still opens the whole video — on GitHub and in the phone's markdown reader.
- asked: 2026-10-08 (owner: "the gifs are way too large - they dont even fit on one page on my laptop")
- shipped: README/guide `<a href="x.mp4"><img src="x.gif" width="270"></a>` (APK film 490); `packages/web/src/fileRefs.ts` `linkedImages`; `scripts/release/public-lib.mjs` reads `href`/`src`
### R-demo-029 · shipped
A hosted static waterplane demo is publicly available on the web so visitors can try the product without installing it.
- asked: 2026-10-06
- shipped: 2ebd6cdf, fdc5733e

### R-demo-030 · shipped
The first README GIF starts on the main screen, the repo list, where the session is started; its
first prompt is then typed into the input field (R-demo-014). Before 2026-10-16 it started with the
prompt already typed in the input field.
- asked: 2026-10-06; 2026-10-16 start on the main screen and tap + New instead of opening on the terminal with the prompt typed — the owner accepted changing that decision (user, session conversation)
- shipped: 742f8689; 2026-10-16 `scripts/ui/journey-first-look.mjs` `teaser`

### R-demo-031 · shipped
Text in the README GIF is sized to read comfortably, and the demo terminal output matches what the real CLI prints.
- asked: 2026-10-06
- shipped: 4611f58e

### R-demo-032 · shipped
The "try the live demo" link sits above the first image of the README.
- asked: 2026-10-09
- shipped: 590393a4

### R-demo-033 · shipped
The demo's first minute, and the README's hero loop, sell what only a desktop gives: Claude Code
running on YOUR desktop runs the app in the iOS simulator AND the Android emulator (a cloud sandbox
cannot), checks the screenshots itself and hands both to the phone; the person combines the two
into one numbered picture, circles what is off and sends it back ("make ② look like ①"); Claude
fixes it and checks both again; and the build then goes to the phone in the person's hand — the
real-world test, after Claude's own simulator checks, never where bugs are first found. The build
is shown the way waterplane really shows it (the desktop's outbox notification, a tap to download)
— no imitated Android system screen, and no pretence that a browser installs an app. Nothing it
shows is what Anthropic's Remote Control also does (starting sessions, answering prompts) as the
selling point. Seven beats, one caption each (≤70 characters, present tense):
1. the main screen, a session started in todo-garden — "Start a session on your desktop."
2. Claude Code's welcome header, the prompt typed — "Your desktop's own Claude Code, with its own tools."
3. the build, `xcrun simctl`, `adb`, two screenshot reads — "Not a cloud sandbox: iOS simulator and Android emulator."
4. a notification and both screenshots in the gallery (① iOS right, ② Android with the button under the keyboard) — "Both screenshots reach your phone."
5. both picked and combined, numbered ① ②, ② circled, "make ② look like ①" sent — "Combine them into one picture: ① iOS, ② Android." then "Circle the difference: "make ② look like ①"."
6. the fix, both re-checked, the after picture — "Fixed on both, checked again."
7. the build onto the real phone — "Now try it on the real device: the phone in your hand."
- asked: 2026-10-16 (user, session conversation: the README hero loop's story)
- shipped: `demo/scenarios/first-look.ts` (`hookReply`, `fixReply`, the `deliverable` step), `scripts/media/demo-shots.mjs` (the three simulator screenshots), the gallery's combine (`gallery/useGalleryPick.ts`, `GalleryPickBar.tsx`, `features/images` `GalleryEntry.tsx` → the collage sheet), `scripts/ui/journey-first-look.mjs` (`teaser`)

### R-demo-034 · shipped
The terminal's floating corner group (grip, reader, model, zoom pair, full screen) is in every docs
film, as the app shows it. Hiding it over the terminal (cb918424, 2026-10-11) took controls out of the
picture that a viewer should see.
- asked: 2026-10-16 (user, inbox `.claude/inbox/1000079074-marked-mvawpwf39f5e50.png`: "in the gif I miss the marked controls")
- shipped: `scripts/ui/filmaids.mjs` and `lib.mjs` no longer hide `.term-zoom`

### R-demo-035 · shipped
The README's and waterplane.dev's "Repo health" section has its own gif and video, and it tells
the health index's current story: a steady number does not mean a healthy repo. The example is the
shape of a real app vibe-coded for months without the readings (fictional name and paths,
R-demo-018): `photo-shelf`, one file grown from 1,020 lines in February to 8,397. The film shows
one score out of 100 against fixed good values (46), capped by its worst entry (file length, 16),
two severe warnings naming the offender, the trend second (100 in February, sliding since), every
entry's own score, and the longest file under it still climbing; the ask button is shown drafting a
prompt that changes nothing. A push on a reading newly turning severe is said in the prose, not
filmed. Readings only: nothing changes code on its own.
- asked: 2026-10-17 (owner: "repo health section does not have a gif and video yet … it needs to tell the right story"; the photo-app shape the same day)
- shipped: `demo/scenarios/repo-health.ts`, `demo/host/healthindex.ts` + `repohealth.ts` (photo-shelf profiles), `scripts/ui/journey-repo-health.mjs` (`teaser`), README `site:health`, `docs/guide.md` "Repo health"

### R-demo-036 · shipped
The README's and waterplane.dev's "Not only on the phone" section shows the app at the desk: a
laptop's browser (a 1440 x 900 window, a mouse) driving Claude Code on a bigger desktop. The film is
filmed and encoded by the same pipeline as the phone's, at the window's own size: repos in the
sidebar, a session started in the main pane, the prompt sent with ⌘↩, the build and both simulator
checks, the gallery opening as a panel beside the session. The section also says, in prose, that
two paired desktops can hand each other a job (R-peers-002).
- asked: 2026-10-18 (owner: "I like it better than vscode by now and is my preferred environment on the desktop … especially when I run stuff from my notebook on another bigger machine like my Mac studio"; "you should add desktop screenshot material as well … Incorporate it in the automated screenshot and media generation")
- shipped: `scripts/ui/journey-desktop.mjs` (`device: "desktop"`, `gif`, `captionScale`), `scripts/ui/lib.mjs` `filmOf`, `encode.mjs` `probeFor`, README `site:desk`, `site-lib.mjs` landscape figure
