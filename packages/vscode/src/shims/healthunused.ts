/**
 * Replaces BOTH `tools/repohealth/narrate.mjs` and `tools/repohealth/html.mjs` in the bundled engine
 * (esbuild `health-unused`). Those two are the engine steps that WRITE into the measured folder
 * (`.claude/outbox/repohealth.md` and `.html`); the extension never runs them (healthrun's steps
 * are `update`, `status`, `plot`), so neither ships — and neither does the outbox path they name.
 * Every function either module exports is here and refuses; their constants are left out, as
 * nothing the engine bundles reads them.
 */
const NO = "narrate and html are not part of the extension: they write into the folder, and nothing here does.";
const refuse = (): never => { throw new Error(NO); };

// narrate.mjs
export function ledgerFile(_root: unknown): never { return refuse(); }
export function events(_prev: unknown, _next: unknown, _prereg: unknown, _deps?: unknown): never { return refuse(); }
export function render(_evs: unknown): never { return refuse(); }
export function mergeNarrative(_existing: unknown, _body: unknown): never { return refuse(); }
export function narrate(_opts: unknown): never { return refuse(); }
// html.mjs
export function packageSeries(_days: unknown, _limit?: unknown): never { return refuse(); }
export function htmlDoc(_days: unknown, _opts?: unknown): never { return refuse(); }
export function writeHtml(_opts?: unknown): never { return refuse(); }
