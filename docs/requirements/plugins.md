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
- shipped: this change (`plugins/pluginapi.ts` `backend`/`hookSink`/`onHook`, `scripts/e2e-pluginbackend.mjs`), 3943f989 (descriptor v2)

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


### R-plugins-023 · shipped
A backend plugin says where each fact comes from (turns, dialogs, questions, transcript, context, tokens, usage, limits, agents, conversations) as an ordered list of providers; the first that answers wins and an empty list means the fact is absent on the phone, never guessed. One reader of that list decides what the wire advertises.
- asked: 2026-10-21 (session: backend contract v2 plan, docs/plans/backend-contract-v2.md, id not recorded)
- shipped: 3943f989, 0f6c8763

### R-plugins-024 · shipped
A backend plugin gets a small toolkit instead of copying helpers: bind a session to the CLI's conversation, follow a JSONL file, read the live screen, find its per-session launch files. A 1.x plugin that registers no backend still loads on the 2.x host; one that registers a backend is refused in words naming the 2.0 contract.
- asked: 2026-10-21 (session: backend contract v2 plan, docs/plans/backend-contract-v2.md, id not recorded)
- shipped: 5da43157, d9aa5b6b

### R-plugins-025 · shipped
Every spawned agent is told what the phone offers (outbox, inbox, builds), whichever CLI it is; the launch plan says how it was told, and where a backend cannot be told the phone says so. The ask-before rules hold natively where the CLI has them and through the answer gate where it has only allow and deny.
- asked: 2026-10-21 (session: backend contract v2 plan, docs/plans/backend-contract-v2.md, id not recorded)
- shipped: 6e92af08

### R-plugins-026 · shipped
A question an agent asks with no choice box reaches the phone from any backend that can pose it, and a typed answer, or a reason on a "No" row, goes back into the CLI's own form. Only a person types an answer: a gated plugin never carries words.
- asked: 2026-10-21 (session: backend contract v2 plan, docs/plans/backend-contract-v2.md, id not recorded)
- shipped: ea856e88, aa0e0668

### R-plugins-027 · shipped
A backend can supply its account's usage windows and usage-limit wall, its running subagents and its list of conversations (resume picker, archive, optional fork and delete), and a turn's context reading is the one from that turn's end.
- asked: 2026-10-21 (session: backend contract v2 plan, docs/plans/backend-contract-v2.md, id not recorded)
- shipped: 1ef834a7, 570bd0d4, aa0e0668

### R-plugins-028 · shipped
The plugin manager lists every plugin it can find in the waterplane-dev GitHub org (repos tagged `waterplane-plugin`), installed or not, each with its maturity label (stable, preview, experimental; a plugin that declares none is "unrated", never shown as stable) and an install button. A curated public catalogue for outside authors is later, not now.
- asked: 2026-10-23
- shipped: fb0cb3c0, 960d75fd, 645751cf, 58a89d29, fb5061cc, 84b05d48

### R-plugins-029 · shipped
A person can add a plugin by its git URL; a repo with no valid plugin manifest is refused in words and nothing is left behind, and the confirm says plainly when the code is not from waterplane-dev and that it runs with full access to the desktop.
- asked: 2026-10-23
- shipped: fb0cb3c0, 960d75fd, 645751cf, 58a89d29, fb5061cc, 84b05d48

### R-plugins-030 · shipped
An installed plugin shows an update button when its repo holds a newer release tag (untagged repos track the default branch and say so); install and update only ever happen on a tap, and the row says when a restart is needed to load the change.
- asked: 2026-10-23
- shipped: fb0cb3c0, 960d75fd, 645751cf, 58a89d29, fb5061cc, 84b05d48

### R-plugins-031 · shipped
A plugin that declares npm dependencies is refused at install in words; plugins are zero-dependency for now.
- asked: 2026-10-23
- shipped: fb0cb3c0, 960d75fd, 645751cf, 58a89d29, fb5061cc, 84b05d48
