// Client → host: updates, usage, plugins, decision log, sent log, settings, auth, limits, notifications, budgets, health. A member list of `ClientMessage` (`../messages.ts`).

import type { UsageBudget } from "../../budget.js";
import type { InstallReportEntry, InstallReporter } from "../install.js";
import type { NotifyPrefs } from "../notify.js";
import type { StallReport } from "../../netstall.js";
import type { PluginValue } from "../../plugin.js";
import type { LimitResumeMode } from "../session.js";
import type { ClientUpdatesMsg } from "./clientupdates.js";

export type ClientHostMsg =
  | ClientUpdatesMsg
  | { t: "update.status" }
  | { t: "update.check" }
  | { t: "update.apply" }
  | { t: "usage.get" }
  | { t: "usage.refresh" }
  // ── Plugins (`plugin.ts`; docs/notes/plugins.md) ──
  /** Ask for every installed plugin; answered with `plugin.list`. */
  | { t: "plugin.list" }
  /** Change a plugin's settings (only declared keys; a refused value is named in `plugin.error`). */
  | { t: "plugin.set"; id: string; values: Record<string, PluginValue> }
  /** Turn a plugin on or off without removing it. */
  | { t: "plugin.enable"; id: string; enabled: boolean }
  /** Tap a declared action; `sessionId` for a session-scoped one. Answered with `plugin.actionResult`. */
  | { t: "plugin.action"; id: string; action: string; sessionId?: string; reqId: string }
  /** Flip a plugin's per-session toggle; `value: null` goes back to the manifest default. */
  | { t: "plugin.sessionToggle"; id: string; sessionId: string; toggle: string; value: boolean | null }
  /** The core-owned "let <plugin> answer" switch for one session. */
  | { t: "plugin.sessionAnswer"; id: string; sessionId: string; value: boolean }
  /** Ask a plugin's `handle()`d method. NOT durable, never queued offline, not in the ack ledger:
   *  `ackId` addresses the reply and de-duplicates a repeated frame (host `plugins/pluginrpc.ts`). */
  | { t: "plugin.call"; plugin: string; method: string; args?: unknown; ackId: string }
  // ── Live streams (plugin API 1.4, shared/stream.ts) ── NOT durable, never queued offline,
  //    never retried: a late open is for a screen nobody watches, a late input lands elsewhere.
  /** Open `plugin`'s stream `name` for THIS socket. Answered by `stream.opened` or
   *  `stream.refused`, matched on `reqId` (client-minted). */
  | { t: "stream.open"; reqId: string; plugin: string; name: string; params?: unknown }
  /** Re-steer an open stream (quality, crop, source). Replaces the params; the plugin decides
   *  what changes. */
  | { t: "stream.params"; streamId: number; params: unknown }
  /** One upstream event (a pointer move, a key). Fire-and-forget, at most once. */
  | { t: "stream.input"; streamId: number; ev: unknown }
  /** What the client has received so far on this stream: the newest `seq` and the payload bytes
   *  it counted. This is the Auto controller's measure of what is in flight. */
  | { t: "stream.ack"; streamId: number; seq: number; rxBytes: number }
  /** Ask the producer for a keyframe now (a decoder error, a reopened view). */
  | { t: "stream.keyframe"; streamId: number }
  | { t: "stream.close"; streamId: number }
  // ── The decision log: limit auto-continues + plugin decisions ──
  | { t: "decisions.get"; sessionId?: string }
  | { t: "decisions.archive"; id: string; archived: boolean }
  | { t: "decisions.delete"; id: string }
  | { t: "decisions.archiveAll" }
  // ── Sent-command audit log ──
  /** Ask for the sent-command log; `sessionId` filters to one session. */
  | { t: "sent.get"; sessionId?: string }
  /** Wipe the log (it is a local audit trail, not accounting). */
  | { t: "sent.clear" }
  // ── User settings that follow the user, not the browser (settings.ts) ──
  /** Ask for the whole synced document (also sent unprompted on hello). */
  | { t: "settings.get" }
  /**
   * Store one setting. `value` is the client's RAW localStorage string and the
   * host never parses it; `ts` is stamped by the writer and decides last-write-
   * wins, so a client whose clock is behind loses rather than corrupts.
   */
  | { t: "settings.set"; key: string; value: string; ts: number; device?: string }
  // ── The install log (installlog.ts) ──
  /**
   * Ask for the whole install log. Also sent unprompted on `hello`, because the
   * question it answers — *which version of what is on which phone* — is the
   * one thing a single device cannot work out for itself.
   */
  | { t: "install.get" }
  /**
   * "Here is every install this phone still has a record of."
   *
   * A RE-STATEMENT, not an event: the install worth reporting is usually the
   * one that happened at 3 a.m. with the tunnel down, so a phone re-sends its
   * whole history on every connect and the host merges on each entry's key.
   * Not durable and never queued offline for that exact reason — an ackId would
   * protect a delivery that is already idempotent, and a queued copy would only
   * repeat what the next `hello` says anyway.
   */
  | { t: "install.report"; device: InstallReporter; entries: InstallReportEntry[] }
  /**
   * The phone's HTTP stalls (`shared/netstall.ts`): the evidence for WHY a
   * request hung while this socket stayed healthy. Over the socket, never a
   * POST, because the thing being measured is the HTTP pool being stuck. A
   * RE-STATEMENT like `install.report` — the whole ring each time, merged on
   * each event's key — so not durable and never queued. Additive: an older
   * host ignores the unknown `t`.
   */
  | { t: "net.stalls"; deviceId: string; report: StallReport }
  /** LAN password gate (managed only from the trusted loopback/Tailscale path). */
  | { t: "auth.set"; password: string }
  | { t: "auth.clear" }
  | { t: "auth.gateTailscale"; enabled: boolean }
  /** Re-fetch the current auth state for this socket. */
  | { t: "auth.get" }
  /** Global switch: automatically send "continue" once a hit usage limit resets. */
  | { t: "limit.setAuto"; enabled: boolean }
  /** Per-session auto-continue override; null clears it (inherit the global switch). */
  | { t: "limit.session"; id: string; override: boolean | null }
  /** Push a session to the front of the resume queue (`on: false` clears it).
   *  Several "first" sessions keep the order they were marked in. */
  | { t: "limit.first"; id: string; on: boolean }
  /** Resume NOW, without waiting for the scheduled reset time: one session when
   *  `id` is given, otherwise every queued one. Still paced by the queue —
   *  "now" means "stop waiting for the clock", not "ignore the release mode". */
  | { t: "limit.resume"; id?: string }
  /** How the resume queue releases sessions once the limit lifts (host-wide). */
  | { t: "limit.setMode"; mode: LimitResumeMode }
  /** The emergency halt: `on` stops every AI process this host started and
   *  latches until a later `on: false` (`shared/halt.ts`). Idempotent — a
   *  repeat of the same value is a no-op, so no ackId is needed. */
  | { t: "host.halt"; on: boolean }
  /** Fetch the in-app notification feed. */
  | { t: "notification.get" }
  /** Clear all in-app notifications. */
  | { t: "notification.clear" }
  /** Mark ONE attention item handled (the row's done). Idempotent — a repeat
   *  or a replay finds it already handled — so no ackId. The host answers
   *  every client with `notification.list`. */
  | { t: "notification.handle"; id: string }
  /**
   * Mute or unmute notification KINDS, host-wide.
   *
   * Host-side and not a synced `waterplane.*` setting because the host is the one
   * that must act on it: a muted kind has to be dropped BEFORE the OS push is
   * sent, and `settings.ts` stores opaque strings the daemon deliberately never
   * parses. Sparse — only the kinds this write changes are sent, the rest keep
   * whatever the host holds.
   */
  | { t: "notify.prefs.set"; prefs: NotifyPrefs; /** Push information too (absent = unchanged). */ pushInfo?: boolean }
  /**
   * The usage BUDGET — "stop starting automatic work past this much of the
   * window, and start again when it resets" (`shared/budget.ts`).
   *
   * Additive and NOT in the durable-op set, like `settings.*` and `pull.*`:
   * setting a ceiling is idempotent state, so a replay writes the same number
   * and there is nothing an ackId would protect. The host answers both with
   * `budget.state`.
   */
  | { t: "budget.get" }
  | { t: "budget.set"; budget: UsageBudget }
  /**
   * The billing profile (`shared/billing.ts`): `billing.get` asks, `billing.set`
   * overrides it (`profile: null` clears the override back to the probe). Both
   * are answered with `billing.status`. Additive, NOT durable - idempotent state
   * like `budget.set`; an older host ignores both.
   */
  | { t: "billing.get" }
  | { t: "billing.set"; profile: "subscription" | "api" | "cloud" | null }
  /**
   * The CLI integration's own health (`shared/clihealth.ts`) — answered with
   * `clihealth`.
   *
   * Additive and NOT in the durable-op set, the `budget.*`/`pull.*` class: it is
   * a read, and asking twice costs a verdict recomputed over ten small records
   * and nothing else, so there is nothing an ackId would protect.
   */
  | { t: "clihealth.get" }
  /**
   * A person read the board's warnings and clears them: per signal, every miss
   * at or before the instant given — the newest miss THAT board showed
   * (`clearSeen`). Answered with `clihealth`.
   *
   * Additive and NOT durable: bounded by what the reader saw, so a late or
   * repeated delivery removes nothing they did not read — there is nothing an
   * ackId would protect. Never queued offline either; the button refuses in
   * words instead.
   */
  | { t: "clihealth.clear"; through: Record<string, number> }
  /**
   * Watch the local model runner — a LEASE, not a subscription.
   *
   * The route table has no socket-close hook, so watch state must not be able
   * to outlive its socket. A lease expires on its own; a client that stops
   * renewing simply lapses, costing at most one lease period of extra loopback
   * GETs, which is the cheap direction to be wrong in. The alternative — a set
   * the host prunes on close — is a leak the day a close event is missed.
   *
   * Not durable and carries no ackId: it is a READ. Answered immediately with
   * one `localrt.sample`, so a client can tell a host that ANSWERED from an
   * older one that ignored an unknown `t`.
   */
  | { t: "localrt.watch" }
  /**
   * "Check again": re-ask the backends that said unavailable (Ollama not
   * reachable). Not durable, no ackId — a read. The answer is a fresh `backends`
   * frame, sent to everyone only when something changed.
   */
  | { t: "backends.recheck" }
  /**
   * Unload one resident model now, instead of waiting for the runner's own
   * `keep_alive` schedule.
   *
   * Deliberately NOT durable and never queued offline, `capture.cancel`'s
   * reason exactly: this is a decision that only means something RIGHT NOW —
   * an eject queued behind a dead tunnel and delivered an hour later unloads
   * whatever is resident THEN, for a reason that may no longer apply, possibly
   * mid-turn for a session that started after the tap. No `ackId`, no
   * at-most-once story needed: a repeated eject of an already-gone model is
   * the runner answering "not found", not a second copy of a real effect.
   * The result rides back as `localrt.evict`, not `op.ack`.
   */
  | { t: "localrt.evict"; name: string }
  | { t: "meter.get" };
