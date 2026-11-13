/** A permission mode a SEED put on a send's launch (the vault's plan-mode explainer) and what the model row does with it. Split from `sendLaunch.ts`; pure, no React. */
import { type LaunchOpts } from "@waterplane/shared";
import { type SendTarget } from "./sendTypes.ts";
import { launchOfTarget } from "./sendLaunch.ts";

/** The permission mode a SEED set on a launch: one the new-session defaults do not give. The model row's picks rebuild a launch from the
 *  defaults, so this is the one field they would drop; a mode that equals the defaults' is theirs, not the seed's. */
export const seededMode = (l: LaunchOpts | undefined, defaults: LaunchOpts): LaunchOpts["permissionMode"] =>
  l?.permissionMode && l.permissionMode !== defaults.permissionMode ? l.permissionMode : undefined;

/** A launch the model row writes, with the seed's mode kept (the vault's read-only explainer sets one). */
export const keepSeededMode = (next: LaunchOpts, was: LaunchOpts | undefined, defaults: LaunchOpts): LaunchOpts => {
  const m = seededMode(was, defaults);
  return m ? { ...next, permissionMode: m } : next;
};

/** "Use the defaults" on the model row: no launch at all, or only the seed's mode where it set one. */
export const defaultsLaunch = (was: LaunchOpts | undefined, defaults: LaunchOpts): LaunchOpts | null => {
  const m = seededMode(was, defaults);
  return m ? { permissionMode: m } : null;
};
/** Whether the launch is more than a seed's bare mode: the model row has been used, so "use the defaults" has something to undo. */
export const pickedModel = (l: LaunchOpts | undefined): boolean => !!l && !(Object.keys(l).length === 1 && l.permissionMode);

/** The launch a target gets when the To row's kind returns to a repo/repos: the one it carried, else only the SEED's permission mode (a session
 *  target carries none, so "this session" and back would drop a seeded plan mode). Never the seed's model: one removed on purpose stays removed. */
export const launchOnReturn = (current: SendTarget, seedTarget: SendTarget | undefined): LaunchOpts | undefined => {
  const m = seedTarget && launchOfTarget(seedTarget)?.permissionMode;
  return launchOfTarget(current) ?? (m ? { permissionMode: m } : undefined);
};
