import test from "node:test";
import assert from "node:assert/strict";
import { manifestProblems, pluginMaturity, PLUGIN_TOPIC, updatesDue, PLUGIN_API_VERSION } from "../dist/index.js";

const base = { id: "demo", name: "Demo", version: "1.0.0", apiVersion: PLUGIN_API_VERSION };

test("maturity: the three words validate, anything else is refused, absent is fine", () => {
  for (const m of ["stable", "preview", "experimental"]) assert.deepEqual(manifestProblems({ ...base, maturity: m }), []);
  assert.deepEqual(manifestProblems(base), []);
  assert.equal(manifestProblems({ ...base, maturity: "beta" }).length, 1);
  assert.equal(manifestProblems({ ...base, maturity: true }).length, 1);
});

test("pluginMaturity: absent or unknown is unrated, never stable; words live here", () => {
  assert.equal(pluginMaturity({}).level, "unrated");
  assert.equal(pluginMaturity({ maturity: "stable-ish" }).level, "unrated");
  assert.equal(pluginMaturity(null).level, "unrated");
  assert.equal(pluginMaturity({ maturity: "preview" }).meaning, "May break between versions");
  assert.equal(pluginMaturity({ maturity: "experimental" }).meaning, "May not work");
  assert.equal(pluginMaturity({}).meaning, "The plugin does not say");
  assert.equal(pluginMaturity({ maturity: "stable" }).label, "Stable");
  assert.equal(PLUGIN_TOPIC, "waterplane-plugin");
});

const self = (o = {}) => ({ mode: "tarball", current: "0.1.4", latest: "0.1.5", canApply: true, ...o });
const entry = (o = {}) => ({
  repo: "waterplane-dev/x", url: "u", name: "X", description: "", maturity: "preview", problems: [],
  latest: { kind: "tag", ref: "v0.2.0" },
  installed: { id: "x", version: "0.1.0", source: "manager", ref: "v0.1.0", dir: "/d" }, ...o,
});

test("updatesDue: self newer and applicable counts; nothing newer does not", () => {
  assert.equal(updatesDue({ self: self(), catalog: [] }).length, 1);
  assert.equal(updatesDue({ self: self({ latest: "0.1.4" }), catalog: [] }).length, 0);
  assert.equal(updatesDue({ self: self({ latest: undefined }), catalog: [] }).length, 0);
  assert.equal(updatesDue({ self: self({ latest: "0.1.3" }), catalog: [] }).length, 0);
  assert.equal(updatesDue(null).length, 0);
});

test("updatesDue: self npm mode counts only with a command; without, it does not", () => {
  assert.equal(updatesDue({ self: self({ mode: "npm", canApply: false, command: "npm i -g x" }), catalog: [] }).length, 1);
  assert.equal(updatesDue({ self: self({ mode: "npm", canApply: false }), catalog: [] }).length, 0);
});

test("updatesDue: local plugins never count", () => {
  const e = entry({ installed: { id: "x", version: "0.1.0", source: "local", dir: "/d" } });
  assert.equal(updatesDue({ self: self({ latest: undefined }), catalog: [e] }).length, 0);
});

test("updatesDue: manager plugin with a newer tag counts; same or older tag does not", () => {
  const s = self({ latest: undefined });
  assert.equal(updatesDue({ self: s, catalog: [entry()] }).length, 1);
  assert.equal(updatesDue({ self: s, catalog: [entry({ latest: { kind: "tag", ref: "v0.1.0" } })] }).length, 0);
  assert.equal(updatesDue({ self: s, catalog: [entry({ latest: { kind: "tag", ref: "v0.0.9" } })] }).length, 0);
  assert.equal(updatesDue({ self: s, catalog: [entry({ latest: null })] }).length, 0);
});

test("updatesDue: untagged (branch) counts only when both commits are known and differ", () => {
  const s = self({ latest: undefined });
  const inst = (commit) => ({ id: "x", version: "0.1.0", source: "manager", ref: "main", commit, dir: "/d" });
  const lat = (commit) => ({ kind: "branch", ref: "main", commit });
  assert.equal(updatesDue({ self: s, catalog: [entry({ installed: inst("a"), latest: lat("b") })] }).length, 1);
  assert.equal(updatesDue({ self: s, catalog: [entry({ installed: inst("a"), latest: lat("a") })] }).length, 0);
  assert.equal(updatesDue({ self: s, catalog: [entry({ installed: inst(undefined), latest: lat("b") })] }).length, 0);
});

test("updatesDue: an entry with problems or not installed never counts", () => {
  const s = self({ latest: undefined });
  assert.equal(updatesDue({ self: s, catalog: [entry({ problems: ["has dependencies"] })] }).length, 0);
  assert.equal(updatesDue({ self: s, catalog: [entry({ installed: null })] }).length, 0);
});
