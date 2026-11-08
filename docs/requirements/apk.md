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

### R-apk-007 · shipped
Demo mode can generate documentation with screenshots and videos of user journeys.
- asked: 2026-10-01
- shipped: cc2ef7b

### R-apk-008 · shipped
The Android app offers an optional biometric lock as a generic feature any plugin can use, so the secrets feature is not coupled to the shipped product.
- asked: 2026-10-05
- shipped: f74352e8

### R-apk-009 · shipped
The Android build tools include the dev debug APK.
- asked: 2026-10-05
- shipped: 1c7d859

### R-apk-010 · shipped
The installed Android app appears in the share sheet as a share target for waterplane, for any file or text.
- asked: 2026-10-06
- shipped: c1d7d699

### R-apk-011 · shipped
The Android app keeps building, syncing and working as before with an iOS shell beside it.
- asked: 2026-10-06
- shipped: be49c5ea

### R-apk-012 · shipped
If a downloaded web release shows a white screen, the app detects the bad state and automatically switches back to the release bundled in the APK, and does not take that build again.
- asked: 2026-10-07
- shipped: 38504c59, 4cca6fde


### R-apk-013 · shipped
Sharing many pictures to the app can drop them straight into a repo's inbox without opening a session, or into an open session; several pictures upload as they are unless the person asks to mark them up first.
- asked: 2026-10-10
- shipped: 83c50bcf

### R-apk-014 · shipped
An opt-in, per-phone switch on the Apps screen (the Android apps extension's, on when the desktop has an Android repo) deletes a build's APK once it has installed: the copy inside the app, the copy the app saved to Downloads, and older builds of the same app. The row then says the clean-up took it and how much it freed, and a Downloads copy it could not remove is named, not dropped.
- asked: 2026-10-11
- shipped: (this commit — needs a new APK)
### R-apk-015 · shipped
The Apps screen (the Android apps extension's, on when the desktop has an Android repo) shows, per repo, whether its artifacts and build scripts are ready for automatic install and why not when they are not.
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

### R-apk-018 · shipped
An Android APK of the app is produced and available alongside the releases.
- asked: 2026-10-19
- shipped: 6598946


### R-apk-019 · shipped
In the sideloaded app, an app the person allowed to install itself updates with no dialog after its first install; only the first install of each app shows Android's confirm, and a refused quiet update falls back to that confirm instead of failing.
- asked: 2026-09-21
- shipped: ddf77a55

### R-apk-020 · shipped
The agent in a driven repo answers "does my app update itself" from waterplane's own chain (build button → auto-download → quiet install after the first; the install step lives on the Android apps extension's screen) and never from general Android knowledge, and can run the repo's build buttons itself so a build it makes reaches the phone like a tapped one.
- asked: 2026-11-01

### R-apk-021 · shipped
Getting a repo's Android app onto the phone and keeping it updated is one flow in one place with one set of words: a new user sees what is missing and fixes it from there. The auto-install control and the per-app Off state never contradict each other, so the user can tell at a glance whether a new build installs by itself or waits for a tap.
- asked: 2026-11-01, 2026-11-01
- shipped: fb82bd6c, c841e1cf

### R-apk-022 · shipped
The built APK carries the correct app name.
- asked: 2026-10-31
- shipped: dc16650e

### R-apk-023 · shipped
The feature is named for what it does: Android apps, automatic deploy and install of Android APKs, the only native app type supported right now, not a generic 'apps' feature.
- asked: 2026-11-01
- shipped: 297ef520

### R-apk-024 · requested
Each built APK carries a version identifier that increases with every build, so the installed version shows which build it is.
- asked: 2026-11-01


### R-apk-025 · shipped
The Android app can require the phone's fingerprint before it shows its screen: when the app starts, and when the person comes back after more than a minute away. Off by default, per phone, switched in Settings › Connection › *lock this app* (turning it on and off each take one authentication); nothing changes on the desktop, and queued sends, notifications and the background link keep working behind the lock. The lock fails closed: a cancelled, failed, locked-out or busy prompt keeps the app locked with a retry, and so does anything the app does not recognise. It opens the app and switches itself off, saying so and where it is turned back on, only for a reason a person holding the phone cannot cause: the fingerprint set changed (a credential only the phone's owner has), the app's own saved check is unreadable, or a fresh status read confirms the phone has no sensor or nothing left to check with. A browser, the PWA, the demo and an app without the fingerprint keystore have no switch; where the switch cannot be turned on the row says why (an old app, no sensor, nothing enrolled, no screen lock, or a plain-HTTP route on an app that needs a key for it).
- asked: 2026-11-03
- shipped: cb2d749e, 49f9e8ec
- note: the lock is a hold-the-phone defence at UI level; see SECURITY.md for what it does not cover.

### R-apk-026 · shipped
On an app with the newer shell the lock's sheet offers the phone's PIN, pattern or password when the fingerprint fails or is locked out, and face unlock counts where the phone has it. An older app locks with a fingerprint only. Needs a new APK; the UI side detects the capability, never a version.
- asked: 2026-11-03
- shipped: 49f9e8ec

### R-apk-027 · shipped
The Android app can lock the phone's sign-ins to password-protected desktops: Settings › Connection › *lock the desktop sign-ins*, off by default, per phone, independent of *lock this app*. On, the phone's device tokens are one blob under a Keystore key instead of plaintext in the page's storage, and opening the app asks for the fingerprint (or, on a newer app, the phone's PIN) before anything connects; with the app lock also on, that is the same single prompt, never two. The row names every saved desktop and what the lock costs it before the choice (a desktop with no password has nothing to lock; one reached on the Wi-Fi signs this phone in again by itself; one that gates the tailnet must be paired again if the key is lost; alerts while the app is closed depend on the app version), and says what the phone cannot know as that. It refuses in words where it cannot work, for example a desktop saved at a plain-HTTP address. A prompt that is cancelled, locked out or unrecognised keeps the app on the card; *open without the sign-ins* mounts the app with the sign-ins still locked and never gets past the app lock. The lock opens and switches itself off, saying which desktops it lost, only for a reason a person holding the phone cannot cause, never because no sensor answers, and even then the locked copy is set aside rather than deleted. When a refusal shows the sign-ins cannot be opened, the row offers *forget the locked sign-ins*: confirmed, past the app lock if that is on, saying per desktop what is lost and what to do next. The socket does not connect before the unlock (tokenless HTTP such as the update check does, with no token), and an older app with both locks on will not save a plain-HTTP address for a desktop, since that app could never open again. It guards a copy of the app's storage, not a hand holding the unlocked phone.
- asked: 2026-11-03
- shipped: 4374d316, 5b60c2f0, 771f39f8
- note: SECURITY.md lists the residuals: a revoked token can stay in the blob until the next rewrap, a stray bare token can stay plaintext, passive (kids') tokens are not sealed. Device checks are still the owner's.

### R-apk-028 · shipped
On a newer app, while the sign-ins are locked the background link keeps each token in memory only: nothing about it reaches the disk. Alerts from password-protected desktops keep coming with the app swiped away until the phone restarts or Android stops the app; then that link says "locked — open the app" and resumes when the app is opened and unlocked. An older app is handed no token while locked, so with the app closed those alerts wait until the app is opened. The UI detects the capability, never a version.
- asked: 2026-11-03
- shipped: 9780cdce, 771f39f8

### R-apk-029 · shipped
The app takes an update over the air only when it can check it: once a phone holds a desktop's update key, an update with no signature, a bad one, or an older one than it already took is refused, nothing is downloaded, and Settings › Connection › app version says why in words that stay true whether the desktop is out of date or cannot read its key file. The key is learned on the next connection over the tailnet or an encrypted link, never over a plain Wi-Fi route: with no question on an older app, and through the app's own dialog on a newer one. A changed key and a restored desktop each wait for the person's answer, and an older app on an older desktop updates as it always did.
- asked: 2026-11-03 (LAN security plan, section 5)
- shipped: c7661bd2, e44959a9, 2815d9b1
- note: two layers. The page checks the signature on every app, so a relay cannot swap a bundle once the phone holds a key; a newer app also checks natively, which covers page code that is already compromised, and asks in its own dialog the first time a desktop's key is seen. The signature proves the bundle came from the desktop that was paired, never that its code is good (SECURITY.md). A passive (kids') phone opens no socket, so it never learns a key and takes updates as it did before. Not tried on a phone.
