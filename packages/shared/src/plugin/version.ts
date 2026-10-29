
/**
 * The plugin API's version, semver `MAJOR.MINOR.PATCH`. It versions everything a plugin
 * author builds against: `HostPluginApi`, the manifest (`PluginManifest`), the event
 * payloads, the module shape (`HostPluginModule`) and the backend descriptor
 * (`PluginBackendDef`).
 *
 * **Compatibility rule** (`pluginApiProblem`, run by the loader on every manifest): a
 * plugin declaring `apiVersion` `A.B` loads on a host speaking `X.Y` exactly when
 * `A === X` and `B <= Y`. Anything else is refused with a sentence and the plugin is
 * listed broken (`state: "error"`), never loaded half-way. The patch number is not
 * compared: a plugin cannot depend on one.
 *
 * A bare number (`"apiVersion": 1`, every manifest written before semver) means `1.0`.
 *
 * **What bumps what:**
 * - MAJOR (breaking): removing or renaming anything exported here; changing a member's
 *   type so an existing call no longer compiles or no longer means the same; making an
 *   optional field required, on either side; a manifest field the loader newly REFUSES;
 *   a call that used to succeed now throwing or being refused for input it used to
 *   accept; an event a plugin relied on no longer firing.
 * - MINOR (additive): a new API method, event, manifest field, optional field, backend
 *   cap or reader name. A plugin using one declares the new minor, so an older host
 *   refuses it in words instead of failing at the first call.
 * - PATCH: wording, documentation and fixes that change no shape — nothing a plugin
 *   can observe through types.
 *
 * **2.0** (backend contract v2, `PLUGIN_API_V2_DOC`): `PluginBackendDef` replaces the v1
 * reader caps (`hooks`, `promptBoxes`, `transcript`, `contextMeter`, `usageLimits`,
 * `usageProbe`, `asking`, `forkVia` inside caps) with `facts` — one ordered provider list per
 * fact — and `launchArgs` with an async `prepare`; it adds `measured`. A 1.x manifest that
 * lists `backends` is refused in words; there is no shim. Everything else in 2.0 is additive,
 * so a 1.x plugin that registers NO backend (a reader, a panel, a usage probe) still loads:
 * `V1_LAST_MINOR` is the newest 1.x it may declare.
 *
 * **2.1** (additive): `HostPluginApi.supports` (`dialogKeysThenTyped`), and a source turn's
 * `ended(at)` waits ≤1.5 s for a `sources.context` sample stamped `>= at` — no end-gate hold needed.
 * **2.2** (additive, `docs/plans/backend-parity-v3.md` §7): facts + slots `mode`/`commands`, Tab and
 * Shift+Tab in `SourceKeys`, context `window` + `compactions`, `tokens.session`. 2.1 plugins load as-is.
 * **2.3** (additive, `docs/analysis/backend-parity-v3/c2.md`): `caps.spendUnit` (a native session-budget
 * unit) and `BackendTokensDoc.hourly` (a ledger cut to a period or week window, beside claude's
 * figure). 2.2 plugins load as-is; an older host ignores both.
 */
export const PLUGIN_API_VERSION = "2.3.0";

/** Where the 2.0 backend contract is written down; the 1.x refusal names it. */
export const PLUGIN_API_V2_DOC = "docs/plans/backend-contract-v2.md";

/** The last 1.x minor: a 1.0–1.8 plugin with no `backends` in its manifest loads on 2.x. */
export const V1_LAST_MINOR = 8;


/** A parsed `MAJOR.MINOR.PATCH`. */
export interface PluginApiVersion { major: number; minor: number; patch: number }

/** Parse a manifest's `apiVersion`: a semver string (`"1.2"` or `"1.2.3"`) or a bare
 *  non-negative integer (`1` ⇒ `1.0.0`). Anything else ⇒ null. */
export function parsePluginApiVersion(v: unknown): PluginApiVersion | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 ? { major: v, minor: 0, patch: 0 } : null;
  if (typeof v !== "string") return null;
  const m = /^(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?$/.exec(v.trim());
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) } : null;
}

/**
 * Why a plugin declaring `declared` cannot load on a host speaking `host`
 * (default: this one), in a sentence — or null when it can. The rule is
 * `PLUGIN_API_VERSION`'s: same major, minor no newer than the host's.
 */
export function pluginApiProblem(declared: unknown, host: string = PLUGIN_API_VERSION, opts: { backends?: boolean } = {}): string | null {
  const h = parsePluginApiVersion(host);
  if (!h) throw new Error(`PLUGIN_API_VERSION ${host} is not semver`);
  const range = `${h.major}.0 up to ${h.major}.${h.minor}`;
  const said = `apiVersion is ${JSON.stringify(declared)}; this daemon speaks ${host}`;
  const d = parsePluginApiVersion(declared);
  if (!d) return `${said}, and loads plugins written for ${range} — "apiVersion" must be a version like "${h.major}.${h.minor}"`;
  // 2.0 broke only the backend descriptor: a 1.x plugin registering no backend is unaffected.
  if (h.major === 2 && d.major === 1 && d.minor <= V1_LAST_MINOR && opts.backends === false) return null;
  if (d.major !== h.major) {
    // A 1.x plugin on a 2.x daemon: v1 is broken, not shimmed — the sentence names where 2.0 is written down.
    const where = d.major < h.major && h.major === 2 ? ` — the 2.0 contract is ${PLUGIN_API_V2_DOC}` : "";
    return `${said}, and loads plugins written for ${range}; ${d.major > h.major ? "this plugin needs a newer daemon" : "this plugin was written for an older API and must be updated"}${where}`;
  }
  if (d.minor > h.minor) return `${said}, and loads plugins written for ${range}; this plugin needs a newer daemon`;
  return null;
}

