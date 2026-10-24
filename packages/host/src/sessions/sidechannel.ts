/**
 * The side channel: a backend's OWN structured channel (`BackendSources`, a
 * local server's event stream, a plugin's hook sink), consumed for the two
 * facts that steer a live session — where a turn starts and ends, and which
 * dialog the CLI is asking (docs/analysis/backends-design.md §2).
 *
 * The ladder per fact is **source → screen reader → absent**, and this slice is
 * the top rung switching itself on and off:
 *
 *  - **attach** on `register()` for a backend whose descriptor has `sources`
 *    (and only then — a backend without them never reaches this file, so it is
 *    exactly today's backend). The channel's health is published as
 *    `SessionInfo.sideChannel`, "down" until `attach()` has said otherwise.
 *  - **turns**: `started`/`ended`/`ready` drive `turn.ts`'s ONE end-of-turn path
 *    (`core.sourceTurn` → `setTurn`/`settleStop`), and while the channel is up
 *    `hooksActive`/`hooked` say what they always said: exact boundaries live.
 *  - **dialogs**: `asked` publishes through `applyPrompt` with `askId` = the
 *    CLI's own id and `nav: true` (the phone then sends `promptChoice`, never a
 *    digit), options verbatim; `resolved` retires it; the `up` edge reconciles
 *    against `pending()`. The screen reader stands down while the channel owns
 *    the dialogs (`boxes.ts`'s `screenReaderOff`), because two readers on one
 *    box re-key its fingerprint.
 *  - **questions** (contract 2.0): a question the CLI posed with NO choice box
 *    (`sources.questions` — an agent's ask-the-user tool) publishes the same way,
 *    `kind: "question"`, `askId` = the CLI's id, `freeText` when a typed answer is
 *    accepted, options possibly empty; `closed` retires it; oldest first ACROSS
 *    dialogs and questions (`posedAt`). claude's box-less question is not this —
 *    it stays `question.ts`'s screen read, answered in the composer.
 *  - **plan** (`sources.plan`, typed in 2.0, consumed since 2.2): a plan the CLI posed
 *    publishes as the SAME plan box claude's screen read produces (`kind: "plan"`, the plan
 *    text on `DetectedPrompt.plan`, capped at `planbox.ts`'s `PLAN_CAP`), two rows — approve,
 *    keep planning — `askId` = the CLI's id, `nav`; `closed` retires it; oldest first across
 *    dialogs, questions and plans. Answered only by a person's tap (`sourceanswer.ts`'s
 *    `answerSourcePlan`, at most once per plan); the answer gate refuses a plan box.
 *  - **mode** (`sources.mode`, 2.2): its `watch` is a cue to re-read — `core.checkMode`, which
 *    asks `current()` (`livemode.ts`) — and so is the channel's `up` edge. Not handed back on
 *    `down`: there is no screen reader for another CLI's mode, and `current()` says null when
 *    it cannot tell.
 *  - **down**: everything above is handed back — `hooked` false (silence again),
 *    the source's box retired, the screen reader re-armed at once.
 *
 * Answering is not here: `boxes.ts`'s `answerBox` is the one dispatcher, and it
 * reads the dialogs this slice keeps on `Session.channel`.
 *
 * A CLASS for the facade's slice shape; it owns no state of its own — every
 * per-session fact is on `Session.channel`. Nothing a source reports becomes a
 * fact it did not state: a dialog with no question or no options is not
 * published (the screen reader may still find it), a `pending()` of `null`
 * leaves the screen reader on, and a callback from a channel already closed
 * changes nothing.
 */
import { realpathSync } from "node:fs";
import type { ChannelHealth, DetectedPrompt, SourceDialog, SourceHandle, SourcePlan, SourceQuestion, SourceSession, TurnFacts } from "@waterplane/shared";
import { MAX_BOX_OPTIONS } from "../prompt.js";
import { PLAN_CAP } from "../planbox.js";
import { PLAN_APPROVE, PLAN_KEEP } from "../sourceanswer.js";
import { dialogAskRuleHit, ruleLabel, sessionAskRules } from "../answergate.js";
import { setLiveSourceLookup } from "../livesources.js";
import { BACKENDS, derive } from "../backends/index.js";
import type { Session, SessionChannel, SessionCore } from "./core.js";
import { CONTEXT_FRESH_MS, CONTEXT_FRESH_POLL_MS, SEAT_SWEEP_MS } from "./knobs.js";

/** The wire shape of a dialog the CLI posed — or null when it states too little
 *  to be a box anybody could answer from a phone. */
export function dialogToPrompt(d: SourceDialog, opts: { keepsRules?: boolean; askRules?: readonly string[] } = {}): DetectedPrompt | null {
  if (!d || typeof d.id !== "string" || !d.id || typeof d.question !== "string") return null;
  // A dialog an ask rule the gate holds names is a person's every time: no option promises a
  // standing rule the gate would refuse (`answergate.ts`'s `ruleRefusal`, `rememberRule`).
  const keepsRules = !!opts.keepsRules && !(opts.askRules?.length && dialogAskRuleHit(opts.askRules, d));
  const options = (Array.isArray(d.options) ? d.options : [])
    .filter((o) => o && Number.isInteger(o.index) && typeof o.label === "string" && o.label.trim())
    .slice(0, MAX_BOX_OPTIONS)
    .map((o) => {
      // A tap on this option makes a standing rule (`answergate.ts`): say so ON the option, in
      // the label the HOST will keep — never the plugin's `key`, and only where a rule can be
      // made at all (`keepsRules`: the backend has an owning plugin to key it by).
      const kept = keepsRules ? ruleLabel(o.remember) : null;
      return {
        index: o.index, label: o.label,
        ...(typeof o.desc === "string" && o.desc ? { desc: o.desc } : {}),
        ...(kept !== null ? { remembers: { label: kept.slice(0, 300) } } : {}),
        // The row takes a typed reason (2.0): the phone offers a field, `answerBox` hands the words over.
        ...(o.takesText === true ? { takesText: true } : {}),
      };
    });
  if (!options.length) return null;
  return { kind: d.kind, question: d.question, options, nav: true, askId: d.id };
}

/** The wire shape of a question the CLI posed with no choice box (`sources.questions`) — or
 *  null when nobody could answer it from a phone: no question, or neither options nor a typed
 *  answer. `nav`: an option is NAMED (`promptChoice`), never typed as a digit. */
export function questionToPrompt(q: SourceQuestion): DetectedPrompt | null {
  if (!q || typeof q.id !== "string" || !q.id || typeof q.question !== "string") return null;
  const options = (Array.isArray(q.options) ? q.options : [])
    .filter((o) => o && Number.isInteger(o.index) && typeof o.label === "string" && o.label.trim())
    .slice(0, MAX_BOX_OPTIONS)
    .map((o) => ({ index: o.index, label: o.label, ...(typeof o.desc === "string" && o.desc ? { desc: o.desc } : {}) }));
  const freeText = q.freeText === true;
  if (!options.length && !freeText) return null;
  return { kind: "question", question: q.question, options, nav: true, askId: q.id, ...(freeText ? { freeText: true } : {}) };
}

/**
 * The wire shape of a plan the CLI posed on its own channel (`sources.plan`) — claude's plan box,
 * from a source: `kind: "plan"`, the question worded as claude's box words it (so `planbox.ts`'s
 * `isPlanBox` reads it as one), two rows the phone names (`nav`) and `answerSourcePlan` maps to
 * the two verbs, and the plan text capped at `PLAN_CAP` exactly as the plan file is. `plan.path`
 * is EMPTY: the text came over the backend's own channel and there is no file to point at — never
 * a made-up path (the wire field says so). No text ⇒ the box without a plan, as claude's box is
 * published when the file cannot be read.
 * Null when it states too little to answer: no id, or a verb missing.
 */
export function planToPrompt(p: SourcePlan, label: string): DetectedPrompt | null {
  if (!p || typeof p.id !== "string" || !p.id || typeof p.approve !== "function" || typeof p.keepPlanning !== "function") return null;
  const text = typeof p.text === "string" ? p.text : "";
  const cut = text.length > PLAN_CAP;
  return {
    kind: "plan",
    question: `${label} has written up a plan and is ready to execute. Would you like to proceed?`,
    options: [{ index: PLAN_APPROVE, label: "Yes, proceed with the plan" }, { index: PLAN_KEEP, label: "No, keep planning" }],
    nav: true, askId: p.id,
    ...(text.trim() ? { plan: { text: cut ? text.slice(0, PLAN_CAP) : text, path: "", ...(cut ? { cut: true } : {}) } } : {}),
  };
}

const sameHealth = (a: ChannelHealth | undefined, b: ChannelHealth) =>
  !!a && a.state === b.state && a.since === b.since && (a.note ?? "") === (b.note ?? "");

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * Why a send must wait: the backend says typed words are swallowed while its channel is down
 * (`delivery.requiresChannel`, opencode's TUI on a dead `serve`), and the channel is not up.
 * `connecting` = the channel has not answered yet (a session seconds old) — worth a short wait;
 * otherwise it was up, or failed, and the send is held at once.
 */
export interface SendHold { connecting: boolean; sentence: string }

export class ChannelSlice {
  private sweepTimer: NodeJS.Timeout | null = null;
  /** The turn-end wait for a fresh context sample, and its re-ask cadence (tests shorten them). */
  contextWaitMs = CONTEXT_FRESH_MS;
  contextPollMs = CONTEXT_FRESH_POLL_MS;

  constructor(private readonly core: SessionCore) {
    // The readers outside the slices (`deliver.ts`, `settle.ts`, `record.ts`, `ctxseries.ts`)
    // reach a live session's sources through this lookup (`livesources.ts`). Installed by the one
    // manager that owns the channels; nothing installed ⇒ every reader is exactly today's.
    setLiveSourceLookup((id) => {
      const s = this.core.sessions.get(id);
      const ch = s?.channel;
      const sources = s?.backend.sources;
      if (!s || !ch || ch.closed || !sources) return null;
      return { session: this.sourceSession(s), sources, health: () => (ch.handle ? ch.handle.health() : null) };
    });
  }

  /** Must a send into this session wait for its channel? Null = no. Never a wait itself. */
  sendHold(s: Session): SendHold | null {
    if (!s.backend.delivery.requiresChannel || !s.backend.sources) return null;
    const ch = s.channel;
    // A session the source says has NO channel (a pane started before it had one) is
    // screen-only, exactly like a backend without sources: holding its sends would hold them
    // for ever behind a server that will never exist.
    if (ch?.screenOnly) return null;
    const h = s.info.sideChannel;
    if (h?.state === "up") return null;
    const connecting = !!ch && !ch.closed && ch.attaching;
    const why = h?.note ? ` (${h.note})` : "";
    // Only a channel that WAS up has a server the backend brings back; one that never came up
    // promises nothing.
    if (ch && !connecting && !ch.everUp) {
      return {
        connecting: false,
        sentence: `${s.backend.label}'s own channel for this session did not start${why}, and its terminal silently drops a prompt `
          + "typed without it — so nothing was typed.",
      };
    }
    return {
      connecting,
      sentence: `${s.backend.label}'s own server for this session is not answering${why}, and its terminal silently drops a prompt `
        + "typed while it is down — so nothing was typed. It is sent once the server is back.",
    };
  }

  /**
   * Ask every backend that can (`sources.sweep`) to reap what a GONE session left behind —
   * once now, then every `SEAT_SWEEP_MS`. Alive = a session this manager holds, or a tmux
   * pane still running under that id (detached, parked); never anything else.
   */
  sweep(): void {
    const alive = (id: string): boolean => this.core.sessions.has(id) || !!this.core.hasLiveTmux(id);
    for (const b of BACKENDS) {
      let sources;
      try { sources = b.sources; } catch { continue; }
      if (!sources?.sweep) continue;
      try { sources.sweep(alive); } catch { /* a backend's own reaper; the next pass asks again */ }
    }
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), SEAT_SWEEP_MS);
      this.sweepTimer.unref?.();
    }
  }

  /** Bring the backend's channel up for a session just registered (spawned or
   *  re-attached). A no-op — and the field cleared — without `sources`. */
  attach(s: Session): void {
    const sources = s.backend.sources;
    if (!sources) { if (s.info.sideChannel) s.info.sideChannel = undefined; return; }
    if (s.channel && !s.channel.closed) return;
    const ch: SessionChannel = {
      handle: null, attaching: true, unwatch: [], turnsLive: false, dialogsLive: false, reconciling: false, dialogs: new Map(), published: null, closed: false,
      suspendOnClose: false, everUp: false, screenOnly: null, unposed: 0, questions: new Map(), posedAt: new Map(), posedSeq: 0, questionsLive: false,
      plans: new Map(),
    };
    s.channel = ch;
    // Not yet up, so said so: a `requiresChannel` backend holds its sends
    // until the channel has answered, which is the safe side of a TUI that
    // swallows prompts typed while its server is gone. An IN-BAND channel
    // (claude's hook pipe) publishes nothing: its health is `hooked` itself.
    if (!sources.inBand) s.info.sideChannel = { state: "down", since: Date.now(), note: "connecting to the CLI's own channel" };
    const ss = this.sourceSession(s);
    let attached: Promise<SourceHandle>;
    try { attached = sources.attach(ss, (h) => this.onHealth(s, ch, h)); } catch (e) { attached = Promise.reject(e); }
    // In-band: nothing to connect, so the subscriptions are live NOW — a hook
    // can be routed before the promise below settles.
    if (sources.inBand) this.watch(s, ch, ss);
    attached.then((handle) => {
      ch.attaching = false;
      // Detached while connecting: a tmux DETACH still suspends (the pane runs on and dials
      // the backend's child), only an ending closes.
      if (ch.closed) { void (ch.suspendOnClose && handle.suspend ? handle.suspend() : handle.close()).catch(() => {}); return; }
      ch.handle = handle;
      if (typeof handle.screenOnly === "string" && handle.screenOnly) {
        // No channel and never one: said so in words, every rung stays the screen's, and no
        // send is held (`sendHold`). Nothing is watched.
        const note = handle.screenOnly.slice(0, 300);
        this.onHealth(s, ch, { state: "down", since: Date.now(), note });
        ch.screenOnly = note; // from here every health report is ignored
        return;
      }
      // The channel knows the CLI's own conversation id (the daemon created it on the backend's
      // server): adopted now, so the store watcher has nothing to find (`convid.ts`).
      if (handle.backendSessionId && !s.info.backendSessionId) this.core.adoptBackendId(s, handle.backendSessionId);
      if (!sources.inBand) this.watch(s, ch, ss);
      let h: ChannelHealth;
      try { h = handle.health(); } catch (e) { h = { state: "down", since: Date.now(), note: errText(e) }; }
      this.onHealth(s, ch, h);
    }, (e) => {
      ch.attaching = false;
      this.onHealth(s, ch, { state: "down", since: Date.now(), note: `the CLI's own channel did not start: ${errText(e)}` });
    });
  }

  /** Tear the channel down — the session exited or was detached. Idempotent. A tmux DETACH
   *  (`s.detaching`: the pane runs on) suspends the handle instead, so a child the CLI depends on
   *  (opencode's server) survives for the re-attach. */
  detach(s: Session): void {
    const ch = s.channel;
    if (!ch || ch.closed) return;
    ch.closed = true;
    ch.suspendOnClose = s.detaching;
    ch.pendingEnd?.cancel();
    for (const u of ch.unwatch) { try { u(); } catch { /* a source's own teardown */ } }
    ch.unwatch = [];
    ch.dialogs.clear(); ch.questions.clear(); ch.plans.clear(); ch.posedAt.clear();
    ch.published = null;
    ch.turnsLive = false; ch.dialogsLive = false; ch.questionsLive = false;
    const h = ch.handle; ch.handle = null;
    if (h) void (s.detaching && h.suspend ? h.suspend() : h.close()).catch(() => { /* already gone */ });
  }

  private sourceSession(s: Session): SourceSession {
    let cwd = s.info.cwd;
    try { cwd = realpathSync(cwd); } catch { /* the record's own path */ }
    return {
      id: s.info.id, cwd, spawnedAt: s.spawnedAt,
      ...(s.info.backendSessionId ? { backendSessionId: s.info.backendSessionId } : {}),
    };
  }

  private watch(s: Session, ch: SessionChannel, ss: SourceSession): void {
    const { turns, dialogs, questions, plan, mode } = s.backend.sources ?? {};
    const live = () => !ch.closed && s.channel === ch;
    if (turns) {
      const edge = (e: "started" | "ended" | "ready", f?: TurnFacts) => { if (live()) this.core.sourceTurn(s, e, f); };
      // Every edge first settles an end still waiting for its context sample: edges stay in order.
      const next = (e: "started" | "ended" | "ready", f?: TurnFacts) => { ch.pendingEnd?.flush(); edge(e, f); };
      try {
        ch.unwatch.push(turns.watch(ss, {
          started: (_at, f) => next("started", f), ready: (f) => next("ready", f),
          ended: (at, f) => {
            if (!live()) return;
            ch.pendingEnd?.flush();
            this.endWhenFresh(s, ch, ss, at, () => edge("ended", f));
          },
          identified: (id) => { if (live() && typeof id === "string") this.core.sourceIdentified(s, id); },
        }));
      } catch { /* a source that cannot watch is a source with no turns */ }
    }
    if (dialogs) {
      try {
        ch.unwatch.push(dialogs.watch(ss, {
          asked: (d) => { if (live()) this.asked(s, ch, d); },
          resolved: (id) => { if (live()) this.resolved(s, ch, id); },
          unposed: (n) => { if (live()) this.unposed(s, ch, n); },
        }));
      } catch { /* same */ }
    }
    if (questions) {
      try {
        ch.unwatch.push(questions.watch(ss, {
          asked: (q) => { if (live()) this.askedQuestion(s, ch, q); },
          closed: (id) => { if (live()) this.closedQuestion(s, ch, id); },
        }));
      } catch { /* same */ }
    }
    // The 2.2 consumers ask the FACT, not the slot alone: the wire cap (`has("plan")`,
    // `modes`) is read off the same table, so the phone is offered exactly what runs here.
    const facts = derive(s.backend);
    if (plan && facts.askSource("plan")) {
      try {
        ch.unwatch.push(plan.watch(ss, {
          posed: (p) => { if (live()) this.posedPlan(s, ch, p); },
          closed: (id) => { if (live()) this.closedPlan(s, ch, id); },
        }));
      } catch { /* same */ }
    }
    if (mode?.watch && facts.askSource("mode")) {
      try {
        ch.unwatch.push(mode.watch(ss, () => { if (live()) this.core.checkMode(s); }));
      } catch { /* a source that cannot watch is re-read on the quiet tick */ }
    }
  }

  /**
   * Settle a source turn's end once the backend's `context` sample is stamped at or after the
   * end's `at`, waiting at most `contextWaitMs` — so the turn-end context read (`markIdle` →
   * `checkContext` → `ctxseries.ts`'s `sourceContext`) is THIS turn's fill, and a plugin needs no
   * hold of its own before calling `ended`. Woken by the source's `watch()` when it has one, else
   * re-asked every `contextPollMs`. No context source, an in-band channel (claude's hooks: its
   * end path takes no wait), an `at` that is not a number, or a sample already fresh ⇒ at once.
   * Past the bound the end settles as it always did: the reading is whatever the source holds,
   * or absent — never a number made up to fill the gap. A later edge flushes the wait first.
   */
  private endWhenFresh(s: Session, ch: SessionChannel, ss: SourceSession, at: number, settle: () => void): void {
    const ctx = s.backend.sources?.context;
    const fresh = (): boolean => {
      let c;
      try { c = ctx!.sample(ss); } catch { c = null; }
      return !!c && typeof c.at === "number" && c.at >= at;
    };
    if (!ctx || s.backend.sources?.inBand || !Number.isFinite(at) || fresh()) { settle(); return; }
    let unwatch: (() => void) | null = null;
    const finish = (run: boolean) => {
      if (ch.pendingEnd !== held) return;
      ch.pendingEnd = null;
      clearInterval(poll); clearTimeout(bound);
      try { unwatch?.(); } catch { /* a source's own teardown */ }
      if (run && !ch.closed && s.channel === ch) settle();
    };
    const held = { flush: () => finish(true), cancel: () => finish(false) };
    ch.pendingEnd = held;
    const poll = setInterval(() => { if (fresh()) finish(true); }, this.contextPollMs);
    const bound = setTimeout(() => finish(true), this.contextWaitMs);
    poll.unref?.(); bound.unref?.();
    if (ctx.watch) {
      try {
        unwatch = ctx.watch(ss, (c) => { if ((c && typeof c.at === "number" && c.at >= at) || fresh()) finish(true); });
      } catch { unwatch = null; /* polled instead */ }
      if (ch.pendingEnd !== held) { try { unwatch?.(); } catch { /* same */ } }
    }
  }

  /** Apply a health report: publish it, and switch the rungs on the EDGES. */
  private onHealth(s: Session, ch: SessionChannel, raw: ChannelHealth): void {
    if (ch.closed || s.channel !== ch || !raw || ch.screenOnly) return;
    const h: ChannelHealth = {
      state: raw.state === "up" ? "up" : "down",
      since: Number.isFinite(raw.since) ? raw.since : Date.now(),
      ...(typeof raw.note === "string" && raw.note ? { note: raw.note.slice(0, 300) } : {}),
    };
    const sources = s.backend.sources;
    // An in-band channel's health is never published (`BackendSources.inBand`):
    // `hooked` says it, as it always did for claude's hook pipe.
    const inBand = !!sources?.inBand;
    const changed = !inBand && !sameHealth(s.info.sideChannel, h);
    if (!inBand) s.info.sideChannel = h;
    // In-band subscriptions are live before the handle exists (`attach`).
    if (h.state === "up" && (ch.handle || inBand)) {
      ch.everUp = true;
      if (sources?.turns && !ch.turnsLive) {
        ch.turnsLive = true;
        if (!s.hooksActive || !s.info.hooked) {
          s.hooksActive = true; s.info.hooked = true;
          // A hook means the CLI reached its prompt: its first-launch setup is over.
          delete s.info.cliSetup;
          // The hook pipe going LIVE is one fact about a session, not one per
          // turn it ran: broadcast, and one `hook.pipe` good (claude's health
          // board; `noteFor` files nothing outside `healthScope`).
          if (inBand) { this.core.emit("updated", s.info); this.core.noteFor(s, "hook.pipe", "good", { fixture: () => (s.lastHook ? JSON.stringify(s.lastHook) : null) }); }
        }
      }
      // Until a reconcile has answered with a list, the screen reader keeps
      // the dialogs; every `up` report until then asks again, never two at once.
      if (sources?.dialogs && !ch.dialogsLive && !ch.reconciling) this.reconcile(s, ch);
      if (sources?.questions && !ch.questionsLive) this.reconcileQuestions(s, ch);
      // The mode may be readable from here on: read it now, not at the next quiet tick.
      if (sources?.mode && derive(s.backend).askSource("mode")) this.core.checkMode(s);
    } else if (h.state === "down") {
      this.handBack(s, ch);
    }
    if (changed) this.core.emit("updated", s.info);
  }

  /** The channel went down: every rung it held goes back to the screen. */
  private handBack(s: Session, ch: SessionChannel): void {
    if (ch.turnsLive) {
      ch.turnsLive = false;
      s.hooksActive = false; s.info.hooked = false;
    }
    const owned = ch.dialogsLive || !!ch.published;
    ch.dialogsLive = false; ch.questionsLive = false;
    ch.dialogs.clear(); ch.questions.clear(); ch.plans.clear(); ch.posedAt.clear();
    if (ch.published) {
      ch.published = null;
      this.core.applyPrompt(s, null);
    }
    // The screen reader is back on duty NOW, not at the next burst of output:
    // a dialog still open on the TUI is the one thing a person must not lose
    // sight of while the channel is out.
    if (owned && s.info.running && derive(s.backend).screen("dialogs") !== null) this.core.armPromptCheck(s, 0);
  }

  /** On the `up` edge: what is pending NOW. `null` = cannot say ⇒ the screen
   *  reader stays on; a list ⇒ the channel owns the dialogs from here. */
  private reconcile(s: Session, ch: SessionChannel): void {
    const dialogs = s.backend.sources?.dialogs;
    if (!dialogs) return;
    const before = new Set(ch.dialogs.keys());
    let pending: Promise<SourceDialog[] | null>;
    try { pending = dialogs.pending(this.sourceSession(s)); } catch { return; }
    ch.reconciling = true;
    pending.finally(() => { ch.reconciling = false; }).then((list) => {
      if (ch.closed || s.channel !== ch || s.info.sideChannel?.state !== "up" || !Array.isArray(list)) return;
      const next = new Map<string, SourceDialog>();
      for (const d of list) if (d && typeof d.id === "string") next.set(d.id, d);
      // A dialog `asked` while the reconcile was in flight is newer than the
      // list, and is kept; one that was there before and is not in the list
      // was resolved during the gap.
      for (const [id, d] of ch.dialogs) if (!before.has(id) && !next.has(id)) next.set(id, d);
      for (const id of ch.dialogs.keys()) if (!next.has(id)) ch.posedAt.delete(id);
      ch.dialogs = next;
      for (const id of next.keys()) this.posed(ch, id);
      ch.dialogsLive = true;
      this.publish(s, ch);
    }, () => { /* cannot say ⇒ the screen reader stays on */ });
  }

  private asked(s: Session, ch: SessionChannel, d: SourceDialog): void {
    if (!dialogToPrompt(d)) return; // states too little to be a box; the screen may still read it
    ch.dialogs.set(d.id, d);
    this.posed(ch, d.id);
    this.publish(s, ch);
  }

  /** Stamp when an id was first posed — "oldest first" across dialogs AND questions. */
  private posed(ch: SessionChannel, id: string): void {
    if (!ch.posedAt.has(id)) ch.posedAt.set(id, ++ch.posedSeq);
  }

  /** On the `up` edge: the questions open NOW, where the source can say (`pending`); one
   *  `asked` during the gap is newer than the list and kept. No `pending` ⇒ live at once. */
  private reconcileQuestions(s: Session, ch: SessionChannel): void {
    const questions = s.backend.sources?.questions;
    if (!questions) return;
    ch.questionsLive = true;
    if (!questions.pending) return;
    const before = new Set(ch.questions.keys());
    let pending: Promise<SourceQuestion[] | null>;
    try { pending = questions.pending(this.sourceSession(s)); } catch { return; }
    pending.then((list) => {
      if (ch.closed || s.channel !== ch || !ch.questionsLive || !Array.isArray(list)) return;
      const next = new Map<string, SourceQuestion>();
      for (const q of list) if (q && typeof q.id === "string" && questionToPrompt(q)) next.set(q.id, q);
      for (const [id, q] of ch.questions) if (!before.has(id) && !next.has(id)) next.set(id, q);
      for (const id of ch.questions.keys()) if (!next.has(id)) ch.posedAt.delete(id);
      ch.questions = next;
      for (const id of next.keys()) this.posed(ch, id);
      this.publish(s, ch);
    }, () => { /* cannot say ⇒ what `asked` reported stands */ });
  }

  private askedQuestion(s: Session, ch: SessionChannel, q: SourceQuestion): void {
    if (!questionToPrompt(q)) return; // nothing a phone could answer with
    ch.questions.set(q.id, q);
    this.posed(ch, q.id);
    this.publish(s, ch);
  }

  private closedQuestion(s: Session, ch: SessionChannel, id: string): void {
    ch.posedAt.delete(id);
    if (!ch.questions.delete(id) && ch.published !== id) return;
    this.publish(s, ch);
  }

  /** A plan posed (or re-posed under the same id: new text, the SAME answer latch — a re-pose
   *  mid-answer must not let a second tap call a verb again). */
  private posedPlan(s: Session, ch: SessionChannel, p: SourcePlan): void {
    if (!planToPrompt(p, s.backend.label)) return; // nothing a phone could answer
    const had = ch.plans.get(p.id);
    // Mutate in place: an in-flight answer holds THIS entry and releases its latch on it.
    if (had) had.plan = p; else ch.plans.set(p.id, { plan: p, answering: false });
    this.posed(ch, p.id);
    this.publish(s, ch);
  }

  private closedPlan(s: Session, ch: SessionChannel, id: string): void {
    ch.posedAt.delete(id);
    if (!ch.plans.delete(id) && ch.published !== id) return;
    this.publish(s, ch);
  }

  /** The count of dialogs the source can see but not pose changed. Above 0 the screen reader
   *  is back on duty (`boxes.ts`'s `screenReaderOff`) and looks NOW; back at 0 a box it read
   *  is retired the way any box is once the channel owns the dialogs. */
  private unposed(s: Session, ch: SessionChannel, raw: number): void {
    const n = Number.isInteger(raw) && raw > 0 ? raw : 0;
    if (n === ch.unposed) return;
    const was = ch.unposed;
    ch.unposed = n;
    // No screen reader to hand it to (Copilot's `ask_user` form): the session is still blocked
    // on you, so the fact the source CAN give — one is open — is what the status says.
    if (derive(s.backend).screen("dialogs") === null) this.core.setAwaiting(s, n > 0 && s.info.running);
    if (n > 0 && was === 0) {
      if (s.info.running && derive(s.backend).screen("dialogs") !== null) this.core.armPromptCheck(s, 0);
    } else if (n === 0) {
      this.publish(s, ch);
    }
  }

  private resolved(s: Session, ch: SessionChannel, id: string): void {
    ch.posedAt.delete(id);
    if (!ch.dialogs.delete(id) && ch.published !== id) return;
    this.publish(s, ch);
  }

  /** Publish the OLDEST open dialog, question or plan (the one the TUI is showing), or retire
   *  what the channel published when none is open. */
  private publish(s: Session, ch: SessionChannel): void {
    let first: DetectedPrompt | null = null;
    let at = Infinity;
    const age = (id: string) => ch.posedAt.get(id) ?? Infinity;
    const askRules = sessionAskRules(s.info.id, s.info);
    for (const d of ch.dialogs.values()) {
      if (age(d.id) >= at && first) continue;
      const p = dialogToPrompt(d, { keepsRules: !!s.backend.plugin, askRules });
      if (p) { first = p; at = age(d.id); }
    }
    for (const q of ch.questions.values()) {
      if (age(q.id) >= at && first) continue;
      const p = questionToPrompt(q);
      if (p) { first = p; at = age(q.id); }
    }
    for (const { plan } of ch.plans.values()) {
      if (age(plan.id) >= at && first) continue;
      const p = planToPrompt(plan, s.backend.label);
      if (p) { first = p; at = age(plan.id); }
    }
    // The box is the same box (`samePrompt`): keep the host's note on the last answer to it.
    const note = s.info.prompt?.answerNote;
    if (first && note && s.info.prompt?.askId === first.askId) first = { ...first, answerNote: note };
    if (first) {
      ch.published = first.askId ?? null;
      this.core.applyPrompt(s, first);
      return;
    }
    // Nothing open. Retire the channel's own box — and, once the channel owns
    // the dialogs, a screen box published before it did: the reader that could
    // retire it is off.
    // While the channel reports a dialog it cannot pose, a screen box is that dialog's, and
    // only the screen reader may retire it.
    const retire = !!ch.published || (ch.dialogsLive && !ch.unposed && !!s.info.prompt);
    ch.published = null;
    if (retire) this.core.applyPrompt(s, null);
    if (retire && ch.unposed && s.info.running && derive(s.backend).screen("dialogs") !== null) this.core.armPromptCheck(s, 0);
  }
}
