# pull

Downloads on this phone: the Downloads sheet (the transfer queue plus each repo's auto-download
rules), the link to the android-apps extension's Apps screen (via `appsDoor`), and the mirror of `pull.ts`'s records that App's
strip, menu chip and activity screen read. The transfers themselves — retries, resume offsets, the
Background Fetch / native / chunked engines — stay in `pull/` (`pull.ts` is its facade); this feature only wires them to the
socket and the screens. Rules for all of it: skill `web-files` (`pull.ts`, `nativePull.ts`,
`installPolicy.ts`; the Apps screen is `packages/extensions/android-apps`).

**Owns**

- `store.ts` — `records` (a snapshot of `pulls.list()`, written only by the subscription `boot`
  opens), `cfgs` (per-repo `AutoPullConfig` by worktree path, written by the `pull.config` handler
  and by `putCfg` on save — optimistic, the host echoes it back) and `rulesFor` (which repo the
  sheet opens on; set by `openPullRules`, cleared by the `pull` sheet's `onLeave`).
- Sheet: `pull`, `persisted: true` (in `PERSISTED_OVERLAYS` — it holds no state
  that cannot be re-read offline).
- Wire frames in: `pull.list` (→ `pulls.sync`), `pull.new` (→ `pulls.add`), `pull.config`. Out, via
  `core().conn`: `pull.get` (liveAsk), `pull.save`, `pull.dismiss` (liveSend). Rules are small and
  idempotent, so they are live sends, never durable ops.
- `actions.ts` — `putCfg`, `openPullRules`, `clearRules`, and `bootPull`. `DownloadsSheet.tsx` —
  the sheet (the install surface it links to is the android-apps extension's, opened through
  `appsDoor`). `store.ts` also holds `usePullRecords()`.
- `boot` (`bootPull`): `pulls.start()`, the records mirror, the Automation foot's rule source (`automationSlot.ts`), and the `OPEN_DOWNLOADS_EVENT` listener that opens
  the sheet from a toast or a gallery button.
- No storage keys of its own — `pull.ts` and `installPolicy.ts` own theirs.

**Exports for App**: `usePullRecords()`, `pullSummary(records)` (the menu
chip's bytes-not-files progress), `openPullRules(repoDir)`.

**Settings rows** (`PullSettings.tsx`, Offline & data, order 10): `downloads`, `upload-scale`.

**Stays in App**: `pulls.pump()` on `welcome`, the service-worker `open-pulls` / pull-message
bridge, and the `PullBar` strip (it reads `usePullRecords()`).

**Tests**: `logic.test.mjs` (`pullSummary`); e2e `autopull`.
