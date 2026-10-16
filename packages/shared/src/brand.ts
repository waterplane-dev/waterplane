/**
 * Everything that says which product this is. Pure data, no fs, no env.
 *
 * The point of this file is that the NEXT rename edits the values below and
 * nothing else in `packages/*\/src`: every brand-bearing identifier is a field
 * here, and every reader of an old one falls back through `LEGACY`. The file's
 * own name, the helper names and every identifier elsewhere stay free of the
 * word on purpose. What cannot import this (JSON, XML, Java, shell, html) is
 * enumerated by `tools/brand.test.mjs`, which is the next rebrand's checklist.
 */

/** The identifiers a running install depends on — one set per identity. */
export interface BrandIds {
  /** Display, UI, docs, log tag. */
  name: string;
  /** npm, skill id, binary, temp prefixes. */
  slug: string;
  /** Prefix of every environment knob, `<prefix>PORT`. */
  envPrefix: string;
  /** `~/.config/<x>`, `~/.local/share/<x>`, `~/.local/state/<x>` (the daemon's global state). */
  configDirName: string;
  /** `<repo>/<x>` (per-repo state); `<root>/<x>` only as the OLD home of the global state, moved out at boot. */
  stateDirName: string;
  /** localStorage keys; a parked host's keys sit under `<prefix>h.<id>.`. */
  storagePrefix: string;
  /** IndexedDB database and Cache API prefix. */
  cacheName: string;
  /** WebSocket subprotocol; the token rides as `<wsProtocol>-tok.<token>`. */
  wsProtocol: string;
  /** The LAN auth cookie. */
  cookie: string;
  /** The pairing deep-link scheme, `<scheme>://pair`. */
  pairScheme: string;
  /** The launchd job label. */
  launchdLabel: string;
  /** Android applicationId. */
  appId: string;
  /** tmux `-L` server name; sessions are `<tmuxServer>_<id>`. */
  tmuxServer: string;
  /** A plugin's manifest file name. */
  pluginManifest: string;
  /** The `--plugin-dir` skill handed to every driven repo (`<skill>:<skill>`). */
  skillName: string;
}

export interface Brand extends BrandIds {
  /** `<repo>/<x>` — per-repo config meant to be COMMITTED (today `builds.json`), beside the
   *  gitignored state dir. New with this identity, so no legacy name and no fallback. */
  sharedDirName: string;
  /** What a person reads in the UI. Lowercase is the decision, not an accident. */
  displayName: string;
  tagline: string;
  domain: string;
  githubOrg: string;
  /** Short forms the repo-facing skill text accepts in prompts — never branding. */
  promptAliases: readonly string[];
  /** Seeded into the dictation prompt so the name is spelled right. */
  dictationTerms: readonly string[];
}

export const BRAND: Brand = {
  name: "waterplane",
  displayName: "waterplane",
  slug: "waterplane",
  envPrefix: "WATERPLANE_",
  configDirName: "waterplane",
  stateDirName: ".waterplane",
  sharedDirName: ".waterplane-shared",
  storagePrefix: "waterplane.",
  cacheName: "waterplane-cache",
  wsProtocol: "waterplane",
  cookie: "waterplane_auth",
  pairScheme: "waterplane",
  launchdLabel: "dev.waterplane.host",
  appId: "dev.waterplane.app",
  tmuxServer: "waterplane",
  pluginManifest: "waterplane-plugin.json",
  skillName: "waterplane",
  tagline: "The CLI wasn't built for your phone. waterplane lands it anyway.",
  domain: "waterplane.dev",
  githubOrg: "waterplane-dev",
  promptAliases: ["WP", "wp"],
  dictationTerms: ["waterplane"],
};

/** A past identity, plus the words a ratchet looks for to find what is left of it. */
export interface LegacyBrand extends BrandIds {
  words: readonly string[];
}

/** Cumulative: every past identity, NEWEST FIRST. Readers fall back through it
 *  in order. An entry is removed only by the cleanup release that follows the
 *  rename which made it legacy, never by the rename itself. */
export const LEGACY: readonly LegacyBrand[] = [
  {
    name: "USMC",
    slug: "usmc",
    envPrefix: "USMC_",
    configDirName: "usmc",
    stateDirName: ".usmc",
    storagePrefix: "usmc.",
    cacheName: "usmc-cache",
    wsProtocol: "usmc",
    cookie: "usmc_auth",
    pairScheme: "usmc",
    launchdLabel: "com.usmc.host",
    appId: "dev.unsuck.amc",
    tmuxServer: "usmc",
    pluginManifest: "usmc-plugin.json",
    skillName: "usmc",
    words: ["usmc", "unsuck", "un-suck"],
  },
];

/** Every word, current and past, the brand-literal lint rule and the ratchet
 *  test look for (lowercase; both match case-insensitively). */
export const BRAND_WORDS: readonly string[] = [
  ...new Set([BRAND.name.toLowerCase(), BRAND.slug.toLowerCase(), ...LEGACY.flatMap((l) => l.words)]),
];

/** A localStorage key under the current prefix. */
export const lsKey = (name: string): string => `${BRAND.storagePrefix}${name}`;
/** Every legacy spelling of the same key, newest first. */
export const legacyLsKeys = (name: string): string[] => LEGACY.map((l) => `${l.storagePrefix}${name}`);
/** An environment knob's current name: `envName("PORT")`. */
export const envName = (key: string): string => `${BRAND.envPrefix}${key}`;
/** Every legacy name of the same knob, newest first. */
export const legacyEnvNames = (key: string): string[] => LEGACY.map((l) => `${l.envPrefix}${key}`);
/** A tmux session name on the current server. */
export const tmuxName = (id: string): string => `${BRAND.tmuxServer}_${id}`;
/** The console tag every host log line opens with. */
export const logTag = `[${BRAND.slug}]`;
/** Every past identity's state dir name, newest first (`.<x>` under a root or a repo). */
export const legacyStateDirNames: readonly string[] = LEGACY.map((l) => l.stateDirName);
/** A path inside a REPO's current state dir: `stateRel("assess-in.json")`. */
export const stateRel = (name: string): string => `${BRAND.stateDirName}/${name}`;
/** A path inside a REPO's committed config dir: `sharedRel("builds.json")`. */
export const sharedRel = (name: string): string => `${BRAND.sharedDirName}/${name}`;

/** The dev flavor's applicationId suffix (`applicationIdSuffix` in android/app/build.gradle). The
 *  play flavor is the bare `BRAND.appId`; the release tooling refuses it as a sideload asset. */
export const DEV_APPID_SUFFIX = ".dev";
/** The sideloadable (dev flavor) APK's applicationId for a brand's appId. */
export const devApplicationId = (appId: string = BRAND.appId): string => `${appId}${DEV_APPID_SUFFIX}`;
/** The release asset's file name: `release:build --apk` writes it, `pair.ts` `releaseApkUrl` links it. */
export const releaseApkName = (slug: string, version: string): string => `${slug}-${version}.apk`;
