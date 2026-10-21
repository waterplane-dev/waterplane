/**
 * Routes about the host itself rather than any one session: the handshake, the
 * LAN gate, settings, plugins and the decision log, telemetry and the
 * notification feed.
 */
import { PLUGIN_ACK_RE, PROTOCOL_VERSION, haltReceiptWords, logTag, roleAfterHello } from "@waterplane/shared";
import { haltState, isHalted, setHalted, stopRuns } from "../halt.js";
import type { HostMessage, PeerKind, PluginCaller } from "@waterplane/shared";
import type { WebSocket } from "ws";
import { cliHealth } from "../clihealth.js";
import { backendInfos, recheckUnavailableBackends } from "../backends/index.js";
import { evictLocalModel, localRtWatch } from "../localrt.js";
import type { HostCtx, Route, RouteTable } from "./types.js";

/**
 * The CLI-health frame.
 *
 * Built here rather than in `main.ts` because the store is a module-level
 * singleton (see `clihealth.ts` for why: ten observation points, and a threaded
 * handle is one the eleventh call site forgets), so this route needs nothing
 * from `HostCtx` and a test can exercise it without one.
 */
function cliHealthFrame(): HostMessage | null {
  const store = cliHealth();
  if (!store) return null;   // no store installed (a unit host) → nothing to say
  return { t: "clihealth", health: store.get(), rollup: store.rollup(), source: store.source() };
}

/**
 * "What does this host's CLI integration currently know about itself?"
 *
 * Not durable and no `contain`: it is a read, in the `budget.*`/`pull.*` class —
 * asking twice costs a verdict recomputation over ten small records and nothing
 * else, so there is nothing an ackId would protect.
 *
 * Registered in the table by the handover hunk, alongside the wire message it
 * answers with.
 */
export const onCliHealthGet = (a: { c: HostCtx; ws: WebSocket }): void => {
  const frame = cliHealthFrame();
  if (frame) a.c.send(a.ws, frame);
};

/**
 * "I read those warnings — clear them." Answered with the board straight back
 * to the asker, so the rows change under the tap rather than after the ~5 s
 * broadcast debounce; every other device gets that broadcast.
 *
 * Not durable, no `contain`: `through` bounds the clear by what the reader was
 * shown, so a repeat or a late delivery removes nothing they had not read.
 */
const onCliHealthClear: Route<"clihealth.clear"> = (a) => {
  const store = cliHealth();
  if (!store) return;
  store.clear(a.msg.through);
  const frame = cliHealthFrame();
  if (frame) a.c.send(a.ws, frame);
};

/**
 * "Tell me what the local model runner is holding, and keep telling me."
 *
 * Not durable and no `contain`, for `clihealth.get`'s reasons exactly: it is a
 * READ. Nothing is spawned, nothing is written, no directory is named — asking
 * twice costs one loopback GET against `127.0.0.1`, so there is nothing an
 * ackId would protect and nothing a containment gate would be guarding.
 *
 * The lease and the poll live in `localrt.ts` as a module-level singleton, the
 * `clihealth.ts` arrangement and for its argument: this needs nothing from
 * `HostCtx`, so threading a manager through the context would add a field that
 * exists only to be passed. The handler hands over a closure rather than the
 * socket's `send`, so the manager never learns what a transport is.
 */
const onLocalRtWatch: Route<"localrt.watch"> = (a) => {
  localRtWatch(a.ws, (msg) => a.c.send(a.ws, msg));
};

/**
 * "Check again" on an unavailable backend. A READ, like its neighbours: one
 * loopback probe per unavailable backend, floored at 2 s so a held button cannot
 * become a probe loop. Only a CHANGED answer is broadcast; the asker is told
 * either way, so the sheet can say it looked.
 */
const onBackendsRecheck: Route<"backends.recheck"> = (a) => {
  void recheckUnavailableBackends(2_000).then((changed) => {
    if (changed) a.c.broadcast({ t: "backends", list: backendInfos() });
    else a.c.send(a.ws, { t: "backends", list: backendInfos() });
  });
};

/**
 * "Unload this model now."
 *
 * Not durable and no `contain`, `localrt.watch`'s neighbour but for the
 * opposite reason: this is a WRITE, but a re-sent eject of an already-gone
 * model costs the runner one more "not found" and produces the same end
 * state, so there is no double-effect for at-most-once to prevent — see the
 * message's own doc comment for why it must not be queued or retried instead.
 * Answers on the SAME socket only; a phone that closed the sheet mid-flight
 * simply does not hear the result, same as any other live-only read.
 */
const onLocalRtEvict: Route<"localrt.evict"> = (a) => {
  void evictLocalModel(a.msg.name).then((r) => {
    a.c.send(a.ws, { t: "localrt.evict", name: a.msg.name, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
  });
};

const onPing: Route<"ping"> = (a) => {
    a.c.send(a.ws, { t: "pong" }); // heartbeat — lets the client detect a dead socket
};

const onHello: Route<"hello"> = (a) => {
    // The client announces its protocol version; until now this arm dropped
    // it. A mismatch cannot be repaired from either side, but it explains the
    // failure mode it causes — a message type one end does not know, silently
    // ignored — so log it once per connection rather than leaving the daemon's
    // operator to find it by reading the wire.
    if (a.msg.protocol !== PROTOCOL_VERSION) {
      console.warn(`${logTag} client speaks protocol ${a.msg.protocol}, this host speaks ${PROTOCOL_VERSION} — rebuild the web bundle (\`npm run build\`) if things behave oddly.`);
    }
    // The APK's background link gets no snapshots: it acts on live
    // notification / authRequired / pull.new frames only and replays nothing
    // (`shared/wire/notifylink.ts`). `send` would drop them all anyway; this
    // skips building twenty frames per reconnect for nobody.
    const role = roleAfterHello(a.msg.role, a.c.wsRole.get(a.ws));
    if (role) { a.c.wsRole.set(a.ws, role); return; }
    a.c.send(a.ws, { t: "session.list", sessions: a.c.sessions.list() });
    a.c.send(a.ws, { t: "recent.list", recent: a.c.sessions.listRecent() });
    a.c.send(a.ws, { t: "closed.list", closed: a.c.sessions.listClosed() });
    a.c.send(a.ws, a.c.backlogSnapshot());
    a.c.send(a.ws, { t: "update.status", info: a.c.updates.get() });
    a.c.send(a.ws, { t: "plugin.list", plugins: a.c.plugins.views() });
    a.c.send(a.ws, { t: "decisions.log", entries: a.c.decisionLog.list().slice(0, 100) });
    a.c.send(a.ws, { t: "usage.status", usage: a.c.usage.get(), readings: a.c.usageSources.readings() });
    a.c.send(a.ws, { t: "meter.status", summary: a.c.meter.summary() });
    a.c.send(a.ws, { t: "notification.list", items: a.c.notifications });
    a.c.send(a.ws, { t: "notify.prefs", prefs: a.c.notifyPrefs.get() });
    a.c.send(a.ws, budgetState(a.c));
    a.c.send(a.ws, { t: "billing.status", ...a.c.billing.status() }); // unknown too: it resets a face a phone kept from another host or an earlier answer
    a.c.send(a.ws, { t: "halt.state", halt: haltState() });
    a.c.send(a.ws, { t: "limit.config", enabled: a.c.sessions.getAutoContinue(), ...a.c.sessions.resumeState() });
    a.c.send(a.ws, { t: "fanout.list", runs: a.c.fanout.list() });
    a.c.send(a.ws, { t: "pull.list", items: a.c.autopull.list() });
    a.c.send(a.ws, a.c.scheduleSnapshot());
    // The launches this host is holding. A phone that has been off all night
    // learns on hello whether the session it asked for ever opened — the
    // whole point of the create having been handed over in the first place.
    a.c.send(a.ws, a.c.launchSnapshot());
    // The Intent store is the one the other two are now views OF, so a client
    // that speaks it needs no second round trip to learn what is waiting.
    a.c.send(a.ws, a.c.intentSnapshot());
    // Deliveries the host could not confirm, open and resolved. A phone that
    // was asleep through a resolution has no other way to learn it: the push
    // went out while nothing was listening, and the row it is still showing is
    // one it must not act on from its own stale copy.
    a.c.send(a.ws, a.c.deliverySnapshot());
    // Unprompted: a client that has just connected needs the user's prompt
    // templates before it renders anything that shows them, and asking for
    // them costs a round trip on the link this app spends its life
    // apologising for.
    a.c.send(a.ws, { t: "settings.all", doc: a.c.settings.all() });
    // What has installed itself, on every phone this desktop has heard from.
    // Unprompted for the reason the log exists at all: this device cannot see
    // the other one, and the answer is already sitting in memory here.
    a.c.send(a.ws, { t: "install.log", doc: a.c.installLog.doc() });
    // The CLI's own health, unprompted. It rides on hello for the same reason
    // the budget does: the phone renders the launcher's mark from the ROLLUP,
    // and a mark that only appears once somebody opens a sheet is the readout
    // nobody reads. It is also the sheet's offline cache, so a client that has
    // connected once can still paint the board with the tunnel down.
    const health = cliHealthFrame();
    if (health) a.c.send(a.ws, health);
};

const onUpdateStatus: Route<"update.status"> = (a) => {
    a.c.send(a.ws, { t: "update.status", info: a.c.updates.get() });
};

const onUpdateCheck: Route<"update.check"> = (a) => {
    void a.c.updates.check(true);
};

const onUpdateApply: Route<"update.apply"> = (a) => {
    void a.c.updates.apply();
};

const onUsageGet: Route<"usage.get"> = (a) => {
    a.c.send(a.ws, { t: "usage.status", usage: a.c.usage.get(), readings: a.c.usageSources.readings() });
};

/**
 * "Tell me the usage figure" — and the HOST decides whether that costs a scrape.
 *
 * `getFresh()` rather than `refresh()`: a reading younger than `WATERPLANE_USAGE_TTL_MS`
 * is served from cache and nothing is spawned. The staleness rule was on the
 * PHONE, twice (two effects, each carrying its own copy of the 8-minute
 * constant and one of them a throttling ref), which made the client's clock the
 * authority on when this desktop should spend a PTY — and left the constant in
 * three places to drift. Asking is now free and idempotent, so the client can
 * simply ask when a screen that shows the figure comes up.
 */
const onUsageRefresh: Route<"usage.refresh"> = (a) => {
    void a.c.usage.getFresh();
    void a.c.usageSources.refreshFresh(); // every other source, behind the same TTL (`usagesources.ts`)
};

const onAuthSet: Route<"auth.set" | "auth.clear" | "auth.gateTailscale"> = (a) => {
    // Password management is trusted-path only. A LAN socket (even an authed
    // one) can never set/change/clear it — refuse and re-state the truth.
    const kind = a.c.wsKind.get(a.ws);
    if (!kind || !a.c.auth.canManage(kind)) {
      a.c.send(a.ws, { t: "error", message: "not allowed from this connection", context: "auth" });
      return;
    }
    try {
      if (a.msg.t === "auth.set") a.c.auth.setPassword(a.msg.password);
      else if (a.msg.t === "auth.clear") a.c.auth.clearPassword();
      else a.c.auth.setGateTailscale(a.msg.enabled);
    } catch (e) {
      a.c.send(a.ws, { t: "error", message: String((e as Error).message || e), context: "auth" });
      return;
    }
    a.c.enforceAuth();        // kick sockets whose tokens the change invalidated
    a.c.broadcastAuthState(); // refresh the survivors' Settings UI
};

const onAuthGet: Route<"auth.get"> = (a) => {
    const kind = a.c.wsKind.get(a.ws) ?? "unknown";
    a.c.send(a.ws, { t: "auth.state", auth: a.c.authStateFor(kind) });
};

// ── Plugins (docs/notes/plugins.md) ── every refusal is `plugin.error`, in words.
const pluginRefused = (a: { c: HostCtx; ws: WebSocket }, id: string, error: string | null): void => {
    if (error) a.c.send(a.ws, { t: "plugin.error", id, error });
};

const onPluginList: Route<"plugin.list"> = (a) => {
    a.c.send(a.ws, { t: "plugin.list", plugins: a.c.plugins.views() });
};

const onPluginSet: Route<"plugin.set"> = (a) => {
    pluginRefused(a, a.msg.id, a.c.plugins.setValues(a.msg.id, a.msg.values));
};

const onPluginEnable: Route<"plugin.enable"> = (a) => {
    void a.c.plugins.setEnabled(a.msg.id, !!a.msg.enabled).then((err) => {
      pluginRefused(a, a.msg.id, err);
      a.c.syncUsagePolling();
    });
};

const onPluginAction: Route<"plugin.action"> = (a) => {
    const { id, action, sessionId, reqId } = a.msg;
    void a.c.plugins.action(id, action, sessionId).then((r) =>
      a.c.send(a.ws, { t: "plugin.actionResult", id, action, reqId, ok: r.ok, message: r.message }));
};

// NOT durable, not contained: a live question, answered to the asking socket only (`pluginrpc.ts`).
/** Who sent a `plugin.call`: the socket's tier, and the paired device's name when its token named one. */
export function callerOf(kind: PeerKind | undefined, deviceId: string | undefined | null, ledger: { get(id: string): { name: string } | null }): PluginCaller {
  const id = deviceId ?? null;
  return { kind: kind ?? "unknown", deviceId: id, deviceName: id ? ledger.get(id)?.name ?? null : null };
}

const onPluginCall: Route<"plugin.call"> = (a) => {
    const { ackId, plugin, method, args } = a.msg;
    if (typeof ackId !== "string" || !PLUGIN_ACK_RE.test(ackId)) return;
    void a.c.plugins.callOnce(ackId, String(plugin), String(method), args,
      callerOf(a.c.wsKind.get(a.ws), a.c.wsDevice.get(a.ws), a.c.auth.devices)).then((r) =>
      a.c.send(a.ws, { t: "plugin.reply", ackId, plugin, method, ...r }));
};

// ── Live streams (plugin API 1.4, `plugins/pluginstreams.ts`) ── NOT durable, never in the ack
// ledger, never retried: a late open is for a screen nobody watches, a late input lands elsewhere.
// An unknown streamId is ignored in silence (a stale close after a reconnect is normal).
const onStreamOpen: Route<"stream.open"> = (a) => { void a.c.plugins.streams.open(a.ws, a.msg); };
const onStreamParams: Route<"stream.params"> = (a) => a.c.plugins.streams.params(a.ws, a.msg.streamId, a.msg.params);
const onStreamInput: Route<"stream.input"> = (a) => a.c.plugins.streams.input(a.ws, a.msg.streamId, a.msg.ev);
const onStreamAck: Route<"stream.ack"> = (a) => a.c.plugins.streams.ack(a.ws, a.msg.streamId, a.msg.seq, a.msg.rxBytes);
const onStreamKeyframe: Route<"stream.keyframe"> = (a) => a.c.plugins.streams.keyframe(a.ws, a.msg.streamId);
const onStreamClose: Route<"stream.close"> = (a) => a.c.plugins.streams.close(a.ws, a.msg.streamId);

const onPluginSessionToggle: Route<"plugin.sessionToggle"> = (a) => {
    pluginRefused(a, a.msg.id, a.c.plugins.sessionToggle(a.msg.id, a.msg.sessionId, a.msg.toggle, a.msg.value));
};

const onPluginSessionAnswer: Route<"plugin.sessionAnswer"> = (a) => {
    pluginRefused(a, a.msg.id, a.c.plugins.sessionAnswer(a.msg.id, a.msg.sessionId, !!a.msg.value));
    // An answering plugin may gate on the plan usage — keep the reading warm.
    a.c.syncUsagePolling();
};

// ── The decision log ── `DecisionLog` broadcasts `decisions.log` on any change.
const onDecisionsGet: Route<"decisions.get"> = (a) => {
    a.c.send(a.ws, { t: "decisions.log", entries: a.c.decisionLog.list(a.msg.sessionId, true).slice(0, 200), sessionId: a.msg.sessionId });
};

const onDecisionsArchive: Route<"decisions.archive"> = (a) => {
    a.c.decisionLog.setArchived(a.msg.id, a.msg.archived);
};

const onDecisionsDelete: Route<"decisions.delete"> = (a) => {
    a.c.decisionLog.remove(a.msg.id);
};

const onDecisionsArchiveAll: Route<"decisions.archiveAll"> = (a) => {
    const n = a.c.decisionLog.archiveAll();
    a.c.send(a.ws, { t: "toast", text: n ? `archived ${n} log entr${n === 1 ? "y" : "ies"}` : "nothing to archive" });
};

    // ── Sent-command audit log ──
const onSentGet: Route<"sent.get"> = (a) => {
    a.c.send(a.ws, { t: "sent.log", entries: a.c.sentLogStore.list(a.msg.sessionId), sessionId: a.msg.sessionId });
};

const onSentClear: Route<"sent.clear"> = (a) => {
    a.c.sentLogStore.clear();
    a.c.broadcast({ t: "sent.log", entries: [] });
};

    // ── Synced settings ──
const onSettingsGet: Route<"settings.get"> = (a) => {
    a.c.send(a.ws, { t: "settings.all", doc: a.c.settings.all() });
};

const onSettingsSet: Route<"settings.set"> = (a) => {
    const res = a.c.settings.set(a.msg.key, a.msg.value, a.msg.ts, a.msg.device);
    if ("record" in res) {
      // Broadcast to EVERY socket, the writer included: the echo is what
      // confirms the write landed, and a client applies an update only when
      // its timestamp is newer than what it holds, so this cannot loop.
      a.c.broadcast({ t: "settings.update", key: a.msg.key, value: res.record.value, ts: res.record.ts, ...(res.record.device ? { device: res.record.device } : {}) });
    } else if (res.reject === "older") {
      // Not an error: two devices simply hold different versions. Send the
      // WINNER back to the loser so it stops holding a value nobody else has.
      const cur = a.c.settings.get(a.msg.key);
      if (cur) a.c.send(a.ws, { t: "settings.update", key: a.msg.key, value: cur.value, ts: cur.ts, ...(cur.device ? { device: cur.device } : {}) });
    } else {
      a.c.send(a.ws, { t: "error", message: `setting not stored: ${res.reject}`, context: a.msg.key });
    }
};

// ── The install log ──

/**
 * "What has installed itself, on which phone?"
 *
 * A READ, in the `clihealth.get` / `budget.get` class: not durable, no
 * `contain`, nothing spawned and no directory named — so there is nothing an
 * ackId would protect. Also pushed unprompted on `hello`, because the whole
 * point of the log is the fleet a single device cannot see.
 */
const onInstallGet: Route<"install.get"> = (a) => {
    a.c.send(a.ws, { t: "install.log", doc: a.c.installLog.doc() });
};

/**
 * "Here is every install this phone still has a record of."
 *
 * Idempotent by construction (`mergeInstallLog` keys each entry), which is what
 * lets a phone re-state its whole history on every connect — and it must, since
 * the install worth logging is the one that happened with the tunnel down and
 * nobody watching.
 *
 * **Quiet when nothing changed.** A reconnect that re-states what the host
 * already holds broadcasts nothing: the common case is every handshake, and the
 * alternative is shipping the whole log to every socket for no news. When
 * something IS new every socket hears it, because a second phone watching this
 * screen should see the first one update itself.
 */
const onInstallReport: Route<"install.report"> = (a) => {
    const changed = a.c.installLog.report(a.msg.device ?? { id: "" }, a.msg.entries ?? []);
    if (changed.added || changed.updated) a.c.broadcast({ t: "install.log", doc: a.c.installLog.doc() });
};

/** The phone's HTTP stalls — over the socket, because the HTTP pool is the
 *  thing that is stuck (`shared/netstall.ts`). A record: nothing is sent back. */
const onNetStalls: Route<"net.stalls"> = (a) => {
    a.c.netstats.putClientStalls(String(a.msg.deviceId ?? ""), a.msg.report);
};

const onMeterGet: Route<"meter.get"> = (a) => {
    a.c.send(a.ws, { t: "meter.status", summary: a.c.meter.summary() });
};

const onNotificationGet: Route<"notification.get"> = (a) => {
    a.c.send(a.ws, { t: "notification.list", items: a.c.notifications });
};

const onNotificationClear: Route<"notification.clear"> = (a) => {
    a.c.notifications.length = 0;
    a.c.broadcast({ t: "notification.list", items: a.c.notifications });
};

const onNotifyPrefsSet: Route<"notify.prefs.set"> = (a) => {
    // Broadcast, not send: the mute is the user's, not this device's, so a
    // second phone must not keep showing a switch the desktop just flipped.
    a.c.broadcast({ t: "notify.prefs", prefs: a.c.notifyPrefs.set(a.msg.prefs) });
    // Muting `burn` is one of the things that decides whether `/usage` is polled at all.
    a.c.syncUsagePolling();
};

const onBudgetGet: Route<"budget.get"> = (a) => {
    a.c.send(a.ws, budgetState(a.c));
};

/** The `budget.state` frame: the periods ride only when there are any (a subscription with none configured is unchanged). */
const budgetState = (c: HostCtx): HostMessage => {
    const periods = c.budget.periods();
    return { t: "budget.state", budget: c.budget.get(), verdict: c.budget.verdict(), ...(periods.length ? { periods } : {}) };
};

/** Answer with the billing profile. The first ask of a host that has not probed yet starts the probe; its answer arrives as a broadcast. */
const onBillingGet: Route<"billing.get"> = (a) => {
    a.c.send(a.ws, { t: "billing.status", ...a.c.billing.status() });
    void a.c.billing.refresh(); // cheap: a no-op while the last probe is fresh; redoes one that read nothing
};

/** A person's override wins; null hands the profile back to the probe (and re-probes). Not durable: idempotent state. */
const onBillingSet: Route<"billing.set"> = (a) => {
    const s = a.c.billing.setOverride(a.msg.profile);
    a.c.broadcast({ t: "billing.status", ...s });
    a.c.syncUsagePolling();
    a.c.publishBudget(true);
    if (a.msg.profile === null) void a.c.billing.refresh(true);
};

const onBudgetSet: Route<"budget.set"> = (a) => {
    a.c.budget.set(a.msg.budget);
    // Arming or disarming the budget changes whether the usage reading is
    // worth keeping warm at all.
    a.c.syncUsagePolling();
    // Forced: the CEILING moved even if the verdict did not, and every device
    // shows that number. Broadcast for the same reason the mute does — this is
    // the account's budget, not this phone's.
    a.c.publishBudget(true);
};

/**
 * The emergency halt (`halt.ts`). The latch is set BEFORE the kill, so nothing
 * that wakes during the second of grace — the intent tick, a resurrect timer, a
 * sidecar event — can start anything; then every live headless run and every
 * agent session is stopped, and the receipt is broadcast. Lifting only clears
 * the flag and kicks the tick: nothing that was killed comes back by itself.
 * A repeat of the current value changes nothing and re-sends the state.
 */
const onHostHalt: Route<"host.halt"> = (a) => {
  const publish = (): void => a.c.broadcast({ t: "halt.state", halt: haltState() });
  if (a.msg.on === isHalted()) return void a.c.send(a.ws, { t: "halt.state", halt: haltState() });
  if (!a.msg.on) {
    setHalted(false);
    console.log(`${logTag} halt lifted`);
    publish();
    a.c.intents.kick();
    return;
  }
  setHalted(true);
  console.warn(`${logTag} HALT: stopping every agent session and headless run`);
  publish();
  const sidecars = stopRuns();
  const held = a.c.intents.pending().length;
  void a.c.sessions.haltAll().then((k) => {
    const receipt = { at: Date.now(), sidecars, held, ...k };
    console.warn(`${logTag} HALT done: ${haltReceiptWords(receipt)}`);
    setHalted(true, receipt);
    publish();
  });
};

export const systemRoutes: RouteTable = {
  "ping": onPing,
  "host.halt": onHostHalt,
  "hello": onHello,
  "update.status": onUpdateStatus,
  "update.check": onUpdateCheck,
  "update.apply": onUpdateApply,
  "usage.get": onUsageGet,
  "usage.refresh": onUsageRefresh,
  "auth.set": onAuthSet as Route<"auth.set">,
  "auth.clear": onAuthSet as Route<"auth.clear">,
  "auth.gateTailscale": onAuthSet as Route<"auth.gateTailscale">,
  "auth.get": onAuthGet,
  "plugin.list": onPluginList,
  "plugin.set": onPluginSet,
  "plugin.enable": onPluginEnable,
  "plugin.action": onPluginAction,
  "plugin.call": onPluginCall,
  "plugin.sessionToggle": onPluginSessionToggle,
  "plugin.sessionAnswer": onPluginSessionAnswer,
  "stream.open": onStreamOpen,
  "stream.params": onStreamParams,
  "stream.input": onStreamInput,
  "stream.ack": onStreamAck,
  "stream.keyframe": onStreamKeyframe,
  "stream.close": onStreamClose,
  "decisions.get": onDecisionsGet,
  "decisions.archive": onDecisionsArchive,
  "decisions.delete": onDecisionsDelete,
  "decisions.archiveAll": onDecisionsArchiveAll,
  "sent.get": onSentGet,
  "sent.clear": onSentClear,
  "install.get": onInstallGet,
  "install.report": onInstallReport,
  "net.stalls": onNetStalls,
  "settings.get": onSettingsGet,
  "settings.set": onSettingsSet,
  "meter.get": onMeterGet,
  "notification.get": onNotificationGet,
  "notification.clear": onNotificationClear,
  "notify.prefs.set": onNotifyPrefsSet,
  "budget.get": onBudgetGet,
  "clihealth.get": onCliHealthGet,
  "clihealth.clear": onCliHealthClear,
  "localrt.watch": onLocalRtWatch,
  "localrt.evict": onLocalRtEvict,
  "backends.recheck": onBackendsRecheck,
  "budget.set": onBudgetSet,
  "billing.get": onBillingGet,
  "billing.set": onBillingSet,
};
