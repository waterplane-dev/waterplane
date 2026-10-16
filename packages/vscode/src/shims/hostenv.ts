/**
 * The host's `env.ts`, as the extension bundles it — the ONE adapted module.
 *
 * `packages/host/src/env.ts` is the daemon's boot module: it reads `.env`
 * files, picks the code root and migrates state directories at import. None of
 * that belongs inside a VS Code extension, and the modules bundled from the host
 * (`claudeconfig.ts`, `agents.ts` via `ctxproject.ts`) only ever ask it for the
 * four knob readers. So `esbuild.mjs` redirects their `./env.js` here, and this
 * exports exactly those four names (env.ts's `makeEnvReader` export), over the
 * extension host's own `process.env`, read at call time.
 *
 * The legacy-name warning is dropped: there is no log a person reads, and an
 * extension printing to the console on a knob nobody set is noise.
 */
import { makeEnvReader } from "@waterplane/shared";

export const { env, envStr, envBool, envInt } = makeEnvReader(process.env, () => {}, undefined);
