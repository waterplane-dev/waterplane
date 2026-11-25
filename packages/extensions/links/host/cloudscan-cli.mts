/**
 * The program the sign-in command runs for a look (`signin.mts`): the only
 * process of this extension that holds a token. Reads `LINKS_GCLOUD_TOKEN_<n>`, prints one JSON line
 * (a `CloudScan`, no token in it), exits.
 *
 *     node cloudscan-cli.mjs <gcloud>
 */
import { mergeScans, scanCloud } from "./cloudscan.mjs";
import { run } from "./run.mjs";
import { TOKEN_VAR } from "./signin.mjs";

const vars = Object.keys(process.env).filter((k) => k.startsWith(TOKEN_VAR)).sort();
const tokens = vars.map((k) => process.env[k] ?? "").filter(Boolean);
for (const k of vars) delete process.env[k]; // gcloud gets its one token, not every account's
const scans = [];
for (const t of tokens) scans.push(await scanCloud({ run, gcloudBin: process.argv[2] ?? "gcloud", fetch: globalThis.fetch }, t));
process.stdout.write(`${JSON.stringify(mergeScans(scans))}\n`);
