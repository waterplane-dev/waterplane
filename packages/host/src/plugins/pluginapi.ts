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
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { BRAND, bindConversation, pluginValues, PLUGIN_API_V2_DOC, PLUGIN_EVENT_RE, PLUGIN_HOOK_HOLD_DEFAULT_MS, PLUGIN_HOOK_HOLD_MAX_MS, PLUGIN_PUSH_MAX } from "@waterplane/shared";
import type { BackendFacts, HandToAgentResult, HostPluginApi, PluginBackendDef, PluginLaunchRequest, PluginRepoScope, PluginSession, Provider, RepoTarget } from "@waterplane/shared";
import { forgetRules, gateAnswer, gateRule, rulesFor } from "../answergate.js";
import { registerBackend, registerScreenReader, registerStoreReader, unregisterBackend, type BackendDescriptor, type BackendModels, type LaunchRequest } from "../backends/index.js";
import { readInlineImages } from "../files.js";
import { isSecretFile, secretAt } from "../git.js";
import { contained, containedReal, inRoot } from "../paths.js";
import { targetId } from "../repos.js";
import { stripAnsi } from "../prompt.js";
import { registerThermalReader } from "../sysstat.js";
import type { PluginEntry, PluginRegistry } from "./pluginregistry.js";
import { hostStateDir } from "../branddirs.js";
import { makePluginRoute, pluginRouteProblem } from "./pluginroutes.js";
import { screenOf } from "./plugintoolkit/screen.js";
import { sessionFilesDir } from "./plugintoolkit/sessionfiles.js";
import { tailJsonl } from "./plugintoolkit/tail.js";

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
/**
 * A repo by id, or — when the argument starts with `/` — by its worktree path, compared by realpath
 * (`/var` → `/private/var`). Ids stay `sha1(worktreePath)[:10]` (`repos.ts: targetId`), so the path is
 * turned into the candidate ids of its spellings and the hit must still realpath-equal the path.
 */
export async function repoByIdOrPath(reg: Pick<PluginRegistry, "findRepo" | "findRepoByPath">, repoId: string): Promise<RepoTarget | null> {
  if (!repoId.startsWith("/")) return reg.findRepo(repoId);
  const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };
  const want = real(repoId);
  if (!want) return null;
  for (const spelling of new Set([repoId.replace(/\/+$/, "") || "/", want])) {
    const t = await reg.findRepo(targetId(spelling));
    if (t && real(t.worktreePath) === want) return t;
  }
  // The id was made from a spelling the caller did not use (`/tmp` vs `/private/tmp`, a symlinked
  // root): the list itself, realpath-compared — still only a repo the host lists.
  return reg.findRepoByPath(want);
}

export function repoScope(t: RepoTarget): PluginRepoScope {
  const wt = t.worktreePath;
  const inside = (rel: unknown): string | null => {
    if (typeof rel !== "string") return null;
    const full = contained(wt, rel);
    if (!full || !inRoot(wt, full) || secretAt(wt, relative(wt, full), full)) return null;
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

/** The 1.x descriptor members 2.0 removed — named in the refusal so a stale plugin says what moved. */
const V1_CAPS = ["hooks", "promptBoxes", "transcript", "contextMeter", "usageLimits", "usageProbe", "asking", "forkVia"] as const;

/**
 * A plugin's backend as the core's descriptor — or a THROWN sentence saying
 * what is missing. Shape only: the registry (`registerBackend`) refuses a taken
 * id and an unknown reader name (`derive.ts`'s `factProblems`) in its own words.
 *
 * What the plugin cannot say is the core's: `healthScope` is false (the health
 * board measures core readers against the claude TUI), every boolean it left
 * out is false, every delivery anchor it left out is null (`deliver.ts`'s
 * no-anchor rule). Its functions are called through guards, so a launch plan
 * that is not a list of strings is a refused launch in words, and a catalogue
 * that throws or answers garbage is an EMPTY catalogue — a free-text field,
 * never a guessed list.
 *
 * 2.0: `prepare` (async, awaited by `create()`) replaces `launchArgs`; `facts` replaces the
 * reader caps. The plan's `instructionsVia`/`askRulesVia` are checked here (a plan that does
 * not say is refused in words); its `files` are the host's to check and write (`launchfiles.ts`).
 */
export function pluginDescriptor(def: PluginBackendDef, pluginName: string, opts: { experimental?: boolean; plugin?: string; dataDir?: string } = {}): BackendDescriptor {
  const d = (def ?? {}) as Partial<PluginBackendDef> & { launchArgs?: unknown };
  const missing: string[] = [];
  if (typeof d.id !== "string") missing.push("id");
  if (typeof d.label !== "string" || !d.label.trim()) missing.push("label");
  if (typeof d.bin !== "function") missing.push("bin()");
  if (typeof d.prepare !== "function") missing.push(typeof d.launchArgs === "function" ? "prepare() (2.0 replaced launchArgs())" : "prepare()");
  if (typeof d.models !== "function") missing.push("models()");
  if (!d.caps || typeof d.caps !== "object") missing.push("caps");
  if (!d.facts || typeof d.facts !== "object" || Array.isArray(d.facts)) missing.push("facts");
  const ms = d.measured as { versions?: unknown; version?: unknown } | undefined;
  if (!ms || !Array.isArray(ms.versions) || typeof ms.version !== "function") missing.push("measured ({ versions, version() })");
  if (missing.length) throw new Error(`${pluginName}'s backend ${JSON.stringify(d.id ?? null)} is missing ${missing.join(", ")}`);
  const stale = V1_CAPS.filter((k) => Object.hasOwn(d.caps as object, k));
  if (stale.length) {
    throw new Error(`${pluginName}'s backend ${JSON.stringify(d.id)} still declares ${stale.map((k) => `caps.${k}`).join(", ")} — the 2.0 contract moved these into \`facts\` (${PLUGIN_API_V2_DOC})`);
  }
  const id = d.id!;
  const prepare = d.prepare!.bind(d);
  const models = d.models!.bind(d);
  const bin = d.bin!.bind(d);
  const measuredVersion = ms!.version as () => Promise<string | null>;
  // `delivery`, `caps`, `facts`, `forkVia` and `sources` are read THROUGH on every access, never
  // copied here: a plugin may answer them from getters a knob switches (opencode's
  // `OPENCODE_SERVE`). Each normalised answer is remembered against the object it came from, so
  // an unchanged answer is the same frozen object every time.
  const delivery = throughDef(() => d.delivery, normDelivery);
  const caps = throughDef(() => d.caps!, normCaps);
  const facts = throughDef(() => d.facts!, normFacts);
  return Object.freeze({
    id,
    label: d.label!.trim().slice(0, 60),
    bin: () => {
      const b = bin();
      if (typeof b !== "string" || !b) throw new Error(`${pluginName}'s backend "${id}" named no binary to run`);
      return b;
    },
    spawnEnv: Object.freeze(strMap(d.spawnEnv) ?? {}),
    prepare: async (req) => {
      const p = (await prepare(pluginRequest(req))) as unknown as Record<string, unknown> | null;
      if (!p || !Array.isArray(p.args) || p.args.some((a) => typeof a !== "string")) {
        throw new Error(`${pluginName}'s backend "${id}" did not answer a launch as a list of arguments`);
      }
      const told = INSTRUCTIONS_VIA.find((v) => v === p.instructionsVia);
      const ask = ASK_RULES_VIA.find((v) => v === p.askRulesVia);
      if (!told || !ask) {
        throw new Error(`${pluginName}'s backend "${id}" did not say how its launch was told (instructionsVia: ${INSTRUCTIONS_VIA.join("/")}) and how its ask rules hold (askRulesVia: ${ASK_RULES_VIA.join("/")})`);
      }
      const env = strMap(p.env);
      const dropEnv = strList(p.dropEnv);
      const files = Array.isArray(p.files) ? (p.files as unknown[]).map((f) => {
        const o = (f ?? {}) as Record<string, unknown>;
        return { path: typeof o.path === "string" ? o.path : "", content: typeof o.content === "string" ? o.content : (null as unknown as string), ...(typeof o.mode === "number" ? { mode: o.mode } : {}) };
      }) : undefined;
      return {
        instructionsVia: told, askRulesVia: ask,
        ...(files ? { files } : {}),
        args: [...(p.args as string[])],
        ...(typeof p.sessionId === "string" && p.sessionId ? { sessionId: p.sessionId } : {}),
        ...(typeof p.backendSessionId === "string" && p.backendSessionId ? { backendSessionId: p.backendSessionId } : {}),
        ...(p.createsRecord === true ? { createsRecord: true } : {}),
        ...(env && Object.keys(env).length ? { env } : {}),
        ...(dropEnv.length ? { dropEnv } : {}),
        ...(typeof p.exec === "string" && p.exec ? { exec: p.exec } : {}),
      };
    },
    get delivery() { return delivery(); },
    get caps() { return caps(); },
    get facts() { return facts(); },
    get forkVia() { return d.forkVia === "server" ? "server" as const : undefined; },
    measured: Object.freeze({
      versions: Object.freeze(strList(ms!.versions)),
      version: async (): Promise<string | null> => {
        try { const v = await measuredVersion.call(ms); return typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null; }
        catch { return null; }
      },
    }),
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
        ...(typeof m.note === "string" && m.note.trim() ? { note: m.note.trim().slice(0, 300) } : {}),
      };
    },
    healthScope: false,
    get sources() { const v = d.sources; return v && typeof v === "object" ? v : undefined; },
    ...(opts.experimental === true ? { experimental: true } : {}),
    ...(typeof opts.plugin === "string" && opts.plugin ? { plugin: opts.plugin } : {}),
    ...(typeof opts.dataDir === "string" && opts.dataDir ? { dataDir: opts.dataDir } : {}),
  } satisfies BackendDescriptor);
}

/** How a plan may say it was told / its rules hold — anything else refuses the launch. */
const INSTRUCTIONS_VIA = ["plugin-dir", "env-file", "config", "flag", "none"] as const;
const ASK_RULES_VIA = ["native", "gate", "none"] as const;

/** The host's launch request as a 2.0 plugin sees it. */
function pluginRequest(req: LaunchRequest): PluginLaunchRequest {
  return {
    ...(req.resumeMode ? { resumeMode: req.resumeMode } : {}),
    ...(req.resumeSessionId ? { resumeSessionId: req.resumeSessionId } : {}),
    launch: req.launch, hookPort: req.hookPort,
    cwd: req.cwd ?? "", hostSessionId: req.hostSessionId ?? "",
    ...(req.forkAtTurn ? { forkAtTurn: req.forkAtTurn } : {}),
    instructions: req.instructions ?? "",
    askRules: [...(req.askRules ?? [])],
  };
}

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
  const effort = strList(c.effort);
  return Object.freeze({
    // Absent ⇒ true: an agent with turns; false = a plain shell.
    turns: c.turns !== false,
    slash: c.slash === "claude" || c.slash === "own" ? c.slash : "none",
    ...(effort.length ? { effort: Object.freeze(effort) } : {}),
    permissionModes: Object.freeze(strList(c.permissionModes)) as BackendDescriptor["caps"]["permissionModes"],
    // Copied as written (a non-list is kept so registration refuses it in words, `launchModesProblems`).
    ...(c.launchModes !== undefined ? { launchModes: (Array.isArray(c.launchModes) ? Object.freeze([...c.launchModes]) : c.launchModes) as BackendDescriptor["caps"]["launchModes"] } : {}),
    remoteControl: c.remoteControl === true,
  });
}

/** Provider lists copied and frozen; shapes are `factProblems`' to refuse at registration. */
function normFacts(v: PluginBackendDef["facts"]): BackendFacts {
  const out: Record<string, readonly Provider[]> = {};
  for (const [k, list] of Object.entries(v ?? {})) {
    if (!Array.isArray(list)) { out[k] = list as unknown as Provider[]; continue; } // refused by name at registration
    out[k] = Object.freeze(list.map((p) => (p && typeof p === "object" ? Object.freeze({ ...p }) : p)) as Provider[]);
  }
  return Object.freeze(out) as BackendFacts;
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
    // Toolkit (2.0): the host's one implementation of what every backend plugin copied.
    bindConversation,
    tail: (path, onLine, opts) => {
      const t = tailJsonl(path, (o) => { if (live()) onLine(o); }, opts);
      return { advance: () => (live() ? t.advance() : null), offset: () => t.offset(), close: () => t.close() };
    },
    screen: (sid) => (live() ? screenOf(sessions, sid) : null),
    sessionFiles: (sid) => (live() ? sessionFilesDir(sessions, hostStateDir(root), e.backends, sid) : null),
    supports: Object.freeze({ dialogKeysThenTyped: true }),
    readRepoFile: (sid, relPath, maxBytes = 256 * 1024) => {
      const s = sessions.get(sid);
      if (!s || typeof relPath !== "string") return null;
      const full = containedReal(s.cwd, relPath);
      if (!full || secretAt(s.cwd, relative(s.cwd, full), full)) return null;
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
      reg.deps.notify(n.urgent ? "approval" : "plugin", { plugin: id, title: String(n.title).slice(0, 200), body: String(n.body).slice(0, 1000), ...(n.sessionId ? { sessionId: n.sessionId } : {}), tag: `plugin-${id}-${typeof n.tag === "string" && n.tag ? n.tag.slice(0, 120) : (n.sessionId ?? "all")}` });
    },
    claudeUsage: () => {
      const u = reg.deps.usage();
      return u?.ok ? { sessionPct: u.sessionPct, weeklyPct: u.weeklyPct } : null;
    },

    // By id, or by an absolute worktree path realpath-compared against core's list (`repoByIdOrPath`,
    // as `handToAgent` already does): a CLI names its repo by path. Still only a repo core knows.
    repo: async (repoId) => {
      if (typeof repoId !== "string" || !repoId) return null;
      const t = await repoByIdOrPath(reg, repoId);
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
      const t = typeof repoId === "string" && repoId ? await repoByIdOrPath(reg, repoId) : null;
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
      const desc = pluginDescriptor(def, e.manifest.name, { experimental: e.manifest.experimental === true, plugin: id, dataDir: api.dataDir });
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
    // The machine readout's temperature and fans (`sysstat.ts`), where core has no reader.
    thermalReader: (name, reader) => {
      if (!live()) throw new Error(`${e.manifest.name} is not running`);
      const off = registerThermalReader(name, reader);
      e.readers.add(off);
      return () => { if (e.readers.delete(off)) off(); };
    },
    // One account's quota beside claude's (`usagesources.ts`); unregistered with this activation
    // like the readers, and a probe asked after a switch-off answers nothing.
    usageProbe: (def) => {
      if (!live()) throw new Error(`${e.manifest.name} is not running`);
      if (!reg.deps.usageProbe) throw new Error(`${e.manifest.name}: this host has no usage registry`);
      if (!def || typeof def.probe !== "function") throw new Error(`${e.manifest.name}: api.usageProbe needs a probe() function`);
      const probe = def.probe;
      const off = reg.deps.usageProbe(id, { ...def, probe: async () => (live() ? probe.call(def) : null) });
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
    // Since 1.4: binary frames to the ONE socket that opened the stream (`pluginstreams.ts`).
    // A bad or taken name throws its sentence; the returned function ends every open sub.
    stream: (name, handlers) => {
      if (!live()) throw new Error(`${e.manifest.name} is not running`);
      return reg.streams.serve(id, e.manifest.name, name, handlers);
    },
    // Since 1.5: one file from its own dataDir to the phone's download path, deleted by the core
    // once fetched or at its TTL (`pluginfiles.ts`). Outside dataDir, a symlink, a bad name: throws.
    offerFile: (file, opts) => {
      if (!live()) throw new Error(`${e.manifest.name} is not running`);
      return reg.files.offer(id, e.manifest.name, api.dataDir, file, opts);
    },
  };
  return api;
}
