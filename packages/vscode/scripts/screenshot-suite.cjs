// Runs INSIDE the VS Code that `screenshot.mjs` launches: opens each view the runner asks for, says
// so through a signal file, and waits for the runner to say it has the picture. No checks — the
// integration suite (`test/integration/suite.cjs`) is the test; this only poses the window.
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(file, ms = 120_000) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${file}`);
    await sleep(200);
  }
}

/** Measure the fictional repo's history, and wait until the series has stopped growing for a while. */
async function measure(ext) {
  await vscode.commands.executeCommand(`${ext}.healthRefresh`);
  const dir = path.join(process.env.WP_SHOT_STORAGE, "health");
  const size = () => {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).map((d) => path.join(dir, d, "repohealth.jsonl")).filter((f) => fs.existsSync(f))
      .reduce((n, f) => n + fs.statSync(f).size, 0);
  };
  const end = Date.now() + 180_000;
  let last = -1, still = 0;
  while (Date.now() < end && still < 8) {
    await sleep(1000);
    const n = size();
    still = n > 0 && n === last ? still + 1 : 0;
    last = n;
  }
  if (!last) throw new Error("the health measure wrote no series");
}

async function run() {
  const sig = process.env.WP_SHOT_SIG;
  const views = process.env.WP_SHOT_VIEWS.split(",");
  const ext = process.env.WP_SHOT_EXT;
  await vscode.extensions.getExtension(`${process.env.WP_SHOT_PUBLISHER}.${ext}`).activate();
  await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
  await vscode.commands.executeCommand("workbench.action.closePanel");
  await vscode.commands.executeCommand(`${ext}.open`);
  await vscode.commands.executeCommand(`workbench.view.extension.${ext}`);
  for (const view of views) {
    if (view === "health") await measure(ext);
    await vscode.commands.executeCommand(`${ext}.show`, view);
    await vscode.commands.executeCommand("notifications.clearAll");
    fs.writeFileSync(path.join(sig, `${view}.req`), view);
    await waitFor(path.join(sig, `${view}.done`));
  }
}

module.exports = { run };
