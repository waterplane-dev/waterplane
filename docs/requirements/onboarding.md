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

