# android-apps — the Apps screen

Which of this desktop's Android apps will install themselves on the phone, and the log of what
installed on which phone. It is an optional extension, so a desktop with no Android repo carries no
Apps line. Public. Design: `docs/notes/android-apps-architecture.md`.

**When it is on.** The manifest says `optional` and `autoOn: "androidRepo"`: with no stored choice
the host switches it on when any primary checkout under the root holds an Android app (a bounded
walk, cached in `<state dir>/auto-probe.json`, re-asked every 15 minutes) and leaves it off
otherwise. A person's own switch always wins. Releases ship it with `deploy/ship.json`
`{ ship: true, on: true }`; `autoOn` narrows that per desktop.

**Host half** (`host/`), reached with `plugin.call`:

- `readiness` returns `{ at, apps: AppRepoFacts[] }` from core's `api.repoApps()` (facts, never a verdict).
- `log` returns the `InstallLogDoc`, trimmed oldest-first to stay under 480 KB (`total` stays what the host holds).
- `report { device, entries }` returns `{ n, at }`. A phone re-states its whole install history on
  every connect, so it sends it in idempotent chunks of at most 100 entries and 48 KB (`chunkReport`).
- push `changed { n, at }` after a chunk changed the log. It is a ping; phones call `log` again.

**The install log** is `<state dir>/installs.json`, the shape `{entries}`. This extension is its only
writer (the `WRITE` constant in `host/installlog.mts`; tests open it read-only). Switching the
extension off loses nothing, because the file stays where it is.

`shared/wire.mts` holds the method types and the pure install-log rules (keyed idempotent merge,
cleaning, device derivation, sentences) both ends import. The phone half is `web/`.

Tests: `test/` (node:test over the built host: `npm run test:host`), `e2e/e2e-android-apps.mjs`.
