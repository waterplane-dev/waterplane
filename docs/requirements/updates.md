# updates

### R-updates-001 · shipped
Web-app automatically updates when a new version is available without requiring an APK rebuild or manual update.
- shipped: 93c6245

### R-updates-002 · shipped
App checks for updates more frequently.
- shipped: 5782931

### R-updates-003 · shipped
Update availability shows as an overlay message on the main screen with a button to install the new release.
- shipped: 1955883, d3e4a82

### R-updates-004 · shipped
Waterplane skills are kept up to date automatically for other users and repos, not just locally.
- asked: 2026-10-04
- shipped: 2efac47

### R-updates-005 · shipped
The README has a section that tells users the exact commands to update an existing waterplane installation to the latest version.
- asked: 2026-10-07
- shipped: 03268ba6

### R-updates-006 · shipped
After a successful CLI update the update button disappears.
- asked: 2026-10-07
- shipped: edf27820

### R-updates-007 · requested
For the project's developers only, a newer Claude CLI release is installed automatically and a real-CLI check then runs, fixes what broke and reports what it did; it is never active for other users of the repository.
- asked: 2026-10-07
- note: The real-CLI smoke script exists (824429cc); the automatic install job and auto-fix were not switched on, pending the owner's go-ahead.

### R-updates-008 · shipped
Pressing the update button in the VS Code title bar fully updates the open extension to the current build, so it shows the current style.
- asked: 2026-10-17
- shipped: 2320f565

### R-updates-009 · shipped
A Claude CLI update installed by any route (native installer, npm, brew) shows up in the UI the same way; a native install is checked against npm at its own update channel.
- asked: 2026-10-20
- shipped: d897e1c7


### R-updates-010 · shipped
A waterplane installed with install.sh shows on the phone when a newer release exists (current → new, release notes on a tap) with an update button and a roll-back button; the update verifies the download, restarts the desktop and the phone confirms the new version. An npm or git-checkout install also gets an update button (see R-updates-010a); an install the updater cannot recognise shows why there is none.
- asked: 2026-10-23; changed 2026-11-13
- shipped: fb0cb3c0, 960d75fd, 645751cf, 58a89d29, fb5061cc, 84b05d48

### R-updates-010a · shipped
Waterplane's own updates have a door beside Plugins at the top of Settings. An npm install's update button installs the version shown with npm and restarts; a git checkout is due when its branch has new commits upstream, and its button fast-forwards, runs npm ci and the build, then restarts — refusing in words, with nothing changed, when the checkout has uncommitted changes, commits of its own, or no upstream. Both say what they skip (no signature check, no roll back) and show the command to run by hand.
- asked: 2026-11-13

### R-updates-011 · shipped
The desktop checks once a day (and on refresh) whether waterplane or an installed plugin has a newer version, never installs anything by itself, and the check can be switched off. Waterplane and plugin updates share one updates view whose count opens exactly those updates.
- asked: 2026-10-23
- shipped: fb0cb3c0, 960d75fd, 645751cf, 58a89d29, fb5061cc, 84b05d48

### R-updates-012 · shipped
A paired desktop can be updated from the phone only while it is the desktop being driven, with a confirm that names it; never several desktops at once.
- asked: 2026-10-23
- shipped: fb0cb3c0, 960d75fd, 645751cf, 58a89d29, fb5061cc, 84b05d48

### R-updates-013 · requested
An Android app installed from a GitHub release shows in the updates view when a newer app release exists, with a download that ends in Android's install dialog. A Google Play install says it updates through Google Play, and an app someone built themselves says to rebuild it from their checkout — neither gets a button, because a differently signed APK cannot install over it.
- asked: 2026-10-23

### R-updates-014 · shipped
After the desktop updates itself, the receipt says the phone picks up the new UI next; the phone's UI keeps following the desktop it is connected to over the air.
- asked: 2026-10-23
- shipped: fb0cb3c0, 960d75fd, 645751cf, 58a89d29, fb5061cc, 84b05d48
### R-updates-015 · shipped
The Android shell and the web bundle each show their own build identifier inside the app, on separate labelled lines in the app-update screen, so the user can compare them with the build list; the web bundle's over-the-air identity is unchanged.
- asked: 2026-10-27, 2026-10-27
- shipped: d902a098

