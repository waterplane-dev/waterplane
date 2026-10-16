// examples/plugin-template is what a plugin author starts from (docs/plugins.md), so it must stay a
// plugin this host LOADS: its manifest passes `manifestProblems`, and its host module answers its
// own declared action through the API the way the daemon calls it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { manifestProblems, pluginValues, PLUGIN_MANIFEST } from "../dist/plugin.js";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/plugin-template");
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, PLUGIN_MANIFEST), "utf8"));

test("the template's manifest has no problems", () => {
  assert.deepEqual(manifestProblems(manifest), []);
  assert.equal(manifest.actions.filter((a) => a.scope === "session").length, 1);
  assert.equal(manifest.settings.length, 1);
});

test("the template's session action saves the screen and says where", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-template-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let onAction = null;
  const asked = [];
  const api = {
    id: manifest.id, dataDir, log() {},
    settings: () => pluginValues(manifest, { lines: 10 }),
    on: (event, fn) => { if (event === "action") onAction = fn; return () => {}; },
    session: (id) => (id === "s1" ? { id, title: "fix the tests" } : null),
    scrollback: (id, lines) => { asked.push([id, lines]); return "line\n".repeat(lines); },
  };
  const mod = await import(pathToFileURL(path.join(DIR, manifest.host ?? "host.mjs")).href);
  await mod.activate(api);
  assert.ok(onAction, "activate() registered an action handler");

  const ok = await onAction({ action: "save-screen", sessionId: "s1" });
  assert.equal(ok.ok, true);
  assert.deepEqual(asked, [["s1", 10]]);
  const [file] = fs.readdirSync(dataDir);
  assert.match(ok.message, new RegExp(file));
  assert.equal(fs.readFileSync(path.join(dataDir, file), "utf8"), "line\n".repeat(10));

  const gone = await onAction({ action: "save-screen", sessionId: "s2" });
  assert.deepEqual(gone, { ok: false, message: "That session has ended." });
});
