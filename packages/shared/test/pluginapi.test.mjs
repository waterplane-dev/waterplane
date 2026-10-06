// The plugin API's version and its compatibility rule (`shared/src/plugin.ts`,
// `PLUGIN_API_VERSION` / `pluginApiProblem`). The rule is the contract a fork's
// plugin builds on: same major, minor no newer than the host's, patch ignored —
// and a bare number, which every manifest written before semver carries, is
// that major's `.0`. A refusal is a SENTENCE naming both versions, never a
// silent skip.
import test from "node:test";
import assert from "node:assert/strict";
import {
  manifestProblems, parsePluginApiVersion, pluginApiProblem, PLUGIN_API_VERSION,
} from "../dist/plugin.js";

test("PLUGIN_API_VERSION is semver", () => {
  assert.match(PLUGIN_API_VERSION, /^\d+\.\d+\.\d+$/);
});

test("parsePluginApiVersion: semver strings and a bare major; nothing else", () => {
  assert.deepEqual(parsePluginApiVersion(1), { major: 1, minor: 0, patch: 0 });
  assert.deepEqual(parsePluginApiVersion("1.2"), { major: 1, minor: 2, patch: 0 });
  assert.deepEqual(parsePluginApiVersion("1.2.3"), { major: 1, minor: 2, patch: 3 });
  for (const bad of [1.5, -1, "1", "v1.0", "1.0.0-beta", "", null, undefined, {}, [1, 0]]) {
    assert.equal(parsePluginApiVersion(bad), null, `${JSON.stringify(bad)} is not a version`);
  }
});

test("pluginApiProblem: same major and minor no newer loads; the patch is never compared", () => {
  for (const ok of [1, "1.0", "1.0.0", "1.0.9", "1.2", "1.3", "1.3.7"]) {
    assert.equal(pluginApiProblem(ok, "1.3.0"), null, `${ok} loads on 1.3.0`);
  }
});

test("pluginApiProblem: a newer minor, another major or no version is refused in words", () => {
  const newer = pluginApiProblem("1.4", "1.3.0");
  assert.match(newer, /^apiVersion is "1\.4"; this daemon speaks 1\.3\.0/);
  assert.match(newer, /1\.0 up to 1\.3/);
  assert.match(newer, /needs a newer daemon/);
  assert.match(pluginApiProblem(2, "1.3.0"), /apiVersion is 2;.*needs a newer daemon/);
  assert.match(pluginApiProblem("1.0", "2.0.0"), /written for an older API and must be updated/);
  assert.match(pluginApiProblem(undefined, "1.0.0"), /apiVersion is undefined;.*must be a version like "1\.0"/);
  assert.match(pluginApiProblem("one", "1.0.0"), /must be a version/);
});

test("today's manifests (a bare 1) still load on this daemon, and 99 is refused", () => {
  const base = { id: "echo", name: "Echo", version: "1.0.0" };
  assert.deepEqual(manifestProblems({ ...base, apiVersion: 1 }), []);
  assert.deepEqual(manifestProblems({ ...base, apiVersion: PLUGIN_API_VERSION }), []);
  assert.match(manifestProblems({ ...base, apiVersion: 99 }).join(";"), /apiVersion is 99; this daemon speaks/);
});
