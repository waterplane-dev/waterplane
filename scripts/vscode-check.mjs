// `npm run test:vscode`: the VS Code extension's typecheck, tests and package check.
// packages/vscode bundles host and web modules from SOURCE (no shared npm package), so a change
// to one of them can break the extension while every root test stays green — esbuild does not
// typecheck, and a renamed export only fails inside the .vsix. The pre-push gate runs this on every
// non-docs push (~8 s). The extension keeps its own lockfile outside the root workspaces, so its
// deps are a separate `npm ci`; say that instead of failing on "vsce: command not found".
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const dir = "packages/vscode";
if (!existsSync(`${dir}/node_modules/@vscode/vsce/package.json`)) {
  console.error(`[vscode-check] the extension's dependencies are not installed — run \`npm ci --prefix ${dir}\`, then run this again.`);
  process.exit(1);
}
const r = spawnSync("npm", ["run", "check"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);
