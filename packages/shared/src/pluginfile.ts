/**
 * `api.offerFile` (plugin API 1.5, `plugin.ts`): one file a plugin wrote into its own `dataDir`,
 * handed to the phone's one download path and deleted by the core once fetched or at its TTL. The
 * host half is `packages/host/src/plugins/pluginfiles.ts`; the reasoning is docs/notes/plugins.md.
 */

/** `api.offerFile`'s options (since 1.5). */
export interface PluginFileOfferOpts {
  /** The name the phone saves it under: letters, digits, `.`, `_`, `-`, space; at most 120. */
  name: string;
  /** How long it may be fetched, ms (default PLUGIN_FILE_TTL_MS, at most PLUGIN_FILE_TTL_MAX_MS). */
  ttlMs?: number;
  /** Called once when the offer ends: fetched (its last byte went out), expired, or withdrawn. */
  onGone?: (why: "fetched" | "expired" | "withdrawn") => void;
}

/** What `api.offerFile` answers: where the phone fetches it, how big it is, until when. */
export interface PluginFileOffer {
  /** App-relative URL path, `/api/plugin-file/<id>/<token>` — the phone downloads it with `files.downloadArtifact({…, src: path})`. */
  path: string;
  size: number;
  expiresAt: number;
  /** End the offer now (the file is deleted). */
  withdraw(): void;
}

export const PLUGIN_FILE_TTL_MS = 10 * 60_000;
export const PLUGIN_FILE_TTL_MAX_MS = 60 * 60_000;
