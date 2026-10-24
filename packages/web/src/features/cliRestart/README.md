# cliRestart — restart a session on the new `claude` once it is idle

The CLI restart banner (`CliRestartBanner` in `core/Banners.tsx`) offers "Restart, same
conversation" when a session runs an older `claude` than the one installed. A restart now stops a
running turn or background agent; this feature adds the other answer — **When idle**: arm it, and
the restart fires by itself the first time the session has nothing running.

**Owns** (`store.ts`, one writer — `actions.ts`): which sessions are armed, and for which installed
version. In memory: a reload forgets the arm and the banner offers both buttons again. `logic.ts`:
`armVerdict` — fire, wait or drop — using the same "what would a restart stop" test as the banner's
confirm (`shared/clirestart.ts`), plus "none of this session's messages are still queued", because a
held prompt typed at turn end would race the kill.

**Messages**: none of its own. The session frames are App's (one handler per frame), so while
anything is armed a 2 s timer reads `core().world.sessions`; a session gone or exited is disarmed.
The restart is `core().launch.relaunch(s, {}, { quiet: true })`, the one kill + create durable op,
quiet so it neither closes the open sheet nor pulls you to the tab.

**Rules that apply**: at most once per arm (disarmed before the relaunch is queued). An arm for a
version that is no longer the installed one, or a session already on it, is dropped, never fired.
The person armed it; nothing arms itself. The banner shows the armed state and an undo.
