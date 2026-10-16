# distribution

### R-distribution-001 · shipped
Instructions can optionally be resent to CLI clients from the initial fan-out.
- shipped: f479df9

### R-distribution-002 · requested
The public repository receives one squashed commit per release, and outside contributions arrive as intent requests.
- asked: 2026-10-04

### R-distribution-003 · requested
Waterplane is released under the MIT licence.
- asked: 2026-10-04

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

### R-distribution-008 · requested
The publish step blocks publishing when internal addresses or secret-like keys are found in the files to be published.
- asked: 2026-10-06

### R-distribution-009 · requested
The WP build tools include a mirror publish entry.
- asked: 2026-10-06

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

### R-distribution-014 · requested
Waterplane runs under OrbStack, and user documentation explains how to set it up that way.
- asked: 2026-10-07

### R-distribution-015 · requested
Lighter alternative variants are available on demand as options in the WP build tools, while the main button stays unchanged for all users.
- asked: 2026-10-08

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

