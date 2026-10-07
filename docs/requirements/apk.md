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

