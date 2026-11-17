// The Findings view's data: the Setup check run standalone over a folder and a config dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { data, tmp } from "./helpers.mjs";

/** A folder with a CLAUDE.md of `chars` characters, and a config dir with settings. */
function setup({ chars = 200, settings } = {}) {
  const folder = tmp("find-repo");
  const cfg = tmp("find-cfg");
  writeFileSync(join(folder, "CLAUDE.md"), "x".repeat(chars));
  if (settings) writeFileSync(join(cfg, "settings.json"), JSON.stringify(settings));
  return { folder, cfg };
}

const run = async (o) => {
  const { folder, cfg } = setup(o);
  const weight = await data.weighFolder(folder, {}, cfg);
  return { folder, doc: await data.findingsFor({ folder, weight, corpus: null, now: Date.parse("2026-11-16T12:00:00Z"), configDir: cfg }) };
};

test("a lean folder lists what was checked, so the view is never empty", async () => {
  const { doc } = await run({ settings: { autoCompactWindow: "300000" } });
  assert.equal(doc.findings.filter((f) => f.weight === "finding").length, 0);
  assert.ok(doc.passed.some((p) => p.rule === "context-weight"), "context weight passed");
  assert.ok(doc.passed.some((p) => p.rule === "auto-compact"), "auto-compact passed");
  // A check that reads only files carries no backends line; one that read conversations names claude.
  const filesOnly = (b) => b.understood.length === 0 && b.unread.length === 0;
  assert.ok(doc.passed.every((p) => filesOnly(p.backends) || p.backends.understood.includes("claude")));
  assert.ok(filesOnly(doc.passed.find((p) => p.rule === "context-weight").backends), "context weight reads only files");
});

test("what could not be read is not checked, never passed", async () => {
  const { doc } = await run({});
  const rules = doc.notChecked.map((n) => n.rule);
  for (const r of ["skills-unused", "price-list", "cold-cache"]) assert.ok(rules.includes(r), `${r} is not checked`);
  assert.ok(!doc.passed.some((p) => ["skills-unused", "price-list", "cold-cache"].includes(p.rule)));
  assert.ok(doc.notChecked.every((n) => n.why.length > 10));
  assert.ok(doc.absent.some((a) => /log scan|skill|session history/.test(a.why)));
});

test("a heavy CLAUDE.md is a ranked finding with a copyable remedy", async () => {
  const { doc } = await run({ chars: 60_000 });
  const f = doc.findings.find((x) => x.rule === "context-weight");
  assert.ok(f, "context-weight finding");
  assert.equal(f.remedy.kind, "seed");
  assert.equal(f.weight, "consider", "the same finding is a 'consider' row on every surface");
  const paras = data.remedyCopy(f, null);
  assert.ok(paras && paras.length > 0);
  assert.ok(!doc.passed.some((p) => p.id === f.id));
});

test("auto-compact unset in user settings is a finding on the machine scope", async () => {
  const { doc } = await run({});
  assert.ok(doc.findings.some((f) => f.rule === "auto-compact"));
});

test("an auto-compact override in the folder's own settings is never the machine's pass", async () => {
  const { folder, cfg } = setup({});
  mkdirSync(join(folder, ".claude"), { recursive: true });
  writeFileSync(join(folder, ".claude", "settings.json"), JSON.stringify({ autoCompactWindow: "1000000" }));
  const weight = await data.weighFolder(folder, {}, cfg);
  const doc = await data.findingsFor({ folder, weight, corpus: null, now: Date.parse("2026-11-16T12:00:00Z"), configDir: cfg });
  assert.ok(!doc.passed.some((p) => p.id === "machine.auto-compact"), "the folder's setting says nothing about the user level");
});

test("the account scope is absent without a desktop and never drawn", async () => {
  const { doc } = await run({});
  assert.equal(doc.account, false);
  for (const x of [...doc.findings, ...doc.passed, ...doc.notChecked]) assert.notEqual(x.scope, "account");
});

test("the efficiency block is a finding until the folder carries it", async () => {
  const { doc } = await run({});
  assert.ok(doc.findings.some((f) => f.rule === "efficiency-rules"));
  const f = doc.findings.find((x) => x.rule === "efficiency-rules");
  const paras = data.remedyCopy(f, null);
  assert.ok(paras.join("\n").includes("efficiency-rules"));
});

test("a broad allow rule in the project's settings is found by the bundled permissions engine", async () => {
  const { folder, cfg } = setup({});
  mkdirSync(join(folder, ".claude"));
  writeFileSync(join(folder, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash"] } }));
  const weight = await data.weighFolder(folder, {}, cfg);
  const doc = await data.findingsFor({ folder, weight, corpus: null, now: 1, configDir: cfg });
  const hit = doc.findings.find((f) => f.rule === "permissions-broad" && f.scope === "repo");
  const bundled = existsSync(join(import.meta.dirname, "../../extensions/permissions/host/engine.mts"));
  if (bundled) { assert.ok(hit, "the bundled engine answered"); assert.equal(hit.weight, "consider"); return; }
  // Public build without the private extension: the rule is not checked, never passed.
  assert.ok(doc.notChecked.some((n) => n.rule === "permissions-broad"));
  assert.ok(!doc.passed.some((p) => p.rule === "permissions-broad"));
});
