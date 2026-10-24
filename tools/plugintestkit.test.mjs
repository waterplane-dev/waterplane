// Guard: the plugin testkit's fake implements EVERY member of `HostPluginApi`, and adds none the
// host lacks. A new API member fails this until `packages/plugin-testkit/fakeapi.mjs` has it (and
// the plugins' tests are then run against the new contract). Reads plugin.ts; imports the kit,
// which needs shared/dist (`npm run build:shared`), so this runs in the push tier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../packages/shared/src/plugin.ts", import.meta.url), "utf8");

/** The member names of `export interface HostPluginApi { … }`: statements at brace depth 0. */
export function apiMembers(text) {
  const at = text.indexOf("export interface HostPluginApi {");
  assert.ok(at >= 0, "HostPluginApi not found in plugin.ts");
  let i = text.indexOf("{", at) + 1, depth = 1;
  const start = i;
  for (; i < text.length && depth > 0; i++) { if (text[i] === "{") depth++; else if (text[i] === "}") depth--; }
  const body = text.slice(start, i - 1).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
  const names = new Set();
  let d = 0, stmt = "";
  const flush = () => { const m = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)/.exec(stmt); if (m) names.add(m[1]); stmt = ""; };
  for (const ch of body) {
    if ("{([".includes(ch)) d++;
    else if ("})]".includes(ch)) d--;
    if (ch === ";" && d === 0) flush(); else stmt += ch;
  }
  flush();
  return [...names];
}

test("the extractor finds the API (guards the guard)", () => {
  const m = apiMembers(src);
  for (const k of ["id", "dataDir", "backend", "notify", "bindConversation", "tail", "supports", "offerFile", "onHook", "on"]) assert.ok(m.includes(k), `${k} missing from ${m.join(",")}`);
  assert.ok(m.length >= 40, `only ${m.length} members found`);
});

test("fakeApi() implements every HostPluginApi member and invents none", async () => {
  const { fakeApi } = await import("../packages/plugin-testkit/index.mjs");
  const members = apiMembers(src);
  const api = fakeApi({ supports: { dialogKeysThenTyped: true } });
  const missing = members.filter((k) => !(k in api));
  assert.deepEqual(missing, [], `HostPluginApi gained ${missing.join(", ")} — add it to packages/plugin-testkit/fakeapi.mjs`);
  const extra = Object.keys(api).filter((k) => !k.startsWith("_") && !members.includes(k));
  assert.deepEqual(extra, [], `the fake has ${extra.join(", ")}, which HostPluginApi does not (rename with a leading _ if it is a test helper)`);
  // a fake without `supports` is an older host: the member is absent, not false
  assert.equal("supports" in fakeApi(), false);
});
