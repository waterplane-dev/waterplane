/**
 * Plugins — the contract between the daemon, the phone, and code a user
 * provides from OUTSIDE this repo. Reasoning: docs/notes/plugins.md.
 *
 * A plugin EXTENDS the daemon. It is a directory with a manifest (`PLUGIN_MANIFEST`) (the
 * `PluginManifest` below) and a HOST module (`host.mjs`, ESM) the daemon
 * imports and calls `activate(api: HostPluginApi)` on. It runs in the daemon's
 * process with the daemon's trust — the daemon already spawns `claude`, so a
 * plugin crosses no boundary the daemon has not — but it only SEES what the API
 * hands it, so the core's rules (the answer gate, containment, metering) cannot
 * be skipped by accident.
 *
 * Not to be confused with what makes a REPO aware of the product (the core's own
 * skill, handed to every spawned `claude`): that is the daemon telling a
 * repo's agent what it offers, owned by the core, and no plugin's business.
 *
 * The phone runs a plugin's UI only as an in-repo extension's web half, built
 * into the bundle (docs/notes/plugins.md, "Trust") — never loaded lazily, never
 * outside the SDK. A plugin with no UI code DECLARES what it shows here
 * (settings fields, action buttons, per-session switches, a badge, a status
 * line, rows in the decision log, a suggested answer) and the app's own
 * components draw it.
 *
 * Pure types + a validator. Both ends and plugin authors read this file.
 *
 * The same `HostPluginApi` is handed to the IN-REPO extensions under
 * `packages/extensions/<id>/` (the static registry, always on) — one object
 * shape for both, so moving an extension out of the repo is a folder move.
 */
export * from "./plugin/version.js";
export * from "./plugin/manifest.js";
export * from "./plugin/api.js";
export * from "./plugin/backend.js";
export * from "./plugin/module.js";
export * from "./pluginreadings.js";
export * from "./pluginlaunch.js";
