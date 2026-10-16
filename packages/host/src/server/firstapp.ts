/**
 * `createFirstApp(ctx)` — the first-app onboarding job (`onboard.ts`) wired to this host: its
 * builds, intent store and sessions, its progress broadcast as `onboard.progress` over the one
 * socket, its state under `<STATE_DIR>/onboard.json`.
 *
 * Called from `main.ts` AFTER `intents.start()`, so a job a restart interrupted resumes into a
 * running intent loop (its first build is an intent). Never resumed in a doctor run: a resumed
 * job may download a toolchain. Every `ctx` member is read at CALL time, inside a closure.
 */
import { OnboardManager, makeOnboardDeps } from "../onboard.js";
import { hostStateDir } from "../branddirs.js";
import type { ServerCtx } from "./ctx.js";

export function createFirstApp(ctx: ServerCtx): OnboardManager {
  const ob = new OnboardManager(makeOnboardDeps({
    root: ctx.ROOT,
    stateDir: hostStateDir(ctx.ROOT),
    builds: {
      list: (r) => ctx.builds.list(r),
      save: (r, b, local) => ctx.builds.save(r, b, local),
      localIds: (r) => ctx.builds.localIds(r),
      run: (r, id) => ctx.builds.run(r, id),
    },
    intents: {
      get: (id) => ctx.intents.get(id),
      post: (draft, now) => ctx.intents.post(draft, now),
    },
    sessions: {
      list: () => ctx.sessions.list(),
      create: (cwd, o) => ctx.sessions.create(cwd, o),
    },
    recomputeWatched: () => ctx.recomputeWatched(),
    broadcast: (job) => ctx.broadcast({ t: "onboard.progress", job }),
  }));
  if (!ctx.DOCTOR) ob.boot();
  return ob;
}
