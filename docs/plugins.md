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

A plugin can also add a whole CLI to the launcher (a backend). That is a bigger contract, written
down in [plugins-api.md](plugins-api.md) (`PluginBackendDef`) and in
[notes/plugins.md](notes/plugins.md#backends-apibackend-hooksink-onhook); the template's README
points at a complete small example. A plugin written for API 1.x that adds no backend still loads;
one that adds a backend must be ported to 2.x.

When you publish your plugin, **tag its GitHub repo with the `waterplane-plugin` topic** (the gear
next to *About* on the repo page). Every tagged repo shows up in one search,
[github.com/topics/waterplane-plugin](https://github.com/topics/waterplane-plugin), which is how
people find plugins and how this project sees that they exist: a plugin is not a fork, so it is
counted nowhere else.

### The manifest's `maturity`

Add `"maturity": "stable"`, `"preview"` or `"experimental"` to `waterplane-plugin.json` to say how
ready it is; the phone prints it beside the plugin. Leave it out and the plugin shows as *Unrated*.

### Getting into the phone's plugin list

waterplane's own phone lists the public repos of the `waterplane-dev` GitHub org that carry the
`waterplane-plugin` topic **and** have a release tag (a plugin with no tag is installed from its
default branch and shown as untagged). Publishing there needs both. A plugin can have no
`dependencies` in its `package.json`: the manager never runs `npm install`. A public catalogue for
authors outside the org is planned, not built; until then anyone can still install your plugin by
pasting its repo address.

## Plugins

None listed yet.

**To get yours listed:** tag the repo with `waterplane-plugin`, then open a pull request adding one
line here (name, link, one sentence on what it adds) or an issue with the link. A listed plugin
has a README that says what it does and which `apiVersion` it needs, and loads on the current
release without errors.
