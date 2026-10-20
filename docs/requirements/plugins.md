# plugins

### R-plugins-001 · shipped
An extension may contribute setup checks and their fixes through the host API; the checklist shows them at the place the requirements row always sat, and a contributed row's words are the phone half's `setupRows`.
- asked: 2026-09-30 (session: extensions plan agreed that day, id not recorded)
- shipped: 7633825, 8002346

### R-plugins-002 · shipped
An extension may contribute methods (answered over `plugin.call`) and pushes (`plugin.push`, broadcast, only for its own id); a bad event name, non-JSON or a push over 64 KB is refused in words and nothing is sent.
- asked: 2026-09-30 (session: extensions plan agreed that day, id not recorded)
- shipped: 8002346, a900a3d

### R-plugins-003 · shipped
An extension may contribute repo actions (a line in the repo's more menu) and repo chips. A count on a chip is a filter: a tap opens exactly the counted items, and the opened view says what it hides with 'n of N' and a clear button.
- asked: 2026-09-30 (session: extensions plan agreed that day, id not recorded)
- shipped: 8002346, 17574b5

### R-plugins-004 · shipped
An extension's sheets have open ids of the form `feature:<id>/<name>`, never persisted, without editing the core's overlay list.
- asked: 2026-09-30 (session: extensions plan agreed that day, id not recorded)
- shipped: 8002346

### R-plugins-005 · shipped
The gate refuses in words, and nothing happens, when an extension claims a fix id the core owns or another plugin took (the plugin is listed broken), reads a secret file, reads a path outside the repo (a symlink out reads as absent), or makes a call over 64 KB of args, a result over 512 KB or a non-JSON one.
- asked: 2026-09-30 (session: extensions plan agreed that day, id not recorded)
- shipped: 7633825, 87a408d, 8002346

### R-plugins-006 · shipped
A plugin's web half is never loaded lazily: it is built into the bundle and staged with the OTA update, so its sheets exist with the tunnel down. Each contributed sheet, row, chip and action has its own error boundary, and a throw shows the reason instead of taking the app down.
- asked: 2026-09-30 (session: extensions plan agreed that day, id not recorded)
- shipped: 8002346, 17574b5

### R-plugins-007 · shipped
Handing work to the agent is the backlog add, never a side door: the item waits for a tap unless the plugin says fire. A `key` makes it at-most-once in the store, and it never types into a session directly.
- asked: 2026-09-30 (session: extensions plan agreed that day, id not recorded)
- shipped: 7633825, 87a408d

### R-plugins-008 · shipped
`plugin.call` is a live question, not a queue entry: a doubled frame or a re-sent read runs the handler once, only reads are re-sent after a reconnect, and a write is never replayed. A write that must be at-most-once across a host restart uses the hand-to-agent key. A call pending when the link drops says it may have run.
- asked: 2026-09-30 (session: extensions plan agreed that day, id not recorded)
- shipped: 8002346, a900a3d

### R-plugins-009 · shipped
Extensions import only the SDK and the kit (web) or `@waterplane/shared` and their own folder (host); the core never imports an extension's internals except through the two registries. The boundary is lint-enforced by `local/extension-boundary`.
- asked: 2026-09-30 (session: extensions plan agreed that day, id not recorded)
- shipped: 0a371ac

### R-plugins-010 · shipped
The phone runs plugin UI only as in-repo extensions built into the bundle, never outside the SDK; the invariants (one socket, the queue, the answer gate) are reachable only through it.
- asked: 2026-09-30 (session: extensions plan agreed that day, id not recorded)
- shipped: 0a371ac, 8002346
### R-plugins-011 · shipped
The web app is built from isolated feature folders with one shape, so developers change one folder instead of one large App.tsx.
- asked: 2026-09-24
- shipped: f0de72e, 2fbfbce, 25810bd

### R-plugins-012 · shipped
A plugin mechanism lets users add customizations from outside the waterplane repo.
- asked: 2026-09-27
- shipped: 41585a9

### R-plugins-013 · shipped
A plugin may add a backend (a CLI the launcher spawns) that it declares in its manifest; an undeclared id, a taken id or a reader name this host does not have is refused in words, and switching the plugin off removes the backend so the next create on it is refused in words. Its hooks reach the daemon only over loopback at `/api/plugin/<id>/hook`, where a held response is answered by the phone's tap through the one answer dispatcher, or `{}` when the hold runs out.
- asked: 2026-10-01 (backends design, docs/analysis/backends-design.md §3, WP3a)
- shipped: this change (`plugins/pluginapi.ts` `backend`/`hookSink`/`onHook`, `scripts/e2e-pluginbackend.mjs`)

### R-plugins-014 · shipped
A session still running in tmux on a plugin's backend survives a host restart: it is held until that plugin registers the backend and then taken back, and meanwhile listed as a closed, still-alive row that names the plugin it waits for.
- asked: 2026-10-01 (backends design, docs/analysis/backends-design.md §3 "Boot order", WP3a)
- shipped: this change (`sessions/tmux.ts` `parkedLive`)
### R-plugins-015 · requested
Repo-specific tooling lives in a private plugin, and nothing private is in the public repository.
- asked: 2026-10-07

### R-plugins-016 · requested
The vault plugin has its own visible repo, like the other plugins.
- asked: 2026-10-11

### R-plugins-017 · requested
Public plugins living in other repos get updates that stay compatible with the core, e.g. reshipped with the core.
- asked: 2026-10-13

### R-plugins-018 · requested
Users install plugins without touching the desktop.
- asked: 2026-10-13

### R-plugins-019 · requested
Bundled plugins are enabled by default; their links are included but switched off. No copilot, codex or oracle plugins are offered.
- asked: 2026-10-13

### R-plugins-020 · shipped
Plugin authors are asked to tag their repos with the waterplane-plugin GitHub topic, and the README links to the topic search.
- asked: 2026-10-15
- shipped: 677f572a

### R-plugins-021 · shipped
A minimal example plugin template passes the manifest checks, offers one session action and one setting, and has a README explaining how to install it.
- asked: 2026-10-15
- shipped: 12d9b75b

### R-plugins-022 · shipped
The plugin docs explain installing a plugin, starting from the template, and a curated list of plugins with how to get listed.
- asked: 2026-10-15
- shipped: 4fadc65b

