/**
 * What this phone may ask a session for — when the session is not `claude`.
 *
 * ── Why a module and not four `?.` in `App.tsx` ─────────────────────────────
 *
 * The host can now drive a second binary in the same PTY substrate
 * (`shared/wire/backend.ts`). Everything that differs is a CAPABILITY: a
 * backend that prints no context gauge, keeps no conversation log, has no
 * account quota, takes no `/slash`. Each of those is read in three or four
 * places in the UI, and each has exactly one correct failure mode — a
 * SENTENCE saying what is absent and why (CLAUDE.md: never grey out a button
 * to mean "not clickable"; a `title` is invisible on a phone). Spread across
 * call sites that becomes four different wordings and, eventually, a 0%.
 *
 * ── The two defaults that matter ────────────────────────────────────────────
 *
 *  1. **A list that never arrived is not an empty list.** `null` means this
 *     host never sent the `backends` frame — an older desktop that only knows
 *     `claude`. Then the picker is NOT RENDERED AT ALL (not greyed, not
 *     empty), every capability answers `true`, and every catalogue falls back
 *     to the claude tables this app has always carried. The screen is
 *     pixel-identical to what it was before this file existed. That gate is
 *     also what stops a new phone asking an old host to spawn a backend it has
 *     never heard of: `launchFor()` strips `backend` from the launch opts when
 *     there is no list to validate it against.
 *  2. **An unknown fact is absent, never a number.** `contextWindowTokens` is
 *     optional on the wire precisely because a local model's window is a fact
 *     about a file on someone else's disk. Absent renders as nothing — never
 *     0, never claude's own window.
 *
 * Pure on purpose: no React, no DOM, no `@waterplane/shared` VALUE imports, so
 * `backendCaps.test.mjs` runs it under `node --test` straight over the
 * TypeScript.
 */
import { BRAND } from "@waterplane/shared";
import type { BackendInfo, Effort, LaunchOpts, PermissionMode } from "@waterplane/shared";

/** The backend every session had before `SessionInfo.backend` existed. An
 *  ABSENT `backend` means this one — never "unknown". */
export const CLAUDE = "claude";

/** The plain-shell backend's id (`host/backends/shell.ts`). */
export const SHELL = "shell";

/**
 * There is NO model catalogue in this app. The host's descriptor carries it
 * (`BackendInfo.models`, built in `host/backends/claudemodels.ts` and
 * overridable by the owner's `models.json`), and `modelChoices` reads it off
 * the wire. Two tables that must agree about which models exist is how a
 * wrong one silently drops a model the binary supports. Before the first
 * `backends` frame, or on a host too old to send one, the answer is a
 * free-text field and a sentence — never an invented list.
 */
export const CLAUDE_EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const CLAUDE_PERM_MODES: PermissionMode[] = ["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"];

/** Every backend this host can launch — or `null`, meaning the `backends`
 *  frame has NEVER ARRIVED and this desktop only knows `claude`. */
export type BackendList = readonly BackendInfo[] | null;

/** The boolean half of `BackendInfo["caps"]` — the ones that gate a control.
 *  `permissionModes` is a list and has its own reader. */
export type BoolCap = "contextMeter" | "usageLimits" | "transcript" | "slash" | "promptBoxes" | "hooks" | "effort" | "remoteControl";

/**
 * The three capabilities that are OPTIONAL on the wire, and what each falls
 * back to when a descriptor never mentioned it.
 *
 * `fork`, `resumePick` and `contextSeries` were implied by `transcript` and
 * `contextMeter` until a backend turned up with one and not the other
 * (`shared/wire/backend.ts`). They went on the wire optional rather than as
 * `false`-defaulting booleans precisely so an OLD host keeps its controls: a
 * descriptor that never heard of them answers `undefined`, and `undefined`
 * must resolve to the flag that used to imply it, never to "no".
 *
 * **This table is the only place that knowledge lives.** A call site reading
 * `b.caps.fork` raw gets `undefined` from every desktop that has not upgraded
 * and, read as falsy, silently deletes *fork from here* from a working claude
 * session. So `hasCap` and `capReason` take these names too, and nothing else
 * touches the optional fields.
 */
export type OptCap = "fork" | "resumePick" | "contextSeries";

const OPT_FALLBACK: Record<OptCap, BoolCap> = {
  fork: "transcript",
  resumePick: "transcript",
  contextSeries: "contextMeter",
};

/** Anything `hasCap`/`capReason` will answer for. */
export type AnyCap = BoolCap | OptCap;

function isOpt(cap: AnyCap): cap is OptCap {
  return cap === "fork" || cap === "resumePick" || cap === "contextSeries";
}

/** Which backend a session runs. Absent means claude — a KNOWN value, not a
 *  missing one, so nothing downstream may render it as "unknown". */
export function backendIdOf(s: { backend?: string }): string {
  return s.backend || CLAUDE;
}

/** The descriptor for one backend, or null when the list never arrived or the
 *  id is not in it. Null is the "behave exactly as before" signal throughout. */
export function backendInfo(list: BackendList, id?: string): BackendInfo | null {
  if (!list) return null;
  return list.find((b) => b.id === (id || CLAUDE)) ?? null;
}

/**
 * Is this backend a plain shell — a PTY with no conversation, no turns, no
 * models? Read off `BackendInfo.kind` when the host described it, and off the id
 * when it did not (a shell session outliving a `backends` frame is still one).
 */
export function isShellBackend(list: BackendList, id?: string): boolean {
  return backendInfo(list, id)?.kind === "shell" || id === SHELL;
}

/** The backends a person may CHOOSE as the thing a session runs — every one
 *  but the shell, which is not an agent and is opened by its own action. A list
 *  that never arrived stays `null`. */
export function agentBackends(list: BackendList): BackendList {
  return list ? list.filter((b) => !isShellBackend(list, b.id)) : null;
}

/** The host's shell backend, or null when this host does not list one (an older
 *  host, or a build without it) — the "open a shell here" action is then not
 *  drawn at all. */
export function shellBackend(list: BackendList): BackendInfo | null {
  return list?.find((b) => b.kind === "shell") ?? null;
}

/**
 * Should the new-session flow offer a backend at all?
 *
 * Two nos, both silent: no frame (old host) and a host with exactly one
 * AGENT backend, where a picker is a control with one option — furniture that
 * implies a decision nobody has. The shell does not count: it is not offered in
 * this picker, so a host with claude + shell has one choice, not two.
 */
export function showBackendPicker(list: BackendList): boolean {
  const a = agentBackends(list);
  return !!a && a.length > 1;
}

/**
 * The one quiet line a shell session says in place of the claude-only strip
 * ("no reader view — …", "no context graph — …"). A shell never had those
 * things, so listing them as missing is noise; null for every other backend.
 */
export function shellQuietLine(list: BackendList, id?: string): string | null {
  if (!isShellBackend(list, id)) return null;
  return "A plain shell on the desktop — no conversation, models or context gauge here.";
}

/**
 * The marker a session row earns for running something other than claude —
 * null for claude and for anything we cannot name, because a session that
 * looks exactly as it always did is the whole compatibility promise.
 */
export function backendMark(list: BackendList, id?: string): string | null {
  const b = backendInfo(list, id);
  if (!b || b.id === CLAUDE) return null;
  return b.label;
}

/**
 * Does this backend have the capability at all?
 *
 * Unknown answers **true** — deliberately. "Unknown" here only happens on a
 * host that predates backends, where every session IS claude and every control
 * must stay exactly where it was. The conservative direction for a heuristic
 * (degrade to absent) is the opposite of the conservative direction for a
 * capability gate on an old host (degrade to today's UI).
 */
export function hasCap(list: BackendList, id: string | undefined, cap: AnyCap): boolean {
  const b = backendInfo(list, id);
  if (!b) return true;
  if (!isOpt(cap)) return b.caps[cap];
  // The documented resolution, in one place: stated wins, absent inherits.
  const stated = b.caps[cap];
  return typeof stated === "boolean" ? stated : b.caps[OPT_FALLBACK[cap]];
}

/**
 * The sentence shown WHERE THE CONTROL WOULD HAVE BEEN, or null when the
 * backend has the capability and the control is drawn normally.
 *
 * Every one of these names the backend by its own `label`, never the literal
 * "opencode": a third backend must read correctly with no edit here.
 */
export function capReason(list: BackendList, id: string | undefined, cap: AnyCap): string | null {
  const b = backendInfo(list, id);
  // Through `hasCap`, so an optional capability resolves its fallback here too
  // rather than being read raw and coming back `undefined` — which is falsy,
  // and would print an absent-capability sentence on a host that simply
  // predates the field.
  if (!b || hasCap(list, id, cap)) return null;
  return reasonText(cap, b.label);
}

/** The wording, split out so the test can pin it without building a descriptor
 *  per case. One sentence per capability, worded once. */
export function reasonText(cap: AnyCap, label: string): string {
  switch (cap) {
    case "transcript":
      return `this session runs ${label}, which keeps no Claude conversation log — there is no transcript to fork from here. The terminal scrollback is still on this screen.`;
    case "contextMeter":
      // A claim of NON-MEASUREMENT. Never a 0%, and never an empty graph
      // captioned "this conversation has not completed a turn" — that is a
      // different, false, claim.
      return `${label} doesn’t print a context gauge this app can read, so nothing here is measured — this is not a session that has run out of room.`;
    case "usageLimits":
      // Worded to stay clear of `limit.ts`'s detection regexes: this string can
      // end up on screen inside a session, and a banner phrase printed there
      // false-positives the detector repo-wide.
      return `${label} runs against no account quota this app can wait out, so nothing here is counted against one.`;
    case "slash":
      return `${label} doesn’t take Claude’s slash commands, so there is nothing to send one to here.`;
    case "promptBoxes":
      return `${label} doesn’t draw choice boxes this app can read — answer it by typing into the terminal.`;
    case "hooks":
      return `${label} doesn’t report when a turn ends, so “finished” here is inferred from silence rather than known.`;
    case "effort":
      return `${label} has no reasoning-effort setting to pick.`;
    case "remoteControl":
      return `${label} can’t be mirrored to a remote-control session.`;
    // ── the three that used to be implied ──────────────────────────────────
    case "fork":
      // Shown only where a READER EXISTS and cannot be branched from — see
      // `sessionCants`. With no transcript at all the transcript sentence
      // already says there is nothing to fork from, and two sentences making
      // the same point read as two separate losses.
      return `${label} keeps its conversation somewhere this app may read and must not rewrite, so a turn here can be read but not forked or reset to. Everything else in the reader works.`;
    case "resumePick":
      return `${label} has no “pick an older conversation” list this desktop knows how to drive — reopening carries on the folder’s own conversation instead.`;
    case "contextSeries":
      // A claim of NON-MEASUREMENT, same as `contextMeter`'s: never a 0%, and
      // never an empty graph captioned as a conversation that has done nothing.
      return `${label} leaves no context history this app can plot, so nothing here is measured — this is not a session that has run out of room.`;
  }
}

/**
 * What this session's BACKEND cannot do, as the strip under the toolbar says it.
 *
 * ── Why one builder and not four `capReason` calls at the call site ─────────
 *
 * Two of these rows are conditional on ANOTHER row, and the conditions are the
 * kind that rot:
 *
 *  - **fork is only worth a sentence when a reader exists.** For a backend with
 *    no transcript the reader row already says there is nothing to fork from;
 *    adding a second line makes one absence read as two.
 *  - **the slash row carries a COUNT**, and that count is the number of the
 *    user's own header chips being withheld this very render
 *    (`headerCmds.ts`'s `splitHeaderCmds`). CLAUDE.md: a count on a control is
 *    a filter, and one function feeds both the number and the cut. Here the
 *    cut is `splitHeaderCmds`' and the number is its `hiddenSlash`, handed
 *    straight in — never recomputed from the list a second time.
 *
 * **For claude this returns `[]`**, so `Unavailable` renders nothing and the
 * session screen is byte-identical. So does every host that never sent a
 * `backends` frame. Both are pinned by `backendCaps.test.mjs`.
 *
 * The return type is structural rather than `Unavailable.tsx`'s `Cant`: that
 * module imports lucide-react, and this one must stay runnable under
 * `node --test`.
 */
export function sessionCants(
  list: BackendList,
  id: string | undefined,
  opts: { hiddenSlash?: number } = {},
): { label: string; reason: string }[] {
  const out: { label: string; reason: string }[] = [];
  // A shell is not a claude missing its features: ONE quiet line (`shellQuietLine`)
  // replaces the whole strip.
  if (isShellBackend(list, id)) return out;
  const add = (label: string, cap: AnyCap, suffix = "") => {
    const reason = capReason(list, id, cap);
    if (reason) out.push({ label, reason: reason + suffix });
  };
  add("reader view", "transcript");
  // Only where the reader is actually drawn.
  if (hasCap(list, id, "transcript")) add("fork or reset to a turn", "fork");
  add("context graph", "contextSeries");
  const n = opts.hiddenSlash ?? 0;
  add("slash commands", "slash", n > 0
    ? ` — ${n} of your header chips ${n === 1 ? "is a Claude slash command and is" : "are Claude slash commands and are"} not offered here.`
    : "");
  return out;
}

/**
 * What `--model` will accept here.
 *
 * `freeText` is the whole point of the empty case: a backend whose catalogue
 * came back empty gets a typed field, never a guessed list. opencode's ids are
 * `provider/model` and carry colons (`ollama/qwen3-coder:30b`), so nothing may
 * split or strip them either.
 */
export function modelChoices(list: BackendList, id?: string): { aliases: string[]; ids: string[]; freeText: boolean } {
  const b = backendInfo(list, id);
  if (!b) return { aliases: [], ids: [], freeText: true };
  const aliases = [...b.models.aliases];
  const ids = [...b.models.ids];
  return { aliases, ids, freeText: aliases.length + ids.length === 0 };
}

/** The sentence under a typed model field, saying WHY it is typed. */
export function freeTextNote(list: BackendList, id?: string): string {
  return backendInfo(list, id)
    ? "This backend did not name its models, so type one."
    : "This desktop has not listed its models yet, so type one.";
}

/**
 * Should starting a session STOP and ask which backend and model to run?
 *
 * Three inputs, and two of them are refusals that matter more than the switch:
 *
 *  - **A resume is never asked.** A resumed conversation carries the launch it
 *    was recorded with, and offering to continue it under a different binary is
 *    not a resume — it is a new session wearing an old conversation's id.
 *  - **A caller that already decided is never re-asked.** The archive's explicit
 *    claude, a relaunch, a worktree row replaying its own opts: each answers this
 *    question by passing a launch in, and re-posing it would throw that away.
 *
 * Pure and here rather than inline in `App.openCwd` because those two are the
 * kind of rule that is obvious while you write it and invisible the day someone
 * adds a sixth caller.
 */
export function shouldAskLaunch(on: boolean, resume: boolean, hasOverride: boolean): boolean {
  return on && !resume && !hasOverride;
}

/** The effort ladder, or `[]` when this backend has no such knob — in which
 *  case the caller draws `capReason(..., "effort")` instead of the chips. */
export function effortChoices(list: BackendList, id?: string): Effort[] {
  const b = backendInfo(list, id);
  if (!b) return CLAUDE_EFFORTS;
  return b.caps.effort ? CLAUDE_EFFORTS : [];
}

/** Which permission modes this backend understands. Empty ⇒ it has no such
 *  concept and the control is absent, never a guessed subset of claude's. */
export function permModeChoices(list: BackendList, id?: string): PermissionMode[] {
  const b = backendInfo(list, id);
  if (!b) return CLAUDE_PERM_MODES;
  return [...b.caps.permissionModes];
}

/**
 * The backend's context window as words, or **null** when it is not known.
 *
 * The null is not a formatting detail: `contextWindowTokens` is absent exactly
 * when the size is a fact about a model file this app has never seen, and a
 * "0k" or an inherited 200k there is a wrong number on a screen whose whole
 * job is to be trusted.
 */
export function windowNote(list: BackendList, id?: string): string | null {
  const n = backendInfo(list, id)?.contextWindowTokens;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  return `${n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)} token window`;
}

/**
 * The launch opts as they may actually go on the wire.
 *
 * Two strippings and one DELIBERATE non-stripping:
 *
 *  - `backend` on a host that sent **no list at all** — the old-desktop gate.
 *    Stripping it there is not a judgement about the id, it is the same
 *    outcome the old host would reach by ignoring an unknown field, reached
 *    one hop earlier so the `model` chosen beside it can be stripped too if it
 *    ever needs to be. Without it a `backend`/`model` pair synced from another
 *    desktop spawns `claude --model ollama/…` on a host that never heard of
 *    either.
 *  - `backend: "claude"` — absent means claude, so the field is noise.
 *  - a flag the chosen backend has no concept of (`effort`, `remoteControlled`,
 *    a `permissionMode` it never listed). Sending one is asking a binary for a
 *    switch it does not have, which is a spawn that fails rather than a
 *    setting that is ignored.
 *
 * **What is NOT stripped: a list that exists and does not contain this id.**
 * That is a host which described its backends and does not have this one — a
 * launch synced from a desktop with more of them, a desktop rolled back to a
 * claude-only build, a queued create replayed after either. Deleting the field
 * there does not degrade to absent, it degrades to a DIFFERENT BINARY: the
 * create silently spawns claude, against an account the user deliberately
 * routed away from, with a model string claude has never heard of.
 *
 * So it goes on the wire as written and the host refuses it in words —
 * `resolveBackend()` already names the id and the ids it does have ("This host
 * has no backend called \"cline\". It can run: claude, opencode."), the op is
 * refused before anything is spawned, and `op.ack` lands that sentence on the
 * queue row. One wording, on the side that actually knows. Refusing here
 * instead would be a second copy of that rule judging an OFFLINE create against
 * a list from a host this phone may not even be talking to when the queue
 * drains.
 */
export function launchFor(o: LaunchOpts, list: BackendList): LaunchOpts {
  const n: LaunchOpts = { ...o };
  const b = backendInfo(list, n.backend);
  // A shell has no models: a `model` stored beside it (or synced from claude)
  // is never typed into a login shell.
  if (isShellBackend(list, n.backend)) { delete n.model; delete n.effort; delete n.permissionMode; delete n.remoteControlled; }
  if (!b) {
    // No descriptor — and the two reasons for that are not the same rule.
    if (!list) delete n.backend; // old host: it would have ignored the field anyway
    // A described host that lacks this id keeps the field: the host refuses.
    // Nothing else is checked either — there is no descriptor to check against,
    // and the whole op is about to come back as a sentence regardless.
    return prune(n);
  }
  if (b.id === CLAUDE) delete n.backend;
  if (!b.caps.effort) delete n.effort;
  if (!b.caps.remoteControl) delete n.remoteControlled;
  if (n.permissionMode && !b.caps.permissionModes.includes(n.permissionMode)) delete n.permissionMode;
  return prune(n);
}

/** Drop empty selections, so an unset field falls back to the backend's own
 *  default rather than being sent as "". Same rule `setLaunchOpt` applies. */
function prune(o: LaunchOpts): LaunchOpts {
  (Object.keys(o) as (keyof LaunchOpts)[]).forEach((k) => { if (!o[k]) delete o[k]; });
  return o;
}

/**
 * What the per-launch ask (`LaunchAskSheet`) STARTS from — the pair answered
 * there last time, or the stored defaults where there is no answer to reuse.
 *
 * The sheet's rule is unchanged and load-bearing: answering it never writes the
 * new-session defaults back (see `LaunchAskSheet`'s own note). What it now also
 * does is REMEMBER, which is a different claim: the defaults still say what a
 * session you are not thinking about runs, and this says what you picked the
 * last time you were asked. Without it the sheet re-posed the same question
 * with the same wrong-for-you answer pre-filled every single launch, which is
 * the switch's cost paid over and over for a decision already made.
 *
 * **The remembered value is a PAIR, and it is dropped as a pair.** A model id
 * belongs to the catalogue it came from — `opus` means nothing to a local
 * runner and `ollama/qwen3-coder:30b` means nothing to claude — so a remembered
 * model is offered only alongside the backend it was chosen for. This is
 * `LaunchAskSheet.pickBackend`'s rule applied to storage rather than to a tap.
 *
 * **A backend this host does not describe is not remembered into the control.**
 * `launchFor()` already strips such an id on the way to the wire, but a
 * `<select>` whose value matches no option renders as the FIRST one — so a
 * remembered `opencode` on a claude-only desktop would read back as "Claude
 * Code" while carrying `backend: "opencode"` into the create. Falling back to
 * the defaults here keeps the control and the launch saying the same thing.
 * The same gate covers a host that sent no list at all, where the picker is not
 * drawn and a remembered backend would be an invisible choice.
 */
export function launchAskStart(
  list: BackendList,
  defaults: LaunchOpts,
  last: { backend?: string; model?: string } | null | undefined,
): { backend?: string; model?: string } {
  const fallback = { backend: defaults.backend, model: defaults.model };
  if (!last) return fallback;
  const wanted = last.backend;
  // A shell is never an answer the ask offers, so it is never remembered into it.
  if (isShellBackend(list, wanted)) return fallback;
  // `backendInfo` answers for the claude default too (absent id ⇒ claude), so
  // "remembered claude on a host that describes claude" is a hit, not a miss.
  if (!backendInfo(list, wanted)) return fallback;
  return { backend: wanted, model: last.model };
}

/** Where a model runs, as the picker groups it. The third value is the one that
 *  matters: `unknown` is what an id the host said nothing about gets, and it is
 *  never quietly folded into `hosted` (`shared/wire/backend.ts`). */
export type ModelWhere = "local" | "hosted" | "unknown";

/**
 * The heading each group gets, and the sentence under it.
 *
 * Worded around the two things a person is actually choosing between — where the
 * bytes go and who pays — rather than around the word "provider", which is
 * opencode's vocabulary and not a fact anybody on a phone is thinking about.
 */
export const WHERE_LABEL: Record<ModelWhere, string> = {
  local: "On this desktop",
  hosted: "Hosted",
  unknown: "Not sure",
};

export const WHERE_NOTE: Record<ModelWhere, string> = {
  local: "Runs on the Mac. No network, no bill, nothing leaves the machine.",
  hosted: "Runs on somebody’s server.",
  // Said as ignorance, never as a guess. A host that could not determine this
  // is a host that must not have its silence read as either answer.
  unknown: "This desktop couldn’t say where these run.",
};

/**
 * The disclaimer a HOSTED model carries — and the reason it is worded like this.
 *
 * **waterplane must not restate a third party's data policy as fact.** Those terms
 * change without telling anybody, and an app that has baked one in is an app
 * that will eventually assert, in its own voice, something untrue about what
 * happens to somebody's source code. That is the one failure mode here that
 * cannot be fixed by a later release, because the person already sent the code.
 *
 * So this states only what is STRUCTURALLY true and always will be: a hosted
 * model means the prompt, and every file the agent reads into it, leaves this
 * machine and lands on hardware somebody else controls, under that operator's
 * terms and not waterplane's. The reader is pointed AT the terms rather than told
 * what they say.
 */
export const HOSTED_DISCLAIMER =
  "Your prompts — and the contents of every file the agent reads — leave this machine and are " +
  `processed on the operator’s servers, under the operator’s terms, not ${BRAND.displayName}’s. Read them before ` +
  "you point one of these at a private repo.";

/**
 * The extra line for a model the backend PRICES AT ZERO.
 *
 * Again: not a claim about any operator. It is the observation that free is a
 * price, not a policy, plus the instruction to go and read what is being taken
 * instead. Free coding tiers commonly settle up in training data — that is a
 * general caution the reader can verify, never an assertion about a named
 * vendor's current contract.
 */
export const ZERO_COST_DISCLAIMER =
  "Free of charge is not free of cost: providers of no-charge tiers commonly keep prompts and " +
  "completions to train on. Check what this one takes before sending anything you would not publish.";

/** Is this id one the host measured at zero price? Absent id ⇒ UNKNOWN, and
 *  unknown is never drawn as free — that is the direction that costs money. */
export function isZeroCost(ids: readonly string[] | undefined, id: string): boolean {
  return !!ids && ids.includes(id);
}

/**
 * Split a catalogue by where its models run.
 *
 * **Order is deliberate: local first.** This app exists to drive coding from a
 * phone against the machine on your desk, and the local models are the ones that
 * work with no tunnel and no bill. The list is what somebody scrolls; the first
 * thing in it is a recommendation whether or not anybody calls it one.
 *
 * **An empty group is dropped, never drawn empty.** A "Hosted (0)" heading is a
 * control that answers a question nobody asked and that cannot be tapped.
 *
 * Returns a SINGLE group when the host said nothing (`where` absent) — which is
 * what makes this safe to put in front of every backend: claude's descriptor
 * names no locality, so its picker keeps exactly the shape it had.
 */
export function modelGroups(
  ids: readonly string[],
  where: Readonly<Record<string, string>> | undefined,
): { where: ModelWhere; ids: string[] }[] {
  if (!where) return ids.length ? [{ where: "unknown", ids: [...ids] }] : [];
  const buckets: Record<ModelWhere, string[]> = { local: [], hosted: [], unknown: [] };
  for (const id of ids) {
    const w = where[id];
    // Anything that is not one of the two known verdicts is UNKNOWN — including
    // a value a newer host invented. Never a default of "hosted".
    buckets[w === "local" || w === "hosted" ? w : "unknown"].push(id);
  }
  return (["local", "hosted", "unknown"] as const)
    .filter((w) => buckets[w].length > 0)
    .map((w) => ({ where: w, ids: buckets[w] }));
}

/**
 * Should the picker offer the where-filter at all?
 *
 * Only when there is a CHOICE to make. One group is not a filter, it is
 * furniture implying a decision nobody has — the same rule
 * `showBackendPicker` applies to a host with one backend.
 */
export function showWhereFilter(groups: readonly { ids: string[] }[]): boolean {
  return groups.length > 1;
}

/**
 * Why this backend cannot be launched right now, as the host's own sentence
 * ("Ollama not reachable at http://…"), or null when nothing is known to be
 * wrong. A backend with one is still LISTED — hiding it would make a choice
 * that exists look like one that does not — and the phone says this instead
 * of failing silently. Unknown id / no list ⇒ null (never a made-up reason).
 */
export function backendUnavailable(list: BackendList, id?: string): string | null {
  const u = backendInfo(list, id)?.unavailable;
  return typeof u === "string" && u.trim() ? u.trim() : null;
}

/** A backend's label in a picker: the label alone, or with the plain facts that
 *  it is experimental (`BackendInfo.experimental`, from its extension's manifest)
 *  and that it cannot start right now. The sentence itself is drawn under the picker. */
export function backendOptionLabel(b: { label: string; unavailable?: string; experimental?: boolean }): string {
  const notes = [
    ...(b.experimental === true ? ["experimental"] : []),
    ...(b.unavailable && b.unavailable.trim() ? ["not available now"] : []),
  ];
  return notes.length ? `${b.label} (${notes.join(", ")})` : b.label;
}

/**
 * The session header's line about its side channel — the backend's own
 * structured channel (`SessionInfo.sideChannel`). **Up says nothing**: exact
 * turn boundaries are the normal case and a line for the normal case is
 * furniture. Absent says nothing either (no channel is not a down channel).
 * Down says so in words: the host's note when it gave one, else what is
 * actually happening — turns and boxes are read off the screen meanwhile.
 */
export function sideChannelLine(h: { state: "up" | "down"; note?: string } | undefined | null): string | null {
  if (!h || h.state !== "down") return null;
  const note = h.note?.trim();
  return note || "The CLI’s own channel is down — turns and questions are read off the screen meanwhile.";
}
