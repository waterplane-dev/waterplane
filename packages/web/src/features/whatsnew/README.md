# whatsnew — What's new, phone side

The owner found a release's new things "kind of distributed": a switch in Downloads, a bell that
counts differently, Automation renamed, a burn sheet. This feature is the one place that lists them
per release, says each one's state on this phone and desktop, and opens the exact place it lives.
It is not a changelog (that is prose and not in the bundle) and not a second Automation list or feed:
it links to those.

**Sheet**: `whatsnew` (not persisted), "What's new · 0.1.8", with a `FilterChip` per kept release
(current and previous). Each row: title, one line, a state line, one door. Rows are hand-written in
`logic.ts`'s `RELEASES`. **A state is read from facts the phone already holds** : the feed through
`feedSlot.ts` (handed over by `features/notifications` at boot), the rule list and repos via
`core().world`, the week-end burn through its sheet's `useRemoteResource` key (fresh only), the
shell's version and Downloads switch asked once (`useHubFacts`, `store.ts`). **A fact not read is null and draws no state line.**

**Entry points**: a one-time launcher row (`WhatsNewLauncherRow.tsx`, mounted by
`core/launcher/LauncherScreen.tsx`) while the desktop's version (`updates.status.self.current`,
heard here too) has rows and differs from `LS.whatsNewSeen` (device scope); *see them* and *got it*
both retire it, and so does opening the sheet. Durable: Settings › Tools & diagnostics › *what's new*
(`whats-new`), and a *what's new* button on the Updates sheet's waterplane row.

**Owns**: `logic.ts` (row view, APK gate, announce rule, launcher wording, failure parsing, the rows;
`logic.test.mjs`), `store.ts` (seen version, desktop version, the facts hooks), `actions.ts` (doors,
`markSeen`, `openWhatsNew`), the sheet, the launcher row, the Settings door.

**Rules**: a count on a row is a filter — *see those 2* opens the feed cut to exactly those failure
items (the same `repoChipItems` the repo chips use), *see those 2* builds opens Automation cut by
ids. Nothing applies itself: every door opens a screen. An APK-gated row says why in words
(`apkGate.ts`, shared with the Downloads sheet) and offers the APK. No badges, no "new" pills.
