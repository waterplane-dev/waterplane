// FIRST, before every other import: it computes ROOT and loads the .env files,
// so a WATERPLANE_* knob a module reads at import sees them (env.ts says why).
import { ROOT, ROOT_DEFAULTED, ROOT_PICKED, env } from "./env.js";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { 
  type ClientMessage, logTag, envName, notifyEnabled } from "@waterplane/shared";
import { tailscaleIp, tailscaleBin, tailscaleDnsName, serveHttpsUrl, lanIps } from "./net.js";
import { configureOrigins } from "./origin.js";
import { printBootSummary, printReport, reportJson, runChecks } from "./doctor.js";
import { AuthManager, authLostNotice, selectWsProtocol } from "./auth.js";
import { SessionManager } from "./sessions.js";
import { AckLedger, ackWriteNotice, lostLedgerNotice } from "./acks.js";
import { BacklogManager, BACKLOG_LINGER_MS } from "./backlog.js";
import { BuildManager } from "./builds.js";
import { createFirstApp } from "./server/firstapp.js";
import { CaptureManager } from "./capture.js";
import { AssessStore, makeAssessExecutor } from "./assess.js";
import { AutoPullManager } from "./autopull.js";
import { FanoutManager } from "./fanout.js";
import { IntentManager } from "./intents/manager.js";
import { launchesToDrafts, schedulesToDrafts } from "./intents/adapters.js";
import { ReviewManager, ReviewStore } from "./review.js";
import { NamingManager } from "./naming.js";
import { OpenDeliveries, setOpenDeliveries } from "./opendeliveries.js";
import { CliHealthStore, setCliHealth } from "./clihealth.js";
import { TokenStatsStore } from "./tokenstats.js";
import { SentLog, setSentLog } from "./sentlog.js";
import { InstallLogStore } from "./installlog.js";
import { SettingsStore } from "./settings.js";
import { PushManager } from "./push.js";
import { NotifyPrefsStore } from "./notifyprefs.js";
import { AttentionStore } from "./attentionstore.js";
import { setPrNotify } from "./prs.js"; import { setGitOutcomeSink } from "./git.js"; import { reportGitOutcome } from "./gitnotify.js";
import { UpdateChecker } from "./update.js"; import { createPluginUpdates, createUpdateApplier } from "./updates/wire.js";
import { SetupWatcher } from "./setupwatch.js"; import { createHealthWatch } from "./healthwatch.js"; import { createExposurePush } from "./exposurepush.js"; import { startDiskWatch } from "./diskwatch.js";
import { NetStats } from "./netstats.js";
import { DecisionLog } from "./decisionlog.js";
import { PluginRegistry } from "./plugins/pluginregistry.js";
import { hostSecretDir } from "./secrets.js"; import { createPeerStore } from "./peers/store.js"; import { startPeerJobs } from "./peers/agentpeer.js"; import { setPeerServe, setPeerSelfAddr } from "./peers/routes.js"; import { createPeerServe } from "./peers/serve.js";
import { Meter } from "./meter.js";
import { UiStats } from "./uistats.js";
import { UsageChecker } from "./usage.js"; import { createUsageSources } from "./usagesources.js";
import { UsageLog } from "./usagelog.js";
import { createBurnWatch, createSourceBurnWatch } from "./burnwatch.js"; import { createWeekBurn } from "./weekburn.js"; import { discoverTargets } from "./repos.js"; import { costMeta } from "./costwindow.js"; import { hostStateDir } from "./branddirs.js";
import { BudgetStore } from "./budget.js";
import { setSpendPeriodSource } from "./spendwall.js";
import { createBillingWire } from "./server/billingwire.js";
import { backendInfos, claudeBackend, primeBackendModels } from "./backends/index.js";
import { initThumbs } from "./thumbs.js";
import { dispatch } from "./routes/index.js";
import { installChecklistStores } from "./setupprefs.js"; import { AskRulesStore, setAskRulesStore } from "./askrules.js";
import { installSessionModels } from "./localrt.js";
import { startLocalUsage } from "./localusage.js";
import { createClients } from "./server/clients.js";
import { createDeliveries } from "./server/deliveries.js";
import type { ServerCtxDraft } from "./server/ctx.js"; import { assertCtxComplete } from "./server/ctxseal.js";
import { makeIntentDeps } from "./server/intentDeps.js";
import { createSnapshots, wireIntentEvents } from "./server/intentEvents.js";
import { createScan } from "./server/scan.js";
import { wireSessionEvents } from "./server/sessionEvents.js";
import { createHttp } from "./server/http.js";
import { installShutdown } from "./server/shutdown.js";
import { createWsOps, WS_MAX_PAYLOAD } from "./server/wsops.js";

const PORT = Number(env("PORT") || 8770);
/**
 * `npm run doctor` imports this whole module, and its body boots managers. A
 * report must never START anything: measured 2026-09-25, a `--doctor` run was
 * still alive 25 h later, kept up by the usage poll below, and had spawned a
 * `claude` /usage probe every 8 min — 193 of the machine's 511 PTYs, the table
 * ran dry. So every module-level starter is gated on this, and `main()` exits
 * explicitly after the report (bounded by `DOCTOR_DEADLINE_MS`).
 */
const DOCTOR = process.argv.includes("--doctor");
const DOCTOR_DEADLINE_MS = 90_000;
// Defined in webbundle.ts, which also publishes this directory as a downloadable
// manifest for the Android shell's over-the-air updates — one definition, so the
// bytes we serve and the bytes we describe can never be two different trees.
/** Identity of THIS daemon process, handed to every client in `welcome`. PTY
 *  `seq` counts bytes since a session was registered, so it restarts at 0 on a
 *  restart even for a tmux session that never died — a resume point persisted by
 *  the phone across that boundary would index a byte stream that no longer
 *  exists. Clients hand the boot id back with `resumeSeq`; a mismatch means a
 *  full replay instead of a corrupt stitch. */
const BOOT_ID = randomUUID();

/**
 * Everything a route handler and a `server/` factory may reach for, filled in
 * boot order: one `ctx.<name> = <name>` right after each name is defined. A
 * reader goes through `ctx.<name>` at CALL time, never at construction — see
 * `server/ctx.ts`, and docs/notes/host-architecture.md ("ServerCtx").
 */
const ctx = {} as ServerCtxDraft;
ctx.ROOT = ROOT; ctx.BOOT_ID = BOOT_ID; ctx.PORT = PORT; ctx.DOCTOR = DOCTOR;

// The intent store as the phone sees it — `server/intentEvents.ts`. Nothing is
// read until a snapshot is CALLED, so the construction callbacks below may hold
// them long before `intents`, `backlog` or `naming` exist.
const { scheduleSnapshot, launchSnapshot, intentSnapshot, assessSnapshot, backlogSnapshot, ...snap } = createSnapshots(ctx);
ctx.scheduleSnapshot = scheduleSnapshot; ctx.launchSnapshot = launchSnapshot; ctx.intentSnapshot = intentSnapshot;
ctx.assessSnapshot = assessSnapshot; ctx.backlogSnapshot = backlogSnapshot; ctx.padNotesFor = snap.padNotesFor;

setAskRulesStore(new AskRulesStore(ROOT)); const sessions = new SessionManager(ROOT, PORT); // ask rules first: `create` reads them per launch
ctx.sessions = sessions;
// Live sessions per resident model (`localrt.ts`'s `installSessionModels`, a closure called
// fresh on every sample), and the runner's own ledger (`localusage.ts`).
installSessionModels(() => sessions.list().map((s) => s.model));
if (!DOCTOR) startLocalUsage(ROOT);
const push = new PushManager(ROOT);
ctx.push = push;
/** Which notification kinds are wanted at all — checked before the feed entry
 *  AND before the push, since muting only the display still buzzes the phone. */
const notifyPrefs = new NotifyPrefsStore(ROOT);
const auth = new AuthManager(ROOT);
ctx.notifyPrefs = notifyPrefs; ctx.auth = auth; ctx.peers = createPeerStore(hostSecretDir()); setPeerServe(createPeerServe(ctx));
/** Runs the repo setup checklist on its own, so a repo that was cloned on the
 *  desktop and driven from the phone gets inspected before its first inbox photo
 *  lands in `git status` — rather than only when someone opens the sheet. Read
 *  only: it flags, the fix stays a tap. */
const setupWatch = new SetupWatcher(ROOT);
ctx.setupWatch = setupWatch;

/** Per-repo context-weight thresholds. Installed as the module singleton before
 *  anything can inspect a repo — `inspectRepo()` reaches it through a free
 *  function, and an unset store silently means "env and defaults only", which is
 *  the pre-override behaviour and the right answer for a tool that never booted
 *  a daemon. */
installChecklistStores(ROOT);

/** Who is connected and how anything reaches them — sockets, `send`/`broadcast`,
 *  auth re-evaluation, the watched set, the notification feed and `notify()`.
 *  See `server/clients.ts`. */
const {
  attached, clients, wsKind, wsToken, wsDevice, wsRole, closeDevice, socketAuthorized,
  authStateFor, enforceAuth, broadcastAuthState, recomputeWatched, isAttachedToSomeone,
  send, broadcast, notifications, notify, notificationFeed, clearNotifications, handleNotification,
  resolveAttention, resolveAttentionPrefix, attention,
} = createClients({ auth, notifyPrefs, push, sessions, attention: new AttentionStore(ROOT) }); ctx.healthWatch = createHealthWatch(ROOT, notify);
Object.assign(ctx, {
  attached, clients, wsKind, wsToken, wsDevice, wsRole, closeDevice, socketAuthorized,
  authStateFor, enforceAuth, broadcastAuthState, recomputeWatched, isAttachedToSomeone,
  send, broadcast, notifications, notify, notificationFeed, clearNotifications, handleNotification,
  resolveAttention, resolveAttentionPrefix, attention,
});
// A host-run pull or push that ended is told once (`gitnotify.ts`): failed ⇒ attention, pushed ⇒ a receipt.
setGitOutcomeSink((o) => reportGitOutcome(o, ctx)); setPrNotify(ctx); // PR changes seen by the leased poll (prs.ts) ride the git notify path

const deliveries = createDeliveries(ctx);
ctx.startPrompt = deliveries.startPrompt; ctx.deliverChain = deliveries.deliverChain;
ctx.deliverySnapshot = deliveries.deliverySnapshot; ctx.deliverInput = deliveries.deliverInput;

/**
 * The CLI integration's own health.
 *
 * Everything this app does rests on driving a TUI it does not own, and every one
 * of those integration points degrades to null by design — correctly, and in
 * silence. Graceful degradation nobody is told about is indistinguishable from
 * working, which is how one delivery in five came back as a gravestone for a
 * week. The record is fed from ten call sites (`clihealth.ts` names them); the
 * singleton is what stops call site eleven from forgetting.
 */
const cliHealthStore = new CliHealthStore(
  ROOT,
  (health, rollup) => broadcast({ t: "clihealth", health, rollup, source: cliHealthStore.source() }),
  // Keyed per signal so a recovery can resolve it (tag `clihealth-<id>` → key `cli:<id>`).
  (kind, p) => notify(kind, p.tag.startsWith("clihealth-") ? { ...p, key: `cli:${p.tag.slice(10)}` } : p),
);
cliHealthStore.onRecovered = (id) => { ctx.resolveAttention(`cli:${id}`, "recovered"); };
setCliHealth(cliHealthStore);
ctx.cliHealthStore = cliHealthStore;

/**
 * Token usage across every conversation log on disk.
 *
 * Constructed at boot so the persisted per-file summaries are already in memory
 * when the statistics screen is first opened — the alternative is a 4.5 s cold
 * scan on that tap, after every routine `npm run restart`.
 */
const tokenStats = new TokenStatsStore(ROOT);
ctx.tokenStats = tokenStats;
/**
 * Warm it in the background, once, a little after boot.
 *
 * The first scan on a machine with no persisted store walks every conversation
 * log there is — measured here, 9,947 files and ~7 s. That is fine to pay while
 * nobody is waiting and wrong to pay on the tap that opens the screen. Deferred
 * so it does not compete with session rediscovery, and `unref`'d so it cannot
 * hold the process up; the scan itself yields to the event loop throughout
 * (`tokenstats.ts`), so the daemon stays responsive while it runs.
 */
setTimeout(() => { void tokenStats.read(0).catch(() => undefined); }, 20_000).unref();

/**
 * Auto-download: per-repo rules for what the phone should fetch on its own, plus
 * the persisted queue of files waiting to be fetched. The queue exists because
 * the interesting case is a file that lands while nothing is connected — a live
 * broadcast alone would drop exactly the pull you were waiting for.
 *
 * A queued item notifies with `pull: true`, which is what lets the service
 * worker start a Background Fetch from the push handler with the app closed.
 */
const autopull = new AutoPullManager(ROOT);
ctx.autopull = autopull;
// The scanners, the auto-pull hand-over, the build announcement and the one
// `autopull.on("item")` listener are `server/scan.ts`; `createScan` registers
// that listener, so it is called right here, after the construction.
const { imgSeen, outSeen, pullSeen, scanImages, scanOutboxDocs, scanPullCandidates, pullNewFiles, fmtSize, ...scan } = createScan(ctx);
ctx.announceBuild = scan.announceBuild;
ctx.imgSeen = imgSeen; ctx.scanImages = scanImages;
ctx.outSeen = outSeen; ctx.scanOutboxDocs = scanOutboxDocs;
ctx.pullSeen = pullSeen; ctx.scanPullCandidates = scanPullCandidates;
ctx.pullNewFiles = pullNewFiles;
ctx.pullCatchUp = scan.pullCatchUp; ctx.fmtSize = fmtSize;

// The durable Intent store. Its deps literal, the executors included, is
// `server/intentDeps.ts` (every name read off `ctx` when it is CALLED).
const intents: IntentManager = new IntentManager(makeIntentDeps(ctx));
ctx.intents = intents;

/**
 * The backlog, the fan-out and the builds — three VIEWS of the store above,
 * constructed after it because each one holds it.
 *
 * The ordering is the only thing worth a note: `intents` names all three in its
 * executors, and they name `intents` back. That works because an executor is a
 * closure the store calls later, long after these lines have run — the same
 * shape `backlog.budgetBlocker` already had for `budget`.
 */
const reviewStore = new ReviewStore(ROOT, () => broadcast(backlogSnapshot()));
/**
 * What the repo's untitled rows should be CALLED.
 *
 * The cheapest thing this daemon buys — toolless, no repo read, one small
 * completion per batch — and the one with the narrowest store slice of any of
 * them: `list` and `name`, which between them cannot run, move, retire or
 * re-word anything. Built here before the backlog, for the closure reason
 * the executors above rely on; `onChange` is the same broadcast, because the rows a pass is working
 * on ride the backlog snapshot as a transient.
 */
const naming = new NamingManager({
  intents,
  onChange: () => broadcast(backlogSnapshot()),
});
const backlog: BacklogManager = new BacklogManager(ROOT, sessions, intents, reviewStore);
const review = new ReviewManager(sessions, intents, reviewStore);
const fanout = new FanoutManager(ROOT, sessions, intents);
ctx.naming = naming; ctx.backlog = backlog; ctx.review = review; ctx.fanout = fanout;
// Build buttons: run a repo's build command without a claude session (the
// token-limit escape hatch). Output streams to every client (builds are rare —
// no per-session attach gating); a completed build notifies with its artifact.
const builds = new BuildManager(intents);
ctx.builds = builds;
builds.on("output", (runId: string, chunk: string) =>
  broadcast({ t: "build.output", runId, dataB64: Buffer.from(chunk, "utf8").toString("base64") }));

/**
 * The verified capture loop — a build with a picture and a claim on the end.
 *
 * Constructed here beside `builds`, holding the same store, and streaming over
 * the same one socket: `capture.output` is `build.output`'s shape on purpose,
 * so nothing about a picture needs a second connection to arrive.
 */
const capture = new CaptureManager(intents);
ctx.capture = capture;
capture.on("output", (runId: string, chunk: string) =>
  broadcast({ t: "capture.output", runId, dataB64: Buffer.from(chunk, "utf8").toString("base64") }));

/**
 * "What is left in this repo, and what is already done" — the store, and the
 * executor the intent manager calls.
 *
 * Broadcast per REPO on every state change, which is what makes a run visible
 * while it works: an assess row is neither `isBacklogRow` nor `isBuildRow`, so
 * without its own snapshot it would appear in no list at all until it finished.
 */
const assess = new AssessStore(ROOT, (repoDir) => broadcast(assessSnapshot(repoDir)));
const assessExecutor = makeAssessExecutor({
  store: assess,
  intents: () => intents.list(),
  notes: (cwd) => ctx.padNotesFor(cwd),
});
ctx.assess = assess; ctx.assessExecutor = assessExecutor;

/**
 * Close the automatic sessions nobody is using any more.
 *
 * A TIMER, unlike everything in `intents/`, and the distinction is the store's
 * own: nothing is FIRED on this clock — no work runs, no prompt is typed, no
 * decision is made that a restart could get wrong. It only closes a session that
 * has been idle, unattached and empty for `WATERPLANE_BACKLOG_LINGER_MS`, and "ten
 * minutes from now" is a question no event can answer (the session's last event
 * is the turn that ended it). A minute of granularity on a ten-minute linger,
 * unref'd so it never holds the process open, and re-asked from scratch each
 * time rather than scheduled per session — a per-session timer would be one more
 * thing a restart silently drops.
 */
if (BACKLOG_LINGER_MS > 0) {
  const lingerTimer = setInterval(() => {
    const closed = backlog.lingerSweep(isAttachedToSomeone);
    if (closed.length) console.log(`${logTag} closed ${closed.length} idle automatic session${closed.length === 1 ? "" : "s"} (they are under Recently closed)`);
  }, Math.max(5_000, Math.min(60_000, BACKLOG_LINGER_MS)));
  if (typeof lingerTimer.unref === "function") lingerTimer.unref();
}

// Every `sessions.on(…)` main registers — the turnEnded/exit → intents pair
// FIRST, then the broadcasts, the scan baselines, the prompt, the limit log and
// idle, fifteen in all and in that order, are `server/sessionEvents.ts`. Wired here, at the position of the first one, and
// before the intent store's own listeners below. Its `ptyHeld` is the plugin streams' PTY-first check.
const ptyFanout = wireSessionEvents(ctx);

// The four `intents.on(…)` blocks (settled, requeued, skipped, missed, in that
// order) are `server/intentEvents.ts`; registered here, after the store exists
// and before `migrateLegacy`/`start` below.
wireIntentEvents(ctx);

// Import what the old per-subsystem files were holding, then rename each source
// to `*.migrated` — a conversion nobody can check is a conversion nobody can
// trust, so the evidence stays on disk.
intents.migrateLegacy({ launches: launchesToDrafts, schedules: schedulesToDrafts });
// A doctor run that ticked the intent store would fire deferred work from a
// second process next to the live host — never.
if (!DOCTOR) intents.start();

/**
 * Deliveries this host could not confirm — and keeps asking about.
 *
 * The second half of the same handover `launches` is the first half of: a
 * question about work must not be owned by a phone. `deliver.ts` registers a
 * row here whenever its echo window fails, the sweep re-asks the CLI's own
 * conversation log until the answer is one of the terminal verdicts, and the
 * resolution is broadcast whether or not anybody was listening when it landed.
 */
const openDeliveries = new OpenDeliveries(ROOT, sessions, deliveries.resendOpenDelivery, () => broadcast(deliveries.deliverySnapshot()));
setOpenDeliveries(openDeliveries);
ctx.openDeliveries = openDeliveries;
deliveries.wireDeliverySettled();
if (!DOCTOR) openDeliveries.start();
ctx.onboard = createFirstApp(ctx); startPeerJobs(ctx); // the first-app job resumes after the store has started; so do open peer jobs

const updates = new UpdateChecker((info) => {
  broadcast({ t: "update.status", info });
  // The CLI's version is part of the health record, because an upgrade is the
  // single most likely cause of a heuristic breaking: a change re-arms every
  // signal and is announced on its own, once, before the readout goes grey. An
  // absent `current` is ignored inside `noteVersion` — a reading we could not
  // take must never look like a new binary.
  cliHealthStore.noteVersion(info.current);
});
ctx.updates = updates;

/** Limit auto-continues + plugin decisions; migrates the old oracle log once. */
const decisionLog: DecisionLog = new DecisionLog(ROOT, () => broadcast({ t: "decisions.log", entries: decisionLog.list(undefined, true).slice(0, 200) }));
ctx.decisionLog = decisionLog;
/**
 * The sent-command audit log. Constructed here (not inside `sentlog.ts`) so it
 * gets the two things only this module has: the session facts to stamp onto an
 * entry, and the broadcast that puts a new row on an open phone immediately.
 */
const sentLogStore = new SentLog(
  ROOT,
  (id) => {
    const info = sessions.get(id);
    return info ? { title: info.title, repoDir: info.cwd } : null;
  },
  (entry) => broadcast({ t: "sent.new", entry }),
);
setSentLog(sentLogStore);
ctx.sentLogStore = sentLogStore;
/**
 * What the phones installed. One host, many devices — see `installlog.ts`: the
 * installs happen on the phones with the app closed, so the only place the
 * whole fleet's history can exist is the desktop that produced the builds.
 */
const installLog = new InstallLogStore(ROOT);
ctx.installLog = installLog;
/**
 * The settings that follow the USER rather than the browser — prompt
 * templates, presets, header commands, the pad, the toolbar layout. Opaque
 * values, last-write-wins on the client's timestamp; the allow-list of keys
 * lives in `@waterplane/shared`. See `settings.ts`.
 */
const settings = new SettingsStore(ROOT);
const meter = new Meter(ROOT, (s) => broadcast({ t: "meter.status", summary: s }));
ctx.settings = settings; ctx.meter = meter;
// Which UI features actually get used — persisted to <STATE_DIR>/ui-usage.json
// so an agent can read it and prune what never fires. Local only.
const uiStats = new UiStats(ROOT);
ctx.uiStats = uiStats;
/**
 * The readings, kept. Recorded HERE rather than inside the checker so the
 * scraper stays a scraper: `usage.ts` reads a screen, this decides that a
 * reading is worth remembering. Nothing on this path ever asks for a scrape —
 * see `usagelog.ts`.
 */
const usageLog = new UsageLog(ROOT);
const burnWatch = createBurnWatch({ usageLog, costWindow: (a, b) => tokenStats.costWindow(a, b, costMeta(sessions, intents), 60_000), notify, stateDir: hostStateDir(ROOT) });
// The week-end burn (weekburn.ts): the weekly pick, its lazy backlog packages and the once-a-week nudge.
// Closures, not values: `usage` and `billingWire` are defined below and read only when the callback runs.
const weekBurn = createWeekBurn({
  stateDir: hostStateDir(ROOT), usage: () => usage.get(), usageLog, subscription: () => billingWire.scraped(),
  rows: () => intents.list(), repos: () => discoverTargets(ROOT),
  add: (text, repoDir, label, opts) => backlog.add(text, repoDir, label, undefined, true, opts),
  health: (dir) => ctx.healthWatch.summaryFor(dir), notify, notifyOn: () => notifyEnabled(notifyPrefs.get(), "weekburn"),
  changed: () => syncUsagePolling(),
});
ctx.weekBurn = weekBurn;
const usage = new UsageChecker(ROOT, (u) => {
  usageLog.note(u);
  void burnWatch.observe(u);
  void weekBurn.observe(u);
  usageSources.publish(); // `usage` + every source's `readings` (usagesources.ts)
  // A fresh reading can flip the budget either way (over, or back under after a
  // reset): publishing it HERE makes the phone's queue rows explain themselves unasked.
  ctx.publishBudget();
});
const sourceBurn = createSourceBurnWatch({ history: (s) => usageSources.history(s)?.samples ?? null, notify, stateDir: hostStateDir(ROOT) }); /* the burn push per non-claude source, on each fresh reading */ const usageSources = createUsageSources(ROOT, () => usage.get(), broadcast, (r) => { if (notifyEnabled(notifyPrefs.get(), "burn")) void sourceBurn.observe(r); }); ctx.usageLog = usageLog; ctx.usage = usage; ctx.usageSources = usageSources;
/**
 * The usage budget's gate. Reads the checker's cache — never triggers a scrape
 * itself, because it is asked several times a second by the backlog tick and by
 * every flush, and spawning a `claude` on that cadence would be the cost.
 */
/**
 * The last reading, re-offered before anything has been probed.
 *
 * This process starts with an empty checker, and `npm run restart` — which is
 * what shipping a new web bundle to the phone IS — runs on every host change.
 * The phone reconnected, asked, and drew `? / ? wk` until a fresh scrape landed
 * (9-15 s at best, the whole TTL when that scrape failed), for a figure that was
 * sitting in `usagelog.jsonl` the entire time. `seed` claims a window only while
 * the reset the screen named is still ahead, keeps the ORIGINAL `checkedAt`, and
 * marks the reading `remembered` — see `usage.ts`.
 */
usage.seed(usageLog.last());
// Billing profile + dollar-period spend (server/billingwire.ts); the budget reads them.
const billingWire = createBillingWire(ctx); ctx.billing = billingWire.billing;
const budget: BudgetStore = new BudgetStore(ROOT, () => usage.get(), () => billingWire.spend(), () => billingWire.scraped()); ctx.budget = budget; setSpendPeriodSource(() => budget.usdPeriods());
ctx.publishBudget = billingWire.publishBudget; // tells clients the verdict, only when it moved
// Keep usage warm only when something GATES on it (each poll spawns claude).
function syncUsagePolling() {
  // Poll when a plugin could answer a box unattended (its per-session switch
  // is on somewhere) — it may gate on the plan usage (`api.claudeUsage`)…
  const forPlugins = plugins.wantsUsage();
  // …and whenever the usage budget is armed, which is the other consumer of the
  // reading. Without this the gate would run on a cache nobody refreshes, go
  // stale in 25 minutes and fail open for ever — the budget would be a switch
  // that quietly does nothing, which is the worst way for a safety setting to
  // fail. A budget watching nothing does not poll; a session's percent budget does (its calibration).
  const cfg = budget.get();
  const forBudget = cfg.enabled && (cfg.sessionMax < 100 || (cfg.weeklyMax != null && cfg.weeklyMax < 100) || (cfg.leftoverMax != null && cfg.leftoverMax < 100));
  billingWire.syncSpendFold();
  const forBurn = (burnWatch.armed() || sourceBurn.armed()) && notifyEnabled(notifyPrefs.get(), "burn"); // the burn push only sees polled readings
  // A known non-subscription account has no /usage screen worth a `claude` spawn; `unknown` polls as before.
  const forWeekBurn = weekBurn.armed(); // a pick for this week, `recurring`, or this week's nudge still possible
  const gated = forPlugins || forBudget || forBurn || forWeekBurn || sessions.wantsBudgetUsage(); usageSources.setPolling(gated); // other sources: same predicate, not claude's billing gate
  if (!billingWire.scraped()) usage.stopPolling();
  else if (gated) usage.startPolling(); else usage.stopPolling();
}
ctx.syncUsagePolling = syncUsagePolling;
/**
 * Plugins (docs/notes/plugins.md): discovered in the config dir, activated
 * after boot, never in a doctor run — a plugin may start timers or spend.
 */
const plugins = new PluginRegistry({
  root: ROOT, configDir: hostSecretDir(), sessions, host: ctx, // `host`: handToAgent's backlog add
  decision: (row) => decisionLog.add(row), meter: (e) => meter.record(e),
  notify, usage: () => usage.get(), push: (plugin, event, data) => broadcast({ t: "plugin.push", plugin, event, data }),
  changed: () => broadcast({ t: "plugin.list", plugins: plugins.views() }), hookPort: PORT, streamSink: () => ({ sendJson: (ws, msg) => send(ws as WebSocket, msg), ptyHeld: (ws) => ptyFanout.ptyHeld(ws as WebSocket) }), usageProbe: (_plugin, def) => usageSources.register(def), // `api.stream`, `api.usageProbe`
});
ctx.plugins = plugins;
ctx.pluginUpdates = createPluginUpdates({ root: ROOT, plugins, settings, broadcast });
ctx.updateApplier = createUpdateApplier({ configDir: hostSecretDir(), plugins, checker: ctx.pluginUpdates });
if (!DOCTOR) void plugins.loadBuiltins().then(() => plugins.loadAll()).then(() => { sessions.parked((b) => plugins.backendOwner(b)); syncUsagePolling(); });
// Unconditional in the daemon: the budget is armed by default.
// Never in a doctor run — each poll is a `claude` in a PTY (see `DOCTOR`).
if (!DOCTOR) syncUsagePolling();
// The billing probe: once at boot (a spawn), never per request; a change re-syncs via onChange.
if (!DOCTOR) void billingWire.billing.refresh();
{
  const b = budget.get();
  if (b.enabled && b.sessionMax < 100) console.log(`${logTag} usage budget: automatic work pauses at ${b.sessionMax}% of the session window.`);
}
if (!meter.enabled) console.log(`${logTag} usage metering disabled (${envName("METER")}=0).`);

// ── HTTP: API router, then static web app ────────────────────────────

const http = createHttp(ctx);

// ── WebSocket ────────────────────────────────────────────────────────

/**
 * Seen delivery receipts, so a client retry is idempotent (see "session.input",
 * "backlog.add" and the durable ops below). Persisted + TTL'd in acks.ts.
 */
const acks = new AckLedger(ROOT);
ctx.acks = acks; if (acks.lost) notify("undelivered", lostLedgerNotice(acks.lost)); // a lost ledger is TOLD (acks.ts)
acks.onWriteError = (message) => notify("undelivered", ackWriteNotice(message)); // …and so is one that stopped reaching the disk
// So is a lost password file (auth.ts: fails closed) and an unreadable or newer intent store (intents/disk.ts).
if (auth.lost) notify("info", { ...authLostNotice(auth.lost), level: "attention" });
{ const n = intents.storeNotice(); if (n) notify("backlog", { ...n, level: "attention" }); }

/**
 * Connectivity + delivery telemetry. Counts the things you can only see in
 * hindsight — how often sockets die and with what close code, how verified
 * compose deliveries actually ended, and how many receipts the tunnel ate
 * (`noteAckReplay`). See netstats.ts.
 */
const netstats = new NetStats(ROOT);
ctx.netstats = netstats;

const wsops = createWsOps(ctx);
ctx.inputsInFlight = wsops.inputsInFlight; ctx.durableOp = wsops.durableOp; ctx.containRepoDir = wsops.containRepoDir;

/**
 * One client frame.
 *
 * The 92-arm switch this used to be lives in `routes/` now, one file per
 * domain, dispatched from a table. See `routes/types.ts` for why that shape
 * was worth the move — briefly: `durableOp` and `containRepoDir` are rules
 * that a ninety-third arm could silently omit, and this file was the second
 * most-edited in the project because every feature added an arm to it.
 */
function handleClientMessage(ws: WebSocket, msg: ClientMessage): void {
  dispatch(ctx, ws, msg);
}
ctx.handleClientMessage = handleClientMessage;

async function main(): Promise<void> {
  if (DOCTOR) {
    // A hard ceiling on the whole report: every check has its own timeout, and
    // this is the one that holds when one of them does not.
    setTimeout(() => {
      console.error(`${logTag} doctor did not finish within ${DOCTOR_DEADLINE_MS / 1000}s — exiting.`);
      process.exit(2);
    }, DOCTOR_DEADLINE_MS).unref();
  }
  // Ask every backend for its model catalogue ONCE — and NEVER block boot on it.
  //
  // A catalogue is a subprocess (`opencode models`), and a subprocess on the
  // boot path is a daemon that binds its port whenever some other program feels
  // like answering. It cannot reject, and an unprimed catalogue is an EMPTY one,
  // which the phone renders as a free-text field rather than as a guessed list
  // of models this install may not have — so the only cost of it landing late
  // is a client that connected in the first second seeing that field. The
  // re-broadcast below closes even that: when the answers arrive, everyone
  // attached is told again.
  void primeBackendModels().then(() => broadcast({ t: "backends", list: backendInfos() }));
  const ip = await tailscaleIp();
  const tsBin = await tailscaleBin();
  const tsDns = await tailscaleDnsName();
  // Re-read per connection would be a subprocess per socket; serve config only
  // changes when someone runs `tailscale serve`, so boot-time is enough.
  const httpsUrl = await serveHttpsUrl(PORT);
  const doctorInput = {
    root: ROOT, rootDefaulted: ROOT_DEFAULTED, rootPicked: ROOT_PICKED,
    port: PORT,
    claudeBin: claudeBackend.bin(),
    // Which backends this host has already launched sessions on (the recent list
    // is loaded from disk in the manager's constructor, so this answers across
    // restarts): an extension's `doctor()` checks a second binary only where it is
    // actually wanted — a claude-only user must never be told that a binary they
    // have never asked for is missing.
    usedBackends: [...new Set(sessions.listRecent().map((r) => r.launch?.backend).filter((b): b is string => !!b))],
    tailscaleIp: ip,
    tailscaleDns: tsDns,
    allowPublic: env("ALLOW_PUBLIC") === "1",
  };
  // `npm run doctor`: report, never bind, and EXIT (1 on a failed check) — this
  // module's timers and sockets would keep every PTY they own alive for ever.
  if (DOCTOR) {
    const checks = await runChecks(doctorInput);
    if (process.argv.includes("--json")) process.stdout.write(reportJson(checks) + "\n");
    else printReport(checks);
    process.exit(checks.some((c) => c.status === "fail") ? 1 : 0);
  }
  // SAFETY: this daemon spawns `claude`, which can run arbitrary code, and has
  // NO app-level auth. So by default we only bind loopback and the Tailscale IP
  // (network identity = the boundary). Binding LAN/0.0.0.0/public is refused
  // unless you knowingly opt in with WATERPLANE_ALLOW_PUBLIC=1.
  const allowPublic = env("ALLOW_PUBLIC") === "1";
  // The LAN IPs we actually bound (only under the opt-in) — the "hop off the
  // tunnel on the same WiFi" endpoints the phone advertises. Empty otherwise, so
  // the Connection shortcut never offers a LAN link nothing is listening on.
  const boundLan = allowPublic ? lanIps() : [];
  // Bind addresses: an explicit HOST knob wins; otherwise the Tailscale IP (for
  // the phone) plus loopback (for this machine's browser — a secure context, so
  // notifications/clipboard work) plus, under the opt-in, the LAN interfaces.
  const hostEnv = env("HOST");
  let binds = hostEnv
    ? [hostEnv]
    : [...new Set([ip, "127.0.0.1", ...boundLan].filter(Boolean) as string[])];
  if (!ip) console.warn(`${logTag} No Tailscale IP found — binding 127.0.0.1 (local only).`);

  const isSafeBind = (a: string) =>
    allowPublic || a === "127.0.0.1" || a === "::1" || a === "localhost" || (!!ip && a === ip);
  const refused = binds.filter((a) => !isSafeBind(a));
  if (refused.length) {
    console.warn(
      `${logTag} REFUSING to bind ${refused.join(", ")} — no app auth and the daemon runs code.\n` +
      `${logTag} Use Tailscale, or set ${envName("ALLOW_PUBLIC")}=1 to override (DANGEROUS: exposes code execution to that network).`,
    );
    binds = binds.filter(isSafeBind);
  }
  if (binds.length === 0) binds = ["127.0.0.1"]; setPeerSelfAddr(ip && binds.includes(ip) ? `${ip}:${PORT}` : null); // a peer dials the tailnet IP, only when bound
  if (allowPublic) console.warn(`${logTag} ${envName("ALLOW_PUBLIC")}=1 — binding without the safe-address guard. Make sure the network is trusted.`);

  // Now that we know which addresses/names we answer to, arm the same-origin
  // guard for /api and /ws. Anything else a browser might send us is refused.
  // `serveUrl` is our OWN discovered front door: `tailscale serve` may well be
  // fronting us on a port that is neither 443 nor ours (443 is one slot per
  // machine), and a guard that refuses it turns the advertised HTTPS address
  // into a 403 — which is how someone ends up stuck on plain http://100.x with
  // no service worker.
  configureOrigins({ port: PORT, tailscaleIp: ip, tailscaleDns: tsDns, lanIps: boundLan, serveUrl: httpsUrl });
  // On a tailnet whose MagicDNS name could not be read (tailscaled still
  // starting, CLI hiccup) the guard has no exact name to trust; keep asking
  // once a minute, up to 30 times, and re-arm it with the name when it comes.
  if (!tsDns && ip) {
    let tries = 0;
    const timer = setInterval(() => {
      void (async () => {
        tries++;
        const dns = await tailscaleDnsName();
        if (dns) {
          clearInterval(timer);
          configureOrigins({ port: PORT, tailscaleIp: ip, tailscaleDns: dns, lanIps: boundLan, serveUrl: await serveHttpsUrl(PORT) });
        } else if (tries >= 30) clearInterval(timer);
      })();
    }, 60_000);
    timer.unref();
  }

  initThumbs(ROOT);       // <STATE_DIR>/thumbs — image thumbnails for the gallery
  // Fold every repo's old `<repoDir>/.waterplane/backlog.json` into the intent store,
  // once, and rename each source `*.migrated`. Here rather than beside the
  // launches/schedules migration above because it needs the repo list, which
  // needs git — and before `listen()`, so reconciliation sees the imported rows.
  await Promise.all([backlog.init(), plugins.builtinsLoaded]); // extensions: rows in the first checklist
  updates.start(); if (!DOCTOR) ctx.pluginUpdates.start(); // a few minutes after boot, never in the preflight
  setupWatch.start(); if (!DOCTOR) void ctx.healthWatch.start(); // setup checklist swept; health index cached, engine re-run weekly
  if (!DOCTOR) createExposurePush(ROOT, notify, (k, n) => ctx.resolveAttention(k, n)).start(); // one push per new exposure alert on a watched repo; boot sweep after 30 s, then every 10 min
  if (!DOCTOR) startDiskWatch({ notify, recovered: () => { ctx.resolveAttention("disk", "disk space back"); } }); // low disk: one push per level (macOS ends Tailscale to free space)

  const attachWs = (server: ReturnType<typeof createServer>) => {
    // permessage-deflate: the socket carries base64'd PTY output, and a claude
    // TUI repaint is tens of KB of highly repetitive ANSI — the single largest
    // continuous byte stream in the app, previously sent raw AND inflated ~33%
    // by the base64 framing. Context takeover (the default) is the point: the
    // deflate window carries across frames, so the Nth repaint of the same
    // screen costs almost nothing. Costs a few hundred KB of memory per socket,
    // which is nothing for the handful of tabs this daemon serves.
    // WATERPLANE_WS_COMPRESS=0 turns it off.
    const wss = new WebSocketServer({
      server, maxPayload: WS_MAX_PAYLOAD, // 16 MiB, not ws's 100 MiB default — why in wsops.ts
      path: "/ws", handleProtocols: selectWsProtocol, // token rides as `waterplane-tok.<tok>`; only the base protocol is echoed
      perMessageDeflate: env("WS_COMPRESS") === "0" ? false : {
        threshold: 256,
        zlibDeflateOptions: { level: 6, memLevel: 8 },
        concurrencyLimit: 10,
      },
    });
    wsops.wireWsConnections(wss, { ip, tsBin, tsDns, httpsUrl, boundLan });
  };
  assertCtxComplete(ctx); // every ctx member assigned, or the boot fails naming it
  for (const host of binds) {
    const httpServer = createServer(http.handler);
    attachWs(httpServer);
    http.listenWithRetry(httpServer, host, PORT);
  }
  console.log(`${logTag} open the Tailscale URL on your phone; localhost works on this machine.`);

  // Preflight, after we're listening and never blocking it: most first-run
  // breakage (logged-out claude, no tailnet, no node-pty) is otherwise silent.
  // WATERPLANE_PREFLIGHT=0 turns it off — the e2e scripts set that, since they drive a
  // stub binary and assert on host output.
  if (env("PREFLIGHT") !== "0") {
    // Port skipped (we just bound it) and the capture probe skipped: it is an
    // always-`ok` line this summary would drop anyway, and computing it shells
    // out to four binaries — see `runChecks`. So is the self-update request.
    void runChecks(doctorInput, true, true, true).then(printBootSummary).catch(() => { /* preflight must never break boot */ });
  }
}

installShutdown(ctx);

main().catch((err) => {
  console.error(`${logTag} fatal`, err);
  process.exit(1);
});
