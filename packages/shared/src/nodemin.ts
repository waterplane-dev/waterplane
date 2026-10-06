/**
 * The oldest Node the host runs on — ONE number, so the root `package.json`
 * `engines`, the doctor's `node` row and the early refusal in `env.ts` /
 * `cli/index.ts` cannot disagree (`packages/host/test/nodepin.test.mjs` holds
 * `engines` to it, and `.nvmrc` to `deploy/node-version`'s major).
 *
 * 20.12 because the host reads `.env` files with `util.parseEnv` (20.12) and
 * reads `import.meta.dirname` at import (`env.ts`, `cli/index.ts`,
 * `webbundle.ts`; 20.11): before that the daemon dies in `path.resolve` before
 * the doctor could say why. `envfiles.ts` imports `node:util` as a namespace so
 * an older Node still LINKS and reaches the refusal. Everything newer the host
 * uses (`node:sqlite`, 22.5) degrades to an absent reader.
 */
export const NODE_MIN = "20.12.0";

/** True when `version` (`process.versions.node`, a leading `v` allowed) is at least `NODE_MIN`. Unparseable ⇒ false. */
export function nodeMeetsMin(version: string, min: string = NODE_MIN): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** The one sentence a too-old Node is refused with, before anything else runs. */
export function nodeTooOldSentence(version: string): string {
  return `Node ${version} is too old: this host needs Node ${NODE_MIN} or newer (it uses util.parseEnv and import.meta.dirname). ` +
    `Install a current Node (the release installer pins one) and run it again.`;
}
