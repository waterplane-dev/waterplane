# downloads

### R-downloads-001 · shipped
Outbox files show status icons: downloading, downloaded, opened/unopened, pending, or new; files can also download automatically without a click, with an indicator when a file is already in the download folder.
- shipped: 6d20ed8

### R-downloads-002 · shipped
Auto-download cancels/drops older downloads of the same artifact type when a newer version becomes available.
- shipped: 3f7c7bc

### R-downloads-003 · shipped
Download buttons behave consistently across the web app and APK, are located in the same place, and work reliably.
- shipped: 6d20ed8

### R-downloads-004 · shipped
Downloads section does not hide other content and keeps correct vertical proportions so the main view stays reachable.
- shipped: f0078f0

### R-downloads-005 · shipped
Downloads continue running in the background when the user switches to another app or the app is backgrounded, including auto-downloads that arrive after the page was frozen.
- asked: 2026-09-25
- shipped: c0a8666

### R-downloads-006 · shipped
Downloaded APK builds automatically install themselves on the phone without requiring a manual confirmation tap.
- asked: 2026-09-21, 2026-09-24
- shipped: 5f4411a

### R-downloads-007 · shipped
Automatic app-installation feature has its own dedicated screen, separate from Downloads.
- asked: 2026-09-21
- shipped: 94d1325

### R-downloads-008 · shipped
Downloads screen is redesigned with findable auto-download settings, and per-repository rule settings accessible from each repo's extended menu.
- asked: 2026-09-21, 2026-09-21
- shipped: f0078f0

### R-downloads-009 · shipped
An installation log lists every automatic app install with version, package name, timestamp, and target device.
- asked: 2026-09-21
- shipped: c3471ea, e38c44a

### R-downloads-010 · requested
Artifact size limit rules are visible and configurable.
- asked: 2026-09-21

### R-downloads-011 · shipped
Auto-download starts and completes reliably even with good connectivity, without being blocked by a false offline state.
- asked: 2026-09-22, 2026-09-22
- shipped: 56dd5ff, f1cca72

### R-downloads-012 · shipped
APK artifact filenames include version identifiers so builds of the same app can be told apart.
- asked: 2026-09-22
- shipped: 3f7c7bc


### R-downloads-013 · shipped
With both the APK and a browser tab open on one phone, auto-downloads can be directed to only one of them, so a build is not fetched twice. Auto-download can be switched off per client, the switch is visible in the downloads section, and a browser beside the APK asks once whether the app alone should fetch.
- asked: 2026-10-09, 2026-10-10, 2026-10-11
- shipped: 7afaac5

