# apk

### R-apk-001 · shipped
APK shows a dialog when a link is tapped, asking whether to open in-app or in an external browser.
- shipped: c2317b5

### R-apk-002 · shipped
The Android app can read the current Wi-Fi network's name and tell the web app whenever the network
changes, both gated on the location permission the OS requires for it; the app states in-product why
it wants that permission before asking for it.
- asked: 2026-09-27 (user request)
- shipped: e2e53b1

### R-apk-003 · shipped
Tapping a `waterplane://pair` link opens the app straight into pairing with that link's desktop already
filled in.
- asked: 2026-09-27 (user request)
- shipped: e2e53b1

### R-apk-004 · shipped
The Android app asks for the permissions it needs via a setup checklist and banner, with one tap per missing step.
- asked: 2026-09-25
- shipped: 1e9a73f

### R-apk-005 · requested
Automated app-installation scanning does not run while permission dialogs are shown.
- asked: 2026-09-25

### R-apk-006 · shipped
The Android app has a demo mode that runs without any backend setup, on an in-app mocked backend, so store reviewers and first-time users can try it.
- asked: 2026-10-01, 2026-10-01
- shipped: b902ba4

### R-apk-007 · requested
Demo mode can generate documentation with screenshots and videos of user journeys.
- asked: 2026-10-01

### R-apk-008 · shipped
The Android app offers an optional biometric lock as a generic feature any plugin can use, so the secrets feature is not coupled to the shipped product.
- asked: 2026-10-05
- shipped: f74352e8

### R-apk-009 · requested
The Android build tools include the dev debug APK.
- asked: 2026-10-05

### R-apk-010 · shipped
The installed Android app appears in the share sheet as a share target for waterplane, for any file or text.
- asked: 2026-10-06
- shipped: c1d7d699

### R-apk-011 · requested
The Android app keeps building, syncing and working unchanged while the iOS shell is added.
- asked: 2026-10-06

### R-apk-012 · shipped
If a downloaded web release shows a white screen, the app detects the bad state and automatically switches back to the release bundled in the APK, and does not take that build again.
- asked: 2026-10-07
- shipped: 38504c59, 4cca6fde


### R-apk-013 · shipped
Sharing many pictures to the app can drop them straight into a repo's inbox without opening a session, or into an open session; several pictures upload as they are unless the person asks to mark them up first.
- asked: 2026-10-10
- shipped: 83c50bcf

### R-apk-014 · shipped
An opt-in, per-phone switch on the Apps screen deletes a build's APK once it has installed: the copy inside the app, the copy the app saved to Downloads, and older builds of the same app. The row then says the clean-up took it and how much it freed, and a Downloads copy it could not remove is named, not dropped.
- asked: 2026-10-11
- shipped: (this commit — needs a new APK)
### R-apk-015 · shipped
The Apps screen shows, per repo, whether its artifacts and build scripts are ready for automatic install and why not when they are not.
- asked: 2026-10-09
- shipped: 4a59f3a8

### R-apk-016 · shipped
The Android app is published to the Play Store from the desktop, and later updates reach the Play Store the same way, with no manual Play Console use after the first upload.
- asked: 2026-10-09
- shipped: 5023c1e5

### R-apk-017 · shipped
Android debug and dev signing keys are leased for a long time at build time, while production signing keys are short-lived and never reused.
- asked: 2026-10-11
- shipped: 3fc7cb4d

