# onboarding

### R-onboarding-001 · requested
Right after pairing, a first-run choice offers "Build my first app", which ends with a brand-new app
built on the desktop and installed on the phone, without the person typing a command.
- asked: 2026-10-01 (first-app plan, docs/analysis/first-app-plan.md)
- progress 2026-10-02: the phone half landed (WP7, `features/onboard`): the first-run card on a host that never opened a session offers *Build your first app*; the web path runs end to end in a browser (`scripts/e2e-onboardphone.mjs`). Stays requested until the Android path is seen installing on a phone.
- progress 2026-10-02: the web path is also a UI journey with a gif (`scripts/ui/journey-first-app.mjs`, `docs/media/first-app.gif`).

### R-onboarding-002 · shipped
Before anything is downloaded, installed or created, one screen lists in plain words every access
the journey will use (new folder, toolchain download with its size and location, Android SDK licence
acceptance, signing key location, permission to install apps on the phone) and nothing starts until
the person taps to go ahead.
- asked: 2026-10-01 (first-app plan, docs/analysis/first-app-plan.md)

- progress 2026-10-02: host half landed (WP6): `GET /api/onboard/plan` lists only the lines that apply on this desktop, each with what/where and the toolchain's derived size and licence link; `POST /api/onboard` refuses a start missing a required tick. The screen itself is WP7.
- shipped: first-app WP7 (`features/onboard/OnboardSheet.tsx`: exactly the plan's lines with what/where/size/licence link, one Go and one Cancel, Go replaced by a sentence while a needed line is unticked)

### R-onboarding-003 · shipped
The journey asks only a few short questions (app name, plain hello world or a one-line description,
whether to set the repo up for waterplane) and never asks for build details.
- asked: 2026-10-01 (first-app plan, docs/analysis/first-app-plan.md)
- shipped: first-app WP7 (name prefilled `hello-<word>`, plain hello world or one line, Android or web page, set-up toggle; no build details asked)

### R-onboarding-004 · shipped
Missing Android build prerequisites are detected first and, with consent, installed into user-local
locations without administrator rights; an existing setup is found and reused, never reinstalled.
- asked: 2026-10-01 (first-app plan, docs/analysis/first-app-plan.md)
- progress 2026-10-02: the finding half landed (read-only probe `androidenv.ts`, doctor lines, `android-toolchain` row).
- progress 2026-10-02: the install half landed host-side (`toolchain.ts`, `android-toolchain` fix, licence only with consent); the phone's consent screen is WP7, so this stays requested.

- progress 2026-10-02: downloads are verified before unpacking (pinned SHA-256 for the cmdline-tools zip, Adoptium's listed checksum for the JDK); the pins match the template (android-36, build-tools 35.0.0).
- shipped: first-app WP7 (the consent screen lists the toolchain line only when the desktop's probe found something missing, with its derived size, location and licence; `android-toolchain` is a two-tap setup-row fix quoting the same consent)

### R-onboarding-005 · shipped
An app signing key is found or, with consent, created on the desktop outside any repo, and the person
is told that losing it stops updates of the installed app.
- asked: 2026-10-01 (first-app plan, docs/analysis/first-app-plan.md)
- progress 2026-10-02: host half landed (`signkey.ts`, the confirm-gated `signing-key` fix on the `apk-install` row); the consent screen is WP7, so this stays requested.
- shipped: first-app WP7 (the consent line quotes `SIGNING_KEY_CONSENT` — where, mode 600, lose it and updates stop — and the `signing-key` setup-row fix is a two-tap confirm with the same words)

### R-onboarding-006 · requested
The new repo comes out set up for waterplane: CLAUDE.md, outbox and inbox, a configured build, and
built APKs collected into the outbox, downloaded by the phone and installed automatically after the
first install.
- asked: 2026-10-01 (first-app plan, docs/analysis/first-app-plan.md)

- progress 2026-10-02: host half landed (WP6, `onboard.ts`): scaffold from the template, setup checklist fixes, first build through `BuildManager` with the APK collected into the outbox; the phone's download and auto-install are WP7.
- progress 2026-10-02: the phone pre-adds the new app's package to the install allow-list when the consent line is ticked, offers Android's install switch when it is off, and the finished checklist downloads the APK; not yet seen installing on a device, so this stays requested.

### R-onboarding-007 · shipped
After the first install, a session is open in the new repo with a suggested next prompt, so the
person's next message changes the app on their phone.
- asked: 2026-10-01 (first-app plan, docs/analysis/first-app-plan.md)

- progress 2026-10-02: host half landed (WP6): the job opens a session in the new repo (a description goes in as its first prompt through the intent store) and carries the suggested prompt for the phone to offer.
- shipped: first-app WP7 (the finished checklist's *open the session* attaches the job's session with the suggested prompt in the composer as an unsent draft, once per job; a description was already sent as the first prompt and seeds nothing)

### R-onboarding-008 · shipped
The setup steps the journey runs are also rows in the repo-setup checklist (build configured, Android
toolchain, signing key), usable on any existing repo one tap at a time.
- asked: 2026-10-01 (first-app plan, docs/analysis/first-app-plan.md)
- shipped: first-app WP7 (`setupRemedy.ts`: `android-toolchain` and `signing-key` are core fixes with their consent words on the armed button, next to WP5's `builds-configured`)

### R-onboarding-009 · shipped
A person who declines the Android build tools can still finish the journey: a web page app is built
instead, with nothing installed, and opens on the phone from the gallery.
- asked: 2026-10-01 (first-app plan, docs/analysis/first-app-plan.md)
- progress 2026-10-02: host half landed (WP6): the web path needs no toolchain or key, builds in about a second and leaves `<name>.html` in the outbox (`scripts/e2e-onboard.mjs`).
- shipped: first-app WP7 (web page preselected in a browser, *make a web page instead* on the toolchain line; the finished page opens in the gallery viewer)

### R-onboarding-010 · shipped
A device that never touched the settings gets session tabs, the connection strip and the local runner strip on by default.
- shipped: fda924a

### R-onboarding-011 · shipped
Help text stays collapsed until the user clicks a helper icon, and the UI is compact enough that the first entry is visible without scrolling.
- asked: 2026-10-06
- shipped: 7f374b35

### R-onboarding-012 · shipped
On Windows, Claude CLI is detected even when it is not on PATH, by searching typical install locations.
- asked: 2026-10-07
- shipped: 9561ff77

### R-onboarding-013 · shipped
A fresh install on Windows run before `npm ci` says to run npm ci instead of a 'tsc' command-not-found error.
- asked: 2026-10-07
- shipped: f8d58d21

### R-onboarding-014 · shipped
On first start the user is shown a one-time dialog to set the folder holding their repos, and Settings → Code folder shows where to change it later.
- asked: 2026-10-07
- shipped: efdf749b, 01712621

### R-onboarding-015 · shipped
A first-time user on a host that has never run a session sees the repo row's + labelled "+ new", and is told when that label retires into a plain +. Superseded 2026-10-13 by R-sessions-040: the start buttons are always worded, so there is no label to retire.
- asked: 2026-10-08
- shipped: d3975281, df830262

### R-onboarding-016 · requested
The flow from the first install step through to the first prompt working runs end to end without failures.
- asked: 2026-10-08


### R-onboarding-017 · shipped
Beside the repo-setup checklist, a repo has an Opt-ins list: the advanced things it can turn on (requirements list, repo health series and own readings, a weekly Fable security review, pre-push checks, safer npm installs, a GCP registry cleanup policy, app screenshots). Each shows whether it is on, what it is for and what it costs. None of it counts as a setup problem or in the repo badge.
- asked: 2026-10-16
- shipped: 1b62447

### R-onboarding-018 · shipped
Every opt-in is the person's choice: a tap seeds the Send sheet (or runs the existing no-cost setup fix, or opens the screen that does the job), and nothing is sent or scheduled until the person sends it there. "Not for me" hides an offer in that repo until they offer it again. An offer the desktop cannot check can be marked done by the person and is shown as their word, not as a check that passed. Offers that do not fit the repo sit behind a count.
- asked: 2026-10-16
- shipped: 1b62447

### R-onboarding-019 · shipped
A "walk me through these" button seeds one prompt in which an agent interviews the person about the offers still open, then posts each one they pick as its own work item (a schedule for the recurring ones) instead of doing them all in one long session.
- asked: 2026-10-16
- shipped: 1b62447
### R-onboarding-020 · shipped
The onboarding screen does not tell the user about a step the installer already handles.
- asked: 2026-10-17
- shipped: b174f3b0

### R-onboarding-021 · shipped
Setup shows the npm install command for Claude Code, states that a paid Claude subscription or API key is needed, and mentions local AI and GitHub Copilot as alternatives.
- asked: 2026-10-19
- shipped: c45c5387

