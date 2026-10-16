// The product's name, for the scripts that cannot spell it.
//
// Every e2e script reads its env knobs, temp prefixes, state dir, subprotocol
// and pair scheme from here, which reads them from `packages/shared/src/brand.ts`
// (via the built `dist`, so `npm run build` precedes any e2e run). The next
// rename edits brand.ts and touches none of the scripts.
import { join } from "node:path";
import { BRAND, LEGACY } from "../packages/shared/dist/brand.js";

/** `E.PORT` is the current spelling of the PORT knob: `{ [E.PORT]: "8795" }`. */
export const E = new Proxy({}, { get: (_t, key) => (typeof key === "string" ? `${BRAND.envPrefix}${key}` : undefined) });
/** The previous identity's spelling of a knob, for the one test of the fallback. */
export const LEGACY_E = new Proxy({}, { get: (_t, key) => (typeof key === "string" ? `${LEGACY[0].envPrefix}${key}` : undefined) });

export const NAME = BRAND.name;
/** The GitHub org the public repos live under (`deploy/public-media.json`'s `{org}`). */
export const GITHUB_ORG = BRAND.githubOrg;
/** Temp-dir / file-name prefix: `mkdtempSync(join(tmpdir(), `${SLUG}-ack-`))`. */
export const SLUG = BRAND.slug;
/** `<root>/<STATE>` and `<repo>/<STATE>`. */
export const STATE = BRAND.stateDirName;
export const LEGACY_STATE = LEGACY[0].stateDirName;
/** `<repo>/<SHARED>` — the committed per-repo config dir (`builds.json`). */
export const SHARED = BRAND.sharedDirName;
/**
 * The env that names a throwaway root AND the host's global state dir:
 * `{ ...rootEnv(ROOT) }` where a script used to set `[E.ROOT]` alone. The state
 * dir is pinned to `<root>/<STATE>` — the host's "same" case, so no boot move —
 * because the host's default (`~/.local/state/<name>`) is the DEVELOPER'S own
 * state: an e2e host that named only a root would read and write the real
 * ack ledger, sessions and settings. Pinned here, every `join(ROOT, STATE, …)`
 * a script reads stays the file the host wrote.
 */
export const rootEnv = (root) => ({ [E.ROOT]: root, [E.STATE_DIR]: join(root, BRAND.stateDirName) });
/** Prefix of every phone-synced settings key (`${LS}pad`). */
export const LS = BRAND.storagePrefix;
export const WS_PROTOCOL = BRAND.wsProtocol;
export const LEGACY_WS_PROTOCOL = LEGACY[0].wsProtocol;
export const PAIR_SCHEME = BRAND.pairScheme;
export const PLUGIN_MANIFEST = BRAND.pluginManifest;
export const LEGACY_PLUGIN_MANIFEST = LEGACY[0].pluginManifest;
/** A tmux session name on the brand's server: `tmuxSession(id)`. */
export const tmuxSession = (id) => `${BRAND.tmuxServer}_${id}`;
/** The scaffolded CLAUDE.md heading the setup check looks for. */
export const CONVENTIONS = `${BRAND.name} conventions`;
export const APP_ID = BRAND.appId;
