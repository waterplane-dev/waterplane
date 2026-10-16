/**
 * The CLI as a file to run: `node packages/host/dist/cli/entry.js <command>`. The release's
 * generated `bin/<slug>.mjs` does the same; this one exists in a checkout too, which is what the
 * Windows launcher runs inside WSL for a command the host's own CLI answers (`pair`).
 */
import { main } from "./index.js";

const code = await main(process.argv.slice(2));
// let a piped stdout drain before exiting
await new Promise((r) => process.stdout.write("", r));
process.exit(code);
