# distribution

### R-distribution-001 · shipped
Instructions can optionally be resent to CLI clients from the initial fan-out.
- shipped: f479df9

### R-distribution-002 · shipped
The public repository receives one squashed commit per release, and outside contributions arrive as intent requests.
- asked: 2026-10-04
- shipped: fa1bd0f

### R-distribution-003 · shipped
Waterplane is released under the MIT licence.
- asked: 2026-10-04
- shipped: 009dff3

### R-distribution-004 · shipped
Users who clone and run waterplane are protected against supply-chain attacks: no install scripts, a release-age cooldown, verified lockfiles, dependency verification and signed releases.
- asked: 2026-10-04
- shipped: 042e38ad, cd0ccf92, d9756d0f, d0e40683

### R-distribution-005 · shipped
Releasing waterplane is done through scripts, so each release is reproducible and checked the same way every time.
- asked: 2026-10-04
- shipped: 60aaf327

### R-distribution-006 · shipped
The open-source release includes the generic keystore bridge; the vault is an experimental extension, not shipped by default (`ship.json` decides), and the opencode extension is never shipped.
- asked: 2026-10-05, 2026-10-06
- shipped: 36b98edb, c53c0924

### R-distribution-007 · shipped
Only allow-listed files are published to the public repository; GIF, video and readme generation tooling and unpublished plugins stay in the private repository.
- asked: 2026-10-06
- shipped: db8533d0

### R-distribution-008 · shipped
The publish step blocks publishing when internal addresses or secret-like keys are found in the files to be published.
- asked: 2026-10-06
- shipped: fa1bd0f

### R-distribution-009 · shipped
The WP build tools include a mirror publish entry.
- asked: 2026-10-06
- shipped: 1c7d859

### R-distribution-010 · shipped
Each internal link in the published docs that points to an unpublished file is handled on its own: removed if it adds little value, or its content moved into the linking page. No public doc links to a missing target.
- asked: 2026-10-07
- shipped: 2ea51816

### R-distribution-011 · shipped
The release publish script automatically builds and publishes the demo videos that the public docs need.
- asked: 2026-10-07
- shipped: 03d096ef, 78ae16f4

### R-distribution-012 · shipped
Demo videos are hosted from a separate GitHub Pages media repo and linked from the public docs; session ids never appear in the published public snapshot.
- asked: 2026-10-07
- shipped: 78ae16f4

### R-distribution-013 · shipped
Waterplane installs and runs on Windows as well as macOS.
- asked: 2026-10-07
- shipped: 0ff8d17e, ccb88790

### R-distribution-014 · shipped
Waterplane runs under OrbStack, and user documentation explains how to set it up that way.
- asked: 2026-10-07
- shipped: 9baaa6e

### R-distribution-015 · shipped
Lighter alternative variants are available on demand as options in the WP build tools, while the main button stays unchanged for all users.
- asked: 2026-10-08
- shipped: 1c7d859

### R-distribution-016 · shipped
The APK is trustworthy enough for users to install: it is on Google Play, and users can compile it themselves from source.
- asked: 2026-10-08
- shipped: 5023c1e5

### R-distribution-017 · shipped
Windows users install and start the host through one Windows launcher, from a checkout or an npm install.
- asked: 2026-10-09
- shipped: 202b4659

### R-distribution-018 · shipped
The product name is the same everywhere it appears; a file that must spell it out (such as the Play listing text, uploaded verbatim) is a listed exception with a reason.
- asked: 2026-10-09, 2026-10-11
- shipped: e665294a

### R-distribution-019 · shipped
A central private plan file records the details of the public open-source release, including the VS Code extension.
- asked: 2026-10-10, 2026-10-11
- shipped: e4660f43, e36d63d3

### R-distribution-020 · shipped
The VS Code extension is built to publishable quality so it can be shipped as is.
- asked: 2026-10-11
- shipped: a700d413

### R-distribution-021 · shipped
The cost and repo health views are one shared implementation used by both waterplane and the VS Code extension.
- asked: 2026-10-11
- shipped: f984d9cf, c4b2f739

### R-distribution-022 · shipped
Before anything is downloaded, the installer names everything missing at once; on a Mac, the installer and the doctor tell an account without admin rights exactly what to ask an administrator for (tmux, the Xcode Command Line Tools, Tailscale), never offering a Homebrew install that would fail for that account.
- asked: 2026-10-19
- shipped: 502e4497, 76282558, 9c500ce9
### R-distribution-023 · shipped
The wp build tool offers one entry that installs the latest version and a second entry that removes it again.
- asked: 2026-10-12
- shipped: 1c7d859

### R-distribution-024 · shipped
The wp build tool entries are shared across all clients and machines where the repo is checked out; machine-specific build settings live in a separate folder that is not shared.
- asked: 2026-10-12
- shipped: 50bf8fc

### R-distribution-025 · shipped
Expanding a section lists only the artifacts that belong to that item and time. Building and installing the VS Code extension produces and installs a VS Code artifact, never an APK.
- asked: 2026-10-14
- shipped: ea7bea2

### R-distribution-026 · shipped
waterplane.dev has a landing page and a privacy page, generated from the README and hosted on GitHub Pages under the custom domain.
- asked: 2026-10-15
- shipped: d1c66b6e

### R-distribution-027 · shipped
The install URL points to the GitHub release (releases/latest/download/install.sh), not the project's own domain, and the link returns the script.
- asked: 2026-10-16, 2026-10-17, 2026-10-17
- shipped: 05a659ca

### R-distribution-028 · requested
The game is published to the Play Store as 'Waterplane game', distinguishable from the coming waterplane-dev app.
- asked: 2026-10-16

### R-distribution-029 · requested
The waterplane, waterplane-game and child-paint repos are public on GitHub with clean rewritten history, no personal paths, noreply commit emails, a description and topics; child-paint is served as a GitHub Pages site and the waterplane npm package is published and installable.
- asked: 2026-10-17, 2026-10-17, 2026-10-17

### R-distribution-030 · shipped
waterplane.dev and www.waterplane.dev serve the GitHub Pages site over HTTPS with a valid certificate, and waterplane-dev.github.io redirects to it.
- asked: 2026-10-16, 2026-10-17
- shipped: 16ecc0eb

### R-distribution-031 · shipped
The build entry for the VS Code extension has a restart option for updating open windows' extensions, on by default.
- asked: 2026-10-17
- shipped: 2320f565

### R-distribution-032 · requested
Granting access to development builds is quick and convenient rather than a repeated manual chore.
- asked: 2026-10-19

### R-distribution-033 · shipped
The VS Code extension is published to the VS Code Marketplace on each release by its own separate release command; Open VSX is not a release target for now. The publish token lives only in the vault and is minted when needed, never left on disk, and each release needs a phone fingerprint approval.
- asked: 2026-10-20, 2026-10-20
- shipped: 6cbd0fd8, 72cf8462, a700d413

### R-distribution-034 · shipped
Each release publishes the public mirror at that release's version, so the mirror carries the latest released version.
- asked: 2026-10-20
- shipped: 03d096ef

### R-distribution-035 · shipped
Play Store listing screenshots and images are generated from the demo; no personal photos are included.
- asked: 2026-10-21
- shipped: 4643873b, 8364511d

### R-distribution-036 · shipped
The remote desktop plugin stays in the public mirror and is marked experimental.
- asked: 2026-10-21
- shipped: 7c84990e

### R-distribution-037 · requested
The apps collect no user data (and the Play data-safety form says so), request only the minimum Android permissions, and comply with Google Play policies and the EU GDPR.
- asked: 2026-10-21

### R-distribution-038 · requested
Waterplane Game, TalkingPictures and Little Painter are published on Google Play through the Play Console with the same flow; listings declare their assets as AI-made, each labelled, are completed and submitted, and show as in review rather than as a draft.
- asked: 2026-10-21, 2026-10-22, 2026-10-23

### R-distribution-039 · superseded
The Waterplane AAB is on the internal testing track assigned to the owner's account, not published to production; the Android app is distributed through Google Play private/internal testing, not a public listing.
- asked: 2026-10-21, 2026-10-26
- superseded-by: R-distribution-049

### R-distribution-040 · requested
The Waterplane Game does not ship a PC form factor.
- asked: 2026-10-23

### R-distribution-041 · shipped
Re-running install.sh on an existing installation says whether it installed, updated or reinstalled.
- asked: 2026-10-24
- shipped: fe9c0b9c

### R-distribution-042 · shipped
The reach/KPI stats scripts and dashboard stay out of the public mirror.
- asked: 2026-10-25
- shipped: b380c90f

### R-distribution-043 · shipped
The release preflight stops a release only for an open, unaccepted high or critical advisory, a newly added install script, or a failed npm verification, each waivable with an accept key; it prints the dependency changes since the last released tag.
- asked: 2026-10-26
- shipped: 025ace37

### R-distribution-044 · shipped
Release assets carry a build provenance attestation.
- asked: 2026-10-26
- shipped: 15c0ea03

### R-distribution-045 · shipped
Every build entry that produces an artifact lists the versions it produced in that project's build-tools list, whether triggered from the phone or by an agent.
- asked: 2026-10-27
- shipped: 672ca6cc

### R-distribution-046 · requested
FeedbackPlatform and realestatecalc are not made public; TalkingPictures is public.
- asked: 2026-10-30

### R-distribution-047 · shipped
One wp build button runs the whole release train in order: next version and notes, media generation (an optional parameter, off by default, commits regenerated media with the release), tag, public mirror, GitHub release and APK, npm, VS Code extension, and site.
- asked: 2026-11-02
- shipped: 03d096ef, 353f8a66

### R-distribution-048 · shipped
The release train also covers Google Play (a permanent step run after the other releases) and the npm release.
- asked: 2026-11-02, 2026-11-04
- shipped: f5806f8b

### R-distribution-049 · shipped
The waterplane Android app is listed on Google Play as a full production release, rolled out to all countries with managed publishing off, like the other apps.
- asked: 2026-11-02
- shipped: f5806f8b
- note: sent for review 2026-11-03 with full rollout, managed publishing off, 177 countries plus rest of world; the public Play page answered 200 on 2026-11-06. Each release train now uploads to production.

### R-distribution-050 · shipped
The Play listing has complete policy declarations, including a working video link for each foreground service type the app declares.
- asked: 2026-11-02
- shipped: 62cca32f

### R-distribution-051 · shipped
The Play Store description of the app is precise and says what the app does, including the phone workbench and that Wi-Fi works without Tailscale.
- asked: 2026-11-07
- shipped: 0379c0f4

### R-distribution-052 · shipped
A Play import button is available where the user expects it, on the reach dashboard.
- asked: 2026-11-07
- shipped: 2dae7963

### R-distribution-053 · requested
The project's links include the VS Code page, the OpenSSF project, the npm page and the Play Store links.
- asked: 2026-11-07

### R-distribution-054 · shipped
Down-scoping code stays private and is kept out of the public release.
- asked: 2026-11-08
- shipped: 8b47cee3

### R-distribution-055 · shipped
The installer ends by printing this desktop's URL and port and opens it in the browser when a screen is present (--no-open skips).
- asked: 2026-11-09
- shipped: adaa96c7

