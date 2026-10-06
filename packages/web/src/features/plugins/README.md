# plugins — installed waterplane plugins, and the decision log

A waterplane plugin is code the machine's owner installs on the DESKTOP (outside this repo) that extends
the daemon; see `docs/notes/plugins.md` and the contract `packages/shared/src/plugin.ts`. **The
phone never runs plugin code.** A plugin declares settings fields, actions, per-session toggles, a
badge and a status line; this folder draws those with the app's own controls. The in-core Gemini
oracle that used to live in `features/oracle` is now such a plugin.

**Owns**
- stores (`store.ts`): `plugins` (`plugin.list`), `results` (one per action button, by `actionKey`,
  pending until `plugin.actionResult` with the same `reqId`), `errors` (the last refused
  `plugin.set`/`plugin.enable`, verbatim from `plugin.error`, or a typed value the phone refused
  before sending), `decisions` (`decisions.log`), `decisionScope` (the session the log is cut to).
- `PluginsSettings.tsx`: Tools' one catalogued row `plugins` with a section per plugin inside it
  (name, version, description, source path, state with the load error verbatim, the enable
  switch, status line, env names set/unset — never values — fields by kind, global actions), and
  the rack door `tool-decisions`. Empty: "No plugins installed" and where they go.
- `PluginsToolbar.tsx`: the session menu's `plugins` item (toggles, the core-owned "let <name>
  answer" switch, session actions) and `PluginBadges` for a session row.
- `DecisionLogSheet.tsx`: overlay `decisions` (not persisted) — limit rows and plugin rows, a
  source filter that says "n of N", archive/delete/archive-all.
- wire frames in: `plugin.list`, `plugin.actionResult`, `plugin.error`, `decisions.log`. Out:
  `plugin.list|set|enable|action|sessionToggle|sessionAnswer`, `decisions.get|archive|delete|archiveAll`.
- exports for core: `openDecisions(sessionId | null)`, `PluginBadges`, `usePlugins()`.

**Reads from `core()`**: `conn` (liveSend/liveAsk/send/status), `nav`, `world.sessions`,
`say.toast`/`track`. No storage keys.

**Tests**: `logic.test.mjs` (state line, env rows, field parsing, one-key `plugin.set`, which
toggles/actions a session shows, toggle-to-default, badges, the decision-log cut).
