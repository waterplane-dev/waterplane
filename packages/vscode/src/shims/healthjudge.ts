/**
 * Replaces `tools/repohealth/judge.mjs` in the bundled engine (esbuild `health-judge`): the one
 * engine module that starts a paid `claude` is not shipped. Every function it exports exists and
 * refuses; its `OUTBOX_DIR` constant is left out (only judge.mjs itself read it), so no outbox path ships.
 */
const NO = "judge is not part of the extension: it would spend tokens, and nothing here does.";
const refuse = (): never => { throw new Error(NO); };

export function slug(_id: unknown): never { return refuse(); }
export function outPath(_id: unknown): never { return refuse(); }
export function bundle(_event: unknown, _root: unknown, _deps?: unknown): never { return refuse(); }
export async function run(_b: unknown, _opts?: unknown): Promise<never> { return refuse(); }
