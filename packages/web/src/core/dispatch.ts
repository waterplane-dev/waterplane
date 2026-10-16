/**
 * The two places the core calls INTO features at run time that are not a
 * sheet: a wire message, and App's mount.
 *
 * `dispatchFeatureMessage` is its own socket listener, registered right AFTER
 * App's `switch (msg.t)` listener: while a message type is still handled in
 * App the order is what it always was, and moving one into a feature is
 * deleting its `case` there. `ws.ts` isolates each listener, so a throw in
 * App's switch cannot starve a feature, and `featureRun.ts` isolates each
 * handler, so one feature's bug cannot stop the next hearing the frame.
 *
 * This file, `sheets.ts`, `settingsRows.ts` and `toolbarItems.ts` are the only
 * modules outside `features/` that import the registry (`local/feature-boundary`).
 */
import type { HostMessage } from "@waterplane/shared";
import { FEATURES } from "../features/registry.ts";
import { core } from "./api.ts";
import { createFeatureRunner } from "./featureRun.ts";
import { pluginCalls } from "./pluginCalls.ts";
import { streamRouter } from "./streamRouter.ts";
// App wires it into `nav.openPlugin` (a tapped plugin alert); it lives with the other registry readers.
export { openPluginFromNotification } from "./extensionPoints.ts";

const RUNNER = createFeatureRunner(FEATURES, core);

export function dispatchFeatureMessage(msg: HostMessage): void {
  pluginCalls().onFrame(msg); // a `plugin.reply` / a reconnect's `welcome`: the generic call channel
  streamRouter().onText(msg); // `stream.*`, plus the `welcome` that reopens and the status edge that parks
  RUNNER.dispatch(msg);
}

/** A toolbar tap no `case` in App handled. False when no feature owns `id`
 *  either, so the caller's own fall-through is unchanged. */
export function runFeatureCommand(id: string): boolean {
  return RUNNER.runCommand(id);
}

/** Every feature's `boot`, once; the returned function runs their cleanups. */
export function bootFeatures(): () => void {
  return RUNNER.boot();
}
