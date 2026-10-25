/**
 * The answer gate — the one way anything that is not a person's tap types an
 * answer into a choice box (docs/notes/plugins.md, "The answer gate").
 *
 * A plugin's `api.answer()` lands here, and every condition is the CORE's, so
 * a plugin cannot skip one:
 *
 *  1. the manifest declared `answers: true`;
 *  2. the session's "let <plugin> answer" switch is on (`SessionInfo.pluginAnswer`,
 *     default OFF, flipped only by `plugin.sessionAnswer` from the phone);
 *  3. the box on screen NOW is the one the plugin was told about (same
 *     `promptFingerprint`) — a box that moved on is never answered with a
 *     stale choice;
 *  4. the box is not blocked (`isBlocked`: trust/tool/plan kinds, or a question
 *     or option naming something destructive, permission-granting or secret);
 *     a checkbox box is refused too, because a digit TOGGLES a row there;
 *  5. `choice` is one of the box's options;
 *  6. on a session whose backend holds its ask rules through this gate
 *     (`askRulesVia: "gate"` — a CLI with allow/deny but no ASK, Copilot 1.0.91),
 *     a box whose question or options match one of the rules it was launched
 *     with (`askrules.ts`'s `askRuleMatches`) is a person's, and the refusal
 *     names the rule.
 *
 * Refused ⇒ `{ ok:false, reason }` in words and nothing typed. Accepted ⇒ the
 * same dispatcher a phone's tap goes through (`sessions.answerBox`: the CLI's
 * own channel, the walk for an unnumbered box, or `"<n>\r"`), a
 * `sent.json` row with `source: "plugin"`, a decision-log row and an
 * `autofire` notification. Caps are the plugin's own policy, not the gate's.
 *
 * The blocklist used to be the Gemini oracle's `isBlocked`; it is core's now,
 * because it guards the core's keystrokes whoever asks for them.
 */
import { randomUUID } from "node:crypto";
import { promptFingerprint } from "@waterplane/shared";
import type { DecisionLogEntry, DetectedPrompt } from "@waterplane/shared";
import { questionWindow } from "./question.js";
import { askRuleHit, askRulesForCwd } from "./askrules.js";
import { recordSent } from "./sentlog.js";
import type { Notify } from "./notifytypes.js";

/** Squash to a whitespace-free, lowercase view — the TUI renders without spaces. */
const squash = (s: string) => s.replace(/\s+/g, "").toLowerCase();

/** Box kinds nothing but a person ever answers. */
export const BLOCK_KINDS = new Set<DetectedPrompt["kind"]>(["trust", "tool", "plan"]);
/** Words (squashed) that make a numbered box a person's call. */
export const BLOCK_PATTERNS = [
  "delete", "remove", "rm-", "drop", "overwrite", "reset--hard", "forcepush",
  "push", "deploy", "publish", "merge", "rebase", "discard", "revert",
  "allow", "permission", "trust", "bypass", "alwaysallow", "dontask", "yolo",
  "credential", "secret", "token", "apikey", "password", "sudo", "chmod", "format",
];

/** Would the gate refuse this box whatever the switches say? */
export function isBlocked(p: Pick<DetectedPrompt, "kind" | "question" | "options">): boolean {
  if (BLOCK_KINDS.has(p.kind)) return true;
  const blob = squash(p.question + " " + p.options.map((o) => o.label).join(" "));
  return BLOCK_PATTERNS.some((pat) => blob.includes(pat));
}

/**
 * Free-text check, WORD boundaries (not squashed substrings) so prose like
 * "published"/"pushed" doesn't trip "publish"/"push", while real asks
 * ("force-push", a standalone "delete") still do.
 */
export const TEXT_BLOCK_RE = /\b(delete|remove|\brm\b|drop|overwrite|reset[- ]?hard|force[- ]?push|discard|revert|deploy|publish|push|merge|rebase|credential|secret|token|api[- ]?key|password|sudo|chmod|format|bypass|trust|permission|always[- ]?allow|dont[- ]?ask|yolo)\b/i;

/** High-stakes wording in a prose question's closing lines (`questionWindow`). */
export function isBlockedText(text: string): boolean {
  return TEXT_BLOCK_RE.test(questionWindow(text).join(" "));
}

/** Everything the gate decides on — pure, so each refusal is testable in words. */
export interface GateInput {
  pluginName: string;
  /** The manifest declared `answers: true`. */
  answers: boolean;
  /** The session exists and is running. */
  sessionLive: boolean;
  /** `SessionInfo.pluginAnswer[id]`. */
  switchOn: boolean;
  /** The box on screen now, or null. */
  prompt: DetectedPrompt | null;
  /** Fingerprint of the box the plugin was last told about on this session, or null. */
  told: string | null;
  choice: number;
  /** The ask rules the gate holds for this session (`askRulesVia: "gate"`); absent/empty = none. */
  askRules?: readonly string[];
}

/** The reason the gate refuses, in words — or null when it lets the answer through. */
export function gateRefusal(g: GateInput): string | null {
  if (!g.answers) return `${g.pluginName} did not declare "answers" in its manifest, so it may only suggest`;
  if (!g.sessionLive) return "that session is not running";
  if (!g.switchOn) return `"let ${g.pluginName} answer" is off for this session`;
  if (!g.prompt) return "no question is open on that session";
  if (!g.told || g.told !== promptFingerprint(g.prompt)) return "the question on screen is not the one the plugin was told about";
  if (BLOCK_KINDS.has(g.prompt.kind)) return `a ${g.prompt.kind} box is always a person's call`;
  const rule = g.askRules?.length ? askRuleHit(g.askRules, `${g.prompt.question}\n${g.prompt.options.map((o) => o.label).join("\n")}`) : null;
  if (rule) return `that question matches the ask rule ${rule} — a person's call`;
  if (isBlocked(g.prompt)) return "that question names something destructive, permission-granting or secret — a person's call";
  if (g.prompt.multi) return "a checkbox box is never answered automatically (a digit toggles a row there)";
  if (!Number.isInteger(g.choice) || !g.prompt.options.some((o) => o.index === g.choice)) return `${g.choice} is not one of the box's options`;
  return null;
}

/** What `gateAnswer` needs from the host — narrow, so it runs against fakes. */
export interface GateDeps {
  sessions: {
    get(id: string): { title: string; running: boolean; cwd?: string; prompt?: DetectedPrompt | null; pluginAnswer?: Record<string, boolean>; askRulesVia?: string } | null | undefined;
    /** The ONE answer dispatcher (`sessions/boxes.ts`): the CLI's own channel
     *  for a dialog it posed, else the walk for a `nav` box, else the digit. */
    answerBox(id: string, choice: number): Promise<{ ok: boolean; reason?: string }>;
  };
  decision(row: DecisionLogEntry): void;
  notify: Notify;
}

/**
 * Answer a session's CURRENT box on a plugin's behalf, or refuse in words.
 * Nothing is typed unless every condition holds.
 */
export async function gateAnswer(
  deps: GateDeps,
  plugin: { id: string; name: string; answers: boolean },
  sessionId: string, choice: number, why: string, told: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  const s = deps.sessions.get(sessionId);
  const prompt = s?.prompt ?? null;
  const reason = gateRefusal({
    pluginName: plugin.name, answers: plugin.answers, sessionLive: !!s?.running,
    switchOn: !!s?.pluginAnswer?.[plugin.id], prompt, told, choice,
    ...(s?.askRulesVia === "gate" ? { askRules: gateAskRules(sessionId, s.cwd) } : {}),
  });
  if (reason || !s || !prompt) return { ok: false, reason: reason ?? "no question is open on that session" };
  const label = prompt.options.find((o) => o.index === choice)?.label ?? `option ${choice}`;
  // The phone's tap, exactly — the same dispatcher the tap goes through: the
  // CLI's own channel for a dialog it posed, the host's walk for an unnumbered
  // box, "<n>\r" through the input path for a numbered one.
  const r = await deps.sessions.answerBox(sessionId, choice);
  const ok = r.ok; const failed = r.ok ? undefined : (r.reason ?? "the answer could not be typed");
  recordSent({
    sessionId, actor: "auto", source: "plugin", kind: "answer", text: String(choice),
    result: ok ? "written" : "failed",
    detail: `${plugin.name} answered "${label}"${why ? ` — ${why.slice(0, 200)}` : ""}`,
  });
  deps.decision({
    id: randomUUID().slice(0, 8), ts: Date.now(), sessionId, sessionTitle: s.title,
    source: "plugin", plugin: plugin.id, question: prompt.question,
    options: prompt.options.map((o) => ({ index: o.index, label: o.label })),
    outcome: ok ? "answered" : "error", choice, answer: label, rationale: why,
    ...(failed ? { error: failed } : {}),
  });
  if (!ok) return { ok: false, reason: failed ?? "the answer could not be typed" };
  deps.notify("autofire", { title: `Answered by ${plugin.name} · ${s.title}`, body: `Chose ${choice}. ${label}${why ? ` — ${why}` : ""}`, sessionId, tag: `autofire-${sessionId}` });
  return { ok: true };
}

// ── Ask rules held by the gate (`askRulesVia: "gate"`) ─────────────────────
//
// The rules a session was LAUNCHED with, the same "a running session keeps the rules it started
// with" as claude's `permissions.ask` (`askrules.ts`). Memory only: after a restart a re-attached
// session falls back to the rules its repo has NOW — the stricter of two unknowns is a person's
// tap. Dropped with the session's other rules (`forgetRules({sessionId})`).
const launchAskRules = new Map<string, readonly string[]>();

/** Record the ask rules a gate-held launch was given (`SessionManager.create`, `tmux.ts`'s re-attach). */
export function holdAskRules(sessionId: string, rules: readonly string[] | undefined): void {
  launchAskRules.set(sessionId, [...(rules ?? [])]);
}

/** The rules recorded for a session's launch, or undefined (never held, or a restart). */
export function heldAskRules(sessionId: string): string[] | undefined {
  const r = launchAskRules.get(sessionId);
  return r ? [...r] : undefined;
}

/** The ask rules the gate holds for a session: its launch's, else its repo's current ones. */
export function gateAskRules(sessionId: string, cwd: string | undefined): readonly string[] {
  return launchAskRules.get(sessionId) ?? askRulesForCwd(cwd);
}

/**
 * Hold a gate launch's ask rules around its spawn: a spawn that THROWS (no tmux, the PTY cap)
 * registers no session, so nothing would ever `forgetRules` it — the entry is released here.
 * A launch whose rules are not the gate's (`native`) holds nothing.
 */
export function holdAskRulesFor<T>(sessionId: string, via: string | undefined, rules: readonly string[] | undefined, spawn: () => T): T {
  if (via !== "gate") return spawn();
  holdAskRules(sessionId, rules);
  try { return spawn(); } catch (e) { launchAskRules.delete(sessionId); throw e; }
}

/** The ask rules the gate holds for THIS session — none unless it was launched `askRulesVia: "gate"`. */
export function sessionAskRules(sessionId: string, s: { cwd?: string; askRulesVia?: string } | null | undefined): readonly string[] {
  return s?.askRulesVia === "gate" ? gateAskRules(sessionId, s.cwd) : [];
}

/**
 * The ask rule a CLI-posed dialog names, or null — over its question, every option's label and
 * any `remember` the source put on a row (the key is often the command line itself). The same
 * words `gateRefusal` reads, plus what a standing rule would be keyed by.
 */
export function dialogAskRuleHit(rules: readonly string[], d: { question?: unknown; options?: readonly { label?: unknown; remember?: { key?: unknown; label?: unknown } }[] }): string | null {
  if (!rules.length) return null;
  const words: string[] = [typeof d.question === "string" ? d.question : ""];
  for (const o of d.options ?? []) {
    if (typeof o?.label === "string") words.push(o.label);
    if (typeof o?.remember?.key === "string") words.push(o.remember.key);
    if (typeof o?.remember?.label === "string") words.push(o.remember.label);
  }
  return askRuleHit(rules, words.join("\n"));
}

// ── Standing rules: a "don't ask again" a PERSON tapped ─────────────────────
//
// Some CLIs ask permission through a hook whose answer cannot persist a rule
// (Copilot 1.0.91: allow/deny only; the identical request asks again). A
// plugin may mark one option of a dialog it posed with `remember: {key, label}`
// (`SourceDialog`). When a PERSON's tap answers that option (`answerBox` with
// `byPerson`, i.e. the phone's route — never the gate's own answers), the host
// records a rule {session, plugin, backend, key} HERE — `plugin` being the one
// that REGISTERED the session's backend (`BackendDescriptor.plugin`), i.e. the
// owner of the source that posed the dialog. Later that plugin, and only it,
// may ask `api.ruleAllows(sessionId, key, why)`, which says yes only for that
// exact key, on that session, for a plugin that declared `answers` and that
// session's backend — and every yes is audited exactly as a gated answer is: a
// `sent.json` row `source: "plugin"`, a decision row, an `autofire` notification.
//
// Memory only: a restart forgets every rule (the safe direction for a switch
// that answers unattended), as does the session's exit and the plugin's
// switch-off. A tmux detach keeps them: the re-attached pane is the same
// conversation the person made the rule in. The plugin never creates one.

export interface AnswerRule {
  sessionId: string;
  /** The plugin that owns the source which posed the dialog — the only one that may use it. */
  plugin: string;
  backend: string;
  key: string;
  /** What the person approved, in words (e.g. the exact command line). */
  label: string;
  at: number;
  uses: number;
}

/** The longest key/label a rule keeps — a rule names one request, not a document. */
export const RULE_KEY_MAX = 2000;

const rules = new Map<string, AnswerRule>();
const ruleId = (sessionId: string, plugin: string, backend: string, key: string) => `${sessionId}\u0000${plugin}\u0000${backend}\u0000${key}`;

/** Told the session id whenever that session's rules change (made, used, forgotten). */
const listeners = new Set<(sessionId: string) => void>();
export function onRulesChanged(fn: (sessionId: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
const changed = (sessionIds: Iterable<string>) => {
  for (const sid of new Set(sessionIds)) for (const fn of listeners) { try { fn(sid); } catch { /* a listener never breaks the store */ } }
};

/**
 * The label a `remember` would be kept under — the HOST's words for the rule a tap makes,
 * shown on the option before the tap (`dialogToPrompt`) and on the rule after it — or null
 * when it is not something to keep (no key, too long).
 */
export function ruleLabel(r: { key: unknown; label: unknown } | null | undefined): string | null {
  if (!r || typeof r.key !== "string" || !r.key || r.key.length > RULE_KEY_MAX) return null;
  return typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, RULE_KEY_MAX) : r.key;
}

/**
 * Record the rule a person's tap made (`boxes.ts`'s `answerBox`, `byPerson`). Returns the rule,
 * or null when the option's `remember` is not something to keep (no key, too long, no owner).
 */
export function rememberRule(r: { sessionId: string; plugin: string | undefined; backend: string; key: unknown; label: unknown; askRules?: readonly string[]; text?: string }, now = Date.now()): AnswerRule | null {
  const label = ruleLabel(r);
  if (label === null || !r.sessionId || !r.backend || !r.plugin) return null;
  const key = r.key as string;
  // A dialog an ask rule the gate holds names is a person's EVERY time: the tap answers it, but
  // keeps no rule `ruleAllows` would then have to refuse (`dialogToPrompt` promised none).
  if (r.askRules?.length && askRuleHit(r.askRules, `${r.text ?? ""}\n${label}\n${key}`)) return null;
  const id = ruleId(r.sessionId, r.plugin, r.backend, key);
  const had = rules.get(id);
  if (had) return had;
  const rule: AnswerRule = { sessionId: r.sessionId, plugin: r.plugin, backend: r.backend, key, label, at: now, uses: 0 };
  rules.set(id, rule);
  changed([r.sessionId]);
  return rule;
}

/** One plugin's rules on one session, oldest first. */
export function rulesFor(sessionId: string, plugin: string): AnswerRule[] {
  return [...rules.values()].filter((r) => r.sessionId === sessionId && r.plugin === plugin).map((r) => ({ ...r }));
}

/** Every rule on one session, by plugin id, in the wire's shape (`SessionInfo.pluginRules`); undefined when none. */
export function sessionRules(sessionId: string): Record<string, { label: string; at: number; uses: number }[]> | undefined {
  const out: Record<string, { label: string; at: number; uses: number }[]> = {};
  for (const r of rules.values()) {
    if (r.sessionId !== sessionId) continue;
    (out[r.plugin] ??= []).push({ label: r.label.slice(0, 300), at: r.at, uses: r.uses });
  }
  return Object.keys(out).length ? out : undefined;
}

/** Drop rules: one session's, one plugin's, or both (and optionally only these backends'). Returns how many. */
export function forgetRules(f: { sessionId?: string; plugin?: string; backends?: readonly string[] }): number {
  // A session's end (no plugin named) also drops the ask rules the gate held for it.
  if (f.sessionId !== undefined && f.plugin === undefined && !f.backends) launchAskRules.delete(f.sessionId);
  let n = 0;
  const hit: string[] = [];
  for (const [k, r] of rules) {
    if (f.sessionId !== undefined && r.sessionId !== f.sessionId) continue;
    if (f.plugin !== undefined && r.plugin !== f.plugin) continue;
    if (f.backends && !f.backends.includes(r.backend)) continue;
    rules.delete(k); n++; hit.push(r.sessionId);
  }
  changed(hit);
  return n;
}

/** Why `ruleAllows` says no, in words — or null when that exact rule exists. Pure but for the store. */
export function ruleRefusal(g: { pluginId: string; pluginName: string; answers: boolean; backends: readonly string[]; session: { running: boolean; backend?: string } | null; sessionId: string; key: unknown; askRules?: readonly string[] }): string | null {
  // The same first rung as `gateRefusal`: a rule answers unattended, so it is an answer.
  if (!g.answers) return `${g.pluginName} did not declare "answers" in its manifest, so it may only suggest`;
  if (!g.session || !g.session.running) return "that session is not running";
  const b = g.session.backend ?? "claude";
  if (!g.backends.includes(b)) return `that session runs ${b}, which is not a backend ${g.pluginName} declares`;
  if (typeof g.key !== "string" || !g.key) return "no rule was named";
  const rule = rules.get(ruleId(g.sessionId, g.pluginId, b, g.key));
  if (!rule) return `no rule a person made on this session for ${g.pluginName} covers that — ask them`;
  // An ask rule outranks every standing allow, as claude's `permissions.ask` does (`askRulesVia: "gate"`).
  const ask = g.askRules?.length ? askRuleHit(g.askRules, `${rule.label}\n${rule.key}`) : null;
  if (ask) return `that request matches the ask rule ${ask} — a person's call, whatever "don't ask again" was tapped`;
  return null;
}

/**
 * May a plugin answer this request on the strength of a rule a person made? Yes only for that exact
 * rule; a yes is counted and audited (sent row, decision row, autofire note) exactly as a gated answer.
 */
export function gateRule(
  deps: Pick<GateDeps, "decision" | "notify"> & { sessions: { get(id: string): { title: string; running: boolean; backend?: string; cwd?: string; askRulesVia?: string } | null | undefined } },
  plugin: { id: string; name: string; answers: boolean; backends: readonly string[] },
  sessionId: string, key: unknown, why: string,
): { ok: boolean; reason?: string } {
  const s = deps.sessions.get(sessionId) ?? null;
  const reason = ruleRefusal({ pluginId: plugin.id, pluginName: plugin.name, answers: plugin.answers, backends: plugin.backends, session: s, sessionId, key, askRules: sessionAskRules(sessionId, s) });
  if (reason || !s) return { ok: false, reason: reason ?? "that session is not running" };
  const rule = rules.get(ruleId(sessionId, plugin.id, s.backend ?? "claude", key as string))!;
  rule.uses++;
  changed([sessionId]);
  recordSent({
    sessionId, actor: "auto", source: "plugin", kind: "answer", text: "rule", result: "written",
    detail: `${plugin.name} answered by the rule a person made: "${rule.label.slice(0, 200)}"${why ? ` — ${why.slice(0, 200)}` : ""}`,
  });
  deps.decision({
    id: randomUUID().slice(0, 8), ts: Date.now(), sessionId, sessionTitle: s.title,
    source: "plugin", plugin: plugin.id, question: `Allowed by a standing rule: ${rule.label}`,
    options: [], outcome: "answered", choice: null, answer: rule.label,
    rationale: `The rule a person tapped at ${new Date(rule.at).toISOString()} ("don't ask again", this session only); use ${rule.uses}.${why ? ` ${why}` : ""}`,
  });
  deps.notify("autofire", { title: `Allowed by a rule · ${s.title}`, body: rule.label.slice(0, 300), sessionId, tag: `autofire-${sessionId}` });
  return { ok: true };
}
