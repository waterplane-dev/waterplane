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
import type { ChannelHealth, DetectedPrompt, SourceDialog, SourceHandle, SourceSession, TurnFacts } from "@waterplane/shared";
import { MAX_BOX_OPTIONS } from "../prompt.js";
import { ruleLabel } from "../answergate.js";
import { setLiveSourceLookup } from "../livesources.js";
import { BACKENDS } from "../backends/index.js";
import type { Session, SessionChannel, SessionCore } from "./core.js";
import { SEAT_SWEEP_MS } from "./knobs.js";

/** The wire shape of a dialog the CLI posed — or null when it states too little
 *  to be a box anybody could answer from a phone. */
export function dialogToPrompt(d: SourceDialog, opts: { keepsRules?: boolean } = {}): DetectedPrompt | null {
  if (!d || typeof d.id !== "string" || !d.id || typeof d.question !== "string") return null;
  const options = (Array.isArray(d.options) ? d.options : [])
    .filter((o) => o && Number.isInteger(o.index) && typeof o.label === "string" && o.label.trim())
    .slice(0, MAX_BOX_OPTIONS)
    .map((o) => {
      // A tap on this option makes a standing rule (`answergate.ts`): say so ON the option, in
      // the label the HOST will keep — never the plugin's `key`, and only where a rule can be
      // made at all (`keepsRules`: the backend has an owning plugin to key it by).
      const kept = opts.keepsRules ? ruleLabel(o.remember) : null;
      return {
        index: o.index, label: o.label,
        ...(typeof o.desc === "string" && o.desc ? { desc: o.desc } : {}),
        ...(kept !== null ? { remembers: { label: kept.slice(0, 300) } } : {}),
      };
    });
  if (!options.length) return null;
  return { kind: d.kind, question: d.question, options, nav: true, askId: d.id };
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
      suspendOnClose: false, everUp: false, screenOnly: null, unposed: 0,
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
    for (const u of ch.unwatch) { try { u(); } catch { /* a source's own teardown */ } }
    ch.unwatch = [];
    ch.dialogs.clear();
    ch.published = null;
    ch.turnsLive = false; ch.dialogsLive = false;
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
    const { turns, dialogs } = s.backend.sources ?? {};
    const live = () => !ch.closed && s.channel === ch;
    if (turns) {
      const edge = (e: "started" | "ended" | "ready", f?: TurnFacts) => { if (live()) this.core.sourceTurn(s, e, f); };
      try {
        ch.unwatch.push(turns.watch(ss, {
          started: (_at, f) => edge("started", f), ended: (_at, f) => edge("ended", f), ready: (f) => edge("ready", f),
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
    ch.dialogsLive = false;
    ch.dialogs.clear();
    if (ch.published) {
      ch.published = null;
      this.core.applyPrompt(s, null);
    }
    // The screen reader is back on duty NOW, not at the next burst of output:
    // a dialog still open on the TUI is the one thing a person must not lose
    // sight of while the channel is out.
    if (owned && s.info.running && s.backend.caps.promptBoxes) this.core.armPromptCheck(s, 0);
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
      ch.dialogs = next;
      ch.dialogsLive = true;
      this.publish(s, ch);
    }, () => { /* cannot say ⇒ the screen reader stays on */ });
  }

  private asked(s: Session, ch: SessionChannel, d: SourceDialog): void {
    if (!dialogToPrompt(d)) return; // states too little to be a box; the screen may still read it
    ch.dialogs.set(d.id, d);
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
    if (!s.backend.caps.promptBoxes) this.core.setAwaiting(s, n > 0 && s.info.running);
    if (n > 0 && was === 0) {
      if (s.info.running && s.backend.caps.promptBoxes) this.core.armPromptCheck(s, 0);
    } else if (n === 0) {
      this.publish(s, ch);
    }
  }

  private resolved(s: Session, ch: SessionChannel, id: string): void {
    if (!ch.dialogs.delete(id) && ch.published !== id) return;
    this.publish(s, ch);
  }

  /** Publish the OLDEST open dialog (the one the TUI is showing), or retire
   *  what the channel published when none is open. */
  private publish(s: Session, ch: SessionChannel): void {
    let first: DetectedPrompt | null = null;
    for (const d of ch.dialogs.values()) { first = dialogToPrompt(d, { keepsRules: !!s.backend.plugin }); if (first) break; }
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
    if (retire && ch.unposed && s.info.running && s.backend.caps.promptBoxes) this.core.armPromptCheck(s, 0);
  }
}
