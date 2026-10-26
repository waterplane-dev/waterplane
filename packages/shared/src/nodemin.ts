/**
 * The oldest Node the host runs on — ONE number, so the root `package.json`
 * `engines`, the doctor's `node` row and the early refusal in `env.ts` /
 * `cli/index.ts` cannot disagree (`packages/host/test/nodepin.test.mjs` holds
 * `engines` to it, and `.nvmrc` to `deploy/node-version`'s major).
 *
 * 22.12 because Node 20 reached end of life on 2026-04-30 and 22 is the oldest
 * line still getting security fixes (to 2027-04-30; the exposure watch's A7
 * reads this floor). The hard needs are older: `util.parseEnv` (20.12) for `.env`
 * files and `import.meta.dirname` at import (`env.ts`, `cli/index.ts`,
 * `webbundle.ts`; 20.11): without them the daemon dies in `path.resolve` before
 * the doctor could say why. `envfiles.ts` imports `node:util` as a namespace so
 * an older Node still LINKS and reaches the refusal. Everything newer the host
 * uses (`node:sqlite`, 22.5) degrades to an absent reader.
 */
export const NODE_MIN = "22.12.0";

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
