/**
 * A faithful fake of `HostPluginApi` (plugin API 2.1; `packages/shared/src/plugin.ts`, the host's
 * `plugins/pluginapi.ts`). No host involved; every call is recorded in `api._calls`.
 *
 * Faithful IN MEANING, not in plumbing:
 *  - `env(name)` answers only names the manifest declares (or `declare`), like the host;
 *  - `backend(def)` refuses an id the manifest does not list, with the host's sentence;
 *  - the toolkit (`bindConversation`, `tail`, `screen`, `sessionFiles`, `supports`) behaves as
 *    `plugins/plugintoolkit/` does: `bindConversation` IS the host's ladder (imported from
 *    shared), `tail` follows complete JSONL lines (1 MiB windows, inode change or shrink re-reads
 *    from 0), `screen` serves rows a test sets (`_setScreen`), `sessionFiles` a temp dir path.
 *  - rules (`ruleAllows`/`rules`/`forgetRules`) emulate `answergate.ts`: made only by `_remember`
 *    (a person's tap), spent by `ruleAllows`.
 * `tools/plugintestkit.test.mjs` fails when `HostPluginApi` gains a member
 * this file lacks.
 */
import { closeSync, fstatSync, mkdtempSync, openSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindConversation, pickBound, BIND_CONFIRM_MS, LEGACY } from "./shared.mjs";

export { bindConversation, pickBound, BIND_CONFIRM_MS };

/** `plugintoolkit/tail.ts`'s follower, in meaning. */
export function fakeTail(path, onLine, opts = {}) {
  const WINDOW = 1024 * 1024;
  let off = 0, ino = null, closed = false, skipping = false;
  return {
    advance() {
      if (closed) return null;
      let fd;
      try { fd = openSync(path, "r"); } catch { return null; }
      try {
        const st = fstatSync(fd);
        if (ino !== null && st.ino !== ino) { off = 0; skipping = false; }
        ino = st.ino;
        if (st.size < off) { off = 0; skipping = false; }
        if (st.size === off) return false;
        const len = Math.min(WINDOW, st.size - off);
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, off);
        if (n <= 0) return false;
        const lastNl = buf.subarray(0, n).lastIndexOf(0x0a);
        if (lastNl < 0) { if (n < WINDOW) return false; skipping = true; off += n; return true; }
        let start = 0;
        for (let i = 0; i <= lastNl; i++) {
          if (buf[i] !== 0x0a) continue;
          const line = buf.subarray(start, i).toString("utf8").trim();
          start = i + 1;
          if (skipping) { skipping = false; continue; }
          if (!line) continue;
          if (opts.filter) { try { if (!opts.filter(line)) continue; } catch { continue; } }
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          try { onLine(obj); } catch { /* a handler's fault is its own */ }
        }
        off += lastNl + 1;
        return true;
      } catch { return null; } finally { try { closeSync(fd); } catch { /* */ } }
    },
    offset: () => off,
    close() { closed = true; },
  };
}

/** A `PluginHookHold` stand-in. */
export function fakeHold(maxHoldMs = 8000) {
  const expired = [];
  return { maxHoldMs, onExpired: (fn) => { expired.push(fn); }, _expire: () => { for (const f of expired) f(); } };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.id]            plugin id (default: manifest.id, else "plugin")
 * @param {object} [opts.manifest]      the plugin's manifest: gates `backend()` ids and `env()` names
 * @param {Record<string,string>|((root:string)=>Record<string,string>)} [opts.env]  values for declared env names
 * @param {string[]} [opts.declare]     extra env names to treat as declared
 * @param {object} [opts.settings]      initial `settings()` values
 * @param {string} [opts.dataDir]       override `dataDir`
 * @param {string} [opts.sink]          `hookSink()` url
 * @param {{dialogKeysThenTyped?:boolean}|false} [opts.supports]  `api.supports` (false/absent: member missing, as on an older host)
 * @param {string[]} [opts.omit]        members to DELETE, to emulate an older host (e.g. ["ruleAllows","rules","forgetRules"])
 */
export function fakeApi(opts = {}) {
  const manifest = opts.manifest ?? null;
  const id = opts.id ?? manifest?.id ?? "plugin";
  const root = mkdtempSync(join(tmpdir(), `${id}-plugin-test-`));
  const calls = {
    backend: [], onHook: [], setStatus: [], onSettings: [], on: [], setBadge: [], decision: [], ruleAllows: [], bind: [], log: [],
    seedSettings: [], suggest: [], answer: [], meter: [], notify: [], handle: [], push: [], handToAgent: [], route: [], stream: [],
    offerFile: [], screenReader: [], storeReader: [], thermalReader: [], usageProbe: [], setupCheck: [], setupFix: [],
  };
  const screens = new Map();
  const sessions = new Map();
  const scrollbacks = new Map();
  let rules = [];
  let values = { ...(opts.settings ?? {}) };
  const declared = new Set([...(manifest?.env ?? []), ...(opts.declare ?? [])]);
  const envValues = typeof opts.env === "function" ? opts.env(root) : (opts.env ?? {});
  const reg = (list, item) => { list.push(item); return () => {}; };

  const api = {
    id,
    dataDir: opts.dataDir ?? join(root, "plugins", id),
    stateDir: root,
    // + the deprecated `<legacy slug>Dir` alias of stateDir, added below from LEGACY (never spelled).
    log: (msg) => { calls.log.push(msg); },
    settings: () => ({ ...values }),
    onSettings: (fn) => reg(calls.onSettings, fn),
    // the host seeds only keys that have no stored value yet
    seedSettings: (v) => { calls.seedSettings.push(v); for (const [k, x] of Object.entries(v ?? {})) if (!(k in values)) values[k] = x; },
    setStatus: (s) => { calls.setStatus.push(s); },
    env: (name) => (declared.has(name) ? envValues[name] : undefined),
    on: (event, fn) => reg(calls.on, { event, fn }),
    session: (sid) => sessions.get(sid) ?? null,
    scrollback: (sid) => scrollbacks.get(sid) ?? "",
    // ── toolkit (2.0) ──
    bindConversation: (look) => { calls.bind.push(look); return bindConversation(look); },
    tail: fakeTail,
    screen: (sid) => {
      if (!screens.has(sid)) return null;
      const rows = (n = 40) => screens.get(sid).slice(-Math.max(1, Math.min(500, n)));
      return { rows, squashed: (n) => rows(n).join("\n").replace(/\s+/g, "").toLowerCase() };
    },
    sessionFiles: (sid) => (typeof sid === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(sid) ? join(root, "launch", sid) : null),
    // ── 2.1 ──
    ...(opts.supports ? { supports: Object.freeze({ ...opts.supports }) } : {}),
    readRepoFile: () => null,
    inlineImages: () => [],
    suggest: (sid, s) => { calls.suggest.push({ sid, s }); },
    answer: async (sid, choice, why) => { calls.answer.push({ sid, choice, why }); return { ok: false, reason: "fake" }; },
    ruleAllows: (sid, key, why) => {
      calls.ruleAllows.push({ sid, key, why });
      const r = rules.find((x) => x.sid === sid && x.key === key);
      if (!r) return { ok: false, reason: "no rule a person made on this session covers that — ask them" };
      r.uses++;
      return { ok: true };
    },
    rules: (sid) => rules.filter((x) => x.sid === sid).map(({ key, label, at, uses }) => ({ key, label, at, uses })),
    forgetRules: (sid) => { const n = rules.filter((x) => x.sid === sid).length; rules = rules.filter((x) => x.sid !== sid); return n; },
    setBadge: (sid, badge) => { calls.setBadge.push({ sid, badge }); },
    decision: (row) => { calls.decision.push(row); },
    meter: (c) => { calls.meter.push(c); },
    notify: (n) => { calls.notify.push(n); },
    claudeUsage: () => null,
    repo: async () => null,
    setupCheck: (fn) => reg(calls.setupCheck, fn),
    setupFix: (fid, fn) => reg(calls.setupFix, { id: fid, fn }),
    handle: (method, fn) => reg(calls.handle, { method, fn }),
    push: (event, data) => { calls.push.push({ event, data }); return null; },
    handToAgent: async (repoId, prompt, o) => { calls.handToAgent.push({ repoId, prompt, opts: o }); return { ok: false, reason: "fake" }; },
    backend: (def) => {
      const bid = def?.id;
      const listed = manifest?.backends;
      if (manifest && (typeof bid !== "string" || !(listed ?? []).includes(bid))) {
        throw new Error(listed?.length
          ? `${manifest.name} may register only the backends its manifest lists (${listed.join(", ")}), not ${JSON.stringify(bid ?? null)}`
          : `${manifest.name} lists no "backends" in its manifest, so it may not register ${JSON.stringify(bid ?? null)}`);
      }
      return reg(calls.backend, def);
    },
    screenReader: (name, reader) => reg(calls.screenReader, { name, reader }),
    storeReader: (name, reader) => reg(calls.storeReader, { name, reader }),
    thermalReader: (name, reader) => reg(calls.thermalReader, { name, reader }),
    usageProbe: (def) => reg(calls.usageProbe, def),
    hookSink: () => opts.sink ?? `http://127.0.0.1:9/api/plugin/${id}/hook`,
    onHook: (fn, o) => reg(calls.onHook, { fn, opts: o }),
    route: (method, pattern, fn) => reg(calls.route, { method, pattern, fn }),
    stream: (name, handlers) => reg(calls.stream, { name, handlers }),
    offerFile: (file, o) => { calls.offerFile.push({ file, opts: o }); return { path: `/api/plugin-file/${id}/fake`, size: 0, expiresAt: Date.now() + 60_000, withdraw() {} }; },
    // ── test helpers, not part of the contract ──
    _calls: calls,
    _root: root,
    get _hook() { return calls.onHook.at(-1); },
    _remember(sid, key, label = key) { rules.push({ sid, key, label, at: Date.now(), uses: 0 }); },
    _setScreen(sid, rows) { screens.set(sid, rows); },
    _setSession(sid, s) { sessions.set(sid, s); },
    _setScrollback(sid, text) { scrollbacks.set(sid, text); },
    _setSettings(v) { values = { ...values, ...v }; for (const fn of calls.onSettings) fn({ ...values }); },
  };
  // HostPluginApi still carries the deprecated `<legacy slug>Dir` alias of stateDir; the name comes
  // from shared's LEGACY so the brand ratchet (`tools/brand.test.mjs`) is not spent on a mirror.
  for (const l of LEGACY) api[`${l.slug}Dir`] = api.stateDir;
  for (const m of opts.omit ?? []) delete api[m];
  return api;
}

/** The name copilot's tests already use. */
export const makeFakeApi = fakeApi;
