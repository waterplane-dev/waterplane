/**
 * The `HostPluginApi` one plugin's `activate()` receives — the seams in
 * docs/notes/plugins.md, each wrapping a core source so its rule cannot be
 * skipped: answers go through `answergate.ts`, file reads through the
 * containment guard, model calls through the meter, env reads through the
 * manifest's declared names.
 *
 * A repo is reached through `repo(repoId)`, whose reads go through the SAME
 * guards as `readRepoFile` (`contained`, `isSecretFile`) plus `inRoot`, so a
 * symlink out of the worktree reads as absent. Prompts reach an agent only via
 * `handToAgent`, which is the backlog add every other client uses.
 *
 * Every side-effecting call checks `live()`: an API handed to an activation
 * that has since been turned off (or replaced) goes quiet rather than acting
 * for a plugin the person switched off.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { BRAND, pluginValues, PLUGIN_EVENT_RE, PLUGIN_HOOK_HOLD_DEFAULT_MS, PLUGIN_HOOK_HOLD_MAX_MS, PLUGIN_PUSH_MAX } from "@waterplane/shared";
import type { HandToAgentResult, HostPluginApi, PluginBackendDef, PluginRepoScope, PluginSession, RepoTarget } from "@waterplane/shared";
import { forgetRules, gateAnswer, gateRule, rulesFor } from "../answergate.js";
import { registerBackend, registerScreenReader, registerStoreReader, unregisterBackend, type BackendDescriptor, type BackendModels } from "../backends/index.js";
import { readInlineImages } from "../files.js";
import { isSecretFile } from "../git.js";
import { contained, inRoot } from "../paths.js";
import { stripAnsi } from "../prompt.js";
import type { PluginEntry, PluginRegistry } from "./pluginregistry.js";
import { hostStateDir } from "../branddirs.js";
import { makePluginRoute, pluginRouteProblem } from "./pluginroutes.js";

/** A text file's bytes, or null for binary / unreadable — the `readRepoFile` rule. */
function readText(full: string, maxBytes: number): string | null {
  try {
    const buf = readFileSync(full);
    if (buf.includes(0)) return null;
    return buf.subarray(0, Math.max(0, maxBytes)).toString("utf8");
  } catch { return null; }
}

const gitOut = (wt: string, args: string[]): string | null => {
  try {
    return execFileSync("git", ["-C", wt, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  } catch { return null; }
};

/** One repo for a plugin to look at. Every path through `contained` + `inRoot`, never a secret. */
export function repoScope(t: RepoTarget): PluginRepoScope {
  const wt = t.worktreePath;
  const inside = (rel: unknown): string | null => {
    if (typeof rel !== "string") return null;
    const full = contained(wt, rel);
    if (!full || !inRoot(wt, full) || isSecretFile(relative(wt, full))) return null;
    return full;
  };
  return {
    id: t.id, name: t.repoName, branch: t.branch, isPrimary: t.isPrimary, worktree: wt,
    readFile: (relPath, maxBytes = 256 * 1024) => {
      const full = inside(relPath);
      return full ? readText(full, maxBytes) : null;
    },
    listDir: (relPath = ".") => {
      const full = inside(relPath);
      if (!full) return null;
      try {
        return readdirSync(full, { withFileTypes: true })
          .filter((d) => !isSecretFile(d.name))
          .map((d) => ({ name: d.name, dir: d.isDirectory() }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch { return null; }
    },
    git: () => {
      const branch = gitOut(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const status = gitOut(wt, ["status", "--porcelain", "-uall"]);
      if (branch == null || status == null) return null;
      return { branch, head: gitOut(wt, ["rev-parse", "--verify", "-q", "HEAD"]) || null, changed: status ? status.split("\n").length : 0 };
    },
  };
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const strMap = (v: unknown): Record<string, string> | undefined => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return out;
};
const regexOrNull = (v: unknown): RegExp | null => (v instanceof RegExp ? v : null);

/**
 * A plugin's backend as the core's descriptor — or a THROWN sentence saying
 * what is missing. Shape only: the registry (`registerBackend`) refuses a taken
 * id and an unknown reader name in its own words.
 *
 * What the plugin cannot say is the core's: `healthScope` is false (the health
 * board measures core readers against the claude TUI), every boolean it left
 * out is false, every delivery anchor it left out is null (`deliver.ts`'s
 * no-anchor rule). Its functions are called through guards, so a launch plan
 * that is not a list of strings is a refused launch in words, and a catalogue
 * that throws or answers garbage is an EMPTY catalogue — a free-text field,
 * never a guessed list.
 */
export function pluginDescriptor(def: PluginBackendDef, pluginName: string, opts: { experimental?: boolean; plugin?: string } = {}): BackendDescriptor {
  const d = (def ?? {}) as Partial<PluginBackendDef>;
  const missing: string[] = [];
  if (typeof d.id !== "string") missing.push("id");
  if (typeof d.label !== "string" || !d.label.trim()) missing.push("label");
  if (typeof d.bin !== "function") missing.push("bin()");
  if (typeof d.launchArgs !== "function") missing.push("launchArgs()");
  if (typeof d.models !== "function") missing.push("models()");
  const c0 = (d.caps ?? {}) as Partial<PluginBackendDef["caps"]>;
  if (!d.caps || typeof d.caps !== "object") missing.push("caps");
  else if (!HOOKS.includes(c0.hooks as string)) missing.push(`caps.hooks ("plugin-inject", "settings-inject" or "none")`);
  if (missing.length) throw new Error(`${pluginName}'s backend ${JSON.stringify(d.id ?? null)} is missing ${missing.join(", ")}`);
  const id = d.id!;
  const launch = d.launchArgs!.bind(d);
  const models = d.models!.bind(d);
  const bin = d.bin!.bind(d);
  // `delivery`, `caps` and `sources` are read THROUGH on every access, never copied here: a plugin
  // may answer them from getters a knob switches (opencode's `OPENCODE_SERVE`). Each normalised
  // answer is remembered against the object it came from, so an unchanged answer is the same
  // frozen object every time.
  const delivery = throughDef(() => d.delivery, normDelivery);
  const caps = throughDef(() => d.caps!, normCaps);
  return Object.freeze({
    id,
    label: d.label!.trim().slice(0, 60),
    bin: () => {
      const b = bin();
      if (typeof b !== "string" || !b) throw new Error(`${pluginName}'s backend "${id}" named no binary to run`);
      return b;
    },
    spawnEnv: Object.freeze(strMap(d.spawnEnv) ?? {}),
    launchArgs: (req) => {
      const p = launch(req) as unknown as Record<string, unknown> | null;
      if (!p || !Array.isArray(p.args) || p.args.some((a) => typeof a !== "string")) {
        throw new Error(`${pluginName}'s backend "${id}" did not answer a launch as a list of arguments`);
      }
      const env = strMap(p.env);
      return {
        args: [...(p.args as string[])],
        ...(typeof p.sessionId === "string" && p.sessionId ? { sessionId: p.sessionId } : {}),
        ...(typeof p.backendSessionId === "string" && p.backendSessionId ? { backendSessionId: p.backendSessionId } : {}),
        ...(p.createsRecord === true ? { createsRecord: true } : {}),
        ...(env && Object.keys(env).length ? { env } : {}),
        ...(typeof p.exec === "string" && p.exec ? { exec: p.exec } : {}),
      };
    },
    get delivery() { return delivery(); },
    get caps() { return caps(); },
    models: async (): Promise<BackendModels> => {
      const m = (await models()) as unknown as Record<string, unknown> | null;
      if (!m || typeof m !== "object") return { aliases: [], ids: [] };
      const where = m.where && typeof m.where === "object" ? Object.fromEntries(Object.entries(m.where as object).filter(([, v]) => v === "local" || v === "hosted")) as Record<string, "local" | "hosted"> : undefined;
      const win = m.contextWindow && typeof m.contextWindow === "object" ? Object.fromEntries(Object.entries(m.contextWindow as object).filter(([, v]) => typeof v === "number" && v > 0)) as Record<string, number> : undefined;
      return {
        aliases: strList(m.aliases), ids: strList(m.ids),
        ...(where ? { where } : {}),
        ...(Array.isArray(m.zeroCost) ? { zeroCost: strList(m.zeroCost) } : {}),
        ...(win && Object.keys(win).length ? { contextWindow: win } : {}),
        ...(typeof m.unavailable === "string" && m.unavailable ? { unavailable: m.unavailable.slice(0, 300) } : {}),
      };
    },
    healthScope: false,
    get sources() { const v = d.sources; return v && typeof v === "object" ? v : undefined; },
    ...(opts.experimental === true ? { experimental: true } : {}),
    ...(typeof opts.plugin === "string" && opts.plugin ? { plugin: opts.plugin } : {}),
  } satisfies BackendDescriptor);
}

const HOOKS: readonly string[] = ["settings-inject", "plugin-inject", "none"];

/** Read `get()` on every call; normalise only when it answers a different object than last time. */
function throughDef<I, O>(get: () => I, norm: (i: I) => O): () => O {
  let seen = false;
  let last: I | undefined;
  let out: O | undefined;
  return () => {
    const i = get();
    if (!seen || i !== last) { seen = true; last = i; out = norm(i); }
    return out as O;
  };
}

function normDelivery(v: PluginBackendDef["delivery"]): BackendDescriptor["delivery"] {
  const dl = v ?? {};
  const isLocal = typeof dl.isLocalCommand === "function" ? (t: string) => { try { return !!dl.isLocalCommand!(t); } catch { return false; } } : () => false;
  const noTurn = typeof dl.startsNoTurn === "function" ? (t: string) => { try { return !!dl.startsNoTurn!(t); } catch { return isLocal(t); } } : isLocal;
  return Object.freeze({
    submitKey: typeof dl.submitKey === "string" && dl.submitKey ? dl.submitKey : "\r",
    textThenSubmitDelayMs: Number.isFinite(dl.textThenSubmitDelayMs) && dl.textThenSubmitDelayMs! >= 0 ? dl.textThenSubmitDelayMs! : 150,
    ...(dl.requiresChannel === true ? { requiresChannel: true } : {}),
    pastePlaceholder: regexOrNull(dl.pastePlaceholder),
    composerCursorRe: regexOrNull(dl.composerCursorRe),
    composerRuleRe: regexOrNull(dl.composerRuleRe),
    composerPlaceholderRe: regexOrNull(dl.composerPlaceholderRe),
    trustPromptRe: regexOrNull(dl.trustPromptRe),
    isLocalCommand: isLocal,
    startsNoTurn: noTurn,
  });
}

function normCaps(v: PluginBackendDef["caps"]): BackendDescriptor["caps"] {
  const c = (v ?? {}) as Partial<PluginBackendDef["caps"]>;
  return Object.freeze({
    // Checked at registration; a later answer that is not one of the three is no hooks at all.
    hooks: (HOOKS.includes(c.hooks as string) ? c.hooks : "none") as BackendDescriptor["caps"]["hooks"],
    // Strings on purpose: `registerBackend` refuses a name core has no reader for.
    promptBoxes: (c.promptBoxes === false || c.promptBoxes === undefined ? false : c.promptBoxes) as BackendDescriptor["caps"]["promptBoxes"],
    transcript: (c.transcript ?? "none") as BackendDescriptor["caps"]["transcript"],
    slash: c.slash === "claude" || c.slash === "own" ? c.slash : "none",
    contextMeter: c.contextMeter === true, usageLimits: c.usageLimits === true, usageProbe: c.usageProbe === true,
    asking: c.asking === true, remoteControl: c.remoteControl === true, effort: c.effort === true,
    permissionModes: Object.freeze(strList(c.permissionModes)) as BackendDescriptor["caps"]["permissionModes"],
    ...(c.forkVia === "jsonl" || c.forkVia === "server" ? { forkVia: c.forkVia } : {}),
    // Absent ⇒ true: every plugin backend written before this cap is an agent with turns.
    turns: c.turns !== false,
  });
}

export function makeApi(reg: PluginRegistry, e: PluginEntry, gen: number): HostPluginApi {
  const id = e.manifest.id;
  const { sessions, root } = reg.deps; // the daemon's ROOT — the state dir here is the host's store
  const live = () => e.gen === gen && e.state === "active";
  const on = (kind: "prompt" | "question" | "action", fn: (x: any) => unknown): (() => void) => {
    if (!live()) return () => {};
    e.handlers[kind].add(fn);
    return () => { e.handlers[kind].delete(fn); };
  };
  const api: HostPluginApi = {
    id,
    dataDir: join(hostStateDir(root), "plugins", id),
    stateDir: hostStateDir(root),
    usmcDir: hostStateDir(root), // deprecated alias of stateDir
    log: (msg) => console.log(`[${BRAND.slug}] plugin ${id}: ${String(msg).slice(0, 2000)}`),

    settings: () => pluginValues(e.manifest, e.stored),
    onSettings: (fn) => {
      if (!live()) return () => {};
      e.onSettings.add(fn);
      return () => { e.onSettings.delete(fn); };
    },
    seedSettings: (values) => { if (live()) reg.seed(e, values); },
    setStatus: (s) => { if (live()) reg.setStatus(e, s); },
    env: (name) => (e.manifest.env ?? []).includes(name) ? process.env[name] : undefined,

    on: on as HostPluginApi["on"],

    session: (sid): PluginSession | null => {
      const s = sessions.get(sid);
      if (!s) return null;
      const toggles: Record<string, boolean> = {};
      for (const t of e.manifest.toggles ?? []) toggles[t.id] = s.pluginToggles?.[id]?.[t.id] ?? t.default;
      return {
        id: s.id, title: s.title, repoDir: s.cwd, cwd: s.cwd, watched: sessions.isWatched(sid), toggles,
        mayAnswer: !!e.manifest.answers && !!s.pluginAnswer?.[id],
      };
    },
    scrollback: (sid, lines = 200) => {
      if (!sessions.get(sid)) return "";
      const text = stripAnsi(sessions.scrollback(sid)).replace(/\r/g, "");
      return text.split("\n").slice(-Math.max(1, Math.min(5000, lines))).join("\n");
    },
    readRepoFile: (sid, relPath, maxBytes = 256 * 1024) => {
      const s = sessions.get(sid);
      if (!s || typeof relPath !== "string") return null;
      const full = contained(s.cwd, relPath);
      if (!full || isSecretFile(relative(s.cwd, full))) return null;
      return readText(full, maxBytes);
    },
    inlineImages: (sid, max = 4) => {
      const s = sessions.get(sid);
      if (!s) return [];
      return readInlineImages(s.cwd, { max }).map((i) => ({ mime: i.mime, data: i.dataB64, relPath: i.relPath }));
    },

    suggest: (sid, s) => { if (live()) reg.suggest(e, sid, s); },
    answer: async (sid, choice, why) => {
      if (!live()) return { ok: false, reason: `${e.manifest.name} is not running` };
      return gateAnswer(
        // Exactly two verbs: read the box, and the ONE answer dispatcher a
        // phone's tap goes through — never `input`/`write` past the gate.
        {
          sessions: { get: (sid2) => sessions.get(sid2), answerBox: (sid2, c) => sessions.answerBox(sid2, c) },
          decision: (row) => reg.deps.decision(row), notify: (k, p) => reg.deps.notify(k, p),
        },
        { id, name: e.manifest.name, answers: !!e.manifest.answers },
        sid, choice, String(why ?? ""), reg.told.get(sid) ?? null,
      );
    },
    // Standing rules: made by a PERSON's tap on a `remember` option (`boxes.ts`), never by the
    // plugin; a yes is the gate's, audited like a gated answer. Only the rules made on dialogs
    // THIS plugin's backend posed — keyed by plugin id, never shared by two declaring one backend.
    ruleAllows: (sid, key, why) => {
      if (!live()) return { ok: false, reason: `${e.manifest.name} is not running` };
      return gateRule(
        { sessions: { get: (sid2) => sessions.get(sid2) }, decision: (row) => reg.deps.decision(row), notify: (k, p) => reg.deps.notify(k, p) },
        { id, name: e.manifest.name, answers: !!e.manifest.answers, backends: e.manifest.backends ?? [] }, sid, key, String(why ?? ""),
      );
    },
    rules: (sid) => rulesFor(sid, id).map((r) => ({ key: r.key, label: r.label, at: r.at, uses: r.uses })),
    forgetRules: (sid) => (live() ? forgetRules({ sessionId: sid, plugin: id }) : 0),
    setBadge: (sid, badge) => { if (live()) sessions.setPluginBadge(sid, id, badge); },
    decision: (row) => {
      if (!live()) return;
      reg.deps.decision({
        ...row, id: randomUUID().slice(0, 8), ts: Date.now(), source: "plugin", plugin: id,
        sessionTitle: row.sessionTitle ?? sessions.get(row.sessionId)?.title ?? "",
      });
    },
    meter: (c) => {
      if (!live()) return;
      reg.deps.meter({
        service: String(c.service), model: String(c.model), kind: `plugin:${id}`,
        inTok: Math.max(0, Number(c.inTok) || 0), outTok: Math.max(0, Number(c.outTok) || 0), ts: Date.now(),
      });
    },
    notify: (n) => {
      if (!live()) return;
      reg.deps.notify("plugin", { title: String(n.title).slice(0, 200), body: String(n.body).slice(0, 1000), ...(n.sessionId ? { sessionId: n.sessionId } : {}), tag: `plugin-${id}-${n.sessionId ?? "all"}` });
    },
    claudeUsage: () => {
      const u = reg.deps.usage();
      return u?.ok ? { sessionPct: u.sessionPct, weeklyPct: u.weeklyPct } : null;
    },

    repo: async (repoId) => {
      if (typeof repoId !== "string" || !repoId) return null;
      const t = await reg.findRepo(repoId);
      return t ? repoScope(t) : null;
    },
    setupCheck: (fn) => {
      if (!live() || typeof fn !== "function") return () => {};
      e.setupChecks.add(fn);
      return () => { e.setupChecks.delete(fn); };
    },
    setupFix: (fixId, fn) => {
      if (!live() || typeof fn !== "function") return () => {};
      const taken = typeof fixId === "string" && fixId ? reg.fixTaken(e, fixId) : "a fix needs an id";
      if (taken) throw new Error(taken);
      e.setupFixes.set(fixId, fn);
      return () => { if (e.setupFixes.get(fixId) === fn) e.setupFixes.delete(fixId); };
    },
    handle: (method, fn) => {
      if (!live() || typeof fn !== "function" || typeof method !== "string" || !method) return () => {};
      e.methods.set(method, fn);
      return () => { if (e.methods.get(method) === fn) e.methods.delete(method); };
    },
    push: (event, data) => {
      if (!live()) return `${e.manifest.name} is not running`;
      if (typeof event !== "string" || !PLUGIN_EVENT_RE.test(event)) return `event "${String(event).slice(0, 60)}" is not a usable name — a letter first, then letters, digits and . _ -, 40 at most`;
      let bytes = 0;
      try { bytes = Buffer.byteLength(JSON.stringify(data ?? null), "utf8"); } catch { return "the data is not JSON"; }
      if (bytes > PLUGIN_PUSH_MAX) return `the data is ${Math.round(bytes / 1024)} KB — over the ${PLUGIN_PUSH_MAX / 1024} KB a push may carry`;
      if (!reg.deps.push) return "this host cannot push";
      reg.deps.push(id, event, data ?? null);
      return null;
    },
    handToAgent: async (repoId, prompt, opts = {}): Promise<HandToAgentResult> => {
      if (!live()) return { ok: false, reason: `${e.manifest.name} is not running` };
      if (typeof prompt !== "string" || !prompt.trim()) return { ok: false, reason: "nothing to hand over — the prompt is empty" };
      const t = typeof repoId === "string" && repoId ? await reg.findRepo(repoId) : null;
      if (!t) return { ok: false, reason: `no repo "${String(repoId)}" under this host's root` };
      if (!live()) return { ok: false, reason: `${e.manifest.name} is not running` };
      // A key makes the add at-most-once in the STORE (the agent route's rule);
      // 64 chars in all, because a chained row names its predecessor in 64.
      const intentId = opts.key === undefined ? undefined : `plugin-${id}-${String(opts.key)}`;
      if (intentId !== undefined && !(/^[A-Za-z0-9._:-]{1,64}$/.test(String(opts.key)) && intentId.length <= 64)) {
        return { ok: false, reason: `key "${String(opts.key).slice(0, 80)}" is not usable — letters, digits and . _ : - only, and ${64 - `plugin-${id}-`.length} chars at most` };
      }
      return reg.handToAgent({
        repoDir: t.worktreePath, text: prompt,
        ...(typeof opts.label === "string" && opts.label.trim() ? { label: opts.label.trim().slice(0, 120) } : {}),
        ...(intentId ? { id: intentId } : {}),
        origin: `plugin:${id}`, fire: opts.fire === true,
      });
    },

    backend: (def) => {
      if (!live()) throw new Error(`${e.manifest.name} is not running`);
      const bid = (def as { id?: unknown } | null)?.id;
      const declared = e.manifest.backends ?? [];
      if (typeof bid !== "string" || !declared.includes(bid)) {
        throw new Error(declared.length
          ? `${e.manifest.name} may register only the backends its manifest lists (${declared.join(", ")}), not ${JSON.stringify(bid ?? null)}`
          : `${e.manifest.name} lists no "backends" in its manifest, so it may not register ${JSON.stringify(bid ?? null)}`);
      }
      const desc = pluginDescriptor(def, e.manifest.name, { experimental: e.manifest.experimental === true, plugin: id });
      registerBackend(desc); // throws its own sentence: id taken, unknown reader
      e.backends.add(desc.id);
      return () => {
        if (!e.backends.delete(desc.id)) return;
        try { unregisterBackend(desc.id); } catch { /* a core id was never ours */ }
      };
    },
    // Readers by NAME (`backends/readers.ts`): registered before the backend that names them, and
    // gone with this activation. A taken or malformed name throws its own sentence.
    screenReader: (name, reader) => {
      if (!live()) throw new Error(`${e.manifest.name} is not running`);
      const off = registerScreenReader(name, reader);
      e.readers.add(off);
      return () => { if (e.readers.delete(off)) off(); };
    },
    storeReader: (name, reader) => {
      if (!live()) throw new Error(`${e.manifest.name} is not running`);
      const off = registerStoreReader(name, reader);
      e.readers.add(off);
      return () => { if (e.readers.delete(off)) off(); };
    },
    hookSink: () => `http://127.0.0.1:${reg.hookPort()}/api/plugin/${id}/hook`,
    onHook: (fn, opts = {}) => {
      if (!live() || typeof fn !== "function") return () => {};
      const asked = Number(opts?.maxHoldMs);
      const maxHoldMs = Number.isFinite(asked) && asked >= 0 ? Math.min(asked, PLUGIN_HOOK_HOLD_MAX_MS) : PLUGIN_HOOK_HOLD_DEFAULT_MS;
      const h = { fn, maxHoldMs };
      e.hook = h;
      return () => { if (e.hook === h) e.hook = null; };
    },
    // Served at `/api/plugin/<id>/<pattern>` behind the core's own gates (`pluginroutes.ts`).
    route: (method, pattern, fn) => {
      if (!live()) throw new Error(`${e.manifest.name} is not running`);
      if (typeof fn !== "function") throw new Error(`${e.manifest.name}: api.route needs a handler function`);
      const problem = pluginRouteProblem(method, pattern, e.routes);
      if (problem) throw new Error(`${e.manifest.name}: ${problem}`);
      const r = makePluginRoute(method, pattern, fn);
      e.routes.push(r);
      return () => { const i = e.routes.indexOf(r); if (i >= 0) e.routes.splice(i, 1); };
    },
  };
  return api;
}
