# waterplane plugin template

A minimal working [waterplane](https://github.com/waterplane-dev/waterplane) plugin: one session
action (**Save screen**, in a session's toolbar menu) and one setting (**Lines to save**, in the
plugin's section of Settings). Tapping the action writes the last lines of that session's screen to
a text file in the plugin's data folder (`<state dir>/plugins/plugin-template/`) and says where.

This folder is meant to become a GitHub template repo (`waterplane-dev/waterplane-plugin-template`),
so a new plugin starts with **Use this template** instead of a copy from here.

## Install it

Either copy the folder into the plugins directory:

```bash
cp -r examples/plugin-template ~/.config/waterplane/plugins/plugin-template
```

or keep it where it is (or in its own git repo) and list its path in
`~/.config/waterplane/plugin-paths.json`:

```json
{ "paths": ["~/code/my-waterplane-plugin"] }
```

Then `npm run restart` in the waterplane checkout: plugins load once at boot. The plugin appears in
Settings; a broken one is listed there with the reason, never skipped in silence.

## Make it yours

1. Change `id` (lowercase letters, digits, dashes), `name` and `description` in
   `waterplane-plugin.json`.
2. Replace the action and the setting with your own. What a manifest may declare and what `api`
   offers `host.mjs`: [docs/plugins-api.md](https://github.com/waterplane-dev/waterplane/blob/main/docs/plugins-api.md).
3. Keep `apiVersion` at the oldest API version whose features you use. This template uses only
   `1.0` features, so it loads on every 1.x host.
4. Publish it in its own repo and **add the `waterplane-plugin` topic** to that repo (the gear next
   to *About* on its GitHub page), so people can
   [find it](https://github.com/topics/waterplane-plugin). To be listed in waterplane's own
   [plugin list](https://github.com/waterplane-dev/waterplane/blob/main/docs/plugins.md), open an
   issue or a pull request there.

## Trust

A plugin's `host.mjs` runs inside the waterplane daemon with the daemon's rights. Install only
plugins whose code you have read or whose author you trust.
