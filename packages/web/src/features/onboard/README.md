# onboard

Build your first app — the phone half of the first-app job. The job itself
is the desktop's (`packages/host/src/onboard.ts`; why it is one persisted step list: `docs/notes/host.md`): it scaffolds from a template, installs the
Android tools and makes the signing key when consented, runs the setup checklist and the first
build, and opens a session. This feature asks the questions, shows the consent, follows the
progress and hands the person into the session.

**Owns**

- `FirstRunCard.tsx` — the launcher's card (`core/launcher/LauncherScreen.tsx` draws it). Shown
  when the host has never opened a session: no live session, nothing in recent, nothing recently
  closed (`firstRunCard`; the host keeps no flag, those three lists are the cheap signal). The
  ways in: *Build your first app*; the repos already listed under it — a line with their count
  (`existingReposLine`), and an *Open an existing repo* button only when there are none (it then
  says how to make one: a button whose whole effect was "tap one below" sat right above them);
  *Try the demo* (`enterDemo("first-look")`). While a job runs or is stopped the same place shows
  it, whatever else is open. Never in the demo. "Not now" lasts for the page only.
- `OnboardSheet.tsx` — overlay `onboard` (not persisted: a consent screen, `hostedack`'s reason).
  Three stages in one sheet: the questions (name prefilled `hello-<word>`, plain hello world or a
  one-line description, Android or web — Android preselected only where this phone can install
  apps — and "set this repo up", on), the consent screen (exactly the plan's lines, each with
  what / where / size / licence link; Go and Cancel, nothing starts before Go; a toolchain line
  offers *make a web page instead*), and the checklist (`onboard.progress` frames; a stopped step
  offers *retry* / *I ran it — carry on* / *allow it and carry on* via `POST /api/onboard/resume`,
  plus *do it yourself: <command>*). Done: open the page (web) or install the APK (Android), open
  the session, build another app. The New sheet's *build an app* row opens it too.
- `actions.ts` — the HTTP calls (`api.onboard*`), `takeJob` (the one writer of `jobStore`: the
  newer `updatedAt` wins, so a late GET never rolls a frame back), the allow-list pre-seed
  (`withAllowed` + `writeInstallAllow`, only when the `installApps` line was ticked), Android's
  install switch (`installSwitchOff` / `openInstallSettings`), and the hand-off.
- `logic.ts` — every pure rule, pinned by `logic.test.mjs`.
- Messages: `onboard.progress` (store), `welcome` (re-read the job after a reconnect).
- Track ids: `overlay:onboard`, `action:onboard.go`, `action:onboard.resume`,
  `action:onboard.handoff`, `action:onboard.demo`.

**Rules that apply here**

- Nothing applies itself: Go is the person's tap for exactly the ticked lines (`consentToSend`
  never sends a line the plan did not list), and the hand-off puts the suggested prompt in the
  composer as a DRAFT — appended through `compose.seedDraft`, once per job (`seededStore`), never
  sent. With a description the host already sent it as the first prompt, so nothing is seeded.
- No greyed buttons: Next and Go are replaced by the sentence saying what is missing.
- The host words every step and line; nothing here re-words them.
