/**
 * Boot what the setup checklist needs outside a daemon: a plugin registry with
 * the in-repo extensions loaded (their rows are contributed, not core), over
 * fake deps — no sessions, no backlog.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function loadSetupForTest() {
  const { PluginRegistry } = await import("../dist/plugins/pluginregistry.js");
  const root = mkdtempSync(join(tmpdir(), "waterplane-setuproot-"));
  const reg = new PluginRegistry({
    root, configDir: root, sessions: { list: () => [], get: () => null },
    decision: () => {}, meter: () => {}, notify: () => {}, usage: () => ({ ok: false }), changed: () => {},
  });
  // A builtin may hold a socket open (vault's), which keeps the test process alive.
  after(() => { reg.shutdownAll(); rmSync(root, { recursive: true, force: true }); });
  await reg.loadBuiltins();
  const broken = reg.entries.filter((e) => e.state !== "active");
  if (broken.length) throw new Error(`extensions did not load: ${broken.map((e) => `${e.manifest.id}: ${e.error}`).join("; ")}`);
  return reg;
}
