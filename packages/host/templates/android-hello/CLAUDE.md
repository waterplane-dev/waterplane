# CLAUDE.md

Guidance for Claude Code working in **{{name}}**.

## What this is

{{description}}

An Android app (Kotlin, one Activity, Jetpack Compose, Material 3, minSdk 26) with the id
`{{package}}`. **The person runs it on the phone they are holding while they read your
replies.** They are not at a desk: they see a small screen, they cannot open Android Studio, and
the only way they see your work is the APK landing on their phone. Keep changes small and
visible, and make the app do the thing on first launch, not after setup.

## Commands

```bash
./gradlew --console=plain assembleRelease   # -> app/build/outputs/apk/release/app-release.apk
./gradlew --console=plain assembleDebug     # -> app/build/outputs/apk/debug/app-debug.apk
```

Both are already configured as builds for the phone's Build sheet (`{{state}}/builds.json`).
After a build, waterplane copies the APK into `.claude/outbox/` under a versioned name and the
phone downloads and installs it. Bump `versionCode` in `app/build.gradle.kts` for every change
the person should get: Android refuses to install an update with the same or a lower
`versionCode`.

## Rules

- **Never change `applicationId` / `namespace`** (`{{package}}`): a different id installs as a
  second app and the person's data stays behind.
- **Never commit a key.** Release signing reads `keystore.properties` (gitignored), which points
  at `~/.config/waterplane/keys/sideload.jks`. Without it the build falls back to the debug key.
  An update signed with a different key than the installed app cannot be installed over it.
- Code is in `app/src/main/kotlin/`; the screen is `MainActivity.kt`. Add dependencies in
  `app/build.gradle.kts`. Do not upgrade the Gradle wrapper, AGP or Kotlin unless asked: the first
  build on a machine is slow and a toolchain mismatch loses the person's time.

## Working from a phone (waterplane)

- **`.claude/outbox/`** is where anything a human should LOOK at goes: screenshots, reports, the
  built APK. A new file there notifies the phone. Name a file by its full path when you mention it.
- **`.claude/inbox/`** holds images uploaded from the phone; prompts reference them by path.
- **`{{state}}/`** is per-repo daemon state (builds, backlog). Don't hand-edit.

All three are gitignored. Prefer writing a file over printing a wall of terminal output.
