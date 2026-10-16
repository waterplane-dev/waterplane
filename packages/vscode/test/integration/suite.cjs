// Runs INSIDE a real VS Code's extension host, against the extension unpacked from the .vsix
// (`run.mjs` launches it). It drives the extension only through VS Code's public API and checks
// what that API can see: activation, the commands, the panel tab, and the files the corpus
// scan and the health measure write into this extension's global storage. What the API cannot see
// — whether a webview rendered — it asks `run.mjs` to read over DevTools (`webviews.mjs`). A
// failed check rejects `run()`, which makes VS Code exit non-zero.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const ID = "waterplane-dev.waterplane";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, ok, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await ok();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
    await sleep(250);
  }
}

const panelTab = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs)
  .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith("waterplane"));

/** Ask run.mjs to look inside the open webviews; resolves to its `{ ok, why }`. */
async function probe(name, modes) {
  const sig = process.env.WP_IT_SIG;
  fs.writeFileSync(path.join(sig, `${name}.req`), Array.isArray(modes) ? modes.join(",") : JSON.stringify(modes));
  const f = path.join(sig, `${name}.json`);
  await until("the webview probe", () => fs.existsSync(f), 40_000);
  return JSON.parse(fs.readFileSync(f, "utf8"));
}

async function run() {
  const out = process.env.WP_IT_OUT;
  const storage = process.env.WP_IT_STORAGE;
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const checks = [];
  const check = async (name, fn) => {
    const t0 = Date.now();
    try { await fn(); checks.push({ name, ok: true, ms: Date.now() - t0 }); }
    catch (e) { checks.push({ name, ok: false, ms: Date.now() - t0, why: String(e?.message ?? e) }); }
  };

  await check("a workspace folder is open", () => assert.ok(folder, "no workspace folder"));

  await check("the extension is installed and activates", async () => {
    const ext = vscode.extensions.getExtension(ID);
    assert.ok(ext, `${ID} not found`);
    await ext.activate();
    assert.equal(ext.isActive, true);
  });

  await check("all four commands are registered", async () => {
    const all = new Set(await vscode.commands.getCommands(true));
    for (const c of ["open", "rescan", "copyPrompt", "healthRefresh"]) assert.ok(all.has(`waterplane.${c}`), `waterplane.${c} missing`);
  });

  await check("waterplane.open shows the panel", async () => {
    await vscode.commands.executeCommand("waterplane.open");
    await until("the panel tab", panelTab, 15_000);
  });

  await check("the panel renders with no error, and the tree is its navigation", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.waterplane");
    const v = await probe("render", ["panel"]);
    assert.ok(v.ok, v.why);
    const all = new Set(await vscode.commands.getCommands(true));
    for (const c of ["show", "pickSession", "pickFolder"]) assert.ok(all.has(`waterplane.${c}`), `waterplane.${c} missing`);
  });

  await check("the Session view follows the newest conversation and titles itself with its last prompt", async () => {
    await vscode.commands.executeCommand("waterplane.show", "session");
    const v = await probe("sessions-panel", { tab: "session", needles: ["Following the newest session.", process.env.WP_IT_SECOND] });
    assert.ok(v.ok, v.why);
  });

  await check("picking the older session in the tree drills the panel into it, and following the newest is one tap away", async () => {
    await vscode.commands.executeCommand("waterplane.pickSession", process.env.WP_IT_CONV);
    const v = await probe("sessions-pick", { tab: "session", needles: ["Pinned to this session.", "Follow the newest", "Explain the build"] });
    assert.ok(v.ok, v.why);
    await vscode.commands.executeCommand("waterplane.pickSession", null);
  });

  await check("waterplane.rescan reads the logs into the token store", async () => {
    await vscode.commands.executeCommand("waterplane.rescan");
    const f = path.join(storage, "tokenstore.v5.json");
    await until(`${f}`, () => fs.existsSync(f) && fs.statSync(f).size > 0, 60_000);
    const store = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.ok(JSON.stringify(store).includes(process.env.WP_IT_CONV), "the fixture conversation is not in the store");
  });

  await check("All sessions: one span filter over Totals, the costliest list and Over time, the phone's layout", async () => {
    await vscode.commands.executeCommand("waterplane.show", "all");
    const v = await probe("all-spans", { tab: "all", needles: ["30 days", "90 days", "All time", "TOTALS", "Costliest conversations", "OVER TIME", "The last 30 calendar days"] });
    assert.ok(v.ok, v.why);
  });

  await check("the Health view shows the series the desktop app left in the folder, without measuring", async () => {
    await vscode.commands.executeCommand("waterplane.show", "health");
    const v = await probe("health-repo", { tab: "health", needles: [
      "Read from this folder's .waterplane/repohealth.jsonl", "measured by the waterplane desktop app", "The extension never writes it.",
    ] });
    assert.ok(v.ok, v.why);
    const own = path.join(storage, "health");
    const files = fs.existsSync(own) ? fs.readdirSync(own, { recursive: true }).filter((n) => String(n).endsWith(".jsonl")) : [];
    assert.deepEqual(files, [], "reading measured something into the extension's storage");
  });

  await check("waterplane.healthRefresh measures the folder's git history", async () => {
    await vscode.commands.executeCommand("waterplane.healthRefresh");
    const dir = path.join(storage, "health");
    const series = () => {
      if (!fs.existsSync(dir)) return null;
      for (const d of fs.readdirSync(dir)) {
        const f = path.join(dir, d, "repohealth.jsonl");
        if (fs.existsSync(f) && fs.readFileSync(f, "utf8").trim()) return f;
      }
      return null;
    };
    const f = await until("a repohealth.jsonl row", series, 120_000);
    const rows = fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(rows.length >= 1, "no rows");
  });

  await check("closing the panel leaves the extension alive", async () => {
    const t = panelTab();
    if (t) await vscode.window.tabGroups.close(t);
    await until("the panel to close", () => !panelTab(), 10_000);
    await vscode.commands.executeCommand("waterplane.open");
    await until("the panel tab again", panelTab, 15_000);
  });

  if (out) fs.writeFileSync(out, JSON.stringify({ vscode: vscode.version, checks }, null, 2));
  const bad = checks.filter((c) => !c.ok);
  if (bad.length) throw new Error(bad.map((c) => `${c.name}: ${c.why}`).join("\n"));
}

module.exports = { run };
