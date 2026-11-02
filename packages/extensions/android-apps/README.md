# android-apps — the Apps screen, as an optional extension

Which of this desktop's Android apps will install themselves on the phone, and the log of what
installed on which phone. It was core; it moved out so a desktop with no Android repo carries no
Apps line (design and cut order: `docs/notes/android-apps-architecture.md`). Public.

**The default rule.** The manifest says `optional` and `autoOn: "androidRepo"`: with no stored choice
the host switches it ON when any primary checkout under the root holds an Android app (a bounded
walk, cached in `<state dir>/auto-probe.json`, re-asked every 15 minutes) and leaves it OFF
otherwise. A person's own switch always wins. Until the Apps screen moves here it is `ship: false` (the settings row would say more than it does); a release then ships it with `deploy/ship.json`
`{ ship: true, on: true }`; `autoOn` narrows that per desktop.

**Host half** (`host/`), reached with `plugin.call`:

- `readiness` -> `{ at, apps: AppRepoFacts[] }` from core's `api.repoApps()` (facts, never a verdict).
- `log` -> `InstallLogDoc`, trimmed oldest-first to stay under 480 KB (`total` stays what the host holds).
- `report { device, entries }` -> `{ n, at }`. A phone re-states its whole install history on every
  connect, so it sends it in idempotent chunks of at most 100 entries and 48 KB (`chunkReport`).
- push `changed { n, at }` after a chunk changed the log — a ping; phones call `log` again.

**The install log** is `<state dir>/installs.json` — the file core has always written, same
`{entries}` shape, no migration, so switching the extension off loses nothing. Until the switch
(work package P4) core is still its writer: this store opens it read-only behind the `WRITE`
constant in `host/installlog.mts`, re-reading it when it changes on disk. P4 flips `WRITE`.

`shared/wire.mts` holds the method types and the pure install-log rules (keyed idempotent merge,
cleaning, device derivation, sentences) both ends import. The phone half (`web/`) arrives in the next
work package.

Tests: `test/` (node:test over the built host: `npm run test:host`), `e2e/e2e-android-apps.mjs`.
