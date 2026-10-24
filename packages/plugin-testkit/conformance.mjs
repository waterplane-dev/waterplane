/**
 * The conformance suite: register a plugin through the fake host API and assert what a real host
 * would enforce, so contract drift shows in the plugin's own `node --test` instead of at install.
 *
 *   // test/conformance.test.mjs
 *   import { runConformance } from "@waterplane/plugin-testkit";   // or the relative path
 *   import * as plugin from "../host.mjs";
 *   import manifest from "../waterplane-plugin.json" with { type: "json" };
 *   runConformance({ plugin, manifest, env: { MYCLI_BIN: "/nonexistent/mycli" } });
 *
 * It never spawns the CLI on purpose: point the plugin's binary env at a path that does not exist
 * (`env`), and `measured.version()` then answers unknown (null) or throws — both fine, hanging is not.
 * The pure checks are in `checks.mjs` (exported as `checks`) for a plugin's own tests too.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeApi } from "./fakeapi.mjs";
import * as checks from "./checks.mjs";
import { PLUGIN_API_VERSION, PLUGIN_BACKEND_ID_RE, manifestProblems, pluginApiProblem } from "./shared.mjs";

/** Settles with `p`, or rejects after `ms` — a conformance run must fail, never hang. */
async function bounded(p, ms, what) {
  let t;
  try {
    return await Promise.race([
      Promise.resolve(p),
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} did not answer within ${ms} ms`)), ms); }),
    ]);
  } finally { clearTimeout(t); }
}

const noProblems = (list, what) => assert.deepEqual(list, [], `${what}: ${list.join("; ")}`);

/**
 * @param {object} o
 * @param {{activate?:Function,deactivate?:Function,shutdown?:Function}} [o.plugin]  the host module
 * @param {Function} [o.activate]    instead of `plugin`
 * @param {object} o.manifest        the parsed waterplane-plugin.json
 * @param {Record<string,string>} [o.env]  values for the manifest's declared env names (use a nonexistent binary)
 * @param {object} [o.apiOptions]    more `fakeApi` options (settings, supports, omit …)
 * @param {() => Promise<{label:string,answer:unknown}[]>} [o.answers]  answers the plugin's sources would give
 *        (dialog/question/plan `answer()` results, `mode.set()` keys), each checked against the bounds the host applies
 * @param {() => Promise<{label:string,kind:"mode"|"commands"|"spend"|"compactions"|"context",value:unknown,backend?:string}[]>} [o.readings]
 *        what the plugin's 2.2 slots answer for its own fixtures (a parsed `/help`, a recorded usage event …),
 *        each checked against shared's shape rule; `mode` against that backend's `caps.permissionModes`
 * @param {number} [o.timeoutMs]
 */
export function runConformance(o) {
  const manifest = o.manifest;
  const activate = o.activate ?? o.plugin?.activate;
  const timeoutMs = o.timeoutMs ?? 5000;
  describe(`conformance: ${manifest?.id ?? "plugin"}`, () => {
    let api; let activateError = null; let cwd;
    before(async () => {
      cwd = mkdtempSync(join(tmpdir(), "conformance-cwd-"));
      api = fakeApi({ manifest, env: o.env, ...(o.apiOptions ?? {}) });
      try { await bounded(activate(api), 10_000, "activate()"); } catch (e) { activateError = e; }
    });
    after(async () => {
      for (const fn of [o.plugin?.deactivate, o.plugin?.shutdown]) {
        if (typeof fn === "function") await bounded(fn.call(o.plugin), 10_000, "deactivate/shutdown");
      }
    });
    const defs = () => api._calls.backend;

    test("manifest: valid, current API, backends listed", () => {
      noProblems(manifestProblems(manifest), "manifest");
      assert.equal(pluginApiProblem(manifest.apiVersion), null, `apiVersion ${manifest.apiVersion} vs host ${PLUGIN_API_VERSION}`);
      assert.ok(Array.isArray(manifest.backends) && manifest.backends.length, "a backend plugin lists its ids in manifest.backends");
      for (const b of manifest.backends) assert.match(b, PLUGIN_BACKEND_ID_RE);
    });

    test("activate() succeeds and registers only manifest-declared backends", () => {
      assert.equal(activateError, null, `activate() threw: ${activateError?.message}`);
      assert.ok(defs().length, "activate() registered no backend");
      const ids = defs().map((d) => d.id);
      assert.equal(new Set(ids).size, ids.length, `a backend id was registered twice: ${ids}`);
      for (const id of ids) assert.ok(manifest.backends.includes(id), `${id} is not in manifest.backends`);
    });

    test("descriptor: complete, 2.0 shape, caps sane", () => {
      for (const d of defs()) {
        noProblems(checks.descriptorProblems(d), `backend ${d.id}`);
        noProblems(checks.capsProblems(d.caps), `backend ${d.id} caps`);
        for (const [k, v] of Object.entries(d.delivery ?? {})) {
          if (/Re$/.test(k)) assert.ok(v === null || v instanceof RegExp, `delivery.${k} is a RegExp or null`);
        }
        assert.ok(d.measured.versions.every((v) => typeof v === "string"), "measured.versions are strings");
      }
    });

    test("facts: valid fact names, readers known, every {source:true} backed by its sources slot", () => {
      const readers = {
        screen: new Set(api._calls.screenReader.map((r) => r.name)),
        store: new Set(api._calls.storeReader.map((r) => r.name)),
      };
      for (const d of defs()) {
        noProblems(checks.factProblems(d.facts, readers), `backend ${d.id} facts`);
        noProblems(checks.sourceSlotProblems(d.facts, d.sources), `backend ${d.id}`);
      }
    });

    test("bin() names a binary", () => {
      for (const d of defs()) assert.ok(typeof d.bin() === "string" && d.bin().length, `backend ${d.id} bin()`);
    });

    test("prepare(): a plan with instructionsVia, askRulesVia, string args, files within limits", async () => {
      for (const d of defs()) {
        const req = {
          launch: {}, hookPort: 1, cwd, hostSessionId: "conformance-1",
          instructions: "Put artifacts in .claude/outbox/.", askRules: ["never force-push"],
        };
        const plan = await bounded(d.prepare(req), timeoutMs, `backend ${d.id} prepare()`);
        noProblems([...checks.planProblems(plan, { dataDir: api.dataDir }), ...checks.planLints(plan)], `backend ${d.id} plan`);
        // A resume the plugin cannot do is a thrown SENTENCE; otherwise it is a valid plan.
        for (const resume of [{ resumeMode: "continue" }, { resumeMode: "pick" }, { resumeMode: "continue", resumeSessionId: "conformance-conv" }]) {
          let again;
          try { again = await bounded(d.prepare({ ...req, ...resume }), timeoutMs, `backend ${d.id} prepare(${resume.resumeMode})`); }
          catch (e) {
            assert.ok(e instanceof Error && e.message.trim(), "a refusal is a thrown sentence");
            assert.doesNotMatch(e.message, /did not answer within/);
            continue;
          }
          noProblems([...checks.planProblems(again, { dataDir: api.dataDir }), ...checks.planLints(again)], `backend ${d.id} ${resume.resumeMode} plan`);
        }
      }
    });

    test("models(): aliases and ids are lists (empty allowed)", async () => {
      for (const d of defs()) {
        const m = await bounded(d.models(), timeoutMs, `backend ${d.id} models()`);
        assert.ok(m && typeof m === "object", "models() answers an object");
        assert.ok(Array.isArray(m.aliases) && m.aliases.every((x) => typeof x === "string"), "aliases: string[]");
        assert.ok(Array.isArray(m.ids) && m.ids.every((x) => typeof x === "string"), "ids: string[]");
        if (m.contextWindow !== undefined) assert.ok(Object.values(m.contextWindow).every((n) => typeof n === "number" && n > 0));
      }
    });

    test("measured.version() answers a string, null or throws — never hangs", async () => {
      for (const d of defs()) {
        let v;
        try { v = await bounded(d.measured.version(), timeoutMs, `backend ${d.id} measured.version()`); }
        catch (e) { assert.doesNotMatch(String(e?.message), /did not answer within/, `backend ${d.id} measured.version() hung`); continue; }
        assert.ok(v === null || typeof v === "string", "version is a string or null");
      }
    });

    test("answers a source gives are bounded (keys ≤8 allowed, typed ≤1000 chars, no control chars)", async () => {
      if (!o.answers) return;
      for (const { label, answer } of await bounded(o.answers(), timeoutMs * 2, "answers()")) {
        assert.equal(checks.answerProblem(answer), null, `${label}: ${checks.answerProblem(answer)}`);
      }
    });

    test("2.2 slots answer in shape when asked cold (mode, commands, session spend, compactions, context window)", async () => {
      // Asked with no channel attached: a throw or null is "cannot say" and fine; hanging is not;
      // an answer must hold shared's shape (`readingProblems`).
      const s = { id: "conformance-1", cwd, spawnedAt: Date.now() };
      const ask = async (fn, what) => {
        try { return { v: await bounded(fn(), timeoutMs, what) }; }
        catch (e) { assert.doesNotMatch(String(e?.message), /did not answer within/, `${what} hung`); return null; }
      };
      for (const d of defs()) {
        const src = d.sources;
        if (!src) continue;
        const modes = { permissionModes: d.caps.permissionModes };
        if (src.mode) {
          assert.equal(typeof src.mode.current, "function", `backend ${d.id} sources.mode.current`);
          assert.equal(typeof src.mode.set, "function", `backend ${d.id} sources.mode.set`);
          assert.ok(d.caps.permissionModes.length, `backend ${d.id} has sources.mode but caps.permissionModes is empty`);
          const r = await ask(() => src.mode.current(s), `backend ${d.id} mode.current()`);
          if (r) noProblems(checks.readingProblems("mode", r.v ?? null, modes), `backend ${d.id} mode.current()`);
        }
        if (src.commands) {
          const r = await ask(() => src.commands.list(cwd), `backend ${d.id} commands.list()`);
          if (r) noProblems(checks.readingProblems("commands", r.v ?? null), `backend ${d.id} commands.list()`);
        }
        if (typeof src.tokens?.session === "function") {
          const r = await ask(() => src.tokens.session(s), `backend ${d.id} tokens.session()`);
          if (r) noProblems(checks.readingProblems("spend", r.v ?? null), `backend ${d.id} tokens.session()`);
        }
        if (typeof src.context?.compactions === "function") {
          const r = await ask(() => src.context.compactions(s), `backend ${d.id} context.compactions()`);
          if (r) noProblems(checks.readingProblems("compactions", r.v ?? null), `backend ${d.id} context.compactions()`);
        }
        if (typeof src.context?.sample === "function") {
          const r = await ask(() => src.context.sample(s), `backend ${d.id} context.sample()`);
          if (r) noProblems(checks.readingProblems("context", r.v ?? null), `backend ${d.id} context.sample()`);
        }
      }
    });

    test("2.2 readings the plugin hands over hold shared's shape", async () => {
      if (!o.readings) return;
      for (const { label, kind, value, backend } of await bounded(o.readings(), timeoutMs * 2, "readings()")) {
        const d = defs().find((x) => x.id === backend) ?? defs()[0];
        noProblems(checks.readingProblems(kind, value, { permissionModes: d?.caps?.permissionModes ?? [] }), label);
      }
    });

    test("the fake saw no stray registrations (hook sink is a URL, reader names are plain)", () => {
      assert.match(api.hookSink(), /^https?:\/\//);
      for (const r of [...api._calls.screenReader, ...api._calls.storeReader]) assert.match(r.name, /^[a-z][a-z0-9-]{0,39}$/);
    });
  });
}
