/**
 * The contract's checks as pure functions: each returns a list of sentences (empty = fine).
 *
 * Constants and validators that live in `@waterplane/shared` are IMPORTED (`./shared.mjs`). The
 * rules that live only in host TypeScript (`pluginDescriptor`, `factProblems` + core reader
 * tables in `backends/derive.ts`, `resolveLaunchFiles`, `sourceKeysProblem`/`sourceTypedProblem`)
 * are restated here, and `packages/host/test/plugintestkit.test.mjs` feeds the SAME bad fixtures to
 * both and fails when one refuses what the other accepts — so they cannot drift. The exception is
 * labelled in the code: `planLints` is KIT-ONLY (the host accepts what it flags) and is pinned only
 * in that direction.
 */
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import {
  FACT_NAMES, PLUGIN_BACKEND_ID_RE, SOURCE_KEYS_MAX, SOURCE_TYPED_MAX,
  launchModesProblems, sourceModeProblem, sourceCommandsProblems, sourceSpendProblems, sourceCompactionsProblems, sourceContextSampleProblems,
} from "./shared.mjs";

export const LAUNCH_FILES_MAX = 16;
export const LAUNCH_FILE_MAX_BYTES = 1024 * 1024;
export const INSTRUCTIONS_VIA = ["plugin-dir", "env-file", "config", "flag", "none"];
export const ASK_RULES_VIA = ["native", "gate", "none"];
/** 1.x cap names the 2.0 contract moved into `facts`. */
export const V1_CAPS = ["hooks", "promptBoxes", "transcript", "contextMeter", "usageLimits", "usageProbe", "asking", "forkVia"];

/** Core's readers per fact (`backends/derive.ts` CORE_SCREEN / CORE_STORE — parity-tested). */
export const CORE_SCREEN = {
  turns: ["silence"], dialogs: ["claude-numbered"], questions: ["question-ts"], asking: ["question-ts"],
  plan: ["planbox"], context: ["context-meter"], limits: ["limit-ts"], usage: ["usage-probe"],
};
export const CORE_STORE = {
  transcript: ["claude-jsonl"], context: ["claude-jsonl"], conversations: ["claude-jsonl"], tokens: ["claude-jsonl"],
  agents: ["claude-agents"],
};
const CONTRIBUTED_SCREEN = new Set(["dialogs"]);
const CONTRIBUTED_STORE = new Set(["transcript", "context", "conversations", "tokens"]);

/** Longest first: Shift+Tab (`\x1b[Z`) is one key, not an Escape (2.2 added it and Tab). */
const SOURCE_CONTROL_KEYS = ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\x1b[Z", "\r", "\t", "\x1b"];
const isControl = (cp) => cp < 0x20 || (cp >= 0x7f && cp < 0xa0);

/** What `pluginDescriptor` refuses: a def missing parts, a v1 cap, a bad id. */
export function descriptorProblems(def) {
  const d = def ?? {};
  const missing = [];
  if (typeof d.id !== "string") missing.push("id");
  if (typeof d.label !== "string" || !d.label.trim()) missing.push("label");
  if (typeof d.bin !== "function") missing.push("bin()");
  if (typeof d.prepare !== "function") missing.push("prepare()");
  if (typeof d.models !== "function") missing.push("models()");
  if (!d.caps || typeof d.caps !== "object") missing.push("caps");
  if (!d.facts || typeof d.facts !== "object" || Array.isArray(d.facts)) missing.push("facts");
  const ms = d.measured;
  if (!ms || !Array.isArray(ms.versions) || typeof ms.version !== "function") missing.push("measured ({ versions, version() })");
  const out = [];
  if (missing.length) out.push(`backend ${JSON.stringify(d.id ?? null)} is missing ${missing.join(", ")}`);
  if (d.caps && typeof d.caps === "object") {
    const stale = V1_CAPS.filter((k) => Object.hasOwn(d.caps, k));
    if (stale.length) out.push(`still declares ${stale.map((k) => `caps.${k}`).join(", ")} — the 2.0 contract moved these into \`facts\``);
  }
  if (typeof d.id === "string" && !PLUGIN_BACKEND_ID_RE.test(d.id)) out.push(`a backend id must be a short lowercase word (letters, digits, dashes); got ${JSON.stringify(d.id)}`);
  return out;
}

/** `readers`: the names this plugin CONTRIBUTED ({screen:Set, store:Set}). */
export function factProblems(facts, readers = { screen: new Set(), store: new Set() }) {
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return ["`facts` must be an object of provider lists, one per fact"];
  const out = [];
  for (const [fact, v] of Object.entries(facts)) {
    if (!FACT_NAMES.includes(fact)) { out.push(`there is no fact called \`${fact}\`; the facts are: ${FACT_NAMES.join(", ")}`); continue; }
    if (!Array.isArray(v)) { out.push(`facts.${fact} must be a list of providers`); continue; }
    for (const p of v) {
      if (!p || typeof p !== "object") { out.push(`facts.${fact} holds ${JSON.stringify(p)}, which is not a provider`); continue; }
      const keys = Object.keys(p);
      if (keys.length === 1 && p.source === true) continue;
      if (keys.length === 1 && typeof p.screen === "string") {
        const known = [...(CORE_SCREEN[fact] ?? []), ...(CONTRIBUTED_SCREEN.has(fact) ? readers.screen : [])];
        if (!known.includes(p.screen)) out.push(`facts.${fact}: no screen reader called \`${p.screen}\` answers ${fact}`);
        continue;
      }
      if (keys.length === 1 && typeof p.store === "string") {
        const known = [...(CORE_STORE[fact] ?? []), ...(CONTRIBUTED_STORE.has(fact) ? readers.store : [])];
        if (!known.includes(p.store)) out.push(`facts.${fact}: no store reader called \`${p.store}\` answers ${fact}`);
        continue;
      }
      out.push(`facts.${fact} holds ${JSON.stringify(p)}, which is not a provider ({source:true}, {screen:"<name>"}, or {store:"<name>"})`);
    }
  }
  return out;
}

/** The `sources` slot a `{source:true}` provider asks, per fact (`derive.ts` slotOf). */
function slotBacked(s, fact) {
  if (!s) return false;
  if (fact === "asking") return !!s.questions;
  if (fact === "limits") return typeof s.usage?.wall === "function";
  return !!s[fact];
}
/** Every `{source:true}` must be backed by the matching `sources` slot (a hollow provider is silently skipped by the host). */
export function sourceSlotProblems(facts, sources) {
  const out = [];
  for (const [fact, list] of Object.entries(facts ?? {})) {
    if (!Array.isArray(list)) continue;
    if (list.some((p) => p && p.source === true) && !slotBacked(sources, fact)) {
      out.push(`facts.${fact} asks {source:true} but sources.${fact === "asking" ? "questions" : fact === "limits" ? "usage.wall" : fact} is not provided`);
    }
  }
  return out;
}

const realish = (p) => {
  let cur = p; const rest = [];
  for (;;) {
    try { return join(realpathSync(cur), ...rest.reverse()); } catch { /* not there yet */ }
    const up = dirname(cur);
    if (up === cur) return p;
    rest.push(cur.slice(up.length).replace(/^[/\\]+/, ""));
    cur = up;
  }
};
const inside = (dir, p) => { const r = relative(dir, p); return !!r && !r.startsWith("..") && !isAbsolute(r); };
function sessionRel(name) {
  if (!name || name.includes("\0") || isAbsolute(name) || name.includes("\\")) return null;
  const n = normalize(name);
  if (n === "." || n.startsWith("..") || n.split(sep).includes("..")) return null;
  return n;
}

/** `resolveLaunchFiles`: ≤16 files, ≤1 MiB each, `session:<name>` or inside dataDir. */
export function launchFilesProblems(files, { dataDir } = {}) {
  if (files === undefined) return [];
  if (!Array.isArray(files)) return ["the launch files are something other than a list"];
  if (files.length > LAUNCH_FILES_MAX) return [`asked for ${files.length} launch files; at most ${LAUNCH_FILES_MAX} are written`];
  const out = [];
  const dataReal = dataDir ? realish(dataDir) : null;
  for (const f of files) {
    const path = f && typeof f.path === "string" ? f.path : "";
    if (!f || typeof f.content !== "string") { out.push(`launch file ${JSON.stringify(path)} has no text`); continue; }
    if (Buffer.byteLength(f.content) > LAUNCH_FILE_MAX_BYTES) { out.push(`launch file ${JSON.stringify(path)} is over ${LAUNCH_FILE_MAX_BYTES} bytes`); continue; }
    if (path.startsWith("session:")) {
      if (!sessionRel(path.slice("session:".length))) out.push(`launch file ${JSON.stringify(path)} leaves its session's launch dir`);
    } else if (!(isAbsolute(path) && dataReal && inside(dataReal, realish(resolve(path))))) {
      out.push(`launch file ${JSON.stringify(path)} is refused: only "session:<name>" or inside the plugin's data dir`);
    }
  }
  return out;
}

/** What the host does with `prepare`'s answer (`pluginDescriptor.prepare` + `resolveLaunchFiles`). */
export function planProblems(plan, { dataDir } = {}) {
  if (!plan || typeof plan !== "object") return ["prepare did not answer a plan"];
  const out = [];
  if (!Array.isArray(plan.args) || plan.args.some((a) => typeof a !== "string")) out.push("did not answer a launch as a list of arguments");
  if (!INSTRUCTIONS_VIA.includes(plan.instructionsVia)) out.push(`instructionsVia must be one of ${INSTRUCTIONS_VIA.join("/")}`);
  if (!ASK_RULES_VIA.includes(plan.askRulesVia)) out.push(`askRulesVia must be one of ${ASK_RULES_VIA.join("/")}`);
  out.push(...launchFilesProblems(plan.files, { dataDir }));
  return out;
}

/**
 * KIT-ONLY lints on a plan, NOT the host's rules: the host silently drops a non-string `env` value
 * or a non-list `dropEnv` (`strMap`/`strList`) and keeps any non-empty `exec` string. A plugin that
 * trips these still launches on the host, but not as it meant to; `conformance.mjs` fails them
 * anyway. Deliberately outside `planProblems` and unpinned by the host parity test, which instead
 * pins that the host accepts them.
 */
export function planLints(plan) {
  if (!plan || typeof plan !== "object") return [];
  const out = [];
  if (plan.env !== undefined && (!plan.env || typeof plan.env !== "object" || Object.values(plan.env).some((v) => typeof v !== "string"))) out.push("env must map names to strings");
  if (plan.dropEnv !== undefined && (!Array.isArray(plan.dropEnv) || plan.dropEnv.some((v) => typeof v !== "string"))) out.push("dropEnv must be a list of strings");
  if (plan.exec !== undefined && (typeof plan.exec !== "string" || !isAbsolute(plan.exec))) out.push("exec must be an absolute path");
  return out;
}

/**
 * `normCaps` (`plugins/pluginapi.ts`): the host never refuses `caps`, it NORMALISES (absent `turns` ⇒
 * true, absent `remoteControl` ⇒ false, a non-list `permissionModes` ⇒ [], an unknown `slash` ⇒
 * "none"). So a problem here is a cap the host would read differently from what the plugin wrote;
 * an ABSENT cap is fine. Pinned to the host by `plugintestkit.test.mjs`.
 */
export function capsProblems(caps) {
  if (!caps || typeof caps !== "object") return [];
  const out = [];
  if (caps.turns !== undefined && typeof caps.turns !== "boolean") out.push("caps.turns must be true or false (the host reads anything but false as true)");
  if (caps.remoteControl !== undefined && typeof caps.remoteControl !== "boolean") out.push("caps.remoteControl must be true or false (the host reads anything but true as false)");
  if (caps.permissionModes !== undefined && !Array.isArray(caps.permissionModes)) out.push("caps.permissionModes must be a list (the host reads anything else as none)");
  // 2.2: unlike the others the host REFUSES this one at registration (a launch set that is not a subset is not a launch set).
  if (caps.launchModes !== undefined) out.push(...launchModesProblems(Array.isArray(caps.permissionModes) ? caps.permissionModes : [], caps.launchModes).map((p) => `${p} (the host refuses the backend)`));
  if (caps.slash !== undefined && !["claude", "own", "none"].includes(caps.slash)) out.push(`caps.slash ${JSON.stringify(caps.slash)} is not claude, own or none (the host reads it as none)`);
  return out;
}

/** `sourceKeysProblem`: ≤SOURCE_KEYS_MAX keys, printable or Return/Escape/arrows/Tab/Shift+Tab. */
export function keysProblem(keys) {
  if (typeof keys !== "string" || keys.length === 0) return "it asked for no keystrokes";
  let n = 0;
  for (let i = 0; i < keys.length; n++) {
    const ctl = SOURCE_CONTROL_KEYS.find((k) => keys.startsWith(k, i));
    if (ctl) { i += ctl.length; continue; }
    const cp = keys.codePointAt(i);
    if (isControl(cp)) return `it asked for a control character (0x${cp.toString(16).padStart(2, "0")}) that is not Return, Escape, Tab, Shift+Tab or an arrow`;
    i += cp > 0xffff ? 2 : 1;
  }
  if (n > SOURCE_KEYS_MAX) return `it asked for ${n} keystrokes, and a box is answered with at most ${SOURCE_KEYS_MAX}`;
  return null;
}

/** `sourceTypedProblem`: ≤SOURCE_TYPED_MAX chars, no control char, `then` only Return. */
export function typedProblem(t) {
  if (!t || typeof t.typed !== "string" || !t.typed.length) return "it handed over nothing to type";
  if (t.then !== undefined && t.then !== "\r") return "it asked to end the words with a key that is not Return";
  if (t.typed.length > SOURCE_TYPED_MAX) return `it asked to type ${t.typed.length} characters, at most ${SOURCE_TYPED_MAX}`;
  for (let i = 0; i < t.typed.length; i++) if (isControl(t.typed.charCodeAt(i))) return "the words hold a control character";
  return null;
}

/** A source's reply to `answer()`: `{ok,reason?}`, or keys and/or typed words, each bounded. */
export function answerProblem(r) {
  if (r == null) return null; // the host treats nothing as "no answer"
  if (typeof r !== "object") return "an answer must be an object";
  if ("keys" in r) {
    const k = keysProblem(r.keys);
    if (k) return k;
    return "typed" in r ? typedProblem(r) : null;
  }
  if ("typed" in r) return typedProblem(r);
  if (typeof r.ok !== "boolean") return "an answer is {ok, reason?}, keys, or typed words";
  return null;
}

/**
 * What a 2.2 slot answers, judged by shared's own rule (imported, so no parity test is needed):
 * `kind` is `mode` (one of `permissionModes`, or null), `commands` (`/`-prefixed unique names, at
 * most `SOURCE_COMMANDS_MAX`), `spend` (`tokens.session`: stamped, figures finite ≥ 0, `native`
 * names a unit that is not dollars), `compactions` (oldest first, at most `SOURCE_COMPACTIONS_MAX`) or `context` (a sample; `window`
 * a whole number above 0 when stated). Null is always fine ("cannot say").
 */
export function readingProblems(kind, value, { permissionModes = [] } = {}) {
  switch (kind) {
    case "mode": { const p = sourceModeProblem(value, permissionModes); return p ? [p] : []; }
    case "commands": return sourceCommandsProblems(value);
    case "spend": return sourceSpendProblems(value);
    case "compactions": return sourceCompactionsProblems(value);
    case "context": return sourceContextSampleProblems(value);
    default: return [`there is no reading kind called ${JSON.stringify(kind)}; the kinds are mode, commands, spend, compactions, context`];
  }
}
