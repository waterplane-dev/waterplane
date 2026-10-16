# waterplane plugins

A plugin adds your own buttons, settings and readings to waterplane without forking it: a small
folder outside this repo with a manifest (`waterplane-plugin.json`) and a host module (`host.mjs`).
The app draws what it declares with its own components, and you keep pulling upstream.

The contract, generated from the source: [plugins-api.md](plugins-api.md). Why it is shaped this
way: [notes/plugins.md](notes/plugins.md).

## Install a plugin

1. Put the plugin's folder in `~/.config/waterplane/plugins/`, or keep it anywhere (its own git
   checkout, say) and list its path in `~/.config/waterplane/plugin-paths.json`:

   ```json
   { "paths": ["~/code/some-waterplane-plugin"] }
   ```

2. `npm run restart` in your waterplane checkout. Plugins load once at boot.
3. The plugin appears in Settings with its own section and an on/off switch. One that cannot load
   is listed there with the reason in words.

A plugin's `host.mjs` runs inside the daemon with the daemon's rights, the same rights that spawn
`claude`. Install only plugins whose code you have read or whose author you trust.

## Write one: start from the template

[`examples/plugin-template/`](../examples/plugin-template/) is a minimal working plugin: one button
in a session's menu (**Save screen**) and one setting (**Lines to save**). Copy it, change the id
and name, and replace the action with your own; its README says how.

When you publish your plugin, **tag its GitHub repo with the `waterplane-plugin` topic** (the gear
next to *About* on the repo page). Every tagged repo shows up in one search,
[github.com/topics/waterplane-plugin](https://github.com/topics/waterplane-plugin), which is how
people find plugins and how this project sees that they exist: a plugin is not a fork, so it is
counted nowhere else.

## Plugins

None listed yet.

**To get yours listed:** tag the repo with `waterplane-plugin`, then open a pull request adding one
line here (name, link, one sentence on what it adds) or an issue with the link. A listed plugin
has a README that says what it does and which `apiVersion` it needs, and loads on the current
release without errors.
