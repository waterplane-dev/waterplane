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
The open-source release includes the generic keystore bridge but never the vault or the opencode extension.
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

### R-distribution-011 · requested
The release publish script automatically builds and publishes the demo videos that the public docs need.
- asked: 2026-10-07

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

### R-distribution-016 · requested
The APK is trustworthy enough for users to install: it is planned for Play Store distribution, and users can compile it themselves from source.
- asked: 2026-10-08

### R-distribution-017 · shipped
Windows users install and start the host through one Windows launcher, from a checkout or an npm install.
- asked: 2026-10-09
- shipped: 202b4659

### R-distribution-018 · requested
The user-facing product name is read from the single brand definition everywhere, including Play store listing text; no file hardcodes it unless allowed with a reason.
- asked: 2026-10-09, 2026-10-11

### R-distribution-019 · shipped
A central private plan file records the details of the public open-source release, including the VS Code extension.
- asked: 2026-10-10, 2026-10-11
- shipped: e4660f43, e36d63d3

### R-distribution-020 · requested
The VS Code extension is built to publishable quality so it can be shipped as is.
- asked: 2026-10-11

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

### R-distribution-030 · requested
waterplane.dev and www.waterplane.dev serve the GitHub Pages site over HTTPS with a valid certificate, and waterplane-dev.github.io redirects to it.
- asked: 2026-10-16, 2026-10-17

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

### R-distribution-034 · requested
The public mirror always carries the latest released version of the product.
- asked: 2026-10-20

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
Waterplane Game, TalkingPictures and Little Painter are published on Google Play through the Play Console with the same flow; listings declare their assets as AI-made, each labelled.
- asked: 2026-10-21, 2026-10-21, 2026-10-21

### R-distribution-039 · requested
The Waterplane AAB is on the internal testing track assigned to the owner's account, not published to production.
- asked: 2026-10-21

